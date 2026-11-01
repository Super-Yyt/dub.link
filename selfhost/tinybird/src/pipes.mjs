/**
 * Tinybird .pipe file loading and rendering.
 *
 * A .pipe file contains NODE <name> / SQL > blocks. The node marked
 * TYPE ENDPOINT is what /v0/pipes/<pipe> executes; other nodes are
 * intermediate queries referenced by name - they get inlined as CTEs.
 *
 * Copy pipes (TYPE materialized ... DATASOURCE <name>) are skipped here;
 * the corresponding ClickHouse materialized views are created by ddl.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderTemplate, TemplateError } from "./template.mjs";

export class PipeError extends Error {}

function stripArtifactLines(sql) {
  // Tinybird exports contain lone "%" separator lines which are not valid SQL
  return sql
    .split("\n")
    .filter((line) => line.trim() !== "%")
    .join("\n");
}

/**
 * @returns {Map<string, {nodes: Map<string,string>, endpoint: string|null, kind: string}>}
 */
export function loadPipes(dir) {
  const pipes = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".pipe")) continue;
    const text = readFileSync(path.join(dir, file), "utf8");
    const pipeName = file.replace(/\.pipe$/, "");

    const nodes = new Map();
    let endpoint = null;
    let kind = "endpoint";

    if (/TYPE\s+materialized/i.test(text)) {
      kind = "materialized";
    }

    // split into NODE blocks sequentially: NODE <name> ... SQL > ... <TYPE ...>
    const blocks = text.split(/(?=^NODE\s+\w+)/m);
    for (const block of blocks) {
      const nameMatch = block.match(/^NODE\s+(\w+)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const typeMatch = block.match(/TYPE\s+(\w+)/);
      if (typeMatch && typeMatch[1].toLowerCase() === "endpoint") {
        endpoint = name;
      }
      const sqlMatch = block.match(/SQL\s*>\s*\n([\s\S]*?)(?=\nTYPE\s+|$)/);
      if (sqlMatch) {
        nodes.set(name, stripArtifactLines(sqlMatch[1]).trim());
      }
    }

    if (nodes.size === 0) {
      nodes.set("endpoint", stripArtifactLines(text).trim());
      endpoint = "endpoint";
    }
    if (!endpoint && nodes.has("endpoint")) endpoint = "endpoint";

    pipes.set(pipeName, { nodes, endpoint, kind });
  }
  return pipes;
}

/** Render a node's SQL with params, inlining referenced sibling nodes as CTEs. */
export function renderPipe(pipe, params) {
  const { nodes, endpoint } = pipe;
  if (!endpoint || !nodes.has(endpoint)) {
    throw new PipeError("pipe has no endpoint node");
  }

  const ctes = [];
  const seen = new Set();

  const collectRefs = (sql) => {
    for (const name of nodes.keys()) {
      if (name === endpoint || seen.has(name)) continue;
      const re = new RegExp("\\b" + name + "\\b");
      if (re.test(sql)) {
        seen.add(name);
        const rendered = renderTemplate(nodes.get(name), params);
        collectRefs(rendered);
        ctes.push({ name, sql: rendered });
      }
    }
  };

  let sql;
  try {
    sql = renderTemplate(nodes.get(endpoint), params);
  } catch (err) {
    if (err instanceof TemplateError) {
      throw new PipeError("template error: " + err.message);
    }
    throw err;
  }
  collectRefs(sql);

  // de-duplicate CTEs that ended up with identical SQL
  const unique = [];
  const uniqueKeys = new Set();
  for (const cte of ctes) {
    if (cte.sql.trim().endsWith(";")) cte.sql = cte.sql.trim().slice(0, -1);
    const key = cte.name + "|" + cte.sql;
    if (!uniqueKeys.has(key)) {
      uniqueKeys.add(key);
      unique.push(cte);
    }
  }

  const prefix = unique.length > 0
    ? "WITH " + unique.map((c) => c.name + " AS (\n" + c.sql + "\n)").join(",\n") + "\n"
    : "";
  return prefix + sql;
}
