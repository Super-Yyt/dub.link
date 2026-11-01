export const SHORT_DOMAIN = "dub.sh";

export const API_HOSTNAMES = new Set([
  "api.dub.co",
  "api-staging.dub.co",
  `api.${SHORT_DOMAIN}`,
  "api.localhost:8888",
  "api.localhost",
  ...(process.env.NEXT_PUBLIC_APP_HOSTNAMES || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .flatMap((h) => [h, `api.${h}`]),
]);

export const API_DOMAIN =
  process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
    ? "https://api.dub.co"
    : process.env.NEXT_PUBLIC_VERCEL_ENV === "preview"
      ? "https://api-staging.dub.co"
      : "http://api.localhost:8888";

export const APP_DOMAIN =
  process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
    ? "https://app.dub.co"
    : process.env.NEXT_PUBLIC_VERCEL_ENV === "preview"
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL || "preview.dub.co"}`
      : "http://localhost:8888";

export const APP_DOMAIN_WITH_NGROK =
  process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
    ? "https://app.dub.co"
    : process.env.NEXT_PUBLIC_VERCEL_ENV === "preview"
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL || "preview.dub.co"}`
      : process.env.NEXT_PUBLIC_NGROK_URL || "http://localhost:8888";

// Additional hostnames that should be treated as the app host, useful for
// self-hosted deployments where internal services (queues, schedulers)
// reach the app via its docker-network hostname (e.g. "web:3000").
const EXTRA_APP_HOSTNAMES = new Set(
  (process.env.NEXT_PUBLIC_APP_HOSTNAMES || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
);

export const isAppHostname = (hostname: string) => {
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "preview") {
    // pattern of our preview URLs are always "dub-<random-string>.dub.co"
    return hostname.startsWith("dub-") && hostname.endsWith(".dub.co");
  }
  return (
    new Set(["app.dub.co", "localhost:8888", "localhost"]).has(hostname) ||
    EXTRA_APP_HOSTNAMES.has(hostname) ||
    // single-label hostnames (e.g. "web", "web:3000") only exist inside
    // container networks, where requests always target the app itself
    !hostname.split(":")[0].includes(".")
  );
};

export const DUB_LOGO = "https://assets.dub.co/logo.png";
export const DUB_LOGO_SQUARE = "https://assets.dub.co/logo-square.png";
export const DUB_QR_LOGO = "https://assets.dub.co/logo.png";
export const DUB_WORDMARK = "https://assets.dub.co/wordmark.png";
export const DUB_THUMBNAIL = "https://assets.dub.co/thumbnail.jpg";

export const DUB_WORKSPACE_ID = "cl7pj5kq4006835rbjlt2ofka";
export const ACME_WORKSPACE_ID = "clrei1gld0002vs9mzn93p8ik";
export const LEGAL_WORKSPACE_ID = "clrflia0j0000vs7sqfhz9c7q";
export const LEGAL_USER_ID = "clqei1lgc0000vsnzi01pbf47";

export const R2_URL = process.env.STORAGE_BASE_URL || "https://dubassets.com";
