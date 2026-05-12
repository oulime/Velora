/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ASSIGNMENT_EXACT_MATCH_ONLY?: string;
  readonly VITE_PROXY_PREFIX?: string;
  /** When URL + username are set, the app skips the login form and connects on load (values are embedded in the client bundle). */
  readonly VITE_NODECAST_URL?: string;
  /** Preferred Nodecast origin (e.g. `http://host:3000`). Tried before no-port URL fallbacks. */
  readonly VITE_NODECAST_API_BASE?: string;
  /** When `"1"`, append `:3000` to `VITE_NODECAST_URL` for an extra base candidate (no port only). */
  readonly VITE_NODECAST_PREFER_PORT_3000?: string;
  readonly VITE_NODECAST_USERNAME?: string;
  readonly VITE_NODECAST_PASSWORD?: string;
  /** Xtream source id for `/api/proxy/xtream/{id}/…` when using the fast live path. */
  readonly VITE_NODECAST_XTREAM_SOURCE_ID?: string;
  /** When `"1"`, after login try direct `live_categories` / `live_streams` for `VITE_NODECAST_XTREAM_SOURCE_ID` before legacy channel probes. */
  readonly VITE_NODECAST_SKIP_CHANNEL_PROBES?: string;
  readonly NEXT_PUBLIC_SUPABASE_URL?: string;
  readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  /** When set, package cover file uploads go to this URL (Cloudflare Worker → R2). See cloudflare-workers/package-cover-r2/README.md */
  readonly VITE_CLOUDFLARE_COVER_UPLOAD_URL?: string;
  /** Bearer token for the Worker; must match Worker secret UPLOAD_SECRET. */
  readonly VITE_CLOUDFLARE_COVER_UPLOAD_SECRET?: string;
  /** When "1" or "true", uploads go to same-origin `/api/r2-package-cover` (R2_* env on the server). */
  readonly VITE_R2_COVER_UPLOAD?: string;
  /** When "1" or "true", logs package-cover upload + grid image load to the browser console (and R2 server route when set in env). */
  readonly VITE_DEBUG_PACKAGE_COVER?: string;
  /**
   * Initial country when none is stored in session yet: exact `admin_countries`-style id
   * (e.g. `country_france`) or a display name match (e.g. `France`, `Maroc`).
   */
  readonly VITE_DEFAULT_COUNTRY?: string;
  /**
   * When Xtream `get_series` is empty: load series from this URL instead of `{base}/api/favorites?itemType=series`.
   * Absolute (`https://host/api/...`) or path starting with `/` (appended to Nodecast `base`).
   */
  readonly VITE_NODECAST_SERIES_FAVORITES_URL?: string;
  /** Optional absolute origin for trial API (default: same-origin `/api/trial`). */
  readonly VITE_TRIAL_API_BASE?: string;
  /** Trial length in seconds, default 60 (server: `VITE_TRIAL_SECONDS` or `TRIAL_SECONDS`). */
  readonly VITE_TRIAL_SECONDS?: string;
  /**
   * Optional secret sent as `X-Velora-Admin-Access` for `/api/admin/*` routes.
   * Prefer server-only `ADMIN_ACCESS_KEY` / `VELORA_ADMIN_ACCESS_KEY` on the host; when empty, admin APIs are open (local dev).
   */
  readonly VITE_ADMIN_ACCESS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
