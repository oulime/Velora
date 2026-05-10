/**
 * Block `/proxy` traffic when trial seconds are exhausted (402); whitelist bypass.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  TrialConfigurationError,
  detectClientIp,
  getCheckoutUrl,
  getTrialLimitSeconds,
  getTrialUsageForIp,
  isTrialIpWhitelisted,
} from "./trialShared.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * @returns true to continue the proxy, false if response already sent (402).
 */
export async function ensureProxyTrialAllowsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  try {
    const ip = detectClientIp(req);
    if (await isTrialIpWhitelisted(ip, env)) return true;
    const used = await getTrialUsageForIp(ip, env);
    const limit = getTrialLimitSeconds(env);
    if (used >= limit) {
      sendJson(res, 402, {
        error: "Trial exhausted",
        code: "trial_exhausted",
        checkoutUrl: getCheckoutUrl(env),
      });
      return false;
    }
    return true;
  } catch (e) {
    if (e instanceof TrialConfigurationError) {
      return true;
    }
    console.warn("[proxy] trial gate skipped:", e instanceof Error ? e.message : e);
    return true;
  }
}
