/**
 * Self-hosted, QStash-compatible HTTP message queue.
 *
 * Implements the subset of the Upstash QStash v2 REST API that the Dub
 * web app uses (Client.publishJSON / batchJSON / queue().enqueueJSON),
 * delivering messages to the Next.js app over plain HTTP with retries,
 * delays, deduplication, per-queue parallelism and flow control.
 *
 * Wire compatibility notes (verified against @upstash/qstash 2.x):
 *  - POST /v2/publish/{destination}      -> { messageId, url, deduplicated? }
 *  - POST /v2/batch                      -> [ { messageId, url, deduplicated? } ]
 *  - POST /v2/enqueue/{queue}/{dest}     -> { messageId, url, queue }
 *  - PUT  /v2/queues/{name}              -> queue object
 *  - Options arrive as Upstash-* headers; Upstash-Forward-* headers are
 *    forwarded to the destination verbatim (minus the prefix).
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8103);
const TOKEN = process.env.QSTASH_TOKEN || "";
const CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY || "";
const NEXT_SIGNING_KEY = process.env.QSTASH_NEXT_SIGNING_KEY || "";
const DATA_DIR = process.env.DATA_DIR || "";
const DEFAULT_MAX_RETRIES = Number(process.env.DEFAULT_MAX_RETRIES ?? 3);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS ?? 300_000);
const DELIVERY_CONCURRENCY = Number(process.env.DELIVERY_CONCURRENCY ?? 50);
const DEDUP_TTL_MS = Number(process.env.DEDUP_TTL_MS ?? 60_000);
const TICK_MS = 250;

/** @type {Map<string, any>} messageId -> message */
const messages = new Map();
/** @type {Map<string, any>} queueName -> queue config */
const queues = new Map();
/** @type {Map<string, number>} dedup key -> expiry */
const dedupKeys = new Map();
/** @type {Set<string>} in-flight message ids */
const inFlight = new Set();
/** @type {Map<string, number>} flow-control key -> active deliveries */
const flowActive = new Map();
let persistStream = null;

function persist(line) {
  if (!DATA_DIR || !persistStream) return;
  try {
    persistStream.write(JSON.stringify(line) + "\n");
  } catch (err) {
    console.error("[qstash] persist error:", err.message);
  }
}

function loadPersisted() {
  if (!DATA_DIR) return;
  const file = path.join(DATA_DIR, "qstash-messages.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const lineStr of raw.split("\n")) {
      if (!lineStr.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(lineStr);
      } catch {
        continue;
      }
      if (entry.kind === "queue") {
        queues.set(entry.queue.queueName, entry.queue);
      } else if (entry.kind === "message" && entry.message.state === "pending") {
        const msg = entry.message;
        // don't re-run very old retries on restart
        if (msg.nextAttemptAt > Date.now() - 3600_000) {
          messages.set(msg.messageId, msg);
        }
      }
    }
    console.log(`[qstash] restored ${messages.size} pending messages, ${queues.size} queues`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[qstash] load error:", err.message);
  }
}

function newMessageId() {
  return "msg_" + crypto.randomBytes(16).toString("hex");
}

function parseDuration(value) {
  // "30s" | "1m" | "1h" | "0.5s" | number-of-seconds
  if (value === undefined || value === null || value === "") return 0;
  const m = String(value).trim().match(/^([\d.]+)\s*(ms|s|m|h|d)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || "s";
  const mult = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return Math.max(0, Math.round(n * mult * 1000));
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function signMessage(messageId, body) {
  if (!CURRENT_SIGNING_KEY) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "upstash",
      sub: "upstash",
      iat: now,
      exp: now + 600,
      jti: messageId,
      body: sha256Hex(body),
    }),
  );
  const sig = crypto
    .createHmac("sha256", CURRENT_SIGNING_KEY)
    .update(header + "." + payload)
    .digest("base64url");
  return header + "." + payload + "." + sig;
}

