import { NextRequest } from "next/server";
import { DOMAIN_REDIRECTS } from "./domain-redirects";

export const parse = (req: NextRequest) => {
  let domain = req.headers.get("host") as string;
  // path is the path of the URL (e.g. dub.sh/stats/github -> /stats/github)
  let path = req.nextUrl.pathname;

  // remove www. from domain and convert to lowercase
  domain = domain.replace(/^www./, "").toLowerCase();

  // self-hosted deployments often serve on a non-standard port
  // (e.g. dub.localhost:8888); link domains are stored without the port,
  // so strip it before doing any domain lookups
  domain = domain.replace(/:\d+$/, "");

  if (DOMAIN_REDIRECTS[domain]) {
    domain = DOMAIN_REDIRECTS[domain];
  }

  // (the upstream Playwright e2e hack for dub.localhost:8888 is not needed
  // here: self-hosted stacks serve real domains from the database)

  // fullPath is the full URL path (along with search params)
  const searchParams = req.nextUrl.searchParams.toString();
  const searchParamsObj = Object.fromEntries(req.nextUrl.searchParams);
  const searchParamsString = searchParams.length > 0 ? `?${searchParams}` : "";
  const fullPath = `${path}${searchParamsString}`;

  // Here, we are using decodeURIComponent to handle foreign languages like Hebrew and Korean
  const key = decodeURIComponent(path.split("/")[1]); // key is the first part of the path (e.g. dub.sh/stats/github -> stats)
  const fullKey = decodeURIComponent(path.slice(1)); // fullKey is the full path without the first slash (to account for multi-level subpaths, e.g. d.to/github/repo -> github/repo)

  return {
    domain,
    path,
    fullPath,
    key,
    fullKey,
    shortLink: `https://${domain}/${fullKey}`,
    searchParamsObj,
    searchParamsString,
  };
};
