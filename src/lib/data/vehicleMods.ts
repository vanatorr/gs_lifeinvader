/**
 * `owned_vehicles.vehicle` -> the modifications a car is actually wearing, in words.
 *
 * WHAT THIS ANSWERS (owner, 2026-08-21): "in citadel i wanna see on each car all the mods applied to
 * it on a the player or job page". The blob is ~75 raw keys of GTA mod indices (`modEngine: 3`,
 * `wheels: 7`, `windowTint: 1`, `color1: 111`), which is exactly the shape the panel's own design
 * rule forbids putting in front of a moderator: labels, never ids, and no raw JSON in normal
 * reading. So every number here is resolved to the SAME French word the mechanic saw in the Benny's
 * menu when they installed it.
 *
 * EVERY LABEL COMES FROM THE GAME'S OWN FILES, none is typed here - the same discipline, and the
 * same reason, as vehicleModels.ts reading `vehicleList.lua` instead of shipping a hash table:
 *
 *   esx_lscustom/config.lua      Config.Menus slot labels, the per-slot `price` arrays that define
 *                                how many upgrade LEVELS a slot has, the wheel-type entries, the
 *                                GetColors() paint index -> label lists, XenonColorNames,
 *                                GetWindowName / GetPlatesName / GetHornName, GetNeons().
 *   esx_lscustom/locales/fr.lua  the `_U('key')` -> French string those tables point at.
 *
 * Change a colour name or add a mod tier in the game and this follows on the next cache expiry,
 * with nothing to edit here. If either file is unreachable in a deployment, resolution degrades to
 * an honest "#<index>" rather than a guess, exactly like an unresolvable model hash.
 *
 * GROUPING is the one thing this module decides for itself, and deliberately: Config.Menus' own
 * `parent` tree is a purchase flow (its `cosmetics` node holds 30 entries) rather than a reading
 * order, so the groups below are a PRESENTATION choice over game-supplied labels. No value is
 * invented by that.
 *
 * WHAT CANNOT BE RESOLVED, and is therefore never faked: the individual VARIANT names of body
 * parts ("Spoiler de course", "Capot carbone"). GTA exposes those through GetModTextLabel, a client
 * native that needs the model streamed in - unreachable from a web server. A variant renders as
 * "Variante 3", which is what its position in the mechanic's list actually is, and never as an
 * invented part name.
 */
import fs from "node:fs";
import path from "node:path";

// citadel/ and fivem/ are siblings; `process.cwd()` is this package root under next dev/start.
const LSCUSTOM_DIR = path.resolve(process.cwd(), "../fivem/server-data/resources/esx_lscustom");
const CONFIG_PATH = path.join(LSCUSTOM_DIR, "config.lua");
const LOCALE_PATH = path.join(LSCUSTOM_DIR, "locales", "fr.lua");

function readOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/* ── Parsing the game's label sources ─────────────────────────────────────────────────────────── */

/** `['key'] = 'valeur',` including `\'` escapes, which the FR file uses ("n\'avez"). */
const LOCALE_RE = /\[\s*'([^']+)'\s*\]\s*=\s*'((?:\\.|[^'\\])*)'/g;

/** `label = _U('key')` - the indirection every Config.Menus entry uses. */
const U_RE = /_U\(\s*'([^']+)'\s*\)/;

/** `{ index = 12, label = _U('matteblack')}` inside any GetColors() branch. */
const COLOR_RE = /\{\s*index\s*=\s*(-?\d+)\s*,\s*label\s*=\s*_U\(\s*'([^']+)'\s*\)\s*\}/g;

/** `[2] = 'Bleu éléctrique',` inside XenonColorNames. */
const XENON_RE = /\[\s*(\d+)\s*\]\s*=\s*'([^']*)'/g;

/** An if/elseif chain returning a literal: `(index == 2) then\n return "Darksmoke"`. */
const IF_LITERAL_RE = /index\s*==\s*(-?\d+)\s*\)\s*then\s*(?:\r?\n)?\s*return\s+(?:"([^"]*)"|'([^']*)'|_U\(\s*'([^']+)'\s*\))/g;

