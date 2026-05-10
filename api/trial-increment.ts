/**
 * POST /api/trial-increment
 *
 * Returns **200** only when the Supabase admin client is configured and `increment_trial_usage` RPC succeeds.
 *
 * Configuration errors (missing `SUPABASE_SERVICE_ROLE_KEY`, missing URL after fallback):
 * **503** with body `{ "error": "<message>", "code": "trial_config" }`.
 *
 * Missing service role responds with **exactly**:
 * `"Missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local for local dev and to deployment environment variables for production."`
 *
 * URL resolution: `SUPABASE_URL`, else fall back to `NEXT_PUBLIC_SUPABASE_URL` (never use anon/publishable key as service role).
 *
 * @see ../api/trialShared.ts — `handleTrialIncrement`, `TRIAL_ERROR_MISSING_SERVICE_ROLE_KEY`
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleTrialIncrement } from "./trialShared.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  await handleTrialIncrement(req, res);
}
