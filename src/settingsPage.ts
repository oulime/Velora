import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { clearAdminSession, isAdminSession } from "./adminSession";
import {
  readVeloraShellBgPreset,
  writeVeloraShellBgPreset,
  type VeloraShellBgPreset,
  VELORA_SHELL_BG_PRESETS,
} from "./veloraShellBackground";
const SETTINGS_PARAM = "settings";
const SETTINGS_VALUE = "1";

export function isSettingsPageOpen(): boolean {
  try {
    return new URLSearchParams(window.location.search).get(SETTINGS_PARAM) === SETTINGS_VALUE;
  } catch {
    return false;
  }
}

function showSettingsShellUI(): void {
  document.getElementById("settings-shell")?.classList.remove("hidden");
  document.querySelector(".app")?.classList.add("hidden");
}

function hideSettingsShellUI(): void {
  document.getElementById("settings-shell")?.classList.add("hidden");
  document.querySelector(".app")?.classList.remove("hidden");
}

function stripSettingsParamFromUrl(): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete(SETTINGS_PARAM);
    const next = `${u.pathname}${u.search}${u.hash}` || "/";
    window.history.replaceState({}, "", next);
  } catch {
    /* ignore */
  }
}

export function closeSettingsPage(): void {
  stripSettingsParamFromUrl();
  hideSettingsShellUI();
  window.dispatchEvent(new CustomEvent("velora-settings-closed"));
}

export function openSettingsPage(): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set(SETTINGS_PARAM, SETTINGS_VALUE);
    window.history.pushState({ veloraSettings: true }, "", u.toString());
  } catch {
    /* ignore */
  }
  showSettingsShellUI();
  void applySettingsRouteContent();
}

let deniedBackBound = false;
let settingsControlsBound = false;
let prefixAdminBound = false;
let hiddenFiltersAdminBound = false;
let shellAppearanceBound = false;

