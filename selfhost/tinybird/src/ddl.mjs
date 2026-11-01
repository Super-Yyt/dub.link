/**
 * ClickHouse schema bootstrap for the Tinybird-compatible API.
 *
 * Raw tables are generated from packages/tinybird/datasources/*.datasource
 * files (column definitions + ENGINE_* attributes translate 1:1).
 *
 * Derived tables (dub_*_mv, *_latest, *_id) replicate the materialized
 * copy pipes from packages/tinybird/pipes/dub_*_pipe.pipe as real
 * ClickHouse materialized views.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/** Parse a .datasource file into CREATE TABLE DDL. */
export function datasourceToDDL(text, tableName) {
  const schemaMatch = text.match(/SCHEMA\s*>\s*\n([\s\S]*?)(?=\nENGINE |\nDESCRIPTION|$)/);
  if (!schemaMatch) throw new Error("no SCHEMA block in datasource " + tableName);
  const columns = schemaMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // drop trailing commas and the json-mapping clauses
    .map((line) => line.replace(/,$/, "").replace(/\s*`json:[^`]*`/, ""));

  const attrs = {};
  for (const m of text.matchAll(/^(ENGINE[A-Z_]*)\s+"([^"]*)"/gm)) {
    attrs[m[1]] = m[2];
  }

  let engine = "MergeTree";
  if (attrs.ENGINE === "ReplacingMergeTree") {
    engine = "ReplacingMergeTree(" + (attrs.ENGINE_VER || "timestamp") + ", " + (attrs.ENGINE_IS_DELETED || "0") + ")";
  } else if (attrs.ENGINE === "AggregatingMergeTree") {
    engine = "AggregatingMergeTree";
  }

  let ddl = "CREATE TABLE IF NOT EXISTS " + tableName + "(\n  " + columns.join(",\n  ") + "\n) ENGINE = " + engine;
  if (attrs.ENGINE_PARTITION_KEY && attrs.ENGINE_PARTITION_KEY !== "tuple()") {
    ddl += " PARTITION BY " + attrs.ENGINE_PARTITION_KEY;
  }
  if (attrs.ENGINE_SORTING_KEY) {
    ddl += " ORDER BY (" + attrs.ENGINE_SORTING_KEY + ")";
  }
  if (attrs.ENGINE_TTL) {
    ddl += " TTL " + attrs.ENGINE_TTL;
  }
  if (attrs.ENGINE_SETTINGS) {
    ddl += " SETTINGS " + attrs.ENGINE_SETTINGS;
  }
  return ddl + ";";
}

/** Column lists shared by event tables (raw and derived). */
const CLICK_COLUMNS = [
  "timestamp DateTime64(3)",
  "click_id String",
  "workspace_id LowCardinality(String)",
  "link_id String",
  "domain String",
  "key String",
  "url String",
  "continent LowCardinality(String)",
  "country LowCardinality(String)",
  "city LowCardinality(String)",
  "region LowCardinality(String)",
  "latitude String",
  "longitude String",
  "device LowCardinality(String)",
  "browser LowCardinality(String)",
  "os LowCardinality(String)",
  "trigger String",
  "ua String",
  "referer String",
  "referer_url String",
  "ip String",
  "identity_hash String",
  "device_model LowCardinality(String)",
  "device_vendor LowCardinality(String)",
  "browser_version String",
  "os_version String",
  "engine LowCardinality(String)",
  "engine_version String",
  "cpu_architecture LowCardinality(String)",
  "qr UInt8",
  "bot UInt8",
];

function table(name, columns, tail) {
  return "CREATE TABLE IF NOT EXISTS " + name + " (\n  " + columns.join(",\n  ") + "\n) ENGINE = " + tail;
}

/** DDL for derived tables that upstream fills via materialized copy pipes. */
export const DERIVED_TABLES = [
  table(
    "dub_links_metadata_latest",
    [
      "timestamp DateTime",
      "workspace_id LowCardinality(String)",
      "link_id String",
      "domain String",
      "key String",
      "url String",
      "folder_id String",
      "tag_ids Array(String)",
      "tenant_id String",
      "created_at DateTime64(3)",
      "deleted UInt8",
    ],
    "ReplacingMergeTree(timestamp, deleted) ORDER BY (workspace_id, link_id);",
  ),
  table(
    "dub_click_events_mv",
    CLICK_COLUMNS,
    "MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (workspace_id, link_id, timestamp);",
  ),
  table(
    "dub_click_events_id",
    CLICK_COLUMNS,
    "MergeTree ORDER BY (click_id) SETTINGS index_granularity = 256;",
  ),
  table(
    "dub_lead_events_mv",
    [
      "timestamp DateTime64(3)",
      "click_id String",
      "workspace_id LowCardinality(String)",
      "link_id String",
      "domain String",
      "key String",
      "url String",
      "event_id String",
      "event_name String",
      "customer_id String",
      "metadata String",
    ].concat(CLICK_COLUMNS.slice(7, 21)).concat(CLICK_COLUMNS.slice(22)),
    "MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (workspace_id, link_id, timestamp);",
  ),
  table(
    "dub_sale_events_mv",
    [
      "timestamp DateTime64(3)",
      "click_id String",
      "workspace_id LowCardinality(String)",
      "link_id String",
      "domain String",
      "key String",
      "url String",
      "event_id String",
      "event_name String",
      "customer_id String",
      "payment_processor LowCardinality(String)",
      "invoice_id String",
      "amount UInt32",
      "metadata String",
    ].concat(CLICK_COLUMNS.slice(7, 21)).concat(CLICK_COLUMNS.slice(22)),
    "MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (workspace_id, link_id, timestamp);",
  ),
  table(
    "dub_first_sale_mv",
    [
      "workspace_id LowCardinality(String)",
      "link_id String",
      "customer_id String",
      "first_sale_state AggregateFunction(min, DateTime64(3))",
    ],
    "AggregatingMergeTree ORDER BY (workspace_id, link_id, customer_id);",
  ),
  table(
    "dub_api_logs_id",
    [
      "id String",
      "timestamp DateTime64(3)",
      "workspace_id String",
      "method LowCardinality(String)",
      "path String",
      "route_pattern LowCardinality(String)",
      "status_code UInt16",
      "duration UInt32",
      "user_agent String",
      "request_body String",
      "query_params String DEFAULT ''",
      "response_body String",
      "token_id String",
      "user_id String",
      "request_type LowCardinality(String)",
    ],
    "MergeTree ORDER BY (id);",
  ),
];

/** Materialized views replicating upstream's copy pipes. */
export const MATERIALIZED_VIEWS = [
  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_links_metadata_latest TO dub_links_metadata_latest AS SELECT timestamp, toLowCardinality(CASE WHEN startsWith(workspace_id, 'ws_c') THEN replace(workspace_id, 'ws_', '') ELSE workspace_id END) AS workspace_id, link_id, domain, key, url, folder_id, tag_ids, tenant_id, created_at, deleted FROM dub_links_metadata",

  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_click_events TO dub_click_events_mv AS SELECT timestamp, click_id, toLowCardinality(coalesce(click_event.workspace_id, link_metadata.workspace_id)) AS workspace_id, link_id, coalesce(click_event.domain, link_metadata.domain) AS domain, coalesce(click_event.key, link_metadata.key) AS key, url, toLowCardinality(continent) AS continent, toLowCardinality(country) AS country, toLowCardinality(city) AS city, toLowCardinality(region) AS region, latitude, longitude, device, browser, os, CASE WHEN trigger = '' THEN (CASE WHEN qr = 1 THEN 'qr' ELSE 'link' END) ELSE trigger END AS trigger, ua, referer, referer_url, ip, coalesce(identity_hash, '') AS identity_hash, device_model, device_vendor, browser_version, os_version, engine, engine_version, cpu_architecture, qr, bot FROM dub_click_events AS click_event ANY LEFT JOIN (SELECT link_id, workspace_id, domain, key FROM dub_links_metadata_latest WHERE link_id IN (SELECT link_id FROM dub_click_events)) AS link_metadata USING link_id",

  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_click_events_id TO dub_click_events_id AS SELECT * FROM dub_click_events_mv",

  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_lead_events TO dub_lead_events_mv AS SELECT timestamp, click_id, toLowCardinality(coalesce(nullIf(lead_event.workspace_id, ''), link_metadata.workspace_id)) AS workspace_id, link_id, coalesce(nullIf(lead_event.domain, ''), link_metadata.domain) AS domain, coalesce(nullIf(lead_event.key, ''), link_metadata.key) AS key, url, event_id, event_name, customer_id, metadata, toLowCardinality(continent) AS continent, toLowCardinality(country) AS country, toLowCardinality(city) AS city, toLowCardinality(region) AS region, latitude, longitude, device, browser, os, CASE WHEN trigger = '' THEN (CASE WHEN qr = 1 THEN 'qr' ELSE 'link' END) ELSE trigger END AS trigger, ua, referer, referer_url, ip, device_model, device_vendor, browser_version, os_version, engine, engine_version, cpu_architecture, qr, bot FROM dub_lead_events AS lead_event ANY LEFT JOIN (SELECT link_id, workspace_id, domain, key FROM dub_links_metadata_latest FINAL WHERE link_id IN (SELECT link_id FROM dub_lead_events)) AS link_metadata USING link_id",

  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sale_events TO dub_sale_events_mv AS SELECT se.timestamp, se.click_id, toLowCardinality(coalesce(nullIf(se.workspace_id, ''), lm.workspace_id)) AS workspace_id, se.link_id AS link_id, coalesce(nullIf(se.domain, ''), lm.domain) AS domain, coalesce(nullIf(se.key, ''), lm.key) AS key, se.url, se.event_id, se.event_name, se.customer_id, se.payment_processor, se.invoice_id, se.amount, se.metadata, toLowCardinality(se.continent) AS continent, toLowCardinality(se.country) AS country, toLowCardinality(se.city) AS city, toLowCardinality(se.region) AS region, se.latitude, se.longitude, se.device, se.browser, se.os, CASE WHEN se.trigger = '' THEN (CASE WHEN se.qr = 1 THEN 'qr' ELSE 'link' END) ELSE se.trigger END AS trigger, se.ua, se.referer, se.referer_url, se.ip, se.device_model, se.device_vendor, se.browser_version, se.os_version, se.engine, se.engine_version, se.cpu_architecture, se.qr, se.bot FROM dub_sale_events AS se LEFT JOIN (SELECT link_id, workspace_id, domain, key FROM dub_links_metadata_latest FINAL WHERE link_id IN (SELECT link_id FROM dub_sale_events)) AS lm USING (link_id)",

  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_first_sale TO dub_first_sale_mv AS SELECT workspace_id, link_id, customer_id, minState(timestamp) AS first_sale_state FROM dub_sale_events_mv GROUP BY workspace_id, link_id, customer_id",

  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_api_logs_id TO dub_api_logs_id AS SELECT * FROM dub_api_logs",
];

export function bootstrapStatements(datasourcesDir) {
  const statements = [];
  if (existsSync(datasourcesDir)) {
    for (const file of readdirSync(datasourcesDir)) {
      if (!file.endsWith(".datasource")) continue;
      const name = file.replace(/\.datasource$/, "");
      // derived tables are created by the hand-written DDL above
      if (/_mv$|_latest$|_id$/.test(name)) continue;
      const text = readFileSync(path.join(datasourcesDir, file), "utf8");
      statements.push(datasourceToDDL(text, name));
    }
  }
  statements.push(...DERIVED_TABLES, ...MATERIALIZED_VIEWS);
  return statements;
}
