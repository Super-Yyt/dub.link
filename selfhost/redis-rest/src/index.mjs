/**
 * Upstash Redis REST API compatible proxy.
 *
 * Speaks the Upstash REST protocol on the front (`POST /` with a JSON array
 * command or an array of arrays for pipelines) and plain RESP to a local
 * Redis/Valkey server on the back via ioredis.
 *
 * This lets the Dub web app (`@upstash/redis` SDK) run fully self-hosted
 * against a local Redis, without any Upstash cloud dependency.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import Redis from "ioredis";

const PORT = Number(process.env.PORT || 8079);
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TOKEN = process.env.REDIS_REST_TOKEN || "";
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 10_000);

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 10_000,
  // Never let ioredis buffer commands forever when Redis is down:
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

redis.on("error", (err) => console.error("[redis-rest] redis error:", err.message));

/**
 * Surface NOSCRIPT explicitly: clients like @upstash/ratelimit fall back
 * from EVALSHA to EVAL only when the error message contains "NOSCRIPT",
 * and ioredis sometimes phrases it as "not found".
 */
function normalizeRedisError(err) {
  const message = err && err.message ? err.message : String(err);
  if (/not found|No matching script/i.test(message) && !message.includes("NOSCRIPT")) {
    return "NOSCRIPT " + message;
  }
  return message;
}

function toJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  return String(value);
}

function isCommandArray(cmd) {
  return Array.isArray(cmd) && cmd.length > 0 && typeof cmd[0] === "string";
}

function isPipeline(body) {
  return Array.isArray(body) && body.length > 0 && Array.isArray(body[0]);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Command timed out")), ms).unref?.(),
    ),
  ]);
}

async function runCommand(cmd) {
  if (!isCommandArray(cmd)) {
    throw new Error("invalid command: expected array of strings");
  }
  const args = cmd.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
  let raw;
  try {
    raw = await withTimeout(redis.call(...prepareLuaArgs(args)), COMMAND_TIMEOUT_MS);
  } catch (err) {
    throw new Error(normalizeRedisError(err));
  }
  return { result: normalize(cmd[0], toJson(raw)) };
}

// The Upstash REST API returns HGETALL (and HGETALL-in-pipeline) results
// as objects; ioredis' generic .call() returns a flat field/value array.
function normalize(command, value) {
  if (typeof command === "string" && command.toUpperCase() === "HGETALL" && Array.isArray(value)) {
    const obj = {};
    for (let i = 0; i + 1 < value.length; i += 2) obj[value[i]] = value[i + 1];
    return obj;
  }
  return value;
}

/**
 * Strip Upstash-specific Lua shebang lines (e.g. "#!lua flags=allow-key-locking")
 * from script bodies: upstream clients (@upstash/ratelimit) ship them, but
 * plain Redis/Valkey rejects the unknown flag. Removing the comment-only
 * shebang is semantically a no-op for the script itself.
 */
function prepareLuaArgs(args) {
  const out = [...args];
  // EVAL script numkeys [key ...] [arg ...]  |  SCRIPT LOAD script
  const scriptIndex = out[0].toUpperCase() === "EVAL" ? 1 : out[0].toUpperCase() === "SCRIPT" && String(out[1] || "").toUpperCase() === "LOAD" ? 2 : -1;
  if (scriptIndex !== -1 && typeof out[scriptIndex] === "string" && out[scriptIndex].startsWith("#!lua")) {
    const firstNewline = out[scriptIndex].indexOf("\n");
    if (firstNewline !== -1) {
      out[scriptIndex] = out[scriptIndex].slice(firstNewline + 1);
    }
  }
  return out;
}

async function runPipeline(cmds) {
  // ioredis exec() returns [[err, result], ...]
  // (commands are added via .call() — the array-batch form of multi()
  // depends on dynamically attached command methods, which is fragile)
  const pipeline = redis.pipeline();
  for (const cmd of cmds) {
    if (!isCommandArray(cmd)) {
      throw new Error("invalid command in pipeline: expected array of strings");
    }
    pipeline.call(...prepareLuaArgs(cmd.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))));
  }
  const results = await withTimeout(pipeline.exec(), COMMAND_TIMEOUT_MS);
  return results.map(([err, result], i) =>
    err
      ? { error: normalizeRedisError(err) }
      : { result: normalize(cmds[i] && cmds[i][0], toJson(result)) },
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz") {
    const ok = redis.status === "ready";
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: redis.status }));
  }

  // URL-path style requests (e.g. GET /set/key/value), also supported by Upstash
  if (req.method === "GET" && url.pathname !== "/") {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length > 0) {
      const body = [parts[0].toUpperCase(), ...parts.slice(1)];
      try {
        const payload = await runCommand(body);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // @upstash/redis sends pipelined commands to POST /pipeline
  // (and MULTI/EXEC batches to POST /multi-exec)
  if (req.method === "POST" && (url.pathname === "/pipeline" || url.pathname === "/multi-exec")) {
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    let parsed;
    try {
      parsed = JSON.parse((await readBody(req)) || "[]");
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid JSON body: " + err.message }));
    }
    try {
      const payload = Array.isArray(parsed) && Array.isArray(parsed[0])
        ? await runPipeline(parsed)
        : await runCommand(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method !== "POST" || url.pathname !== "/") {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }

  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  let parsed;
  try {
    parsed = JSON.parse((await readBody(req)) || "[]");
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `invalid JSON body: ${err.message}` }));
  }

  try {
    const payload = isPipeline(parsed) ? await runPipeline(parsed) : await runCommand(parsed);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(payload));
  } catch (err) {
    // Upstash returns 200 with an error payload for command failures
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: err.message }));
  }
});

/**
 * Preload the Lua scripts shipped by @upstash/ratelimit (fixed/sliding
 * window, token bucket, ...) so the SDK's EVALSHA calls resolve locally
 * just like they do against Upstash Redis.
 */
async function preloadRatelimitScripts() {
  let scripts = [];
  try {
    scripts = JSON.parse(readFileSync("/app/ratelimit-scripts.json", "utf8"));
  } catch {
    return;
  }
  for (const { name, body } of scripts) {
    // strip Upstash-only shebang (see prepareLuaArgs)
    const script = body.startsWith("#!lua") && body.includes("\n") ? body.slice(body.indexOf("\n") + 1) : body;
    try {
      await redis.script("LOAD", script);
    } catch (err) {
      console.warn("[redis-rest] SCRIPT LOAD failed for", name, err.message);
    }
  }
  console.log("[redis-rest] preloaded", scripts.length, "ratelimit lua scripts");
}

async function start() {
  // Wait for Redis to be reachable before accepting traffic
  for (let i = 0; ; i++) {
    try {
      await redis.ping();
      break;
    } catch (err) {
      if (i % 10 === 0) console.log("[redis-rest] waiting for redis at", REDIS_URL, "...");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await preloadRatelimitScripts();
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`[redis-rest] Upstash-compatible REST proxy listening on :${PORT} -> ${REDIS_URL}`);
}

start().catch((err) => {
  console.error("[redis-rest] fatal:", err);
  process.exit(1);
});
