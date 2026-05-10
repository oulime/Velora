import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleAdminTrialWhitelist } from "../adminTrialWhitelistShared.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  await handleAdminTrialWhitelist(req, res, process.env);
}
