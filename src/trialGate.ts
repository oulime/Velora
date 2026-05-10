/** Client-side trial gate: playback-time only; server is source of truth. */

type TrialApiPayload = {
  allowed: boolean;
  secondsUsed: number;
  secondsRemaining: number;
  limitSeconds: number;
  checkoutUrl: string;
};

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
  | { ok: true; payload: TrialApiPayload }
  | { ok: false; configError: boolean; status: number; body: unknown }
> {
  let r: Response;
  try {
    r = await fetch("/api/trial-status", { method: "GET", cache: "no-store" });
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
  return { ok: true, payload: parsed as TrialApiPayload };
}

async function requestTrialIncrement(): Promise<
  | { ok: true; payload: TrialApiPayload }
  | { ok: false; configError: boolean; status: number; body: unknown }
> {
  let r: Response;
  try {
    r = await fetch("/api/trial-increment", {
      method: "POST",
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
  return { ok: true, payload: parsed as TrialApiPayload };
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

/** Only call after a successful 200 trial-status / increment payload. */
function applyServerPayload(j: TrialApiPayload): void {
  secondsRemaining = j.secondsRemaining;
  limitSeconds = j.limitSeconds;
  checkoutUrl = j.checkoutUrl || "/checkout";
  if (!j.allowed || j.secondsRemaining <= 0) {
    isBlocked = true;
  } else {
    isBlocked = false;
  }
}

function hideCountdownBadge(): void {
  badgeRoot?.classList.add("trial-countdown--hidden");
}

function showCountdownBadge(): void {
  if (isBlocked || verificationError || trialBackendConfigError) {
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
  localTicksSinceSync = 0;
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
    localTicksSinceSync = 0;
    updateTrialCountdownUI();
    if (!j.allowed || j.secondsRemaining <= 0) {
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
  if (isBlocked || verificationError || trialBackendConfigError) return;
  if (!videosMeetPlayingGate(video)) return;

  const resumeFromBufferHold =
    activeVideoElement === video && !isCounting;

  activeVideoElement = video;
  clearTimers();
  isCounting = true;
  if (!resumeFromBufferHold) {
    localTicksSinceSync = 0;
  }
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
    if (isBlocked || verificationError || trialBackendConfigError) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
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
  overlay.className = "trial-modal-overlay trial-modal-overlay--hidden";
  overlay.innerHTML = `
    <div class="trial-modal-card" role="dialog" aria-modal="true" aria-labelledby="trial-modal-title">
      <h2 id="trial-modal-title" class="trial-modal-title"></h2>
      <p class="trial-modal-message"></p>
      <p class="trial-modal-note"></p>
      <button type="button" class="trial-modal-button primary"></button>
    </div>
  `;
  document.body.appendChild(overlay);
  modalOverlay = overlay;
}

export function showTrialExpiredModal(messageOverride?: string): void {
  ensureModalMounted();
  if (!modalOverlay) return;

  const titleEl = modalOverlay.querySelector(".trial-modal-title");
  const msgEl = modalOverlay.querySelector(".trial-modal-message");
  const noteEl = modalOverlay.querySelector(".trial-modal-note");
  const btn = modalOverlay.querySelector(
    ".trial-modal-button"
  ) as HTMLButtonElement | null;
  if (!titleEl || !msgEl || !noteEl || !btn) return;

  void messageOverride;

  if (trialBackendConfigError) {
    titleEl.textContent = "Configuration incomplète";
    msgEl.textContent =
      "Le système d’essai gratuit n’est pas encore configuré. Veuillez réessayer plus tard.";
    noteEl.textContent = "";
    noteEl.classList.add("hidden");
    btn.textContent = "Réessayer";
    btn.onclick = async (): Promise<void> => {
      const result = await requestTrialStatus();
      if (result.ok) {
        trialBackendConfigError = false;
        verificationError = false;
        applyServerPayload(result.payload);
        modalOverlay?.classList.add("trial-modal-overlay--hidden");
        if (!result.payload.allowed) {
          document.body.classList.add("trial-locked");
        } else {
          document.body.classList.remove("trial-locked");
        }
        return;
      }
      trialBackendConfigError = result.configError;
      verificationError = !result.configError;
      showTrialExpiredModal();
    };
  } else if (verificationError) {
    titleEl.textContent = "Vérification impossible";
    msgEl.textContent =
      "Impossible de vérifier votre accès. Veuillez réessayer.";
    noteEl.textContent = "";
    noteEl.classList.add("hidden");
    btn.textContent = "Réessayer";
    btn.onclick = async (): Promise<void> => {
      verificationError = false;
      const result = await requestTrialStatus();
      if (result.ok) {
        trialBackendConfigError = false;
        applyServerPayload(result.payload);
        modalOverlay?.classList.add("trial-modal-overlay--hidden");
        document.body.classList.toggle("trial-locked", !result.payload.allowed);
        if (!result.payload.allowed) {
          isBlocked = true;
        } else {
          isBlocked = false;
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
    titleEl.textContent = "Votre essai gratuit est terminé";
    msgEl.textContent =
      "Vous avez utilisé votre minute d’essai gratuite. Pour continuer à regarder sans limite, activez votre abonnement maintenant.";
    noteEl.textContent = "Accès instantané après paiement.";
    noteEl.classList.remove("hidden");
    btn.textContent = "Obtenir un accès illimité";
    btn.onclick = (): void => {
      window.location.href = checkoutUrl || "/checkout";
    };
  }

  modalOverlay.classList.remove("trial-modal-overlay--hidden");
}

export function initTrialGate(options?: { onTrialBlocked?: () => void }): void {
  onTrialBlockedExtra = options?.onTrialBlocked;
  ensureBadgeMounted();

  void (async () => {
    const result = await requestTrialStatus();
    if (!result.ok) {
      if (result.configError) {
        trialBackendConfigError = true;
        verificationError = false;
      } else {
        verificationError = true;
        trialBackendConfigError = false;
      }
      return;
    }
    trialBackendConfigError = false;
    verificationError = false;
    applyServerPayload(result.payload);
    if (!result.payload.allowed) {
      document.body.classList.add("trial-locked");
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
  if (isBlocked) return false;
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
      return false;
    }
    trialBackendConfigError = false;
    verificationError = false;
    applyServerPayload(result.payload);
    if (!result.payload.allowed) {
      document.body.classList.add("trial-locked");
      return false;
    }
    document.body.classList.remove("trial-locked");
    return true;
  } catch {
    verificationError = true;
    trialBackendConfigError = false;
    return false;
  }
}

export function markPlaybackStarted(videoElement?: HTMLVideoElement | null): void {
  const v = videoElement ?? null;
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
