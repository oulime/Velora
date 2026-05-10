/**
 * Square export for package covers: image fits entirely inside the square (letterbox / pillarbox),
 * empty bands filled with solid color, linear gradient, or transparency (PNG). Optional zoom + pan.
 */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const VIEW_CSS = 300;
const EXPORT_MAX = 960;
const JPEG_QUALITY_START = 0.9;
const DEFAULT_FILL = "#141118";
const DEFAULT_GRADIENT_END = "#3d2a55";
/** 1 = image entière « contain » dans le carré ; sous 1 = dézoom (marges remplies par le fond choisi). */
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 3;

/** `localStorage` : derniers réglages du dialogue « Recadrer en carré » (sauvegardés au clic sur Valider). */
const COVER_SQUARE_CROP_UI_LS_KEY = "velora.coverSquareCropUi.v1";

const elDialog = document.getElementById("dialog-cover-square-crop") as HTMLDialogElement | null;
const elCanvas = document.getElementById("crop-sq-canvas") as HTMLCanvasElement | null;
const elViewport = document.getElementById("crop-sq-viewport") as HTMLDivElement | null;
const elZoom = document.getElementById("crop-sq-zoom") as HTMLInputElement | null;
const elFillMode = document.getElementById("crop-sq-fill-mode") as HTMLSelectElement | null;
const elFill = document.getElementById("crop-sq-fill") as HTMLInputElement | null;
const elFillStart = document.getElementById("crop-sq-fill-start") as HTMLInputElement | null;
const elFillEnd = document.getElementById("crop-sq-fill-end") as HTMLInputElement | null;
const elGradientKind = document.getElementById("crop-sq-gradient-kind") as HTMLSelectElement | null;
const elGradientAngleWrap = document.getElementById("crop-sq-gradient-angle-wrap") as HTMLDivElement | null;
const elGradientAngleLabel = document.getElementById("crop-sq-gradient-angle-label") as HTMLLabelElement | null;
const elGradientAngle = document.getElementById("crop-sq-gradient-angle") as HTMLInputElement | null;
const elGradientAngleVal = document.getElementById("crop-sq-gradient-angle-val") as HTMLSpanElement | null;
const elGradientPosX = document.getElementById("crop-sq-gradient-cx") as HTMLInputElement | null;
const elGradientPosY = document.getElementById("crop-sq-gradient-cy") as HTMLInputElement | null;
const elGradientPosXVal = document.getElementById("crop-sq-gradient-cx-val") as HTMLSpanElement | null;
const elGradientPosYVal = document.getElementById("crop-sq-gradient-cy-val") as HTMLSpanElement | null;
const elGradientRadialWrap = document.getElementById("crop-sq-gradient-radial-wrap") as HTMLDivElement | null;
const elGradientRadius = document.getElementById("crop-sq-gradient-radius") as HTMLInputElement | null;
const elGradientRadiusVal = document.getElementById("crop-sq-gradient-radius-val") as HTMLSpanElement | null;
const elGradientBalance = document.getElementById("crop-sq-gradient-balance") as HTMLInputElement | null;
const elGradientBalanceVal = document.getElementById("crop-sq-gradient-balance-val") as HTMLSpanElement | null;
const elSolidRow = document.getElementById("crop-sq-fill-solid-row") as HTMLDivElement | null;
const elGradientRow = document.getElementById("crop-sq-fill-gradient-row") as HTMLDivElement | null;
const elCancel = document.getElementById("crop-sq-cancel") as HTMLButtonElement | null;
const elApply = document.getElementById("crop-sq-apply") as HTMLButtonElement | null;
const elErr = document.getElementById("crop-sq-err") as HTMLParagraphElement | null;

type Source = ImageBitmap | HTMLImageElement;
type FillMode = "solid" | "gradient" | "transparent";
type GradientKind = "linear" | "linear_h" | "linear_v" | "radial" | "conic";

let finish: ((file: File | null) => void) | null = null;
let source: Source | null = null;
let revokeObjectUrl: string | null = null;
let pendingSourceFileName = "cover.jpg";
/** Bumped when a new crop session supersedes or closes; stale async loads ignore results. */
let cropGeneration = 0;
let letterboxFillHex = DEFAULT_FILL;