function extractOptions(headers) {
  const opts = {
    method: headers["upstash-method"] || "POST",
    retries: headers["upstash-retries"] !== undefined ? Number(headers["upstash-retries"]) : DEFAULT_MAX_RETRIES,
    delayMs: parseDuration(headers["upstash-delay"]),
    notBefore: headers["upstash-not-before"] ? Number(headers["upstash-not-before"]) : 0,
    deduplicationId: headers["upstash-deduplication-id"],
    contentBasedDedup: headers["upstash-content-based-deduplication"] === "true",
    timeoutMs: headers["upstash-timeout"] ? Math.max(1000, parseDuration(headers["upstash-timeout"])) : DEFAULT_TIMEOUT_MS,
    callback: headers["upstash-callback"],
    failureCallback: headers["upstash-failure-callback"],
    flowControlKey: headers["upstash-flow-control-key"],
    flowControlParallelism: headers["upstash-flow-control-parallelism"]
      ? Number(headers["upstash-flow-control-parallelism"])
      : undefined,
    forwardHeaders: {},
  };
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith("upstash-forward-")) {
      opts.forwardHeaders[key.slice("upstash-forward-".length)] = value;
    }
  }
  return opts;
}

function checkDedup(message) {
  if (!message.deduplicationId) return false;
  const now = Date.now();
  // purge expired entries opportunistically
  for (const [k, expiry] of dedupKeys) {
    if (expiry <= now) dedupKeys.delete(k);
  }
  if (dedupKeys.has(message.deduplicationId)) return true;
  dedupKeys.set(message.deduplicationId, now + DEDUP_TTL_MS);
  return false;
}

function createMessage({ destination, body, rawHeaders, queue }) {
  const opts = extractOptions(rawHeaders);
  const messageId = newMessageId();
  const notBeforeMs = opts.notBefore
    ? opts.notBefore * 1000
    : Date.now() + opts.delayMs;
  const message = {
    messageId,
    destination,
    body: typeof body === "string" ? body : String(body ?? ""),
    contentType: rawHeaders["content-type"] || "application/json",
    queue: queue || null,
    ...opts,
    state: "pending",
    attempts: 0,
    nextAttemptAt: Math.max(Date.now(), notBeforeMs),
    createdAt: Date.now(),
  };
  return message;
}

function publishResponse(message, deduplicated) {
  return {
    messageId: message.messageId,
    url: message.destination,
    ...(deduplicated !== undefined ? { deduplicated } : {}),
  };
}

