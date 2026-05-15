/** Client-side trial gate: playback-time only; server is source of truth. */

import type { TrialStatusResponse } from "./trialTypes";

type TrialErrJson = {
  error?: string;
  code?: string;
};

const isDev = import.meta.env.DEV;

let secondsRemaining = 0;
let limitSeconds = 60;
let checkoutUrl = "/checkout";
let isCounting = false;
let isBlocked = false;
let activeVideoElement: HTMLVideoElement | null = null;
let localTicksSinceSync = 0;
let incrementIntervalId: number | undefined;
let countdownIntervalId: number | undefined;
let incrementInFlight = false;
/** Network / RPC failure on trial-status (not misconfiguration). */
let verificationError = false;
/** Missing env / trial_config from API — never treated as trial exhaustion. */
let trialBackendConfigError = false;
/** Server flag: IP on admin whitelist — no countdown, no increment, no offer. */
let trialWhitelisted = false;
let trialTestMode = false;

let badgeRoot: HTMLDivElement | null = null;
let modalOverlay: HTMLDivElement | null = null;

let onTrialBlockedExtra: (() => void) | undefined;

function logTrialFailureDev(
  scope: string,
  status: number,
  body: unknown
): void {
  if (!isDev) return;
  console.error(`[trial] ${scope} failed`, { status, body });
}

function parseTrialErr(body: unknown): TrialErrJson {
  if (!body || typeof body !== "object") return {};
  const o = body as Record<string, unknown>;
  return {
    error: typeof o.error === "string" ? o.error : undefined,
    code: typeof o.code === "string" ? o.code : undefined,
  };
}

function isTrialConfigurationFailure(
  httpStatus: number,
  body: unknown
): boolean {
  if (httpStatus === 503) return true;
  return parseTrialErr(body).code === "trial_config";
}

async function requestTrialStatus(): Promise<
  | { ok: true; payload: TrialStatusResponse }
  | { ok: false; configError: boolean; status: number; body: unknown }
> {
  let r: Response;
  try {
    const headers: Record<string, string> = {};
    if (trialTestMode) headers["X-Velora-Trial-Test"] = "1";
    r = await fetch("/api/trial-status", {
      method: "GET",
      headers,
      cache: "no-store",
    });
  } catch {
    logTrialFailureDev("trial-status", 0, { message: "network error" });
    return { ok: false, configError: false, status: 0, body: null };
  }
  let parsed: unknown;
  try {
    const text = await r.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!r.ok) {
    logTrialFailureDev("trial-status", r.status, parsed);
    return {
      ok: false,
      configError: isTrialConfigurationFailure(r.status, parsed),
      status: r.status,
      body: parsed,
    };
  }
  return { ok: true, payload: parsed as TrialStatusResponse };
}

async function requestTrialIncrement(): Promise<
  | { ok: true; payload: TrialStatusResponse }
  | { ok: false; configError: boolean; status: number; body: unknown }
> {
  let r: Response;
  try {
    const headers: Record<string, string> = {};
    if (trialTestMode) headers["X-Velora-Trial-Test"] = "1";
    r = await fetch("/api/trial-increment", {
      method: "POST",
      headers,
      cache: "no-store",
    });
  } catch {
    logTrialFailureDev("trial-increment", 0, { message: "network error" });
    return { ok: false, configError: false, status: 0, body: null };
  }
  let parsed: unknown;
  try {
    const text = await r.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!r.ok) {
    logTrialFailureDev("trial-increment", r.status, parsed);
    return {
      ok: false,
      configError: isTrialConfigurationFailure(r.status, parsed),
      status: r.status,
      body: parsed,
    };
  }
  return { ok: true, payload: parsed as TrialStatusResponse };
}

function shouldResetTrialFromUrl(): boolean {
  if (!isDev) return false;
  try {
    const u = new URL(window.location.href);
    const v = u.searchParams.get("trial")?.trim().toLowerCase();
    return v === "1" || v === "reset" || v === "test";
  } catch {
    return false;
  }
}

async function requestAdminTrialReset(): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const adminKey = (import.meta.env.VITE_ADMIN_ACCESS_KEY as string | undefined)?.trim();
  if (adminKey) headers["X-Velora-Admin-Access"] = adminKey;

  let r: Response;
  try {
    r = await fetch("/api/admin/trial-reset", {
      method: "POST",
      headers,
      cache: "no-store",
    });
  } catch {
    logTrialFailureDev("admin-trial-reset", 0, { message: "network error" });
    return;
  }
  if (!r.ok) {
    let parsed: unknown = null;
    try {
      const text = await r.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    logTrialFailureDev("admin-trial-reset", r.status, parsed);
  }
}

