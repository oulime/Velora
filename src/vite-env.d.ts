/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ASSIGNMENT_EXACT_MATCH_ONLY?: string;
  readonly VITE_PROXY_PREFIX?: string;
  readonly VITE_ADMIN_ACCESS_KEY?: string;
  /** When URL + username are set, the app skips the login form and connects on load (values are embedded in the client bundle). */
  readonly VITE_NODECAST_URL?: string;
  readonly VITE_NODECAST_USERNAME?: string;
  readonly VITE_NODECAST_PASSWORD?: string;
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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
