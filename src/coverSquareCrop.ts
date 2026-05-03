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

const elDialog = document.getElementById("dialog-cover-square-crop") as HTMLDialogElement | null;
const elCanvas = document.getElementById("crop-sq-canvas") as HTMLCanvasElement | null;
const elViewport = document.getElementById("crop-sq-viewport") as HTMLDivElement | null;
const elZoom = document.getElementById("crop-sq-zoom") as HTMLInputElement | null;
const elFillMode = document.getElementById("crop-sq-fill-mode") as HTMLSelectElement | null;
const elFill = document.getElementById("crop-sq-fill") as HTMLInputElement | null;
const elFillEnd = document.getElementById("crop-sq-fill-end") as HTMLInputElement | null;
const elGradientAngle = document.getElementById("crop-sq-gradient-angle") as HTMLInputElement | null;
const elGradientAngleVal = document.getElementById("crop-sq-gradient-angle-val") as HTMLSpanElement | null;
const elSolidRow = document.getElementById("crop-sq-fill-solid-row") as HTMLDivElement | null;
const elGradientRow = document.getElementById("crop-sq-fill-gradient-row") as HTMLDivElement | null;
const elCancel = document.getElementById("crop-sq-cancel") as HTMLButtonElement | null;
const elApply = document.getElementById("crop-sq-apply") as HTMLButtonElement | null;
const elErr = document.getElementById("crop-sq-err") as HTMLParagraphElement | null;

type Source = ImageBitmap | HTMLImageElement;
type FillMode = "solid" | "gradient" | "transparent";

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

function readGradientEndHex(): string {
  const v = elFillEnd?.value?.trim();
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_GRADIENT_END;
}

function syncFillControlRows(): void {
  const mode = readFillMode();
  elSolidRow?.classList.toggle("hidden", mode !== "solid");
  elGradientRow?.classList.toggle("hidden", mode !== "gradient");
}

function syncAngleLabel(): void {
  if (elGradientAngleVal) elGradientAngleVal.textContent = `${Math.round(readGradientAngleDeg())}°`;
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
    const rad = (readGradientAngleDeg() * Math.PI) / 180;
    const cx = w / 2;
    const cy = h / 2;
    const len = Math.hypot(w, h) / 2;
    const x0 = cx - Math.cos(rad) * len;
    const y0 = cy - Math.sin(rad) * len;
    const x1 = cx + Math.cos(rad) * len;
    const y1 = cy + Math.sin(rad) * len;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, letterboxFillHex || DEFAULT_FILL);
    g.addColorStop(1, readGradientEndHex());
    ctx.fillStyle = g;
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
    syncFillControlRows();
    render();
  });
  elFill?.addEventListener("input", () => {
    letterboxFillHex = elFill.value?.trim() || DEFAULT_FILL;
    render();
  });
  elFillEnd?.addEventListener("input", () => render());
  elGradientAngle?.addEventListener("input", () => {
    syncAngleLabel();
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
  letterboxFillHex =
    elFill?.value && /^#[0-9a-f]{6}$/i.test(elFill.value) ? elFill.value : DEFAULT_FILL;
  if (elFillEnd && !/^#[0-9a-f]{6}$/i.test(elFillEnd.value)) elFillEnd.value = DEFAULT_GRADIENT_END;
  syncFillControlRows();
  syncAngleLabel();
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
        zoom = 1;
        centerImage();
        if (elZoom) elZoom.value = "100";
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