function pauseAllVideos(): void {
  for (const el of document.querySelectorAll("video")) {
    try {
      el.pause();
    } catch {
      /* ignore */
    }
  }
}

function videosMeetPlayingGate(video: HTMLVideoElement): boolean {
  return (
    !video.paused &&
    !video.ended &&
    video.readyState >= 2
  );
}

/** True when the server considers the IP's trial exhausted (sales offer, not config/network error). */
function isTrialExpiredFromPayload(j: TrialStatusResponse): boolean {
  if (!trialTestMode && j.whitelisted === true) return false;
  if (!j.allowed || j.secondsRemaining <= 0) return true;
  const lim = j.limitSeconds;
  return typeof lim === "number" && lim > 0 && j.secondsUsed >= lim;
}

/** Only call after a successful 200 trial-status / increment payload. */
function applyServerPayload(j: TrialStatusResponse): void {
  trialWhitelisted = !trialTestMode && j.whitelisted === true;
  secondsRemaining = j.secondsRemaining;
  limitSeconds = j.limitSeconds;
  checkoutUrl = j.checkoutUrl || "/checkout";
  localTicksSinceSync = 0;

  if (trialWhitelisted) {
    isBlocked = false;
    clearTimers();
    isCounting = false;
    hideCountdownBadge();
    document.body.classList.remove("trial-locked");
    modalOverlay?.classList.add("trial-modal-overlay--hidden");
    return;
  }

  if (isTrialExpiredFromPayload(j)) {
    isBlocked = true;
  } else {
    isBlocked = false;
  }
}

function hideCountdownBadge(): void {
  badgeRoot?.classList.add("trial-countdown--hidden");
}

function showCountdownBadge(): void {
  if (
    trialWhitelisted ||
    isBlocked ||
    verificationError ||
    trialBackendConfigError
  ) {
    hideCountdownBadge();
    return;
  }
  badgeRoot?.classList.remove("trial-countdown--hidden");
}

function clearTimers(): void {
  if (incrementIntervalId != null) {
    clearInterval(incrementIntervalId);
    incrementIntervalId = undefined;
  }
  if (countdownIntervalId != null) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = undefined;
  }
}

/** Full stop: user pause/ended/teardown — reset local tick offset. */
function stopPlaybackAccounting(): void {
  clearTimers();
  isCounting = false;
  hideCountdownBadge();
}

/** Buffering / stall — timers only; preserves localTicksSinceSync for resume. */
function transientPlaybackHold(): void {
  if (!isCounting) return;
  clearTimers();
  isCounting = false;
  hideCountdownBadge();
}

function enforceTrialExpiredFromServer(): void {
  verificationError = false;
  trialBackendConfigError = false;
  isBlocked = true;
  stopPlaybackAccounting();
  activeVideoElement = null;
  document.body.classList.add("trial-locked");
  pauseAllVideos();
  hideCountdownBadge();
  onTrialBlockedExtra?.();
  showTrialExpiredModal();
}

function enforceVerificationFailure(): void {
  verificationError = true;
  trialBackendConfigError = false;
  stopPlaybackAccounting();
  activeVideoElement = null;
  pauseAllVideos();
  hideCountdownBadge();
  onTrialBlockedExtra?.();
  showTrialExpiredModal();
}

function enforceTrialConfigurationFailure(): void {
  trialBackendConfigError = true;
  verificationError = false;
  stopPlaybackAccounting();
  activeVideoElement = null;
  pauseAllVideos();
  hideCountdownBadge();
  onTrialBlockedExtra?.();
  document.body.classList.remove("trial-locked");
  showTrialExpiredModal();
}

async function runTrialIncrement(): Promise<void> {
  if (isBlocked || incrementInFlight) return;
  incrementInFlight = true;
  try {
    const result = await requestTrialIncrement();
    if (!result.ok) {
      if (result.configError) {
        enforceTrialConfigurationFailure();
      } else {
        enforceVerificationFailure();
      }
      return;
    }
    const j = result.payload;
    applyServerPayload(j);
    if (trialWhitelisted) {
      return;
    }
    localTicksSinceSync = 0;
    updateTrialCountdownUI();
    if (isTrialExpiredFromPayload(j)) {
      enforceTrialExpiredFromServer();
    }
  } finally {
    incrementInFlight = false;
  }
}

