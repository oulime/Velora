/**
 * Map noisy IPTV category titles to one dropdown country (e.g. "France 4k", "France cinema" → France).
 * Keys are normalized (ASCII, lower); match longest key first as prefix of the cleaned title.
 */

export type ParsedCountry = { id: string; name: string };

/** Normalize for comparison: lower, strip accents, collapse spaces. */
export function normalizeCountryKey(s: string): string {
  return s
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugId(key: string): string {
  return `country_${key.replace(/\s+/g, "_")}`;
}

/** Trailing bouquet / quality tokens (not part of the country name). */
const TRAILING_STRIP = new RegExp(
  String.raw`\s+(4k|8k|2k|uhd|fhd|full\s*hd|hd|sd|hevc|h265|h264|hdr|sdr|2160p|1080p|720p|vip|premium|plus|ultra|max|pro|lite|backup|low|iptv|vod|docs?|series|seasons?|live|radio|ppv|uhd|sd|hd)\s*$`,
  "i"
);

const TRAILING_STRIP2 = new RegExp(
  String.raw`\s+(cinema|cinemas|carribain|caribbean|caribéenne|antilles|guadeloupe|martinique|guyane|guyana|réunion|reunion|mayotte|polynesia|polynesie|ocean|océan|oth|others?|misc|mix|general|local|national|international|hd|fhd|uhd)\s*$`,
  "i"
);

/** Strip trailing non-country words repeatedly. */
export function stripCountryNoise(normalized: string): string {
  let t = normalized.trim();
  for (let i = 0; i < 16; i++) {
    const a = t.replace(TRAILING_STRIP, "").trim();
    const b = a.replace(TRAILING_STRIP2, "").trim();
    if (b === t) break;
    t = b;
  }
  return t;
}

/**
 * Each line: `englishKey|French display name`.
 * First keys `ar|…` / `af|…` / `as|…` / `eu|…` align with normalized bouquets `|AR|`, `|AF|`, `|AS|`, `|EU|`.
 * Pays du monde arabe (Maghreb, Machrek, péninsule) : pas de ligne dédiée — regroupés via `|AR|` / clé `ar`.
 */
const RAW = `
ar|Arabe
af|Afrique
as|Asie
eu|Europe
bosnia and herzegovina|Bosnie-Herzégovine
trinidad and tobago|Trinité-et-Tobago
papua new guinea|Papouasie-Nouvelle-Guinée
equatorial guinea|Guinée équatoriale
burkina faso|Burkina Faso
czech republic|République tchèque
dominican republic|République dominicaine
united kingdom|Royaume-Uni
united states|États-Unis
south africa|Afrique du Sud
costa rica|Costa Rica
el salvador|Salvador
new zealand|Nouvelle-Zélande
sri lanka|Sri Lanka
north macedonia|Macédoine du Nord
south korea|Corée du Sud
north korea|Corée du Nord
new caledonia|Nouvelle-Calédonie
solomon islands|Îles Salomon
marshall islands|Îles Marshall
cape verde|Cap-Vert
cabo verde|Cap-Vert
east timor|Timor oriental
timor leste|Timor oriental
ivory coast|Côte d’Ivoire
cote d ivoire|Côte d’Ivoire
côte d ivoire|Côte d’Ivoire
democratic republic of the congo|RD Congo
republic of the congo|Congo
central african republic|Centrafrique
south sudan|Soudan du Sud
sierra leone|Sierra Leone
sri lanka|Sri Lanka
san marino|Saint-Marin
sao tome and principe|São Tomé-et-Príncipe
saint kitts and nevis|Saint-Kitts-et-Nevis
saint lucia|Sainte-Lucie
saint vincent and the grenadines|Saint-Vincent-et-les-Grenadines
antigua and barbuda|Antigua-et-Barbuda
united kingdom|Royaume-Uni
great britain|Royaume-Uni
england|Angleterre
scotland|Écosse
wales|Pays de Galles
northern ireland|Irlande du Nord
france|France
germany|Allemagne
spain|Espagne
italy|Italie
portugal|Portugal
netherlands|Pays-Bas
pays bas|Pays-Bas
holland|Pays-Bas
belgium|Belgique
allemagne|Allemagne
espagne|Espagne
italie|Italie
maroc|Maroc
belgique|Belgique
grece|Grèce
switzerland|Suisse
austria|Autriche
poland|Pologne
greece|Grèce
turkey|Turquie
sweden|Suède
norway|Norvège
denmark|Danemark
finland|Finlande
ireland|Irlande
iceland|Islande
luxembourg|Luxembourg
malta|Malte
cyprus|Chypre
estonia|Estonie
latvia|Lettonie
lithuania|Lituanie
croatia|Croatie
slovenia|Slovénie
slovakia|Slovaquie
hungary|Hongrie
romania|Roumanie
bulgaria|Bulgarie
serbia|Serbie
montenegro|Monténégro
albania|Albanie
north macedonia|Macédoine du Nord
kosovo|Kosovo
ukraine|Ukraine
moldova|Moldavie
belarus|Biélorussie
russia|Russie
georgia|Géorgie
armenia|Arménie
azerbaijan|Azerbaïdjan
kazakhstan|Kazakhstan
uzbekistan|Ouzbékistan
turkmenistan|Turkménistan
kyrgyzstan|Kirghizistan
tajikistan|Tadjikistan
mongolia|Mongolie
china|Chine
japan|Japon
south korea|Corée du Sud
north korea|Corée du Nord
taiwan|Taïwan
hong kong|Hong Kong
macau|Macao
vietnam|Viêt Nam
thailand|Thaïlande
cambodia|Cambodge
laos|Laos
myanmar|Myanmar
bangladesh|Bangladesh
india|Inde
pakistan|Pakistan
afghanistan|Afghanistan
iran|Iran
israel|Israël
senegal|Sénégal
mali|Mali
burkina faso|Burkina Faso
niger|Niger
nigeria|Nigeria
chad|Tchad
south sudan|Soudan du Sud
ethiopia|Éthiopie
eritrea|Érythrée
kenya|Kenya
uganda|Ouganda
tanzania|Tanzanie
rwanda|Rwanda
burundi|Burundi
democratic republic of the congo|RD Congo
republic of the congo|Congo
gabon|Gabon
cameroon|Cameroun
central african republic|Centrafrique
angola|Angola
zambia|Zambie
zimbabwe|Zimbabwe
botswana|Botswana
namibia|Namibie
south africa|Afrique du Sud
lesotho|Lesotho
eswatini|Eswatini
mozambique|Mozambique
malawi|Malawi
madagascar|Madagascar
mauritius|Maurice
seychelles|Seychelles
cape verde|Cap-Vert
ghana|Ghana
togo|Togo
benin|Bénin
ivory coast|Côte d’Ivoire
liberia|Libéria
sierra leone|Sierra Leone
guinea|Guinée
guinea bissau|Guinée-Bissau
equatorial guinea|Guinée équatoriale
sao tome and principe|São Tomé-et-Príncipe
gambia|Gambie
canada|Canada
united states|États-Unis
mexico|Mexique
guatemala|Guatemala
belize|Belize
honduras|Honduras
el salvador|Salvador
nicaragua|Nicaragua
costa rica|Costa Rica
panama|Panama
cuba|Cuba
jamaica|Jamaïque
haiti|Haïti
dominican republic|République dominicaine
puerto rico|Porto Rico
bahamas|Bahamas
barbados|Barbade
trinidad and tobago|Trinité-et-Tobago
colombia|Colombie
venezuela|Venezuela
guyana|Guyana
suriname|Suriname
brazil|Brésil
ecuador|Équateur
peru|Pérou
bolivia|Bolivie
paraguay|Paraguay
uruguay|Uruguay
chile|Chili
argentina|Argentine
australia|Australie
new zealand|Nouvelle-Zélande
fiji|Fidji
papua new guinea|Papouasie-Nouvelle-Guinée
new caledonia|Nouvelle-Calédonie
french polynesia|Polynésie française
japan|Japon
philippines|Philippines
indonesia|Indonésie
malaysia|Malaisie
singapore|Singapour
brunei|Brunei
east timor|Timor oriental
vanuatu|Vanuatu
samoa|Samoa
tonga|Tonga
micronesia|Micronésie
palau|Palaos
marshall islands|Îles Marshall
solomon islands|Îles Salomon
kiribati|Kiribati
nauru|Nauru
tuvalu|Tuvalu
luxembourg|Luxembourg
liechtenstein|Liechtenstein
monaco|Monaco
andorra|Andorre
san marino|Saint-Marin
vatican|Vatican
maldives|Maldives
bhutan|Bhoutan
nepal|Népal
sri lanka|Sri Lanka
bangladesh|Bangladesh
pakistan|Pakistan
`.trim();

type Row = { key: string; id: string; name: string };

function sortRowsForMatch(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (b.key.length !== a.key.length) return b.key.length - a.key.length;
    return a.name.localeCompare(b.name, "fr");
  });
}