/** Everything the two game files can tell us, resolved once and cached. */
type LabelCatalog = {
  /** Config.Menus slot key -> French label ("modEngine" -> "moteur"). */
  slot: Map<string, string>;
  /** Config.Menus slot key -> how many upgrade tiers its price array declares (0 when it has none). */
  levels: Map<string, number>;
  /** GTA paint index -> French name, unioned over every GetColors() category. */
  paint: Map<number, string>;
  /** GTA wheel-type id -> label, from the modFrontWheelsType<N> entries' own `wheelType` field. */
  wheelType: Map<number, string>;
  xenon: Map<number, string>;
  windowTint: Map<number, string>;
  plateIndex: Map<number, string>;
  horn: Map<number, string>;
  /** "r,g,b" -> neon preset name, so a stored neon colour reads as a word when it is a preset. */
  neon: Map<string, string>;
  /** `_U('level')` = "niveau %s". Kept as its template so the game owns the wording. */
  levelTemplate: string | null;
  /** `_U('by_default')` = "par défaut". */
  defaultLabel: string | null;
  /** false when config.lua could not be read at all - callers then avoid claiming anything. */
  ok: boolean;
};

/** Slice a `function Name(...)` body out of the config, so an if-chain scan cannot run past it. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const end = src.indexOf("\nend", at);
  return src.slice(at, end === -1 ? undefined : end);
}

function buildCatalog(): LabelCatalog {
  const config = readOrEmpty(CONFIG_PATH);
  const locale = readOrEmpty(LOCALE_PATH);

  const words = new Map<string, string>();
  let l: RegExpExecArray | null;
  LOCALE_RE.lastIndex = 0;
  while ((l = LOCALE_RE.exec(locale))) words.set(l[1], l[2].replace(/\\'/g, "'"));

  const word = (key: string) => words.get(key) ?? null;
  /** A label that came through `_U(...)`; the raw key is a last resort, never a fabrication. */
  const fromU = (text: string): string | null => {
    const m = text.match(U_RE);
    if (!m) return null;
    return word(m[1]) ?? m[1];
  };

  const empty: LabelCatalog = {
    slot: new Map(), levels: new Map(), paint: new Map(), wheelType: new Map(),
    xenon: new Map(), windowTint: new Map(), plateIndex: new Map(), horn: new Map(),
    neon: new Map(), levelTemplate: null, defaultLabel: null, ok: false,
  };
  if (!config) return empty;

  // ── Config.Menus: slot labels, level counts, wheel types.
  //
  // Bounded to the Config.Menus block and matched on ONE TAB of indentation, which is what makes a
  // top-level slot distinguishable from the nested keys inside it: `cosmetics` lists `modEngine` as
  // a child at two tabs, and a looser scan would read that navigation entry as a slot definition.
  const slot = new Map<string, string>();
  const levels = new Map<string, number>();
  const wheelType = new Map<number, string>();
  const menusAt = config.indexOf("Config.Menus = {");
  if (menusAt >= 0) {
    const menus = config.slice(menusAt);
    const entryRe = /^\t([A-Za-z0-9_]+)\s*=\s*\{/gm;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(menus))) {
      // This entry's body: from its opening brace to the next top-level `\t},`.
      const bodyEnd = menus.indexOf("\n\t},", e.index);
      const body = menus.slice(e.index, bodyEnd === -1 ? e.index + 2000 : bodyEnd);
      const key = e[1];
      const label = fromU(body);
      if (label) slot.set(key, label);

      // `price = {a, b, c}` means the slot sells 3 tiers; a scalar price means a single toggle.
      const priceList = body.match(/price\s*=\s*\{([^}]*)\}/);
      if (priceList) {
        const n = priceList[1].split(",").filter((s) => s.trim() !== "").length;
        if (n > 0) levels.set(key, n);
      }

      // The wheel-type entries name their own GTA id, so nothing has to be inferred from the key.
      const wt = body.match(/wheelType\s*=\s*(\d+)/);
      if (wt && label) wheelType.set(Number(wt[1]), label);
    }
  }

  // ── Paint indices, unioned over every GetColors() category (the lists are sparse and disjoint).
  const paint = new Map<number, string>();
  const colorsBody = fnBody(config, "GetColors");
  let c: RegExpExecArray | null;
  COLOR_RE.lastIndex = 0;
  while ((c = COLOR_RE.exec(colorsBody))) {
    const name = word(c[2]) ?? c[2];
    if (!paint.has(Number(c[1]))) paint.set(Number(c[1]), name);
  }

  // ── Xenon colours: a plain indexed table rather than a function.
  const xenon = new Map<number, string>();
  const xenonAt = config.indexOf("XenonColorNames");
  if (xenonAt >= 0) {
    const end = config.indexOf("\n}", xenonAt);
    const body = config.slice(xenonAt, end === -1 ? undefined : end);
    let x: RegExpExecArray | null;
    XENON_RE.lastIndex = 0;
    while ((x = XENON_RE.exec(body))) xenon.set(Number(x[1]), x[2]);
  }

  // ── The three if-chains. Each is read from its OWN function body.
  const chain = (name: string): Map<number, string> => {
    const out = new Map<number, string>();
    const body = fnBody(config, name);
    let m: RegExpExecArray | null;
    IF_LITERAL_RE.lastIndex = 0;
    while ((m = IF_LITERAL_RE.exec(body))) {
      const literal = m[2] ?? m[3] ?? (m[4] ? word(m[4]) ?? m[4] : null);
      if (literal) out.set(Number(m[1]), literal);
    }
    return out;
  };

  // ── Neon presets: `{label = _U('red'), r = 255, g = 0, b = 0}`.
  const neon = new Map<string, string>();
  const neonBody = fnBody(config, "GetNeons");
  const neonRe = /\{\s*label\s*=\s*(?:_U\(\s*'([^']+)'\s*\)|"([^"]*)")\s*,\s*r\s*=\s*(\d+)\s*,\s*g\s*=\s*(\d+)\s*,\s*b\s*=\s*(\d+)/g;
  let n: RegExpExecArray | null;
  while ((n = neonRe.exec(neonBody))) {
    const name = n[1] ? word(n[1]) ?? n[1] : n[2];
    if (name) neon.set(`${n[3]},${n[4]},${n[5]}`, name);
  }

  return {
    slot, levels, paint, wheelType, xenon,
    windowTint: chain("GetWindowName"),
    plateIndex: chain("GetPlatesName"),
    horn: chain("GetHornName"),
    neon,
    levelTemplate: word("level"),
    defaultLabel: word("by_default"),
    ok: true,
  };
}

