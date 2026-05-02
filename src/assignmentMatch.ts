/** Shared channel label + optional rule matching helpers. */

/** Longest first: strip longest configured prefix before shorter overlapping ones. */
let channelPrefixesOrdered: string[] = [];

/** Called after Supabase fetch; `null` or empty → no prefix stripping. */
export function setChannelNamePrefixesFromDatabase(prefixes: readonly string[] | null): void {
  if (!prefixes?.length) {
    channelPrefixesOrdered = [];
    return;
  }
  const uniq = [...new Set(prefixes.map((p) => p.trim()).filter(Boolean))];
  uniq.sort((a, b) => b.length - a.length);
  channelPrefixesOrdered = uniq;
}

function stripLeadingPrefixes(raw: string): string {
  let s = raw.trim();
  if (!channelPrefixesOrdered.length) return s;
  for (let guard = 0; guard < 64; guard++) {
    let hit = false;
    for (const p of channelPrefixesOrdered) {
      const n = p.length;
      if (!n || n > s.length) continue;
      if (s.slice(0, n).toLowerCase() === p.toLowerCase()) {
        s = s.slice(n).trim();
        hit = true;
        break;
      }
    }
    if (!hit) break;
  }
  return s.length ? s : raw.trim();
}

function assignmentExactMatchOnly(): boolean {
  const v = import.meta.env?.VITE_ASSIGNMENT_EXACT_MATCH_ONLY;
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Strips leading prefixes from `admin_channel_name_prefixes` (Supabase), case-insensitive at start. */
export function displayChannelName(raw: string): string {
  return stripLeadingPrefixes(raw);
}

/** Substrings (from `admin_hidden_filters`): if any appears in the channel name, the channel is not listed. */
let channelHideNeedlesOrdered: string[] = [];

export function setChannelHideNeedlesFromDatabase(needles: readonly string[] | null): void {
  if (!needles?.length) {
    channelHideNeedlesOrdered = [];
    return;
  }
  const uniq = [...new Set(needles.map((n) => n.trim()).filter(Boolean))];
  uniq.sort((a, b) => b.length - a.length);
  channelHideNeedlesOrdered = uniq;
}

function haystackForHideMatch(s: string): string {
  try {
    return s.normalize("NFKC").trim().toLowerCase();
  } catch {
    return s.trim().toLowerCase();
  }
}

/** True when the raw catalogue name contains any configured needle (substring, case-insensitive). */
export function shouldHideChannelByName(rawName: string): boolean {
  if (!channelHideNeedlesOrdered.length) return false;
  const hay = haystackForHideMatch(rawName);
  return channelHideNeedlesOrdered.some((n) => hay.includes(haystackForHideMatch(n)));
}

export type AssignmentRule = { match_text: string; category_id: string };

function stripMatchDecorators(s: string): string {
  return s
    .replace(/^[\s\uFEFF"'“”‘’\[\]()]+/u, "")
    .replace(/[\s"'“”‘’\[\]()]+$/u, "")
    .trim();
}

function normalizeKey(s: string): string {
  let t = s;
  try {
    t = t.normalize("NFKC");
  } catch {
    /* ignore */
  }
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

function compactKey(s: string): string {
  return normalizeKey(s).replace(/\s/g, "");
}

/**
 * Maps a provider stream name to an admin leaf `category_id` using `admin_channel_rules`.
 * Compares normalized names (case, spacing, NFKC); substring match prefers longer `match_text`
 * first; optional compact (no spaces) match. `match_text` is what you configure in Admin.
 */
export function assignmentCategoryIdForStreamName(
  streamName: string,
  assignments: readonly AssignmentRule[]
): string | null {
  if (!assignments.length) return null;

  const stripped = displayChannelName(streamName);
  const rawTrim = streamName.trim();
  if (!stripped && !rawTrim) return null;
  const k1 = normalizeKey(stripped);
  const k2 = normalizeKey(rawTrim);
  const variants = k1 === k2 ? [k1] : [k1, k2];

  for (const a of assignments) {
    const needle = normalizeKey(stripMatchDecorators(a.match_text));
    if (!needle) continue;
    for (const v of variants) {
      if (v === needle) return a.category_id;
    }
  }

  if (assignmentExactMatchOnly()) return null;

  const byNeedleLen = [...assignments].sort(
    (a, b) =>
      normalizeKey(stripMatchDecorators(b.match_text)).length -
      normalizeKey(stripMatchDecorators(a.match_text)).length
  );

  for (const a of byNeedleLen) {
    const needle = normalizeKey(stripMatchDecorators(a.match_text));
    if (needle.length < 3) continue;
    for (const v of variants) {
      if (v.includes(needle)) return a.category_id;
    }
  }

  for (const a of byNeedleLen) {
    const needle = normalizeKey(stripMatchDecorators(a.match_text));
    const needleC = compactKey(needle);
    if (needleC.length < 4) continue;
    for (const v of variants) {
      if (compactKey(v).includes(needleC)) return a.category_id;
    }
  }

  return null;
}
