/** Re-export: shared with Vercel `api/proxy` (see `api/proxyParamTransport.ts`). */
export {
  proxyQueryNeedsB64Transport,
  toBase64UrlUtf8,
  fromBase64UrlUtf8,
  proxiedQueryString,
  proxiedFullUrl,
} from "../api/proxyParamTransport";
