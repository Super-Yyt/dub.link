import pg, { types } from "pg";

/**
 * PostgreSQL-backed connection for the raw-SQL helpers in this directory.
 *
 * This file used to connect to PlanetScale through the @planetscale/database
 * HTTP driver. The self-hosted deployment targets PostgreSQL, so the same
 * `conn.execute(query, params)` interface is now backed by a standard
 * node-postgres pool.
 *
 * The small amount of MySQL dialect that the existing call sites rely on is
 * translated transparently, so queries stay upstream-compatible:
 *   1. `backtick` identifiers  ->  "double quoted" identifiers
 *   2. ? positional parameters     ->  $1, $2, ... parameters
 *   3. UPDATE t alias SET alias.c  ->  UPDATE t AS alias SET c
 *      (PostgreSQL does not allow a table prefix on the assignment target)
 */

// Keep timestamps as raw strings, matching the values the previous
// PlanetScale driver returned for DATETIME/TIMESTAMP columns.
types.setTypeParser(1114, (v: string) => v); // timestamp
types.setTypeParser(1184, (v: string) => v); // timestamptz

const pool = new pg.Pool({
  connectionString:
    process.env.PLANETSCALE_DATABASE_URL || process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
});

/**
 * Replace ? placeholders with $n outside of single-quoted string literals.
 */
function convertPlaceholders(sql: string): string {
  let out = "";
  let inString = false;
  let paramIndex = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
    } else if (ch === "?" && !inString) {
      out += "$" + ++paramIndex;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * `identifier` -> "identifier" (MySQL only supports backticks, PG only quotes)
 */
function convertBackticks(sql: string): string {
  return sql.replace(/`([^`]+)`/g, (_m, ident: string) => '"' + ident + '"');
}

/**
 * Quote identifiers that PostgreSQL would fold to lowercase: table names
 * from the Prisma schema (Link, Project, ...) and camelCase column names
 * (lastClicked, projectId, ...). SQL keywords are all-uppercase (or
 * lowercase) and all-lowercase identifiers pass through untouched, so only
 * the two cases above need quoting. String literals are skipped.
 */
const TABLE_NAMES = new Set([
  "Account", "Customer", "Dashboard", "DefaultDomains", "Domain",
  "EmailVerificationToken", "Folder", "FolderAccessRequest", "FolderUser",
  "FolderWebhook", "InstalledIntegration", "Integration", "Invoice",
  "jackson_index", "jackson_store", "jackson_ttl", "Job", "Link", "LinkTag",
  "LinkWebhook", "NotificationPreference", "OAuthApp", "OAuthCode",
  "OAuthRefreshToken", "PasswordResetToken", "Project", "ProjectInvite",
  "ProjectUsers", "RegisteredDomain", "RestrictedToken", "SentEmail",
  "Session", "Tag", "Token", "User", "UserNotificationPreferences",
  "UtmTemplate", "VerificationToken", "Webhook", "YearInReview",
]);

function convertIdentifiers(sql: string): string {
  let out = "";
  let inString = false;
  const token = /^[A-Za-z_][A-Za-z0-9_]*/;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && /[A-Za-z_]/.test(ch)) {
      const m = sql.slice(i).match(token);
      const word = m && m[0];
      const needsQuotes =
        word !== null &&
        word !== undefined &&
        (TABLE_NAMES.has(word) || /^[a-z]+[A-Z]/.test(word));
      if (word && needsQuotes && sql[i - 1] !== '"') {
        out += '"' + word + '"';
        i += word.length - 1;
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * UPDATE Project p SET p.usage = p.usage + 1 WHERE ...
 *   -> UPDATE Project AS p SET usage = p.usage + 1 WHERE ...
 * (table may already be double-quoted by convertIdentifiers)
 */
function convertUpdateAlias(sql: string): string {
  // word-ish boundary without regex escapes: start or a non-word char
  const WB = '([^A-Za-z0-9_"]|^)';
  const updateAlias = new RegExp(
    'UPDATE[ ]+"?([A-Za-z_][A-Za-z0-9_]*)"?[ ]+([A-Za-z_][A-Za-z0-9_]*)[ ]+SET',
    "gi",
  );

  let result = sql;
  let match: RegExpExecArray | null;
  while ((match = updateAlias.exec(sql)) !== null) {
    const rawTable = match[1];
    const alias = match[2];
    // strip "<alias>." prefix on assignment left-hand sides
    const lhs = new RegExp(
      WB + alias + "[.]([A-Za-z_][A-Za-z0-9_]*)([ ]*=)",
      "g",
    );
    result = result.replace(lhs, "$1$2$3");
    const updateRe = new RegExp(
      '(UPDATE[ ]+"?' + rawTable + '"?[ ]+)' + alias + "([ ]+SET)",
      "i",
    );
    result = result.replace(updateRe, "$1AS " + alias + "$2");
  }
  return result;
}

export function translateSql(sql: string): string {
  return convertUpdateAlias(
    convertPlaceholders(convertIdentifiers(convertBackticks(sql))),
  );
}

export interface ExecuteResult<T = any> {
  rows: T[];
  rowsAffected: number;
  insertId: null;
  timing: number;
}

export const conn = {
  async execute<T = any>(
    query: string,
    params: unknown[] = [],
  ): Promise<ExecuteResult<T>> {
    const start = performance.now();
    const result = await pool.query(translateSql(query), params as never[]);
    return {
      rows: result.rows as T[],
      rowsAffected: result.rowCount ?? 0,
      insertId: null,
      timing: performance.now() - start,
    };
  },
};