function readFillMode(): FillMode {
  const v = elFillMode?.value?.trim();
  if (v === "gradient" || v === "transparent") return v;
  return "solid";
}

function readGradientAngleDeg(): number {
  const n = Number(elGradientAngle?.value);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 145;
}

function readGradientStartHex(): string {
  const v = elFillStart?.value?.trim();
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_FILL;
}

function readGradientEndHex(): string {
  const v = elFillEnd?.value?.trim();
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_GRADIENT_END;
}

function readGradientKind(): GradientKind {
  const v = elGradientKind?.value?.trim();
  if (v === "linear_h" || v === "linear_v" || v === "radial" || v === "conic") return v;
  return "linear";
}

function readPct(el: HTMLInputElement | null, fallback: number, min: number, max: number): number {
  const n = Number(el?.value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readRadialRadiusPct(): number {
  return readPct(elGradientRadius, 100, 25, 200);
}

/** 0 = tout en couleur fin, 100 = tout en couleur début ; 50 = répartition classique sur l’axe du dégradé. */
function readGradientBalancePct(): number {
  return readPct(elGradientBalance, 50, 0, 100);
}

/**
 * Répartition 0–100 : 100 = uniquement couleur début, 0 = uniquement couleur fin.
 * À ~50 % : dégradé linéaire classique (début → fin) sur tout l’axe.
 * Sous 50 % : davantage de couleur fin ; au-dessus de 50 % : davantage de couleur début,
 * avec une transition progressive (évite une ligne nette au milieu à 50 %).
 */
function applyBalancedTwoColorStops(
  g: CanvasGradient,
  colorStart: string,
  colorEnd: string,
  balancePct: number
): void {
  const p = Math.min(1, Math.max(0, balancePct / 100));
  const eps = 0.002;
  if (p >= 1 - eps) {
    g.addColorStop(0, colorStart);
    g.addColorStop(1, colorStart);
    return;
  }
  if (p <= eps) {
    g.addColorStop(0, colorEnd);
    g.addColorStop(1, colorEnd);
    return;
  }
  if (Math.abs(p - 0.5) < 0.02) {
    g.addColorStop(0, colorStart);
    g.addColorStop(1, colorEnd);
    return;
  }
  if (p < 0.5) {
    const t = Math.max(eps, Math.min(1 - eps, 2 * p));
    g.addColorStop(0, colorStart);
    g.addColorStop(t, colorEnd);
    g.addColorStop(1, colorEnd);
    return;
  }
  const t = 2 * (p - 0.5);
  const edge = Math.max(eps, Math.min(1 - eps, 1 - t));
  g.addColorStop(0, colorStart);
  g.addColorStop(edge, colorStart);
  g.addColorStop(1, colorEnd);
}

function gradientAnchorPx(w: number, h: number): { ax: number; ay: number } {
  const px = readPct(elGradientPosX, 50, 0, 100) / 100;
  const py = readPct(elGradientPosY, 50, 0, 100) / 100;
  return { ax: px * w, ay: py * h };
}

function syncGradientKindUi(): void {
  const kind = readGradientKind();
  const showAngle = kind === "linear" || kind === "conic";
  elGradientAngleWrap?.classList.toggle("hidden", !showAngle);
  elGradientRadialWrap?.classList.toggle("hidden", kind !== "radial");
  if (elGradientAngleLabel) elGradientAngleLabel.textContent = kind === "conic" ? "Rotation" : "Angle";
}

function syncPosAndRadiusLabels(): void {
  if (elGradientPosXVal) elGradientPosXVal.textContent = `${Math.round(readPct(elGradientPosX, 50, 0, 100))}%`;
  if (elGradientPosYVal) elGradientPosYVal.textContent = `${Math.round(readPct(elGradientPosY, 50, 0, 100))}%`;
  if (elGradientRadiusVal) elGradientRadiusVal.textContent = `${Math.round(readRadialRadiusPct())}%`;
  if (elGradientBalanceVal) elGradientBalanceVal.textContent = `${Math.round(readGradientBalancePct())}%`;
}

function tryCreateConicGradient(
  ctx: CanvasRenderingContext2D,
  startAngleRad: number,
  x: number,
  y: number
): CanvasGradient | null {
  const c = ctx as CanvasRenderingContext2D & {
    createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient;
  };
  if (typeof c.createConicGradient !== "function") return null;
  return c.createConicGradient(startAngleRad, x, y);
}

function syncFillControlRows(): void {
  const mode = readFillMode();
  elSolidRow?.classList.toggle("hidden", mode !== "solid");
  elGradientRow?.classList.toggle("hidden", mode !== "gradient");
  if (mode === "gradient") syncGradientKindUi();
}

function syncAngleLabel(): void {
  if (elGradientAngleVal) elGradientAngleVal.textContent = `${Math.round(readGradientAngleDeg())}°`;
}

type CoverSquareCropUiV1 = {
  v: 1;
  fillMode: string;
  fillHex: string;
  fillStartHex: string;
  fillEndHex: string;
  gradientKind: string;
  angle: string;
  posX: string;
  posY: string;
  radialRadius: string;
  balance: string;
  zoomPct: string;
};

function isFillModeStored(s: string): s is FillMode {
  return s === "solid" || s === "gradient" || s === "transparent";
}

function isGradientKindStored(s: string): s is GradientKind {
  return s === "linear" || s === "linear_h" || s === "linear_v" || s === "radial" || s === "conic";
}

function saveCoverSquareCropUiToLocalStorage(): void {
  try {
    const payload: CoverSquareCropUiV1 = {
      v: 1,
      fillMode: readFillMode(),
      fillHex: elFill?.value?.trim() || DEFAULT_FILL,
      fillStartHex: readGradientStartHex(),
      fillEndHex: readGradientEndHex(),
      gradientKind: readGradientKind(),
      angle: String(Math.round(readGradientAngleDeg())),
      posX: String(Math.round(readPct(elGradientPosX, 50, 0, 100))),
      posY: String(Math.round(readPct(elGradientPosY, 50, 0, 100))),
      radialRadius: String(Math.round(readRadialRadiusPct())),
      balance: String(Math.round(readGradientBalancePct())),
      zoomPct: elZoom?.value?.trim() || "100",
    };
    localStorage.setItem(COVER_SQUARE_CROP_UI_LS_KEY, JSON.stringify(payload));
  } catch {
    /* private mode, quota */
  }
}

function parseCoverSquareCropUiV1(raw: unknown): CoverSquareCropUiV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  const str = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const fillMode = str("fillMode");
  const fillHex = str("fillHex");
  const fillStartHex = str("fillStartHex");
  const fillEndHex = str("fillEndHex");
  const gradientKind = str("gradientKind");
  const angle = str("angle");
  const posX = str("posX");
  const posY = str("posY");
  const radialRadius = str("radialRadius");
  const balance = str("balance");
  const zoomPct = str("zoomPct");
  if (
    !fillMode ||
    !fillHex ||
    !fillStartHex ||
    !fillEndHex ||
    !gradientKind ||
    !angle ||
    !posX ||
    !posY ||
    !radialRadius ||
    !balance ||
    !zoomPct
  )
    return null;
  if (!isFillModeStored(fillMode)) return null;
  if (!isGradientKindStored(gradientKind)) return null;
  if (!/^#[0-9a-f]{6}$/i.test(fillHex)) return null;
  if (!/^#[0-9a-f]{6}$/i.test(fillStartHex)) return null;
  if (!/^#[0-9a-f]{6}$/i.test(fillEndHex)) return null;
  const an = Number(angle);
  const xi = Number(posX);
  const yi = Number(posY);
  const rr = Number(radialRadius);
  const bal = Number(balance);
  const zm = Number(zoomPct);
  if (![an, xi, yi, rr, bal, zm].every(Number.isFinite)) return null;
  const clampI = (n: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, Math.round(n)));
  return {
    v: 1,
    fillMode,
    fillHex,
    fillStartHex,
    fillEndHex,
    gradientKind,
    angle: String(clampI(an, 0, 360)),
    posX: String(clampI(xi, 0, 100)),
    posY: String(clampI(yi, 0, 100)),
    radialRadius: String(clampI(rr, 25, 200)),
    balance: String(clampI(bal, 0, 100)),
    zoomPct: String(clampI(zm, 35, 300)),
  };
}

function loadCoverSquareCropUiFromLocalStorage(): CoverSquareCropUiV1 | null {
  try {
    const raw = localStorage.getItem(COVER_SQUARE_CROP_UI_LS_KEY);
    if (!raw) return null;
    return parseCoverSquareCropUiV1(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Applique les réglages sauvegardés aux champs du dialogue (sans toucher au zoom runtime `zoom` / pan). */
function applyCoverSquareCropUiFields(saved: CoverSquareCropUiV1): void {
  if (elFillMode) elFillMode.value = saved.fillMode;
  if (elFill) elFill.value = saved.fillHex;
  letterboxFillHex = saved.fillHex;
  if (elFillStart) elFillStart.value = saved.fillStartHex;
  if (elFillEnd) elFillEnd.value = saved.fillEndHex;
  if (elGradientKind) elGradientKind.value = saved.gradientKind;
  if (elGradientAngle) elGradientAngle.value = saved.angle;
  if (elGradientPosX) elGradientPosX.value = saved.posX;
  if (elGradientPosY) elGradientPosY.value = saved.posY;
  if (elGradientRadius) elGradientRadius.value = saved.radialRadius;
  if (elGradientBalance) elGradientBalance.value = saved.balance;
  if (elZoom) elZoom.value = saved.zoomPct;
  syncFillControlRows();
  syncGradientKindUi();
  syncAngleLabel();
  syncPosAndRadiusLabels();
}

function applyDefaultCoverSquareCropUiFields(): void {
  letterboxFillHex =
    elFill?.value && /^#[0-9a-f]{6}$/i.test(elFill.value) ? elFill.value : DEFAULT_FILL;
  if (elFillStart) elFillStart.value = letterboxFillHex;
  if (elFillEnd && !/^#[0-9a-f]{6}$/i.test(elFillEnd.value)) elFillEnd.value = DEFAULT_GRADIENT_END;
  if (elGradientKind) elGradientKind.value = "linear";
  if (elGradientPosX) elGradientPosX.value = "50";
  if (elGradientPosY) elGradientPosY.value = "50";
  if (elGradientRadius) elGradientRadius.value = "100";
  if (elGradientBalance) elGradientBalance.value = "50";
  syncFillControlRows();
  syncGradientKindUi();
  syncAngleLabel();
  syncPosAndRadiusLabels();
}

function discardStale(s: Source): void {
  if ("close" in s && typeof (s as ImageBitmap).close === "function") {
    try {
      (s as ImageBitmap).close();
    } catch {
      /* ignore */
    }
    return;
  }
  if (s instanceof HTMLImageElement && s.src.startsWith("blob:")) {
    URL.revokeObjectURL(s.src);
    if (revokeObjectUrl === s.src) revokeObjectUrl = null;
  }
}
let iw = 0;
let ih = 0;
let px = 0;
let py = 0;
let zoom = 1;
let drag: { sx: number; sy: number; spx: number; spy: number } | null = null;

function baseScaleContain(): number {
  return Math.min(VIEW_CSS / iw, VIEW_CSS / ih);
}

function scale(): number {
  return baseScaleContain() * zoom;
}

function imgW(): number {
  return iw * scale();
}

function imgH(): number {
  return ih * scale();
}

function clampPanContain(): void {
  const W = imgW();
  const H = imgH();
  const minPx = Math.min(0, VIEW_CSS - W);
  const maxPx = Math.max(0, VIEW_CSS - W);
  px = Math.min(maxPx, Math.max(minPx, px));
  const minPy = Math.min(0, VIEW_CSS - H);
  const maxPy = Math.max(0, VIEW_CSS - H);
  py = Math.min(maxPy, Math.max(minPy, py));
}

function centerImage(): void {
  px = (VIEW_CSS - imgW()) / 2;
  py = (VIEW_CSS - imgH()) / 2;
  clampPanContain();
}

function setZoomClamped(z: number, anchorScreenX: number, anchorScreenY: number): void {
  const oldS = scale();
  const oldPx = px;
  const oldPy = py;
  const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  zoom = nz;
  const newS = scale();
  if (oldS === newS) {
    clampPanContain();
    return;
  }
  const fx = (anchorScreenX - oldPx) / (iw * oldS);
  const fy = (anchorScreenY - oldPy) / (ih * oldS);
  px = anchorScreenX - fx * iw * newS;
  py = anchorScreenY - fy * ih * newS;
  clampPanContain();
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const c1 = "#1c1a24";
  const c2 = "#121018";
  const cell = 10;
  for (let yi = 0; yi * cell < h; yi++) {
    for (let xi = 0; xi * cell < w; xi++) {
      ctx.fillStyle = (xi + yi) % 2 === 0 ? c1 : c2;
      ctx.fillRect(
        x + xi * cell,
        y + yi * cell,
        Math.min(cell, w - xi * cell),
        Math.min(cell, h - yi * cell)
      );
    }
  }
}

function fillLetterboxBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const mode = readFillMode();
  if (mode === "transparent") {
    drawCheckerboard(ctx, 0, 0, w, h);
    return;
  }
  if (mode === "gradient") {
    const c0 = readGradientStartHex();
    const c1 = readGradientEndHex();
    const bal = readGradientBalancePct();
    const { ax, ay } = gradientAnchorPx(w, h);
    const kind = readGradientKind();
    const halfSpan = Math.hypot(w, h) * 1.05;

    if (kind === "radial") {
      const scale = readRadialRadiusPct() / 100;
      const r1 = (Math.hypot(w, h) * 0.5) * scale;
      const g = ctx.createRadialGradient(ax, ay, 0, ax, ay, r1);
      applyBalancedTwoColorStops(g, c0, c1, bal);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    if (kind === "conic") {
      const start = (readGradientAngleDeg() * Math.PI) / 180;
      const g = tryCreateConicGradient(ctx, start, ax, ay);
      if (g) {
        applyBalancedTwoColorStops(g, c0, c1, bal);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        return;
      }
      const r1 = Math.hypot(w, h) * 0.55;
      const g2 = ctx.createRadialGradient(ax, ay, 0, ax, ay, r1);
      applyBalancedTwoColorStops(g2, c0, c1, bal);
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    let rad = (readGradientAngleDeg() * Math.PI) / 180;
    if (kind === "linear_h") rad = 0;
    if (kind === "linear_v") rad = Math.PI / 2;
    const x0 = ax - Math.cos(rad) * halfSpan;
    const y0 = ay - Math.sin(rad) * halfSpan;
    const x1 = ax + Math.cos(rad) * halfSpan;
    const y1 = ay + Math.sin(rad) * halfSpan;
    const lin = ctx.createLinearGradient(x0, y0, x1, y1);
    applyBalancedTwoColorStops(lin, c0, c1, bal);
    ctx.fillStyle = lin;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  ctx.fillStyle = letterboxFillHex || DEFAULT_FILL;
  ctx.fillRect(0, 0, w, h);
}

async function loadSource(file: File): Promise<Source> {
  try {
    return await createImageBitmap(file);
  } catch {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(file);
      revokeObjectUrl = u;
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(u);
        revokeObjectUrl = null;
        reject(new Error("decode"));
      };
      img.src = u;
    });
  }
}

function cleanupSource(): void {
  if (source && "close" in source && typeof (source as ImageBitmap).close === "function") {
    try {
      (source as ImageBitmap).close();
    } catch {
      /* ignore */
    }
  }
  if (revokeObjectUrl) {
    URL.revokeObjectURL(revokeObjectUrl);
    revokeObjectUrl = null;
  }
  source = null;
}

function readCanvasScale(): number {
  const w = elCanvas?.getBoundingClientRect().width ?? VIEW_CSS;
  return VIEW_CSS / Math.max(w, 1);
}

function render(): void {
  if (!elCanvas || !source) return;
  const ctx = elCanvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  elCanvas.width = Math.round(VIEW_CSS * dpr);
  elCanvas.height = Math.round(VIEW_CSS * dpr);
  elCanvas.style.width = "100%";
  elCanvas.style.height = "100%";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fillLetterboxBackground(ctx, VIEW_CSS, VIEW_CSS);
  ctx.drawImage(source, px, py, imgW(), imgH());
  ctx.strokeStyle = "rgba(255,255,255,0.38)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, VIEW_CSS - 2, VIEW_CSS - 2);
}

async function exportCroppedImage(originalName: string): Promise<File> {
  if (!source) throw new Error("no source");
  const mode = readFillMode();
  const W = imgW();
  const H = imgH();
  const stem = originalName.replace(/\.[^.]+$/, "") || "cover";
  const oc = document.createElement("canvas");
  const octx = oc.getContext("2d");
  if (!octx) throw new Error("ctx");

  if (mode === "transparent") {
    let outSize = EXPORT_MAX;
    let blob: Blob | null = null;
    for (let attempt = 0; attempt < 28; attempt++) {
      oc.width = outSize;
      oc.height = outSize;
      octx.clearRect(0, 0, outSize, outSize);
      const k = outSize / VIEW_CSS;
      octx.drawImage(source, 0, 0, iw, ih, px * k, py * k, W * k, H * k);
      blob = await new Promise<Blob | null>((r) => oc.toBlob(r, "image/png"));
      if (blob && blob.size <= MAX_UPLOAD_BYTES) break;
      outSize = Math.max(240, Math.round(outSize * 0.86));
    }
    if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("too large");
    return new File([blob], `${stem}-carre.png`, { type: "image/png" });
  }

  let outSize = EXPORT_MAX;
  let q = JPEG_QUALITY_START;
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 28; attempt++) {
    oc.width = outSize;
    oc.height = outSize;
    fillLetterboxBackground(octx, outSize, outSize);
    const k = outSize / VIEW_CSS;
    octx.drawImage(source, 0, 0, iw, ih, px * k, py * k, W * k, H * k);
    blob = await new Promise<Blob | null>((r) => oc.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= MAX_UPLOAD_BYTES) break;
    if (q > 0.48) q -= 0.06;
    else {
      outSize = Math.max(240, Math.round(outSize * 0.86));
      q = Math.min(q + 0.05, JPEG_QUALITY_START);
    }
  }
  if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("too large");
  return new File([blob], `${stem}-carre.jpg`, { type: "image/jpeg" });
}

function closeSession(result: File | null): void {
  cropGeneration++;
  const r = finish;
  finish = null;
  cleanupSource();
  drag = null;
  elDialog?.close();
  elErr && (elErr.textContent = "");
  if (r) r(result);
}

function onPointerDown(e: PointerEvent): void {
  if (!elViewport) return;
  drag = { sx: e.clientX, sy: e.clientY, spx: px, spy: py };
  elViewport.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  const sc = readCanvasScale();
  px = drag.spx + (e.clientX - drag.sx) * sc;
  py = drag.spy + (e.clientY - drag.sy) * sc;
  clampPanContain();
  render();
}

function onPointerUp(e: PointerEvent): void {
  if (elViewport?.hasPointerCapture(e.pointerId)) {
    elViewport.releasePointerCapture(e.pointerId);
  }
  drag = null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const rect = elViewport?.getBoundingClientRect();
  if (!rect?.width) return;
  const lx = ((e.clientX - rect.left) / rect.width) * VIEW_CSS;
  const ly = ((e.clientY - rect.top) / rect.height) * VIEW_CSS;
  const delta = e.deltaY > 0 ? -0.12 : 0.12;
  setZoomClamped(zoom + delta, lx, ly);
  if (elZoom) elZoom.value = String(Math.round(zoom * 100));
  render();
}

let listenersBound = false;

function bindUiOnce(): void {
  if (listenersBound) return;
  listenersBound = true;
  elFillMode?.addEventListener("change", () => {
    const mode = readFillMode();
    if (mode === "gradient" && elFillStart && elFill) {
      elFillStart.value = elFill.value;
    }
    if (mode === "solid" && elFillStart && elFill) {
      const s = readGradientStartHex();
      elFill.value = s;
      letterboxFillHex = s;
    }
    syncFillControlRows();
    syncPosAndRadiusLabels();
    render();
  });
  elGradientKind?.addEventListener("change", () => {
    syncGradientKindUi();
    syncAngleLabel();
    syncPosAndRadiusLabels();
    render();
  });
  elFill?.addEventListener("input", () => {
    letterboxFillHex = elFill.value?.trim() || DEFAULT_FILL;
    render();
  });
  elFillStart?.addEventListener("input", () => render());
  elFillEnd?.addEventListener("input", () => render());
  elGradientAngle?.addEventListener("input", () => {
    syncAngleLabel();
    render();
  });
  elGradientPosX?.addEventListener("input", () => {
    syncPosAndRadiusLabels();
    render();
  });
  elGradientPosY?.addEventListener("input", () => {
    syncPosAndRadiusLabels();
    render();
  });
  elGradientRadius?.addEventListener("input", () => {
    syncPosAndRadiusLabels();
    render();
  });
  elGradientBalance?.addEventListener("input", () => {
    syncPosAndRadiusLabels();
    render();
  });
  elZoom?.addEventListener("input", () => {
    const v = Number(elZoom?.value) / 100;
    setZoomClamped(Number.isFinite(v) ? v : 1, VIEW_CSS / 2, VIEW_CSS / 2);
    render();
  });
  elCancel?.addEventListener("click", () => closeSession(null));
  elApply?.addEventListener("click", () => {
    void (async () => {
      if (!finish || !source) return;
      elApply.disabled = true;
      try {
        const file = await exportCroppedImage(pendingSourceFileName);
        saveCoverSquareCropUiToLocalStorage();
        closeSession(file);
      } catch {
        if (elErr) elErr.textContent = "Impossible d’exporter l’image. Réessayez.";
      } finally {
        elApply.disabled = false;
      }
    })();
  });
  elDialog?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeSession(null);
  });
  elViewport?.addEventListener("pointerdown", onPointerDown);
  elViewport?.addEventListener("pointermove", onPointerMove);
  elViewport?.addEventListener("pointerup", onPointerUp);
  elViewport?.addEventListener("pointercancel", onPointerUp);
  elViewport?.addEventListener("wheel", onWheel, { passive: false });
}

/** Opens the crop dialog; returns `null` if cancelled or on error. */
export function runCoverSquareCrop(file: File): Promise<File | null> {
  if (!elDialog || !elCanvas || !elViewport) {
    return Promise.resolve(file);
  }
  bindUiOnce();
  if (finish) {
    const r = finish;
    finish = null;
    r(null);
  }
  cleanupSource();
  elDialog.close();
  cropGeneration++;
  const myGen = cropGeneration;
  pendingSourceFileName = file.name || "cover.jpg";
  const savedUi = loadCoverSquareCropUiFromLocalStorage();
  if (savedUi) applyCoverSquareCropUiFields(savedUi);
  else applyDefaultCoverSquareCropUiFields();
  return new Promise<File | null>((resolve) => {
    finish = resolve;
    void (async () => {
      elErr && (elErr.textContent = "");
      if (elApply) elApply.disabled = true;
      elDialog.showModal();
      try {
        const src = await loadSource(file);
        if (myGen !== cropGeneration) {
          discardStale(src);
          return;
        }
        source = src;
        iw = "width" in src && typeof src.width === "number" ? src.width : (src as HTMLImageElement).naturalWidth;
        ih = "height" in src && typeof src.height === "number" ? src.height : (src as HTMLImageElement).naturalHeight;
        if (iw < 2 || ih < 2) {
          cleanupSource();
          if (elErr) elErr.textContent = "Image trop petite.";
          if (elApply) elApply.disabled = true;
          return;
        }
        const zPct = Number(elZoom?.value) / 100;
        zoom = Number.isFinite(zPct) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zPct)) : 1;
        centerImage();
        if (elZoom) elZoom.value = String(Math.round(zoom * 100));
        if (elFill && !/^#[0-9a-f]{6}$/i.test(elFill.value)) elFill.value = DEFAULT_FILL;
        if (elApply) elApply.disabled = false;
        render();
      } catch {
        cleanupSource();
        if (elErr) elErr.textContent = "Impossible de lire cette image.";
        if (elApply) elApply.disabled = true;
      }
    })();
  });
}
