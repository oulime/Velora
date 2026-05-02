/**
 * Derive Velora CSS palette from a package hero image (canvas sampling).
 * Uses the same proxy as thumbnails when possible so pixels stay readable (CORS).
 */

import type { PresetTheme } from "./packageThemePresets";
import { proxiedUrl } from "./nodecastCatalog";

const imageThemeCache = new Map<string, PresetTheme>();

function cacheKey(packageId: string, imageUrl: string): string {
  return `${packageId}\0${imageUrl}`;
}

/** Call after `cover_url` / override image changes for that package. */
export function invalidatePackageImageThemeCache(packageId: string): void {
  if (!packageId.trim()) return;
  const p = `${packageId}\0`;
  for (const k of [...imageThemeCache.keys()]) {
    if (k.startsWith(p)) imageThemeCache.delete(k);
  }
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function mixRgb(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
  t: number
): { r: number; g: number; b: number } {
  return {
    r: r1 + (r2 - r1) * t,
    g: g1 + (g2 - g1) * t,
    b: b1 + (b2 - b1) * t,
  };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(rgb1: { r: number; g: number; b: number }, rgb2: { r: number; g: number; b: number }): number {
  const L1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const L2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function sampleImageToAccent(img: HTMLImageElement): { r: number; g: number; b: number } | null {
  const w = 56;
  const h = 56;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, w, h);
  } catch {
    return null;
  }
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
  const d = data.data;
  let bestScore = -1;
  let br = 138,
    bg = 43,
    bb = 226;
  let ar = 0,
    ag = 0,
    ab = 0,
    an = 0;
  for (let i = 0; i < d.length; i += 4 * 3) {
    const a = d[i + 3] ?? 255;
    if (a < 28) continue;
    const R = d[i] ?? 0;
    const G = d[i + 1] ?? 0;
    const B = d[i + 2] ?? 0;
    const { s, l } = rgbToHsl(R, G, B);
    if (l < 0.05 || l > 0.97) continue;
    ar += R;
    ag += G;
    ab += B;
    an++;
    const score = s * (1 - Math.abs(l - 0.55) * 1.2);
    if (score > bestScore) {
      bestScore = score;
      br = R;
      bg = G;
      bb = B;
    }
  }
  if (bestScore < 0.08 && an > 0) {
    br = ar / an;
    bg = ag / an;
    bb = ab / an;
  }
  return { r: br, g: bg, b: bb };
}

function buildPaletteFromAccent(accent: { r: number; g: number; b: number }): PresetTheme {
  const { h, s, l } = rgbToHsl(accent.r, accent.g, accent.b);
  const sBoost = clamp(s < 0.18 ? s + 0.35 : s + 0.12, 0.35, 0.95);
  const primaryRgb = hslToRgb(h, sBoost, clamp(l < 0.35 ? l + 0.22 : l, 0.38, 0.62));

  const bgRgb = mixRgb(accent.r, accent.g, accent.b, 8, 6, 14, 0.78);
  const surfaceRgb = mixRgb(accent.r, accent.g, accent.b, 18, 14, 32, 0.55);

  let pr = primaryRgb.r;
  let pg = primaryRgb.g;
  let pb = primaryRgb.b;
  const bgDark = { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b };
  for (let i = 0; i < 10; i++) {
    if (contrastRatio({ r: pr, g: pg, b: pb }, bgDark) >= 4) break;
    const hsl = rgbToHsl(pr, pg, pb);
    const next = hslToRgb(hsl.h, clamp(hsl.s * 0.92, 0.2, 1), clamp(hsl.l + 0.06, 0.35, 0.75));
    pr = next.r;
    pg = next.g;
    pb = next.b;
  }

  const primary = toHex(pr, pg, pb);
  const bg = toHex(bgRgb.r, bgRgb.g, bgRgb.b);
  const surface = toHex(surfaceRgb.r, surfaceRgb.g, surfaceRgb.b);
  const glow = `rgba(${Math.round(pr)}, ${Math.round(pg)}, ${Math.round(pb)}, 0.38)`;
  return { bg, surface, primary, glow };
}

/**
 * Returns a palette or `null` if the image cannot be read (CORS / decode).
 */
export async function extractPresetFromImageUrl(imageUrl: string): Promise<PresetTheme | null> {
  const trimmed = imageUrl.trim();
  if (!trimmed) return null;
  const loadUrl = /^https?:\/\//i.test(trimmed) ? proxiedUrl(trimmed) : trimmed;
  const img = new Image();
  img.crossOrigin = "anonymous";
  return new Promise((resolve) => {
    const done = (t: PresetTheme | null) => resolve(t);
    const fail = () => done(null);
    img.onload = () => {
      const accent = sampleImageToAccent(img);
      if (!accent) {
        fail();
        return;
      }
      try {
        done(buildPaletteFromAccent(accent));
      } catch {
        fail();
      }
    };
    img.onerror = fail;
    img.src = loadUrl;
  });
}

export async function extractPresetFromImageUrlCached(
  packageId: string,
  imageUrl: string
): Promise<PresetTheme | null> {
  const k = cacheKey(packageId, imageUrl);
  const hit = imageThemeCache.get(k);
  if (hit) return hit;
  const t = await extractPresetFromImageUrl(imageUrl);
  if (t) imageThemeCache.set(k, t);
  return t;
}