export function updateTrialCountdownUI(): void {
  if (!badgeRoot) return;
  const timeEl = badgeRoot.querySelector(".trial-countdown__time");
  const ring = badgeRoot.querySelector(
    ".trial-countdown__progress-ring-fill"
  ) as SVGCircleElement | null;
  if (!timeEl) return;

  const displayRemaining = Math.max(
    0,
    secondsRemaining - localTicksSinceSync
  );
  const m = Math.floor(displayRemaining / 60);
  const s = Math.floor(displayRemaining % 60);
  timeEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

  const lim = Math.max(1, limitSeconds);
  const frac = Math.min(1, displayRemaining / lim);
  badgeRoot.classList.toggle("trial-countdown--warning", displayRemaining < 10 && displayRemaining > 0);

  if (ring) {
    const c = 2 * Math.PI * 16;
    ring.style.strokeDashoffset = String(c * (1 - frac));
  }
}

function startPlaybackAccounting(video: HTMLVideoElement): void {
  if (
    trialWhitelisted ||
    isBlocked ||
    verificationError ||
    trialBackendConfigError
  )
    return;
  if (!videosMeetPlayingGate(video)) return;

  activeVideoElement = video;
  clearTimers();
  isCounting = true;
  showCountdownBadge();
  updateTrialCountdownUI();

  countdownIntervalId = window.setInterval(() => {
    if (!isCounting || !activeVideoElement) return;
    if (!videosMeetPlayingGate(activeVideoElement)) return;
    localTicksSinceSync += 1;
    updateTrialCountdownUI();
    const displayRemaining = Math.max(
      0,
      secondsRemaining - localTicksSinceSync
    );
    if (displayRemaining <= 0) {
      void runTrialIncrement();
    }
  }, 1000);

  incrementIntervalId = window.setInterval(() => {
    if (!isCounting || !activeVideoElement) return;
    if (!videosMeetPlayingGate(activeVideoElement)) return;
    void runTrialIncrement();
  }, 5000);
}

function onTransientPlaybackStop(video: HTMLVideoElement): void {
  if (activeVideoElement !== video) return;
  transientPlaybackHold();
}

function attachVideoLifecycle(video: HTMLVideoElement): void {
  const onPlaying = (): void => {
    if (trialWhitelisted) return;
    if (isBlocked || verificationError || trialBackendConfigError) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      showTrialExpiredModal();
      return;
    }
    if (!videosMeetPlayingGate(video)) return;
    markPlaybackStarted(video);
  };

  const onHardStop = (): void => {
    markPlaybackStopped(video);
  };

  video.addEventListener("playing", onPlaying);
  video.addEventListener("pause", onHardStop);
  video.addEventListener("ended", onHardStop);
  video.addEventListener("error", onHardStop);
  video.addEventListener("emptied", onHardStop);
  video.addEventListener("abort", onHardStop);

  video.addEventListener("waiting", () => onTransientPlaybackStop(video));
  video.addEventListener("stalled", () => onTransientPlaybackStop(video));
  video.addEventListener("suspend", () => onTransientPlaybackStop(video));
}

function ensureBadgeMounted(): void {
  if (badgeRoot) return;
  const root = document.createElement("div");
  root.id = "trial-countdown-root";
  root.className = "trial-countdown trial-countdown--hidden";
  root.innerHTML = `
    <div class="trial-countdown__inner">
      <svg class="trial-countdown__svg" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="trial-countdown__progress-ring-bg" cx="18" cy="18" r="16" fill="none" stroke-width="2.5" />
        <circle class="trial-countdown__progress-ring-fill" cx="18" cy="18" r="16" fill="none" stroke-width="2.5"
          stroke-linecap="round"
          stroke-dasharray="100.531"
          stroke-dashoffset="0"
          transform="rotate(-90 18 18)" />
      </svg>
      <div class="trial-countdown__text">
        <span class="trial-countdown__label">Essai gratuit</span>
        <span class="trial-countdown__time">01:00</span>
      </div>
    </div>
    <div class="trial-countdown__progress" aria-hidden="true"></div>
  `;
  document.body.appendChild(root);
  badgeRoot = root;
}