type Cache = { loadedAt: number; catalog: LabelCatalog };
const TTL_MS = 10 * 60_000; // these files change about as often as the mechanic's price list does
const globalForMods = globalThis as unknown as { citadelVehicleModCatalog?: Cache };

function catalog(): LabelCatalog {
  const hit = globalForMods.citadelVehicleModCatalog;
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.catalog;
  const fresh = { loadedAt: Date.now(), catalog: buildCatalog() };
  globalForMods.citadelVehicleModCatalog = fresh;
  return fresh.catalog;
}

/* ── The decoded shape ────────────────────────────────────────────────────────────────────────── */

export type VehicleModEntry = {
  /** Slot key. A React key and a debugging aid; never rendered as the primary text. */
  key: string;
  /** What a human calls the slot: "moteur", "vitres teintées". Straight from the game's locale. */
  label: string;
  /** What is fitted, in words: "niveau 4 / 5", "Sport", "Noir mat". */
  value: string;
  /** `#RRGGBB` when the value IS a colour, so the UI can draw the actual paint next to the word. */
  swatch?: string;
};

export type VehicleModGroup = { key: string; label: string; entries: VehicleModEntry[] };

export type VehicleMods = {
  /** Only groups with at least one non-stock entry. A car with nothing fitted has an empty array. */
  groups: VehicleModGroup[];
  /** At most 4 short chips for a dense row, most distinctive first. */
  summary: string[];
  /** How many modifications were counted across every group. */
  total: number;
  /**
   * What the STORED BLOB knows, which is not the same question as what the car is wearing.
   *
   * "none" is the 2026-08-21 finding made visible: 10 of 26 production rows carried no appearance
   * key at all (5 were literally `{model, plate}`), and ESX.Game.SetVehicleProperties only applies
   * what the blob contains - so those cars come out of the garage wearing whatever the engine gave
   * the freshly created entity, not what their owner last saw. A panel that rendered that as "no
   * modifications" would be quietly wrong; it is a MISSING RECORD, not an unmodified car.
   * See _server_build/SESSION_2026-08-21_vehicle_custom_persistence.md.
   */
  record: "full" | "partial" | "none";
};

/* ── Reading raw blob values ──────────────────────────────────────────────────────────────────── */

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** The game writes toggles as `true` (a GetVehicleProperties capture) or `1` (an esx_lscustom
 *  purchase, whose menu value is numeric) into the same key. Both mean fitted. */
function on(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const n = num(v);
  return n !== null && n !== 0;
}

/** An RGB triple, healing the three shapes that reach the DB, exactly as SetVehicleProperties'
 *  `rgbTriple` does: a plain array, a `table.pack` leftover with an `n`, and a JSON-decoded object
 *  with string keys. Getting this wrong is what silently dropped custom paint before 2026-08-16. */
