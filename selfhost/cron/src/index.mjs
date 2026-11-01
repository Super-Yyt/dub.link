// Cron scheduler replacing Vercel Cron for self-hosted deployments.
// Hits the Next.js app's /api/cron/* endpoints on the same schedules as
// apps/web/vercel.json. Override with CRON_JOBS (lines of
// "<5-field cron>|<path>", e.g. "0 */5 * * *|/api/cron/sync-redis-resources").
const WEB_URL = process.env.WEB_URL || "http://web:3000";
const CRON_SECRET = process.env.CRON_SECRET || "";
const DEFAULT_JOBS = [
  "0 * * * *|/api/cron/domains/verify",
  "0 * * * *|/api/cron/trial-emails",
  "* * * * *|/api/cron/streams/send-link-clicked-webhooks",
  "* * * * *|/api/cron/streams/update-click-stats",
  "* * * * *|/api/cron/streams/update-workspace-links-usage",
  "40 0,8,12,20 * * *|/api/cron/trigger-backup",
  "0 2 * * *|/api/cron/sitemaps/queue",
  "*/5 * * * *|/api/cron/sync-redis-resources",
  "* * * * *|/api/cron/queue/retry",
];

function parseJobs() {
  const raw = (process.env.CRON_JOBS && process.env.CRON_JOBS.trim()) || DEFAULT_JOBS.join("\n");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [schedule, path] = line.split("|").map((s) => s.trim());
      if (!schedule || !path) throw new Error("Invalid CRON_JOBS line: " + line);
      return { schedule, path, expr: parseCron(schedule) };
    });
}

// ------------------------------------------------- 5-field cron expressions

function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Invalid cron expression (need 5 fields): " + expr);
  const ranges = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6],  // day of week
  ];
  return fields.map((field, i) => {
    const [min, max] = ranges[i];
    const values = new Set();
    for (const part of field.split(",")) {
      const stepMatch = part.match(/^(.+?)\/(\d+)$/);
      const step = stepMatch ? Number(stepMatch[2]) : 1;
      let range = stepMatch ? stepMatch[1] : part;
      let lo = min;
      let hi = max;
      if (range !== "*") {
        const rangeMatch = range.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          lo = Number(rangeMatch[1]);
          hi = Number(rangeMatch[2]);
        } else {
          lo = hi = Number(range);
        }
      }
      for (let v = lo; v <= hi; v += step) {
        if (v >= min && v <= max) values.add(v);
      }
    }
    return values;
  });
}

function matches(expr, date) {
  const parts = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  // In cron, if both day-of-month and day-of-week are restricted, either may match
  const domRestricted = expr[2].size < 31;
  const dowRestricted = expr[4].size < 7;
  const timeMatch = expr[0].has(parts[0]) && expr[1].has(parts[1]) && expr[3].has(parts[3]);
  const dom = expr[2].has(parts[2]);
  const dow = expr[4].has(parts[4]);
  const dayMatch = domRestricted && dowRestricted ? dom || dow : dom && dow;
  return timeMatch && dayMatch;
}

// ------------------------------------------------------------------ runner

async function fire(path) {
  const url = WEB_URL.replace(/\/$/, "") + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 590_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: "Bearer " + CRON_SECRET,
        // present the app hostname so the middleware routes /api/* correctly
        host: process.env.WEB_HOST_HEADER || "localhost",
      },
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    console.log(`[cron] ${path} -> ${res.status} ${body.slice(0, 140).replace(/\s+/g, " ")}`);
  } catch (err) {
    console.error(`[cron] ${path} failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const jobs = parseJobs();
  console.log("[cron] scheduler started with " + jobs.length + " jobs ->", WEB_URL);
  for (const job of jobs) console.log("[cron]   " + job.schedule + "  " + job.path);

  let lastFiredMinute = -1;
  const tick = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastFiredMinute) return;
    lastFiredMinute = minute;
    for (const job of jobs) {
      if (matches(job.expr, now)) {
        fire(job.path);
      }
    }
  };
  tick();
  setInterval(tick, 15_000);
}

main().catch((err) => {
  console.error("[cron] fatal:", err);
  process.exit(1);
});
