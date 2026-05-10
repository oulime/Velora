import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleAdminMyIp } from "../adminTrialWhitelistShared.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  await handleAdminMyIp(req, res, process.env);
}