function rgb(v: unknown): [number, number, number] | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown> & unknown[];
  const r = num(t[0] ?? t["1"]);
  const g = num(t[1] ?? t["2"]);
  const b = num(t[2] ?? t["3"]);
  if (r === null || g === null || b === null) return null;
  return [r, g, b];
}

const hex = (c: [number, number, number]) =>
  "#" + c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");

/* ── Slot groups ──────────────────────────────────────────────────────────────────────────────── */

/** Level-priced upgrades. Their tier count comes from the config price array, never from here. */
const PERF_SLOTS = ["modEngine", "modBrakes", "modTransmission", "modSuspension", "modArmor"] as const;

/** GTA paint-index slots. `color1`/`color2` are the standard pair; the others are overlays. */
const PAINT_SLOTS = [
  "color1", "color2", "pearlescentColor", "wheelColor", "interiorColour", "dashboardColour",
] as const;

/** Cosmetic parts with no resolvable variant NAME (see the module header). */
const BODY_SLOTS = [
  "modSpoilers", "modFrontBumper", "modRearBumper", "modSideSkirt", "modExhaust", "modFrame",
  "modGrille", "modHood", "modFender", "modRightFender", "modRoof", "modWindows",
] as const;

const INTERIOR_SLOTS = [
  "modTrimA", "modOrnaments", "modDashboard", "modDial", "modDoorSpeaker", "modSeats",
  "modSteeringWheel", "modShifterLeavers", "modAPlate", "modSpeakers", "modTrunk", "modHydrolic",
  "modEngineBlock", "modAirFilter", "modStruts", "modArchCover", "modAerials", "modTrimB", "modTank",
] as const;

const MISC_SLOTS = ["modPlateHolder", "modVanityPlate"] as const;

/** Every key that says something about APPEARANCE. Used only to decide `record`, so a blob that is
 *  pure degradable state (the GetBasicVehicleProperties shape) is reported as a missing record
 *  rather than as an unmodified car. */
const APPEARANCE_KEYS = [
  ...PAINT_SLOTS, ...PERF_SLOTS, ...BODY_SLOTS, ...INTERIOR_SLOTS, ...MISC_SLOTS,
  "customColor1", "customColor2", "wheels", "modFrontWheels", "modBackWheels", "windowTint",
  "plateIndex", "modLivery", "modRoofLivery", "modXenon", "xenonColor", "neonEnabled", "modHorns",
  "modTurbo", "extras",
];

/* ── The decoder ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Decode one `owned_vehicles.vehicle` blob into readable groups.
 *
 * ONLY WHAT IS FITTED IS LISTED. A stock slot is `-1` in GTA and there are ~40 of them on an
 * untouched car; printing "moteur : par défaut" forty times would bury the three lines that matter.
 * `total` counts what was found, so an empty result still reads as a fact rather than a gap.
 *
 * Returns null when the blob is unparseable - the caller shows nothing rather than a wrong nothing.
 */
