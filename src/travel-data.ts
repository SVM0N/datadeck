// ─── Travel view: reference data + pure analysis ────────────────────────────
//
// Ported from the standalone travel-tracker visualizer (visualizer.html).
// This module is DOM-free and side-effect-free so it can be unit-tested.
// The companion `travel-view.ts` renders the model this produces.
//
// Source format: the flat `travel_flat.csv` emitted by travel.py — one header,
// uniform rows, with a `source` column (confirmed | inferred | conflict).
// See docs / handoff "Travel / world-map view" for the overlap rules.

import { CSVRow } from "./types";

export interface TravelRow {
  date_entered: string;
  date_left: string;
  country: string;      // ISO-2
  city: string;
  visa_status: string;
  notes: string;
  source: string;       // confirmed | inferred | conflict
  resolved: string;
  /** The original CSVRow this was derived from — edit through this to persist. */
  _src: CSVRow;
}

export const TOTAL_COUNTRIES = 195;

export const NAMES: Record<string, string> = {AF:'Afghanistan',AL:'Albania',DZ:'Algeria',AD:'Andorra',AO:'Angola',AR:'Argentina',AM:'Armenia',AU:'Australia',AT:'Austria',AZ:'Azerbaijan',BD:'Bangladesh',BY:'Belarus',BE:'Belgium',BO:'Bolivia',BA:'Bosnia',BW:'Botswana',BR:'Brazil',BG:'Bulgaria',KH:'Cambodia',CM:'Cameroon',CA:'Canada',CL:'Chile',CN:'China',CO:'Colombia',HR:'Croatia',CU:'Cuba',CY:'Cyprus',CZ:'Czechia',DK:'Denmark',DO:'Dominican Rep.',EC:'Ecuador',EG:'Egypt',ET:'Ethiopia',FI:'Finland',FR:'France',GE:'Georgia',DE:'Germany',GH:'Ghana',GR:'Greece',GT:'Guatemala',GY:'Guyana',HT:'Haiti',HN:'Honduras',HU:'Hungary',IS:'Iceland',IN:'India',ID:'Indonesia',IR:'Iran',IQ:'Iraq',IE:'Ireland',IL:'Israel',IT:'Italy',JP:'Japan',JO:'Jordan',KZ:'Kazakhstan',KE:'Kenya',KP:'N. Korea',KR:'S. Korea',KW:'Kuwait',KG:'Kyrgyzstan',LA:'Laos',LV:'Latvia',LB:'Lebanon',LY:'Libya',LI:'Liechtenstein',LT:'Lithuania',LU:'Luxembourg',MY:'Malaysia',ML:'Mali',MT:'Malta',MR:'Mauritania',MX:'Mexico',MD:'Moldova',MN:'Mongolia',ME:'Montenegro',MA:'Morocco',MZ:'Mozambique',MM:'Myanmar',NA:'Namibia',NP:'Nepal',NL:'Netherlands',NZ:'New Zealand',NI:'Nicaragua',NE:'Niger',NG:'Nigeria',NO:'Norway',OM:'Oman',PK:'Pakistan',PA:'Panama',PG:'Papua New Guinea',PY:'Paraguay',PE:'Peru',PH:'Philippines',PL:'Poland',PT:'Portugal',QA:'Qatar',RO:'Romania',RU:'Russia',RW:'Rwanda',SA:'Saudi Arabia',SN:'Senegal',RS:'Serbia',SG:'Singapore',SK:'Slovakia',SI:'Slovenia',SO:'Somalia',ZA:'South Africa',SS:'South Sudan',ES:'Spain',LK:'Sri Lanka',SD:'Sudan',SE:'Sweden',CH:'Switzerland',SY:'Syria',TJ:'Tajikistan',TZ:'Tanzania',TH:'Thailand',TN:'Tunisia',TR:'Turkey',TM:'Turkmenistan',UG:'Uganda',UA:'Ukraine',AE:'UAE',GB:'United Kingdom',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',VN:'Vietnam',YE:'Yemen',ZM:'Zambia',ZW:'Zimbabwe',MC:'Monaco',BZ:'Belize'};

const CONTINENTS: Record<string, string[]> = {
  AF:['DZ','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CD','CG','CI','DJ','EG','GQ','ER','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG','RE','RW','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','ZM','ZW'],
  AN:['AQ'],
  AS:['AF','AM','AZ','BH','BD','BT','BN','KH','CN','CY','GE','IN','ID','IR','IQ','IL','JP','JO','KZ','KW','KG','LA','LB','MY','MV','MN','MM','NP','KP','OM','PK','PS','PH','QA','RU','SA','SG','KR','LK','SY','TW','TJ','TH','TL','TR','TM','AE','UZ','VN','YE'],
  EU:['AL','AD','AT','BY','BE','BA','BG','HR','CZ','DK','EE','FI','FR','DE','GR','HU','IS','IE','IT','XK','LV','LI','LT','LU','MT','MD','MC','ME','NL','MK','NO','PL','PT','RO','RU','SM','RS','SK','SI','ES','SE','CH','UA','GB','VA'],
  NA:['AG','BS','BB','BZ','CA','CR','CU','DM','DO','SV','GD','GT','HT','HN','JM','MX','NI','PA','KN','LC','VC','TT','US'],
  OC:['AU','FJ','KI','MH','FM','NR','NZ','PW','PG','WS','SB','TO','TV','VU'],
  SA:['AR','BO','BR','CL','CO','EC','GY','PY','PE','SR','UY','VE'],
};
export const CONT_NAMES: Record<string, string> = {AF:'Africa',AN:'Antarctica',AS:'Asia',EU:'Europe',NA:'N. America',OC:'Oceania',SA:'S. America'};

const isoToCont: Record<string, string> = {};
for (const [cont, isos] of Object.entries(CONTINENTS)) for (const iso of isos) isoToCont[iso] = cont;

const TOURIST_V = new Set(['tourist','visitor','b-1','b-2','b1','b2','b','transit']);

/** Country name for an ISO-2 code, falling back to the code itself. */
export function countryName(iso: string): string { return NAMES[iso] || iso; }

/** Unicode regional-indicator flag emoji from an ISO-2 code. */
export function flag(a2: string): string {
  if (!a2 || a2.length !== 2) return "";
  return String.fromCodePoint(...a2.toUpperCase().split("").map(c => c.charCodeAt(0) + 127397));
}

export function isTourist(visa: string): boolean {
  return TOURIST_V.has((visa || "").toLowerCase().trim());
}

/** Parse a YYYY-MM-DD date. Returns null for blank or partial (`2022-06-??`) dates. */
export function pd(s: string): Date | null {
  if (!s || s.indexOf("?") !== -1) return null;
  const d = new Date(s + "T12:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

/** Inclusive trip length in days (min 1). 0 when either date is missing/partial. */
export function tripDays(r: TravelRow): number {
  const a = pd(r.date_entered), b = pd(r.date_left);
  if (!a || !b) return 0;
  return Math.max(Math.round((b.getTime() - a.getTime()) / 86400000), 1);
}

export interface CountryStat { iso: string; days: number; }

export interface TravelModel {
  confirmed: TravelRow[];
  inferred: TravelRow[];
  conflicts: TravelRow[];
  /** Inferred rows with valid dates that do NOT overlap any confirmed range — safe to plot. */
  inferredVisible: TravelRow[];
  confRanges: Array<[number, number]>;        // epoch-ms pairs of confirmed trips
  confirmedCountries: Set<string>;            // gold
  inferredOnlyCountries: Set<string>;         // blue (seen only via photos)
  allCountries: Set<string>;
  countryDays: CountryStat[];                 // confirmed day totals, desc; undated → days 0
  totalConfirmedDays: number;
  visitedContinents: Set<string>;
  worldPct: number;
}

/** Split the raw CSV rows by `source` and compute everything the view needs. */
export function analyzeTravel(rows: CSVRow[]): TravelModel {
  const toRow = (r: CSVRow): TravelRow => ({
    date_entered: r.date_entered ?? "",
    date_left: r.date_left ?? "",
    country: (r.country ?? "").trim().toUpperCase(),
    city: r.city ?? "",
    visa_status: r.visa_status ?? "",
    notes: r.notes ?? "",
    source: (r.source ?? "").trim().toLowerCase(),
    resolved: r.resolved ?? "",
    _src: r,
  });
  const all = rows.map(toRow).filter(r => r.country);

  const confirmed = all.filter(r => r.source === "confirmed");
  const inferred = all.filter(r => r.source === "inferred");
  const conflicts = all.filter(r => r.source === "conflict");

  const confRanges: Array<[number, number]> = [];
  for (const r of confirmed) {
    const a = pd(r.date_entered), b = pd(r.date_left);
    if (a && b) confRanges.push([a.getTime(), b.getTime()]);
  }
  const overlapsConfirmed = (r: TravelRow): boolean => {
    const a = pd(r.date_entered), b = pd(r.date_left);
    if (!a || !b) return false;
    const am = a.getTime(), bm = b.getTime();
    return confRanges.some(([ca, cb]) => am <= cb && bm >= ca);
  };
  const inferredVisible = inferred.filter(r => pd(r.date_entered) && pd(r.date_left) && !overlapsConfirmed(r));

  const confirmedCountries = new Set(confirmed.map(r => r.country));
  const inferredCountries = new Set(inferred.map(r => r.country));
  const inferredOnlyCountries = new Set([...inferredCountries].filter(c => !confirmedCountries.has(c)));
  const allCountries = new Set([...confirmedCountries, ...inferredCountries]);

  const dayMap = new Map<string, number>();
  for (const r of confirmed) dayMap.set(r.country, (dayMap.get(r.country) || 0) + tripDays(r));
  const countryDays = [...dayMap.entries()]
    .map(([iso, days]) => ({ iso, days }))
    .sort((x, y) => y.days - x.days || countryName(x.iso).localeCompare(countryName(y.iso)));
  const totalConfirmedDays = countryDays.reduce((s, c) => s + c.days, 0);

  const visitedContinents = new Set<string>();
  for (const iso of confirmedCountries) { const c = isoToCont[iso]; if (c) visitedContinents.add(c); }

  return {
    confirmed, inferred, conflicts, inferredVisible, confRanges,
    confirmedCountries, inferredOnlyCountries, allCountries,
    countryDays, totalConfirmedDays, visitedContinents,
    worldPct: Math.round(confirmedCountries.size / TOTAL_COUNTRIES * 100),
  };
}