function buildBundledRows(): Row[] {
  const seen = new Map<string, Row>();
  for (const line of RAW.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const pipe = t.indexOf("|");
    if (pipe < 0) continue;
    const keyRaw = t.slice(0, pipe).trim();
    const name = t.slice(pipe + 1).trim();
    if (!keyRaw || !name) continue;
    const key = normalizeCountryKey(keyRaw);
    if (!key) continue;
    const id = slugId(key);
    if (!seen.has(key)) seen.set(key, { key, id, name });
  }
  return sortRowsForMatch([...seen.values()]);
}

/** Supabase canonical rows (sorted longest-key first); merged at read time with bundled defaults. */
let dbRowsSorted: Row[] | null = null;
let bundledCache: Row[] | null = null;

function mergeDbRowsWithBundledRows(dbRows: Row[], bundled: Row[]): Row[] {
  const byKey = new Map<string, Row>();
  for (const row of bundled) {
    byKey.set(row.key, row);
  }
  for (const row of dbRows) {
    byKey.set(row.key, row);
  }
  return sortRowsForMatch([...byKey.values()]);
}

export function setCanonicalCountriesFromDatabase(
  rows: ReadonlyArray<{ id: string; match_key: string; display_name: string }> | null
): void {
  if (!rows?.length) {
    dbRowsSorted = null;
    return;
  }
  const byKey = new Map<string, Row>();
  for (const r of rows) {
    const nameRaw = (r.display_name ?? "").trim();
    const mkKey = normalizeCountryKey(r.match_key);
    const dnKey = normalizeCountryKey(nameRaw);
    const name = nameRaw || mkKey || dnKey;
    const keys: string[] = [];
    if (mkKey) keys.push(mkKey);
    if (dnKey && dnKey !== mkKey) keys.push(dnKey);
    if (!keys.length) continue;
    for (const key of keys) {
      if (!key) continue;
      byKey.set(key, { key, id: r.id, name: name || key });
    }
  }
  dbRowsSorted = byKey.size ? sortRowsForMatch([...byKey.values()]) : null;
}

function rows(): Row[] {
  const bundled = bundledCache ?? buildBundledRows();
  if (!bundledCache) bundledCache = bundled;

  if (!dbRowsSorted || dbRowsSorted.length === 0) return bundled;

  return mergeDbRowsWithBundledRows(dbRowsSorted, bundled);
}

/** Longest-prefix match on normalized + noise-stripped title → one canonical country, or null → Autres. */
export function matchCanonicalCountry(cleanedTitle: string): ParsedCountry | null {
  const n0 = normalizeCountryKey(cleanedTitle);
  if (!n0) return null;
  const n = stripCountryNoise(n0);
  const candidates = [n, n0];
  for (const cand of candidates) {
    if (!cand) continue;
    for (const row of rows()) {
      if (cand === row.key || cand.startsWith(`${row.key} `)) {
        return { id: row.id, name: row.name };
      }
    }
  }
  return null;
}