export function vehicleModsFromJson(vehicleJson: string | null | undefined): VehicleMods | null {
  if (!vehicleJson) return null;
  let v: Record<string, unknown>;
  try {
    const parsed = JSON.parse(vehicleJson);
    if (!parsed || typeof parsed !== "object") return null;
    v = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const cat = catalog();
  const name = (slot: string) => cat.slot.get(slot) ?? slot;
  const paintName = (i: number) => cat.paint.get(i) ?? `teinte #${i}`;

  /** "niveau 4 / 5", worded by the game's own `_U('level')` template. */
  const levelText = (slot: string, index: number) => {
    const tiers = cat.levels.get(slot) ?? 0;
    const shown = index + 1; // GTA: -1 stock, 0 is the FIRST purchasable tier
    const base = cat.levelTemplate ? cat.levelTemplate.replace("%s", String(shown)) : `niveau ${shown}`;
    return tiers > 0 ? `${base} / ${tiers}` : base;
  };

  const groups: VehicleModGroup[] = [];
  const push = (key: string, label: string, entries: VehicleModEntry[]) => {
    if (entries.length > 0) groups.push({ key, label, entries });
  };

  /* Peinture. A colour is never "stock" - a car always wears one - so these are listed whenever the
     blob records them, unlike every other group below. */
  const paint: VehicleModEntry[] = [];
  for (const slot of PAINT_SLOTS) {
    const i = num(v[slot]);
    if (i === null) continue;
    paint.push({ key: slot, label: name(slot), value: paintName(i) });
  }
  // Custom RGB overrides the index when its own flag is set - the same precedence the game applies.
  for (const [flag, key] of [["customColor1Enabled", "customColor1"], ["customColor2Enabled", "customColor2"]] as const) {
    const c = rgb(v[key]);
    if (!on(v[flag]) || !c) continue;
    paint.push({ key, label: name(key), value: `RVB ${c[0]}, ${c[1]}, ${c[2]}`, swatch: hex(c) });
  }
  push("paint", "Peinture", paint);

  /* Performance. */
  const perf: VehicleModEntry[] = [];
  // Counted in SYSTEMS UPGRADED, not in summed tiers. A chip reading "perf 19/26" is a number nobody
  // can act on; "perf 5/5" answers the question staff actually ask of a fleet row, which is whether
  // the car is fully built. The per-slot tier is on its own line inside the group.
  let perfUpgraded = 0;
  for (const slot of PERF_SLOTS) {
    const i = num(v[slot]);
    if (i === null || i < 0) continue;
    perfUpgraded += 1;
    perf.push({ key: slot, label: name(slot), value: levelText(slot, i) });
  }
  if (on(v.modTurbo)) perf.push({ key: "modTurbo", label: name("modTurbo"), value: "installé" });
  const nitro = num(v.nitroCharges);
  if (nitro !== null && nitro > 0) {
    perf.push({ key: "nitroCharges", label: name("nitroCharges"), value: `${nitro} charge${nitro > 1 ? "s" : ""}` });
  }
  push("perf", "Performance", perf);

  /* Roues. */
  const wheels: VehicleModEntry[] = [];
  const wheelTypeIdx = num(v.wheels);
  if (wheelTypeIdx !== null && wheelTypeIdx >= 0) {
    wheels.push({
      key: "wheels",
      label: name("modFrontWheelsTypes"),
      value: cat.wheelType.get(wheelTypeIdx) ?? `type #${wheelTypeIdx}`,
    });
  }
  /**
   * The two RIM slots are the one place Config.Menus has no top-level entry to borrow a label from:
   * the config models rims as a TYPE submenu (`modFrontWheelsTypes` -> `modFrontWheelsType<N>`) and
   * the individual rims are built at runtime from GetModTextLabel, which a web server cannot call.
   * So the noun comes from the game (`wheels`) and only the direction is added here - which is not
   * data about the car, it is which of two slots is being named. Without this the row rendered the
   * raw key `modFrontWheels`, i.e. an id on a surface whose rule is labels, never ids. It was the
   * ONLY unresolved label across all 26 production rows.
   */
  const rimNoun = cat.slot.get("wheels") ?? "jantes";
  for (const [slot, side] of [["modFrontWheels", "avant"], ["modBackWheels", "arrière"]] as const) {
    const i = num(v[slot]);
    if (i === null || i < 0) continue;
    wheels.push({ key: slot, label: `${rimNoun} ${side}`, value: `variante ${i + 1}` });
  }
  if (on(v.customTires)) wheels.push({ key: "customTires", label: name("customTires"), value: "oui" });
  if (on(v.modSmokeEnabled)) {
    const c = rgb(v.tyreSmokeColor);
    wheels.push({
      key: "tyreSmokeColor",
      label: name("tyreSmokeColor"),
      value: c ? `RVB ${c[0]}, ${c[1]}, ${c[2]}` : "activée",
      ...(c ? { swatch: hex(c) } : {}),
    });
  }
  push("wheels", "Roues", wheels);

  /* Éclairage et vitres. */
  const lights: VehicleModEntry[] = [];
  if (on(v.modXenon)) {
    const xc = num(v.xenonColor);
    // 255 is GTA's "no override" sentinel, so it is a colourless xenon rather than colour #255.
    const colour = xc !== null && xc !== 255 ? cat.xenon.get(xc) ?? `couleur #${xc}` : null;
    lights.push({ key: "modXenon", label: name("modXenon"), value: colour ?? "installé" });
  }
  const neonOn = Array.isArray(v.neonEnabled) ? (v.neonEnabled as unknown[]).some(on) : on(v.neonEnabled);
  if (neonOn) {
    const c = rgb(v.neonColor);
    const preset = c ? cat.neon.get(`${c[0]},${c[1]},${c[2]}`) : null;
    lights.push({
      key: "neonColor",
      label: name("neonColor"),
      value: preset ?? (c ? `RVB ${c[0]}, ${c[1]}, ${c[2]}` : "activés"),
      ...(c ? { swatch: hex(c) } : {}),
    });
  }
  const tint = num(v.windowTint);
  // 0 and -1 both mean "no tint" on this server: GetWindowName only names 1..5, and
  // SetVehicleProperties floors a stored -1 to 0 before applying it.
  if (tint !== null && tint > 0) {
    lights.push({ key: "windowTint", label: name("windowTint"), value: cat.windowTint.get(tint) ?? `niveau ${tint}` });
  }
  push("lights", "Éclairage et vitres", lights);

  /* Carrosserie, plus the two livery slots. */
  const body: VehicleModEntry[] = [];
  for (const slot of BODY_SLOTS) {
    const i = num(v[slot]);
    if (i === null || i < 0) continue;
    body.push({ key: slot, label: name(slot), value: `variante ${i + 1}` });
  }
  for (const slot of ["modLivery", "modRoofLivery"] as const) {
    const i = num(v[slot]);
    if (i === null || i < 0) continue;
    body.push({ key: slot, label: name(slot), value: `motif ${i + 1}` });
  }
  push("body", "Carrosserie", body);

  /* Intérieur. */
  const interior: VehicleModEntry[] = [];
  for (const slot of INTERIOR_SLOTS) {
    const i = num(v[slot]);
    if (i === null || i < 0) continue;
    interior.push({ key: slot, label: name(slot), value: `variante ${i + 1}` });
  }
  push("interior", "Intérieur", interior);

  /* Plaque et divers. */
  const misc: VehicleModEntry[] = [];
  const plate = num(v.plateIndex);
  // plateIndex 0 IS a real plate design, so unlike a mod slot it is listed at its lowest value.
  if (plate !== null && plate >= 0) {
    misc.push({ key: "plateIndex", label: name("plateIndex"), value: cat.plateIndex.get(plate) ?? `modèle #${plate}` });
  }
  const horn = num(v.modHorns);
  if (horn !== null && horn >= 0) {
    misc.push({ key: "modHorns", label: name("modHorns"), value: cat.horn.get(horn) ?? `klaxon #${horn}` });
  }
  for (const slot of MISC_SLOTS) {
    const i = num(v[slot]);
    if (i === null || i < 0) continue;
    misc.push({ key: slot, label: name(slot), value: `variante ${i + 1}` });
  }
  push("misc", "Plaque et divers", misc);

  /* Extras: the coachwork toggles (light bars, roof racks, spare wheels). Only the ones switched ON.
     Stored either as an object keyed by extra id or, when empty, as a JSON array. */
  const extrasRaw = v.extras;
  if (extrasRaw && typeof extrasRaw === "object") {
    const fitted = Object.entries(extrasRaw as Record<string, unknown>)
      .filter(([, state]) => on(state))
      .map(([id]) => Number(id))
      .filter((id) => Number.isFinite(id))
      .sort((a, b) => a - b);
    push("extras", "Extras", fitted.map((id) => ({ key: `extra${id}`, label: `extra ${id}`, value: "activé" })));
  }

  const total = groups.reduce((n, g) => n + g.entries.length, 0);

  /* What the RECORD knows. `partial` is the honest middle: the blob has some appearance data but no
     paint, which is what a degradable-only store merged onto a thin INSERT leaves behind. */
  const known = APPEARANCE_KEYS.filter((k) => v[k] !== undefined).length;
  // The STANDARD PAIR only, not any paint key. A row carrying `pearlescentColor` alone is the exact
  // residue of a thin INSERT that a degradable-only sync later merged into, and calling that "full"
  // would report a car whose actual paint nothing can restore as fully recorded.
  const hasPaint = num(v.color1) !== null || num(v.color2) !== null;
  const record: VehicleMods["record"] = known === 0 ? "none" : hasPaint ? "full" : "partial";

  /* Summary: the most distinctive facts, in the order a staff member scans for them. */
  const summary: string[] = [];
  const primary = num(v.color1);
  const custom1 = on(v.customColor1Enabled) ? rgb(v.customColor1) : null;
  if (custom1) summary.push("peinture perso");
  else if (primary !== null) summary.push(paintName(primary));
  if (perfUpgraded > 0) summary.push(`perf ${perfUpgraded}/${PERF_SLOTS.length}`);
  if (wheelTypeIdx !== null && wheelTypeIdx >= 0) summary.push(cat.wheelType.get(wheelTypeIdx) ?? `jantes #${wheelTypeIdx}`);
  if (neonOn) summary.push("néons");

  return { groups, summary: summary.slice(0, 4), total, record };
}
