/** Re-export: implementation in `api/lib/` for a single source of truth with serverless `/api/proxy`. */
export {
  proxyQueryNeedsB64Transport,
  toBase64UrlUtf8,
  fromBase64UrlUtf8,
  proxiedQueryString,
  proxiedFullUrl,
} from "../api/lib/proxyParamTransport";