function bindDeniedBack(): void {
  if (deniedBackBound) return;
  deniedBackBound = true;
  document.getElementById("cc-denied-back")?.addEventListener("click", () => {
    closeSettingsPage();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** First paint: `?settings=1` opens the shell (admin or denied). */
export function applySettingsRouteOnLoad(): void {
  if (!isSettingsPageOpen()) return;
  showSettingsShellUI();
  void applySettingsRouteContent();
}

export function syncSettingsFromUrl(): void {
  if (isSettingsPageOpen()) {
    showSettingsShellUI();
    void applySettingsRouteContent();
  } else {
    hideSettingsShellUI();
  }
}

async function applySettingsRouteContent(): Promise<void> {
  const granted = document.getElementById("settings-view-granted");
  const denied = document.getElementById("settings-view-denied");
  if (!isAdminSession()) {
    granted?.classList.add("hidden");
    denied?.classList.remove("hidden");
    bindDeniedBack();
    return;
  }
  denied?.classList.add("hidden");
  granted?.classList.remove("hidden");
  await mountSettingsTable();
}

async function mountSettingsTable(): Promise<void> {
  const elStatus = document.getElementById("countries-admin-status") as HTMLParagraphElement;
  const elMatch = document.getElementById("cc-match") as HTMLInputElement;
  const elDisplay = document.getElementById("cc-display") as HTMLInputElement;
  const elAdd = document.getElementById("cc-add") as HTMLButtonElement;
  const elCancelEdit = document.getElementById("cc-cancel-edit") as HTMLButtonElement;
  const elFormHeading = document.getElementById("cc-form-heading") as HTMLHeadingElement;
  const elWrap = document.getElementById("cc-table-wrap") as HTMLDivElement;

  let editingCountryId: string | null = null;

  function clearCountryEdit(): void {
    editingCountryId = null;
    elMatch.value = "";
    elDisplay.value = "";
    elAdd.textContent = "Ajouter";
    elFormHeading.textContent = "Ajouter";
    elCancelEdit.classList.add("hidden");
  }

  function beginCountryEdit(r: Row): void {
    editingCountryId = r.id;
    elMatch.value = r.match_key;
    elDisplay.value = r.display_name;
    elAdd.textContent = "Enregistrer";
    elFormHeading.textContent = "Modifier";
    elCancelEdit.classList.remove("hidden");
    elMatch.focus();
  }

  if (!settingsControlsBound) {
    document.getElementById("cc-back-player")?.addEventListener("click", () => {
      closeSettingsPage();
    });
    document.getElementById("cc-quit-admin")?.addEventListener("click", () => {
      clearAdminSession();
      closeSettingsPage();
      window.dispatchEvent(new CustomEvent("velora-admin-session-changed"));
    });
    elAdd.addEventListener("click", () => void saveCountryRow());
    elCancelEdit.addEventListener("click", () => {
      clearCountryEdit();
      setStatus("Modification annulée.");
    });
    settingsControlsBound = true;
  }

  const supabaseUrl = import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
  const supabaseKey = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  const supabase =
    supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  type Row = {
    id: string;
    match_key: string;
    display_name: string;
    sort_order: number;
  };

  function setStatus(msg: string, isError = false): void {
    elStatus.textContent = msg;
    elStatus.classList.toggle("error", isError);
  }

  async function loadRows(): Promise<void> {
    if (!supabase) {
      setStatus("Variables NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY requises.", true);
      elWrap.innerHTML = "";
      return;
    }
    setStatus("Chargement…");
    const { data, error } = await supabase
      .from("canonical_countries")
      .select("id, match_key, display_name, sort_order")
      .order("sort_order", { ascending: true })
      .order("display_name", { ascending: true });
    if (error) {
      setStatus(error.message, true);
      elWrap.innerHTML = "";
      return;
    }
    const rows = (data ?? []) as Row[];
    if (editingCountryId && !rows.some((r) => r.id === editingCountryId)) {
      clearCountryEdit();
    }
    setStatus(`${rows.length} entrée(s). Le lecteur recharge cette liste à la connexion.`);
    renderTable(rows);
  }

  function renderTable(rows: Row[]): void {
    if (rows.length === 0) {
      elWrap.innerHTML =
        "<p class=\"countries-admin-empty\">Aucune entrée — le lecteur utilise la liste intégrée.</p>";
      return;
    }
    const table = document.createElement("table");
    table.className = "countries-admin-table";
    table.innerHTML =
      "<thead><tr><th>Clé</th><th>Nom affiché</th><th>Actions</th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody")!;
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><code>${escapeHtml(r.match_key)}</code></td><td>${escapeHtml(r.display_name)}</td>`;
      const td = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "countries-admin-actions";
      const btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "countries-admin-edit";
      btnEdit.textContent = "Modifier";
      btnEdit.addEventListener("click", () => beginCountryEdit(r));
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "countries-admin-del";
      btnDel.textContent = "Supprimer";
      btnDel.addEventListener("click", () => void deleteRow(r.id));
      wrap.appendChild(btnEdit);
      wrap.appendChild(btnDel);
      td.appendChild(wrap);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    elWrap.innerHTML = "";
    elWrap.appendChild(table);
  }

  async function deleteRow(id: string): Promise<void> {
    if (!supabase) return;
    if (editingCountryId === id) clearCountryEdit();
    setStatus("Suppression…");
    const { error } = await supabase.from("canonical_countries").delete().eq("id", id);
    if (error) {
      setStatus(error.message, true);
      return;
    }
    await loadRows();
  }

  async function saveCountryRow(): Promise<void> {
    if (!supabase) return;
    const key = elMatch.value.trim().replace(/\s+/g, " ");
    const name = elDisplay.value.trim();
    if (!key) {
      setStatus("Renseignez une clé (telle qu’affichée, ex. france, [ALB]).", true);
      return;
    }
    if (!name) {
      setStatus("Renseignez le nom affiché.", true);
      return;
    }
    elAdd.disabled = true;
    if (editingCountryId) {
      setStatus("Enregistrement…");
      const { error } = await supabase
        .from("canonical_countries")
        .update({ match_key: key, display_name: name })
        .eq("id", editingCountryId);
      elAdd.disabled = false;
      if (error) {
        setStatus(error.message, true);
        return;
      }
      clearCountryEdit();
      setStatus("Entrée mise à jour.");
    } else {
      setStatus("Ajout…");
      const { error } = await supabase.from("canonical_countries").insert({
        match_key: key,
        display_name: name,
        sort_order: 0,
      });
      elAdd.disabled = false;
      if (error) {
        setStatus(error.message, true);
        return;
      }
      elMatch.value = "";
      elDisplay.value = "";
    }
    await loadRows();
  }

  await loadRows();
  await mountChannelPrefixAdmin(supabase);
  await mountHiddenFiltersAdmin(supabase);
  mountShellAppearanceControls();
}

function mountShellAppearanceControls(): void {
  const sel = document.getElementById("vel-shell-bg-select") as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = readVeloraShellBgPreset();
  if (!shellAppearanceBound) {
    shellAppearanceBound = true;
    sel.addEventListener("change", () => {
      const raw = sel.value.trim();
      const v = (VELORA_SHELL_BG_PRESETS as readonly string[]).includes(raw) ? (raw as VeloraShellBgPreset) : "default";
      writeVeloraShellBgPreset(v);
      window.dispatchEvent(new CustomEvent("velora-shell-bg-changed"));
    });
  }
}

async function mountChannelPrefixAdmin(supabase: SupabaseClient | null): Promise<void> {
  const elSt = document.getElementById("cn-prefix-status") as HTMLParagraphElement | null;
  const elVal = document.getElementById("cn-prefix-val") as HTMLInputElement | null;
  const elAdd = document.getElementById("cn-prefix-add") as HTMLButtonElement | null;
  const elWrap = document.getElementById("cn-prefix-wrap") as HTMLDivElement | null;
  if (!elSt || !elVal || !elAdd || !elWrap) return;
  const stEl = elSt;
  const valEl = elVal;
  const addEl = elAdd;
  const wrapEl = elWrap;

  type PRow = { id: string; prefix: string; sort_order: number };

  function setPStatus(msg: string, isError = false): void {
    stEl.textContent = msg;
    stEl.classList.toggle("error", isError);
  }

  async function loadPRows(): Promise<void> {
    if (!supabase) {
      setPStatus("Même configuration Supabase que pour les pays.", true);
      wrapEl.innerHTML = "";
      return;
    }
    setPStatus("Chargement…");
    const { data, error } = await supabase
      .from("admin_channel_name_prefixes")
      .select("id, prefix, sort_order")
      .order("sort_order", { ascending: true })
      .order("prefix", { ascending: true });
    if (error) {
      setPStatus(error.message, true);
      wrapEl.innerHTML = "";
      return;
    }
    const rows = (data ?? []) as PRow[];
    setPStatus(
      rows.length
        ? `${rows.length} préfixe(s). Reconnexion ou fermeture des paramètres met à jour le lecteur.`
        : "Aucun préfixe — rien n’est retiré des noms de chaîne."
    );
    if (rows.length === 0) {
      wrapEl.innerHTML =
        "<p class=\"countries-admin-empty\">Ajoutez au moins un préfixe si vos titres commencent par « FR - », etc.</p>";
      return;
    }
    const table = document.createElement("table");
    table.className = "countries-admin-table";
    table.innerHTML = "<thead><tr><th>Préfixe</th><th></th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody")!;
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><code>${escapeHtml(r.prefix)}</code></td>`;
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "countries-admin-del";
      btn.textContent = "Supprimer";
      btn.addEventListener("click", () => void deletePRow(r.id));
      td.appendChild(btn);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    wrapEl.innerHTML = "";
    wrapEl.appendChild(table);
  }

  async function deletePRow(id: string): Promise<void> {
    if (!supabase) return;
    setPStatus("Suppression…");
    const { error } = await supabase.from("admin_channel_name_prefixes").delete().eq("id", id);
    if (error) {
      setPStatus(error.message, true);
      return;
    }
    await loadPRows();
  }

  async function addPRow(): Promise<void> {
    if (!supabase) return;
    const prefix = valEl.value.trim();
    if (!prefix) {
      setPStatus("Saisissez un préfixe (ex. FR - ).", true);
      return;
    }
    addEl.disabled = true;
    setPStatus("Ajout…");
    const { error } = await supabase.from("admin_channel_name_prefixes").insert({
      prefix,
      sort_order: 0,
    });
    addEl.disabled = false;
    if (error) {
      setPStatus(error.message, true);
      return;
    }
    valEl.value = "";
    await loadPRows();
  }

  if (!prefixAdminBound) {
    addEl.addEventListener("click", () => void addPRow());
    prefixAdminBound = true;
  }

  await loadPRows();
}

async function mountHiddenFiltersAdmin(supabase: SupabaseClient | null): Promise<void> {
  const elSt = document.getElementById("hf-status") as HTMLParagraphElement | null;
  const elNeedle = document.getElementById("hf-needle") as HTMLInputElement | null;
  const elAdd = document.getElementById("hf-add") as HTMLButtonElement | null;
  const elWrap = document.getElementById("hf-wrap") as HTMLDivElement | null;
  if (!elSt || !elNeedle || !elAdd || !elWrap) return;
  const stEl = elSt;
  const needleEl = elNeedle;
  const addEl = elAdd;
  const wrapEl = elWrap;

  type HRow = { id: string; needle: string };

  function setHStatus(msg: string, isError = false): void {
    stEl.textContent = msg;
    stEl.classList.toggle("error", isError);
  }

  async function loadHRows(): Promise<void> {
    if (!supabase) {
      setHStatus("Même configuration Supabase que pour les pays.", true);
      wrapEl.innerHTML = "";
      return;
    }
    setHStatus("Chargement…");
    const { data, error } = await supabase
      .from("admin_hidden_filters")
      .select("id, needle")
      .order("needle", { ascending: true });
    if (error) {
      setHStatus(error.message, true);
      wrapEl.innerHTML = "";
      return;
    }
    const rows = (data ?? []) as HRow[];
    setHStatus(
      rows.length
        ? `${rows.length} mot(s) / fragment(s). Fermeture des paramètres met à jour le lecteur.`
        : "Aucun filtre — toutes les chaînes du catalogue peuvent s’afficher."
    );
    if (rows.length === 0) {
      wrapEl.innerHTML =
        "<p class=\"countries-admin-empty\">Ajoutez un fragment pour exclure des chaînes dont le nom le contient.</p>";
      return;
    }
    const table = document.createElement("table");
    table.className = "countries-admin-table";
    table.innerHTML = "<thead><tr><th>Fragment</th><th></th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody")!;
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><code>${escapeHtml(r.needle)}</code></td>`;
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "countries-admin-del";
      btn.textContent = "Supprimer";
      btn.addEventListener("click", () => void deleteHRow(r.id));
      td.appendChild(btn);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    wrapEl.innerHTML = "";
    wrapEl.appendChild(table);
  }

  async function deleteHRow(id: string): Promise<void> {
    if (!supabase) return;
    setHStatus("Suppression…");
    const { error } = await supabase.from("admin_hidden_filters").delete().eq("id", id);
    if (error) {
      setHStatus(error.message, true);
      return;
    }
    await loadHRows();
  }

  async function addHRow(): Promise<void> {
    if (!supabase) return;
    const needle = needleEl.value.trim();
    if (!needle) {
      setHStatus("Saisissez un mot ou fragment.", true);
      return;
    }
    addEl.disabled = true;
    setHStatus("Ajout…");
    const { error } = await supabase.from("admin_hidden_filters").insert({ needle });
    addEl.disabled = false;
    if (error) {
      setHStatus(error.message, true);
      return;
    }
    needleEl.value = "";
    await loadHRows();
  }

  if (!hiddenFiltersAdminBound) {
    addEl.addEventListener("click", () => void addHRow());
    hiddenFiltersAdminBound = true;
  }

  await loadHRows();
}
