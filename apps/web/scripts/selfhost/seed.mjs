/**
 * Self-hosting seed: creates the shared (workspace-independent) verified
 * Domain rows for the domains listed in SELFHOST_DOMAINS, e.g. dub.localhost.
 *
 * Runs inside the migrate container before the web app starts.
 */
import pg from "pg";

const domains = (process.env.SELFHOST_DOMAINS || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

if (domains.length === 0) {
  console.log("[seed] SELFHOST_DOMAINS not set; nothing to seed");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  for (const [i, slug] of domains.entries()) {
    await pool.query(
      `INSERT INTO "Domain" (id, slug, verified, "primary", archived, "deepviewData", "createdAt", "updatedAt")
       VALUES ($1, $2, true, $3, false, '{}', now(), now())
       ON CONFLICT (slug) DO UPDATE SET verified = true, "updatedAt" = now()`,
      ["seed_domain_" + i, slug, i === 0],
    );
    console.log("[seed] ensured shared domain:", slug);
  }
} finally {
  await pool.end();
}
