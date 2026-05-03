const STORAGE_KEY = "velora_admin_settings";

/**
 * Admin UI (Paramètres, switch grille, outils bouquet) : oui si la session onglet a été activée avec `?admin=1`.
 * Par défaut : non. `?admin=0` désactive et retire le paramètre de l’URL.
 */
export function isAdminSession(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Lit `admin` dans l’URL : `1` → activer (session), `0` → désactiver ; puis nettoie le query param.
 * Appeler au chargement et sur `popstate` si l’URL peut changer sans rechargement complet.
 */
export function tryConsumeAdminAccessFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const u = new URL(window.location.href);
    const raw = u.searchParams.get("admin");
    if (raw === null) return;
    if (raw === "1") {
      sessionStorage.setItem(STORAGE_KEY, "1");
    } else if (raw === "0") {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      return;
    }
    u.searchParams.delete("admin");
    const next = `${u.pathname}${u.search}${u.hash}` || "/";
    window.history.replaceState({}, "", next);
  } catch {
    /* ignore */
  }
}

export function clearAdminSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
