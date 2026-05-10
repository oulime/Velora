/** Shared trial API shapes (mirrors `api/trialShared.ts` JSON). */

export type TrialStatusResponse = {
  allowed: boolean;
  whitelisted?: boolean;
  secondsUsed: number;
  secondsRemaining: number;
  limitSeconds: number;
  checkoutUrl: string;
};

export type TrialIpWhitelistItem = {
  ipAddress: string;
  label?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
