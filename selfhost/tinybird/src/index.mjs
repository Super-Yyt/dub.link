/**
 * Tinybird-compatible analytics API backed by ClickHouse.
 *
 * Implements the endpoints the Dub web app uses:
 *   GET  /v0/pipes/<name>.json?params      -> { meta, data, rows, statistics }
 *   POST /v0/events?name=<datasource>      -> { successful_rows, quarantined_rows }
 *   POST /v0/datasources/<name>/delete     -> mutation (ALTER TABLE ... DELETE)
 *
 * Pipes are loaded from the same .pipe files that ship in the upstream
 * repo (packages/tinybird/pipes) and rendered per-request by the
 * template engine, so upstream pipe changes keep working.
 */
import http from "node:http";
import { bootstrapStatements } from "./ddl.mjs";
import { loadPipes, renderPipe, PipeError } from "./pipes.mjs";

const PORT = Number(process.env.PORT || 7181);
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER || "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const TOKEN = process.env.TINYBIRD_API_KEY || "";
const PIPES_DIR = process.env.PIPES_DIR || "/app/pipes";
const DATASOURCES_DIR = process.env.DATASOURCES_DIR || "/app/datasources";

let pipes = new Map();

/** column name -> ClickHouse type, per table (cached) */
const tableSchemas = new Map();

async function getTableSchema(table) {
  if (tableSchemas.has(table)) return tableSchemas.get(table);
  const raw = await ch(
    "SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = {table:String} FORMAT JSONEachRow",
    "",
    null,
    { table },
  );
  const schema = new Map();
  for (const line of raw.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    schema.set(row.name, row.type);
  }
  tableSchemas.set(table, schema);
  return schema;
}

/**
 * Convert incoming event values to what ClickHouse JSONEachRow expects:
 *  - ISO-8601 strings for DateTime/DateTime64 columns become
 *    'YYYY-MM-DD HH:MM:SS[.mmm]' (the Tinybird Events API accepts ISO
 *    timestamps directly, ClickHouse does not)
 *  - booleans for UInt/Int columns become 1/0
 */
async function transformEvents(table, events) {
  let schema;
  try {
    schema = await getTableSchema(table);
  } catch {
    return events; // unknown table -> let ClickHouse report the error
  }
  return events.map((event) => {
    const out = { ...event };
    for (const [key, value] of Object.entries(out)) {
      const type = schema.get(key);
      if (!type) continue;
      if (typeof type === "string" && type.startsWith("DateTime")) {
        if (typeof value === "string" && value.includes("T") && /\d{4}-\d{2}-\d{2}/.test(value)) {
          const d = new Date(value);
          if (!isNaN(d.getTime())) {
            const p = (n, w) => String(n).padStart(w || 2, "0");
            let s =
              d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
              " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
            if (type.startsWith("DateTime64")) s += "." + p(d.getUTCMilliseconds(), 3);
            out[key] = s;
          }
        }
      } else if (typeof value === "boolean" && /^(U)?Int(8|16|32|64)/.test(type)) {
        out[key] = value ? 1 : 0;
      }
    }
    return out;
  });
}

async function ch(query, body, format, params) {
  const url = new URL(CLICKHOUSE_URL);
  url.searchParams.set("query", query);
  if (format) url.searchParams.set("default_format", format);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set("param_" + key, value);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": CH_USER,
      ...(CH_PASSWORD ? { "X-ClickHouse-Key": CH_PASSWORD } : {}),
    },
    body: body ?? "",
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("ClickHouse error (" + res.status + "): " + text.slice(0, 800));
    err.statusCode = res.status;
    throw err;
  }
  return text;
}

async function waitForClickHouse() {
  for (let i = 0; ; i++) {
    try {
      await ch("SELECT 1");
      return;
    } catch (err) {
      if (i % 20 === 0) console.log("[tinybird] waiting for ClickHouse at", CLICKHOUSE_URL);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function bootstrap() {
  const statements = bootstrapStatements(DATASOURCES_DIR);
  for (const stmt of statements) {
    try {
      await ch(stmt);
    } catch (err) {
      console.error("[tinybird] bootstrap statement failed:", err.message, "\n--", stmt.slice(0, 200));
    }
  }
  console.log("[tinybird] schema bootstrap done (" + statements.length + " statements)");
  pipes = loadPipes(PIPES_DIR);
  console.log("[tinybird] loaded " + pipes.size + " pipes");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseEventsBody(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("{")) {
    // could be a single object or NDJSON starting with an object
    try {
      return [JSON.parse(trimmed)];
    } catch {
      // fall through to NDJSON
    }
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/healthz") {
    return send(200, { ok: true, pipes: pipes.size });
  }

  const auth = req.headers.authorization || "";
  if (TOKEN && auth !== "Bearer " + TOKEN) {
    return send(403, { error: "Unauthorized" });
  }

  try {
    // ---- GET /v0/pipes/<name>.json
    const pipeMatch = url.pathname.match(/^\/v0\/pipes\/([\w.-]+)\.json$/);
    if (pipeMatch && req.method === "GET") {
      const pipeName = pipeMatch[1];
      const pipe = pipes.get(pipeName);
      if (!pipe || pipe.kind !== "endpoint") {
        return send(404, { error: "pipe not found: " + pipeName });
      }
      const params = {};
      for (const [key, value] of url.searchParams.entries()) {
        params[key] = value;
      }
      const sql = renderPipe(pipe, params);
      const raw = await ch(sql + "\nFORMAT JSON", "", null);
      const parsed = JSON.parse(raw);
      return send(200, {
        meta: parsed.meta || [],
        data: parsed.data || [],
        rows: parsed.rows,
        rows_before_limit_at_least: parsed.rows_before_limit_at_least,
        statistics: parsed.statistics,
      });
    }

    // ---- POST /v0/events?name=<datasource>[&wait=true]
    if (url.pathname === "/v0/events" && req.method === "POST") {
      const name = url.searchParams.get("name");
      if (!name) return send(400, { error: "missing ?name= parameter" });
      const body = await readBody(req);
      let events;
      try {
        events = parseEventsBody(body);
      } catch (err) {
        return send(400, { error: "invalid events payload: " + err.message });
      }
      const transformed = await transformEvents(name, events);
      const ndjson = transformed.map((e) => JSON.stringify(e)).join("\n");
      await ch("INSERT INTO " + name + " FORMAT JSONEachRow", ndjson);
      return send(200, { successful_rows: events.length, quarantined_rows: 0 });
    }

    // ---- POST /v0/datasources/<name>/delete   (delete_condition=<SQL>)
    const deleteMatch = url.pathname.match(/^\/v0\/datasources\/([\w]+)\/delete$/);
    if (deleteMatch && req.method === "POST") {
      const name = deleteMatch[1];
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const condition = params.get("delete_condition");
      if (!condition) return send(400, { error: "missing delete_condition" });
      // ALTER ... DELETE works on raw tables; MV-backed tables are rebuilt
      // from the raw events after mutation.
      await ch("ALTER TABLE " + name + " DELETE WHERE " + condition);
      return send(200, { ok: true });
    }

    return send(404, { error: "not found" });
  } catch (err) {
    console.error("[tinybird] request error:", err.message);
    if (err instanceof PipeError || err instanceof SyntaxError) {
      return send(400, { error: err.message });
    }
    return send(500, { error: err.message });
  }
});

async function start() {
  await waitForClickHouse();
  await bootstrap();
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log("[tinybird] Tinybird-compatible API listening on :" + PORT);
}

start().catch((err) => {
  console.error("[tinybird] fatal:", err);
  process.exit(1);
});
