import Hls, { ErrorDetails, ErrorTypes, type ErrorData } from "hls.js";
import { isAdminSession, tryConsumeAdminAccessFromUrl } from "./adminSession";
import {
  displayChannelName,
  setChannelHideNeedlesFromDatabase,
  setChannelNamePrefixesFromDatabase,
  shouldHideChannelByName,
} from "./assignmentMatch";
import {
  applySettingsRouteOnLoad,
  isSettingsPageOpen,
  openSettingsPage,
  syncSettingsFromUrl,
} from "./settingsPage";
import {
  type AdminConfig,
  type AdminCountry,
  type AdminPackage,
  EMPTY_ADMIN_CONFIG,
} from "./adminHierarchyConfig";
import { THEMES, presetForPackageName } from "./packageThemePresets";
import { matchCanonicalCountry, normalizeCountryKey } from "./canonicalCountries";
import { fetchAndApplyCanonicalCountries } from "./canonicalCountriesSupabase";
import { fetchAndApplyChannelNamePrefixes } from "./channelNamePrefixesSupabase";
import { fetchAndApplyChannelHideNeedles } from "./channelHideNeedlesSupabase";
import { normalizeGlobalAllowlistNameKey } from "./globalPackageAllowlist";
import {
  clearGlobalPackageSupabaseCaches,
  fetchGlobalPackageAllowlistLines,
  fetchGlobalPackageOpenConfirmUi,
  getGlobalPackageAllowlistLines,
  getGlobalPackageOpenConfirmUi,
} from "./globalPackageAllowlistSupabase";
import { buildProviderAdminConfig, inferCountryFromCategoryName } from "./providerLayout";
import {
  type LiveCategory,
  type LiveStream,
  tryNodecastLoginAndLoad,
  fetchNodecastLiveStreamsForCategories,
  fetchNodecastVodCategories,
  fetchNodecastVodStreamsForCategories,
  fetchNodecastSeriesCategories,
  fetchNodecastSeriesStreamsForCategories,
  resolveNodecastStreamUrl,
  resolveNodecastVodStreamUrl,
  resolveNodecastSeriesPlayableUrl,
  createNodecastLiveTranscodeUrl,
  createNodecastVodTranscodeSession,
  probeNodecastStreamCompatibility,
  getNodecastTranscodeSessionMeta,
  fetchNodecastVodInfo,
  fetchNodecastSeriesInfo,
  pingNodecastSourcesStatus,
  proxiedUrl,
  imageUrlForDisplay,
  normalizeServerInput,
  sameOrigin,
  isVeloraCatalogCacheDebugEnabled,
  type NodecastTranscodeSessionMeta,
  type SeriesEpisodeListItem,
} from "./nodecastCatalog";
import {
  fetchDbAdminCountries,
  fetchDbAdminPackages,
  getSupabaseClient,
  isLikelyUuid,
  matchDbCountryIdByDisplayName,
  uploadPackageCoverFile,
  isPackageCoverDebugEnabled,
} from "./supabaseAdminHierarchy";
import { runCoverSquareCrop } from "./coverSquareCrop";
import {
  FRANCE_SYNTH_PACKAGES,
  STREAM_CURATION_HIDDEN,
  autoSynthPackageIdForStreamName,
  collectStreamsFromProviderCategories,
  listStreamsForOpenedPackage,
} from "./franceStreamCuration";
import { fetchDbStreamCurations, upsertStreamCuration } from "./channelCurationSupabase";
import { applySavedOrder, mergeVisibleReorder } from "./packageChannelOrder";
import {
  fetchDbPackageChannelOrders,
  upsertPackageChannelOrder,
} from "./packageChannelOrderSupabase";
import { fetchDbPackageGridOrders, upsertPackageGridOrder } from "./packageGridOrderSupabase";
import {
  clearPackageCoverImageKeepingThemes,
  fetchDbPackageCoverOverrides,
  setPackageCoverDeletedState,
  upsertPackageCoverOverride,
  upsertPackageCoverThemeOnly,
  type PackageCoverOverrideEntry,
  type PackageThemeColumns,
} from "./packageCoverOverridesSupabase";
import {
  extractPresetFromImageUrl,
  extractPresetFromImageUrlCached,
  invalidatePackageImageThemeCache,
} from "./packageImageTheme";
import { applyVeloraShellBgToMain } from "./veloraShellBackground";
import {
  initTrialGate,
  canStartPlayback,
  markPlaybackStopped,
  showTrialExpiredModal,
  isTrialBlocked,
} from "./trialGate";

type ServerInfo = {
  url: string;
  port: string | number;
  https_port?: string | number;
  server_protocol?: string;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

const elServer = $("#server") as HTMLInputElement;
const elUser = $("#user") as HTMLInputElement;
const elPass = $("#pass") as HTMLInputElement;
const elBtnConnect = $("#btn-connect") as HTMLButtonElement;
const elLoginStatus = $("#login-status") as HTMLSpanElement;
const elMain = $("#main") as HTMLElement;
const elCatalogLoadingOverlay = $("#catalog-loading-overlay") as HTMLDivElement | null;
const elCatalogLoadingStatus = $("#catalog-loading-status") as HTMLParagraphElement | null;
const elLoginPanel = document.querySelector(".login-panel") as HTMLElement;
const elCatPills = $("#cat-pills") as HTMLDivElement;
const elCatPillsWrap = $("#cat-pills-wrap") as HTMLElement;
const elVideo = $("#video") as HTMLVideoElement;
const elVideoVod = document.getElementById("video-vod") as HTMLVideoElement | null;
elVideo.preload = "auto";
elVideo.crossOrigin = "anonymous";
configureLiveNativeUi(elVideo);
const elLiveVideoWrapper = elVideo.closest<HTMLElement>(".video-wrapper");
const elLiveControlsOverlay = document.getElementById("live-controls-overlay") as HTMLDivElement | null;
const elLiveCtlPlay = document.getElementById("live-ctl-play") as HTMLButtonElement | null;
const elLiveCtlMute = document.getElementById("live-ctl-mute") as HTMLButtonElement | null;
const elLiveCtlFullscreen = document.getElementById("live-ctl-fullscreen") as HTMLButtonElement | null;
const VOD_VOLUME_LS_KEY = "velora_vod_volume_v1";
const LIVE_TRANSCODE_NEEDED_LS_PREFIX = "velora_live_transcode_needed_v1";

function readPersistedVodVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOD_VOLUME_LS_KEY);
    if (raw == null) return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
  } catch {
    return 1;
  }
}

function persistVodVolume(volume: number): void {
  if (!Number.isFinite(volume)) return;
  try {
    window.localStorage.setItem(VOD_VOLUME_LS_KEY, String(volume));
  } catch {
    /* ignore */
  }
}

/** Films / épisodes VOD : son activé par défaut après un clic utilisateur ; repli silencieux si autoplay bloque. */
function prepareVodAudioForPlayback(video: HTMLVideoElement): void {
  video.volume = readPersistedVodVolume();
  video.muted = false;
}

if (elVideoVod) {
  elVideoVod.preload = "none";
  elVideoVod.crossOrigin = "anonymous";
  elVideoVod.muted = false;
  elVideoVod.autoplay = false;
}
const elVodPlayerContainer = document.getElementById("vod-player-container") as HTMLElement | null;
const elVodVideoWrapper = elVideoVod?.closest<HTMLElement>(".video-wrapper") ?? null;
const elNowPlayingVod = document.getElementById("now-playing-vod") as HTMLDivElement | null;
const elVodPlayerBuffering = document.getElementById("vod-player-buffering") as HTMLDivElement | null;
const elVodControlsOverlay = document.getElementById("vod-controls-overlay") as HTMLDivElement | null;
const elVodCtlPlay = document.getElementById("vod-ctl-play") as HTMLButtonElement | null;
const elVodCtlSeekTrack = document.getElementById("vod-ctl-seek-track") as HTMLDivElement | null;
const elVodCtlSeekFill = document.getElementById("vod-ctl-seek-fill") as HTMLDivElement | null;
const elVodCtlSeekHandle = document.getElementById("vod-ctl-seek-handle") as HTMLDivElement | null;
const elVodCtlCurrent = document.getElementById("vod-ctl-current") as HTMLSpanElement | null;
const elVodCtlDuration = document.getElementById("vod-ctl-duration") as HTMLSpanElement | null;
const elVodCtlMute = document.getElementById("vod-ctl-mute") as HTMLButtonElement | null;
const elVodCtlFullscreen = document.getElementById("vod-ctl-fullscreen") as HTMLButtonElement | null;
const elBtnCloseVodPlayer = document.getElementById("btn-close-vod-player") as HTMLButtonElement | null;
const elPlayerBuffering = document.getElementById("player-buffering") as HTMLDivElement | null;
const elNowPlaying = $("#now-playing") as HTMLDivElement;
const elBtnLogout = $("#btn-logout") as HTMLButtonElement;
const elBtnSettings = $("#btn-settings") as HTMLButtonElement | null;
const elVelAdminToolsWrap = document.getElementById("vel-admin-tools-wrap") as HTMLElement | null;
const elToggleAdminUi = document.getElementById("toggle-admin-ui") as HTMLInputElement | null;
const elHeaderLoginOnly = document.querySelector(".header--login-only") as HTMLElement | null;
const elCountrySelect = $("#country-select") as HTMLSelectElement;
const elDialogAddPkg = document.getElementById("dialog-admin-add-package") as HTMLDialogElement;
const elDapSbCountry = document.getElementById("dap-sb-country") as HTMLSelectElement;
const elDapName = document.getElementById("dap-name") as HTMLInputElement;
const elDapCancel = document.getElementById("dap-cancel") as HTMLButtonElement;
const elDapSubmit = document.getElementById("dap-submit") as HTMLButtonElement;
const elDapStatus = document.getElementById("dap-status") as HTMLParagraphElement;
const elDapCover = document.getElementById("dap-cover") as HTMLInputElement;
const elDapCoverPick = document.getElementById("dap-cover-pick") as HTMLButtonElement | null;
const elDapCoverEmpty = document.getElementById("dap-cover-empty") as HTMLDivElement | null;
const elDapCoverPreviewWrap = document.getElementById("dap-cover-preview-wrap") as HTMLDivElement | null;
const elDapCoverPreview = document.getElementById("dap-cover-preview") as HTMLImageElement | null;
const elDapDropzone = document.getElementById("dap-dropzone") as HTMLDivElement | null;
const elDapEmptyCountriesHint = document.getElementById("dap-empty-countries-hint") as HTMLParagraphElement | null;
const elDapNewCountryName = document.getElementById("dap-new-country-name") as HTMLInputElement;
const elDapAddCountry = document.getElementById("dap-add-country") as HTMLButtonElement;
const elCurateStatus = document.getElementById("vel-curate-status") as HTMLParagraphElement | null;
let curateStatusClearTimer: number | undefined;

/** Visible feedback in the player shell (login status is hidden after connect). */
function flashCurateStatus(message: string, isError: boolean): void {
  if (!elCurateStatus) {
    if (isError) window.alert(message);
    return;
  }
  elCurateStatus.textContent = message;
  elCurateStatus.classList.remove("hidden");
  elCurateStatus.classList.toggle("vel-curate-status--error", isError);
  if (curateStatusClearTimer) window.clearTimeout(curateStatusClearTimer);
  curateStatusClearTimer = window.setTimeout(() => {
    elCurateStatus.classList.add("hidden");
    elCurateStatus.textContent = "";
  }, 6000);
}

const elDialogPackageCover = document.getElementById("dialog-package-cover") as HTMLDialogElement | null;
const elPcePackageId = document.getElementById("pce-package-id") as HTMLInputElement | null;
const elPcePackageName = document.getElementById("pce-package-name") as HTMLParagraphElement | null;
const elPceCover = document.getElementById("pce-cover") as HTMLInputElement | null;
const elPceCoverPick = document.getElementById("pce-cover-pick") as HTMLButtonElement | null;
const elPceCoverEmpty = document.getElementById("pce-cover-empty") as HTMLDivElement | null;
const elPceCoverPreviewWrap = document.getElementById("pce-cover-preview-wrap") as HTMLDivElement | null;
const elPceCoverPreview = document.getElementById("pce-cover-preview") as HTMLImageElement | null;
const elPceDropzone = document.getElementById("pce-dropzone") as HTMLDivElement | null;
const elPceClear = document.getElementById("pce-clear") as HTMLButtonElement | null;
const elPceCancel = document.getElementById("pce-cancel") as HTMLButtonElement | null;
const elPceSubmit = document.getElementById("pce-submit") as HTMLButtonElement | null;
const elPceStatus = document.getElementById("pce-status") as HTMLParagraphElement | null;
const elPceThemeBg = document.getElementById("pce-theme-bg") as HTMLInputElement | null;
const elPceThemeSurface = document.getElementById("pce-theme-surface") as HTMLInputElement | null;
const elPceThemePrimary = document.getElementById("pce-theme-primary") as HTMLInputElement | null;
const elPceThemeGlow = document.getElementById("pce-theme-glow") as HTMLInputElement | null;
const elPceThemeBack = document.getElementById("pce-theme-back") as HTMLInputElement | null;
const elPceThemeReset = document.getElementById("pce-theme-reset") as HTMLButtonElement | null;

/** `URL.createObjectURL` for cover previews — revoked when clearing or replacing. */
let pceCoverPreviewObjectUrl: string | null = null;
let dapCoverPreviewObjectUrl: string | null = null;

const elDialogChannelAssign = document.getElementById("dialog-channel-assign") as HTMLDialogElement | null;
const elChannelAssignSelect = document.getElementById("channel-assign-package") as HTMLSelectElement | null;
const elChannelAssignStatus = document.getElementById("channel-assign-status") as HTMLParagraphElement | null;
const elChannelAssignTitle = document.getElementById("channel-assign-title") as HTMLHeadingElement | null;
const elChannelAssignHint = document.getElementById("channel-assign-hint") as HTMLParagraphElement | null;
const elChannelAssignCancel = document.getElementById("channel-assign-cancel") as HTMLButtonElement | null;
const elChannelAssignOk = document.getElementById("channel-assign-ok") as HTMLButtonElement | null;
let pendingAssignStreamIds: number[] = [];
const selectedAdminChannelStreamIds = new Set<number>();

const elDialogAddChannels = document.getElementById("dialog-admin-add-channels") as HTMLDialogElement | null;
const elAddChannelsHint = document.getElementById("add-channels-package-hint") as HTMLParagraphElement | null;
const elAddChannelsSearch = document.getElementById("add-channels-search") as HTMLInputElement | null;
const elAddChannelsList = document.getElementById("add-channels-list") as HTMLDivElement | null;
const elAddChannelsStatus = document.getElementById("add-channels-status") as HTMLParagraphElement | null;
const elAddChannelsCancel = document.getElementById("add-channels-cancel") as HTMLButtonElement | null;
const elAddChannelsSubmit = document.getElementById("add-channels-submit") as HTMLButtonElement | null;
const elAddChannelsSelectVisible = document.getElementById("add-channels-select-visible") as HTMLButtonElement | null;
const elBtnAdminAddChannels = document.getElementById("btn-admin-add-channels") as HTMLButtonElement | null;
const elBtnAdminSelectAllChannels = document.getElementById("btn-admin-select-all-channels") as HTMLButtonElement | null;

const elPlayerContainer = $("#player-container") as HTMLElement;
const elBtnClosePlayer = document.getElementById("btn-close-player") as HTMLButtonElement | null;
const elMainTabs = $("#main-tabs") as HTMLElement;
const elPackagesView = $("#packages-view") as HTMLDivElement;
const elAdultView = document.getElementById("adult-view") as HTMLDivElement | null;
const elBtnAdultPortal = document.getElementById("btn-adult-portal") as HTMLButtonElement | null;
const elAdultTabLive = document.getElementById("adult-tab-live") as HTMLButtonElement | null;
const elAdultTabMovies = document.getElementById("adult-tab-movies") as HTMLButtonElement | null;
const elAdultTabHome = document.getElementById("adult-tab-home") as HTMLButtonElement | null;
const elAdultConfirmDialog = document.getElementById("vel-adult-confirm-dialog") as HTMLDialogElement | null;
const elAdultConfirmYes = document.getElementById("vel-adult-confirm-yes") as HTMLButtonElement | null;
const elAdultConfirmNo = document.getElementById("vel-adult-confirm-no") as HTMLButtonElement | null;
const elContentView = $("#content-view") as HTMLElement;
const elDynamicList = $("#dynamic-list") as HTMLDivElement;
const elBtnBackHome = $("#btn-back-home") as HTMLButtonElement;
const elBtnGoHome = $("#btn-go-home") as HTMLButtonElement | null;
const elBtnLogoHome = $("#btn-logo-home") as HTMLButtonElement | null;
const elTabLive = $("#tab-live") as HTMLButtonElement;
const elTabMovies = $("#tab-movies") as HTMLButtonElement;
const elTabSeries = $("#tab-series") as HTMLButtonElement;

applyVeloraShellBgToMain(elMain);
window.addEventListener("velora-shell-bg-changed", () => applyVeloraShellBgToMain(elMain));

type PillId = string;

const ALL_PILL = { id: "all", label: "Tout" } as const;

let selectedPillId: PillId = "all";
let pillDefs: Array<{ id: string; label: string }> = [ALL_PILL];

let adminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };
/** Pays › bouquets dérivés des catégories VOD / séries (même logique que le live). */
let vodAdminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };
let seriesAdminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };
/** Dernier échec de chargement catalogue (affiché si le stockage local est vide après fetch). */
let nodecastVodCatalogFetchError: string | null = null;
let nodecastSeriesCatalogFetchError: string | null = null;

type UiTab = "live" | "movies" | "series";
type UiShell = "packages" | "content";
type AdultCatalogTab = "live" | "movies";

let uiTab: UiTab = "live";
let uiShell: UiShell = "packages";
let adultPortalMode = false;
let adultPortalTab: AdultCatalogTab = "live";
/** When in live TV content view, which admin package (grid card) is open. */
let uiAdminPackageId: string | null = null;
/** Selected country in the header (inferred from catalogue keys, e.g. canonical id). */
let selectedAdminCountryId: string | null = null;
/** Supabase `admin_countries` / `admin_packages` — merged into the grid for admins. */
let dbAdminCountries: AdminCountry[] = [];
let dbAdminPackages: AdminPackage[] = [];
/** Supabase `country_id` → `stream_id` → `target_package_id` (or `hidden`). */
let streamCurationByCountry: Map<string, Map<number, string>> = new Map();
/** `package_id` (fournisseur ou velagg:…) → image + couleurs hors `admin_packages`. */
let packageCoverOverrideById: Map<string, PackageCoverOverrideEntry> = new Map();
/** `${country_id or cat:…}::${package_id}` → manual live channel order (stream_id sequence). */
let packageChannelOrderByKey: Map<string, number[]> = new Map();
/** `${country_id}::${ui_tab}` -> manual package card order (package id sequence). */
let packageGridOrderByKey: Map<string, string[]> = new Map();
/** Bouquets présents sur la grille uniquement grâce à la liste globale Supabase (popup avant ouverture). */
let globalAllowlistInjectedPackageIds = new Set<string>();
let packagesGridRenderToken = 0;

function isGlobalAllowlistInjectedPackageId(packageId: string): boolean {
  return globalAllowlistInjectedPackageIds.has(packageId);
}

const COUNTRY_STORAGE_KEY = "lumina_selected_country_id";
const ADULT_ACCESS_SESSION_KEY = "velora_adult_confirmed_v1";
const PKG_CHANNEL_ORDER_LS_PREFIX = "velora_pkg_ch_order_v1";
const PKG_GRID_ORDER_LS_PREFIX = "velora_pkg_grid_order_v1";
/** When `"0"`, hide + / Supabase delete in the grid (admin session only). Default = visible. */
const ADMIN_GRID_TOOLS_KEY = "velora_admin_grid_tools";
/** Same id as `providerLayout` « Autres » bucket — keep last in the list. */
const OTHER_COUNTRY_ID = "country__other";

type TvDirection = "up" | "down" | "left" | "right";

const TV_MODE_STORAGE_KEY = "velora_tv_mode";
const TV_FOCUS_CLASS = "velora-tv-focus";
const TV_FOCUSABLE_SELECTOR = [
  "button",
  "a[href]",
  "select",
  "textarea",
  "input:not([type='hidden'])",
  "[role='button']",
  "[role='tab']",
  "[role='slider']",
  "[tabindex]",
  "[data-tv-focusable='true']",
].join(",");

let tvNavigationEnabled = false;
let tvFocusMutationObserver: MutationObserver | null = null;
let tvSelectMenuEl: HTMLDivElement | null = null;
let tvFocusRefreshPending = false;

function readTvModeRequested(): boolean {
  try {
    const params = new URL(window.location.href).searchParams;
    const tvParam = params.get("tv")?.trim();
    if (tvParam === "1") {
      window.localStorage.setItem(TV_MODE_STORAGE_KEY, "1");
      return true;
    }
    if (tvParam === "0") {
      window.localStorage.removeItem(TV_MODE_STORAGE_KEY);
      return false;
    }
    return window.localStorage.getItem(TV_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markTvFocusable(el: HTMLElement): void {
  el.dataset.tvFocusable = "true";
  if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
}

function isElementActuallyVisible(el: HTMLElement): boolean {
  if (el.closest("[hidden], .hidden, [inert]")) return false;
  if (el.closest("[aria-hidden='true']") && !el.closest("dialog[open]")) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isTvFocusableElement(el: HTMLElement): boolean {
  if (!isElementActuallyVisible(el)) return false;
  if (el.matches("button, input, select, textarea") && (el as HTMLButtonElement | HTMLInputElement).disabled) {
    return false;
  }
  const tabIndexAttr = el.getAttribute("tabindex");
  if (tabIndexAttr != null && Number(tabIndexAttr) < 0 && el.dataset.tvFocusable !== "true") return false;
  return true;
}

function isWithinTvNavigationWindow(el: HTMLElement): boolean {
  if (tvSelectMenuEl && tvSelectMenuEl.contains(el)) return true;
  const rect = el.getBoundingClientRect();
  const yMargin = window.innerHeight * 0.75;
  const xMargin = window.innerWidth * 0.45;
  return (
    rect.bottom >= -yMargin &&
    rect.top <= window.innerHeight + yMargin &&
    rect.right >= -xMargin &&
    rect.left <= window.innerWidth + xMargin
  );
}

function tvFocusScopeRoot(): ParentNode {
  if (tvSelectMenuEl && isElementActuallyVisible(tvSelectMenuEl)) return tvSelectMenuEl;
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(isElementActuallyVisible);
  if (dialogs.length > 0) return dialogs[dialogs.length - 1];
  const trialOverlay = document.querySelector<HTMLElement>(
    ".trial-modal-overlay:not(.trial-modal-overlay--hidden), .trial-offer-overlay:not(.trial-modal-overlay--hidden)"
  );
  if (trialOverlay && isElementActuallyVisible(trialOverlay)) return trialOverlay;
  return document;
}

function getTvFocusableElements(): HTMLElement[] {
  const scope = tvFocusScopeRoot();
  const elements = [...scope.querySelectorAll<HTMLElement>(TV_FOCUSABLE_SELECTOR)];
  const unique = [...new Set(elements)];
  return unique.filter((el) => isTvFocusableElement(el) && isWithinTvNavigationWindow(el));
}

function clearTvFocusClass(): void {
  document.querySelectorAll(`.${TV_FOCUS_CLASS}`).forEach((el) => el.classList.remove(TV_FOCUS_CLASS));
}

function setTvFocus(el: HTMLElement, scroll = true): void {
  if (!isTvFocusableElement(el)) return;
  clearTvFocusClass();
  el.classList.add(TV_FOCUS_CLASS);
  el.focus({ preventScroll: true });
  if (scroll) {
    const block = el.closest("#packages-view, #dynamic-list") ? "center" : "nearest";
    el.scrollIntoView({ block, inline: "nearest", behavior: "auto" });
  }
}

function getCurrentTvFocus(candidates = getTvFocusableElements()): HTMLElement | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active && candidates.includes(active) && isTvFocusableElement(active)) return active;
  const marked = document.querySelector<HTMLElement>(`.${TV_FOCUS_CLASS}`);
  if (marked && candidates.includes(marked) && isTvFocusableElement(marked)) return marked;
  return null;
}

function ensureTvFocus(): HTMLElement | null {
  const candidates = getTvFocusableElements();
  const current = getCurrentTvFocus(candidates);
  if (current) {
    current.classList.add(TV_FOCUS_CLASS);
    return current;
  }
  const first = candidates[0] ?? null;
  if (first) setTvFocus(first, false);
  return first;
}

function tvRectCenter(rect: DOMRect): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function directionalPrimaryDistance(from: DOMRect, to: DOMRect, direction: TvDirection): number {
  if (direction === "right") return Math.max(0, to.left - from.right);
  if (direction === "left") return Math.max(0, from.left - to.right);
  if (direction === "down") return Math.max(0, to.top - from.bottom);
  return Math.max(0, from.top - to.bottom);
}

function perpendicularOverlap(from: DOMRect, to: DOMRect, direction: TvDirection): number {
  if (direction === "left" || direction === "right") {
    return Math.max(0, Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top));
  }
  return Math.max(0, Math.min(from.right, to.right) - Math.max(from.left, to.left));
}

function tvNavigationGroup(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(
    [
      ".velora-tv-select-menu",
      ".vod-controls-row",
      ".live-controls-row",
      "#dynamic-list",
      "#packages-view",
      "#cat-pills",
      "#main-tabs",
      ".vel-header",
    ].join(",")
  );
}

function moveTvFocus(direction: TvDirection): void {
  const candidates = getTvFocusableElements();
  if (candidates.length === 0) return;
  const current = getCurrentTvFocus(candidates) ?? candidates[0];
  if (!current) return;
  const currentRect = current.getBoundingClientRect();
  const currentCenter = tvRectCenter(currentRect);
  const ranked: Array<{ el: HTMLElement; score: number; inBeam: boolean }> = [];

  for (const el of candidates) {
    if (el === current) continue;
    const rect = el.getBoundingClientRect();
    const center = tvRectCenter(rect);
    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;
    const moving =
      (direction === "right" && dx > 3) ||
      (direction === "left" && dx < -3) ||
      (direction === "down" && dy > 3) ||
      (direction === "up" && dy < -3);
    if (!moving) continue;

    const primary = directionalPrimaryDistance(currentRect, rect, direction);
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const overlap = perpendicularOverlap(currentRect, rect, direction);
    const minBeamOverlap =
      direction === "left" || direction === "right"
        ? Math.min(currentRect.height, rect.height) * 0.34
        : Math.min(currentRect.width, rect.width) * 0.34;
    const inBeam =
      direction === "left" || direction === "right"
        ? overlap >= Math.max(14, minBeamOverlap) &&
          secondary <= Math.min(currentRect.height, rect.height) * 0.65
        : overlap >= Math.max(8, minBeamOverlap);
    const score = primary * 1000 + secondary * (inBeam ? 3 : 14) - overlap * 8;
    ranked.push({ el, score, inBeam });
  }

  const beam = ranked.filter((item) => item.inBeam);
  if ((direction === "up" || direction === "down") && current.closest("#dynamic-list, #packages-view")) {
    const currentGroup = tvNavigationGroup(current);
    const sameGroup = ranked.filter((item) => tvNavigationGroup(item.el) === currentGroup);
    const sameGroupBeam = sameGroup.filter((item) => item.inBeam);
    const pool = sameGroupBeam.length > 0 ? sameGroupBeam : sameGroup;
    if (pool.length > 0) {
      const best = pool.sort((a, b) => a.score - b.score)[0];
      setTvFocus(best.el);
      return;
    }
  }
  if ((direction === "left" || direction === "right") && beam.length === 0) {
    setTvFocus(current);
    return;
  }
  const pool = beam.length > 0 ? beam : ranked;
  const best = pool.sort((a, b) => a.score - b.score)[0];
  setTvFocus(best?.el ?? current);
}

function closeTvSelectMenu(): boolean {
  if (!tvSelectMenuEl) return false;
  const hadMenu = tvSelectMenuEl.isConnected;
  tvSelectMenuEl.remove();
  tvSelectMenuEl = null;
  return hadMenu;
}

function openTvSelectMenu(select: HTMLSelectElement): void {
  closeTvSelectMenu();
  const menu = document.createElement("div");
  menu.className = "velora-tv-select-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", select.getAttribute("aria-label") || "Choisir une option");

  const rect = select.getBoundingClientRect();
  const maxHeight = Math.min(420, Math.max(180, window.innerHeight - rect.bottom - 16));
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - maxHeight - 8)}px`;
  menu.style.width = `${Math.max(rect.width, 220)}px`;
  menu.style.maxHeight = `${maxHeight}px`;

  const selectedValue = select.value;
  let selectedButton: HTMLButtonElement | null = null;
  for (const option of [...select.options]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "velora-tv-select-option";
    btn.dataset.tvFocusable = "true";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", option.value === selectedValue ? "true" : "false");
    btn.textContent = option.textContent || option.value;
    btn.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      closeTvSelectMenu();
      setTvFocus(select);
    });
    if (option.value === selectedValue) selectedButton = btn;
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  tvSelectMenuEl = menu;
  syncTvFocusableMetadata(menu);
  setTvFocus(selectedButton ?? menu.querySelector<HTMLElement>(".velora-tv-select-option") ?? select);
}

function clickCurrentTvFocus(): void {
  const current = ensureTvFocus();
  if (!current) return;
  if (current instanceof HTMLSelectElement) {
    openTvSelectMenu(current);
    return;
  }
  current.click();
}

function closeTopTvDialog(): boolean {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(isElementActuallyVisible);
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return false;
  const closeButton = dialog.querySelector<HTMLElement>(
    [
      "[data-tv-close='true']",
      "[id*='cancel' i]",
      "[id*='close' i]",
      "[id*='no' i]",
      "button[aria-label*='fermer' i]",
      "button[aria-label*='annuler' i]",
      "button[value='cancel']",
    ].join(",")
  );
  if (closeButton && isElementActuallyVisible(closeButton)) {
    closeButton.click();
  } else {
    dialog.close();
  }
  return true;
}

function handleTvBackAction(): void {
  if (closeTvSelectMenu()) return;
  if (closeTopTvDialog()) return;
  const trialOverlay = document.querySelector<HTMLElement>(".trial-modal-overlay:not(.trial-modal-overlay--hidden)");
  if (trialOverlay && isElementActuallyVisible(trialOverlay) && !document.body.classList.contains("trial-locked")) {
    trialOverlay.classList.add("trial-modal-overlay--hidden");
    return;
  }
  if (!elPlayerContainer.classList.contains("hidden")) {
    closePlayerUserAction();
    return;
  }
  if (elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden")) {
    closeVodPlayerUserAction();
    return;
  }
  if (uiShell === "content" || veloraUiHistoryDepth > 0) {
    window.history.back();
  }
}

function syncTvFocusableMetadata(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>(
    [
      "#country-select",
      "#main-tabs .tab",
      "#btn-adult-portal",
      "#btn-back-home",
      "#btn-go-home",
      "#btn-logo-home",
      "#btn-settings",
      "#btn-logout",
      ".vel-package-card",
      ".media-item",
      ".vel-vod-movie-card",
      ".vel-vod-detail__watch",
      ".vel-vod-detail__episode",
      ".vel-vod-detail__season-select",
      ".cat-pill",
      ".vel-adult-tab",
      ".vel-player-dismiss-x",
      ".live-ctl-btn",
      ".vod-ctl-btn",
      ".vod-ctl-seek-track",
      ".trial-offer-highlight",
      ".trial-offer-button",
      ".trial-modal-button",
      ".trial-expired-dialog__btn",
      ".vel-global-pkg-confirm-dialog__btn",
      ".admin-pkg-edit-sb",
      ".admin-pkg-del-sb",
      ".vel-media-item-tool",
      ".velora-tv-select-option",
    ].join(",")
  )) {
    markTvFocusable(el);
  }
}

function refreshTvFocusSoon(): void {
  if (!tvNavigationEnabled) return;
  if (tvFocusRefreshPending) return;
  tvFocusRefreshPending = true;
  window.requestAnimationFrame(() => {
    tvFocusRefreshPending = false;
    syncTvFocusableMetadata();
    const current = getCurrentTvFocus();
    if (current) setTvFocus(current, false);
  });
}

function initTvNavigation(): void {
  tvNavigationEnabled = readTvModeRequested();
  document.body.classList.toggle("velora-tv-mode", tvNavigationEnabled);
  if (!tvNavigationEnabled) return;

  syncTvFocusableMetadata();
  tvFocusMutationObserver?.disconnect();
  tvFocusMutationObserver = new MutationObserver(() => refreshTvFocusSoon());
  tvFocusMutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "aria-hidden", "disabled", "tabindex"],
  });

  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || !isTvFocusableElement(target)) return;
      clearTvFocusClass();
      target.classList.add(TV_FOCUS_CLASS);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!tvNavigationEnabled || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key;
      if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        const direction: TvDirection =
          key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : "right";
        moveTvFocus(direction);
        return;
      }
      if (key === "Enter" || key === "OK" || key === "Accept") {
        event.preventDefault();
        event.stopPropagation();
        clickCurrentTvFocus();
        return;
      }
      if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || key === "GoBack") {
        event.preventDefault();
        event.stopPropagation();
        handleTvBackAction();
      }
    },
    true
  );

  window.addEventListener("storage", (event) => {
    if (event.key !== TV_MODE_STORAGE_KEY) return;
    tvNavigationEnabled = readTvModeRequested();
    document.body.classList.toggle("velora-tv-mode", tvNavigationEnabled);
    if (tvNavigationEnabled) refreshTvFocusSoon();
  });

  window.setTimeout(() => {
    ensureTvFocus();
  }, 0);
}

/** Entrées pushState Velora encore « actives » (package, fiche VOD, lecteur). */
let veloraUiHistoryDepth = 0;
let veloraIgnoreHistoryPopstate = false;
/** Évite un second `history.go` lorsque la fermeture du lecteur est déjà due à un popstate. */
let veloraApplyingHistoryPopstate = false;

function veloraPushNavigationState(tag: string): void {
  try {
    const prev = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
    window.history.pushState({ ...(prev as object), veloraNav: tag }, "", window.location.href);
    veloraUiHistoryDepth++;
  } catch {
    /* ignore */
  }
}

function stripVeloraHistorySilently(steps: number): void {
  if (steps <= 0 || veloraUiHistoryDepth <= 0) return;
  const n = Math.min(steps, veloraUiHistoryDepth);
  veloraUiHistoryDepth -= n;
  veloraIgnoreHistoryPopstate = true;
  window.history.go(-n);
}

function ensureVeloraHistoryRootMarker(): void {
  try {
    const prev = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
    if (!(prev as Record<string, unknown>).veloraHistoryRoot) {
      window.history.replaceState({ ...(prev as object), veloraHistoryRoot: true }, "", window.location.href);
    }
  } catch {
    /* ignore */
  }
}

function resolvedIconUrl(raw: string | undefined, base: string): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    return /^https?:\/\//i.test(s) ? s : new URL(s, base).href;
  } catch {
    return null;
  }
}

function buildLiveStreamUrl(
  server: ServerInfo,
  username: string,
  password: string,
  streamId: number,
  ext: "m3u8" | "ts"
): string {
  const protocol = (server.server_protocol || "http").replace(/:$/, "");
  const host = String(server.url).replace(/^\/+/, "");
  const useHttps = protocol === "https";
  const port = String(
    useHttps && server.https_port != null && server.https_port !== ""
      ? server.https_port
      : server.port || ""
  );
  const hostPort = port ? `${host}:${port}` : host;
  const base = `${protocol}://${hostPort}`.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;
}

let state: {
  mode: "xtream" | "nodecast";
  base: string;
  username: string;
  password: string;
  nodecastAuthHeaders?: Record<string, string>;
  serverInfo: ServerInfo;
  liveCategories: LiveCategory[];
  /** Full provider catalog (used only to resolve streams matched by admin rules). */
  streamsByCatAll: Map<string, LiveStream[]>;
  liveLoadedCategoryIds: Set<string>;
  nodecastXtreamSourceId?: string;
  vodCategories: LiveCategory[];
  vodStreamsByCat: Map<string, LiveStream[]>;
  vodLoadedCategoryIds: Set<string>;
  seriesCategories: LiveCategory[];
  seriesStreamsByCat: Map<string, LiveStream[]>;
  seriesLoadedCategoryIds: Set<string>;
  /** VOD / séries ne sont chargés qu’à l’ouverture des onglets (pas au login). */
  vodCatalogLoaded: boolean;
  seriesCatalogLoaded: boolean;
} | null = null;

/** Persist Nodecast catalogue + layouts for env-auth refresh (skip second login/catalog fetch). */
const NODECAST_SNAPSHOT_STORAGE_KEY = "velora-nodecast-session-v1";

/** Last Nodecast origin that completed login (session-only fast path). */
const NODECAST_WORKING_BASE_SS_KEY = "velora_nodecast_working_base";

function preferNodecastPort3000FromEnv(): boolean {
  const v = import.meta.env.VITE_NODECAST_PREFER_PORT_3000?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Base URLs to try for Nodecast login (order + preferred timeouts). */
function buildNodecastLoginBaseCandidates(userEnteredBase: string): { url: string; preferred: boolean }[] {
  const out: { url: string; preferred: boolean }[] = [];
  const seen = new Set<string>();

  function push(url: string, preferred: boolean): void {
    const normalized = normalizeServerInput(url.trim()).replace(/\/+$/, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ url: normalized, preferred });
  }

  try {
    const w = sessionStorage.getItem(NODECAST_WORKING_BASE_SS_KEY)?.trim();
    if (w) push(w, true);
  } catch {
    /* ignore */
  }

  const apiBase = import.meta.env.VITE_NODECAST_API_BASE?.trim();
  if (apiBase) push(apiBase, true);

  if (preferNodecastPort3000FromEnv()) {
    const envUrl = import.meta.env.VITE_NODECAST_URL?.trim();
    if (envUrl) {
      try {
        const u = new URL(normalizeServerInput(envUrl));
        if (!u.port) {
          push(`${u.protocol}//${u.hostname}:3000`, true);
        }
      } catch {
        /* ignore */
      }
    }
  }

  push(userEnteredBase, false);

  return out;
}

/** Last catalogue UI (package, fiche VOD, onglet…) — restauré après F5 / rechargement. */
const VELORA_UI_ROUTE_STORAGE_KEY = "velora-ui-route-v1";

function veloraRouteDebugEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("velora_debug_route") === "1") {
      return true;
    }
    return new URLSearchParams(window.location.search).has("velora_debug_route");
  } catch {
    return false;
  }
}

function veloraRouteDebug(message: string, detail?: Record<string, unknown>): void {
  if (!veloraRouteDebugEnabled()) return;
  if (detail) console.info("[Velora route]", message, detail);
  else console.info("[Velora route]", message);
}

type VeloraUiRouteV1 = {
  v: 1;
  credsKey: string;
  shell: "packages" | "content";
  tab: "live" | "movies" | "series";
  packageId: string | null;
  selectedPillId: string;
  vodMovieUiPhase: "list" | "detail";
  vodStreamId: number | null;
  seriesUiPhase: "list" | "detail";
  seriesStreamId: number | null;
  mainScrollY: number;
  /** `#dynamic-list` (fiche VOD plein écran et listes) — distinct de `elMain`. */
  catalogListScrollY: number;
  /** Pays du header (même logique que les listes VOD / bouquets). */
  adminCountryId?: string | null;
};

type OpenAdminPackageRestore = {
  selectedPillId?: string | null;
  vodMovieUiPhase?: "list" | "detail";
  vodStreamId?: number | null;
  seriesUiPhase?: "list" | "detail";
  seriesStreamId?: number | null;
  skipResetScroll?: boolean;
};

let persistVeloraUiRouteTimer = 0;

/** Aligné sur `state` quand il existe (évite écarts URL formulaire vs `state.base` après reload). */
function routePersistenceCredsKey(): string {
  if (state) {
    return `${state.mode}\u0000${state.base}\u0000${state.username}\u0000${state.password}`;
  }
  if (envAutoConnectConfigured()) return nodecastSnapshotCredsKey();
  return "";
}

function routeMatchesPersistedCreds(r: VeloraUiRouteV1): boolean {
  const now = routePersistenceCredsKey();
  if (r.credsKey === now) return true;
  if (envAutoConnectConfigured() && r.credsKey === nodecastSnapshotCredsKey()) return true;
  return false;
}

function findStreamInPackageByStreamId(packageId: string, streamId: number): LiveStream | null {
  if (!state) return null;
  const base = streamsDisplayedForOpenPackage(packageId);
  const inPackage = base.find((s) => s.stream_id === streamId);
  if (inPackage) return inPackage;
  const pool =
    uiTab === "series" ? state.seriesStreamsByCat : state.vodStreamsByCat;
  for (const list of pool.values()) {
    const s = list.find((x) => x.stream_id === streamId);
    if (s) return s;
  }
  return null;
}

function persistVeloraUiRoute(): void {
  if (!state) return;
  try {
    const credsKey = routePersistenceCredsKey();
    if (!credsKey) return;
    const payload: VeloraUiRouteV1 = {
      v: 1,
      credsKey,
      shell: uiShell,
      tab: uiTab,
      packageId: uiAdminPackageId,
      selectedPillId,
      vodMovieUiPhase,
      vodStreamId: vodDetailStream?.stream_id ?? null,
      seriesUiPhase,
      seriesStreamId: seriesDetailStream?.stream_id ?? null,
      mainScrollY: Math.round(elMain.scrollTop),
      catalogListScrollY: Math.round(elDynamicList.scrollTop),
      adminCountryId: selectedAdminCountryId,
    };
    sessionStorage.setItem(VELORA_UI_ROUTE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function schedulePersistVeloraUiRoute(): void {
  if (!state) return;
  window.clearTimeout(persistVeloraUiRouteTimer);
  persistVeloraUiRouteTimer = window.setTimeout(() => {
    persistVeloraUiRouteTimer = 0;
    persistVeloraUiRoute();
  }, 160);
}

function clearVeloraUiRouteStorage(): void {
  try {
    sessionStorage.removeItem(VELORA_UI_ROUTE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

async function tryApplyVeloraUiRouteAfterSessionReady(opts?: {
  /** When true (env autoconnect first load), never restore Films/Series tab (live-only first paint). */
  skipMediaTabRestore?: boolean;
}): Promise<boolean> {
  if (!state) {
    veloraRouteDebug("skip restore: no state");
    return false;
  }
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(VELORA_UI_ROUTE_STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) {
    veloraRouteDebug("skip restore: nothing in sessionStorage", { key: VELORA_UI_ROUTE_STORAGE_KEY });
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearVeloraUiRouteStorage();
    veloraRouteDebug("cleared restore: JSON parse error");
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as Partial<VeloraUiRouteV1>).v !== 1) {
    clearVeloraUiRouteStorage();
    veloraRouteDebug("cleared restore: bad payload shape");
    return false;
  }
  const r = parsed as VeloraUiRouteV1;
  if (!routeMatchesPersistedCreds(r)) {
    clearVeloraUiRouteStorage();
    veloraRouteDebug("cleared restore: creds mismatch", {
      storedLen: r.credsKey?.length,
      now: routePersistenceCredsKey().slice(0, 80),
      legacyMatch: envAutoConnectConfigured() ? r.credsKey === nodecastSnapshotCredsKey() : false,
    });
    return false;
  }
  const tabFromRoute: UiTab =
    r.tab === "live" || r.tab === "movies" || r.tab === "series" ? r.tab : "live";
  const tab: UiTab =
    opts?.skipMediaTabRestore && (tabFromRoute === "movies" || tabFromRoute === "series")
      ? "live"
      : tabFromRoute;
  if (
    isVeloraCatalogCacheDebugEnabled() &&
    opts?.skipMediaTabRestore &&
    tab !== tabFromRoute
  ) {
    console.info("[Velora catalog]", "Skipped VOD/series first-load (route restore)", {
      wasTab: tabFromRoute,
    });
  }
  const scrollY = Number.isFinite(r.mainScrollY) ? Math.max(0, Math.round(r.mainScrollY)) : 0;
  const listScrollY = Number.isFinite(r.catalogListScrollY)
    ? Math.max(0, Math.round(r.catalogListScrollY))
    : 0;

  const bumpScroll = () => {
    elMain.scrollTop = scrollY;
    elDynamicList.scrollTop = listScrollY;
  };

  if (r.shell === "packages") {
    if (tab === "movies" || tab === "series") {
      await openNodecastMediaShellAsync(tab);
      if (!state) return false;
      if (uiShell !== "packages") return false;
      requestAnimationFrame(() => {
        bumpScroll();
        requestAnimationFrame(bumpScroll);
      });
      schedulePersistVeloraUiRoute();
      return true;
    }
    uiTab = "live";
    showPackagesShell();
    requestAnimationFrame(() => {
      bumpScroll();
      requestAnimationFrame(bumpScroll);
    });
    schedulePersistVeloraUiRoute();
    return true;
  }

  if (r.shell !== "content" || !r.packageId) {
    clearVeloraUiRouteStorage();
    veloraRouteDebug("cleared restore: not content shell or missing packageId", {
      shell: r.shell,
      packageId: r.packageId,
    });
    return false;
  }

  const ac = r.adminCountryId?.trim();
  if (ac && state) {
    const countries = countryRowsForSelect();
    const resolved = resolveCountryIdToValidGlobalId(ac, countries);
    if (resolved) {
      selectedAdminCountryId = resolved;
      if ([...elCountrySelect.options].some((o) => o.value === resolved)) {
        elCountrySelect.value = resolved;
      }
      try {
        sessionStorage.setItem(COUNTRY_STORAGE_KEY, resolved);
      } catch {
        /* ignore */
      }
    }
  }

  /* `findPackageById` uses `providerLayoutForUiTab()` → depends on `uiTab` (live vs films vs séries). */
  uiTab = tab;
  if (!findPackageById(r.packageId)) {
    clearVeloraUiRouteStorage();
    veloraRouteDebug("cleared restore: package not found for tab", { packageId: r.packageId, tab });
    return false;
  }
  if (
    state.mode === "nodecast" &&
    ((tab === "movies" && r.vodStreamId != null && r.vodMovieUiPhase !== "list") ||
      (tab === "series" && r.seriesStreamId != null && r.seriesUiPhase !== "list"))
  ) {
    await ensureNodecastVodOrSeriesCatalogReady(tab);
    if (!state) return false;
  }
  openAdminPackage(r.packageId, {
    selectedPillId: r.selectedPillId,
    vodMovieUiPhase: r.vodMovieUiPhase,
    vodStreamId: r.vodStreamId,
    seriesUiPhase: r.seriesUiPhase,
    seriesStreamId: r.seriesStreamId,
    skipResetScroll: true,
  });
  requestAnimationFrame(() => {
    bumpScroll();
    requestAnimationFrame(bumpScroll);
  });
  schedulePersistVeloraUiRoute();
  veloraRouteDebug("restore ok: content package", {
    packageId: r.packageId,
    tab,
    pill: r.selectedPillId,
  });
  return true;
}

type NodecastSnapshotStateJson = {
  mode: "nodecast";
  base: string;
  username: string;
  password: string;
  nodecastAuthHeaders?: Record<string, string>;
  serverInfo: ServerInfo;
  liveCategories?: LiveCategory[];
  streamsByCatAll: [string, LiveStream[]][];
  liveLoadedCategoryIds?: string[];
  nodecastXtreamSourceId?: string;
  vodCategories: LiveCategory[];
  vodStreamsByCat: [string, LiveStream[]][];
  vodLoadedCategoryIds?: string[];
  seriesCategories: LiveCategory[];
  seriesStreamsByCat: [string, LiveStream[]][];
  seriesLoadedCategoryIds?: string[];
  vodCatalogLoaded: boolean;
  seriesCatalogLoaded: boolean;
};

type VeloraNodecastSnapshotV1 = {
  v: 1;
  credsKey: string;
  state: NodecastSnapshotStateJson;
  adminConfig: AdminConfig;
  vodAdminConfig: AdminConfig;
  seriesAdminConfig: AdminConfig;
};

function nodecastSnapshotCredsKey(): string {
  const base = normalizeServerInput(elServer.value);
  const username = elUser.value.trim();
  const password = elPass.value;
  return `${base}\u0000${username}\u0000${password}`;
}

function clearVeloraNodecastSnapshot(): void {
  try {
    sessionStorage.removeItem(NODECAST_SNAPSHOT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function persistVeloraNodecastSnapshot(): void {
  if (!envAutoConnectConfigured() || !state || state.mode !== "nodecast") return;
  try {
    const snap: VeloraNodecastSnapshotV1 = {
      v: 1,
      credsKey: nodecastSnapshotCredsKey(),
      state: {
        mode: "nodecast",
        base: state.base,
        username: state.username,
        password: state.password,
        nodecastAuthHeaders: state.nodecastAuthHeaders,
        serverInfo: state.serverInfo,
        liveCategories: state.liveCategories,
        streamsByCatAll: [...state.streamsByCatAll.entries()],
        liveLoadedCategoryIds: [...state.liveLoadedCategoryIds],
        nodecastXtreamSourceId: state.nodecastXtreamSourceId,
        vodCategories: state.vodCategories,
        vodStreamsByCat: [...state.vodStreamsByCat.entries()],
        vodLoadedCategoryIds: [...state.vodLoadedCategoryIds],
        seriesCategories: state.seriesCategories,
        seriesStreamsByCat: [...state.seriesStreamsByCat.entries()],
        seriesLoadedCategoryIds: [...state.seriesLoadedCategoryIds],
        vodCatalogLoaded: state.vodCatalogLoaded,
        seriesCatalogLoaded: state.seriesCatalogLoaded,
      },
      adminConfig,
      vodAdminConfig,
      seriesAdminConfig,
    };
    sessionStorage.setItem(NODECAST_SNAPSHOT_STORAGE_KEY, JSON.stringify(snap));
  } catch {
    clearVeloraNodecastSnapshot();
  }
}

function deserializeNodecastSnapshotState(p: NodecastSnapshotStateJson): NonNullable<typeof state> {
  return {
    mode: "nodecast",
    base: p.base,
    username: p.username,
    password: p.password,
    nodecastAuthHeaders: p.nodecastAuthHeaders,
    serverInfo: p.serverInfo,
    liveCategories: p.liveCategories ?? [],
    streamsByCatAll: new Map(p.streamsByCatAll),
    liveLoadedCategoryIds: new Set(p.liveLoadedCategoryIds ?? []),
    nodecastXtreamSourceId: p.nodecastXtreamSourceId,
    vodCategories: p.vodCategories,
    vodStreamsByCat: new Map(p.vodStreamsByCat),
    vodLoadedCategoryIds: new Set(p.vodLoadedCategoryIds ?? []),
    seriesCategories: p.seriesCategories,
    seriesStreamsByCat: new Map(p.seriesStreamsByCat),
    seriesLoadedCategoryIds: new Set(p.seriesLoadedCategoryIds ?? []),
    vodCatalogLoaded: p.vodCatalogLoaded,
    seriesCatalogLoaded: p.seriesCatalogLoaded,
  };
}

async function tryRestoreVeloraNodecastSnapshot(): Promise<boolean> {
  if (!envAutoConnectConfigured() || !isNavigationReload()) return false;
  applyNodecastEnvDefaults();
  const credsKey = nodecastSnapshotCredsKey();
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(NODECAST_SNAPSHOT_STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Partial<VeloraNodecastSnapshotV1>).v !== 1 ||
    (parsed as Partial<VeloraNodecastSnapshotV1>).credsKey !== credsKey
  ) {
    return false;
  }
  const snap = parsed as VeloraNodecastSnapshotV1;
  if (!snap.state || snap.state.mode !== "nodecast") return false;

  elBtnConnect.disabled = true;
  try {
    setCatalogLoadingVisible(true, "Restauration de la session…", "live");
    state = deserializeNodecastSnapshotState(snap.state);
    adminConfig = snap.adminConfig;
    vodAdminConfig = buildProviderAdminConfig(state.vodCategories, state.vodStreamsByCat);
    seriesAdminConfig = buildProviderAdminConfig(state.seriesCategories, state.seriesStreamsByCat);

    await fetchAndApplyCanonicalCountries();
    await fetchAndApplyChannelNamePrefixes();
    await fetchAndApplyChannelHideNeedles();
    await refreshSupabaseHierarchy();

    selectedPillId = "all";
    activeStreamId = null;
    destroyPlayer();
    destroyVodPlayer();
    elNowPlaying.textContent = "";

    const routeOk = await tryApplyVeloraUiRouteAfterSessionReady();
    if (!routeOk) goLiveHome();
    elLoginPanel.classList.add("hidden");
    elMain.classList.remove("hidden");
    ensureVeloraHistoryRootMarker();
    syncAdminSettingsButton();
    setLoginStatus("");
    persistVeloraUiRoute();
  } catch {
    clearVeloraNodecastSnapshot();
    state = null;
    adminConfig = { ...EMPTY_ADMIN_CONFIG };
    vodAdminConfig = { ...EMPTY_ADMIN_CONFIG };
    seriesAdminConfig = { ...EMPTY_ADMIN_CONFIG };
    return false;
  } finally {
    setCatalogLoadingVisible(false);
    elBtnConnect.disabled = false;
  }
  return true;
}

async function bootEnvAutoconnect(): Promise<void> {
  applyNodecastEnvDefaults();
  if (isNavigationReload()) {
    const restored = await tryRestoreVeloraNodecastSnapshot();
    if (restored) return;
  }
  await connect({ skipMediaRouteRestore: true });
}

let hls: Hls | null = null;
let hlsVod: Hls | null = null;
let primaryPlaybackKeepAliveCleanup: (() => void) | null = null;
let nodecastStatusPollingCleanup: (() => void) | null = null;
let liveStartupUiCleanup: (() => void) | null = null;
let liveSilentAudioMonitorCleanup: (() => void) | null = null;
let liveAudioContext: AudioContext | null = null;
let liveAudioSource: MediaElementAudioSourceNode | null = null;
let liveAudioAnalyser: AnalyserNode | null = null;
let mediaPlaybackRequestId = 0;
let livePlaybackSessionId = 0;
const NODECAST_STATUS_POLL_MS = 3000;
const NODECAST_STATUS_STARTUP_DELAY_MS = 8000;

/** Match Nodecast transcode (HLS): VLC-style UA in `xhrSetup` (proxy may also set upstream UA). */
const NODECAST_HLS_USER_AGENT = "VLC/3.0.18 LibVLC/3.0.18";

/** hls.js VOD tuned to stay ahead and avoid the “few seconds loaded” wall. */
const HLS_VOD_CONFIG_BASE = {
  enableSoftwareAES: true,
  testBandwidth: false,
  autoStartLoad: true,
  startPosition: 0,
  startFragPrefetch: true,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  backBufferLength: 30,
  maxBufferHole: 0.5,
  maxLoadingDelay: 4,
  manifestLoadingMaxRetry: 8,
  manifestLoadingRetryDelay: 500,
  levelLoadingMaxRetry: 10,
  fragLoadingMaxRetry: 8,
  fragLoadingRetryDelay: 500,
  fragLoadingMaxRetryTimeout: 8000,
  enableWorker: true,
  initialLiveManifestSize: 1,
  liveDurationInfinity: false,
  lowLatencyMode: false,
} as const;

const VOD_STALL_RETRY_DELAY_MS = 2200;
const VOD_WATCHDOG_TICK_MS = 1000;
const VOD_WATCHDOG_STALL_MS = 6500;
const VOD_REMOUNT_MIN_GAP_MS = 2000;
const VOD_REMOUNT_MAX_ATTEMPTS = 8;
const VOD_MIN_AHEAD_SECONDS = 3;
const STARTUP_MIN_BUFFER_SECONDS = 6;
const STARTUP_BUFFER_WAIT_TIMEOUT_MS = 12_000;
const VOD_BUFFER_STALL_WAKE_MS = 3200;
const VOD_BUFFER_STALL_EDGE_SECONDS = 0.9;
const VOD_NUDGE_COOLDOWN_MS = 5000;
const HLS_WARMUP_PREFERRED_SECONDS = 25;
const HLS_WARMUP_FALLBACK_SECONDS = 12;
const HLS_WARMUP_MIN_SEGMENTS = 4;
const HLS_WARMUP_FALLBACK_AFTER_MS = 20_000;
const HLS_WARMUP_MAX_WAIT_MS = 25_000;
const HLS_WARMUP_POLL_MS = 750;

let vodPlaybackHelpersCleanup: (() => void) | null = null;
let vodStallRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastVodProxiedUrl: string | null = null;
let lastVodUpstreamAuth: Record<string, string> | undefined;
let vodRemountAttempts = 0;
let vodLastRemountTs = 0;
let vodPlaybackSessionId = 0;
let liveManualFullscreenActive = false;
let currentTranscodeSessionId: string | null = null;
let currentVodSourceUrl: string | null = null;
let currentVodStartAt = 0;
let currentVodDurationSeconds: number | null = null;
let currentVodSeekable = false;
let currentVodVideoMode: string | undefined;
let currentVodVideoCodec: string | undefined;
let currentVodAudioCodec: string | undefined;
let currentVodAudioChannels: number | undefined;
let vodSeekInFlight = false;
let isVodTranscode = false;
let vodManualFullscreenActive = false;
let isVodTranscodeSeeking = false;
let suppressNativeSeekingHandler = false;
let isVodSeekDragging = false;
let lastVodUiLogSecond = -1;
let optimisticVodTimeSeconds: number | null = null;

function startVodFakeLoadingOverlay(status = "Préparation de la lecture…"): void {
  void status;
  setVodPlayerBufferingVisible(true);
}

function stopVodFakeLoadingOverlay(): void {
  setVodPlayerBufferingVisible(false);
}

function formatDurationHms(secondsRaw: number): string {
  const seconds = Math.max(0, Math.floor(secondsRaw));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${String(h).padStart(2, "0")}:${mm}:${ss}`;
  return `00:${mm}:${ss}`;
}

const VOD_CONTROL_ICONS = {
  play:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12l10-6z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="4" height="12" rx="1.1" fill="currentColor"/><rect x="13" y="6" width="4" height="12" rx="1.1" fill="currentColor"/></svg>',
  volume:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4z" fill="currentColor"/><path d="M16.5 8.2a1 1 0 0 1 1.4 0A6 6 0 0 1 19.5 12a6 6 0 0 1-1.6 3.8 1 1 0 1 1-1.5-1.3A4 4 0 0 0 17.5 12a4 4 0 0 0-1.1-2.5 1 1 0 0 1 .1-1.3z" fill="currentColor"/></svg>',
  muted:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4z" fill="currentColor"/><path d="M16 9l5 5M21 9l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  fullscreen:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v4m14-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m13-5v4a1 1 0 0 1-1 1h-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  fullscreenExit:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9H4m0 0V4m0 5l6-6m5 6h5m0 0V4m0 5l-6-6M9 15H4m0 0v5m0-5l6 6m5-6h5m0 0v5m0-5l-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
} as const;

function setVodControlIcon(button: HTMLButtonElement | null, svgMarkup: string, ariaLabel: string): void {
  if (!button) return;
  button.innerHTML = `<span class="vod-ctl-icon">${svgMarkup}</span>`;
  button.setAttribute("aria-label", ariaLabel);
  button.title = ariaLabel;
}

function setLiveControlIcon(button: HTMLButtonElement | null, svgMarkup: string, ariaLabel: string): void {
  if (!button) return;
  button.innerHTML = `<span class="live-ctl-icon">${svgMarkup}</span>`;
  button.setAttribute("aria-label", ariaLabel);
  button.title = ariaLabel;
}

function setLiveControlsVisible(visible: boolean): void {
  if (!elLiveControlsOverlay) return;
  elLiveControlsOverlay.classList.toggle("hidden", !visible);
  elLiveControlsOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
}

function lockLiveLandscapeOrientation(): void {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (orientation: "landscape") => Promise<void>;
  };
  if (!orientation || typeof orientation.lock !== "function") return;
  void orientation.lock("landscape").catch(() => {});
}

function unlockLiveLandscapeOrientation(): void {
  const orientation = screen.orientation as ScreenOrientation & {
    unlock?: () => void;
  };
  if (!orientation || typeof orientation.unlock !== "function") return;
  try {
    orientation.unlock();
  } catch {
    /* ignore unsupported orientation unlock */
  }
}

function clearLiveManualFullscreen(): void {
  liveManualFullscreenActive = false;
  elPlayerContainer.classList.remove("player-container--live-fullscreen");
  document.body.classList.remove("vel-live-fullscreen-active");
  unlockLiveLandscapeOrientation();
}

function isLiveFullscreenActive(): boolean {
  return Boolean(
    (document.fullscreenElement && document.fullscreenElement === elPlayerContainer) ||
      liveManualFullscreenActive
  );
}

function syncLiveControlState(): void {
  setLiveControlIcon(
    elLiveCtlPlay,
    elVideo.paused ? VOD_CONTROL_ICONS.play : VOD_CONTROL_ICONS.pause,
    elVideo.paused ? "Play" : "Pause"
  );
  setLiveControlIcon(
    elLiveCtlMute,
    elVideo.muted ? VOD_CONTROL_ICONS.muted : VOD_CONTROL_ICONS.volume,
    elVideo.muted ? "Unmute" : "Mute"
  );
  setLiveControlIcon(
    elLiveCtlFullscreen,
    isLiveFullscreenActive() ? VOD_CONTROL_ICONS.fullscreenExit : VOD_CONTROL_ICONS.fullscreen,
    isLiveFullscreenActive() ? "Exit fullscreen" : "Fullscreen landscape"
  );
}

function onLiveFullscreenChange(): void {
  const inFullscreen = isLiveFullscreenActive();
  const wasLiveFullscreen =
    liveManualFullscreenActive ||
    elPlayerContainer.classList.contains("player-container--live-fullscreen") ||
    document.body.classList.contains("vel-live-fullscreen-active");
  elPlayerContainer.classList.toggle("player-container--live-fullscreen", inFullscreen);
  document.body.classList.toggle("vel-live-fullscreen-active", inFullscreen);
  if (inFullscreen) lockLiveLandscapeOrientation();
  else if (wasLiveFullscreen) clearLiveManualFullscreen();
  syncLiveControlState();
}

async function toggleLiveFullscreen(): Promise<void> {
  if (!isLiveFullscreenActive()) {
    liveManualFullscreenActive = false;
    try {
      await elPlayerContainer.requestFullscreen?.();
    } catch {
      liveManualFullscreenActive = true;
    }
    if (!document.fullscreenElement && !liveManualFullscreenActive) {
      liveManualFullscreenActive = true;
    }
    lockLiveLandscapeOrientation();
    onLiveFullscreenChange();
    return;
  }
  if (document.fullscreenElement === elPlayerContainer) {
    await document.exitFullscreen?.().catch(() => {});
  }
  clearLiveManualFullscreen();
  onLiveFullscreenChange();
}

function setupLiveControls(): void {
  const onCtlPlay = (): void => {
    if (elVideo.paused) {
      if (isTrialBlocked()) {
        showTrialExpiredModal();
        return;
      }
      void elVideo.play().catch(() => {});
    } else {
      elVideo.pause();
    }
    syncLiveControlState();
  };
  const onCtlMute = (): void => {
    elVideo.muted = !elVideo.muted;
    syncLiveControlState();
  };
  const onCtlFullscreen = (): void => {
    void toggleLiveFullscreen();
  };
  const stopLiveControlClick = (event: Event): void => {
    event.stopPropagation();
  };
  elLiveCtlPlay?.addEventListener("click", onCtlPlay);
  elLiveCtlMute?.addEventListener("click", onCtlMute);
  elLiveCtlFullscreen?.addEventListener("click", onCtlFullscreen);
  elLiveControlsOverlay?.addEventListener("click", stopLiveControlClick);
  elVideo.addEventListener("play", syncLiveControlState);
  elVideo.addEventListener("pause", syncLiveControlState);
  elVideo.addEventListener("volumechange", syncLiveControlState);
  document.addEventListener("fullscreenchange", onLiveFullscreenChange);
  syncLiveControlState();
}

function setVodSeekVisualPercent(percentRaw: number): void {
  if (!elVodCtlSeekFill || !elVodCtlSeekHandle || !elVodCtlSeekTrack) return;
  const percent = Math.max(0, Math.min(1, percentRaw));
  const percentLabel = `${(percent * 100).toFixed(3)}%`;
  elVodCtlSeekFill.style.width = percentLabel;
  elVodCtlSeekHandle.style.left = percentLabel;
  elVodCtlSeekTrack.setAttribute("aria-valuenow", String(Math.round(percent * 100)));
}

function lockDownVodNativeUi(video: HTMLVideoElement): void {
  video.controls = false;
  video.removeAttribute("controls");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("x5-playsinline", "true");
  video.setAttribute("x5-video-player-type", "h5-page");
  video.setAttribute("x5-video-player-fullscreen", "false");
  video.setAttribute("x5-video-orientation", "landscape");
  video.setAttribute("controlslist", "nofullscreen nodownload noremoteplayback noplaybackrate");
  video.setAttribute("disablepictureinpicture", "");
  try {
    video.disablePictureInPicture = true;
  } catch {
    /* ignore unsupported PiP flag */
  }
  try {
    video.disableRemotePlayback = true;
  } catch {
    /* ignore unsupported remote playback flag */
  }
}

function configureLiveNativeUi(video: HTMLVideoElement): void {
  video.controls = false;
  video.removeAttribute("controls");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("x5-playsinline", "true");
  video.setAttribute("x5-video-player-type", "h5-page");
  video.setAttribute("x5-video-player-fullscreen", "false");
  video.setAttribute("x5-video-orientation", "landscape");
  video.setAttribute("controlslist", "nofullscreen nodownload noplaybackrate noremoteplayback");
  video.setAttribute("disablepictureinpicture", "");
  video.setAttribute("disableremoteplayback", "");
  try {
    video.disablePictureInPicture = true;
  } catch {
    /* ignore unsupported PiP flag */
  }
  try {
    video.disableRemotePlayback = true;
  } catch {
    /* ignore unsupported remote playback flag */
  }
}

function resetVodTranscodeState(): void {
  currentTranscodeSessionId = null;
  currentVodSourceUrl = null;
  currentVodStartAt = 0;
  currentVodDurationSeconds = null;
  currentVodSeekable = false;
  currentVodVideoMode = undefined;
  currentVodVideoCodec = undefined;
  currentVodAudioCodec = undefined;
  currentVodAudioChannels = undefined;
  isVodTranscode = false;
  vodSeekInFlight = false;
  optimisticVodTimeSeconds = null;
  setVodSeekVisualPercent(0);
}

function applyVodTranscodeSessionMeta(meta: NodecastTranscodeSessionMeta | null): void {
  if (!meta) {
    resetVodTranscodeState();
    return;
  }
  currentTranscodeSessionId = meta.sessionId;
  currentVodSourceUrl = meta.sourceUrl;
  currentVodStartAt = Number.isFinite(meta.startAt) ? Math.max(0, meta.startAt) : 0;
  currentVodDurationSeconds =
    typeof meta.durationSeconds === "number" && Number.isFinite(meta.durationSeconds)
      ? Math.max(0, meta.durationSeconds)
      : null;
  currentVodSeekable = Boolean(meta.seekable);
  currentVodVideoMode = meta.videoMode;
  currentVodVideoCodec = meta.videoCodec;
  currentVodAudioCodec = meta.audioCodec;
  currentVodAudioChannels = meta.audioChannels;
}

function getRealVodCurrentTime(video: HTMLVideoElement): number {
  const t = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
  return Math.max(0, currentVodStartAt + t);
}

function getRealVodDuration(video: HTMLVideoElement): number {
  if (typeof currentVodDurationSeconds === "number" && Number.isFinite(currentVodDurationSeconds)) {
    return Math.max(0, currentVodDurationSeconds);
  }
  return Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
}

function updateVodProgressUi(video: HTMLVideoElement): void {
  const realDuration = getRealVodDuration(video);
  if (!(realDuration > 0)) return;
  const baseCurrent = getRealVodCurrentTime(video);
  const displayCurrent =
    optimisticVodTimeSeconds != null ? optimisticVodTimeSeconds : baseCurrent;
  if (elVodCtlCurrent && elVodCtlDuration) {
    elVodCtlCurrent.textContent = formatDurationHms(displayCurrent);
    elVodCtlDuration.textContent = formatDurationHms(realDuration);
    if (!isVodSeekDragging) {
      const pct = Math.min(1, Math.max(0, displayCurrent / realDuration));
      setVodSeekVisualPercent(pct);
    }
  }
  const nowSecond = Math.floor(displayCurrent);
  if (nowSecond !== lastVodUiLogSecond) {
    lastVodUiLogSecond = nowSecond;
    console.log("[VOD UI] currentVodStartAt", currentVodStartAt);
    console.log("[VOD UI] video.currentTime", Number.isFinite(video.currentTime) ? video.currentTime : 0);
    console.log("[VOD UI] realCurrentTime", displayCurrent);
    console.log("[VOD UI] duration", currentVodDurationSeconds);
  }
}

function isVodNodecastTranscodeSession(): boolean {
  return Boolean(currentTranscodeSessionId && currentVodSourceUrl);
}

function syncVodControlVisibility(video: HTMLVideoElement): void {
  isVodTranscode = isVodNodecastTranscodeSession();
  lockDownVodNativeUi(video);
  if (elVodControlsOverlay) {
    elVodControlsOverlay.classList.remove("hidden");
    elVodControlsOverlay.setAttribute("aria-hidden", "false");
  }
}

function lockVodLandscapeOrientation(): void {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (orientation: "landscape") => Promise<void>;
  };
  if (!orientation || typeof orientation.lock !== "function") return;
  void orientation.lock("landscape").catch(() => {});
}

function unlockVodLandscapeOrientation(): void {
  const orientation = screen.orientation as ScreenOrientation & {
    unlock?: () => void;
  };
  if (!orientation || typeof orientation.unlock !== "function") return;
  try {
    orientation.unlock();
  } catch {
    /* ignore unsupported orientation unlock */
  }
}

function clearVodManualFullscreen(): void {
  vodManualFullscreenActive = false;
  elVodPlayerContainer?.classList.remove("player-container--fullscreen");
  document.body.classList.remove("vel-vod-fullscreen-active");
  unlockVodLandscapeOrientation();
}

function teardownVodPlaybackHelpers(): void {
  vodPlaybackHelpersCleanup?.();
  vodPlaybackHelpersCleanup = null;
  if (vodStallRetryTimer != null) {
    clearTimeout(vodStallRetryTimer);
    vodStallRetryTimer = null;
  }
}

function prepareLiveAudioForPlayback(video: HTMLVideoElement): void {
  video.muted = false;
  if (!Number.isFinite(video.volume) || video.volume <= 0) {
    video.volume = 1;
  }
}

function ensureHlsAudioTrack(instance: Hls): void {
  const tracks = instance.audioTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  if (instance.audioTrack >= 0) return;
  const defaultIndex = tracks.findIndex((track) => track.default);
  instance.audioTrack = defaultIndex >= 0 ? defaultIndex : 0;
}

function audioCodecLikelyUnsupportedInBrowser(codec: string | undefined): boolean {
  const c = (codec ?? "").toLowerCase();
  if (!c) return false;
  return /\b(ac-?3|ec-?3|eac3|dts|dca|truehd|mlp|opus|mp2)\b/.test(c);
}

function hlsHasLikelyUnsupportedAudio(instance: Hls): boolean {
  const audioTracks = instance.audioTracks ?? [];
  if (
    audioTracks.some(
      (track) =>
        audioCodecLikelyUnsupportedInBrowser(track.audioCodec) ||
        (track.unknownCodecs ?? []).some((codec) => audioCodecLikelyUnsupportedInBrowser(codec))
    )
  ) {
    return true;
  }
  const levels = instance.levels ?? [];
  return levels.some((level) => audioCodecLikelyUnsupportedInBrowser(level.audioCodec));
}

function liveProbeSuggestsTranscode(probe: {
  audio?: string;
  needsTranscode?: boolean;
  compatible?: boolean;
  container?: string;
} | null): boolean {
  if (!probe) return false;
  if (probe.needsTranscode === true) return true;
  if (probe.compatible === false) return true;
  if (probe.container?.toLowerCase() === "mpegts" && audioCodecLikelyUnsupportedInBrowser(probe.audio)) {
    return true;
  }
  return audioCodecLikelyUnsupportedInBrowser(probe.audio);
}

function liveTranscodeStorageKey(url: string, label: string, stableKey?: string): string {
  if (stableKey?.trim()) {
    return `${LIVE_TRANSCODE_NEEDED_LS_PREFIX}:${stableKey.trim().toLowerCase()}`;
  }
  let id = "";
  try {
    const u = new URL(url);
    const streamPathMatch =
      u.pathname.match(/\/stream\/(\d+)\/live/i) ||
      u.pathname.match(/\/live\/(?:[^/]+\/){2}(\d+)(?:\.[a-z0-9]+)?$/i) ||
      u.pathname.match(/\/(\d+)\.m3u8$/i);
    if (streamPathMatch?.[1]) {
      id = `${u.hostname.toLowerCase()}::${streamPathMatch[1]}`;
    }
  } catch {
    /* fall back to label */
  }
  if (!id) {
    id = label.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  }
  return `${LIVE_TRANSCODE_NEEDED_LS_PREFIX}:${id}`;
}

function liveSourceNeedsTranscode(url: string, label: string, stableKey?: string): boolean {
  try {
    if (window.localStorage.getItem(liveTranscodeStorageKey(url, label, stableKey)) === "1") {
      return true;
    }
    if (stableKey?.trim() && window.localStorage.getItem(liveTranscodeStorageKey(url, label)) === "1") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function rememberLiveSourceNeedsTranscode(url: string, label: string, stableKey?: string): void {
  try {
    window.localStorage.setItem(liveTranscodeStorageKey(url, label, stableKey), "1");
    if (stableKey?.trim()) {
      window.localStorage.setItem(liveTranscodeStorageKey(url, label), "1");
    }
  } catch {
    /* ignore storage errors */
  }
}

function ensureLiveAudioAnalyser(video: HTMLVideoElement): AnalyserNode | null {
  try {
    if (!liveAudioContext) {
      const AudioCtx =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      liveAudioContext = new AudioCtx();
    }
    if (!liveAudioSource) {
      liveAudioSource = liveAudioContext.createMediaElementSource(video);
      liveAudioAnalyser = liveAudioContext.createAnalyser();
      liveAudioAnalyser.fftSize = 2048;
      liveAudioSource.connect(liveAudioAnalyser);
      liveAudioAnalyser.connect(liveAudioContext.destination);
    }
    return liveAudioAnalyser;
  } catch {
    return null;
  }
}

function liveAudioRms(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) {
    const centered = (v - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / data.length);
}

function scheduleLiveSilentAudioFallback(
  sessionId: number,
  tryFallback: (reason: string) => void
): void {
  liveSilentAudioMonitorCleanup?.();
  let cancelled = false;
  const startTimer = window.setTimeout(() => {
    void (async () => {
      if (cancelled || sessionId !== livePlaybackSessionId) return;
      if (elVideo.paused || elVideo.muted || elVideo.volume <= 0) return;
      if (!(elVideo.currentTime > 2) || elVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const analyser = ensureLiveAudioAnalyser(elVideo);
      const ctx = liveAudioContext;
      if (!analyser || !ctx) return;
      try {
        if (ctx.state === "suspended") await ctx.resume();
      } catch {
        return;
      }
      if (ctx.state !== "running") return;
      let total = 0;
      let peak = 0;
      const samples = 18;
      for (let i = 0; i < samples; i++) {
        if (cancelled || sessionId !== livePlaybackSessionId) return;
        if (elVideo.paused || elVideo.muted || elVideo.volume <= 0) return;
        const rms = liveAudioRms(analyser);
        total += rms;
        peak = Math.max(peak, rms);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      const avg = total / samples;
      if (avg < 0.0018 && peak < 0.004) {
        tryFallback("silent audio output detected");
      }
    })();
  }, 6500);
  liveSilentAudioMonitorCleanup = () => {
    cancelled = true;
    window.clearTimeout(startTimer);
  };
}

function stopCurrentVodTranscodeSession(): void {
  const sessionId = currentTranscodeSessionId;
  const base = state?.base;
  if (!sessionId || !base) return;
  const delUrl = `${base.replace(/\/+$/, "")}/api/transcode/${encodeURIComponent(sessionId)}`;
  void fetch(proxiedUrl(delUrl), {
    method: "DELETE",
    headers: state?.nodecastAuthHeaders,
  }).catch(() => {});
}

/** Start playback with sound after user gesture ; muted fallback only if autoplay refuses unmuted playback. */
function playVodAggressive(video: HTMLVideoElement): void {
  prepareVodAudioForPlayback(video);
  void video.play().catch(() => {
    const prevMuted = video.muted;
    const prevVol = video.volume;
    video.muted = true;
    void video.play().catch(() => {
      video.muted = prevMuted;
      video.volume = prevVol;
    });
  });
}

async function waitForStartupBuffer(
  video: HTMLVideoElement,
  minAheadSeconds = STARTUP_MIN_BUFFER_SECONDS,
  timeoutMs = STARTUP_BUFFER_WAIT_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (video.buffered && video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        if (end - t >= minAheadSeconds) return;
      }
    } catch {
      /* ignore buffered reads while media attaches */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function parseHlsStartupDepth(playlistBody: string): { segmentCount: number; totalSeconds: number } {
  let segmentCount = 0;
  let totalSeconds = 0;
  for (const raw of playlistBody.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const part = line.slice("#EXTINF:".length).split(",")[0]?.trim() ?? "";
      const sec = Number(part);
      if (Number.isFinite(sec) && sec > 0) totalSeconds += sec;
      continue;
    }
    if (!line.startsWith("#")) segmentCount += 1;
  }
  return { segmentCount, totalSeconds };
}

async function waitForHlsStartupBuffer(url: string): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    let segmentCount = 0;
    let totalSeconds = 0;
    try {
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*" },
      });
      if (res.ok) {
        const text = await res.text();
        const parsed = parseHlsStartupDepth(text);
        segmentCount = parsed.segmentCount;
        totalSeconds = parsed.totalSeconds;
      }
    } catch {
      /* ignore transient warmup fetch failures */
    }
    const waitedMs = Date.now() - startedAt;
    if (
      totalSeconds >= HLS_WARMUP_PREFERRED_SECONDS ||
      segmentCount >= HLS_WARMUP_MIN_SEGMENTS
    ) {
      return;
    }
    if (waitedMs >= HLS_WARMUP_FALLBACK_AFTER_MS && totalSeconds >= HLS_WARMUP_FALLBACK_SECONDS) {
      return;
    }
    if (waitedMs >= HLS_WARMUP_MAX_WAIT_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, HLS_WARMUP_POLL_MS));
  }
}

function vodHlsXhrSetup(
  xhr: XMLHttpRequest,
  _url: string,
  upstreamAuth: Record<string, string> | undefined
): void {
  try {
    xhr.setRequestHeader("User-Agent", NODECAST_HLS_USER_AGENT);
  } catch {
    /* Browsers may forbid setting User-Agent; the proxy still uses VLC upstream. */
  }
  if (!upstreamAuth) return;
  for (const [k, v] of Object.entries(upstreamAuth)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const lk = k.toLowerCase();
    if (lk === "user-agent" || lk === "referer" || lk === "referrer") continue;
    try {
      xhr.setRequestHeader(k, v);
    } catch {
      /* ignore invalid header names */
    }
  }
}

function mountHlsVod(
  proxied: string,
  video: HTMLVideoElement,
  upstreamAuth: Record<string, string> | undefined,
  opts?: { resumeAt?: number; autoPlayOnManifest?: boolean }
): void {
  const sessionId = vodPlaybackSessionId;
  if (hlsVod) {
    try {
      hlsVod.destroy();
    } catch {
      /* ignore */
    }
    hlsVod = null;
  }
  const hlsVodInstance = new Hls({
    ...HLS_VOD_CONFIG_BASE,
    // More stable long playback for Nodecast-style transcode playlists.
    lowLatencyMode: false,
    xhrSetup(xhr, url) {
      vodHlsXhrSetup(xhr, url, upstreamAuth);
    },
  });
  hlsVod = hlsVodInstance;
  hlsVodInstance.loadSource(proxied);
  hlsVodInstance.attachMedia(video);
  try {
    hlsVodInstance.startLoad(-1);
  } catch {
    /* ignore */
  }

  hlsVodInstance.on(Hls.Events.MANIFEST_PARSED, () => {
    if (sessionId !== vodPlaybackSessionId || hlsVod !== hlsVodInstance) return;
    ensureHlsAudioTrack(hlsVodInstance);
    const resumeAt = opts?.resumeAt;
    if (resumeAt != null && Number.isFinite(resumeAt) && resumeAt > 0) {
      try {
        video.currentTime = Math.max(0, resumeAt);
      } catch {
        /* ignore */
      }
    }
    try {
      hlsVodInstance.startLoad(-1);
    } catch {
      /* ignore */
    }
    if (opts?.autoPlayOnManifest !== false) {
      playVodAggressive(video);
    }
  });

  hlsVodInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
    if (sessionId !== vodPlaybackSessionId || hlsVod !== hlsVodInstance) return;
    ensureHlsAudioTrack(hlsVodInstance);
  });

  hlsVodInstance.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
    if (sessionId !== vodPlaybackSessionId || hlsVod !== hlsVodInstance) return;
    if (!data.fatal) return;
    if (data.type === ErrorTypes.MEDIA_ERROR) {
      try {
        hlsVodInstance.recoverMediaError();
        return;
      } catch {
        /* fall through */
      }
    }
    // Force HLS to retry loading segments on transient network errors.
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      try {
        hlsVodInstance.startLoad(-1);
        return;
      } catch {
        /* ignore */
      }
    }
    if (tryRemountVodHls(video)) return;
    setVodPlayerBufferingVisible(false);
    if (elNowPlayingVod) {
      elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
        `Erreur lecture : ${data.type} / ${String(data.details)}`
      );
    }
  });
}

function tryRemountVodHls(video: HTMLVideoElement): boolean {
  if (!hlsVod || !lastVodProxiedUrl || !Hls.isSupported()) return false;
  const now = Date.now();
  if (now - vodLastRemountTs < VOD_REMOUNT_MIN_GAP_MS) return false;
  if (vodRemountAttempts >= VOD_REMOUNT_MAX_ATTEMPTS) return false;
  vodLastRemountTs = now;
  vodRemountAttempts++;
  const resumeAt = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
  mountHlsVod(lastVodProxiedUrl, video, lastVodUpstreamAuth, { resumeAt });
  attachVodPlaybackHelpers(video);
  return true;
}

async function seekVodTranscodeTo(video: HTMLVideoElement, targetSeconds: number): Promise<boolean> {
  const logVodSeekGuard = (reason: string): void => {
    console.log("[VOD SEEK GUARD]", {
      reason,
      isVodTranscode,
      currentVodSourceUrl,
      currentVodSeekable,
      currentVodDurationSeconds,
      currentTranscodeSessionId,
      isVodTranscodeSeeking,
    });
  };
  if (!state) {
    logVodSeekGuard("missing state");
    return false;
  }
  if (!isVodNodecastTranscodeSession()) {
    logVodSeekGuard("not transcode session");
    return false;
  }
  if (!currentVodSourceUrl) {
    logVodSeekGuard("missing currentVodSourceUrl");
    return false;
  }
  if (vodSeekInFlight || isVodTranscodeSeeking) {
    logVodSeekGuard("seek already in flight");
    return false;
  }
  if (!currentVodDurationSeconds || !Number.isFinite(currentVodDurationSeconds)) {
    logVodSeekGuard("missing currentVodDurationSeconds");
    return false;
  }
  const maxTarget = Math.max(0, currentVodDurationSeconds - 2);
  const clamped = Math.max(0, Math.min(targetSeconds, maxTarget));
  console.log("[VOD SEEK CLICK] targetSeconds", clamped);
  console.log("[VOD SEEK] POST startAt", clamped);
  vodSeekInFlight = true;
  isVodTranscodeSeeking = true;
  try {
    try {
      const oldSessionId = currentTranscodeSessionId;
      console.log("[VOD SEEK] oldSessionId", oldSessionId);
      suppressNativeSeekingHandler = true;
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      startVodFakeLoadingOverlay(`Preparing from ${formatDurationHms(clamped)}...`);
      if (hlsVod) {
        try {
          hlsVod.stopLoad();
        } catch {
          /* ignore */
        }
        try {
          hlsVod.detachMedia();
        } catch {
          /* ignore */
        }
        try {
          hlsVod.destroy();
        } catch {
          /* ignore */
        }
        hlsVod = null;
      }
      video.removeAttribute("src");
      video.src = "";
      video.load();

      const session = await createNodecastVodTranscodeSession(
        state.base,
        currentVodSourceUrl,
        state.nodecastAuthHeaders,
        {
          mode: "vod",
          startAt: clamped,
          seekOffset: clamped,
          videoMode: currentVodVideoMode,
          videoCodec: currentVodVideoCodec,
          audioCodec: currentVodAudioCodec,
          audioChannels: currentVodAudioChannels,
        }
      );
      if (!session || !elVideoVod) {
        logVodSeekGuard("session creation failed");
        return false;
      }
      console.log("[VOD SEEK] new sessionId", session.sessionId);
      applyVodTranscodeSessionMeta({
        ...session,
        durationSeconds: session.durationSeconds ?? currentVodDurationSeconds,
      });
      const proxied = proxiedUrl(session.playlistUrl);
      console.log("[VOD SEEK] new playlistUrl", session.playlistUrl);
      lastVodProxiedUrl = proxied;
      prepareVodAudioForPlayback(video);
      mountHlsVod(proxied, video, state.nodecastAuthHeaders, {
        autoPlayOnManifest: true,
      });
      const clearSuppress = (): void => {
        suppressNativeSeekingHandler = false;
        video.removeEventListener("loadedmetadata", clearSuppress);
        video.removeEventListener("canplay", clearSuppress);
      };
      video.addEventListener("loadedmetadata", clearSuppress);
      video.addEventListener("canplay", clearSuppress);
      syncVodControlVisibility(video);
      attachVodPlaybackHelpers(video);
      updateVodProgressUi(video);
      if (oldSessionId && oldSessionId !== currentTranscodeSessionId) {
        const delUrl = `${state.base.replace(/\/+$/, "")}/api/transcode/${encodeURIComponent(oldSessionId)}`;
        void fetch(proxiedUrl(delUrl), {
          method: "DELETE",
          headers: state.nodecastAuthHeaders,
        }).catch(() => {});
      }
      return true;
    } catch (err) {
      console.error("[VOD SEEK] error", err);
      return false;
    }
  } finally {
    vodSeekInFlight = false;
    isVodTranscodeSeeking = false;
    window.setTimeout(() => {
      suppressNativeSeekingHandler = false;
    }, 2500);
  }
}

function attachVodPlaybackHelpers(video: HTMLVideoElement): void {
  teardownVodPlaybackHelpers();
  lockDownVodNativeUi(video);
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastProgressTs = Date.now();
  let lastTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;

  const forceStartLoad = (): void => {
    if (!hlsVod) return;
    try {
      hlsVod.startLoad(-1);
    } catch {
      /* ignore */
    }
  };

  const updateProgressClock = (): void => {
    const now = Date.now();
    const t = getRealVodCurrentTime(video);
    if (t > lastTime + 0.02) {
      lastProgressTs = now;
      lastTime = t;
      return;
    }
    if (video.seeking) return;
    const realDuration = getRealVodDuration(video);
    const d = realDuration > 0 ? realDuration : Number.POSITIVE_INFINITY;
    if (t >= d) return;
    if (now - lastProgressTs >= VOD_WATCHDOG_STALL_MS) {
      setVodPlayerBufferingVisible(true);
      forceStartLoad();
      if (!tryRemountVodHls(video)) {
        forceStartLoad();
      }
      lastProgressTs = now;
    }
  };

  const cancelStallRetry = (): void => {
    if (vodStallRetryTimer != null) {
      clearTimeout(vodStallRetryTimer);
      vodStallRetryTimer = null;
    }
  };

  const scheduleStallRetry = (): void => {
    if (!hlsVod) return;
    cancelStallRetry();
    vodStallRetryTimer = setTimeout(() => {
      vodStallRetryTimer = null;
      if (!hlsVod) return;
      if (video.seeking) return;
      const t = getRealVodCurrentTime(video);
      const realDuration = getRealVodDuration(video);
      const d = realDuration > 0 ? realDuration : Number.POSITIVE_INFINITY;
      if (t >= d) return;
      forceStartLoad();
    }, VOD_STALL_RETRY_DELAY_MS);
  };

  const onWaiting = (): void => {
    setVodPlayerBufferingVisible(true);
    scheduleStallRetry();
  };

  const onStalled = (): void => {
    setVodPlayerBufferingVisible(true);
    scheduleStallRetry();
  };

  const onError = (): void => {
    setVodPlayerBufferingVisible(false);
    cancelStallRetry();
    // Note: do NOT clear optimisticVodTimeSeconds here. Clearing the source
    // during a seek transition (video.src = "" + video.load()) can fire an
    // `error` event mid-transition; clearing the optimistic value would let
    // the progress bar snap back. We only clear on `playing` (success) or
    // when seekVodTranscodeTo itself reports failure.
    updateVodProgressUi(video);
  };

  const onPlaying = (): void => {
    stopVodFakeLoadingOverlay();
    cancelStallRetry();
    lastProgressTs = Date.now();
    lastTime = getRealVodCurrentTime(video);
    forceStartLoad();
    optimisticVodTimeSeconds = null;
    updateVodProgressUi(video);
  };

  const onTimeUpdate = (): void => {
    if (optimisticVodTimeSeconds !== null) {
      // While we have an optimistic seek target, ignore timeupdate from the
      // (possibly old / tearing-down) media element; just keep the UI on the
      // optimistic value until the new session reaches `playing`.
      updateVodProgressUi(video);
      return;
    }
    const t = getRealVodCurrentTime(video);
    if (t > lastTime) lastTime = t;
    lastProgressTs = Date.now();
    updateVodProgressUi(video);
  };

  const onSeeking = (): void => {
    if (suppressNativeSeekingHandler) return;
    if (isVodTranscode) return;
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (!currentVodSeekable || !currentVodSourceUrl) return;
    if (vodSeekInFlight) return;
    let delta = 0;
    if (ev.key === "ArrowRight" || ev.key.toLowerCase() === "l") delta = 10;
    if (ev.key === "ArrowLeft" || ev.key.toLowerCase() === "j") delta = -10;
    if (!delta) return;
    ev.preventDefault();
    const realDuration = getRealVodDuration(video);
    const base = getRealVodCurrentTime(video);
    const target = realDuration > 0 ? Math.min(Math.max(0, base + delta), realDuration) : Math.max(0, base + delta);
    optimisticVodTimeSeconds = target;
    if (realDuration > 0) {
      setVodSeekVisualPercent(target / realDuration);
    }
    updateVodProgressUi(video);
    setVodPlayerBufferingVisible(true);
    seekVodTranscodeTo(video, target).then(
      (ok) => {
        if (!ok) {
          optimisticVodTimeSeconds = null;
          updateVodProgressUi(video);
        }
      },
      () => {
        optimisticVodTimeSeconds = null;
        updateVodProgressUi(video);
      }
    );
  };

  const onLoadedData = (): void => {
    lockDownVodNativeUi(video);
    forceStartLoad();
    updateVodProgressUi(video);
  };

  video.addEventListener("waiting", onWaiting);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("stalled", onStalled);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("keydown", onKeyDown);
  video.addEventListener("loadeddata", onLoadedData);
  video.addEventListener("error", onError);

  const seekFromPointerEvent = (event: PointerEvent | MouseEvent): void => {
    if (!elVodCtlSeekTrack) return;
    const duration = getRealVodDuration(video);
    if (!duration || !Number.isFinite(duration)) return;
    const rect = elVodCtlSeekTrack.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const targetSeconds = percent * duration;
    console.log("[VOD CTRL] pointer percent", percent);
    console.log("[VOD CTRL] targetSeconds", targetSeconds);
    if (!isVodTranscode) {
      video.currentTime = targetSeconds;
      setVodSeekVisualPercent(percent);
      updateVodProgressUi(video);
      return;
    }
    // 1. Move the UI immediately to the clicked position.
    optimisticVodTimeSeconds = targetSeconds;
    setVodSeekVisualPercent(percent);
    updateVodProgressUi(video);
    setVodPlayerBufferingVisible(true);
    // 2. Then run the existing (working) seek/session reload logic. We only
    //    clear the optimistic value if the seek itself failed; on success we
    //    wait for the `playing` event of the new session to clear it.
    seekVodTranscodeTo(video, targetSeconds).then(
      (ok) => {
        if (!ok) {
          optimisticVodTimeSeconds = null;
          updateVodProgressUi(video);
        }
      },
      () => {
        optimisticVodTimeSeconds = null;
        updateVodProgressUi(video);
      }
    );
  };
  const updateDragPercent = (event: PointerEvent): void => {
    if (!elVodCtlSeekTrack) return;
    const duration = getRealVodDuration(video);
    if (!duration || !Number.isFinite(duration)) return;
    const rect = elVodCtlSeekTrack.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setVodSeekVisualPercent(percent);
    console.log("[VOD CTRL] pointer percent", percent);
  };
  const onSeekTrackClick = (event: MouseEvent): void => {
    if (isVodSeekDragging) return;
    if (event.detail === 0) return;
    if (elVodCtlSeekTrack?.dataset.skipClick === "1") {
      elVodCtlSeekTrack.dataset.skipClick = "0";
      return;
    }
    seekFromPointerEvent(event);
  };
  const onSeekTrackPointerDown = (event: PointerEvent): void => {
    if (!elVodCtlSeekTrack) return;
    isVodSeekDragging = true;
    elVodCtlSeekTrack.setPointerCapture?.(event.pointerId);
    updateDragPercent(event);
  };
  const onSeekTrackPointerMove = (event: PointerEvent): void => {
    if (!isVodSeekDragging) return;
    updateDragPercent(event);
  };
  const onSeekTrackPointerUp = (event: PointerEvent): void => {
    if (!elVodCtlSeekTrack) return;
    if (!isVodSeekDragging) return;
    isVodSeekDragging = false;
    elVodCtlSeekTrack.dataset.skipClick = "1";
    elVodCtlSeekTrack.releasePointerCapture?.(event.pointerId);
    seekFromPointerEvent(event);
  };
  const onSeekTrackPointerCancel = (event: PointerEvent): void => {
    if (!elVodCtlSeekTrack) return;
    isVodSeekDragging = false;
    elVodCtlSeekTrack.releasePointerCapture?.(event.pointerId);
  };
  const onCtlPlay = (): void => {
    if (video.paused) {
      if (isTrialBlocked()) {
        showTrialExpiredModal();
        return;
      }
      void video.play().catch(() => {});
    } else video.pause();
  };
  const onCtlMute = (): void => {
    video.muted = !video.muted;
    setVodControlIcon(
      elVodCtlMute,
      video.muted ? VOD_CONTROL_ICONS.muted : VOD_CONTROL_ICONS.volume,
      video.muted ? "Unmute" : "Mute"
    );
  };
  const onCtlFullscreen = async (): Promise<void> => {
    const host = elVodPlayerContainer ?? video;
    const inVodFullscreen = Boolean(
      (document.fullscreenElement && elVodPlayerContainer && document.fullscreenElement === elVodPlayerContainer) ||
        vodManualFullscreenActive
    );
    if (!inVodFullscreen) {
      vodManualFullscreenActive = false;
      try {
        if (host.requestFullscreen) {
          await host.requestFullscreen();
        } else {
          vodManualFullscreenActive = true;
        }
      } catch {
        vodManualFullscreenActive = true;
      }
      if (!document.fullscreenElement && !vodManualFullscreenActive) {
        vodManualFullscreenActive = true;
      }
      lockVodLandscapeOrientation();
      onFullscreenChange();
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => {});
    }
    clearVodManualFullscreen();
    onFullscreenChange();
  };
  const onFullscreenChange = (): void => {
    const inFullscreen = Boolean(
      (document.fullscreenElement &&
        elVodPlayerContainer &&
        document.fullscreenElement === elVodPlayerContainer) ||
        vodManualFullscreenActive
    );
    elVodPlayerContainer?.classList.toggle("player-container--fullscreen", inFullscreen);
    document.body.classList.toggle("vel-vod-fullscreen-active", inFullscreen);
    if (inFullscreen) lockVodLandscapeOrientation();
    else clearVodManualFullscreen();
    setVodControlIcon(
      elVodCtlFullscreen,
      inFullscreen ? VOD_CONTROL_ICONS.fullscreenExit : VOD_CONTROL_ICONS.fullscreen,
      inFullscreen ? "Exit fullscreen" : "Fullscreen"
    );
  };
  const onPlayPauseSync = (): void => {
    setVodControlIcon(
      elVodCtlPlay,
      video.paused ? VOD_CONTROL_ICONS.play : VOD_CONTROL_ICONS.pause,
      video.paused ? "Play" : "Pause"
    );
    setVodControlIcon(
      elVodCtlMute,
      video.muted ? VOD_CONTROL_ICONS.muted : VOD_CONTROL_ICONS.volume,
      video.muted ? "Unmute" : "Mute"
    );
    onFullscreenChange();
  };
  let overlayIdleTimer: number | null = null;
  const stopVodControlClick = (event: Event): void => {
    event.stopPropagation();
  };
  const markVodControlsActive = (): void => {
    if (!elVodControlsOverlay) return;
    elVodControlsOverlay.classList.remove("vod-controls-overlay--idle");
    if (overlayIdleTimer != null) window.clearTimeout(overlayIdleTimer);
    overlayIdleTimer = window.setTimeout(() => {
      if (!video.paused && !isVodSeekDragging) {
        elVodControlsOverlay?.classList.add("vod-controls-overlay--idle");
      }
    }, 2100);
  };
  if (elVodCtlSeekTrack) {
    elVodCtlSeekTrack.addEventListener("click", onSeekTrackClick);
    elVodCtlSeekTrack.addEventListener("pointerdown", onSeekTrackPointerDown);
    elVodCtlSeekTrack.addEventListener("pointermove", onSeekTrackPointerMove);
    elVodCtlSeekTrack.addEventListener("pointerup", onSeekTrackPointerUp);
    elVodCtlSeekTrack.addEventListener("pointercancel", onSeekTrackPointerCancel);
  }
  if (elVodCtlPlay) elVodCtlPlay.addEventListener("click", onCtlPlay);
  if (elVodCtlMute) elVodCtlMute.addEventListener("click", onCtlMute);
  if (elVodCtlFullscreen) elVodCtlFullscreen.addEventListener("click", onCtlFullscreen);
  video.addEventListener("mousemove", markVodControlsActive);
  video.addEventListener("pointermove", markVodControlsActive);
  video.addEventListener("touchstart", markVodControlsActive, { passive: true });
  elVodVideoWrapper?.addEventListener("click", toggleVideoPlayPauseVod);
  elVodVideoWrapper?.addEventListener("pointermove", markVodControlsActive);
  elVodVideoWrapper?.addEventListener("touchstart", markVodControlsActive, { passive: true });
  elVodControlsOverlay?.addEventListener("click", stopVodControlClick);
  elVodControlsOverlay?.addEventListener("pointermove", markVodControlsActive);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  const onVolumeChange = (): void => {
    persistVodVolume(video.volume);
    setVodControlIcon(
      elVodCtlMute,
      video.muted ? VOD_CONTROL_ICONS.muted : VOD_CONTROL_ICONS.volume,
      video.muted ? "Unmute" : "Mute"
    );
  };
  video.addEventListener("volumechange", onVolumeChange);
  video.addEventListener("play", onPlayPauseSync);
  video.addEventListener("pause", onPlayPauseSync);
  onPlayPauseSync();
  markVodControlsActive();

  watchdogTimer = setInterval(() => {
    if (video.paused) return;
    updateProgressClock();
  }, VOD_WATCHDOG_TICK_MS);

  vodPlaybackHelpersCleanup = () => {
    isVodSeekDragging = false;
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("stalled", onStalled);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("keydown", onKeyDown);
    video.removeEventListener("loadeddata", onLoadedData);
    video.removeEventListener("error", onError);
    if (elVodCtlSeekTrack) {
      elVodCtlSeekTrack.removeEventListener("click", onSeekTrackClick);
      elVodCtlSeekTrack.removeEventListener("pointerdown", onSeekTrackPointerDown);
      elVodCtlSeekTrack.removeEventListener("pointermove", onSeekTrackPointerMove);
      elVodCtlSeekTrack.removeEventListener("pointerup", onSeekTrackPointerUp);
      elVodCtlSeekTrack.removeEventListener("pointercancel", onSeekTrackPointerCancel);
    }
    if (elVodCtlPlay) elVodCtlPlay.removeEventListener("click", onCtlPlay);
    if (elVodCtlMute) elVodCtlMute.removeEventListener("click", onCtlMute);
    if (elVodCtlFullscreen) elVodCtlFullscreen.removeEventListener("click", onCtlFullscreen);
    video.removeEventListener("mousemove", markVodControlsActive);
    video.removeEventListener("pointermove", markVodControlsActive);
    video.removeEventListener("touchstart", markVodControlsActive);
    elVodVideoWrapper?.removeEventListener("click", toggleVideoPlayPauseVod);
    elVodVideoWrapper?.removeEventListener("pointermove", markVodControlsActive);
    elVodVideoWrapper?.removeEventListener("touchstart", markVodControlsActive);
    elVodControlsOverlay?.removeEventListener("click", stopVodControlClick);
    elVodControlsOverlay?.removeEventListener("pointermove", markVodControlsActive);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    video.removeEventListener("volumechange", onVolumeChange);
    video.removeEventListener("play", onPlayPauseSync);
    video.removeEventListener("pause", onPlayPauseSync);
    if (overlayIdleTimer != null) {
      window.clearTimeout(overlayIdleTimer);
      overlayIdleTimer = null;
    }
    elVodControlsOverlay?.classList.remove("vod-controls-overlay--idle");
    cancelStallRetry();
    if (watchdogTimer != null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };
  syncVodControlVisibility(video);
  updateVodProgressUi(video);
}
let activeStreamId: number | null = null;

type VodMovieUiPhase = "list" | "detail";
let vodMovieUiPhase: VodMovieUiPhase = "list";
let vodDetailStream: LiveStream | null = null;

type SeriesUiPhase = "list" | "detail";
let seriesUiPhase: SeriesUiPhase = "list";
let seriesDetailStream: LiveStream | null = null;

type CatalogMediaTab = "movies" | "series";

function applyPresetTheme(key: string): void {
  const t = THEMES[key] || THEMES.default;
  elMain.style.setProperty("--vel-bg", t.bg);
  elMain.style.setProperty("--vel-surface", t.surface);
  elMain.style.setProperty("--vel-primary", t.primary);
  elMain.style.setProperty("--vel-accent-glow", t.glow);
  elMain.style.removeProperty("--vel-back");
}

function applyThemeForPackageSync(pkg: AdminPackage | null): void {
  if (!pkg) {
    applyPresetTheme("default");
    return;
  }
  const preset = presetForPackageName(pkg.name);
  const bg = pkg.theme_bg?.trim() || preset.bg;
  const surface = pkg.theme_surface?.trim() || preset.surface;
  const primary = pkg.theme_primary?.trim() || preset.primary;
  const glow = pkg.theme_glow?.trim() || preset.glow;
  elMain.style.setProperty("--vel-bg", bg);
  elMain.style.setProperty("--vel-surface", surface);
  elMain.style.setProperty("--vel-primary", primary);
  elMain.style.setProperty("--vel-accent-glow", glow);
  const back = pkg.theme_back?.trim();
  if (back) elMain.style.setProperty("--vel-back", back);
  else elMain.style.removeProperty("--vel-back");
}

function resolveHeroImageUrlForTheme(pkg: AdminPackage): string | null {
  const st = state;
  if (!st) return null;
  const id = pkg.id;
  if (isLikelyUuid(id)) {
    const u = pkg.cover_url?.trim();
    if (u && /^https?:\/\//i.test(u)) return u;
    return null;
  }
  const o = packageCoverOverrideById.get(id)?.cover_url?.trim();
  if (o && /^https?:\/\//i.test(o)) return o;
  const list = streamsForPackageCoverFallback(id);
  const ch = list.map((s) => resolvedIconUrl(s.stream_icon, st.base)).find(Boolean);
  return ch?.trim() || null;
}

async function applyPackageImageThemeAsync(pkg: AdminPackage | null): Promise<void> {
  if (!pkg) return;
  const hasCustom =
    Boolean(pkg.theme_bg?.trim()) ||
    Boolean(pkg.theme_surface?.trim()) ||
    Boolean(pkg.theme_primary?.trim()) ||
    Boolean(pkg.theme_glow?.trim());
  if (hasCustom) return;
  const url = resolveHeroImageUrlForTheme(pkg);
  if (!url) return;
  const pid = pkg.id;
  const extracted = await extractPresetFromImageUrlCached(pid, url);
  if (!extracted) return;
  if (uiAdminPackageId !== pid) return;
  const now = findPackageById(pid);
  if (!now) return;
  if (
    now.theme_bg?.trim() ||
    now.theme_surface?.trim() ||
    now.theme_primary?.trim() ||
    now.theme_glow?.trim()
  ) {
    return;
  }
  const urlNow = resolveHeroImageUrlForTheme(now);
  if (urlNow !== url) return;
  elMain.style.setProperty("--vel-bg", extracted.bg);
  elMain.style.setProperty("--vel-surface", extracted.surface);
  elMain.style.setProperty("--vel-primary", extracted.primary);
  elMain.style.setProperty("--vel-accent-glow", extracted.glow);
}

function applyThemeForPackage(pkg: AdminPackage | null): void {
  applyThemeForPackageSync(pkg);
  void applyPackageImageThemeAsync(pkg);
}

function setTabsActive(tab: UiTab): void {
  elTabLive.classList.toggle("active", tab === "live");
  elTabMovies.classList.toggle("active", tab === "movies");
  elTabSeries.classList.toggle("active", tab === "series");
  elAdultTabLive?.classList.toggle("active", adultPortalMode && adultPortalTab === "live");
  elAdultTabMovies?.classList.toggle("active", adultPortalMode && adultPortalTab === "movies");
}

/** Marque le shell « dans un bouquet » : le logo VIP suit le thème du package sur `.main`. */
function syncMainInPackageClass(): void {
  elMain.classList.toggle("main--velora-in-package", uiShell === "content" && uiAdminPackageId != null);
  elMain.classList.toggle(
    "main--velora-live-package",
    uiShell === "content" && uiAdminPackageId != null && uiTab === "live"
  );
}

/** Scroll is on `#main` (`.main--velora`), not the window; grid scroll was kept when opening a package. */
function resetVeloraMainScroll(): void {
  elMain.scrollTop = 0;
  window.scrollTo(0, 0);
}

function smoothVeloraMainScrollTop(): void {
  elMain.scrollTo({ top: 0, behavior: "smooth" });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function syncAdultPortalChrome(): void {
  elMain.classList.toggle("main--velora-adult", adultPortalMode);
  elAdultView?.classList.toggle("hidden", !adultPortalMode || uiShell !== "packages");
  elBtnAdultPortal?.classList.toggle("active", adultPortalMode);
  elBtnAdultPortal?.setAttribute("aria-pressed", adultPortalMode ? "true" : "false");
  elAdultTabLive?.classList.toggle("active", adultPortalMode && adultPortalTab === "live");
  elAdultTabMovies?.classList.toggle("active", adultPortalMode && adultPortalTab === "movies");
  elAdultTabHome?.classList.remove("active");
  elCountrySelect.closest(".vel-header__country")?.classList.toggle("hidden", adultPortalMode);
  elTabSeries.classList.toggle("hidden", adultPortalMode);
}

function normalizeAdultMatchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_|.[\](){}:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isAdultLabel(value: string | null | undefined): boolean {
  const t = normalizeAdultMatchText(value ?? "");
  if (!t) return false;
  return (
    /(^|\s)(xxx|xx|adult|adults|adulte|adultes|adulti|erotic|erotique|erotik|porn|porno|sexy|sex|hot|playboy|hustler|dorcel|brazzers|redlight|xvideos)(\s|$)/i.test(t) ||
    /(^|\s)(18\s*\+|\+18|x\s*rated)(\s|$)/i.test(t)
  );
}

function packageCountryLabel(pkg: AdminPackage, layout: AdminConfig): string | null {
  return (
    countryNameForIdInLayout(pkg.country_id, layout) ??
    (isLikelyUuid(pkg.country_id)
      ? dbAdminCountries.find((c) => c.id === pkg.country_id)?.name.trim() ?? null
      : null)
  );
}

function isAdultPackage(pkg: AdminPackage, layout: AdminConfig, tab?: AdultCatalogTab | UiTab): boolean {
  void tab;
  return isAdultLabel(pkg.name) || isAdultLabel(packageCountryLabel(pkg, layout));
}

function isAdultAccessConfirmed(): boolean {
  try {
    return sessionStorage.getItem(ADULT_ACCESS_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function confirmAdultAccess(): Promise<boolean> {
  if (isAdultAccessConfirmed()) return Promise.resolve(true);

  if (!elAdultConfirmDialog || !elAdultConfirmYes || !elAdultConfirmNo) {
    const ok = window.confirm("Contenu reserve aux adultes. Confirmez-vous avoir 18 ans ou plus ?");
    if (ok) {
      try {
        sessionStorage.setItem(ADULT_ACCESS_SESSION_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    return Promise.resolve(ok);
  }

  return new Promise((resolve) => {
    const ac = new AbortController();
    const { signal } = ac;
    const done = (ok: boolean) => {
      if (ok) {
        try {
          sessionStorage.setItem(ADULT_ACCESS_SESSION_KEY, "1");
        } catch {
          /* ignore */
        }
      }
      elAdultConfirmDialog.close();
      ac.abort();
      resolve(ok);
    };
    elAdultConfirmYes.addEventListener("click", (ev) => {
      ev.preventDefault();
      done(true);
    }, { signal });
    elAdultConfirmNo.addEventListener("click", (ev) => {
      ev.preventDefault();
      done(false);
    }, { signal });
    elAdultConfirmDialog.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      done(false);
    }, { signal });
    elAdultConfirmDialog.addEventListener("close", () => {
      ac.abort();
      resolve(false);
    }, { once: true });
    elAdultConfirmDialog.showModal();
  });
}

function exitAdultPortalMode(): void {
  if (!adultPortalMode) return;
  adultPortalMode = false;
  syncAdultPortalChrome();
}

function adultPackagesForTab(tab: AdultCatalogTab): AdminPackage[] {
  const layout = tab === "movies" ? vodAdminConfig : adminConfig;
  const byId = new Map<string, AdminPackage>();
  for (const pkg of layout.packages) {
    if (isAdultPackage(pkg, layout, tab)) byId.set(pkg.id, pkg);
  }
  const globalLines = getGlobalPackageAllowlistLines()
    .map((x) => x.trim())
    .filter(Boolean);
  for (const line of globalLines) {
    const nk = normalizeGlobalAllowlistNameKey(line);
    const exact =
      layout.packages.find((p) => p.id === line) ??
      dbAdminPackages.find((p) => p.id === line);
    if (exact && isAdultPackage(exact, layout, tab)) {
      byId.set(exact.id, exact);
      continue;
    }
    if (!nk && !isAdultLabel(line)) continue;
    for (const pkg of layout.packages) {
      if (normalizeGlobalAllowlistNameKey(pkg.name) === nk || (isAdultLabel(line) && isAdultPackage(pkg, layout, tab))) {
        if (isAdultPackage(pkg, layout, tab)) byId.set(pkg.id, pkg);
      }
    }
  }
  if (tab === "live") {
    for (const pkg of dbAdminPackages) {
      if (isAdultPackage(pkg, adminConfig, tab)) byId.set(pkg.id, pkg);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function adultCategoryIdsForTab(tab: AdultCatalogTab): string[] {
  if (!state || state.mode !== "nodecast") return [];
  const categories = tab === "movies" ? state.vodCategories : state.liveCategories;
  return categories
    .filter((category) => isAdultLabel(category.category_name))
    .map((category) => String(category.category_id))
    .filter(Boolean);
}

async function ensureAdultCatalogReady(tab: AdultCatalogTab): Promise<void> {
  if (!state || state.mode !== "nodecast") return;
  const sid = state.nodecastXtreamSourceId?.trim();
  if (!sid) return;

  setCatalogLoadingVisible(
    true,
    tab === "movies" ? "Chargement des films adultes..." : "Chargement des lives adultes...",
    tab
  );
  try {
    if (tab === "movies") {
      nodecastVodCatalogFetchError = null;
      if (!state.vodCatalogLoaded) {
        state.vodCategories = await fetchNodecastVodCategories(
          state.base,
          sid,
          state.nodecastAuthHeaders
        );
        state.vodCatalogLoaded = true;
      }
      const adultCategoryIds = adultCategoryIdsForTab("movies");
      const missing = adultCategoryIds.filter((categoryId) => !state?.vodLoadedCategoryIds.has(categoryId));
      if (missing.length > 0) {
        const streamsByCat = await fetchNodecastVodStreamsForCategories(
          state.base,
          sid,
          missing,
          state.nodecastAuthHeaders
        );
        if (!state) return;
        mergeStreamsByCategory(state.vodStreamsByCat, streamsByCat);
        for (const categoryId of missing) state.vodLoadedCategoryIds.add(categoryId);
      }
      if (!state) return;
      vodAdminConfig = buildProviderAdminConfig(state.vodCategories, state.vodStreamsByCat);
      nodecastVodCatalogFetchError = null;
      persistVeloraNodecastSnapshot();
      return;
    }

    const adultCategoryIds = adultCategoryIdsForTab("live");
    const missing = adultCategoryIds.filter((categoryId) => !state?.liveLoadedCategoryIds.has(categoryId));
    if (missing.length > 0) {
      const streamsByCat = await fetchNodecastLiveStreamsForCategories(
        state.base,
        sid,
        missing,
        state.nodecastAuthHeaders
      );
      if (!state) return;
      mergeStreamsByCategory(state.streamsByCatAll, streamsByCat);
      for (const categoryId of missing) state.liveLoadedCategoryIds.add(categoryId);
    }
    if (!state) return;
    adminConfig = buildProviderAdminConfig(state.liveCategories, state.streamsByCatAll);
    persistVeloraNodecastSnapshot();
  } catch (err) {
    if (tab === "movies") {
      nodecastVodCatalogFetchError = err instanceof Error ? err.message : String(err);
    }
    console.error("[Velora] Adult catalogue fetch failed", err);
  } finally {
    setCatalogLoadingVisible(false);
  }
}

async function showAdultPortal(tab: AdultCatalogTab = adultPortalTab): Promise<void> {
  if (!(await confirmAdultAccess())) return;
  activeStreamId = null;
  destroyPlayer();
  destroyVodPlayer();
  adultPortalMode = true;
  adultPortalTab = tab;
  uiTab = tab;
  uiShell = "packages";
  uiAdminPackageId = null;
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  selectedPillId = "all";
  setTabsActive(uiTab);
  elPackagesView.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.classList.remove("item-list--vod-film-detail");
  elCatPillsWrap.classList.add("hidden");
  applyPresetTheme("default");
  syncAdultPortalChrome();
  await ensureAdultCatalogReady(tab);
  renderPackagesGrid();
  syncPlayerDismissOverlay();
  syncMainInPackageClass();
  resetVeloraMainScroll();
}

/** × sur le lecteur : visible seulement sur la grille bouquets (hors package), lecteur affiché. */
function syncPlayerDismissOverlay(): void {
  const onPackagesGrid = uiShell === "packages";
  const liveShown = !elPlayerContainer.classList.contains("hidden");
  const vodShown = Boolean(elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden"));
  const ok = state != null && onPackagesGrid;
  elBtnClosePlayer?.classList.toggle("hidden", !(liveShown && ok));
  elBtnCloseVodPlayer?.classList.toggle("hidden", !(vodShown && ok));
}

function showPlayerChrome(show: boolean): void {
  const wasVisible = !elPlayerContainer.classList.contains("hidden");
  if (show) {
    destroyVodPlayer();
  } else if (wasVisible && !veloraApplyingHistoryPopstate && veloraUiHistoryDepth > 0) {
    stripVeloraHistorySilently(1);
  }
  elPlayerContainer.classList.toggle("hidden", !show);
  elPlayerContainer.setAttribute("aria-hidden", show ? "false" : "true");
  elNowPlaying.classList.toggle("hidden", !show);
  elNowPlaying.setAttribute("aria-hidden", show ? "false" : "true");
  setLiveControlsVisible(show);
  if (!show) clearLiveManualFullscreen();
  syncLiveControlState();
  if (show && !wasVisible) {
    veloraPushNavigationState("player-live");
  }
  syncPlayerDismissOverlay();
}

function showVodPlayerChrome(show: boolean): void {
  if (!elVodPlayerContainer || !elNowPlayingVod) return;
  const wasVisible = !elVodPlayerContainer.classList.contains("hidden");
  if (show) {
    destroyPlayer();
  } else if (wasVisible && !veloraApplyingHistoryPopstate && veloraUiHistoryDepth > 0) {
    stripVeloraHistorySilently(1);
  }
  elVodPlayerContainer.classList.toggle("hidden", !show);
  elVodPlayerContainer.setAttribute("aria-hidden", show ? "false" : "true");
  elNowPlayingVod.classList.toggle("hidden", !show);
  elNowPlayingVod.setAttribute("aria-hidden", show ? "false" : "true");
  if (show && !wasVisible) {
    veloraPushNavigationState("player-vod");
  }
  syncPlayerDismissOverlay();
}

/** Arrête la lecture et masque le lecteur ; met à jour la liste des chaînes si on est encore dans un bouquet. */
function closePlayerUserAction(): void {
  activeStreamId = null;
  destroyPlayer();
  syncSeriesEpisodePlaybackHighlight();
  syncSeriesDetailEpisodePlayingLayout();
  if (state && uiShell === "content" && uiAdminPackageId != null) {
    renderPackageChannelList();
  }
}

function closeVodPlayerUserAction(): void {
  activeStreamId = null;
  destroyVodPlayer();
  syncSeriesEpisodePlaybackHighlight();
  syncSeriesDetailEpisodePlayingLayout();
  if (state && uiShell === "content" && uiAdminPackageId != null) {
    renderPackageChannelList();
  }
}

/** Réordonne la fiche série (épisodes + saison en tête) pendant la lecture d’un épisode VOD. */
function syncSeriesDetailEpisodePlayingLayout(): void {
  const detail = elDynamicList?.querySelector<HTMLElement>(".vel-vod-detail--series");
  if (!detail) return;
  const seriesRow = seriesDetailStream;
  const inSeriesDetail = uiTab === "series" && seriesUiPhase === "detail" && seriesRow != null;
  if (!inSeriesDetail) {
    detail.classList.remove("vel-vod-detail--episode-playing");
    return;
  }
  const id = activeStreamId;
  const episodeIds = new Set<number>();
  detail.querySelectorAll<HTMLButtonElement>("button.vel-vod-detail__episode[data-episode-stream-id]").forEach((btn) => {
    const n = Number(btn.dataset.episodeStreamId);
    if (Number.isFinite(n)) episodeIds.add(n);
  });
  const vodShown =
    elVodPlayerContainer != null && !elVodPlayerContainer.classList.contains("hidden");
  const seriesRowPlaying = id != null && id === seriesRow.stream_id;
  const rowInList = id != null && episodeIds.has(id);
  const playingEpisode =
    id != null && !seriesRowPlaying && (vodShown || rowInList);
  detail.classList.toggle("vel-vod-detail--episode-playing", playingEpisode);
}

function syncSeriesEpisodePlaybackHighlight(): void {
  if (!elDynamicList) return;
  const root = elDynamicList.querySelector(".vel-vod-detail__episodes");
  if (root) {
    const id = activeStreamId;
    for (const btn of root.querySelectorAll<HTMLButtonElement>("button.vel-vod-detail__episode")) {
      const raw = btn.dataset.episodeStreamId;
      const sid = raw !== undefined ? Number(raw) : NaN;
      const on = id !== null && Number.isFinite(sid) && sid === id;
      btn.classList.toggle("vel-vod-detail__episode--playing", on);
      if (on) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    }
  }
  syncSeriesDetailEpisodePlayingLayout();
}

function uniqueSortedSeasonsFromEpisodes(eps: SeriesEpisodeListItem[]): number[] {
  const set = new Set<number>();
  for (const e of eps) {
    if (Number.isFinite(e.seasonNumber)) set.add(e.seasonNumber);
  }
  return [...set].sort((a, b) => a - b);
}

function setPlayerBufferingVisible(visible: boolean): void {
  if (!elPlayerBuffering) return;
  elPlayerBuffering.classList.toggle("hidden", !visible);
  elPlayerBuffering.setAttribute("aria-hidden", visible ? "false" : "true");
}

function armLiveStartupUi(): void {
  liveStartupUiCleanup?.();
  setPlayerBufferingVisible(true);
  let cleaned = false;
  const markReady = (): void => {
    setPlayerBufferingVisible(false);
    cleanup();
  };
  const fallbackTimer = window.setTimeout(markReady, 15_000);
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(fallbackTimer);
    elVideo.removeEventListener("playing", markReady);
    elVideo.removeEventListener("canplay", markReady);
    if (liveStartupUiCleanup === cleanup) liveStartupUiCleanup = null;
  }
  elVideo.addEventListener("playing", markReady);
  elVideo.addEventListener("canplay", markReady);
  liveStartupUiCleanup = cleanup;
}

/** Stop HLS / native playback without hiding the player shell (used when switching stream). */
function teardownPlaybackMedia(): void {
  livePlaybackSessionId += 1;
  markPlaybackStopped(elVideo);
  liveStartupUiCleanup?.();
  liveStartupUiCleanup = null;
  liveSilentAudioMonitorCleanup?.();
  liveSilentAudioMonitorCleanup = null;
  primaryPlaybackKeepAliveCleanup?.();
  primaryPlaybackKeepAliveCleanup = null;
  nodecastStatusPollingCleanup?.();
  nodecastStatusPollingCleanup = null;
  if (hls) {
    try {
      hls.stopLoad();
    } catch {
      /* ignore */
    }
    try {
      hls.detachMedia();
    } catch {
      /* ignore */
    }
    try {
      hls.destroy();
    } catch {
      /* ignore */
    }
    hls = null;
  }
  elVideo.onerror = null;
  try {
    elVideo.pause();
  } catch {
    /* ignore */
  }
  elVideo.removeAttribute("src");
  elVideo.removeAttribute("title");
  elVideo.load();
  configureLiveNativeUi(elVideo);
  syncLiveControlState();
  elPlayerContainer.classList.remove("player-container--live-tv");
}

function attachNodecastStatusPollingForPlayback(
  initialDelayMs = NODECAST_STATUS_STARTUP_DELAY_MS
): void {
  nodecastStatusPollingCleanup?.();
  nodecastStatusPollingCleanup = null;
  const st = state;
  if (!st?.nodecastAuthHeaders) return;
  let stopped = false;
  let inflight = false;
  const run = async (): Promise<void> => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      await pingNodecastSourcesStatus(st.base, st.nodecastAuthHeaders);
    } catch {
      /* best-effort polling only */
    } finally {
      inflight = false;
    }
  };
  const initialTimer = window.setTimeout(() => {
    void run();
  }, Math.max(0, initialDelayMs));
  const timer = window.setInterval(() => {
    void run();
  }, NODECAST_STATUS_POLL_MS);
  nodecastStatusPollingCleanup = () => {
    stopped = true;
    window.clearTimeout(initialTimer);
    window.clearInterval(timer);
  };
}

function attachPrimaryPlaybackKeepAlive(video: HTMLVideoElement): void {
  primaryPlaybackKeepAliveCleanup?.();
  const keepAliveSessionId = livePlaybackSessionId;
  let lastBufferedEnd = 0;
  let lastBufferAdvanceTs = Date.now();
  let lastNudgeTs = 0;
  const forceHungryLoad = (): void => {
    if (!hls || keepAliveSessionId !== livePlaybackSessionId) return;
    try {
      hls.startLoad(-1);
    } catch {
      /* ignore */
    }
  };
  const onProgress = (): void => {
    if (video.paused || video.seeking) return;
    let currentEnd = 0;
    if (video.buffered && video.buffered.length > 0) {
      currentEnd = video.buffered.end(video.buffered.length - 1);
    }
    const now = Date.now();
    const edgeMoved = Math.abs(currentEnd - lastBufferedEnd) > 0.01;
    if (edgeMoved) {
      lastBufferedEnd = currentEnd;
      lastBufferAdvanceTs = now;
    }
    const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const edgeDelta = currentEnd - t;
    if (edgeDelta < VOD_MIN_AHEAD_SECONDS) {
      forceHungryLoad();
    }
    const stalledGrowth = now - lastBufferAdvanceTs >= VOD_BUFFER_STALL_WAKE_MS;
    const canNudge = now - lastNudgeTs >= VOD_NUDGE_COOLDOWN_MS;
    if (stalledGrowth && edgeDelta <= VOD_BUFFER_STALL_EDGE_SECONDS && canNudge) {
      forceHungryLoad();
      try {
        video.currentTime = Math.max(0, t + 0.1);
        lastNudgeTs = now;
      } catch {
        /* ignore */
      }
    }
  };
  video.addEventListener("progress", onProgress);
  primaryPlaybackKeepAliveCleanup = () => {
    video.removeEventListener("progress", onProgress);
  };
}

function destroyPlayer(): void {
  teardownPlaybackMedia();
  setPlayerBufferingVisible(false);
  elNowPlaying.textContent = "";
  showPlayerChrome(false);
}

function setVodPlayerBufferingVisible(visible: boolean): void {
  if (!elVodPlayerBuffering) return;
  elVodPlayerBuffering.classList.toggle("hidden", !visible);
  elVodPlayerBuffering.setAttribute("aria-hidden", visible ? "false" : "true");
}

function teardownVodMedia(): void {
  if (!elVideoVod) return;
  vodPlaybackSessionId += 1;
  markPlaybackStopped(elVideoVod);
  nodecastStatusPollingCleanup?.();
  nodecastStatusPollingCleanup = null;
  teardownVodPlaybackHelpers();
  stopCurrentVodTranscodeSession();
  vodRemountAttempts = 0;
  vodLastRemountTs = 0;
  lastVodProxiedUrl = null;
  lastVodUpstreamAuth = undefined;
  resetVodTranscodeState();
  if (hlsVod) {
    try {
      hlsVod.stopLoad();
    } catch {
      /* ignore */
    }
    try {
      hlsVod.detachMedia();
    } catch {
      /* ignore */
    }
    try {
      hlsVod.destroy();
    } catch {
      /* ignore */
    }
    hlsVod = null;
  }
  elVideoVod.onerror = null;
  try {
    elVideoVod.pause();
  } catch {
    /* ignore */
  }
  elVideoVod.preload = "none";
  elVideoVod.removeAttribute("src");
  elVideoVod.src = "";
  elVideoVod.removeAttribute("title");
  elVideoVod.load();
  lockDownVodNativeUi(elVideoVod);
  isVodTranscode = false;
  clearVodManualFullscreen();
  if (elVodControlsOverlay) {
    elVodControlsOverlay.classList.add("hidden");
    elVodControlsOverlay.setAttribute("aria-hidden", "true");
  }
  elVodPlayerContainer?.classList.remove("player-container--live-tv");
}

function destroyVodPlayer(): void {
  teardownVodMedia();
  stopVodFakeLoadingOverlay();
  setVodPlayerBufferingVisible(false);
  if (elNowPlayingVod) elNowPlayingVod.textContent = "";
  showVodPlayerChrome(false);
}

/** HLS manifest or Nodecast transcode playlist (not raw MKV/MP4). */
function urlLooksLikeHls(href: string): boolean {
  const h = href.toLowerCase();
  if (/\.m3u8(\?|#|&|$)/i.test(h)) return true;
  if (/\/api\/transcode\/[^/]+\/stream\.m3u8/i.test(h)) return true;
  if (/[?&]container=m3u8(?:&|$)/i.test(h)) return true;
  return false;
}

/** Progressive file or Xtream `container=` for a file container (native video element, not hls.js). */
function urlLooksLikeProgressiveMedia(href: string): boolean {
  if (urlLooksLikeHls(href)) return false;
  const h = href.toLowerCase();
  if (/\.(mp4|mkv|webm|mov|avi|m4v)(\?|#|&|$)/i.test(h)) return true;
  if (/[?&]container=(mkv|mp4|webm|mov|avi|m4v)(?:&|$)/i.test(h)) return true;
  return false;
}

function playUrl(
  url: string,
  label: string,
  upstreamAuth?: Record<string, string>,
  /** Live HLS (direct Xtream / chaîne Nodecast) : masque la barre de progression native (flux non borné). */
  hideNativeProgressBar = false,
  allowLiveAudioTranscodeFallback = true,
  liveTranscodeKey?: string
): void {
  if (isTrialBlocked()) {
    showTrialExpiredModal();
    return;
  }
  destroyVodPlayer();
  teardownPlaybackMedia();
  const sessionId = ++livePlaybackSessionId;
  configureLiveNativeUi(elVideo);
  prepareLiveAudioForPlayback(elVideo);
  attachNodecastStatusPollingForPlayback();
  armLiveStartupUi();
  const proxied = proxiedUrl(url);
  elNowPlaying.innerHTML = nowPlayingLiveMarkup(label);
  /* Classe live avant d’afficher le shell : sinon une frame affiche la barre de progression native. */
  if (hideNativeProgressBar) {
    elPlayerContainer.classList.add("player-container--live-tv");
  } else {
    elPlayerContainer.classList.remove("player-container--live-tv");
  }
  showPlayerChrome(true);

  const hasUpstreamAuth = Boolean(
    upstreamAuth &&
      Object.values(upstreamAuth).some((v) => typeof v === "string" && v.trim())
  );

  let liveAudioFallbackStarted = false;
  const tryLiveAudioTranscodeFallback = (reason: string): void => {
    if (!allowLiveAudioTranscodeFallback || liveAudioFallbackStarted) return;
    if (!state || state.mode !== "nodecast") return;
    if (/\/api\/transcode\//i.test(url)) return;
    liveAudioFallbackStarted = true;
    const fallbackSessionId = sessionId;
    liveSilentAudioMonitorCleanup?.();
    liveSilentAudioMonitorCleanup = null;
    rememberLiveSourceNeedsTranscode(url, label, liveTranscodeKey);
    console.warn(`[Live audio] retrying with Nodecast transcode: ${reason}`, { label });
    void (async () => {
      const transcoded = await createNodecastLiveTranscodeUrl(state!.base, url, upstreamAuth);
      if (fallbackSessionId !== livePlaybackSessionId) return;
      if (!transcoded) {
        playUrl(url, label, upstreamAuth, hideNativeProgressBar, false, liveTranscodeKey);
        return;
      }
      playUrl(transcoded, label, upstreamAuth, hideNativeProgressBar, false, liveTranscodeKey);
    })();
  };

  if (
    allowLiveAudioTranscodeFallback &&
    state?.mode === "nodecast" &&
    !/\/api\/transcode\//i.test(url) &&
    liveSourceNeedsTranscode(url, label, liveTranscodeKey)
  ) {
    tryLiveAudioTranscodeFallback("known silent-audio live source");
    return;
  }

  if (
    allowLiveAudioTranscodeFallback &&
    state?.mode === "nodecast" &&
    !/\/api\/transcode\//i.test(url)
  ) {
    const probeSessionId = sessionId;
    void probeNodecastStreamCompatibility(state.base, url, upstreamAuth)
      .then((probe) => {
        if (probeSessionId !== livePlaybackSessionId) return;
        if (liveProbeSuggestsTranscode(probe)) {
          tryLiveAudioTranscodeFallback(
            probe?.audio ? `probe audio=${probe.audio}` : "probe reported incompatible stream"
          );
        }
      })
      .catch(() => {});
  }

  if (urlLooksLikeProgressiveMedia(url) || urlLooksLikeProgressiveMedia(proxied)) {
    if (sessionId !== livePlaybackSessionId) return;
    elVideo.src = proxied;
    elVideo.onerror = () => {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        "Lecture impossible (codec non pris en charge ou flux refusé)."
      );
    };
    prepareLiveAudioForPlayback(elVideo);
    void elVideo.play().catch(() => {});
    if (allowLiveAudioTranscodeFallback) {
      scheduleLiveSilentAudioFallback(sessionId, tryLiveAudioTranscodeFallback);
    }
    return;
  }

  // Native <video> cannot send Authorization; Nodecast transcode/HLS needs Bearer on every segment.
  if (
    elVideo.canPlayType("application/vnd.apple.mpegurl") &&
    !hasUpstreamAuth &&
    urlLooksLikeHls(url)
  ) {
    if (sessionId !== livePlaybackSessionId) return;
    elVideo.src = proxied;
    prepareLiveAudioForPlayback(elVideo);
    void elVideo.play().catch(() => {});
    if (allowLiveAudioTranscodeFallback) {
      scheduleLiveSilentAudioFallback(sessionId, tryLiveAudioTranscodeFallback);
    }
    return;
  }

  if (Hls.isSupported()) {
    const hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      testBandwidth: false,
      startLevel: 0,
      startFragPrefetch: true,
      // Keep enough buffered media for smooth playback without drifting too far behind live edge.
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 9,
      manifestLoadingMaxRetry: 12,
      levelLoadingMaxRetry: 12,
      fragLoadingMaxRetry: 14,
      xhrSetup(xhr) {
        try {
          xhr.setRequestHeader("User-Agent", NODECAST_HLS_USER_AGENT);
        } catch {
          /* browser may block User-Agent */
        }
        if (!upstreamAuth) return;
        for (const [k, v] of Object.entries(upstreamAuth)) {
          if (typeof v !== "string" || !v.trim()) continue;
          try {
            xhr.setRequestHeader(k, v);
          } catch {
            /* ignore invalid header names */
          }
        }
      },
    });
    hls = hlsInstance;
    hlsInstance.loadSource(proxied);
    hlsInstance.attachMedia(elVideo);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (sessionId !== livePlaybackSessionId || hls !== hlsInstance) return;
      ensureHlsAudioTrack(hlsInstance);
      if (hlsHasLikelyUnsupportedAudio(hlsInstance)) {
        tryLiveAudioTranscodeFallback("unsupported audio codec in manifest");
        return;
      }
      attachPrimaryPlaybackKeepAlive(elVideo);
      prepareLiveAudioForPlayback(elVideo);
      void elVideo.play().catch(() => {});
      if (allowLiveAudioTranscodeFallback) {
        scheduleLiveSilentAudioFallback(sessionId, tryLiveAudioTranscodeFallback);
      }
    });
    hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      if (sessionId !== livePlaybackSessionId || hls !== hlsInstance) return;
      ensureHlsAudioTrack(hlsInstance);
      if (hlsHasLikelyUnsupportedAudio(hlsInstance)) {
        tryLiveAudioTranscodeFallback("unsupported audio track codec");
      }
    });
    hlsInstance.on(Hls.Events.ERROR, (_e, data) => {
      if (sessionId !== livePlaybackSessionId || hls !== hlsInstance) return;
      if (data.fatal) {
        if (
          data.details === ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
          data.details === ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR
        ) {
          tryLiveAudioTranscodeFallback(String(data.details));
          return;
        }
        if (data.type === ErrorTypes.NETWORK_ERROR) {
          try {
            hlsInstance.startLoad(-1);
            return;
          } catch {
            /* ignore */
          }
        }
        if (data.type === ErrorTypes.MEDIA_ERROR) {
          try {
            hlsInstance.recoverMediaError();
            return;
          } catch {
            /* ignore */
          }
        }
        elNowPlaying.innerHTML = nowPlayingErrorMarkup(
          `Erreur lecture : ${data.type} / ${String(data.details)}`
        );
      }
    });
    return;
  }

  elNowPlaying.innerHTML = nowPlayingErrorMarkup(
    "HLS non pris en charge dans ce navigateur."
  );
}

async function playLiveUrlWithAudioPolicy(
  url: string,
  label: string,
  upstreamAuth: Record<string, string> | undefined,
  hideNativeProgressBar: boolean,
  liveTranscodeKey: string
): Promise<void> {
  const requestId = mediaPlaybackRequestId;
  if (state?.mode === "nodecast" && liveSourceNeedsTranscode(url, label, liveTranscodeKey)) {
    destroyVodPlayer();
    teardownPlaybackMedia();
    configureLiveNativeUi(elVideo);
    prepareLiveAudioForPlayback(elVideo);
    attachNodecastStatusPollingForPlayback();
    armLiveStartupUi();
    elNowPlaying.innerHTML = nowPlayingLiveMarkup(label);
    elPlayerContainer.classList.toggle("player-container--live-tv", hideNativeProgressBar);
    showPlayerChrome(true);
    const transcoded = await createNodecastLiveTranscodeUrl(state.base, url, upstreamAuth);
    if (requestId !== mediaPlaybackRequestId) return;
    if (transcoded && liveSourceNeedsTranscode(url, label, liveTranscodeKey)) {
      playUrl(transcoded, label, upstreamAuth, hideNativeProgressBar, false, liveTranscodeKey);
      return;
    }
  }
  playUrl(url, label, upstreamAuth, hideNativeProgressBar, true, liveTranscodeKey);
}

/** Lecteur VOD : `<video>` et instance HLS séparées du direct TV. */
function playVodUrl(url: string, label: string, upstreamAuth?: Record<string, string>): void {
  if (!elVideoVod || !elNowPlayingVod) return;
  if (isTrialBlocked()) {
    showTrialExpiredModal();
    return;
  }
  setVodPlayerBufferingVisible(true);
  startVodFakeLoadingOverlay("Preparation du flux...");
  teardownVodMedia();
  const sessionId = ++vodPlaybackSessionId;
  attachNodecastStatusPollingForPlayback();
  elVideoVod.preload = "metadata";
  elVideoVod.crossOrigin = "anonymous";
  lockDownVodNativeUi(elVideoVod);
  const proxied = proxiedUrl(url);
  applyVodTranscodeSessionMeta(getNodecastTranscodeSessionMeta(url));
  syncVodControlVisibility(elVideoVod);
  lastVodProxiedUrl = proxied;
  lastVodUpstreamAuth = upstreamAuth;
  vodRemountAttempts = 0;
  vodLastRemountTs = 0;
  elNowPlayingVod.innerHTML = nowPlayingLiveMarkup(label);
  showVodPlayerChrome(true);

  if (urlLooksLikeProgressiveMedia(url) || urlLooksLikeProgressiveMedia(proxied)) {
    elVideoVod.src = proxied;
    attachVodPlaybackHelpers(elVideoVod);
    playVodAggressive(elVideoVod);
    return;
  }

  if (Hls.isSupported()) {
    void (async () => {
      await waitForHlsStartupBuffer(proxied);
      if (sessionId !== vodPlaybackSessionId) return;
      mountHlsVod(proxied, elVideoVod, upstreamAuth, { autoPlayOnManifest: false });
      if (sessionId !== vodPlaybackSessionId) return;
      attachVodPlaybackHelpers(elVideoVod);
      await waitForStartupBuffer(elVideoVod);
      if (sessionId !== vodPlaybackSessionId) return;
      playVodAggressive(elVideoVod);
    })();
    return;
  }

  setVodPlayerBufferingVisible(false);
  elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
    "HLS non pris en charge dans ce navigateur."
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nowPlayingLiveMarkup(title: string): string {
  return `<div class="vel-live-ticker" role="status">
  <div class="vel-live-ticker__meta">

    <strong class="vel-live-ticker__title">${escapeHtml(title)}</strong>
  </div>
</div>`;
}

function nowPlayingErrorMarkup(message: string): string {
  return `<div class="vel-live-ticker vel-live-ticker--error" role="alert">
  <span class="vel-live-ticker__badge vel-live-ticker__badge--alert" aria-hidden="true">!</span>
  <p class="vel-live-ticker__error">${escapeHtml(message)}</p>
</div>`;
}

function setLoginStatus(msg: string, isError = false): void {
  elLoginStatus.textContent = msg;
  elLoginStatus.classList.toggle("error", isError);
}

/** Couleurs d’accent du chargement catalogue : alignées sur DIRECT TV (V), FILMS (I), SÉRIES (P). */
type CatalogLoadAccent = "live" | "movies" | "series";

const CATALOG_LOAD_PALETTE: Record<
  CatalogLoadAccent,
  { primary: string; primarySoft: string; glow: string; phase: string }
> = {
  live: {
    primary: "#7c3aed",
    primarySoft: "#a78bfa",
    glow: "rgba(167, 139, 250, 0.48)",
    phase: "0",
  },
  movies: {
    primary: "#0284c7",
    primarySoft: "#38bdf8",
    glow: "rgba(56, 189, 248, 0.48)",
    phase: "0.08",
  },
  series: {
    primary: "#d97706",
    primarySoft: "#fbbf24",
    glow: "rgba(245, 158, 11, 0.48)",
    phase: "0.16",
  },
};

function setCatalogLoadingVisible(
  visible: boolean,
  statusText?: string,
  accent: CatalogLoadAccent = "live"
): void {
  const el = elCatalogLoadingOverlay;
  if (!el) return;
  if (visible) {
    const p = CATALOG_LOAD_PALETTE[accent];
    el.style.setProperty("--cat-load-primary", p.primary);
    el.style.setProperty("--cat-load-primary-soft", p.primarySoft);
    el.style.setProperty("--cat-load-glow", p.glow);
    el.style.setProperty("--cat-load-phase", p.phase);
    el.dataset.catLoadAccent = accent;
  } else {
    el.style.removeProperty("--cat-load-primary");
    el.style.removeProperty("--cat-load-primary-soft");
    el.style.removeProperty("--cat-load-glow");
    el.style.removeProperty("--cat-load-phase");
    delete el.dataset.catLoadAccent;
  }
  if (elCatalogLoadingStatus) {
    if (visible && statusText) {
      elCatalogLoadingStatus.textContent = statusText;
    } else if (!visible) {
      elCatalogLoadingStatus.textContent = "Chargement du catalogue…";
    }
  }
  el.classList.toggle("hidden", !visible);
  el.setAttribute("aria-hidden", visible ? "false" : "true");
}

function envAutoConnectConfigured(): boolean {
  const u = import.meta.env.VITE_NODECAST_URL?.trim();
  const n = import.meta.env.VITE_NODECAST_USERNAME?.trim();
  return Boolean(u && n);
}

/** Full page refresh (F5, location.reload, etc.). Used to skip env autoconnect. */
function isNavigationReload(): boolean {
  try {
    const entries = performance.getEntriesByType("navigation");
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === "reload") return true;
  } catch {
    /* ignore */
  }
  try {
    const legacy = (
      performance as unknown as {
        navigation?: { type?: number };
      }
    ).navigation;
    /* 1 === PerformanceNavigationTiming.TYPE_RELOAD */
    if (legacy?.type === 1) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function applyNodecastEnvDefaults(): void {
  if (!envAutoConnectConfigured()) return;
  elServer.value = import.meta.env.VITE_NODECAST_URL!.trim();
  elUser.value = import.meta.env.VITE_NODECAST_USERNAME!.trim();
  elPass.value =
    typeof import.meta.env.VITE_NODECAST_PASSWORD === "string"
      ? import.meta.env.VITE_NODECAST_PASSWORD
      : "";
}

/** Skip the login card: show main shell with a loading line until `connect()` finishes. */
function prepareEnvAutoconnectUi(): void {
  elHeaderLoginOnly?.classList.add("hidden");
  elLoginPanel.classList.add("hidden");
  elMain.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elPackagesView.classList.remove("hidden");
  elPackagesView.innerHTML = "";
}

function syncPillDefsForPackage(packageId: string): void {
  const leaves = adminConfig.categories
    .filter((c) => c.package_id === packageId)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  pillDefs = [
    ALL_PILL,
    ...leaves.map((c) => ({ id: `custom:${c.id}`, label: c.name })),
  ];
  if (!pillDefs.some((p) => p.id === selectedPillId)) {
    selectedPillId = "all";
  }
}

function streamsAfterPill(base: LiveStream[], pillId: PillId): LiveStream[] {
  if (pillId === "all") return base;
  return base;
}

function updatePillsVisibility(): void {
  const show = uiShell === "content" && uiTab === "live" && uiAdminPackageId != null;
  if (!show) {
    elCatPillsWrap.classList.add("hidden");
    return;
  }
  const hasExtra = pillDefs.length > 1;
  elCatPillsWrap.classList.toggle("hidden", !hasExtra);
}

function renderCategoryPills(): void {
  if (!state || uiAdminPackageId == null) return;
  /** Films / séries : pas de pastilles live, mais la liste des titres doit s’afficher. */
  if (uiTab === "movies" || uiTab === "series") {
    elCatPills.innerHTML = "";
    updatePillsVisibility();
    renderPackageChannelList();
    return;
  }
  if (uiTab !== "live") return;
  elCatPills.innerHTML = "";
  if (!pillDefs.some((p) => p.id === selectedPillId)) {
    selectedPillId = "all";
  }
  for (const p of pillDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-pill";
    btn.setAttribute("role", "tab");
    btn.dataset.pillId = p.id;
    if (p.id === selectedPillId) btn.classList.add("active");
    btn.textContent = p.label;
    btn.title = p.label;
    btn.addEventListener("click", () => {
      selectedPillId = p.id;
      elCatPills.querySelectorAll(".cat-pill").forEach((b) => {
        b.classList.toggle("active", (b as HTMLButtonElement).dataset.pillId === p.id);
      });
      renderPackageChannelList();
    });
    elCatPills.appendChild(btn);
  }
  updatePillsVisibility();
  renderPackageChannelList();
}

function showAdminChannelCurateTools(): boolean {
  return Boolean(isAdminSession() && readAdminGridToolsEnabled() && getSupabaseClient());
}

/**
 * If the catalogue pays has no matching `admin_countries` row yet, create one with the same
 * display name so curations (masquer / déplacer) can be stored.
 */
async function ensureSupabaseCountryForSelection(): Promise<string | null> {
  const existing = resolvedDbCountryIdForAdminPackages();
  if (existing) return existing;
  const sb = getSupabaseClient();
  if (!sb) return null;
  const label = currentCountryDisplayLabel()?.trim();
  if (!label) return null;
  const reuse = matchDbCountryIdByDisplayName(label, dbAdminCountries);
  if (reuse) return reuse;
  const { error } = await sb.from("admin_countries").insert({ name: label });
  if (error) {
    const msg = `Impossible de créer le pays « ${label} » dans Supabase : ${error.message}`;
    flashCurateStatus(msg, true);
    await refreshSupabaseHierarchy();
    return matchedDbCountryIdForSelection();
  }
  await refreshSupabaseHierarchy();
  return matchedDbCountryIdForSelection();
}

async function persistStreamCuration(streamId: number, targetPackageId: string): Promise<boolean> {
  const sb = getSupabaseClient();
  if (!sb) {
    flashCurateStatus("Supabase non configuré.", true);
    return false;
  }
  let cid = resolvedDbCountryIdForAdminPackages();
  if (!cid) {
    cid = await ensureSupabaseCountryForSelection();
  }
  if (!cid) {
    flashCurateStatus(
      "Enregistrement impossible : pays introuvable en base ou droits Supabase (admin_countries / admin_stream_curations).",
      true
    );
    return false;
  }
  const res = await upsertStreamCuration(sb, {
    stream_id: streamId,
    country_id: cid,
    target_package_id: targetPackageId,
  });
  if (res.error) {
    flashCurateStatus(
      `Enregistrement chaîne : ${res.error}. Vérifiez la table admin_stream_curations et la contrainte unique (stream_id, country_id).`,
      true
    );
    return false;
  }
  let inner = streamCurationByCountry.get(cid);
  if (!inner) {
    inner = new Map();
    streamCurationByCountry.set(cid, inner);
  }
  inner.set(streamId, targetPackageId);
  if (targetPackageId === STREAM_CURATION_HIDDEN) {
    if (uiAdminPackageId) invalidatePackageImageThemeCache(uiAdminPackageId);
  } else {
    invalidatePackageImageThemeCache(targetPackageId);
    if (uiAdminPackageId && uiAdminPackageId !== targetPackageId) {
      invalidatePackageImageThemeCache(uiAdminPackageId);
    }
  }
  if (state && uiShell === "content" && uiTab === "live" && uiAdminPackageId) {
    applyThemeForPackage(findPackageById(uiAdminPackageId) ?? null);
  }
  return true;
}

function populateChannelAssignPackageSelect(): void {
  if (!elChannelAssignSelect) return;
  elChannelAssignSelect.innerHTML = "";
  const pkgs = augmentChannelAssignPackagesFromDb(mergedPackagesForGrid());
  for (const p of pkgs) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    elChannelAssignSelect.appendChild(o);
  }
  if (uiAdminPackageId && [...elChannelAssignSelect.options].some((o) => o.value === uiAdminPackageId)) {
    elChannelAssignSelect.value = uiAdminPackageId;
  }
}

function openChannelAssignDialog(streamIds: number | number[]): void {
  if (!elDialogChannelAssign || !elChannelAssignSelect) return;
  const rawList = Array.isArray(streamIds) ? streamIds : [streamIds];
  const normalized = [...new Set(rawList.filter((id) => Number.isFinite(id)).map((id) => Number(id)))];
  if (normalized.length < 1) return;
  pendingAssignStreamIds = normalized;
  elChannelAssignStatus && (elChannelAssignStatus.textContent = "");
  elChannelAssignStatus?.classList.remove("error");
  if (elChannelAssignTitle) {
    elChannelAssignTitle.textContent =
      normalized.length > 1 ? "Affecter les chaînes" : "Affecter la chaîne";
  }
  if (elChannelAssignHint) {
    elChannelAssignHint.textContent =
      normalized.length > 1
        ? `${normalized.length} chaînes sélectionnées. Choisissez un bouquet du pays actuel. Elles disparaissent de leur bouquet d’origine pour tous les visiteurs.`
        : "Choisissez un bouquet du pays actuel. La chaîne disparaît du bouquet d’origine pour tous les visiteurs.";
  }
  if (elChannelAssignOk) {
    elChannelAssignOk.textContent = normalized.length > 1 ? "Déplacer la sélection" : "OK";
  }
  populateChannelAssignPackageSelect();
  elDialogChannelAssign.showModal();
}

function closeChannelAssignDialog(): void {
  pendingAssignStreamIds = [];
  elDialogChannelAssign?.close();
}

function syncAdminAddChannelsButton(): void {
  const wrap = document.getElementById("vel-admin-add-channels-wrap");
  if (!wrap) return;
  const show =
    showAdminChannelCurateTools() &&
    state != null &&
    uiShell === "content" &&
    uiTab === "live" &&
    uiAdminPackageId != null;
  wrap.classList.toggle("hidden", !show);
}

/** Chaînes du pays hors de ce bouquet (liste courante + règles), pour import admin. */
function candidatesStreamsNotInOpenPackage(packageId: string): LiveStream[] {
  if (!state) return [];
  const inside = new Set(streamsDisplayedForOpenPackage(packageId).map((s) => s.stream_id));
  return unionStreamsForCurrentCountry()
    .filter((s) => !inside.has(s.stream_id) && !shouldHideChannelByName(s.name))
    .sort((a, b) => displayChannelName(a.name).localeCompare(displayChannelName(b.name), "fr"));
}

/** Bouquet catalogue / curation où la chaîne apparaît aujourd’hui (hors bouquet ouvert). */
function liveStreamCurrentCatalogPackageName(streamId: number): string {
  if (!state) return "—";
  const cur = curationMapForSelection()?.get(streamId) ?? null;
  if (cur === STREAM_CURATION_HIDDEN) return "Masquée (curation)";
  if (cur && cur.length > 0) {
    const p = findPackageById(cur);
    return p?.name ?? cur;
  }
  const s = unionStreamsForCurrentCountry().find((x) => x.stream_id === streamId);
  if (!s) return "—";
  if (isSelectedCountryFrance()) {
    const syn = autoSynthPackageIdForStreamName(s.name, true);
    if (syn) {
      const p = findPackageById(syn);
      return p?.name ?? syn;
    }
  }
  for (const pkg of mergedPackagesForGrid()) {
    if (isLikelyUuid(pkg.id)) continue;
    const natives = state.streamsByCatAll.get(pkg.id) ?? [];
    if (natives.some((r) => r.stream_id === streamId)) return pkg.name;
  }
  return "Catalogue";
}

function filterAddChannelsListRows(): void {
  if (!elAddChannelsSearch || !elAddChannelsList) return;
  const q = elAddChannelsSearch.value.trim().toLowerCase();
  elAddChannelsList.querySelectorAll(".add-channels-row").forEach((rowEl) => {
    const row = rowEl as HTMLElement;
    const hay = (row.dataset.searchHay ?? "").toLowerCase();
    row.classList.toggle("hidden", q.length > 0 && !hay.includes(q));
  });
}

function buildAddChannelsDialogList(packageId: string): void {
  if (!elAddChannelsList) return;
  elAddChannelsList.innerHTML = "";
  const cand = candidatesStreamsNotInOpenPackage(packageId);
  for (const s of cand) {
    const row = document.createElement("div");
    row.className = "add-channels-row";
    const pkgName = liveStreamCurrentCatalogPackageName(s.stream_id);
    const hay = `${displayChannelName(s.name)} ${s.name} ${pkgName}`.replace(/\s+/g, " ").trim();
    row.dataset.searchHay = hay;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `add-ch-${s.stream_id}`;
    cb.dataset.streamId = String(s.stream_id);
    const body = document.createElement("div");
    body.className = "add-channels-row__body";
    const lab = document.createElement("label");
    lab.htmlFor = cb.id;
    lab.textContent = displayChannelName(s.name);
    lab.title = s.name;
    const pkgEl = document.createElement("span");
    pkgEl.className = "add-channels-row__package";
    pkgEl.textContent = `Bouquet actuel : ${pkgName}`;
    body.append(lab, pkgEl);
    row.append(cb, body);
    elAddChannelsList.appendChild(row);
  }
  if (cand.length === 0) {
    const p = document.createElement("p");
    p.className = "vel-empty-msg";
    p.style.margin = "0.5rem 0";
    p.textContent =
      "Aucune chaîne disponible ailleurs pour ce pays (ou elles sont déjà dans ce bouquet).";
    elAddChannelsList.appendChild(p);
  }
}

function openAddChannelsToPackageDialog(): void {
  if (!elDialogAddChannels || !uiAdminPackageId || !state) return;
  if (!showAdminChannelCurateTools()) return;
  const pkg = findPackageById(uiAdminPackageId);
  const label = pkg?.name ?? uiAdminPackageId;
  if (elAddChannelsHint) {
    elAddChannelsHint.textContent = `Destination : bouquet « ${label} ». Chaque ligne indique le bouquet actuel de la chaîne. L’ajout la retire des autres bouquets de ce pays.`;
  }
  if (elAddChannelsSearch) elAddChannelsSearch.value = "";
  elAddChannelsStatus && (elAddChannelsStatus.textContent = "");
  elAddChannelsStatus?.classList.remove("error");
  buildAddChannelsDialogList(uiAdminPackageId);
  filterAddChannelsListRows();
  elDialogAddChannels.showModal();
}

function closeAddChannelsToPackageDialog(): void {
  elDialogAddChannels?.close();
}

function syncCatalogBackButtonLabel(): void {
  const lab = elBtnBackHome.querySelector(".back-btn__text");
  if (adultPortalMode && uiShell === "content") {
    if (lab) lab.textContent = "Adultes";
    elBtnBackHome.classList.remove("hidden");
    elBtnGoHome?.classList.remove("hidden");
    return;
  }
  const inDetail =
    uiShell === "content" &&
    ((uiTab === "movies" && vodMovieUiPhase === "detail") ||
      (uiTab === "series" && seriesUiPhase === "detail"));
  if (lab) lab.textContent = "Liste";
  elBtnBackHome.classList.toggle("hidden", !inDetail);
  elBtnGoHome?.classList.remove("hidden");
}

function returnToCurrentPackageListFromToolbar(): void {
  if (adultPortalMode && uiShell === "content") {
    void showAdultPortal(adultPortalTab);
    return;
  }
  if (uiShell !== "content" || uiAdminPackageId == null) {
    showPackagesShell();
    return;
  }
  if (uiTab === "movies") {
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    destroyVodPlayer();
    activeStreamId = null;
    renderPackageChannelList();
    syncCatalogBackButtonLabel();
    stripVeloraHistorySilently(Math.min(veloraUiHistoryDepth, 1));
    smoothVeloraMainScrollTop();
    return;
  }
  if (uiTab === "series") {
    seriesUiPhase = "list";
    seriesDetailStream = null;
    destroyVodPlayer();
    activeStreamId = null;
    renderPackageChannelList();
    syncCatalogBackButtonLabel();
    stripVeloraHistorySilently(Math.min(veloraUiHistoryDepth, 1));
    smoothVeloraMainScrollTop();
    return;
  }
  renderPackageChannelList();
  smoothVeloraMainScrollTop();
}

function catalogPosterRowLooksPlaying(s: LiveStream): boolean {
  if (activeStreamId !== s.stream_id) return false;
  if (s.nodecast_media === "vod") {
    return Boolean(elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden"));
  }
  return Boolean(elPlayerContainer && !elPlayerContainer.classList.contains("hidden"));
}

/** Notes renvoyées par `vod_streams` (rating ~ /10, rating_5based ~ /5). */
function vodStreamsRowRatingLabel(s: LiveStream): string | null {
  if (s.vod_rating != null && Number.isFinite(s.vod_rating)) {
    return `★ ${s.vod_rating.toFixed(1)}`;
  }
  if (s.vod_rating_5based != null && Number.isFinite(s.vod_rating_5based)) {
    return `★ ${s.vod_rating_5based.toFixed(1)}/5`;
  }
  return null;
}

function normalizeListingHeadingSource(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Bouquets télé : mise en forme lisible sans sur-normaliser les marques réelles (CANAL+, beIN Sports…). */
function prettifyLiveChannelLabel(displayName: string): string {
  const t = displayName.replace(/\|/g, " · ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const flat = normalizeListingHeadingSource(t).replace(/\s+/g, "");
  const nk = normalizeListingHeadingSource(t);
  if (flat.includes("bein") && flat.includes("sport")) return "beIN Sports";
  if (flat.includes("rmcsport")) return "RMC Sport";
  if (/^rmc /.test(nk) && /\bsport\b/.test(nk)) return "RMC Sport";
  if (/canal\s*\+\s*|canal\s*±\s*|canalplus/i.test(displayName.trim())) return "CANAL+";
  if (nk === "france") return "Chaînes France";
  if (nk === "sport" || nk === "sports") return "Chaînes sport";
  return displayName.trim().replace(/\s+/g, " ");
}

function velCategoryHeadingTheme(normPackage: string, normEffective: string): string {
  const blob = `${normPackage} ${normEffective}`;
  if (
    /\b(sport|rugby|foot|liga|match|motogp|nba|ufc|golf|tennis)\b/.test(blob) ||
    /bein|rmc\s*sport|dazn|eurosport|winamax|sport\+/.test(blob)
  ) {
    return "vel-category-heading--sport";
  }
  if (/\baction\b|\bthriller\b|\bcrime\b|aventures?/.test(blob)) return "vel-category-heading--action";
  if (/enfant|kids|junior|cartoon|animations?|anime|dessin/.test(blob)) return "vel-category-heading--kids";
  if (/horreur|horror|terror|gore|\bslasher\b/.test(blob)) return "vel-category-heading--horror";
  if (/comed|humour|comedy|sitcom/.test(blob)) return "vel-category-heading--comedy";
  return "vel-category-heading--neutral";
}

function frenchMoviesCatalogTitle(normRaw: string): string | null {
  const norm = normalizeListingHeadingSource(normRaw);
  if (!norm) return null;
  if (/populaire|\bpopular\b/.test(norm)) return "Films populaires";
  if (/tendance|trending|\bbuzz\b|\btrends?\b/.test(norm)) return "Films tendances";
  if (/\bsci[- ]fi\b|\bsci fi\b|\bscience.fiction\b/.test(norm)) return "Films science-fiction";
  if (/\baction\b|\bactions\b/.test(norm)) return "Films d\u2019action";
  if (/comed|\bcomedy\b|humour|\bhumor\b|\bcomedies?\b/.test(norm)) return "Films comédie";
  if (/drame\b|\bdrama\b|dramati/.test(norm)) return "Films dramatiques";
  if (/horreur|\bhorror\b/.test(norm)) return "Films horreur";
  if (/\bthriller\b|\bthrillers\b/.test(norm)) return "Films thriller";
  if (/\bcrime\b|polici/.test(norm)) return "Films crime";
  if (/romance|romanti/.test(norm)) return "Films romance";
  if (/animations?|\banime\b|dessin anime/.test(norm)) return "Films animation";
  if (/documentaire|documentary/.test(norm)) return "Films documentaires";
  if (/famil|famille|\bfamily\b|tout.public/.test(norm)) return "Films famille";
  return null;
}

function frenchSeriesCatalogTitle(normRaw: string): string | null {
  const norm = normalizeListingHeadingSource(normRaw);
  if (!norm) return null;
  if (/populaire|\bpopular\b/.test(norm)) return "Séries populaires";
  if (/tendance|trending|\bbuzz\b|\btrends?\b/.test(norm)) return "Séries tendances";
  if (/drame\b|\bdrama\b|dramati/.test(norm)) return "Séries dramatiques";
  if (/comed|\bcomedy\b|sitcom|\bhumor\b|\bhumour\b/.test(norm)) return "Séries comédie";
  if (/\bcrime\b|polici/.test(norm)) return "Séries crime";
  if (/\bthriller\b/.test(norm)) return "Séries thriller";
  if (/\baction\b|\bactions\b/.test(norm)) return "Séries d\u2019action";
  return null;
}

function readableCatalogFallbackTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return prettifyLiveChannelLabel(t.replace(/_/g, " "));
}

/** Titre liste (bouquet ou pastille sélectionnée). */
function resolveVelListingHeading(kind: "live" | "movies" | "series"): {
  title: string;
  headingClassSuffix: string;
  liveAccent: boolean;
} {
  const pkgMeta = uiAdminPackageId ? findPackageById(uiAdminPackageId) : undefined;
  const packageRaw = ((pkgMeta?.name ?? "").trim() || uiAdminPackageId || "").trim();
  let focusRaw = packageRaw;

  if (kind === "live" && selectedPillId !== "all") {
    const lab = pillDefs.find((p) => p.id === selectedPillId)?.label.trim();
    if (lab) focusRaw = lab;
  }

  const normPkg = normalizeListingHeadingSource(packageRaw);
  const normFocus = normalizeListingHeadingSource(focusRaw || packageRaw);
  const headingClassSuffix = velCategoryHeadingTheme(normPkg, normFocus);

  if (kind === "live") {
    const t = prettifyLiveChannelLabel(focusRaw || packageRaw || "Catalogue");
    return { title: t || "Catalogue", headingClassSuffix, liveAccent: true };
  }

  if (kind === "movies") {
    const guessed =
      frenchMoviesCatalogTitle(focusRaw) ??
      frenchMoviesCatalogTitle(packageRaw) ??
      frenchMoviesCatalogTitle(`${focusRaw} ${packageRaw}`);
    const fb = readableCatalogFallbackTitle(focusRaw || packageRaw);
    return {
      title: guessed ?? (fb ? fb : "Films"),
      headingClassSuffix,
      liveAccent: false,
    };
  }

  const guessedS =
    frenchSeriesCatalogTitle(focusRaw) ??
    frenchSeriesCatalogTitle(packageRaw) ??
    frenchSeriesCatalogTitle(`${focusRaw} ${packageRaw}`);
  const fbS = readableCatalogFallbackTitle(focusRaw || packageRaw);
  return {
    title: guessedS ?? (fbS ? fbS : "Séries"),
    headingClassSuffix,
    liveAccent: false,
  };
}

/** En-tête de section pour grilles Chaînes / Films / Séries (hors fiche détail). */
function prependVelListingCategoryHeader(mediaKind: UiTab): void {
  if (!uiAdminPackageId) return;
  const key = mediaKind === "live" ? "live" : mediaKind === "movies" ? "movies" : "series";
  const { title, headingClassSuffix, liveAccent } = resolveVelListingHeading(key);
  if (!title) return;

  const el = document.createElement("header");
  el.className = `vel-category-heading ${headingClassSuffix}`;
  if (liveAccent) el.classList.add("vel-category-heading--live-accent");

  const h = document.createElement("h2");
  h.className = "vel-category-heading__title";
  h.textContent = title;

  const line = document.createElement("span");
  line.className = "vel-category-heading__accent-line";
  line.setAttribute("aria-hidden", "true");

  el.append(h, line);
  elDynamicList.prepend(el);
}

const EPISODE_ROW_PLAY_SVG =
  '<svg class="vel-vod-detail__episode-play" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 6v12l10-6z"/></svg>';

function renderCatalogPosterGrid(streams: LiveStream[], tab: CatalogMediaTab): void {
  if (!state) return;
  const st = state;
  prependVelListingCategoryHeader(tab === "movies" ? "movies" : "series");
  const emptyEmoji = tab === "movies" ? "🎬" : "📺";
  const adminTools = showAdminChannelCurateTools() && uiAdminPackageId != null;
  let priorityImageSlots = 8;
  for (const s of streams) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "vel-vod-movie-card";
    card.dataset.streamId = String(s.stream_id);
    if (catalogPosterRowLooksPlaying(s)) {
      card.classList.add("vel-vod-movie-card--active");
    }

    const media = document.createElement("div");
    media.className = "vel-vod-movie-card__media";

    const poster = document.createElement("div");
    poster.className = "vel-vod-movie-card__poster";
    const iconHref = resolvedIconUrl(s.stream_icon, st.base);
    if (iconHref) {
      const img = document.createElement("img");
      img.alt = "";
      const priority = priorityImageSlots > 0;
      if (priority) priorityImageSlots--;
      wireImageLoadingState(img, priority, poster);
      img.src = posterImageSrc(iconHref);
      img.addEventListener("error", () => {
        poster.innerHTML = "";
        poster.classList.add("vel-vod-movie-card__poster--empty");
        poster.textContent = emptyEmoji;
        poster.setAttribute("aria-hidden", "true");
      });
      poster.appendChild(img);
    } else {
      poster.classList.add("vel-vod-movie-card__poster--empty");
      poster.textContent = emptyEmoji;
      poster.setAttribute("aria-hidden", "true");
    }

    media.appendChild(poster);

    if (tab === "movies") {
      const ratingLabel = vodStreamsRowRatingLabel(s);
      if (ratingLabel) {
        const badge = document.createElement("span");
        badge.className = "vel-vod-movie-card__rating-badge";
        badge.textContent = ratingLabel;
        badge.setAttribute("aria-label", `Note ${ratingLabel}`);
        media.appendChild(badge);
      }
    }

    const body = document.createElement("div");
    body.className = "vel-vod-movie-card__body";
    const title = document.createElement("span");
    title.className = "vel-vod-movie-card__title";
    const titleText = displayChannelName(s.name);
    title.textContent = titleText;
    title.title = titleText;
    body.appendChild(title);

    card.append(media, body);
    if (adminTools) {
      const tools = document.createElement("div");
      tools.className = "vel-media-item-tools";

      const btnAssign = document.createElement("button");
      btnAssign.type = "button";
      btnAssign.className = "vel-media-item-tool vel-media-item-tool--assign";
      btnAssign.title = "Affecter à un bouquet";
      btnAssign.setAttribute("aria-label", "Affecter à un bouquet");
      btnAssign.textContent = "➡️";
      btnAssign.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openChannelAssignDialog(s.stream_id);
      });

      const btnRemove = document.createElement("button");
      btnRemove.type = "button";
      btnRemove.className = "vel-media-item-tool vel-media-item-tool--remove";
      btnRemove.title = "Retirer ce contenu";
      btnRemove.setAttribute("aria-label", "Retirer ce contenu");
      btnRemove.textContent = "🗑️";
      btnRemove.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!window.confirm("Retirer ce contenu de toutes les listes ?")) return;
        void (async () => {
          const ok = await persistStreamCuration(s.stream_id, STREAM_CURATION_HIDDEN);
          if (ok) renderPackageChannelList();
        })();
      });

      tools.append(btnAssign, btnRemove);
      card.appendChild(tools);
    }
    card.addEventListener("click", () => {
      if (tab === "movies") {
        vodDetailStream = s;
        vodMovieUiPhase = "detail";
      } else {
        seriesDetailStream = s;
        seriesUiPhase = "detail";
      }
      destroyVodPlayer();
      activeStreamId = null;
      renderPackageChannelList();
      syncCatalogBackButtonLabel();
      veloraPushNavigationState("vod-detail");
      smoothVeloraMainScrollTop();
    });

    elDynamicList.appendChild(card);
  }

  if (streams.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.textContent =
      tab === "movies" ? "Aucun film dans ce bouquet." : "Aucune série dans ce bouquet.";
    elDynamicList.appendChild(empty);
  }
}

/** Backdrop / poster URL for VOD hero: TMDB profile matched to content width × DPR, then proxy rules. */
function vodHeroBackgroundDisplayUrl(rawHttps: string): string {
  const w = Math.max(240, elContentView.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 800));
  return imageUrlForDisplay(rawHttps, w);
}

const vodFilmDetailHeroBgResizeObservers = new WeakMap<HTMLDivElement, ResizeObserver>();

/** Painted height for `background-size: 100% auto` (width × aspect), capped to the hero box. */
function syncVodFilmDetailHeroPaintedHeight(bg: HTMLDivElement): void {
  const nw = Number(bg.dataset.velHeroNatW);
  const nh = Number(bg.dataset.velHeroNatH);
  if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw <= 0 || nh <= 0) {
    bg.style.removeProperty("--vel-vod-hero-img-h");
    return;
  }
  const w = bg.clientWidth;
  if (w <= 0) {
    bg.style.removeProperty("--vel-vod-hero-img-h");
    return;
  }
  const painted = Math.round((w * nh) / nw);
  const cap = bg.clientHeight || painted;
  bg.style.setProperty("--vel-vod-hero-img-h", `${Math.min(painted, cap)}px`);
}

function ensureVodFilmDetailHeroResizeObserver(bg: HTMLDivElement): void {
  if (vodFilmDetailHeroBgResizeObservers.has(bg)) return;
  const ro = new ResizeObserver(() => {
    syncVodFilmDetailHeroPaintedHeight(bg);
  });
  ro.observe(bg);
  vodFilmDetailHeroBgResizeObservers.set(bg, ro);
}

function teardownVodFilmDetailHeroHeight(bg: HTMLDivElement): void {
  const ro = vodFilmDetailHeroBgResizeObservers.get(bg);
  if (ro) {
    ro.disconnect();
    vodFilmDetailHeroBgResizeObservers.delete(bg);
  }
  bg.style.removeProperty("--vel-vod-hero-img-h");
  delete bg.dataset.velHeroNatW;
  delete bg.dataset.velHeroNatH;
}

/** Précharge le visuel puis l’affiche (évite l’affiche carte → swap backdrop). */
function preloadVodDetailHeroBackground(
  bg: HTMLDivElement,
  primaryUrl: string,
  fallbackUrl: string | null,
  isStill: () => boolean
): void {
  const apply = (url: string, naturalW: number, naturalH: number) => {
    if (!isStill()) return;
    bg.classList.remove("vel-vod-detail__bg--loading");
    bg.classList.remove("vel-vod-detail__bg--entered");
    bg.style.backgroundImage = `url("${url}")`;
    void bg.offsetWidth;
    bg.classList.add("vel-vod-detail__bg--entered");
    if (naturalW > 0 && naturalH > 0) {
      bg.dataset.velHeroNatW = String(naturalW);
      bg.dataset.velHeroNatH = String(naturalH);
      ensureVodFilmDetailHeroResizeObserver(bg);
      const bump = () => syncVodFilmDetailHeroPaintedHeight(bg);
      bump();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!isStill()) return;
          bump();
        });
      });
    } else {
      teardownVodFilmDetailHeroHeight(bg);
    }
  };

  const attempt = (url: string, allowIconFallback: boolean) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => apply(url, img.naturalWidth, img.naturalHeight);
    img.onerror = () => {
      if (!isStill()) return;
      if (allowIconFallback && fallbackUrl && url !== fallbackUrl) {
        bg.classList.remove("vel-vod-detail__bg--poster");
        attempt(fallbackUrl, false);
        return;
      }
      teardownVodFilmDetailHeroHeight(bg);
      bg.classList.remove("vel-vod-detail__bg--loading", "vel-vod-detail__bg--entered");
      bg.style.backgroundImage = "";
    };
    img.src = url;
  };

  attempt(primaryUrl, Boolean(fallbackUrl));
}

/** Masque « Regarder » (films uniquement) si ce titre joue dans le lecteur VOD ouvert. */
function shouldHideCatalogRegarderButtonMovie(s: LiveStream): boolean {
  if (activeStreamId !== s.stream_id) return false;
  return Boolean(elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden"));
}

function appendCatalogEpisodesSkeleton(listEl: HTMLDivElement): void {
  listEl.classList.add("vel-vod-detail__episodes--skeleton");
  for (let i = 0; i < 5; i++) {
    const row = document.createElement("div");
    row.className = "vel-vod-detail__episode-skeleton";
    row.setAttribute("aria-hidden", "true");
    const badge = document.createElement("div");
    badge.className = "vel-vod-detail__episode-skeleton__badge";
    const lines = document.createElement("div");
    lines.className = "vel-vod-detail__episode-skeleton__lines";
    const l1 = document.createElement("div");
    l1.className = "vel-vod-detail__episode-skeleton__line vel-vod-detail__episode-skeleton__line--long";
    const l2 = document.createElement("div");
    l2.className = "vel-vod-detail__episode-skeleton__line vel-vod-detail__episode-skeleton__line--short";
    lines.append(l1, l2);
    row.append(badge, lines);
    listEl.appendChild(row);
  }
}

function renderCatalogMediaDetailView(s: LiveStream, tab: CatalogMediaTab): void {
  if (!state) return;
  const st = state;
  const streamTitle = displayChannelName(s.name);
  const sid = st.nodecastXtreamSourceId?.trim();
  const iconHref = resolvedIconUrl(s.stream_icon, st.base);

  const wrap = document.createElement("article");
  wrap.className = tab === "series" ? "vel-vod-detail vel-vod-detail--series" : "vel-vod-detail";
  wrap.setAttribute("aria-label", streamTitle);

  const bg = document.createElement("div");
  bg.className = "vel-vod-detail__bg vel-vod-detail__bg--loading";

  const inner = document.createElement("div");
  inner.className = "vel-vod-detail__inner";

  const titleEl = document.createElement("h1");
  titleEl.className = "vel-vod-detail__title";
  titleEl.textContent = streamTitle;

  const metaRow = document.createElement("div");
  metaRow.className = "vel-vod-detail__meta";

  const ratingEl = document.createElement("span");
  ratingEl.className = "vel-vod-detail__rating";
  ratingEl.textContent = "…";

  const genreEl = document.createElement("span");
  genreEl.className = "vel-vod-detail__genre";

  metaRow.append(ratingEl, genreEl);

  const plot = document.createElement("p");
  plot.className = "vel-vod-detail__plot";
  plot.textContent = "Chargement de la fiche…";

  const castBlock = document.createElement("section");
  castBlock.className = "vel-vod-detail__section";
  const castH = document.createElement("h2");
  castH.className = "vel-vod-detail__section-title";
  castH.textContent = "Distribution";
  const castP = document.createElement("p");
  castP.className = "vel-vod-detail__cast";
  castP.textContent = "—";
  castBlock.append(castH, castP);

  const directorBlock = document.createElement("section");
  directorBlock.className = "vel-vod-detail__section";
  const dirH = document.createElement("h2");
  dirH.className = "vel-vod-detail__section-title";
  dirH.textContent = "Réalisation";
  const dirP = document.createElement("p");
  dirP.className = "vel-vod-detail__director";
  dirP.textContent = "—";
  directorBlock.append(dirH, dirP);

  let episodesListEl: HTMLDivElement | null = null;
  let seasonToolbarEl: HTMLDivElement | null = null;
  let seasonSelectEl: HTMLSelectElement | null = null;
  /** Présent uniquement sur les fiches film (pas série). */
  let btnWatch: HTMLButtonElement | null = null;
  if (tab === "series") {
    const episodesSection = document.createElement("section");
    episodesSection.className =
      "vel-vod-detail__section vel-vod-detail__episodes-section vel-vod-detail__episodes-section--loading";
    episodesSection.setAttribute("aria-busy", "true");
    const episodesH = document.createElement("h2");
    episodesH.className = "vel-vod-detail__section-title";
    episodesH.textContent = "Épisodes";
    const seasonToolbar = document.createElement("div");
    seasonToolbar.className = "vel-vod-detail__season-toolbar hidden";
    const seasonLabel = document.createElement("label");
    seasonLabel.className = "vel-vod-detail__season-label";
    const seasonSelectId = `vel-series-season-${s.stream_id}`;
    seasonLabel.htmlFor = seasonSelectId;
    seasonLabel.textContent = "Saison";
    const seasonSelect = document.createElement("select");
    seasonSelect.id = seasonSelectId;
    seasonSelect.className = "vel-vod-detail__season-select";
    seasonSelect.setAttribute("aria-label", "Choisir la saison");
    seasonToolbar.append(seasonLabel, seasonSelect);
    seasonToolbarEl = seasonToolbar;
    seasonSelectEl = seasonSelect;
    episodesListEl = document.createElement("div");
    episodesListEl.className = "vel-vod-detail__episodes";
    appendCatalogEpisodesSkeleton(episodesListEl);
    episodesSection.append(episodesH, seasonToolbar, episodesListEl);
    inner.append(titleEl, metaRow, plot, castBlock, directorBlock, episodesSection);
  } else {
    btnWatch = document.createElement("button");
    btnWatch.type = "button";
    btnWatch.className = "vel-vod-detail__watch vel-vod-detail__watch--film primary";
    btnWatch.textContent = "Regarder";
    btnWatch.setAttribute("aria-label", `Regarder « ${streamTitle} »`);
    btnWatch.classList.toggle("hidden", shouldHideCatalogRegarderButtonMovie(s));
    btnWatch.addEventListener("click", () => {
      activeStreamId = s.stream_id;
      startVodFakeLoadingOverlay("Préparation du film…");
      btnWatch!.classList.add("hidden");
      void (async () => {
        await playStreamByMode(s);
        btnWatch!.classList.toggle("hidden", shouldHideCatalogRegarderButtonMovie(s));
      })();
      smoothVeloraMainScrollTop();
    });
    inner.append(titleEl, btnWatch, metaRow, plot, castBlock, directorBlock);
  }

  wrap.append(bg, inner);
  elDynamicList.appendChild(wrap);

  const requestedId = s.stream_id;
  const noPlotCopy =
    tab === "movies"
      ? "Aucune description disponible pour ce titre."
      : "Aucune description disponible pour cette série.";

  void (async () => {
    const isStill = () =>
      tab === "movies"
        ? vodDetailStream?.stream_id === requestedId && uiTab === "movies"
        : seriesDetailStream?.stream_id === requestedId && uiTab === "series";

    const info =
      sid && sid.length > 0
        ? tab === "movies"
          ? await fetchNodecastVodInfo(st.base, sid, requestedId, st.nodecastAuthHeaders, streamTitle)
          : await fetchNodecastSeriesInfo(st.base, sid, requestedId, st.nodecastAuthHeaders, streamTitle)
        : null;
    if (!state || !isStill()) return;

    const displayTitle = (info?.title || streamTitle).trim() || streamTitle;
    titleEl.textContent = displayTitle;
    if (btnWatch) btnWatch.setAttribute("aria-label", `Regarder « ${displayTitle} »`);

    const rd = (info?.ratingDisplay ?? "").trim();
    if (rd) {
      ratingEl.textContent = `★ ${rd}`;
    } else {
      ratingEl.textContent = "";
      ratingEl.classList.add("vel-vod-detail__rating--empty");
    }

    const gn = (info?.genre ?? "").trim();
    genreEl.textContent = gn;
    genreEl.classList.toggle("hidden", !gn);

    plot.textContent = (info?.plot ?? "").trim() || noPlotCopy;

    const c = (info?.cast ?? "").trim();
    castP.textContent = c || "Non communiqué.";

    const d = (info?.director ?? "").trim();
    dirP.textContent = d || "—";
    directorBlock.classList.toggle("hidden", !d);

    const backdrop = info?.backdropUrl?.trim();
    const poster = info?.posterUrl?.trim();
    const fallbackIcon = iconHref ? proxiedUrl(iconHref) : null;
    if (backdrop) {
      bg.classList.remove("vel-vod-detail__bg--poster");
      preloadVodDetailHeroBackground(bg, vodHeroBackgroundDisplayUrl(backdrop), fallbackIcon, isStill);
    } else if (poster) {
      bg.classList.add("vel-vod-detail__bg--poster");
      preloadVodDetailHeroBackground(bg, vodHeroBackgroundDisplayUrl(poster), fallbackIcon, isStill);
    } else if (fallbackIcon) {
      bg.classList.remove("vel-vod-detail__bg--poster");
      preloadVodDetailHeroBackground(bg, fallbackIcon, null, isStill);
    } else {
      teardownVodFilmDetailHeroHeight(bg);
      bg.classList.remove("vel-vod-detail__bg--loading", "vel-vod-detail__bg--entered");
      bg.style.backgroundImage = "";
    }

    if (tab === "series" && episodesListEl) {
      const episodesSection = episodesListEl.parentElement;
      const episodes = info?.episodes ?? [];
      episodesListEl.classList.remove("vel-vod-detail__episodes--skeleton");
      const seasons = uniqueSortedSeasonsFromEpisodes(episodes);

      const appendEpisodeRows = (eps: SeriesEpisodeListItem[]) => {
        const fragment = document.createDocumentFragment();
        for (const ep of eps) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "vel-vod-detail__episode";
          const badge = document.createElement("span");
          badge.className = "vel-vod-detail__episode-badge";
          badge.textContent = `S${ep.seasonNumber}E${ep.episodeNum}`;
          const body = document.createElement("span");
          body.className = "vel-vod-detail__episode-body";
          const titleSpan = document.createElement("span");
          titleSpan.className = "vel-vod-detail__episode-title";
          titleSpan.textContent = displayChannelName(ep.title);
          titleSpan.title = ep.title;
          body.appendChild(titleSpan);
          if (ep.duration) {
            const meta = document.createElement("span");
            meta.className = "vel-vod-detail__episode-meta";
            meta.textContent = ep.duration;
            body.appendChild(meta);
          }
          const playWrap = document.createElement("span");
          playWrap.className = "vel-vod-detail__episode-play-wrap";
          playWrap.innerHTML = EPISODE_ROW_PLAY_SVG;
          row.append(badge, playWrap, body);
          const epTitleTrim = String(ep.title ?? "").trim();
          row.setAttribute(
            "aria-label",
            `Lire épisode ${ep.seasonNumber}×${ep.episodeNum}${epTitleTrim ? ` — ${ep.title}` : ""}`
          );
          row.dataset.episodeStreamId = String(ep.episodeStreamId);
          row.addEventListener("click", () => {
            const epStream: LiveStream = {
              stream_id: ep.episodeStreamId,
              name: ep.title,
              nodecast_source_id: s.nodecast_source_id,
              nodecast_media: "vod",
              nodecast_series_episode: true,
              container_extension: ep.containerExtension,
            };
            activeStreamId = ep.episodeStreamId;
            startVodFakeLoadingOverlay("Préparation de l’épisode…");
            syncSeriesEpisodePlaybackHighlight();
            void playStreamByMode(epStream);
            smoothVeloraMainScrollTop();
          });
          fragment.appendChild(row);
        }
        episodesListEl.replaceChildren(fragment);
        syncSeriesEpisodePlaybackHighlight();
      };

      const rebuildForSeason = (seasonNum: number | null) => {
        const eps =
          seasonNum == null || !Number.isFinite(seasonNum)
            ? episodes
            : episodes.filter((e) => e.seasonNumber === seasonNum);
        appendEpisodeRows(eps);
      };

      if (episodes.length > 0) {
        const playingSeason = episodes.find((e) => e.episodeStreamId === activeStreamId)?.seasonNumber;
        let selectedSeason: number | null =
          playingSeason != null && Number.isFinite(playingSeason) && seasons.includes(playingSeason)
            ? playingSeason
            : seasons.length > 0
              ? seasons[0]
              : null;

        if (seasons.length > 1 && seasonToolbarEl && seasonSelectEl) {
          seasonToolbarEl.classList.remove("hidden");
          seasonSelectEl.replaceChildren();
          for (const sn of seasons) {
            const opt = document.createElement("option");
            opt.value = String(sn);
            opt.textContent = `Saison ${sn}`;
            seasonSelectEl.appendChild(opt);
          }
          if (selectedSeason != null) {
            seasonSelectEl.value = String(selectedSeason);
          }
          seasonSelectEl.onchange = () => {
            const sn = Number(seasonSelectEl!.value);
            if (Number.isFinite(sn)) rebuildForSeason(sn);
          };
          rebuildForSeason(selectedSeason);
        } else {
          seasonToolbarEl?.classList.add("hidden");
          if (seasonSelectEl) seasonSelectEl.onchange = null;
          rebuildForSeason(selectedSeason);
        }
      } else {
        seasonToolbarEl?.classList.add("hidden");
        if (seasonSelectEl) seasonSelectEl.onchange = null;
        const empty = document.createElement("p");
        empty.className = "vel-vod-detail__episodes-empty";
        empty.textContent =
          !sid || sid.length === 0
            ? "Catalogue indisponible pour charger les épisodes."
            : "Aucun épisode listé pour cette série.";
        episodesListEl.replaceChildren(empty);
        syncSeriesEpisodePlaybackHighlight();
      }
      if (episodesSection) {
        episodesSection.classList.remove("vel-vod-detail__episodes-section--loading");
        episodesSection.setAttribute("aria-busy", "false");
        episodesSection.classList.add("vel-vod-detail__episodes-section--ready");
      }
    }

    if (btnWatch) btnWatch.classList.toggle("hidden", shouldHideCatalogRegarderButtonMovie(s));
  })();
}

function renderPackageChannelList(): void {
  try {
    if (!state || uiAdminPackageId == null) return;
    const base = streamsDisplayedForOpenPackage(uiAdminPackageId);
  const filtered = streamsAfterPill(base, selectedPillId).filter(
    (s) => adultPortalMode || !shouldHideChannelByName(s.name)
  );
  const adminTools = showAdminChannelCurateTools();

  elDynamicList.innerHTML = "";

  if (uiTab === "movies") {
    if (vodMovieUiPhase === "detail" && vodDetailStream) {
      elDynamicList.classList.remove("item-list--vod-vertical");
      elDynamicList.classList.add("item-list--vod-film-detail");
      elContentView.classList.add("content-view--vod-film-detail");
      renderCatalogMediaDetailView(vodDetailStream, "movies");
    } else {
      elDynamicList.classList.remove("item-list--vod-film-detail");
      elContentView.classList.remove("content-view--vod-film-detail");
      elDynamicList.classList.add("item-list--vod-vertical");
      renderCatalogPosterGrid(filtered, "movies");
    }
    syncCatalogBackButtonLabel();
    syncAdminAddChannelsButton();
    return;
  }

  if (uiTab === "series") {
    if (seriesUiPhase === "detail" && seriesDetailStream) {
      elDynamicList.classList.remove("item-list--vod-vertical");
      elDynamicList.classList.add("item-list--vod-film-detail");
      elContentView.classList.add("content-view--vod-film-detail");
      renderCatalogMediaDetailView(seriesDetailStream, "series");
    } else {
      elDynamicList.classList.remove("item-list--vod-film-detail");
      elContentView.classList.remove("content-view--vod-film-detail");
      elDynamicList.classList.add("item-list--vod-vertical");
      renderCatalogPosterGrid(filtered, "series");
    }
    syncCatalogBackButtonLabel();
    syncAdminAddChannelsButton();
    return;
  }

  elDynamicList.classList.remove("item-list--vod-vertical", "item-list--vod-film-detail");
  elContentView.classList.remove("content-view--vod-film-detail");

  const pkgIdForDrag = uiAdminPackageId;
  const alphaIdsForDrag =
    pkgIdForDrag != null ? liveStreamsAlphaForPackage(pkgIdForDrag).map((x) => x.stream_id) : [];
  const visibleIdSetForDrag = new Set(filtered.map((x) => x.stream_id));
  for (const sid of [...selectedAdminChannelStreamIds]) {
    if (!visibleIdSetForDrag.has(sid)) selectedAdminChannelStreamIds.delete(sid);
  }

  prependVelListingCategoryHeader("live");

  let priorityImageSlots = 8;
  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "vel-media-item-row";
    row.dataset.streamId = String(s.stream_id);
    if (activeStreamId === s.stream_id) row.classList.add("vel-media-item-row--active");

    if (adminTools) {
      const selectCb = document.createElement("input");
      selectCb.type = "checkbox";
      selectCb.className = "vel-channel-select";
      selectCb.checked = selectedAdminChannelStreamIds.has(s.stream_id);
      selectCb.title = "Sélectionner pour déplacement groupé";
      selectCb.setAttribute("aria-label", `Sélectionner ${displayChannelName(s.name)}`);
      selectCb.addEventListener("click", (ev) => {
        ev.stopPropagation();
      });
      selectCb.addEventListener("change", () => {
        if (selectCb.checked) selectedAdminChannelStreamIds.add(s.stream_id);
        else selectedAdminChannelStreamIds.delete(s.stream_id);
      });
      row.appendChild(selectCb);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "media-item media-item__main";
    if (activeStreamId === s.stream_id) btn.classList.add("selected");

    const thumb = document.createElement("div");
    thumb.className = "media-item__thumb";
    const iconHref = resolvedIconUrl(s.stream_icon, state.base);
    if (iconHref) {
      const img = document.createElement("img");
      img.alt = "";
      const priority = priorityImageSlots > 0;
      if (priority) priorityImageSlots--;
      wireImageLoadingState(img, priority, thumb);
      img.src = thumbImageSrc(iconHref);
      img.addEventListener("error", () => {
        thumb.innerHTML = "";
        thumb.classList.add("media-item__thumb--empty");
        thumb.textContent = "📺";
        thumb.setAttribute("aria-hidden", "true");
      });
      thumb.appendChild(img);
    } else {
      thumb.classList.add("media-item__thumb--empty");
      thumb.textContent = "📺";
      thumb.setAttribute("aria-hidden", "true");
    }

    const info = document.createElement("div");
    info.className = "media-info";
    const h4 = document.createElement("h4");
    const titleText = displayChannelName(s.name);
    h4.textContent = titleText;
    h4.title = titleText;
    info.appendChild(h4);
    const playingBadge = document.createElement("span");
    playingBadge.className = "vel-channel-playing-badge";
    playingBadge.textContent = "En lecture";
    playingBadge.classList.toggle("hidden", activeStreamId !== s.stream_id);
    info.appendChild(playingBadge);
    const epgId = s.epg_channel_id;
    if (typeof epgId === "string" && epgId.trim()) {
      const p = document.createElement("p");
      p.textContent = `EPG : ${epgId}`;
      info.appendChild(p);
    }
    btn.appendChild(thumb);
    btn.appendChild(info);
    btn.addEventListener("click", () => {
      activeStreamId = s.stream_id;
      elDynamicList.querySelectorAll(".vel-media-item-row").forEach((wrapEl) => {
        const wrap = wrapEl as HTMLElement;
        const sid = wrap.dataset.streamId;
        wrap.classList.toggle("vel-media-item-row--active", sid === String(s.stream_id));
        wrap.querySelector(".media-item__main")?.classList.toggle("selected", sid === String(s.stream_id));
        wrap
          .querySelector(".vel-channel-playing-badge")
          ?.classList.toggle("hidden", sid !== String(s.stream_id));
      });
      void playStreamByMode(s);
      showPlayerChrome(true);
    });

    if (adminTools && pkgIdForDrag != null) {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "vel-channel-drag-handle";
      handle.title = "Glisser pour réorganiser";
      handle.setAttribute("aria-label", "Réorganiser la chaîne");
      const grip = document.createElement("span");
      grip.className = "vel-channel-drag-handle__grip";
      grip.setAttribute("aria-hidden", "true");
      grip.textContent = "⠿";
      handle.appendChild(grip);

      let allowDrag = false;
      handle.addEventListener("mousedown", () => {
        allowDrag = true;
      });
      handle.addEventListener("mouseup", () => {
        allowDrag = false;
      });
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        if (!allowDrag) {
          e.preventDefault();
          return;
        }
        allowDrag = false;
        row.classList.add("vel-media-item-row--dragging");
        e.dataTransfer?.setData("text/plain", String(s.stream_id));
        e.dataTransfer?.setData("application/x-velora-stream-id", String(s.stream_id));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("vel-media-item-row--dragging");
        elDynamicList.querySelectorAll(".vel-media-item-row--drop-target").forEach((el) => {
          el.classList.remove("vel-media-item-row--drop-target");
        });
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        row.classList.add("vel-media-item-row--drop-target");
        row.dataset.dropBefore = before ? "1" : "0";
      });
      row.addEventListener("dragleave", (e) => {
        const rel = e.relatedTarget as Node | null;
        if (rel && row.contains(rel)) return;
        row.classList.remove("vel-media-item-row--drop-target");
        delete row.dataset.dropBefore;
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("vel-media-item-row--drop-target");
        const raw = e.dataTransfer?.getData("text/plain") || e.dataTransfer?.getData("application/x-velora-stream-id");
        const draggedId = Number(raw);
        if (!Number.isFinite(draggedId) || !pkgIdForDrag) return;
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        delete row.dataset.dropBefore;
        const rows = [
          ...elDynamicList.querySelectorAll<HTMLElement>(".vel-media-item-row[data-stream-id]"),
        ];
        const visibleIds = rows.map((r) => Number(r.dataset.streamId)).filter(Number.isFinite);
        const fromIdx = visibleIds.indexOf(draggedId);
        const toIdx = visibleIds.indexOf(Number(row.dataset.streamId));
        if (fromIdx < 0 || toIdx < 0) return;
        const newVisibleOrder = reorderVisibleStreamIds(visibleIds, fromIdx, toIdx, before);
        const prevSaved = getPackageChannelOrder(pkgIdForDrag);
        const fullOrder = prevSaved?.length ? prevSaved : [...alphaIdsForDrag];
        const merged = mergeVisibleReorder(fullOrder, visibleIdSetForDrag, newVisibleOrder);
        void (async () => {
          await persistPackageChannelOrder(pkgIdForDrag, merged);
          renderPackageChannelList();
        })();
      });

      row.appendChild(handle);
    }

    row.appendChild(btn);

    if (adminTools) {
      const tools = document.createElement("div");
      tools.className = "vel-media-item-tools";

      const btnAssign = document.createElement("button");
      btnAssign.type = "button";
      btnAssign.className = "vel-media-item-tool vel-media-item-tool--assign";
      btnAssign.title = "Affecter à un bouquet";
      btnAssign.setAttribute("aria-label", "Affecter à un bouquet");
      btnAssign.textContent = "➡️";
      btnAssign.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const selectedIds = selectedAdminChannelStreamIds.has(s.stream_id)
          ? [...selectedAdminChannelStreamIds]
          : [s.stream_id];
        openChannelAssignDialog(selectedIds);
      });

      const btnRemove = document.createElement("button");
      btnRemove.type = "button";
      btnRemove.className = "vel-media-item-tool vel-media-item-tool--remove";
      btnRemove.title = "Retirer cette chaîne";
      btnRemove.setAttribute("aria-label", "Retirer cette chaîne");
      btnRemove.textContent = "🗑️";
      btnRemove.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const selectedIds = selectedAdminChannelStreamIds.has(s.stream_id)
          ? [...selectedAdminChannelStreamIds]
          : [s.stream_id];
        const confirmMsg =
          selectedIds.length > 1
            ? `Retirer ces ${selectedIds.length} chaînes de toutes les listes ?`
            : "Retirer cette chaîne de toutes les listes ?";
        if (!window.confirm(confirmMsg)) return;
        void (async () => {
          let ok = 0;
          for (const sid of selectedIds) {
            if (await persistStreamCuration(sid, STREAM_CURATION_HIDDEN)) ok++;
          }
          if (ok > 0) {
            selectedIds.forEach((sid) => selectedAdminChannelStreamIds.delete(sid));
            renderPackageChannelList();
          }
        })();
      });

      tools.append(btnAssign, btnRemove);
      row.appendChild(tools);
    }

    elDynamicList.appendChild(row);
  }

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vel-empty-msg";
      empty.textContent =
        uiAdminPackageId && isLikelyUuid(uiAdminPackageId)
          ? "Ce bouquet Supabase n’a pas encore de catégories / règles liées au catalogue fournisseur dans la base."
          : "Aucune chaîne dans cette catégorie.";
      elDynamicList.appendChild(empty);
    }

    syncAdminAddChannelsButton();
  } finally {
    schedulePersistVeloraUiRoute();
  }
}

function providerLayoutForUiTab(): AdminConfig {
  if (uiTab === "movies") return vodAdminConfig;
  if (uiTab === "series") return seriesAdminConfig;
  return adminConfig;
}

const GLOBAL_COUNTRY_OTHER_KEY = "__autres__";

/** Same rules as catalogue / Supabase country matching (ASCII lower, strip accents). */
function normalizeCountryLabel(value: string): string {
  return normalizeCountryKey(value);
}

function normalizeCountryDisplayKey(name: string): string {
  return normalizeCountryKey(name);
}

function countryNameForIdInLayout(countryId: string, layout: AdminConfig): string | null {
  return layout.countries.find((c) => c.id === countryId)?.name?.trim() || null;
}

function getCountryDisplayNameFromLayout(countryId: string, layout: AdminConfig): string | null {
  return countryNameForIdInLayout(countryId, layout);
}

function getCountryDisplayNameFromAnySource(countryId: string): string | null {
  for (const layout of [adminConfig, vodAdminConfig, seriesAdminConfig]) {
    const n = getCountryDisplayNameFromLayout(countryId, layout);
    if (n) return n;
  }
  if (isLikelyUuid(countryId)) {
    const d = dbAdminCountries.find((c) => c.id === countryId);
    const n = d?.name?.trim();
    if (n) return n;
  }
  return null;
}

function countryGlobalMergeKeyFromCountryRow(c: AdminCountry): string {
  if (c.id === OTHER_COUNTRY_ID) return GLOBAL_COUNTRY_OTHER_KEY;
  const nk = normalizeCountryLabel(c.name);
  return nk.length ? nk : GLOBAL_COUNTRY_OTHER_KEY;
}

type GlobalCountrySource = "live" | "movies" | "series" | "supabase";

type GlobalCountryRowAcc = {
  mergeKey: string;
  displayName: string;
  idLive?: string;
  idSupabase?: string;
  idMovies?: string;
  idSeries?: string;
  sortHint: number;
  sources: Set<GlobalCountrySource>;
};

function buildGlobalCountryRowsForSelect(): AdminCountry[] {
  const byKey = new Map<string, GlobalCountryRowAcc>();

  const touch = (c: AdminCountry, source: GlobalCountrySource, hint: number): void => {
    const mergeKey = countryGlobalMergeKeyFromCountryRow(c);
    let row = byKey.get(mergeKey);
    if (!row) {
      row = {
        mergeKey,
        displayName: c.name.trim(),
        sortHint: hint,
        sources: new Set(),
      };
      byKey.set(mergeKey, row);
    }
    row.sources.add(source);
    row.sortHint = Math.min(row.sortHint, hint);
    if (source === "supabase") {
      row.idSupabase = c.id;
      row.displayName = c.name.trim();
    } else if (source === "live") {
      row.idLive = c.id;
      if (!row.idSupabase) row.displayName = c.name.trim();
    } else if (source === "movies") {
      row.idMovies = c.id;
      if (!row.idSupabase && !row.idLive) row.displayName = c.name.trim();
    } else if (source === "series") {
      row.idSeries = c.id;
      if (!row.idSupabase && !row.idLive && !row.idMovies) row.displayName = c.name.trim();
    }
  };

  dbAdminCountries.forEach((c, i) => touch(c, "supabase", i));
  adminConfig.countries.forEach((c, i) => touch(c, "live", 1000 + i));
  vodAdminConfig.countries.forEach((c, i) => touch(c, "movies", 2000 + i));
  seriesAdminConfig.countries.forEach((c, i) => touch(c, "series", 3000 + i));

  const internal = [...byKey.values()];
  internal.sort((a, b) => {
    if (a.mergeKey === GLOBAL_COUNTRY_OTHER_KEY) return 1;
    if (b.mergeKey === GLOBAL_COUNTRY_OTHER_KEY) return -1;
    if (a.mergeKey === "france") return -1;
    if (b.mergeKey === "france") return 1;
    const cmp = a.displayName.localeCompare(b.displayName, "fr");
    if (cmp !== 0) return cmp;
    return a.sortHint - b.sortHint;
  });

  const out: AdminCountry[] = [];
  for (const row of internal) {
    if (isAdultLabel(row.displayName)) continue;
    const id = row.idLive ?? row.idSupabase ?? row.idMovies ?? row.idSeries;
    if (!id) continue;
    out.push({ id, name: row.displayName });
  }

  if (isVeloraCatalogCacheDebugEnabled()) {
    console.info("[Velora] Global country list", {
      count: out.length,
      first50Names: out.slice(0, 50).map((c) => c.name),
      first50Sources: out.slice(0, 50).map((c) => {
        const mk = countryGlobalMergeKeyFromCountryRow(c);
        const acc = byKey.get(mk);
        return acc ? [...acc.sources].sort().join("+") : "?";
      }),
    });
  }

  return out;
}

/** Pays du header : une seule liste fusionnée (Live + Films + Séries + Supabase), identique sur tous les onglets. */
function countryRowsForSelect(): AdminCountry[] {
  return buildGlobalCountryRowsForSelect();
}

function selectedCountryMatchesPackage(
  packageCountryId: string,
  selectedCountryId: string,
  layout: AdminConfig
): boolean {
  if (!selectedCountryId) return false;
  if (packageCountryId === selectedCountryId) return true;

  const pkgName =
    getCountryDisplayNameFromLayout(packageCountryId, layout) ??
    (isLikelyUuid(packageCountryId)
      ? dbAdminCountries.find((c) => c.id === packageCountryId)?.name.trim() ?? null
      : null);
  const selName = getCountryDisplayNameFromAnySource(selectedCountryId);
  if (!pkgName || !selName) return false;

  if (normalizeCountryLabel(pkgName) === normalizeCountryLabel(selName)) return true;

  const dbPkg = matchDbCountryIdByDisplayName(pkgName, dbAdminCountries);
  const dbSel = matchDbCountryIdByDisplayName(selName, dbAdminCountries);
  if (dbPkg && dbSel && dbPkg === dbSel) return true;
  if (dbPkg && packageCountryId === dbPkg) return true;
  if (dbSel && packageCountryId === dbSel) return true;
  if (dbPkg && selectedCountryId === dbPkg) return true;
  if (dbSel && selectedCountryId === dbSel) return true;

  const canonPkg = matchCanonicalCountry(pkgName);
  const canonSel = matchCanonicalCountry(selName);
  if (canonPkg && canonSel) {
    if (canonPkg.id === canonSel.id) return true;
    if (normalizeCountryLabel(canonPkg.name) === normalizeCountryLabel(canonSel.name)) return true;
  }

  return false;
}

/** `VITE_DEFAULT_COUNTRY`: id exact, sinon nom affiché (normalisé comme le catalogue). */
function defaultCountryIdFromEnv(countries: AdminCountry[]): string | null {
  const raw = import.meta.env.VITE_DEFAULT_COUNTRY?.trim();
  if (!raw) return null;
  if (countries.some((c) => c.id === raw)) return raw;
  const nk = normalizeCountryKey(raw);
  if (!nk) return null;
  const hit = countries.find((c) => normalizeCountryKey(c.name) === nk);
  return hit?.id ?? null;
}

/** France si présente, sinon premier pays hors « Autres », sinon « Autres » (ne dépend pas de l’onglet ni des bouquets). */
function pickDefaultCountryIdForGlobalList(countries: AdminCountry[]): string | null {
  if (countries.length === 0) return null;
  const fr = countries.find((c) => normalizeCountryLabel(c.name) === "france");
  if (fr) return fr.id;
  const regular = countries.filter(
    (c) => c.id !== OTHER_COUNTRY_ID && normalizeCountryLabel(c.name) !== "autres"
  );
  if (regular.length) {
    regular.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return regular[0].id;
  }
  const autres = countries.find((c) => c.id === OTHER_COUNTRY_ID);
  return autres?.id ?? countries[0]?.id ?? null;
}

function resolveCountryIdToValidGlobalId(
  candidateId: string | null | undefined,
  countries: AdminCountry[]
): string | null {
  if (!candidateId) return null;
  if (countries.some((c) => c.id === candidateId)) return candidateId;
  const label = getCountryDisplayNameFromAnySource(candidateId);
  if (!label) return null;
  const nk = normalizeCountryLabel(label);
  const isAutres =
    candidateId === OTHER_COUNTRY_ID ||
    nk === "autres" ||
    label.trim().toLowerCase() === "autres";
  const hit = countries.find((c) => {
    if (isAutres) {
      return c.id === OTHER_COUNTRY_ID || normalizeCountryLabel(c.name) === "autres";
    }
    return normalizeCountryLabel(c.name) === nk;
  });
  return hit?.id ?? null;
}

function ensureSelectedCountry(): void {
  const countries = countryRowsForSelect();
  if (countries.length === 0) {
    selectedAdminCountryId = null;
    return;
  }
  const fromCurrent = resolveCountryIdToValidGlobalId(selectedAdminCountryId, countries);
  if (fromCurrent) {
    selectedAdminCountryId = fromCurrent;
    return;
  }
  try {
    const stored = sessionStorage.getItem(COUNTRY_STORAGE_KEY);
    const fromStored = resolveCountryIdToValidGlobalId(stored, countries);
    if (fromStored) {
      selectedAdminCountryId = fromStored;
      return;
    }
  } catch {
    /* ignore */
  }
  const fromEnv = defaultCountryIdFromEnv(countries);
  if (fromEnv) {
    selectedAdminCountryId = fromEnv;
    return;
  }
  selectedAdminCountryId = pickDefaultCountryIdForGlobalList(countries);
}

function populateCountrySelectFromAdmin(): void {
  elCountrySelect.innerHTML = "";
  const countries = countryRowsForSelect();
  if (countries.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.disabled = true;
    o.selected = true;
    o.textContent = "Aucun pays";
    elCountrySelect.appendChild(o);
    elCountrySelect.disabled = true;
    return;
  }
  elCountrySelect.disabled = false;
  ensureSelectedCountry();
  for (const c of countries) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === selectedAdminCountryId) o.selected = true;
    elCountrySelect.appendChild(o);
  }
}

function readAdminGridToolsEnabled(): boolean {
  if (!isAdminSession()) return false;
  try {
    if (localStorage.getItem(ADMIN_GRID_TOOLS_KEY) === "0") return false;
  } catch {
    /* ignore */
  }
  return true;
}

/** Grille bouquets : Live, Films ou Séries (overrides image + thème comme le live). */
function isPackagesGridTab(): boolean {
  return uiTab === "live" || uiTab === "movies" || uiTab === "series";
}

function syncAdminGridToolsToggleFromStorage(): void {
  if (!elToggleAdminUi) return;
  const on = readAdminGridToolsEnabled();
  elToggleAdminUi.checked = on;
  elToggleAdminUi.setAttribute("aria-checked", on ? "true" : "false");
}

function syncAdminSettingsButton(): void {
  const admin = isAdminSession();
  elBtnSettings?.classList.toggle("hidden", !admin);
  elVelAdminToolsWrap?.classList.toggle("hidden", !admin);
  elBtnLogout?.classList.toggle("hidden", !admin);
  elMain.classList.toggle("main--velora-admin", admin);
  if (admin) syncAdminGridToolsToggleFromStorage();
}

tryConsumeAdminAccessFromUrl();
syncAdminSettingsButton();
applySettingsRouteOnLoad();

elBtnSettings?.addEventListener("click", () => {
  openSettingsPage();
});

elToggleAdminUi?.addEventListener("change", () => {
  try {
    localStorage.setItem(ADMIN_GRID_TOOLS_KEY, elToggleAdminUi.checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  elToggleAdminUi.setAttribute("aria-checked", elToggleAdminUi.checked ? "true" : "false");
  if (!elToggleAdminUi.checked && elDialogAddPkg.open) {
    elDialogAddPkg.close();
  }
  if (!elToggleAdminUi.checked && elDialogChannelAssign?.open) {
    closeChannelAssignDialog();
  }
  if (!elToggleAdminUi.checked && elDialogPackageCover?.open) {
    elDialogPackageCover.close();
  }
  if (!elToggleAdminUi.checked && elDialogAddChannels?.open) {
    closeAddChannelsToPackageDialog();
  }
  if (state && uiShell === "packages") {
    renderPackagesGrid();
  }
  if (state && uiShell === "content" && uiAdminPackageId) {
    renderPackageChannelList();
  }
  syncAdminAddChannelsButton();
});

window.addEventListener("popstate", () => {
  if (veloraIgnoreHistoryPopstate) {
    veloraIgnoreHistoryPopstate = false;
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  const appEl = document.querySelector(".app");
  if (appEl?.classList.contains("hidden")) {
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  const liveOpen = !elPlayerContainer.classList.contains("hidden");
  const vodOpen = Boolean(elVodPlayerContainer && !elVodPlayerContainer.classList.contains("hidden"));

  if (liveOpen) {
    veloraApplyingHistoryPopstate = true;
    activeStreamId = null;
    destroyPlayer();
    veloraApplyingHistoryPopstate = false;
    veloraUiHistoryDepth = Math.max(0, veloraUiHistoryDepth - 1);
    syncSeriesEpisodePlaybackHighlight();
    syncSeriesDetailEpisodePlayingLayout();
    if (state && uiShell === "content" && uiAdminPackageId != null) {
      renderPackageChannelList();
    }
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  if (vodOpen) {
    veloraApplyingHistoryPopstate = true;
    activeStreamId = null;
    destroyVodPlayer();
    veloraApplyingHistoryPopstate = false;
    veloraUiHistoryDepth = Math.max(0, veloraUiHistoryDepth - 1);
    syncSeriesEpisodePlaybackHighlight();
    syncSeriesDetailEpisodePlayingLayout();
    if (state && uiShell === "content" && uiAdminPackageId != null) {
      renderPackageChannelList();
    }
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  if (uiShell === "content" && uiTab === "movies" && vodMovieUiPhase === "detail") {
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    veloraUiHistoryDepth = Math.max(0, veloraUiHistoryDepth - 1);
    if (state && uiAdminPackageId != null) {
      renderPackageChannelList();
    }
    syncCatalogBackButtonLabel();
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  if (uiShell === "content" && uiTab === "series" && seriesUiPhase === "detail") {
    seriesUiPhase = "list";
    seriesDetailStream = null;
    veloraUiHistoryDepth = Math.max(0, veloraUiHistoryDepth - 1);
    if (state && uiAdminPackageId != null) {
      renderPackageChannelList();
    }
    syncCatalogBackButtonLabel();
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  if (uiShell === "content" && uiAdminPackageId != null) {
    veloraUiHistoryDepth = Math.max(0, veloraUiHistoryDepth - 1);
    applyPackagesShellUi();
    tryConsumeAdminAccessFromUrl();
    syncAdminSettingsButton();
    syncSettingsFromUrl();
    return;
  }

  tryConsumeAdminAccessFromUrl();
  syncAdminSettingsButton();
  syncSettingsFromUrl();
});

window.addEventListener("velora-admin-session-changed", () => {
  syncAdminSettingsButton();
  void refreshSupabaseHierarchy().then(() => {
    if (state && uiShell === "packages") renderPackagesGrid();
    if (state && uiShell === "content" && uiAdminPackageId) {
      renderPackageChannelList();
    }
    syncAdminAddChannelsButton();
  });
});

window.addEventListener("velora-settings-closed", () => {
  applyVeloraShellBgToMain(elMain);
  if (state) {
    void (async () => {
      await fetchAndApplyCanonicalCountries();
      await fetchAndApplyChannelNamePrefixes();
      await fetchAndApplyChannelHideNeedles();
      await refreshSupabaseHierarchy();
      if (uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
    })();
  }
  if (envAutoConnectConfigured() && !state) {
    prepareEnvAutoconnectUi();
    void connect();
  }
});

window.addEventListener("velora-global-packages-changed", () => {
  if (!state) return;
  void refreshSupabaseHierarchy().then(() => {
    if (uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
  });
});

/** Bouquets fournisseur (live / VOD / séries) pour le pays sélectionné dans le header. */
function packagesForSelectedCountry(): AdminPackage[] {
  const layout = providerLayoutForUiTab();
  const sel = selectedAdminCountryId;
  if (!sel) return [];

  if (uiTab === "movies" || uiTab === "series") {
    const selectedName = selectedCountryDisplayName();
    const selectedKey = selectedName ? normalizeCountryDisplayKey(selectedName) : "";
    if (!selectedKey) return [];

    return layout.packages
      .filter((pkg) => {
        if (isAdultPackage(pkg, layout, uiTab)) return false;
        const pkgCountryName = countryNameForIdInLayout(pkg.country_id, layout);
        if (
          pkgCountryName &&
          normalizeCountryDisplayKey(pkgCountryName) === selectedKey
        ) {
          return true;
        }
        return selectedCountryMatchesPackage(pkg.country_id, sel, layout);
      })
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  return layout.packages
    .filter((p) => selectedCountryMatchesPackage(p.country_id, sel, layout))
    .filter((p) => !isAdultPackage(p, layout, uiTab))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function logVeloraSelectedCountryPackagesDebug(): void {
  if (!isVeloraCatalogCacheDebugEnabled()) return;
  const packages = packagesForSelectedCountry();
  const layout = providerLayoutForUiTab();
  console.info("[Velora catalog] UI package selection debug", {
    current_selected_country_id: selectedAdminCountryId,
    current_selected_country_name: currentCountryDisplayLabel(),
    active_tab: uiTab,
    packagesForSelectedCountry_count: packages.length,
    packagesForSelectedCountry_first_20: packages.slice(0, 20).map((pkg) => ({
      packageName: pkg.name,
      countryName: getCountryDisplayNameFromLayout(pkg.country_id, layout) ?? pkg.country_id,
      itemCount:
        uiTab === "movies"
          ? state?.vodStreamsByCat.get(String(pkg.id))?.length ?? 0
          : uiTab === "series"
            ? state?.seriesStreamsByCat.get(String(pkg.id))?.length ?? 0
            : state?.streamsByCatAll.get(String(pkg.id))?.length ?? 0,
    })),
  });
}

function currentCountryDisplayLabel(): string | null {
  return selectedCountryDisplayName();
}

function selectedCountryDisplayName(): string | null {
  if (!selectedAdminCountryId) return null;

  const fromGlobal = countryRowsForSelect()
    .find((c) => c.id === selectedAdminCountryId)
    ?.name?.trim();
  if (fromGlobal) return fromGlobal;

  for (const layout of [adminConfig, vodAdminConfig, seriesAdminConfig]) {
    const n = countryNameForIdInLayout(selectedAdminCountryId, layout);
    if (n) return n;
  }

  const db = dbAdminCountries.find((c) => c.id === selectedAdminCountryId)?.name?.trim();
  if (db) return db;

  return null;
}

if (import.meta.env.DEV || isVeloraCatalogCacheDebugEnabled()) {
  (window as Window & { veloraDebugMedia?: () => void }).veloraDebugMedia = function (): void {
    const vodCountries = vodAdminConfig.countries.map((c) => ({
      id: c.id,
      name: c.name,
      packages: vodAdminConfig.packages.filter((p) => p.country_id === c.id).length,
      items: vodAdminConfig.packages
        .filter((p) => p.country_id === c.id)
        .reduce((sum, p) => sum + (state?.vodStreamsByCat.get(String(p.id))?.length ?? 0), 0),
    }));

    const seriesCountries = seriesAdminConfig.countries.map((c) => ({
      id: c.id,
      name: c.name,
      packages: seriesAdminConfig.packages.filter((p) => p.country_id === c.id).length,
      items: seriesAdminConfig.packages
        .filter((p) => p.country_id === c.id)
        .reduce((sum, p) => sum + (state?.seriesStreamsByCat.get(String(p.id))?.length ?? 0), 0),
    }));

    const selectedName = selectedCountryDisplayName();

    console.table(vodCountries);
    console.table(seriesCountries);
    console.log({
      uiTab,
      selectedAdminCountryId,
      selectedName,
      selectedKey: selectedName ? normalizeCountryDisplayKey(selectedName) : null,
      currentPackages: packagesForSelectedCountry().map((p) => ({
        id: p.id,
        name: p.name,
        country_id: p.country_id,
        countryName: countryNameForIdInLayout(p.country_id, providerLayoutForUiTab()),
        itemCount:
          uiTab === "movies"
            ? state?.vodStreamsByCat.get(String(p.id))?.length ?? 0
            : uiTab === "series"
              ? state?.seriesStreamsByCat.get(String(p.id))?.length ?? 0
              : state?.streamsByCatAll.get(String(p.id))?.length ?? 0,
      })),
    });
  };
}

function isSelectedCountryFrance(): boolean {
  const n = currentCountryDisplayLabel();
  return n != null && normalizeCountryKey(n) === "france";
}

/**
 * Toutes les catégories fournisseur (non-UUID) présentes sur la grille fusionnée (pays + bouquets globaux, etc.).
 * Sert à remplir `unionStreamsForCurrentCountry` : sans cela, un bouquet global n’a aucune chaîne (hors union).
 */
function providerCategoryIdsForStreamUnion(): string[] {
  const ids = new Set<string>();
  for (const p of mergedPackagesForGrid()) {
    if (!isLikelyUuid(p.id)) ids.add(p.id);
  }
  return [...ids];
}

function unionStreamsForCurrentCountry(): LiveStream[] {
  if (!state) return [];
  return collectStreamsFromProviderCategories(
    state.streamsByCatAll,
    providerCategoryIdsForStreamUnion()
  );
}

function curationMapForSelection(): Map<number, string> | null {
  const cid = resolvedDbCountryIdForAdminPackages();
  if (!cid) return null;
  return streamCurationByCountry.get(cid) ?? new Map();
}

function packageChannelOrderMapKey(packageId: string): string {
  const db = resolvedDbCountryIdForAdminPackages();
  const scope = db ?? `cat:${selectedAdminCountryId ?? "default"}`;
  return `${scope}::${packageId}`;
}

function loadPackageChannelOrderFromLocalStorage(mapKey: string): number[] | null {
  try {
    const raw = localStorage.getItem(`${PKG_CHANNEL_ORDER_LS_PREFIX}:${mapKey}`);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => Number(x)).filter(Number.isFinite);
  } catch {
    return null;
  }
}

function savePackageChannelOrderToLocalStorage(mapKey: string, ids: number[]): void {
  try {
    localStorage.setItem(`${PKG_CHANNEL_ORDER_LS_PREFIX}:${mapKey}`, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

function getPackageChannelOrder(packageId: string): number[] | null {
  const key = packageChannelOrderMapKey(packageId);
  const fromMap = packageChannelOrderByKey.get(key);
  if (fromMap?.length) return fromMap;
  return loadPackageChannelOrderFromLocalStorage(key);
}

/** Alphabetical live streams for a package (no manual order). */
function liveStreamsAlphaForPackageWithContext(
  packageId: string,
  unionStreamsForCountry: LiveStream[],
  isFranceContext: boolean,
  curationForSelectedDbCountry: Map<number, string> | null
): LiveStream[] {
  if (!state) return [];
  return listStreamsForOpenedPackage({
    packageId,
    streamsByCatAll: state.streamsByCatAll,
    unionStreamsForCountry,
    isFranceContext,
    isLikelyUuidPackage: isLikelyUuid,
    curationForSelectedDbCountry,
  });
}

function liveStreamsAlphaForPackage(packageId: string): LiveStream[] {
  return liveStreamsAlphaForPackageWithContext(
    packageId,
    unionStreamsForCurrentCountry(),
    isSelectedCountryFrance(),
    curationMapForSelection()
  );
}

async function persistPackageChannelOrder(packageId: string, streamIds: number[]): Promise<void> {
  const mapKey = packageChannelOrderMapKey(packageId);
  packageChannelOrderByKey.set(mapKey, streamIds);
  savePackageChannelOrderToLocalStorage(mapKey, streamIds);
  console.log("[Velora] Channel order saved", { packageId, streamIds });
  const sb = getSupabaseClient();
  if (!sb) return;
  let cid = resolvedDbCountryIdForAdminPackages();
  if (!cid) {
    cid = await ensureSupabaseCountryForSelection();
  }
  if (!cid) return;
  const res = await upsertPackageChannelOrder(sb, {
    country_id: cid,
    package_id: packageId,
    stream_order: streamIds,
  });
  if (res.error) {
    flashCurateStatus(`Ordre des chaînes (local OK) — Supabase : ${res.error}`, true);
  } else {
    flashCurateStatus("Ordre des chaînes enregistré.", false);
  }
}

function reorderVisibleStreamIds(ids: number[], fromIdx: number, toIdx: number, insertBefore: boolean): number[] {
  const next = [...ids];
  const [moved] = next.splice(fromIdx, 1);
  let ins = insertBefore ? toIdx : toIdx + 1;
  if (fromIdx < ins) ins--;
  next.splice(ins, 0, moved);
  return next;
}

function streamsDisplayedForOpenPackage(packageId: string): LiveStream[] {
  if (!state) return [];
  /* Films / séries : liste brute Nodecast par catégorie (pas d’union live ni allowlist globale). */
  if (uiTab === "movies") {
    const list = state.vodStreamsByCat.get(String(packageId)) ?? [];
    return [...list].sort((a, b) =>
      displayChannelName(a.name).localeCompare(displayChannelName(b.name), "fr")
    );
  }
  if (uiTab === "series") {
    const list = state.seriesStreamsByCat.get(String(packageId)) ?? [];
    return [...list].sort((a, b) =>
      displayChannelName(a.name).localeCompare(displayChannelName(b.name), "fr")
    );
  }
  const raw = liveStreamsAlphaForPackage(packageId);
  return applySavedOrder(raw, getPackageChannelOrder(packageId));
}

/** Icône fallback grille / thème : uniquement des chaînes visibles (hors « Mots masqués — noms »). */
function streamsForPackageCoverFallback(packageId: string): LiveStream[] {
  return streamsDisplayedForOpenPackage(packageId).filter((s) => !shouldHideChannelByName(s.name));
}

async function refreshSupabaseHierarchy(): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) {
    dbAdminCountries = [];
    dbAdminPackages = [];
    streamCurationByCountry = new Map();
    packageCoverOverrideById = new Map();
    packageChannelOrderByKey = new Map();
    packageGridOrderByKey = new Map();
    clearGlobalPackageSupabaseCaches();
    populateCountrySelectFromAdmin();
    return;
  }
  try {
    const [countries, packages] = await Promise.all([
      fetchDbAdminCountries(sb),
      fetchDbAdminPackages(sb),
      fetchGlobalPackageAllowlistLines(sb),
      fetchGlobalPackageOpenConfirmUi(sb),
    ]);
    dbAdminCountries = countries;
    dbAdminPackages = packages;
    try {
      streamCurationByCountry = await fetchDbStreamCurations(sb);
    } catch {
      streamCurationByCountry = new Map();
    }
    try {
      packageCoverOverrideById = await fetchDbPackageCoverOverrides(sb);
    } catch {
      packageCoverOverrideById = new Map();
    }
    try {
      packageChannelOrderByKey = await fetchDbPackageChannelOrders(sb);
    } catch {
      packageChannelOrderByKey = new Map();
    }
    try {
      packageGridOrderByKey = await fetchDbPackageGridOrders(sb);
    } catch {
      packageGridOrderByKey = new Map();
    }
  } catch {
    dbAdminCountries = [];
    dbAdminPackages = [];
    streamCurationByCountry = new Map();
    packageCoverOverrideById = new Map();
    packageChannelOrderByKey = new Map();
    packageGridOrderByKey = new Map();
    clearGlobalPackageSupabaseCaches();
  }
  populateCountrySelectFromAdmin();
}

function matchedDbCountryIdForSelection(): string | null {
  if (!selectedAdminCountryId) return null;
  if (dbAdminCountries.some((c) => c.id === selectedAdminCountryId)) {
    return selectedAdminCountryId;
  }
  const label = getCountryDisplayNameFromAnySource(selectedAdminCountryId);
  if (!label) return null;
  return matchDbCountryIdByDisplayName(label, dbAdminCountries);
}

/**
 * `admin_countries.id` pour packages Supabase + curations : reprend `matchedDbCountryIdForSelection`,
 * puis le libellé pays du header si le catalogue et Supabase n’alignent pas les ids.
 */
function resolvedDbCountryIdForAdminPackages(): string | null {
  const m = matchedDbCountryIdForSelection();
  if (m) return m;
  const label = currentCountryDisplayLabel();
  if (!label) return null;
  return matchDbCountryIdByDisplayName(label, dbAdminCountries);
}

function augmentChannelAssignPackagesFromDb(base: AdminPackage[]): AdminPackage[] {
  const byId = new Map(base.map((p) => [p.id, p]));
  const sid = resolvedDbCountryIdForAdminPackages();
  const label = currentCountryDisplayLabel();
  const labelKey = label ? normalizeCountryKey(label) : "";
  for (const p of dbAdminPackages) {
    if (byId.has(p.id)) continue;
    if (sid && p.country_id === sid) {
      byId.set(p.id, p);
      continue;
    }
    if (labelKey) {
      const dc = dbAdminCountries.find((c) => c.id === p.country_id);
      if (dc && normalizeCountryKey(dc.name) === labelKey) {
        byId.set(p.id, p);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function mergeGlobalAllowlistIntoPackages(base: AdminPackage[]): AdminPackage[] {
  const entries = getGlobalPackageAllowlistLines();
  if (entries.length === 0 || !selectedAdminCountryId) {
    globalAllowlistInjectedPackageIds = new Set();
    return base;
  }
  const injected = new Set<string>();
  const byId = new Map(base.map((p) => [p.id, p]));
  const layout = providerLayoutForUiTab();
  const anchor = selectedAdminCountryId;

  for (const entry of entries) {
    const raw = entry.trim();
    if (!raw) continue;

    const byExactId =
      layout.packages.find((p) => p.id === raw) ?? dbAdminPackages.find((p) => p.id === raw);
    if (byExactId) {
      if (isAdultPackage(byExactId, layout, uiTab)) continue;
      if (!byId.has(byExactId.id)) {
        byId.set(byExactId.id, { ...byExactId, country_id: anchor });
        injected.add(byExactId.id);
      }
      continue;
    }

    const nk = normalizeGlobalAllowlistNameKey(raw);
    if (!nk) continue;
    for (const p of layout.packages) {
      if (isAdultPackage(p, layout, uiTab)) continue;
      if (normalizeGlobalAllowlistNameKey(p.name) === nk && !byId.has(p.id)) {
        byId.set(p.id, { ...p, country_id: anchor });
        injected.add(p.id);
      }
    }
    for (const p of dbAdminPackages) {
      if (isAdultPackage(p, layout, uiTab)) continue;
      if (normalizeGlobalAllowlistNameKey(p.name) === nk && !byId.has(p.id)) {
        byId.set(p.id, { ...p, country_id: anchor });
        injected.add(p.id);
      }
    }
  }
  globalAllowlistInjectedPackageIds = injected;
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function mergedPackagesForGrid(): AdminPackage[] {
  if (adultPortalMode) {
    return adultPackagesForTab(adultPortalTab);
  }
  if (uiTab === "movies" || uiTab === "series") {
    return packagesForSelectedCountry();
  }
  const provider = packagesForSelectedCountry();
  const sid = resolvedDbCountryIdForAdminPackages();
  const fromDb = sid
    ? dbAdminPackages.filter((p) => p.country_id === sid && !isAdultPackage(p, adminConfig, "live"))
    : [];
  const base = [...fromDb, ...provider];
  if (isSelectedCountryFrance() && selectedAdminCountryId) {
    for (const t of FRANCE_SYNTH_PACKAGES) {
      base.push({
        id: t.id,
        country_id: selectedAdminCountryId,
        name: t.name,
      });
    }
  }
  return mergeGlobalAllowlistIntoPackages(base.sort((a, b) => a.name.localeCompare(b.name, "fr")));
}

function packageGridOrderMapKey(tab: UiTab): string | null {
  const db = resolvedDbCountryIdForAdminPackages();
  if (!db) return null;
  return `${db}::${tab}`;
}

function loadPackageGridOrderFromLocalStorage(mapKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${PKG_GRID_ORDER_LS_PREFIX}:${mapKey}`);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr
      .map((x) => String(x).trim())
      .filter((x) => x.length > 0);
  } catch {
    return null;
  }
}

function savePackageGridOrderToLocalStorage(mapKey: string, packageIds: string[]): void {
  try {
    localStorage.setItem(`${PKG_GRID_ORDER_LS_PREFIX}:${mapKey}`, JSON.stringify(packageIds));
  } catch {
    /* ignore */
  }
}

function getSavedPackageGridOrder(tab: UiTab): string[] | null {
  const key = packageGridOrderMapKey(tab);
  if (!key) return null;
  const fromMap = packageGridOrderByKey.get(key);
  if (fromMap?.length) return fromMap;
  return loadPackageGridOrderFromLocalStorage(key);
}

function applySavedPackageGridOrder(pkgs: AdminPackage[], saved: string[] | null): AdminPackage[] {
  if (!saved?.length) return pkgs;
  const byId = new Map(pkgs.map((p) => [p.id, p]));
  const ordered: AdminPackage[] = [];
  const used = new Set<string>();
  for (const id of saved) {
    const p = byId.get(id);
    if (p) {
      ordered.push(p);
      used.add(id);
    }
  }
  const rest = pkgs.filter((p) => !used.has(p.id));
  return [...ordered, ...rest];
}

function reorderVisiblePackageIds(ids: string[], fromIdx: number, toIdx: number, insertBefore: boolean): string[] {
  const next = [...ids];
  const [moved] = next.splice(fromIdx, 1);
  let ins = insertBefore ? toIdx : toIdx + 1;
  if (fromIdx < ins) ins--;
  next.splice(ins, 0, moved);
  return next;
}

async function persistPackageGridOrder(tab: UiTab, packageIds: string[]): Promise<void> {
  const mapKey = packageGridOrderMapKey(tab);
  if (!mapKey) return;
  packageGridOrderByKey.set(mapKey, packageIds);
  savePackageGridOrderToLocalStorage(mapKey, packageIds);
  const sb = getSupabaseClient();
  if (!sb) return;
  const cid = resolvedDbCountryIdForAdminPackages();
  if (!cid) return;
  const res = await upsertPackageGridOrder(sb, {
    country_id: cid,
    ui_tab: tab,
    package_order: packageIds,
  });
  if (res.error) {
    flashCurateStatus(`Ordre des packages (local OK) — Supabase : ${res.error}`, true);
  } else {
    flashCurateStatus("Ordre des packages enregistré.", false);
  }
}

type PackageThemeKey = "theme_bg" | "theme_surface" | "theme_primary" | "theme_glow" | "theme_back";

function mergePackageCoverThemeFromCatalogOverride(base: AdminPackage): AdminPackage {
  if (isLikelyUuid(base.id) && dbAdminPackages.some((p) => p.id === base.id)) {
    return base;
  }
  const ov = packageCoverOverrideById.get(base.id);
  if (!ov) return base;
  const overlay = (k: PackageThemeKey): string | undefined => {
    const v = ov[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    const b = base[k];
    return typeof b === "string" && b.trim() ? b.trim() : undefined;
  };
  return {
    ...base,
    theme_bg: overlay("theme_bg"),
    theme_surface: overlay("theme_surface"),
    theme_primary: overlay("theme_primary"),
    theme_glow: overlay("theme_glow"),
    theme_back: overlay("theme_back"),
  };
}

function findPackageById(packageId: string): AdminPackage | undefined {
  if (uiTab === "live" && isSelectedCountryFrance() && selectedAdminCountryId) {
    const syn = FRANCE_SYNTH_PACKAGES.find((t) => t.id === packageId);
    if (syn) {
      return mergePackageCoverThemeFromCatalogOverride({
        id: syn.id,
        country_id: selectedAdminCountryId,
        name: syn.name,
      });
    }
  }
  const base =
    providerLayoutForUiTab().packages.find((p) => p.id === packageId) ??
    (uiTab === "live" ? dbAdminPackages.find((p) => p.id === packageId) : undefined);
  if (!base) return undefined;
  return mergePackageCoverThemeFromCatalogOverride(base);
}

function httpsCatalogCoverOverride(packageId: string): string | null {
  const u = packageCoverOverrideById.get(packageId)?.cover_url?.trim();
  return u && /^https?:\/\//i.test(u) ? u : null;
}

function isSoftDeletedNonDbPackage(packageId: string): boolean {
  if (isLikelyUuid(packageId)) return false;
  return packageCoverOverrideById.get(packageId)?.deleted === true;
}

function hexForVelColorInput(fallback: string, raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return `#${t.slice(1).toLowerCase()}`;
  if (/^#[0-9a-f]{3}$/i.test(t)) {
    const r = t[1]!;
    const g = t[2]!;
    const b = t[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function readPackageThemeColumnsFromPceDialog(): PackageThemeColumns {
  const hexOrNull = (el: HTMLInputElement | null): string | null => {
    const t = el?.value.trim() ?? "";
    return t.length ? t : null;
  };
  const glow = elPceThemeGlow?.value.trim() ?? "";
  const back = elPceThemeBack?.value.trim() ?? "";
  return {
    theme_bg: hexOrNull(elPceThemeBg),
    theme_surface: hexOrNull(elPceThemeSurface),
    theme_primary: hexOrNull(elPceThemePrimary),
    theme_glow: glow.length ? glow : null,
    theme_back: back.length ? back : null,
  };
}

function normalizeHexCss(a: string | null | undefined): string {
  const t = (a ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(t)) {
    const r = t[1]!;
    const g = t[2]!;
    const b = t[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return t;
}

/** Treats colours matching the name-based preset as « unset » so image-based theming still applies. */
function readPackageThemeColumnsFromPceDialogNormalized(packageName: string): PackageThemeColumns {
  const pr = presetForPackageName(packageName);
  const raw = readPackageThemeColumnsFromPceDialog();
  const eqHex = (x: string | null, y: string) =>
    x != null && y.length > 0 && normalizeHexCss(x) === normalizeHexCss(y);
  const glowNorm = (s: string) => s.replace(/\s+/g, " ").trim();
  const eqGlow = (x: string | null, y: string) =>
    x != null && glowNorm(x) === glowNorm(y);
  return {
    theme_bg: eqHex(raw.theme_bg, pr.bg) ? null : raw.theme_bg,
    theme_surface: eqHex(raw.theme_surface, pr.surface) ? null : raw.theme_surface,
    theme_primary: eqHex(raw.theme_primary, pr.primary) ? null : raw.theme_primary,
    theme_glow: eqGlow(raw.theme_glow, pr.glow) ? null : raw.theme_glow,
    theme_back: (raw.theme_back ?? "").trim().length ? raw.theme_back : null,
  };
}

function mergeThemeIntoOverrideEntry(
  prev: PackageCoverOverrideEntry | null | undefined,
  dialog: PackageThemeColumns
): PackageCoverOverrideEntry {
  return {
    cover_url: prev?.cover_url ?? null,
    theme_bg: dialog.theme_bg,
    theme_surface: dialog.theme_surface,
    theme_primary: dialog.theme_primary,
    theme_glow: dialog.theme_glow,
    theme_back: dialog.theme_back,
    deleted: prev?.deleted ?? false,
  };
}

function fillPackageThemeDialogFromPackage(pkg: AdminPackage): void {
  const pr = presetForPackageName(pkg.name);
  if (elPceThemeBg) elPceThemeBg.value = hexForVelColorInput(pr.bg, pkg.theme_bg);
  if (elPceThemeSurface) elPceThemeSurface.value = hexForVelColorInput(pr.surface, pkg.theme_surface);
  if (elPceThemePrimary) elPceThemePrimary.value = hexForVelColorInput(pr.primary, pkg.theme_primary);
  if (elPceThemeGlow) elPceThemeGlow.value = (pkg.theme_glow ?? "").trim() || pr.glow;
  if (elPceThemeBack) elPceThemeBack.value = (pkg.theme_back ?? "").trim();
}

async function fillPackageThemeDialogFromImageFile(file: File): Promise<void> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const t = await extractPresetFromImageUrl(objectUrl);
    if (!t) return;
    if (elPceThemeBg) elPceThemeBg.value = hexForVelColorInput(t.bg, t.bg);
    if (elPceThemeSurface) elPceThemeSurface.value = hexForVelColorInput(t.surface, t.surface);
    if (elPceThemePrimary) elPceThemePrimary.value = hexForVelColorInput(t.primary, t.primary);
    if (elPceThemeGlow) elPceThemeGlow.value = t.glow;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function persistPackageThemeColumns(
  packageId: string,
  themes: PackageThemeColumns
): Promise<string | null> {
  const sb = getSupabaseClient();
  if (!sb) return "Supabase indisponible.";
  if (isLikelyUuid(packageId)) {
    const { error } = await sb.from("admin_packages").update({ ...themes }).eq("id", packageId);
    return error?.message ?? null;
  }
  const res = await upsertPackageCoverThemeOnly(
    sb,
    packageId,
    themes,
    packageCoverOverrideById.get(packageId)
  );
  return res.error ?? null;
}

/** See `imageUrlForDisplay` (R2 `*.r2.dev` = direct; other HTTPS = `/proxy`). */
function packageCoverImageSrc(href: string): string {
  return imageUrlForDisplay(href, 420);
}

function gridImageSrc(href: string): string {
  return imageUrlForDisplay(href, 420);
}

function posterImageSrc(href: string): string {
  return imageUrlForDisplay(href, 260);
}

function thumbImageSrc(href: string): string {
  return imageUrlForDisplay(href, 96);
}

function wireImageLoadingState(img: HTMLImageElement, priority = false, host?: HTMLElement): void {
  img.classList.add("vel-image-loading");
  host?.classList.add("vel-image-loading-host");
  img.loading = priority ? "eager" : "lazy";
  img.decoding = "async";
  img.setAttribute("fetchpriority", priority ? "high" : "auto");
  const done = (): void => {
    img.classList.remove("vel-image-loading");
    img.classList.add("vel-image-loaded");
    host?.classList.remove("vel-image-loading-host");
    host?.classList.add("vel-image-loaded-host");
  };
  img.addEventListener("load", done, { once: true });
  img.addEventListener("error", done, { once: true });
  if (img.complete) queueMicrotask(done);
}

function appendAddPackageCard(): void {
  const add = document.createElement("button");
  add.type = "button";
  add.className = "vel-package-card vel-package-card--add";
  add.setAttribute("aria-label", "Nouveau package Supabase");
  const plus = document.createElement("span");
  plus.className = "vel-package-card__add-plus";
  plus.setAttribute("aria-hidden", "true");
  plus.textContent = "+";
  const title = document.createElement("span");
  title.className = "vel-package-card__title";
  title.textContent = "Nouveau package";
  add.append(plus, title);
  add.addEventListener("click", () => openAddPackageDialog());
  elPackagesView.appendChild(add);
}

/** Nearly square grid art fills the card; horizontal / vertical images stay fully visible (`contain`). */
const PACKAGE_CARD_SQUARE_RATIO_EPS = 0.1;

function isNearlySquarePackageArt(nw: number, nh: number): boolean {
  if (nw < 2 || nh < 2) return false;
  const r = nw / nh;
  return r >= 1 - PACKAGE_CARD_SQUARE_RATIO_EPS && r <= 1 + PACKAGE_CARD_SQUARE_RATIO_EPS;
}

function wirePackageCardArtFit(img: HTMLImageElement, priority = false, host?: HTMLElement): void {
  img.classList.add("vel-package-card__art");
  wireImageLoadingState(img, priority, host);
  const apply = (): void => {
    img.classList.remove("vel-package-card__art--cover", "vel-package-card__art--contain");
    img.classList.add(
      isNearlySquarePackageArt(img.naturalWidth, img.naturalHeight)
        ? "vel-package-card__art--cover"
        : "vel-package-card__art--contain"
    );
  };
  img.addEventListener("load", apply);
  if (img.complete) queueMicrotask(apply);
}

function wirePackageCardDragReorder(card: HTMLElement, packageId: string, packageName: string): void {
  const drag = document.createElement("button");
  drag.type = "button";
  drag.className = "vel-package-drag-handle";
  drag.title = "Glisser pour réorganiser";
  drag.setAttribute("aria-label", `Réorganiser ${packageName}`);
  const grip = document.createElement("span");
  grip.className = "vel-package-drag-handle__grip";
  grip.setAttribute("aria-hidden", "true");
  grip.textContent = "⠿";
  drag.appendChild(grip);
  card.appendChild(drag);
  let allowDrag = false;
  drag.addEventListener("mousedown", () => {
    allowDrag = true;
  });
  drag.addEventListener("mouseup", () => {
    allowDrag = false;
  });
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    if (!allowDrag) {
      e.preventDefault();
      return;
    }
    allowDrag = false;
    card.classList.add("vel-package-card--dragging");
    e.dataTransfer?.setData("text/plain", packageId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("vel-package-card--dragging");
    elPackagesView.querySelectorAll(".vel-package-card--drop-target").forEach((el) => {
      el.classList.remove("vel-package-card--drop-target");
    });
  });
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = card.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    card.classList.add("vel-package-card--drop-target");
    card.dataset.dropBefore = before ? "1" : "0";
  });
  card.addEventListener("dragleave", (e) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && card.contains(rel)) return;
    card.classList.remove("vel-package-card--drop-target");
    delete card.dataset.dropBefore;
  });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("vel-package-card--drop-target");
    const draggedId = (e.dataTransfer?.getData("text/plain") ?? "").trim();
    if (!draggedId) return;
    const rect = card.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    delete card.dataset.dropBefore;
    const cards = [...elPackagesView.querySelectorAll<HTMLElement>(".vel-package-card[data-package-id]")];
    const visibleIds = cards
      .map((x) => (x.dataset.packageId ?? "").trim())
      .filter((x) => x.length > 0);
    const fromIdx = visibleIds.indexOf(draggedId);
    const toIdx = visibleIds.indexOf(packageId);
    if (fromIdx < 0 || toIdx < 0) return;
    const reordered = reorderVisiblePackageIds(visibleIds, fromIdx, toIdx, before);
    void (async () => {
      await persistPackageGridOrder(uiTab, reordered);
      renderPackagesGrid();
    })();
  });
}

function renderPackagesGrid(): void {
  elPackagesView.innerHTML = "";
  const st = state;
  if (!st) return;
  const gridEmojiFallback = uiTab === "movies" ? "🎬" : uiTab === "series" ? "📺" : "📡";

  if (countryRowsForSelect().length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent =
      "Aucun pays (ni dans le catalogue, ni dans Supabase). Connectez-vous ou ajoutez des pays via l’admin Supabase / le dialogue « + ».";
    elPackagesView.appendChild(empty);
    return;
  }

  if (!selectedAdminCountryId) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent = "Sélectionnez un pays.";
    elPackagesView.appendChild(empty);
    return;
  }

  const showAdminPackageImageTools =
    isAdminSession() &&
    Boolean(getSupabaseClient()) &&
    readAdminGridToolsEnabled() &&
    isPackagesGridTab();
  const showAdminGridReorder = showAdminPackageImageTools;
  const showAdminDeletePackage = showAdminPackageImageTools;
  const showAdminLiveGridExtras = showAdminPackageImageTools && uiTab === "live";
  if (showAdminLiveGridExtras) appendAddPackageCard();

  const orderedPkgs = applySavedPackageGridOrder(mergedPackagesForGrid(), getSavedPackageGridOrder(uiTab));
  const packageStreamsForGrid = new Map<string, LiveStream[]>();
  const liveUnionStreams = uiTab === "live" ? unionStreamsForCurrentCountry() : null;
  const liveFranceContext = uiTab === "live" ? isSelectedCountryFrance() : false;
  const liveCuration = uiTab === "live" ? curationMapForSelection() : null;
  const streamsDisplayedForGridPackage = (packageId: string): LiveStream[] => {
    const cached = packageStreamsForGrid.get(packageId);
    if (cached) return cached;
    const streams =
      uiTab === "live" && liveUnionStreams
        ? applySavedOrder(
            liveStreamsAlphaForPackageWithContext(
              packageId,
              liveUnionStreams,
              liveFranceContext,
              liveCuration
            ),
            getPackageChannelOrder(packageId)
          )
        : streamsDisplayedForOpenPackage(packageId);
    packageStreamsForGrid.set(packageId, streams);
    return streams;
  };
  const streamsForGridPackageCoverFallback = (packageId: string): LiveStream[] =>
    streamsDisplayedForGridPackage(packageId).filter((s) => !shouldHideChannelByName(s.name));
  logVeloraSelectedCountryPackagesDebug();
  /** Admin (?admin=1) : tous les bouquets y compris catalogue « supprimés » (masqués visiteurs). Visiteurs : hors supprimés et sans chaînes vides. */
  const pkgs = orderedPkgs.filter((pkg) => {
    if (isAdminSession()) return true;
    if (isSoftDeletedNonDbPackage(pkg.id)) return false;
    return streamsDisplayedForGridPackage(pkg.id).length > 0;
  });
  let priorityImageSlots = 8;
  const wireGridPackageImage = (img: HTMLImageElement, host: HTMLElement): void => {
    const priority = priorityImageSlots > 0;
    if (priority) priorityImageSlots--;
    wirePackageCardArtFit(img, priority, host);
  };
  for (const pkg of pkgs) {
    const isDb = isLikelyUuid(pkg.id);
    const isSoftDeleted = isSoftDeletedNonDbPackage(pkg.id);
    const matched = streamsForGridPackageCoverFallback(pkg.id);
    const channelFirstIcon = matched
      .map((s) => resolvedIconUrl(s.stream_icon, st.base))
      .find(Boolean);

    if (isDb) {
      const card = document.createElement("div");
      card.className = "vel-package-card vel-package-card--db";
      if (isSoftDeleted) card.classList.add("vel-package-card--deleted");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.dataset.packageId = pkg.id;
      card.setAttribute("aria-label", pkg.name);

      if (showAdminPackageImageTools) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "admin-pkg-edit-sb";
        if (showAdminDeletePackage) edit.classList.add("admin-pkg-edit-sb--with-del");
        edit.setAttribute("aria-label", `Image et couleurs — ${pkg.name}`);
        edit.title =
          uiTab === "live"
            ? "Modifier l’image et les couleurs du bouquet"
            : "Modifier l’image et les couleurs (affiche + thème)";
        edit.textContent = "🖼";
        edit.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openPackageCoverEditDialog(pkg);
        });
        card.appendChild(edit);
      }
      if (showAdminDeletePackage) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "admin-pkg-del-sb";
        del.dataset.packageId = pkg.id;
        del.setAttribute("aria-label", isSoftDeleted ? `Restaurer ${pkg.name}` : `Supprimer ${pkg.name}`);
        del.title = isSoftDeleted ? "Restaurer ce bouquet" : "Supprimer ce bouquet";
        del.textContent = isSoftDeleted ? "↺" : "×";
        del.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void deletePackageById(pkg.id);
        });
        card.appendChild(del);
      }
      if (showAdminGridReorder) {
        wirePackageCardDragReorder(card, pkg.id, pkg.name);
      }

      const cover = pkg.cover_url?.trim();
      const useCover = Boolean(cover && /^https?:\/\//i.test(cover));
      if (useCover && cover) {
        const img = document.createElement("img");
        img.alt = "";
        img.setAttribute("role", "presentation");
        img.src = packageCoverImageSrc(cover);
        wireGridPackageImage(img, card);
        img.addEventListener("error", () => {
          if (isPackageCoverDebugEnabled()) {
            console.warn("[package-cover] grid img error (db package)", {
              packageId: pkg.id,
              rawCoverUrl: cover,
              imgSrc: img.src,
            });
          }
          img.remove();
          if (channelFirstIcon) {
            const img2 = document.createElement("img");
            img2.alt = "";
            img2.setAttribute("role", "presentation");
            img2.src = gridImageSrc(channelFirstIcon);
            wireGridPackageImage(img2, card);
            img2.addEventListener("error", () => {
              img2.remove();
              const em = document.createElement("span");
              em.className = "vel-package-card__emoji";
              em.textContent = "📦";
              em.setAttribute("aria-hidden", "true");
              card.appendChild(em);
            });
            card.appendChild(img2);
          } else {
            const em = document.createElement("span");
            em.className = "vel-package-card__emoji";
            em.textContent = "📦";
            em.setAttribute("aria-hidden", "true");
            card.appendChild(em);
          }
        });
        card.appendChild(img);
      } else if (channelFirstIcon) {
        const img = document.createElement("img");
        img.alt = "";
        img.setAttribute("role", "presentation");
        img.src = gridImageSrc(channelFirstIcon);
        wireGridPackageImage(img, card);
        img.addEventListener("error", () => {
          img.remove();
          const em = document.createElement("span");
          em.className = "vel-package-card__emoji";
          em.textContent = "📦";
          em.setAttribute("aria-hidden", "true");
          card.appendChild(em);
        });
        card.appendChild(img);
      } else {
        const em = document.createElement("span");
        em.className = "vel-package-card__emoji";
        em.textContent = "📦";
        em.setAttribute("aria-hidden", "true");
        card.appendChild(em);
      }

      const title = document.createElement("span");
      title.className = "vel-package-card__title";
      title.textContent = pkg.name;
      card.appendChild(title);
      if (isSoftDeleted) {
        const badge = document.createElement("span");
        badge.className = "vel-package-card__deleted-badge";
        badge.textContent = "Supprimé";
        badge.setAttribute("aria-label", "Supprimé");
        card.appendChild(badge);
      }

      card.addEventListener("click", (ev) => {
        if (
          (ev.target as HTMLElement).closest(
            ".admin-pkg-del-sb, .admin-pkg-edit-sb, .vel-package-drag-handle"
          )
        )
          return;
        maybeConfirmThenOpenAdminPackage(pkg.id);
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          maybeConfirmThenOpenAdminPackage(pkg.id);
        }
      });
      elPackagesView.appendChild(card);
      continue;
    }

    const card = document.createElement("button");
    card.type = "button";
    card.className = "vel-package-card";
    if (isSoftDeleted) card.classList.add("vel-package-card--deleted");
    card.dataset.packageId = pkg.id;
    card.setAttribute("aria-label", pkg.name);

    if (showAdminPackageImageTools) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "admin-pkg-edit-sb";
      if (showAdminDeletePackage) edit.classList.add("admin-pkg-edit-sb--with-del");
      edit.setAttribute("aria-label", `Image et couleurs — ${pkg.name}`);
      edit.title =
        uiTab === "live"
          ? "Modifier l’image et les couleurs du bouquet"
          : "Modifier l’image et les couleurs (affiche + thème)";
      edit.textContent = "🖼";
      edit.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openPackageCoverEditDialog(pkg);
      });
      card.appendChild(edit);
    }
    if (showAdminDeletePackage) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "admin-pkg-del-sb";
      del.dataset.packageId = pkg.id;
      del.setAttribute("aria-label", isSoftDeleted ? `Restaurer ${pkg.name}` : `Supprimer ${pkg.name}`);
      del.title = isSoftDeleted ? "Restaurer ce bouquet" : "Supprimer ce bouquet";
      del.textContent = isSoftDeleted ? "↺" : "×";
      del.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void deletePackageById(pkg.id);
      });
      card.appendChild(del);
    }
    if (showAdminGridReorder) {
      wirePackageCardDragReorder(card, pkg.id, pkg.name);
    }

    const httpsOverride = httpsCatalogCoverOverride(pkg.id);
    const appendEmoji = (sym: string) => {
      const em = document.createElement("span");
      em.className = "vel-package-card__emoji";
      em.textContent = sym;
      em.setAttribute("aria-hidden", "true");
      card.appendChild(em);
    };
    const appendProxiedIcon = (href: string, onFailEmoji: string) => {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      img.src = gridImageSrc(href);
      wireGridPackageImage(img, card);
      img.addEventListener("error", () => {
        img.remove();
        appendEmoji(onFailEmoji);
      });
      card.appendChild(img);
    };

    if (httpsOverride) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      img.src = packageCoverImageSrc(httpsOverride);
      wireGridPackageImage(img, card);
      img.addEventListener("error", () => {
        if (isPackageCoverDebugEnabled()) {
          console.warn("[package-cover] grid img error (catalog override)", {
            packageId: pkg.id,
            rawUrl: httpsOverride,
            imgSrc: img.src,
          });
        }
        img.remove();
        if (channelFirstIcon) appendProxiedIcon(channelFirstIcon, gridEmojiFallback);
        else appendEmoji(gridEmojiFallback);
      });
      card.appendChild(img);
    } else if (channelFirstIcon) {
      appendProxiedIcon(channelFirstIcon, gridEmojiFallback);
    } else {
      appendEmoji(gridEmojiFallback);
    }

    const title = document.createElement("span");
    title.className = "vel-package-card__title";
    title.textContent = pkg.name;
    card.appendChild(title);
    if (isSoftDeleted) {
      const badge = document.createElement("span");
      badge.className = "vel-package-card__deleted-badge";
      badge.textContent = "Supprimé";
      badge.setAttribute("aria-label", "Supprimé");
      card.appendChild(badge);
    }

    card.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".admin-pkg-edit-sb, .admin-pkg-del-sb, .vel-package-drag-handle"))
        return;
      maybeConfirmThenOpenAdminPackage(pkg.id);
    });
    elPackagesView.appendChild(card);
  }

  if (pkgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vel-empty-msg";
    empty.style.gridColumn = "1 / -1";
    empty.textContent =
      uiTab === "movies"
        ? "Aucun film disponible pour ce pays."
        : uiTab === "series"
          ? "Aucune série disponible pour ce pays."
          : "Aucune chaîne disponible pour ce pays.";
    elPackagesView.appendChild(empty);
  }
}

function releasePackagesGridRenderBlock(token: number): void {
  if (token !== packagesGridRenderToken) return;
  elPackagesView.removeAttribute("aria-busy");
  elPackagesView.style.removeProperty("pointer-events");
}

function schedulePackagesGridRender(): void {
  const token = ++packagesGridRenderToken;
  elPackagesView.setAttribute("aria-busy", "true");
  elPackagesView.style.pointerEvents = "none";
  requestAnimationFrame(() => {
    if (token !== packagesGridRenderToken) return;
    if (uiShell !== "packages") {
      releasePackagesGridRenderBlock(token);
      return;
    }
    try {
      renderPackagesGrid();
    } finally {
      releasePackagesGridRenderBlock(token);
    }
  });
}

function maybeConfirmThenOpenAdminPackage(packageId: string): void {
  if (adultPortalMode) {
    openAdminPackage(packageId);
    return;
  }
  if (!isGlobalAllowlistInjectedPackageId(packageId)) {
    openAdminPackage(packageId);
    return;
  }
  const dlg = document.getElementById("vel-global-pkg-confirm-dialog") as HTMLDialogElement | null;
  const msgEl = document.getElementById("vel-global-pkg-confirm-msg") as HTMLParagraphElement | null;
  const yesBtn = document.getElementById("vel-global-pkg-confirm-yes") as HTMLButtonElement | null;
  const noBtn = document.getElementById("vel-global-pkg-confirm-no") as HTMLButtonElement | null;
  if (!dlg || !msgEl || !yesBtn || !noBtn) {
    openAdminPackage(packageId);
    return;
  }
  const ui = getGlobalPackageOpenConfirmUi();
  msgEl.textContent = ui.message.trim().length
    ? ui.message.trim()
    : "Ce bouquet est proposé pour tous les pays. Souhaitez-vous l’ouvrir ?";
  yesBtn.textContent = (ui.yes_label ?? "Oui").trim() || "Oui";
  noBtn.textContent = (ui.no_label ?? "Non").trim() || "Non";

  const ac = new AbortController();
  const { signal } = ac;
  const onYes = (ev: Event): void => {
    ev.preventDefault();
    dlg.close();
    openAdminPackage(packageId);
  };
  const onNo = (ev: Event): void => {
    ev.preventDefault();
    dlg.close();
  };
  yesBtn.addEventListener("click", onYes, { signal });
  noBtn.addEventListener("click", onNo, { signal });
  dlg.addEventListener("close", () => ac.abort(), { once: true });
  dlg.showModal();
}

function openAdminPackage(packageId: string, restore?: OpenAdminPackageRestore): void {
  if (!state) return;
  const pkg = findPackageById(packageId);
  if (!pkg) return;
  const tab: UiTab = uiTab === "movies" || uiTab === "series" ? uiTab : "live";
  if (isVeloraCatalogCacheDebugEnabled() && (tab === "movies" || tab === "series")) {
    const map = tab === "movies" ? state.vodStreamsByCat : state.seriesStreamsByCat;
    const raw = map.get(String(packageId)) ?? [];
    console.info("[Velora] Package open", { packageId, tab, rawItemCount: raw.length });
  }
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  if (tab === "movies" && restore?.vodStreamId != null && restore.vodMovieUiPhase !== "list") {
    const row = findStreamInPackageByStreamId(packageId, restore.vodStreamId);
    if (row) {
      vodDetailStream = row;
      vodMovieUiPhase = "detail";
    }
  }
  if (tab === "series" && restore?.seriesStreamId != null && restore.seriesUiPhase !== "list") {
    const row = findStreamInPackageByStreamId(packageId, restore.seriesStreamId);
    if (row) {
      seriesDetailStream = row;
      seriesUiPhase = "detail";
    }
  }
  activeStreamId = null;
  destroyPlayer();
  destroyVodPlayer();
  uiShell = "content";
  uiTab = tab;
  uiAdminPackageId = packageId;
  setTabsActive(tab);
  applyThemeForPackage(pkg);
  elPackagesView.classList.add("hidden");
  elMainTabs.classList.add("hidden");
  elContentView.classList.remove("hidden");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.classList.remove("item-list--vod-film-detail");
  syncPillDefsForPackage(packageId);
  if (restore?.selectedPillId && pillDefs.some((p) => p.id === restore.selectedPillId)) {
    selectedPillId = restore.selectedPillId;
  } else {
    selectedPillId = "all";
  }
  renderCategoryPills();
  updatePillsVisibility();
  renderPackageChannelList();
  syncCatalogBackButtonLabel();
  syncAdminAddChannelsButton();
  syncPlayerDismissOverlay();
  syncAdultPortalChrome();
  syncMainInPackageClass();
  if (!restore?.skipResetScroll) resetVeloraMainScroll();
  veloraPushNavigationState("package");
}

/** Retour catalogue bouquets : état UI uniquement (sans synchroniser l’historique). */
function applyPackagesShellUi(): void {
  activeStreamId = null;
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  veloraApplyingHistoryPopstate = true;
  destroyPlayer();
  destroyVodPlayer();
  veloraApplyingHistoryPopstate = false;
  uiShell = "packages";
  uiAdminPackageId = null;
  setTabsActive(uiTab);
  applyPresetTheme("default");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.classList.remove("item-list--vod-film-detail");
  elCatPillsWrap.classList.add("hidden");
  selectedPillId = "all";
  syncAdminAddChannelsButton();
  if (state) schedulePackagesGridRender();
  syncCatalogBackButtonLabel();
  syncPlayerDismissOverlay();
  syncAdultPortalChrome();
  syncMainInPackageClass();
  schedulePersistVeloraUiRoute();
}

/** Grille bouquets : conserve l’onglet (Live / Films / Séries). */
function showPackagesShell(): void {
  const pendingHist = veloraUiHistoryDepth;
  applyPackagesShellUi();
  stripVeloraHistorySilently(pendingHist);
  schedulePersistVeloraUiRoute();
}

function goLiveHome(): void {
  exitAdultPortalMode();
  uiTab = "live";
  populateCountrySelectFromAdmin();
  showPackagesShell();
}

async function deletePackageById(packageId: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  if (isLikelyUuid(packageId)) {
    if (
      !window.confirm("Supprimer ce package Supabase ? Les catégories liées seront supprimées (cascade).")
    ) {
      return;
    }
    const { error } = await sb.from("admin_packages").delete().eq("id", packageId);
    if (error) {
      setLoginStatus(error.message, true);
      return;
    }
  } else {
    const isDeleted = isSoftDeletedNonDbPackage(packageId);
    const confirmMsg = isDeleted
      ? "Restaurer ce bouquet catalogue ?"
      : "Supprimer ce bouquet catalogue pour les utilisateurs (visible seulement en admin) ?";
    if (!window.confirm(confirmMsg)) return;
    const res = await setPackageCoverDeletedState(
      sb,
      packageId,
      !isDeleted,
      packageCoverOverrideById.get(packageId)
    );
    if (res.error) {
      setLoginStatus(res.error, true);
      return;
    }
    const prevOv = packageCoverOverrideById.get(packageId);
    packageCoverOverrideById.set(packageId, {
      cover_url: prevOv?.cover_url ?? null,
      theme_bg: prevOv?.theme_bg ?? null,
      theme_surface: prevOv?.theme_surface ?? null,
      theme_primary: prevOv?.theme_primary ?? null,
      theme_glow: prevOv?.theme_glow ?? null,
      theme_back: prevOv?.theme_back ?? null,
      deleted: !isDeleted,
    });
  }
  await refreshSupabaseHierarchy();
  if (state && uiShell === "packages" && isPackagesGridTab()) {
    renderPackagesGrid();
  }
}

/** One row per normalized pays name (évite les doublons « France » si plusieurs lignes en base). */
function dedupeCountriesByDisplayName(countries: AdminCountry[]): AdminCountry[] {
  if (countries.length === 0) return [];
  const sorted = [...countries].sort((a, b) => a.id.localeCompare(b.id));
  const byKey = new Map<string, AdminCountry>();
  for (const c of sorted) {
    const nk = normalizeCountryKey(c.name);
    const key = nk.length > 0 ? nk : `__id:${c.id}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** `admin_packages.country_id` : réutilise `admin_countries` si le nom correspond, sinon insert. */
async function resolveSupabaseCountryIdForNewPackage(selectionValue: string): Promise<string | null> {
  const v = selectionValue.trim();
  if (!v) return null;
  if (isLikelyUuid(v) && dbAdminCountries.some((c) => c.id === v)) return v;
  const row = countryRowsForSelect().find((c) => c.id === v);
  if (!row) return null;
  const name = row.name.trim();
  if (!name) return null;
  const existing = matchDbCountryIdByDisplayName(name, dbAdminCountries);
  if (existing) return existing;
  const sb = getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb.from("admin_countries").insert({ name }).select("id").single();
  if (!error && data && typeof data === "object" && "id" in data) {
    await refreshSupabaseHierarchy();
    return String((data as { id: string }).id);
  }
  await refreshSupabaseHierarchy();
  return matchDbCountryIdByDisplayName(name, dbAdminCountries);
}

function populateAddPackageDialogCountries(): void {
  elDapSbCountry.innerHTML = "";
  const pickList = dedupeCountriesByDisplayName(countryRowsForSelect());
  if (pickList.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "— Connectez-vous au catalogue ou créez un pays ci-dessous —";
    o.disabled = true;
    o.selected = true;
    elDapSbCountry.appendChild(o);
    elDapSbCountry.disabled = true;
    return;
  }
  elDapSbCountry.disabled = false;
  for (const c of pickList) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    elDapSbCountry.appendChild(o);
  }
}

function preselectDapCountryFromHeader(): void {
  const opts = [...elDapSbCountry.options].filter((o) => o.value && !o.disabled);
  if (!opts.length || elDapSbCountry.disabled) return;
  const tryVal = (val: string | null | undefined): boolean => {
    if (!val) return false;
    if (opts.some((o) => o.value === val)) {
      elDapSbCountry.value = val;
      return true;
    }
    return false;
  };
  if (tryVal(selectedAdminCountryId)) return;
  const label = currentCountryDisplayLabel();
  if (label) {
    const nk = normalizeCountryKey(label);
    const hit = countryRowsForSelect().find((c) => normalizeCountryKey(c.name) === nk);
    if (hit && tryVal(hit.id)) return;
  }
  if (tryVal(resolvedDbCountryIdForAdminPackages())) return;
  elDapSbCountry.selectedIndex = 0;
}

function openAddPackageDialog(): void {
  const sb = getSupabaseClient();
  if (!isAdminSession() || !readAdminGridToolsEnabled() || !sb) return;
  elDapStatus.textContent = "";
  elDapStatus.classList.remove("error");
  elDapNewCountryName.value = "";
  elDapCover.value = "";
  syncCoverUploadVisual("dap");
  populateAddPackageDialogCountries();
  const merged = countryRowsForSelect();
  const hasCatalogueCountries = merged.length > 0;
  document.getElementById("dap-create-country-field")?.classList.toggle("hidden", hasCatalogueCountries);
  elDapEmptyCountriesHint?.classList.toggle("hidden", hasCatalogueCountries);
  preselectDapCountryFromHeader();
  elDapName.value = "";
  elDialogAddPkg.showModal();
  queueMicrotask(() => {
    if (!hasCatalogueCountries) elDapNewCountryName.focus();
    else elDapName.focus();
  });
}

function closeAddPackageDialog(): void {
  elDialogAddPkg.close();
}

function revokeCoverPreviewObjectUrl(side: "pce" | "dap"): void {
  if (side === "pce") {
    if (pceCoverPreviewObjectUrl) {
      URL.revokeObjectURL(pceCoverPreviewObjectUrl);
      pceCoverPreviewObjectUrl = null;
    }
  } else if (dapCoverPreviewObjectUrl) {
    URL.revokeObjectURL(dapCoverPreviewObjectUrl);
    dapCoverPreviewObjectUrl = null;
  }
}

function syncCoverUploadVisual(side: "pce" | "dap"): void {
  const input = side === "pce" ? elPceCover : elDapCover;
  const empty = side === "pce" ? elPceCoverEmpty : elDapCoverEmpty;
  const wrap = side === "pce" ? elPceCoverPreviewWrap : elDapCoverPreviewWrap;
  const img = side === "pce" ? elPceCoverPreview : elDapCoverPreview;
  const pick = side === "pce" ? elPceCoverPick : elDapCoverPick;
  const zone = side === "pce" ? elPceDropzone : elDapDropzone;
  revokeCoverPreviewObjectUrl(side);
  const f = input?.files?.[0];
  if (!f) {
    if (img) {
      img.removeAttribute("src");
      img.alt = "";
    }
    empty?.classList.remove("hidden");
    wrap?.classList.add("hidden");
    if (pick) pick.textContent = "Choisir une image";
    zone?.classList.remove("cover-upload__card--has-file");
    return;
  }
  const url = URL.createObjectURL(f);
  if (side === "pce") pceCoverPreviewObjectUrl = url;
  else dapCoverPreviewObjectUrl = url;
  if (img) {
    img.src = url;
    img.alt = `Aperçu : ${f.name}`;
  }
  empty?.classList.add("hidden");
  wrap?.classList.remove("hidden");
  if (pick) pick.textContent = "Changer l’image";
  zone?.classList.add("cover-upload__card--has-file");
}

async function assignCoverAfterCrop(
  input: HTMLInputElement | null,
  sync: () => void,
  file: File,
  afterAssign?: (assigned: File) => Promise<void>
): Promise<void> {
  if (!input) return;
  const cropped = await runCoverSquareCrop(file);
  input.value = "";
  if (!cropped) {
    sync();
    return;
  }
  const dt = new DataTransfer();
  dt.items.add(cropped);
  input.files = dt.files;
  sync();
  await afterAssign?.(cropped);
}

function wirePackageCoverDropZone(
  zone: HTMLElement | null,
  input: HTMLInputElement | null,
  sync: () => void,
  afterCrop: (input: HTMLInputElement | null, sync: () => void, file: File) => Promise<void>
): void {
  if (!zone || !input) return;
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    const rel = e.relatedTarget as Node | null;
    if (rel && zone.contains(rel)) return;
    zone.classList.add("cover-upload__card--drag");
  });
  zone.addEventListener("dragleave", (e) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && zone.contains(rel)) return;
    zone.classList.remove("cover-upload__card--drag");
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("cover-upload__card--drag");
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    void afterCrop(input, sync, file);
  });
}

(function wireCoverUploadControls(): void {
  const syncPce = (): void => syncCoverUploadVisual("pce");
  const syncDap = (): void => syncCoverUploadVisual("dap");
  const afterPceAssign = async (assigned: File): Promise<void> => {
    await fillPackageThemeDialogFromImageFile(assigned);
  };
  elPceCoverPick?.addEventListener("click", () => elPceCover?.click());
  elDapCoverPick?.addEventListener("click", () => elDapCover?.click());
  elPceCover?.addEventListener("change", () => {
    const f = elPceCover?.files?.[0];
    if (!f) {
      syncPce();
      return;
    }
    void assignCoverAfterCrop(elPceCover, syncPce, f, afterPceAssign);
  });
  elDapCover?.addEventListener("change", () => {
    const f = elDapCover?.files?.[0];
    if (!f) {
      syncDap();
      return;
    }
    void assignCoverAfterCrop(elDapCover, syncDap, f);
  });
  wirePackageCoverDropZone(elPceDropzone, elPceCover, syncPce, (i, s, f) =>
    assignCoverAfterCrop(i, s, f, afterPceAssign)
  );
  wirePackageCoverDropZone(elDapDropzone, elDapCover, syncDap, assignCoverAfterCrop);
})();

function openPackageCoverEditDialog(pkg: AdminPackage): void {
  if (!elDialogPackageCover || !elPcePackageId || !elPceCover) return;
  const sb = getSupabaseClient();
  if (!isAdminSession() || !readAdminGridToolsEnabled() || !sb) return;
  const merged = findPackageById(pkg.id) ?? pkg;
  elPcePackageId.value = merged.id;
  if (elPcePackageName) elPcePackageName.textContent = merged.name;
  elPceCover.value = "";
  syncCoverUploadVisual("pce");
  fillPackageThemeDialogFromPackage(merged);
  elPceStatus && (elPceStatus.textContent = "");
  elPceStatus?.classList.remove("error");
  elDialogPackageCover.showModal();
}

function closePackageCoverEditDialog(): void {
  elDialogPackageCover?.close();
}

elDapCancel.addEventListener("click", () => closeAddPackageDialog());

elPceCancel?.addEventListener("click", () => closePackageCoverEditDialog());
elDialogPackageCover?.addEventListener("cancel", () => closePackageCoverEditDialog());

elPceClear?.addEventListener("click", () => {
  void (async () => {
    const id = elPcePackageId?.value.trim();
    const sb = getSupabaseClient();
    if (!id || !sb) return;
    elPceStatus && (elPceStatus.textContent = "");
    elPceStatus?.classList.remove("error");
    elPceClear.disabled = true;
    try {
      if (isLikelyUuid(id)) {
        const { error } = await sb.from("admin_packages").update({ cover_url: null }).eq("id", id);
        if (error) {
          elPceStatus && (elPceStatus.textContent = error.message);
          elPceStatus?.classList.add("error");
          return;
        }
      } else {
        const res = await clearPackageCoverImageKeepingThemes(
          sb,
          id,
          packageCoverOverrideById.get(id)
        );
        if (res.error) {
          elPceStatus && (elPceStatus.textContent = res.error);
          elPceStatus?.classList.add("error");
          return;
        }
      }
      invalidatePackageImageThemeCache(id);
      await refreshSupabaseHierarchy();
      closePackageCoverEditDialog();
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
      if (state && uiShell === "content" && uiAdminPackageId === id && isPackagesGridTab()) {
        applyThemeForPackage(findPackageById(id) ?? null);
      }
    } finally {
      elPceClear.disabled = false;
    }
  })();
});

elPceThemeReset?.addEventListener("click", () => {
  void (async () => {
    const id = elPcePackageId?.value.trim();
    const sb = getSupabaseClient();
    if (!id || !sb) return;
    elPceStatus && (elPceStatus.textContent = "");
    elPceStatus?.classList.remove("error");
    const cleared: PackageThemeColumns = {
      theme_bg: null,
      theme_surface: null,
      theme_primary: null,
      theme_glow: null,
      theme_back: null,
    };
    elPceThemeReset.disabled = true;
    try {
      const msg = await persistPackageThemeColumns(id, cleared);
      if (msg) {
        elPceStatus && (elPceStatus.textContent = msg);
        elPceStatus?.classList.add("error");
        return;
      }
      invalidatePackageImageThemeCache(id);
      await refreshSupabaseHierarchy();
      const merged = findPackageById(id);
      if (merged) fillPackageThemeDialogFromPackage(merged);
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
      if (state && uiShell === "content" && uiAdminPackageId === id && isPackagesGridTab()) {
        applyThemeForPackage(findPackageById(id) ?? null);
      }
    } finally {
      elPceThemeReset.disabled = false;
    }
  })();
});

elPceSubmit?.addEventListener("click", () => {
  void (async () => {
    const id = elPcePackageId?.value.trim();
    const sb = getSupabaseClient();
    if (!id || !sb || !elPceCover) return;
    const file = elPceCover.files?.[0];
    elPceStatus && (elPceStatus.textContent = "");
    elPceStatus?.classList.remove("error");
    const pkgName = findPackageById(id)?.name ?? elPcePackageName?.textContent?.trim() ?? "";
    const themes = readPackageThemeColumnsFromPceDialogNormalized(pkgName);
    const prevOv = packageCoverOverrideById.get(id);

    elPceSubmit.disabled = true;
    try {
      if (file) {
        const up = await uploadPackageCoverFile(sb, id, file);
        if ("error" in up) {
          elPceStatus && (elPceStatus.textContent = up.error);
          elPceStatus?.classList.add("error");
          return;
        }
        const finalUrl = up.url;

        if (isLikelyUuid(id)) {
          const { error } = await sb
            .from("admin_packages")
            .update({ cover_url: finalUrl, ...themes })
            .eq("id", id);
          if (error) {
            elPceStatus && (elPceStatus.textContent = error.message);
            elPceStatus?.classList.add("error");
            return;
          }
        } else {
          const res = await upsertPackageCoverOverride(
            sb,
            id,
            finalUrl,
            mergeThemeIntoOverrideEntry(prevOv, themes)
          );
          if (res.error) {
            elPceStatus && (elPceStatus.textContent = res.error);
            elPceStatus?.classList.add("error");
            return;
          }
        }
      } else {
        const msg = await persistPackageThemeColumns(id, themes);
        if (msg) {
          elPceStatus && (elPceStatus.textContent = msg);
          elPceStatus?.classList.add("error");
          return;
        }
      }

      if (isPackageCoverDebugEnabled() && file) {
        console.log("[package-cover] saved to Supabase", {
          packageId: id,
          row: isLikelyUuid(id) ? "admin_packages.cover_url" : "admin_package_covers",
        });
      }

      invalidatePackageImageThemeCache(id);
      await refreshSupabaseHierarchy();
      if (isPackageCoverDebugEnabled()) {
        const row = dbAdminPackages.find((p) => p.id === id);
        const ov = packageCoverOverrideById.get(id)?.cover_url?.trim();
        console.log("[package-cover] after refreshSupabaseHierarchy", {
          packageId: id,
          cover_urlFromFetch: row?.cover_url ?? "(no admin_packages row)",
          overrideFromFetch: ov ?? "(no admin_package_covers row)",
        });
      }
      closePackageCoverEditDialog();
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
      if (state && uiShell === "content" && uiAdminPackageId === id && isPackagesGridTab()) {
        applyThemeForPackage(findPackageById(id) ?? null);
      }
    } finally {
      elPceSubmit.disabled = false;
    }
  })();
});

elChannelAssignCancel?.addEventListener("click", () => closeChannelAssignDialog());
elDialogChannelAssign?.addEventListener("cancel", () => closeChannelAssignDialog());
elChannelAssignOk?.addEventListener("click", () => {
  void (async () => {
    if (pendingAssignStreamIds.length < 1 || !elChannelAssignSelect) return;
    const pkgId = elChannelAssignSelect.value?.trim();
    if (!pkgId) return;
    elChannelAssignStatus && (elChannelAssignStatus.textContent = "");
    elChannelAssignStatus?.classList.remove("error");
    let ok = 0;
    let fail = 0;
    for (const sid of pendingAssignStreamIds) {
      if (await persistStreamCuration(sid, pkgId)) ok++;
      else fail++;
    }
    if (ok < 1) {
      if (elChannelAssignStatus) {
        elChannelAssignStatus.textContent =
          "Échec de l’enregistrement. Vérifiez la table admin_stream_curations dans Supabase.";
        elChannelAssignStatus.classList.add("error");
      }
      return;
    }
    if (fail > 0 && elChannelAssignStatus) {
      elChannelAssignStatus.textContent = `${ok} chaîne(s) déplacée(s), ${fail} erreur(s).`;
      elChannelAssignStatus.classList.add("error");
      return;
    }
    pendingAssignStreamIds.forEach((sid) => selectedAdminChannelStreamIds.delete(sid));
    closeChannelAssignDialog();
    renderPackageChannelList();
    if (state && uiShell === "packages" && isPackagesGridTab()) {
      renderPackagesGrid();
    }
  })();
});

elBtnAdminAddChannels?.addEventListener("click", () => {
  openAddChannelsToPackageDialog();
});

elBtnAdminSelectAllChannels?.addEventListener("click", () => {
  if (!showAdminChannelCurateTools() || uiShell !== "content" || uiTab !== "live" || uiAdminPackageId == null) {
    return;
  }
  const boxes = elDynamicList.querySelectorAll<HTMLInputElement>(".vel-channel-select");
  boxes.forEach((cb) => {
    const sid = Number(cb.closest<HTMLElement>(".vel-media-item-row")?.dataset.streamId);
    if (Number.isFinite(sid)) selectedAdminChannelStreamIds.add(sid);
    cb.checked = true;
  });
});

elAddChannelsCancel?.addEventListener("click", () => closeAddChannelsToPackageDialog());
elDialogAddChannels?.addEventListener("cancel", () => closeAddChannelsToPackageDialog());

elAddChannelsSearch?.addEventListener("input", () => filterAddChannelsListRows());

elAddChannelsSelectVisible?.addEventListener("click", () => {
  if (!elAddChannelsList) return;
  elAddChannelsList.querySelectorAll(".add-channels-row:not(.hidden) input[type=checkbox]").forEach((cb) => {
    (cb as HTMLInputElement).checked = true;
  });
});

elAddChannelsSubmit?.addEventListener("click", () => {
  void (async () => {
    if (!elAddChannelsList || !uiAdminPackageId) return;
    const pkgId = uiAdminPackageId;
    const boxes = elAddChannelsList.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]:checked"
    );
    const ids: number[] = [];
    boxes.forEach((cb) => {
      const n = Number(cb.dataset.streamId);
      if (Number.isFinite(n)) ids.push(n);
    });
    elAddChannelsStatus && (elAddChannelsStatus.textContent = "");
    elAddChannelsStatus?.classList.remove("error");
    if (ids.length === 0) {
      elAddChannelsStatus && (elAddChannelsStatus.textContent = "Cochez au moins une chaîne.");
      elAddChannelsStatus?.classList.add("error");
      return;
    }
    elAddChannelsSubmit.disabled = true;
    let ok = 0;
    let fail = 0;
    for (const sid of ids) {
      if (await persistStreamCuration(sid, pkgId)) ok++;
      else fail++;
    }
    elAddChannelsSubmit.disabled = false;
    if (fail > 0) {
      elAddChannelsStatus &&
        (elAddChannelsStatus.textContent = `${ok} chaîne(s) ajoutée(s), ${fail} erreur(s). Réessayez ou vérifiez Supabase.`);
      elAddChannelsStatus?.classList.add("error");
      buildAddChannelsDialogList(pkgId);
      filterAddChannelsListRows();
    } else {
      closeAddChannelsToPackageDialog();
      renderPackageChannelList();
      if (state && uiShell === "packages" && isPackagesGridTab()) renderPackagesGrid();
    }
  })();
});

elDapAddCountry.addEventListener("click", () => {
  void (async () => {
    const sb = getSupabaseClient();
    if (!sb) return;
    const name = elDapNewCountryName.value.trim();
    elDapStatus.textContent = "";
    elDapStatus.classList.remove("error");
    if (!name) {
      elDapStatus.textContent = "Saisissez un nom de pays.";
      elDapStatus.classList.add("error");
      return;
    }
    elDapAddCountry.disabled = true;
    const { data, error } = await sb.from("admin_countries").insert({ name }).select("id, name").single();
    elDapAddCountry.disabled = false;
    if (error) {
      elDapStatus.textContent = error.message;
      elDapStatus.classList.add("error");
      return;
    }
    elDapNewCountryName.value = "";
    await refreshSupabaseHierarchy();
    populateAddPackageDialogCountries();
    const mergedAfter = countryRowsForSelect();
    document.getElementById("dap-create-country-field")?.classList.toggle("hidden", mergedAfter.length > 0);
    elDapEmptyCountriesHint?.classList.toggle("hidden", mergedAfter.length > 0);
    const id = data && typeof data === "object" && "id" in data ? String((data as { id: string }).id) : "";
    if (id && [...elDapSbCountry.options].some((o) => o.value === id)) {
      elDapSbCountry.value = id;
    } else {
      preselectDapCountryFromHeader();
    }
    elDapStatus.textContent = "Pays ajouté. Saisissez le nom du package puis « Ajouter ».";
    elDapName.focus();
  })();
});

elDapSubmit.addEventListener("click", () => {
  void (async () => {
    const sb = getSupabaseClient();
    if (!sb) return;
    const countryId = elDapSbCountry.value?.trim();
    const name = elDapName.value.trim();
    elDapStatus.textContent = "";
    elDapStatus.classList.remove("error");
    if (!countryId) {
      elDapStatus.textContent = "Choisissez un pays dans la liste.";
      elDapStatus.classList.add("error");
      return;
    }
    if (!name) {
      elDapStatus.textContent = "Saisissez un nom.";
      elDapStatus.classList.add("error");
      return;
    }
    const file = elDapCover.files?.[0];

    elDapSubmit.disabled = true;
    const resolvedCountryId = await resolveSupabaseCountryIdForNewPackage(countryId);
    if (!resolvedCountryId) {
      elDapSubmit.disabled = false;
      elDapStatus.textContent =
        "Impossible d’associer ce pays à Supabase (admin_countries). Vérifiez les droits ou réessayez.";
      elDapStatus.classList.add("error");
      return;
    }

    const insertRow: { country_id: string; name: string; cover_url?: string | null } = {
      country_id: resolvedCountryId,
      name,
      cover_url: null,
    };
    const { data: inserted, error } = await sb
      .from("admin_packages")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) {
      elDapSubmit.disabled = false;
      const dup = /unique|duplicate/i.test(error.message);
      elDapStatus.textContent = dup
        ? "Un package avec ce nom existe déjà pour ce pays."
        : error.message;
      elDapStatus.classList.add("error");
      return;
    }
    const newId = inserted && typeof inserted === "object" && "id" in inserted ? String(inserted.id) : "";
    if (file && newId) {
      const up = await uploadPackageCoverFile(sb, newId, file);
      if ("error" in up) {
        elDapStatus.textContent = `Package créé ; image non enregistrée : ${up.error}`;
        elDapStatus.classList.remove("error");
        elDapSubmit.disabled = false;
        invalidatePackageImageThemeCache(newId);
        await refreshSupabaseHierarchy();
        if (state && uiShell === "packages" && uiTab === "live") {
          renderPackagesGrid();
        }
        return;
      }
      const { error: upErr } = await sb.from("admin_packages").update({ cover_url: up.url }).eq("id", newId);
      if (upErr) {
        elDapStatus.textContent = `Package créé ; fichier reçu mais URL non sauvegardée : ${upErr.message}`;
        elDapStatus.classList.add("error");
        elDapSubmit.disabled = false;
        invalidatePackageImageThemeCache(newId);
        await refreshSupabaseHierarchy();
        if (state && uiShell === "packages" && uiTab === "live") {
          renderPackagesGrid();
        }
        return;
      }
    }
    elDapSubmit.disabled = false;
    closeAddPackageDialog();
    if (newId) invalidatePackageImageThemeCache(newId);
    await refreshSupabaseHierarchy();
    if (state && uiShell === "packages" && uiTab === "live") {
      renderPackagesGrid();
    }
  })();
});

function countStreamsInMap(m: Map<string, LiveStream[]>): number {
  let n = 0;
  for (const list of m.values()) n += list.length;
  return n;
}

function logVeloraRawMediaCatalogLayoutDebug(
  media: "vod" | "series",
  categories: LiveCategory[],
  streamsByCat: Map<string, LiveStream[]>,
  layout: AdminConfig
): void {
  if (!isVeloraCatalogCacheDebugEnabled()) return;
  const streamTotal = countStreamsInMap(streamsByCat);
  const streamsMapKeyCount = streamsByCat.size;
  const first30CategoryIdsWithItemCounts = [...streamsByCat.entries()]
    .slice(0, 30)
    .map(([categoryId, items]) => ({ categoryId, itemCount: items.length }));
  const categoriesWithZeroItemsCount = categories.filter(
    (category) => (streamsByCat.get(String(category.category_id))?.length ?? 0) === 0
  ).length;
  const countriesList = layout.countries.map((c) => c.name);
  const autresCount = layout.packages.filter((p) => p.country_id === OTHER_COUNTRY_ID).length;
  const pkgSamples30 = layout.packages.slice(0, 30).map((p) => ({
    packageName: p.name,
    countryName: getCountryDisplayNameFromLayout(p.country_id, layout) ?? p.country_id,
    itemCount: streamsByCat.get(String(p.id))?.length ?? 0,
  }));
  const countryMatchingFirst30 = categories.slice(0, 30).map((c) => {
    const parsed = inferCountryFromCategoryName(c.category_name);
    return {
      category_name: c.category_name,
      parsedCountryName: parsed?.name ?? null,
      parsedCountryId: parsed?.id ?? null,
      itemCount: streamsByCat.get(String(c.category_id))?.length ?? 0,
    };
  });
  if (media === "vod") {
    console.info("[Velora catalog] VOD layout debug", {
      vod_categories_count: categories.length,
      vod_streams_total_count: streamTotal,
      vodStreamsByCat_size: streamsMapKeyCount,
      vodStreamsByCat_first_30_category_ids_with_item_counts: first30CategoryIdsWithItemCounts,
      vod_categories_with_0_items_count: categoriesWithZeroItemsCount,
      vodAdminConfig_countries_names: countriesList,
      vod_packages_built_first_30: pkgSamples30,
      packages_in_autres_count: autresCount,
      country_matching_first_30_vod_categories: countryMatchingFirst30,
    });
  } else {
    console.info("[Velora catalog] Series layout debug", {
      series_categories_count: categories.length,
      series_streams_total_count: streamTotal,
      seriesStreamsByCat_size: streamsMapKeyCount,
      seriesStreamsByCat_first_30_category_ids_with_item_counts: first30CategoryIdsWithItemCounts,
      series_categories_with_0_items_count: categoriesWithZeroItemsCount,
      seriesAdminConfig_countries_names: countriesList,
      series_packages_built_first_30: pkgSamples30,
      packages_in_autres_count: autresCount,
      country_matching_first_30_series_categories: countryMatchingFirst30,
    });
  }
}

function showVodPlaceholder(
  kind: "movies" | "series",
  reason: "no-nodecast" | "no-xtream-source" | "empty" | "catalog-fetch-error" = "no-nodecast"
): void {
  exitAdultPortalMode();
  activeStreamId = null;
  destroyPlayer();
  destroyVodPlayer();
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  uiShell = "content";
  uiTab = kind;
  uiAdminPackageId = null;
  setTabsActive(kind);
  applyPresetTheme("default");
  elPackagesView.classList.add("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.remove("hidden");
  elCatPillsWrap.classList.add("hidden");
  elDynamicList.classList.remove("item-list--vod-vertical", "item-list--vod-film-detail");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "vel-empty-msg";
  if (reason === "empty") {
    msg.innerHTML =
      kind === "movies"
        ? "Aucun <strong>film</strong> (VOD) dans le catalogue pour cette source Xtream."
        : "Aucune <strong>série</strong> dans le catalogue pour cette source Xtream.";
  } else if (reason === "catalog-fetch-error") {
    const detail =
      kind === "movies"
        ? nodecastVodCatalogFetchError ?? "Erreur réseau ou proxy."
        : nodecastSeriesCatalogFetchError ?? "Erreur réseau ou proxy.";
    msg.innerHTML =
      kind === "movies"
        ? `Impossible de charger le catalogue <strong>films</strong> (VOD).<br><span class="vel-muted">${escapeHtml(
            detail
          )}</span><br><small>Réessayez en cliquant de nouveau sur <strong>Films</strong>.</small>`
        : `Impossible de charger le catalogue <strong>séries</strong>.<br><span class="vel-muted">${escapeHtml(
            detail
          )}</span><br><small>Réessayez en cliquant de nouveau sur <strong>Séries</strong>.</small>`;
  } else if (reason === "no-xtream-source") {
    msg.innerHTML =
      kind === "movies"
        ? "Impossible de déterminer la <strong>source Xtream</strong> pour charger les films (catalogue live sans proxy <code>api/proxy/xtream</code>)."
        : "Impossible de déterminer la <strong>source Xtream</strong> pour charger les séries (catalogue live sans proxy <code>api/proxy/xtream</code>).";
  } else {
    msg.innerHTML =
      kind === "movies"
        ? "Les <strong>films</strong> (VOD) sont disponibles après connexion <strong>Nodecast</strong> avec un proxy Xtream (<code>vod_categories</code> / <code>vod_streams</code>)."
        : "Les <strong>séries</strong> sont disponibles après connexion <strong>Nodecast</strong> avec un proxy Xtream (<code>series_categories</code> / <code>get_series</code>).";
  }
  elDynamicList.appendChild(msg);
  syncMainInPackageClass();
  schedulePersistVeloraUiRoute();
}

function openNodecastMediaShell(tab: "movies" | "series"): void {
  void openNodecastMediaShellAsync(tab);
}

function mediaCategoryIdsForSelectedCountry(categories: LiveCategory[]): string[] {
  const selectedName = selectedCountryDisplayName();
  const selectedKey = selectedName ? normalizeCountryDisplayKey(selectedName) : "";
  if (!selectedKey) return [];
  const wantsOther = selectedKey === normalizeCountryDisplayKey("Autres");
  return categories
    .filter((category) => {
      const parsed = inferCountryFromCategoryName(category.category_name);
      if (!parsed) return wantsOther;
      return normalizeCountryDisplayKey(parsed.name) === selectedKey;
    })
    .map((category) => String(category.category_id))
    .filter(Boolean);
}

function mergeStreamsByCategory(
  target: Map<string, LiveStream[]>,
  incoming: Map<string, LiveStream[]>
): void {
  for (const [categoryId, streams] of incoming.entries()) {
    const existing = target.get(categoryId) ?? [];
    const byId = new Map(existing.map((stream) => [stream.stream_id, stream]));
    for (const stream of streams) byId.set(stream.stream_id, stream);
    target.set(categoryId, [...byId.values()]);
  }
}

async function ensureSelectedCountryLiveCatalogReady(): Promise<void> {
  if (!state || state.mode !== "nodecast") return;
  const sid = state.nodecastXtreamSourceId?.trim();
  if (!sid) return;
  const wantedCategoryIds = mediaCategoryIdsForSelectedCountry(state.liveCategories);
  const missingCategoryIds = wantedCategoryIds.filter(
    (categoryId) => !state?.liveLoadedCategoryIds.has(categoryId)
  );
  if (!missingCategoryIds.length) return;
  const streamsByCat = await fetchNodecastLiveStreamsForCategories(
    state.base,
    sid,
    missingCategoryIds,
    state.nodecastAuthHeaders
  );
  if (!state) return;
  mergeStreamsByCategory(state.streamsByCatAll, streamsByCat);
  for (const categoryId of missingCategoryIds) state.liveLoadedCategoryIds.add(categoryId);
  adminConfig = buildProviderAdminConfig(state.liveCategories, state.streamsByCatAll);
  persistVeloraNodecastSnapshot();
}

/** Charge films ou séries Nodecast si besoin (login initial = maps vides). */
async function ensureNodecastVodOrSeriesCatalogReady(
  tab: "movies" | "series",
  opts?: { showLoading?: boolean }
): Promise<void> {
  if (!state || state.mode !== "nodecast") return;
  const sid = state.nodecastXtreamSourceId?.trim();
  if (!sid) return;
  const showLoading = opts?.showLoading !== false;

  if (tab === "movies") {
    if (showLoading) setCatalogLoadingVisible(true, "Chargement des films…", "movies");
    nodecastVodCatalogFetchError = null;
    try {
      if (!state.vodCatalogLoaded) {
        state.vodCategories = await fetchNodecastVodCategories(
          state.base,
          sid,
          state.nodecastAuthHeaders
        );
        state.vodCatalogLoaded = true;
      }
      const wantedCategoryIds = mediaCategoryIdsForSelectedCountry(state.vodCategories);
      const missingCategoryIds = wantedCategoryIds.filter(
        (categoryId) => !state?.vodLoadedCategoryIds.has(categoryId)
      );
      if (missingCategoryIds.length > 0) {
        const streamsByCat = await fetchNodecastVodStreamsForCategories(
          state.base,
          sid,
          missingCategoryIds,
          state.nodecastAuthHeaders
        );
        if (!state) return;
        mergeStreamsByCategory(state.vodStreamsByCat, streamsByCat);
        for (const categoryId of missingCategoryIds) state.vodLoadedCategoryIds.add(categoryId);
      }
      if (!state) return;
      vodAdminConfig = buildProviderAdminConfig(state.vodCategories, state.vodStreamsByCat);
      nodecastVodCatalogFetchError = null;
      logVeloraRawMediaCatalogLayoutDebug("vod", state.vodCategories, state.vodStreamsByCat, vodAdminConfig);
      persistVeloraNodecastSnapshot();
    } catch (err) {
      nodecastVodCatalogFetchError = err instanceof Error ? err.message : String(err);
      console.error("[Velora] VOD catalogue fetch failed", err);
      if (state) {
        state.vodCatalogLoaded = false;
      }
    } finally {
      if (showLoading) setCatalogLoadingVisible(false);
    }
  }

  if (tab === "series") {
    if (showLoading) setCatalogLoadingVisible(true, "Chargement des séries…", "series");
    nodecastSeriesCatalogFetchError = null;
    try {
      if (!state.seriesCatalogLoaded) {
        state.seriesCategories = await fetchNodecastSeriesCategories(
          state.base,
          sid,
          state.nodecastAuthHeaders
        );
        state.seriesCatalogLoaded = true;
      }
      const wantedCategoryIds = mediaCategoryIdsForSelectedCountry(state.seriesCategories);
      const missingCategoryIds = wantedCategoryIds.filter(
        (categoryId) => !state?.seriesLoadedCategoryIds.has(categoryId)
      );
      if (missingCategoryIds.length > 0) {
        const streamsByCat = await fetchNodecastSeriesStreamsForCategories(
          state.base,
          sid,
          missingCategoryIds,
          state.nodecastAuthHeaders
        );
        if (!state) return;
        mergeStreamsByCategory(state.seriesStreamsByCat, streamsByCat);
        for (const categoryId of missingCategoryIds) state.seriesLoadedCategoryIds.add(categoryId);
      }
      if (!state) return;
      seriesAdminConfig = buildProviderAdminConfig(state.seriesCategories, state.seriesStreamsByCat);
      nodecastSeriesCatalogFetchError = null;
      logVeloraRawMediaCatalogLayoutDebug(
        "series",
        state.seriesCategories,
        state.seriesStreamsByCat,
        seriesAdminConfig
      );
      persistVeloraNodecastSnapshot();
    } catch (err) {
      nodecastSeriesCatalogFetchError = err instanceof Error ? err.message : String(err);
      console.error("[Velora] Series catalogue fetch failed", err);
      if (state) {
        state.seriesCatalogLoaded = false;
      }
    } finally {
      if (showLoading) setCatalogLoadingVisible(false);
    }
  }
}

async function warmSelectedCountryCatalogs(): Promise<void> {
  if (!state || state.mode !== "nodecast") return;
  const selectedName = selectedCountryDisplayName();
  setCatalogLoadingVisible(
    true,
    selectedName ? `Chargement de ${selectedName}…` : "Chargement du pays…",
    uiTab
  );
  try {
    await Promise.all([
      ensureSelectedCountryLiveCatalogReady(),
      ensureNodecastVodOrSeriesCatalogReady("movies", { showLoading: false }),
      ensureNodecastVodOrSeriesCatalogReady("series", { showLoading: false }),
    ]);
    populateCountrySelectFromAdmin();
  } finally {
    setCatalogLoadingVisible(false);
  }
}

async function warmSelectedCountryLiveCatalog(): Promise<void> {
  if (!state || state.mode !== "nodecast") return;
  const selectedName = selectedCountryDisplayName();
  setCatalogLoadingVisible(
    true,
    selectedName ? `Chargement de ${selectedName}...` : "Chargement du pays...",
    "live"
  );
  try {
    await ensureSelectedCountryLiveCatalogReady();
    populateCountrySelectFromAdmin();
  } finally {
    setCatalogLoadingVisible(false);
  }
}

function warmSelectedCountryMediaCatalogsInBackground(): void {
  void (async () => {
    try {
      await Promise.all([
        ensureNodecastVodOrSeriesCatalogReady("movies", { showLoading: false }),
        ensureNodecastVodOrSeriesCatalogReady("series", { showLoading: false }),
      ]);
      populateCountrySelectFromAdmin();
      if (state && uiShell === "packages" && (uiTab === "movies" || uiTab === "series")) {
        schedulePackagesGridRender();
        syncPlayerDismissOverlay();
      }
    } catch (err) {
      console.warn("[Velora] Background media warm-up failed", err);
    }
  })();
}

function selectedCountryMediaSlicesLoaded(tab: "movies" | "series"): boolean {
  if (!state || state.mode !== "nodecast") return false;
  const categories = tab === "movies" ? state.vodCategories : state.seriesCategories;
  const loaded = tab === "movies" ? state.vodLoadedCategoryIds : state.seriesLoadedCategoryIds;
  const catalogLoaded = tab === "movies" ? state.vodCatalogLoaded : state.seriesCatalogLoaded;
  if (!catalogLoaded) return false;
  return mediaCategoryIdsForSelectedCountry(categories).every((categoryId) => loaded.has(categoryId));
}

async function openNodecastMediaShellAsync(tab: "movies" | "series"): Promise<void> {
  exitAdultPortalMode();
  if (isVeloraCatalogCacheDebugEnabled()) {
    console.info("[Velora] Tab switch (media shell start)", {
      requestedTab: tab,
      selectedCountryBefore: selectedAdminCountryId,
      activeTabBefore: uiTab,
    });
  }
  if (!state || state.mode !== "nodecast") {
    showVodPlaceholder(tab, "no-nodecast");
    return;
  }
  const sid = state.nodecastXtreamSourceId?.trim();
  if (!sid) {
    showVodPlaceholder(tab, "no-xtream-source");
    return;
  }

  if (!selectedCountryMediaSlicesLoaded(tab)) {
    await ensureNodecastVodOrSeriesCatalogReady(tab);
  }

  if (!state) return;
  const fetchErr = tab === "movies" ? nodecastVodCatalogFetchError : nodecastSeriesCatalogFetchError;
  if (fetchErr) {
    showVodPlaceholder(tab, "catalog-fetch-error");
    return;
  }
  activeStreamId = null;
  destroyPlayer();
  destroyVodPlayer();
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  uiTab = tab;
  uiShell = "packages";
  uiAdminPackageId = null;
  setTabsActive(tab);
  applyPresetTheme("default");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  elContentView.classList.add("hidden");
  elCatPillsWrap.classList.add("hidden");
  selectedPillId = "all";
  populateCountrySelectFromAdmin();
  renderPackagesGrid();
  syncAdminAddChannelsButton();
  syncPlayerDismissOverlay();
  syncMainInPackageClass();
  schedulePersistVeloraUiRoute();
  if (isVeloraCatalogCacheDebugEnabled()) {
    console.info("[Velora] Tab switch (media shell done)", {
      selectedCountryAfter: selectedAdminCountryId,
      activeTab: uiTab,
      packagesFoundForSelectedCountry: packagesForSelectedCountry().length,
    });
  }
}

function onTabClick(tab: UiTab): void {
  if (tab === "live") {
    if (isVeloraCatalogCacheDebugEnabled()) {
      console.info("[Velora] Tab switch", {
        phase: "before",
        tab,
        selectedCountry: selectedAdminCountryId,
        activeTab: uiTab,
      });
    }
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    seriesUiPhase = "list";
    seriesDetailStream = null;
    destroyVodPlayer();
    goLiveHome();
    if (isVeloraCatalogCacheDebugEnabled()) {
      console.info("[Velora] Tab switch", {
        phase: "after",
        tab: uiTab,
        selectedCountry: selectedAdminCountryId,
        packagesFoundForSelectedCountry: packagesForSelectedCountry().length,
      });
    }
    return;
  }
  if (isVeloraCatalogCacheDebugEnabled()) {
    console.info("[Velora] Tab switch", {
      phase: "before",
      tab,
      selectedCountry: selectedAdminCountryId,
      activeTab: uiTab,
    });
  }
  if (tab === "movies") {
    seriesUiPhase = "list";
    seriesDetailStream = null;
    destroyPlayer();
  }
  if (tab === "series") {
    vodMovieUiPhase = "list";
    vodDetailStream = null;
    destroyVodPlayer();
  }
  openNodecastMediaShell(tab === "movies" ? "movies" : "series");
}

async function playStreamByMode(s: LiveStream): Promise<void> {
  if (!state) return;
  const playbackRequestId = ++mediaPlaybackRequestId;
  const isVodFilm = s.nodecast_media === "vod";
  const hideLiveProgress = !isVodFilm && s.nodecast_media !== "series";
  if (isVodFilm) {
    destroyPlayer();
    teardownVodMedia();
  } else {
    destroyVodPlayer();
    teardownPlaybackMedia();
  }
  const trialOk = await canStartPlayback();
  if (playbackRequestId !== mediaPlaybackRequestId) return;
  if (!trialOk) {
    showTrialExpiredModal();
    return;
  }

  if (state.mode === "nodecast") {
    if (isVodFilm) {
      showVodPlayerChrome(true);
      setVodPlayerBufferingVisible(true);
      startVodFakeLoadingOverlay(
        s.nodecast_series_episode ? "Préparation de l’épisode…" : "Préparation du film…"
      );
      if (elNowPlayingVod) {
        elNowPlayingVod.innerHTML = nowPlayingLiveMarkup(displayChannelName(s.name));
      }
      let resolved: string | null = null;
      try {
        resolved = await resolveNodecastVodStreamUrl(state.base, s, state.nodecastAuthHeaders);
      } catch {
        resolved = null;
      }
      if (playbackRequestId !== mediaPlaybackRequestId || activeStreamId !== s.stream_id) {
        return;
      }
      if (!resolved) {
        setVodPlayerBufferingVisible(false);
        stopVodFakeLoadingOverlay();
        if (elNowPlayingVod) {
          elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
            "Impossible de résoudre l’URL de ce film (proxy VOD Nodecast)."
          );
        }
        activeStreamId = null;
        syncSeriesEpisodePlaybackHighlight();
        return;
      }
      if (!sameOrigin(resolved, state.base)) {
        setVodPlayerBufferingVisible(false);
        stopVodFakeLoadingOverlay();
        if (elNowPlayingVod) {
          elNowPlayingVod.innerHTML = nowPlayingErrorMarkup(
            "URL de lecture externe bloquée ; proxy requis."
          );
        }
        activeStreamId = null;
        syncSeriesEpisodePlaybackHighlight();
        return;
      }
      // Liste / autre navigation pendant l’await : ne pas relancer le lecteur.
      const okFilmDetail =
        uiTab === "movies" &&
        vodMovieUiPhase === "detail" &&
        vodDetailStream != null &&
        vodDetailStream.stream_id === s.stream_id;
      const okSeriesEpisode =
        uiTab === "series" &&
        seriesUiPhase === "detail" &&
        seriesDetailStream != null &&
        seriesDetailStream.nodecast_source_id === s.nodecast_source_id &&
        seriesDetailStream.stream_id !== s.stream_id;
      if (!okFilmDetail && !okSeriesEpisode) {
        setVodPlayerBufferingVisible(false);
        stopVodFakeLoadingOverlay();
        if (s.nodecast_series_episode) {
          activeStreamId = null;
          syncSeriesEpisodePlaybackHighlight();
        }
        return;
      }
      if (playbackRequestId !== mediaPlaybackRequestId || activeStreamId !== s.stream_id) {
        return;
      }
      s.direct_source = resolved;
      playVodUrl(resolved, displayChannelName(s.name), state.nodecastAuthHeaders);
      syncSeriesEpisodePlaybackHighlight();
      smoothVeloraMainScrollTop();
      return;
    }

    if (hideLiveProgress) {
      elPlayerContainer.classList.add("player-container--live-tv");
    } else {
      elPlayerContainer.classList.remove("player-container--live-tv");
    }
    showPlayerChrome(true);
    elNowPlaying.innerHTML = nowPlayingLiveMarkup(displayChannelName(s.name));
    let resolved: string | null = null;
    if (s.nodecast_media === "series" && s.nodecast_source_id) {
      resolved = await resolveNodecastSeriesPlayableUrl(
        state.base,
        s.stream_id,
        s.nodecast_source_id,
        state.nodecastAuthHeaders
      );
    } else {
      resolved = await resolveNodecastStreamUrl(state.base, s, state.nodecastAuthHeaders);
    }
    if (playbackRequestId !== mediaPlaybackRequestId || activeStreamId !== s.stream_id) {
      return;
    }
    if (!resolved) {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        s.nodecast_media === "series"
          ? "Impossible de lire cette série (épisode / API get_series_info)."
          : "Impossible de résoudre l’URL de cette chaîne (API Nodecast)."
      );
      return;
    }
    if (!sameOrigin(resolved, state.base)) {
      elNowPlaying.innerHTML = nowPlayingErrorMarkup(
        "URL de lecture externe bloquée ; proxy requis."
      );
      return;
    }
    if (s.nodecast_media === "series") {
      if (
        seriesUiPhase !== "detail" ||
        seriesDetailStream == null ||
        seriesDetailStream.stream_id !== s.stream_id
      ) {
        return;
      }
    }
    if (playbackRequestId !== mediaPlaybackRequestId || activeStreamId !== s.stream_id) {
      return;
    }
    s.direct_source = resolved;
    await playLiveUrlWithAudioPolicy(
      resolved,
      displayChannelName(s.name),
      state.nodecastAuthHeaders,
      hideLiveProgress,
      `nodecast:${s.nodecast_source_id ?? "source"}:${s.stream_id}`
    );
    return;
  }
  const m3u8 = buildLiveStreamUrl(
    state.serverInfo,
    state.username,
    state.password,
    s.stream_id,
    "m3u8"
  );
  if (playbackRequestId !== mediaPlaybackRequestId || activeStreamId !== s.stream_id) {
    return;
  }
  await playLiveUrlWithAudioPolicy(
    m3u8,
    displayChannelName(s.name),
    undefined,
    hideLiveProgress,
    `xtream:${state.serverInfo.url}:${s.stream_id}`
  );
}

async function connect(opts?: { skipMediaRouteRestore?: boolean }): Promise<void> {
  applyNodecastEnvDefaults();
  setLoginStatus("");
  const base = normalizeServerInput(elServer.value);
  const username = elUser.value.trim();
  const password = elPass.value;

  if (!base || !username) {
    setLoginStatus("Renseignez l’URL et l’identifiant.", true);
    return;
  }

  if (envAutoConnectConfigured()) {
    prepareEnvAutoconnectUi();
  }

  elBtnConnect.disabled = true;
  setLoginStatus("Connexion à Nodecast…");

  try {
    setCatalogLoadingVisible(true, "Connexion au serveur…", "live");
    const mode: "nodecast" = "nodecast";
    const baseCandidates = buildNodecastLoginBaseCandidates(base);
    if (isVeloraCatalogCacheDebugEnabled()) {
      console.info("[Velora catalog]", "Nodecast base candidate order", {
        candidates: baseCandidates.map((c) => ({ url: c.url, preferred: c.preferred })),
      });
    }
    let activeBase = baseCandidates[0]?.url ?? base;
    let nodecast:
      | Awaited<ReturnType<typeof tryNodecastLoginAndLoad>>
      | null = null;
    let lastConnectError: unknown = null;
    for (let i = 0; i < baseCandidates.length; i += 1) {
      const { url: candidate, preferred } = baseCandidates[i]!;
      try {
        if (i > 0) {
          setLoginStatus(`Connexion à Nodecast… (${new URL(candidate).host})`);
        }
        nodecast = await tryNodecastLoginAndLoad(candidate, username, password, { preferred });
        activeBase = candidate;
        if (isVeloraCatalogCacheDebugEnabled()) {
          console.info("[Velora catalog]", "Nodecast login succeeded", { selectedBase: activeBase });
        }
        break;
      } catch (err) {
        lastConnectError = err;
      }
    }
    if (!nodecast) {
      throw (lastConnectError instanceof Error
        ? lastConnectError
        : new Error(String(lastConnectError ?? "Nodecast login failed.")));
    }
    try {
      sessionStorage.setItem(NODECAST_WORKING_BASE_SS_KEY, activeBase);
    } catch {
      /* ignore */
    }
    setCatalogLoadingVisible(true, "Préparation de l’accueil…", "live");
    const streamsByCat = nodecast.streamsByCat;
    const nodecastAuthHeaders = nodecast.authHeaders;
    const serverInfo: ServerInfo = {
      url: new URL(activeBase).hostname,
      port: new URL(activeBase).port || (new URL(activeBase).protocol === "https:" ? "443" : "80"),
      server_protocol: new URL(activeBase).protocol.replace(":", ""),
    };

    await fetchAndApplyCanonicalCountries();
    const postHomeSetupPromise = Promise.allSettled([
      fetchAndApplyChannelNamePrefixes(),
      fetchAndApplyChannelHideNeedles(),
    ]);
    await refreshSupabaseHierarchy();
    adminConfig = buildProviderAdminConfig(nodecast.categories, streamsByCat);
    vodAdminConfig = buildProviderAdminConfig(nodecast.vodCategories, nodecast.vodStreamsByCat);
    seriesAdminConfig = buildProviderAdminConfig(nodecast.seriesCategories, nodecast.seriesStreamsByCat);
    logVeloraRawMediaCatalogLayoutDebug("vod", nodecast.vodCategories, nodecast.vodStreamsByCat, vodAdminConfig);
    logVeloraRawMediaCatalogLayoutDebug(
      "series",
      nodecast.seriesCategories,
      nodecast.seriesStreamsByCat,
      seriesAdminConfig
    );
    nodecastVodCatalogFetchError = null;
    nodecastSeriesCatalogFetchError = null;

    state = {
      mode,
      base: activeBase,
      username,
      password,
      nodecastAuthHeaders,
      serverInfo: serverInfo!,
      liveCategories: nodecast.categories,
      streamsByCatAll: new Map(streamsByCat),
      liveLoadedCategoryIds: new Set(streamsByCat.keys()),
      nodecastXtreamSourceId: nodecast.nodecastXtreamSourceId,
      vodCategories: nodecast.vodCategories,
      vodStreamsByCat: nodecast.vodStreamsByCat,
      vodLoadedCategoryIds: new Set(),
      seriesCategories: nodecast.seriesCategories,
      seriesStreamsByCat: nodecast.seriesStreamsByCat,
      seriesLoadedCategoryIds: new Set(),
      vodCatalogLoaded: false,
      seriesCatalogLoaded: false,
    };

    await warmSelectedCountryLiveCatalog();

    selectedPillId = "all";
    activeStreamId = null;
    destroyPlayer();
    destroyVodPlayer();
    elNowPlaying.textContent = "";

    const routeOk = await tryApplyVeloraUiRouteAfterSessionReady({
      skipMediaTabRestore: Boolean(opts?.skipMediaRouteRestore),
    });
    if (!routeOk) goLiveHome();
    warmSelectedCountryMediaCatalogsInBackground();
    void postHomeSetupPromise.then(() => {
      if (!state) return;
      populateCountrySelectFromAdmin();
      if (uiShell === "packages") {
        schedulePackagesGridRender();
      } else if (uiAdminPackageId != null) {
        renderPackageChannelList();
      }
      syncAdminSettingsButton();
      persistVeloraNodecastSnapshot();
      persistVeloraUiRoute();
    });
    elLoginPanel.classList.add("hidden");
    elMain.classList.remove("hidden");
    ensureVeloraHistoryRootMarker();
    syncAdminSettingsButton();
    setLoginStatus("");
    persistVeloraNodecastSnapshot();
    persistVeloraUiRoute();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setLoginStatus(msg, true);
    if (envAutoConnectConfigured()) {
      elMain.classList.remove("hidden");
      ensureVeloraHistoryRootMarker();
      elLoginPanel.classList.add("hidden");
      elHeaderLoginOnly?.classList.add("hidden");
      elPackagesView.classList.remove("hidden");
      elPackagesView.innerHTML = `<div class="vel-empty-msg" style="grid-column: 1 / -1; text-align: center; padding: 2rem 1rem; color: #fca5a5">${escapeHtml(msg)}</div>`;
    } else {
      elMain.classList.add("hidden");
      elLoginPanel.classList.remove("hidden");
      elHeaderLoginOnly?.classList.remove("hidden");
    }
  } finally {
    setCatalogLoadingVisible(false);
    elBtnConnect.disabled = false;
  }
}

function disconnect(): void {
  clearVeloraNodecastSnapshot();
  clearVeloraUiRouteStorage();
  veloraUiHistoryDepth = 0;
  veloraApplyingHistoryPopstate = true;
  setChannelNamePrefixesFromDatabase(null);
  setChannelHideNeedlesFromDatabase(null);
  adminConfig = { ...EMPTY_ADMIN_CONFIG };
  vodAdminConfig = { ...EMPTY_ADMIN_CONFIG };
  seriesAdminConfig = { ...EMPTY_ADMIN_CONFIG };
  dbAdminCountries = [];
  dbAdminPackages = [];
  streamCurationByCountry = new Map();
  packageCoverOverrideById = new Map();
  populateCountrySelectFromAdmin();
  state = null;
  activeStreamId = null;
  vodMovieUiPhase = "list";
  vodDetailStream = null;
  seriesUiPhase = "list";
  seriesDetailStream = null;
  selectedPillId = "all";
  uiTab = "live";
  uiShell = "packages";
  adultPortalMode = false;
  adultPortalTab = "live";
  uiAdminPackageId = null;
  destroyPlayer();
  destroyVodPlayer();
  veloraApplyingHistoryPopstate = false;
  elDynamicList.classList.remove("item-list--vod-vertical", "item-list--vod-film-detail");
  elContentView.classList.remove("content-view--vod-film-detail");
  elDynamicList.innerHTML = "";
  elCatPills.innerHTML = "";
  elPackagesView.innerHTML = "";
  elNowPlaying.textContent = "";
  elContentView.classList.add("hidden");
  elPackagesView.classList.remove("hidden");
  elMainTabs.classList.remove("hidden");
  syncAdultPortalChrome();
  elCatPillsWrap.classList.add("hidden");
  setTabsActive("live");
  applyPresetTheme("default");
  syncMainInPackageClass();
  if (envAutoConnectConfigured()) {
    applyNodecastEnvDefaults();
    prepareEnvAutoconnectUi();
    void connect();
    return;
  }
  elMain.classList.add("hidden");
  elLoginPanel.classList.remove("hidden");
  elHeaderLoginOnly?.classList.remove("hidden");
  setLoginStatus("");
}

function onCountryChange(): void {
  selectedAdminCountryId = elCountrySelect.value || null;
  try {
    if (selectedAdminCountryId) {
      sessionStorage.setItem(COUNTRY_STORAGE_KEY, selectedAdminCountryId);
    }
  } catch {
    /* ignore */
  }

  if (!state) return;

  if (uiShell === "content" && uiAdminPackageId) {
    const merged = mergedPackagesForGrid();
    if (!merged.some((p) => p.id === uiAdminPackageId)) {
      showPackagesShell();
      void (async () => {
        if (uiTab === "live") {
          await warmSelectedCountryLiveCatalog();
          warmSelectedCountryMediaCatalogsInBackground();
        } else {
          await warmSelectedCountryCatalogs();
        }
        if (state && uiAdminPackageId == null) {
          schedulePackagesGridRender();
          syncPlayerDismissOverlay();
        }
      })();
      return;
    }
    if (uiTab === "live") {
      syncPillDefsForPackage(uiAdminPackageId);
      renderCategoryPills();
    } else {
      renderPackageChannelList();
    }
    return;
  }

  if (uiShell === "packages") {
    void (async () => {
      if (uiTab === "live") {
        await warmSelectedCountryLiveCatalog();
        warmSelectedCountryMediaCatalogsInBackground();
      } else {
        await warmSelectedCountryCatalogs();
      }
      if (state && uiShell === "packages") {
        schedulePackagesGridRender();
        syncPlayerDismissOverlay();
      }
    })();
  }

  schedulePersistVeloraUiRoute();
}

elBtnConnect.addEventListener("click", () => void connect());
elBtnLogout.addEventListener("click", disconnect);
elBtnClosePlayer?.addEventListener("click", () => closePlayerUserAction());
elBtnCloseVodPlayer?.addEventListener("click", () => closeVodPlayerUserAction());
elBtnLogoHome?.addEventListener("click", () => {
  exitAdultPortalMode();
  uiTab = "live";
  showPackagesShell();
});
elBtnBackHome.addEventListener("click", () => returnToCurrentPackageListFromToolbar());
elBtnGoHome?.addEventListener("click", () => {
  exitAdultPortalMode();
  uiTab = "live";
  showPackagesShell();
});

elTabLive.addEventListener("click", () => onTabClick("live"));
elTabMovies.addEventListener("click", () => onTabClick("movies"));
elTabSeries.addEventListener("click", () => onTabClick("series"));
elBtnAdultPortal?.addEventListener("click", () => void showAdultPortal("live"));
elAdultTabLive?.addEventListener("click", () => void showAdultPortal("live"));
elAdultTabMovies?.addEventListener("click", () => void showAdultPortal("movies"));
elAdultTabHome?.addEventListener("click", () => {
  exitAdultPortalMode();
  uiTab = "live";
  showPackagesShell();
});

elCountrySelect.addEventListener("change", onCountryChange);

applyNodecastEnvDefaults();
initTvNavigation();

initTrialGate({
  onTrialBlocked: () => {
    destroyPlayer();
    destroyVodPlayer();
    setPlayerBufferingVisible(false);
    setVodPlayerBufferingVisible(false);
  },
});

if (envAutoConnectConfigured()) {
  elHeaderLoginOnly?.classList.add("hidden");
  elLoginPanel.classList.add("hidden");
  elMain.classList.remove("hidden");
}

/** Click on the picture (not the native control bar) toggles play / pause. */
function toggleVideoPlayPause(ev: MouseEvent): void {
  if (!hls && !elVideo.src && !elVideo.currentSrc) return;
  const target = ev.target as Element | null;
  if (target?.closest("#live-controls-overlay")) return;
  const r = elVideo.getBoundingClientRect();
  const y = ev.clientY - r.top;
  const controlsReservePx = 52;
  if (y > r.height - controlsReservePx) return;
  ev.preventDefault();
  if (elVideo.paused) {
    if (isTrialBlocked()) {
      showTrialExpiredModal();
      return;
    }
    void elVideo.play().catch(() => {});
  } else elVideo.pause();
}

setupLiveControls();
elVideo.addEventListener("click", toggleVideoPlayPause);
elLiveVideoWrapper?.addEventListener("click", toggleVideoPlayPause);

function toggleVideoPlayPauseVod(ev: MouseEvent): void {
  if (!elVideoVod) return;
  if (!hlsVod && !elVideoVod.src && !elVideoVod.currentSrc) return;
  const r = elVideoVod.getBoundingClientRect();
  const y = ev.clientY - r.top;
  const controlsReservePx = 52;
  if (y > r.height - controlsReservePx) return;
  ev.preventDefault();
  if (elVideoVod.paused) {
    if (isTrialBlocked()) {
      showTrialExpiredModal();
      return;
    }
    void elVideoVod.play().catch(() => {});
  } else elVideoVod.pause();
}

elVideoVod?.addEventListener("click", toggleVideoPlayPauseVod);
window.addEventListener("pagehide", () => {
  teardownVodMedia();
  persistVeloraUiRoute();
});
window.addEventListener("beforeunload", teardownVodMedia);

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement?.closest(".login-panel")) {
    void connect();
  }
});

if (envAutoConnectConfigured() && !isSettingsPageOpen()) {
  prepareEnvAutoconnectUi();
  void bootEnvAutoconnect();
} else if (!isSettingsPageOpen()) {
  void fetchAndApplyCanonicalCountries().catch(() => {});
  void refreshSupabaseHierarchy().then(() => syncAdminSettingsButton());
} else {
  syncAdminSettingsButton();
}
