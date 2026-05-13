/**
 * Frontend Xtream catalog list endpoints: always return 200 + JSON body from the proxy
 * (R2 or upstream), never 304 with an empty body — browsers cannot parse JSON from 304.
 */

export function isXtreamFrontendCatalogJsonPathname(pathname: string): boolean {
  const p = pathname.toLowerCase();
  if (!p.includes("/api/proxy/xtream/")) return false;
  return (
    p.endsWith("/live_categories") ||
    p.endsWith("/live_streams") ||
    p.endsWith("/vod_categories") ||
    p.endsWith("/vod_streams") ||
    p.endsWith("/series_categories") ||
    p.endsWith("/series") ||
    p.endsWith("/get_series")
  );
}

export function isXtreamFrontendCatalogJsonTarget(targetUrl: string): boolean {
  try {
    const u = new URL(targetUrl);
    if (isXtreamFrontendCatalogJsonPathname(u.pathname)) return true;
    const p = u.pathname.toLowerCase();
    if (!p.includes("/api/proxy/xtream/")) return false;
    if (p.endsWith("/player_api") || p.endsWith("/player_api.php")) {
      const a = u.searchParams.get("action")?.toLowerCase() ?? "";
      return a === "get_series" || a === "get_vod_streams" || a === "get_live_streams";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Live TV catalogue only (channel lists + Xtream live_categories / live_streams).
 * VOD and series JSON is never R2- or edge-catalog-cached — always upstream for raw Nodecast data.
 */
export function isXtreamLiveCatalogR2CacheTarget(targetUrl: string): boolean {
  try {
    const u = new URL(targetUrl);
    const p = u.pathname.toLowerCase();
    if (
      p.endsWith("/api/channels") ||
      p.endsWith("/api/live/channels") ||
      p.endsWith("/api/content/live") ||
      p.endsWith("/api/streams/live") ||
      p.endsWith("/api/tv/channels") ||
      p.endsWith("/api/content/channels") ||
      p.endsWith("/api/live")
    ) {
      return true;
    }
    return isXtreamFrontendCatalogJsonTarget(targetUrl);
  } catch {
    return false;
  }
}

/** Strip validators so Nodecast/upstream does not answer 304 when the client revalidates. */
export function stripCatalogConditionalRequestHeaders(
  headers: Record<string, string>,
  targetUrl: string
): void {
  if (!isXtreamFrontendCatalogJsonTarget(targetUrl)) return;
  delete headers["If-None-Match"];
  delete headers["If-Modified-Since"];
}

export type CatalogJsonResponseHeadersSink = {
  setHeader(name: string, value: string | number | readonly string[]): void;
  removeHeader(name: string): void;
};

export function catalogBrowserCacheMaxAgeSeconds(
  env: Record<string, string | undefined | boolean | number>
): number {
  const raw =
    env.CATALOG_BROWSER_CACHE_MAX_AGE_SECONDS ??
    env.VITE_CATALOG_BROWSER_CACHE_TTL_SECONDS ??
    60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(Math.round(n), 0), 3600);
}

/**
 * Xtream catalog list JSON: never cache at browser or edge; no validators on the wire.
 * Used for live_categories, live_streams, vod_*, series_* (see isXtreamFrontendCatalogJsonTarget).
 */
export function applyVeloraFrontendCatalogJsonResponseHeaders(res: CatalogJsonResponseHeadersSink): void {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("X-Velora-Catalog-Cache", "DISABLED");
  try {
    res.removeHeader("ETag");
    res.removeHeader("Last-Modified");
  } catch {
    /* ignore */
  }
}

/** When unset, catalog R2 is off (debug default). Set both to "0" to allow R2 for non-list catalog paths. */
export function isCatalogJsonCacheDisabledByEnv(
  env: Record<string, string | undefined | boolean | number>
): boolean {
  const d = String(env.DISABLE_CATALOG_CACHE ?? "").trim();
  const v = String(env.VITE_DISABLE_CATALOG_CACHE ?? "").trim();
  if (d === "0" && v === "0") return false;
  if (!d && !v) return true;
  return d === "1" || v === "1" || /^true$/i.test(d) || /^true$/i.test(v);
}
