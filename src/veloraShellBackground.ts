/** Fond décoratif du shell Velora (dégradés) — persistant `localStorage`. */

export const VELORA_SHELL_BG_STORAGE_KEY = "velora_shell_bg_preset";

export const VELORA_SHELL_BG_PRESETS = [
  "default",
  "aurora",
  "mesh",
  "ember",
  "ocean",
  "nocturne",
] as const;

export type VeloraShellBgPreset = (typeof VELORA_SHELL_BG_PRESETS)[number];

export function readVeloraShellBgPreset(): VeloraShellBgPreset {
  try {
    const v = localStorage.getItem(VELORA_SHELL_BG_STORAGE_KEY)?.trim();
    if (v && (VELORA_SHELL_BG_PRESETS as readonly string[]).includes(v)) return v as VeloraShellBgPreset;
  } catch {
    /* ignore */
  }
  return "default";
}

export function writeVeloraShellBgPreset(p: VeloraShellBgPreset): void {
  try {
    if (p === "default") localStorage.removeItem(VELORA_SHELL_BG_STORAGE_KEY);
    else localStorage.setItem(VELORA_SHELL_BG_STORAGE_KEY, p);
  } catch {
    /* ignore */
  }
}

export function applyVeloraShellBgToMain(elMain: HTMLElement): void {
  const p = readVeloraShellBgPreset();
  if (p === "default") delete elMain.dataset.velShellBg;
  else elMain.dataset.velShellBg = p;
}
