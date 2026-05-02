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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