function ensureModalMounted(): void {
  if (modalOverlay) return;
  const overlay = document.createElement("div");
  overlay.className =
    "trial-offer-overlay trial-modal-overlay trial-modal-overlay--hidden";
  overlay.innerHTML = `
    <div class="trial-offer-page">
      <div class="trial-offer-card trial-modal-card" role="dialog" aria-modal="true" aria-labelledby="trial-offer-title">
        <div class="trial-offer-sales hidden">
          <div class="trial-offer-badge">VENTE FLASH -60%</div>
          <p class="trial-offer-urgency">Aujourd’hui seulement</p>
          <h2 id="trial-offer-title" class="trial-offer-title">Débloquez l’accès illimité à VeloraVIP</h2>
          <p class="trial-offer-subtitle">Votre minute d’essai gratuite est terminée. Profitez maintenant de l’offre spéciale pour continuer à regarder vos chaînes, films et séries sans limite.</p>
          <div class="trial-offer-highlight" role="button" tabindex="0" data-tv-focusable="true" aria-label="Offre spéciale aujourd’hui">
            <span class="trial-offer-highlight-label">Offre spéciale aujourd’hui</span>
            <span class="trial-offer-discount" aria-hidden="true">-60%</span>
            <div class="trial-offer-highlight-row">
              <span>Accès illimité</span>
              <span class="trial-offer-highlight-dot">•</span>
              <span>Tous les appareils inclus</span>
            </div>
          </div>
          <ul class="trial-offer-benefits">
            <li class="trial-offer-benefit">Plus de chaînes en direct</li>
            <li class="trial-offer-benefit">Films et séries à la demande</li>
            <li class="trial-offer-benefit">Compatible TV, tablette, mobile et ordinateur</li>
            <li class="trial-offer-benefit">Fonctionne aussi sur Smart TV, Android Box et navigateur web</li>
            <li class="trial-offer-benefit">Accès instantané après paiement</li>
            <li class="trial-offer-benefit">Qualité HD / FHD selon disponibilité</li>
          </ul>
          <section class="trial-offer-devices" aria-labelledby="trial-offer-devices-heading">
            <h3 id="trial-offer-devices-heading" class="trial-offer-devices-title">Regardez partout, sans exception</h3>
            <p class="trial-offer-devices-text">Votre accès fonctionne sur TV, téléphone, tablette, ordinateur, Android Box et navigateur web.</p>
          </section>
          <button type="button" class="trial-offer-button trial-modal-button primary">Obtenir ma promo maintenant</button>
          <p class="trial-offer-reassurance">Activation rapide • Accès immédiat • Offre limitée</p>
        </div>
        <div class="trial-offer-error hidden">
          <h2 class="trial-modal-title trial-error-title"></h2>
          <p class="trial-modal-message trial-error-message"></p>
          <button type="button" class="trial-modal-button primary trial-error-retry">Réessayer</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  modalOverlay = overlay;
}

export function showTrialExpiredModal(messageOverride?: string): void {
  ensureModalMounted();
  if (!modalOverlay) return;

  const salesEl = modalOverlay.querySelector(".trial-offer-sales");
  const errorEl = modalOverlay.querySelector(".trial-offer-error");
  const titleEl = modalOverlay.querySelector(".trial-error-title");
  const msgEl = modalOverlay.querySelector(".trial-error-message");
  const retryBtn = modalOverlay.querySelector(
    ".trial-error-retry"
  ) as HTMLButtonElement | null;
  const offerBtn = modalOverlay.querySelector(
    ".trial-offer-button"
  ) as HTMLButtonElement | null;
  const offerHighlight = modalOverlay.querySelector(
    ".trial-offer-highlight"
  ) as HTMLElement | null;

  if (!salesEl || !errorEl || !titleEl || !msgEl || !retryBtn || !offerBtn) {
    return;
  }

  void messageOverride;

  if (trialBackendConfigError) {
    salesEl.classList.add("hidden");
    errorEl.classList.remove("hidden");
    titleEl.textContent = "Configuration incomplète";
    msgEl.textContent =
      "Le système d’essai gratuit n’est pas encore configuré. Veuillez réessayer plus tard.";
    offerBtn.onclick = null;
    retryBtn.onclick = async (): Promise<void> => {
      const result = await requestTrialStatus();
      if (result.ok) {
        trialBackendConfigError = false;
        verificationError = false;
        applyServerPayload(result.payload);
        if (isTrialExpiredFromPayload(result.payload)) {
          enforceTrialExpiredFromServer();
        } else {
          document.body.classList.remove("trial-locked");
          modalOverlay?.classList.add("trial-modal-overlay--hidden");
        }
        return;
      }
      trialBackendConfigError = result.configError;
      verificationError = !result.configError;
      showTrialExpiredModal();
    };
  } else if (verificationError) {
    salesEl.classList.add("hidden");
    errorEl.classList.remove("hidden");
    titleEl.textContent = "Vérification impossible";
    msgEl.textContent =
      "Impossible de vérifier votre accès. Veuillez réessayer.";
    offerBtn.onclick = null;
    retryBtn.onclick = async (): Promise<void> => {
      verificationError = false;
      const result = await requestTrialStatus();
      if (result.ok) {
        trialBackendConfigError = false;
        verificationError = false;
        applyServerPayload(result.payload);
        if (isTrialExpiredFromPayload(result.payload)) {
          enforceTrialExpiredFromServer();
        } else {
          document.body.classList.remove("trial-locked");
          modalOverlay?.classList.add("trial-modal-overlay--hidden");
        }
        return;
      }
      if (result.configError) {
        trialBackendConfigError = true;
        verificationError = false;
      } else {
        verificationError = true;
        trialBackendConfigError = false;
      }
      showTrialExpiredModal();
    };
  } else {
    errorEl.classList.add("hidden");
    salesEl.classList.remove("hidden");
    retryBtn.onclick = null;
    offerBtn.onclick = (): void => {
      window.location.href = checkoutUrl || "/checkout";
    };
    if (offerHighlight) {
      offerHighlight.onclick = (): void => {
        offerBtn.click();
      };
    }
  }

  modalOverlay.classList.remove("trial-modal-overlay--hidden");
}

/** Alias for the expired-trial sales surface (same overlay; idempotent). */
export function showTrialOfferPage(): void {
  showTrialExpiredModal();
}

export function initTrialGate(options?: { onTrialBlocked?: () => void }): void {
  onTrialBlockedExtra = options?.onTrialBlocked;
  ensureBadgeMounted();

  void (async () => {
    trialTestMode = shouldResetTrialFromUrl();
    if (trialTestMode) {
      isBlocked = false;
      verificationError = false;
      trialBackendConfigError = false;
      trialWhitelisted = false;
      localTicksSinceSync = 0;
      document.body.classList.remove("trial-locked");
      modalOverlay?.classList.add("trial-modal-overlay--hidden");
      await requestAdminTrialReset();
    }

    const result = await requestTrialStatus();
    if (!result.ok) {
      if (result.configError) {
        trialBackendConfigError = true;
        verificationError = false;
      } else {
        verificationError = true;
        trialBackendConfigError = false;
      }
      showTrialExpiredModal();
      return;
    }
    trialBackendConfigError = false;
    verificationError = false;
    applyServerPayload(result.payload);
    if (isTrialExpiredFromPayload(result.payload)) {
      enforceTrialExpiredFromServer();
    } else {
      document.body.classList.remove("trial-locked");
    }
  })();

  const vLive = document.querySelector("#video") as HTMLVideoElement | null;
  const vVod = document.querySelector("#video-vod") as HTMLVideoElement | null;
  if (vLive) attachVideoLifecycle(vLive);
  if (vVod) attachVideoLifecycle(vVod);
}

export async function canStartPlayback(): Promise<boolean> {
  if (trialWhitelisted) return true;
  if (isBlocked) {
    showTrialExpiredModal();
    return false;
  }
  try {
    const result = await requestTrialStatus();
    if (!result.ok) {
      if (result.configError) {
        trialBackendConfigError = true;
        verificationError = false;
      } else {
        verificationError = true;
        trialBackendConfigError = false;
      }
      showTrialExpiredModal();
      return false;
    }
    trialBackendConfigError = false;
    verificationError = false;
    applyServerPayload(result.payload);
    if (isTrialExpiredFromPayload(result.payload)) {
      enforceTrialExpiredFromServer();
      return false;
    }
    document.body.classList.remove("trial-locked");
    return true;
  } catch {
    verificationError = true;
    trialBackendConfigError = false;
    showTrialExpiredModal();
    return false;
  }
}

export function markPlaybackStarted(videoElement?: HTMLVideoElement | null): void {
  const v = videoElement ?? null;
  if (trialWhitelisted) return;
  if (!v || isBlocked || verificationError || trialBackendConfigError) return;
  if (!videosMeetPlayingGate(v)) return;
  startPlaybackAccounting(v);
}

export function markPlaybackStopped(videoElement?: HTMLVideoElement | null): void {
  if (videoElement != null && activeVideoElement !== videoElement) return;
  stopPlaybackAccounting();
  activeVideoElement = null;
}

export function isTrialBlocked(): boolean {
  return isBlocked;
}
