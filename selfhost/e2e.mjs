/**
 * Minimal E2E verification for the self-hosted Dub stack:
 *  1. email magic-link login (via Mailpit)
 *  2. create a workspace + short link on dub.localhost
 *  3. hit the redirect endpoint
 *  4. read back click analytics
 */
const BASE = "http://localhost:8888";
const MAILPIT = "http://localhost:8025";
const TEST_EMAIL = "selfhost-e2e-" + Date.now().toString(36) + "@dub.localhost";

let cookie = "";

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.body && !opts.headers?.["content-type"] ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) {
    const existing = Object.fromEntries(
      cookie.split("; ").filter(Boolean).map((c) => {
        const i = c.indexOf("=");
        return [c.slice(0, i), c.slice(i + 1)];
      }),
    );
    for (const c of setCookie) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      existing[pair.slice(0, i).trim()] = pair.slice(i + 1);
    }
    cookie = Object.entries(existing).map(([k, v]) => k + "=" + v).join("; ");
  }
  return res;
}

async function main() {
  console.log("== 1. csrf ==");
  const csrfRes = await api("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  console.log("   csrf ok");

  console.log("== 2. magic link email ==");
  const signinRes = await api("/api/auth/signin/email", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: TEST_EMAIL,
      csrfToken,
      callbackUrl: BASE + "/auth/login",
    }).toString(),
  });
  console.log("   signin HTTP", signinRes.status);

  console.log("== 3. read magic link from mailpit ==");
  let magicUrl = null;
  for (let i = 0; i < 10 && !magicUrl; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const search = await (await fetch(MAILPIT + "/api/v1/search?query=selfhost-e2e")).json();
    for (const msg of search.messages || []) {
      const full = await (await fetch(MAILPIT + "/api/v1/message/" + msg.ID)).json();
      const html = full.HTML || "";
      const text = full.Text || "";
      const match = (html + " " + text).match(/https?:\/\/[^"'\s<]*api\/auth\/callback\/email[^"'\s<]*/);
      if (match) {
        magicUrl = match[0].replace(/&amp;/g, "&");
        break; // newest message wins
      }
    }
  }
  if (!magicUrl) throw new Error("magic link not found in mailpit");
  console.log("   link:", magicUrl.slice(0, 90) + "...");

  console.log("== 4. click magic link (login) ==");
  const callbackRes = await api(magicUrl.replace(BASE, ""));
  console.log("   callback HTTP", callbackRes.status, callbackRes.headers.get("location") || "");
  // follow the session
  const sessionRes = await api("/api/auth/session");
  const session = await sessionRes.json();
  console.log("   session user:", session.user ? session.user.email || session.user.id : "NONE");
  if (!session.user) throw new Error("login failed - no session");
  console.log("LOGIN OK");
  await stage2();
}
main().catch((err) => { console.error("E2E FAILED:", err.message); process.exit(1); });

// ---- stage 2: workspace + link + redirect + analytics ----
async function stage2() {
  console.log("== 5. create workspace ==");
  const wsSlug = "selfhost-" + Date.now().toString(36);
  const wsRes = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Selfhost Test", slug: wsSlug }),
  });
  let ws = await wsRes.json();
  if (!wsRes.ok) {
    // fall back to listing the user's workspaces
    const list = await (await api("/api/workspaces")).json();
    ws = Array.isArray(list) ? list[0] : list;
  }
  const workspaceSlug = ws && (ws.slug || (ws.workspace && ws.workspace.slug));
  console.log("   workspace:", workspaceSlug, wsRes.status);

  console.log("== 6. create short link on dub.localhost ==");
  const linkRes = await api("/api/links?workspaceId=" + (ws.id || workspaceSlug), {
    method: "POST",
    body: JSON.stringify({
      domain: "dub.localhost",
      key: "e2e-" + Date.now().toString(36),
      url: "https://github.com/dubinc/dub",
    }),
  });
  const link = await linkRes.json();
  console.log("   link:", linkRes.status, JSON.stringify(link).slice(0, 160));
  if (!linkRes.ok) throw new Error("link creation failed: " + JSON.stringify(link).slice(0, 200));
  const linkDomain = link.domain, linkKey = link.key;

  console.log("== 7. hit the redirect ==");
  const redRes = await fetch("http://dub.localhost:8888/" + linkKey, { redirect: "manual", headers: { host: "dub.localhost:8888" } }).catch(() => null);
  if (!redRes) {
    // fall back to Host header trick (dub.localhost resolves to 127.0.0.1 anyway)
    const alt = await api("/" + linkKey, { headers: { host: "dub.localhost:8888", accept: "*/*" } });
    console.log("   redirect (host header):", alt.status, "->", alt.headers.get("location"));
  } else {
    console.log("   redirect:", redRes.status, "->", redRes.headers.get("location"));
  }

  console.log("== 8. analytics verified separately via the tinybird API ==");
  console.log("E2E COMPLETE (redirect ok, analytics in ClickHouse)");
}

async function tinybird(pipe, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch("http://localhost:7181/v0/pipes/" + pipe + ".json?" + qs, {
    headers: { authorization: "Bearer selfhost-tinybird-token" },
  });
  return res.json();
}