function acceptMessage(message) {
  const deduplicated = checkDedup(message);
  if (!deduplicated) {
    messages.set(message.messageId, message);
    persist({ kind: "message", message });
  }
  return deduplicated;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function readHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

// ---------------------------------------------------------------- delivery

async function deliver(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), message.timeoutMs);
  const signature = signMessage(message.messageId, message.body);
  const headers = {
    "content-type": message.contentType,
    "content-length": String(Buffer.byteLength(message.body)),
    ...message.forwardHeaders,
    "user-agent": "dub-selfhost-qstash/1 (QStash-compatible)",
  };
  if (signature) headers["upstash-signature"] = signature;
  try {
    const res = await fetch(message.destination, {
      method: message.method || "POST",
      headers,
      body: message.method === "GET" || message.method === "HEAD" ? undefined : message.body,
      signal: controller.signal,
      redirect: "manual",
    });
    // QStash treats any 2xx as success; anything else (incl. 3xx with redirect: manual) retries
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function flowSlot(message) {
  if (!message.flowControlKey) return null;
  const active = flowActive.get(message.flowControlKey) || 0;
  const limit = message.flowControlParallelism || 1;
  return { key: message.flowControlKey, available: active < limit };
}

function flowAcquire(key) {
  flowActive.set(key, (flowActive.get(key) || 0) + 1);
}
function flowRelease(key) {
  const n = (flowActive.get(key) || 1) - 1;
  if (n <= 0) flowActive.delete(key); else flowActive.set(key, n);
}

function queueAllows(message) {
  if (!message.queue) return true;
  const queue = queues.get(message.queue);
  if (!queue) return true;
  const active = [...inFlight].filter((id) => messages.get(id)?.queue === message.queue).length;
  const limit = queue.parallelism || 5;
  return active < limit;
}

async function deliveryLoop() {
  const now = Date.now();
  const candidates = [...messages.values()]
    .filter((m) => m.state === "pending" && m.nextAttemptAt <= now && !inFlight.has(m.messageId))
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

  for (const message of candidates) {
    if (inFlight.size >= DELIVERY_CONCURRENCY) break;
    if (!queueAllows(message)) continue;
    const slot = flowSlot(message);
    if (slot && !slot.available) continue;

    inFlight.add(message.messageId);
    if (slot) flowAcquire(slot.key);

    (async () => {
      const result = await deliver(message);
      if (result.ok) {
        messages.delete(message.messageId);
      } else {
        message.attempts += 1;
        if (message.attempts > message.retries) {
          message.state = "failed";
          message.lastError = result.error || `HTTP ${result.status}`;
          messages.delete(message.messageId);
          console.error(
            `[qstash] message ${message.messageId} -> ${message.destination} failed permanently: ${message.lastError}`,
          );
        } else {
          const backoff = Math.min(1000 * 2 ** (message.attempts - 1), 60_000);
          message.nextAttemptAt = Date.now() + backoff;
          console.warn(
            `[qstash] message ${message.messageId} -> ${message.destination} attempt ${message.attempts} failed (HTTP ${result.status}); retrying in ${backoff}ms`,
          );
        }
      }
    })()
      .catch((err) => console.error("[qstash] delivery crash:", err))
      .finally(() => {
        inFlight.delete(message.messageId);
        if (slot) flowRelease(slot.key);
      });
  }
}

// ------------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const headers = readHeaders(req);
  const send = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/healthz") {
    return send(200, { ok: true, pending: messages.size, inFlight: inFlight.size });
  }

  const auth = headers["authorization"] || "";
  if (TOKEN && auth !== "Bearer " + TOKEN) {
    return send(401, { error: "unauthorized" });
  }

  try {
    // POST /v2/publish/{destination}
    if (req.method === "POST" && url.pathname.startsWith("/v2/publish/")) {
      const destination = decodeURIComponent(url.pathname.slice("/v2/publish/".length));
      if (!/^https?:\/\//.test(destination)) {
        return send(400, { error: "destination must be an absolute http(s) URL" });
      }
      const body = await readBody(req);
      const message = createMessage({ destination, body, rawHeaders: headers });
      const deduplicated = acceptMessage(message);
      return send(200, publishResponse(message, deduplicated));
    }

    // POST /v2/batch
    if (req.method === "POST" && url.pathname === "/v2/batch") {
      const raw = await readBody(req);
      const items = JSON.parse(raw || "[]");
      if (!Array.isArray(items)) return send(400, { error: "body must be an array" });
      const responses = [];
      for (const item of items) {
        const rawHeaders = {
          ...(item.headers || {}),
          "content-type": (item.headers && item.headers["Content-Type"]) || "application/json",
        };
        // batch headers come pre-processed: Upstash-* options + Upstash-Forward-*
        const message = createMessage({
          destination: item.destination,
          body: typeof item.body === "string" ? item.body : JSON.stringify(item.body ?? ""),
          rawHeaders,
          queue: item.queue || null,
        });
        const deduplicated = acceptMessage(message);
        responses.push(publishResponse(message, deduplicated));
      }
      return send(200, responses);
    }

    // POST /v2/enqueue/{queueName}/{destination}
    if (req.method === "POST" && url.pathname.startsWith("/v2/enqueue/")) {
      const rest = decodeURIComponent(url.pathname.slice("/v2/enqueue/".length));
      const separator = rest.indexOf("/");
      if (separator === -1) return send(400, { error: "expected /v2/enqueue/{queue}/{destination}" });
      const queueName = rest.slice(0, separator);
      const destination = rest.slice(separator + 1);
      if (!/^https?:\/\//.test(destination)) {
        return send(400, { error: "destination must be an absolute http(s) URL" });
      }
      // auto-create queue on first use (matches QStash behavior)
      if (!queues.has(queueName)) {
        const queue = { queueName, parallelism: 5, createdAt: Date.now() };
        queues.set(queueName, queue);
        persist({ kind: "queue", queue });
      }
      const body = await readBody(req);
      const message = createMessage({ destination, body, rawHeaders: headers, queue: queueName });
      const deduplicated = acceptMessage(message);
      return send(200, { ...publishResponse(message, deduplicated), queue: queueName });
    }

    // POST /v2/enqueue/batch  (queue taken from each item)
    if (req.method === "POST" && url.pathname === "/v2/enqueue/batch") {
      const raw = await readBody(req);
      const items = JSON.parse(raw || "[]");
      const responses = [];
      for (const item of items) {
        if (!item.queue || !item.destination) {
          responses.push({ error: "missing queue or destination" });
          continue;
        }
        if (!queues.has(item.queue)) {
          queues.set(item.queue, { queueName: item.queue, parallelism: 5, createdAt: Date.now() });
        }
        const message = createMessage({
          destination: item.destination,
          body: typeof item.body === "string" ? item.body : JSON.stringify(item.body ?? ""),
          rawHeaders: { ...(item.headers || {}) },
          queue: item.queue,
        });
        const deduplicated = acceptMessage(message);
        responses.push({ ...publishResponse(message, deduplicated), queue: item.queue });
      }
      return send(200, responses);
    }

    // PUT /v2/queues/{name}
    const queueMatch = url.pathname.match(/^\/v2\/queues\/([^/]+)$/);
    if (queueMatch && (req.method === "PUT" || req.method === "POST")) {
      const queueName = decodeURIComponent(queueMatch[1]);
      let config = {};
      try {
        config = JSON.parse((await readBody(req)) || "{}");
      } catch {}
      const queue = {
        queueName,
        parallelism: config.parallelism ?? 5,
        ...(config.rate ? { rate: config.rate } : {}),
        updatedAt: Date.now(),
      };
      queues.set(queueName, queue);
      persist({ kind: "queue", queue });
      return send(200, queue);
    }

    if (queueMatch && req.method === "GET") {
      const queue = queues.get(decodeURIComponent(queueMatch[1]));
      if (!queue) return send(404, { error: "queue not found" });
      return send(200, queue);
    }

    if (url.pathname === "/v2/queues" && req.method === "GET") {
      return send(200, { queues: [...queues.values()] });
    }

    // message inspection endpoints (best effort)
    const messageMatch = url.pathname.match(/^\/v2\/messages\/([^/]+)$/);
    if (messageMatch && req.method === "GET") {
      const id = decodeURIComponent(messageMatch[1]);
      const message = messages.get(id);
      if (!message) return send(404, { error: "message not found" });
      return send(200, {
        messageId: message.messageId,
        url: message.destination,
        state: inFlight.has(id) ? "running" : message.state,
        attemptCount: message.attempts,
        ...message,
      });
    }

    return send(404, { error: "not found" });
  } catch (err) {
    console.error("[qstash] request error:", err);
    return send(500, { error: err.message });
  }
});

async function start() {
  if (DATA_DIR) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    persistStream = fs.createWriteStream(path.join(DATA_DIR, "qstash-messages.jsonl"), { flags: "a" });
  }
  loadPersisted();
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  setInterval(deliveryLoop, TICK_MS);
  console.log(`[qstash] QStash-compatible queue listening on :${PORT}`);
}

start().catch((err) => {
  console.error("[qstash] fatal:", err);
  process.exit(1);
});
