/**
 * Vehicle model hash -> display name resolution (Page 2 · Players - "Inventaire & Véhicules" tab).
 *
 * `owned_vehicles.vehicle` (schema/game.ts) stores a numeric GTA model HASH, never a name - GTA's
 * `GetHashKey` is the public Jenkins one-at-a-time ("joaat") hash of the lowercase spawn code, and
 * this codebase ships no hash->name reverse table of its own.
 *
 * CLAUDE.md's "never hardcode a value - read it from an existing shared list" rule names exactly
 * this situation: `gs_utils/common/vehicleList.lua` (read-only here, never written - a concurrent
 * agent owns everything under fivem/) already carries every stock vehicle's `name` (human label,
 * "Dubsta 6x6") and `modelName` (spawn code, "dubsta3") as the server's own catalog. Hashing every
 * `modelName` with joaat and inverting the map resolves a stock vehicle's hash to its real name
 * without a single model ever being typed into CITADEL by hand.
 *
 * Verified 2026-07-16 against the live `testlife` DB: all 15 owned_vehicles rows hashed back to a
 * real vehicleList.lua entry (e.g. 3057713523 -> "Dubsta 6x6", 1353720154 -> "Plateau",
 * 740289177 -> "Vagrant").
 *
 * An add-on/custom model that isn't in vehicleList.lua (or, in a deployment where the fivem/ tree
 * isn't reachable on disk next to citadel/) still falls back to "Modèle #<hex>" at the call site -
 * this module never fabricates a name, only resolves one from the real catalog or returns null.
 */
import fs from "node:fs";
import path from "node:path";

/** GTA's GetHashKey algorithm (Jenkins one-at-a-time), over the lowercased string, as uint32. */
function joaat(str: string): number {
  const s = str.toLowerCase();
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash + s.charCodeAt(i)) >>> 0;
    hash = (hash + ((hash << 10) >>> 0)) >>> 0;
    hash = (hash ^ (hash >>> 6)) >>> 0;
  }
  hash = (hash + ((hash << 3) >>> 0)) >>> 0;
  hash = (hash ^ (hash >>> 11)) >>> 0;
  hash = (hash + ((hash << 15) >>> 0)) >>> 0;
  return hash >>> 0;
}

// This repo lays out citadel/ and fivem/ as siblings under GrandSide/ - `process.cwd()` for
// `next dev`/`next start` is the citadel/ package root, so one level up + into the FiveM tree
// reaches the real, live catalog (never copied/duplicated into CITADEL).
const VEHICLE_LIST_PATH = path.resolve(
  process.cwd(),
  "../fivem/server-data/resources/gs_base/common/vehicleList.lua",
);

// Matches consecutive `name = '...', modelName = '...'` pairs - the fixed field order every
// FleetRoster entry in that file uses. Deliberately does NOT try to parse full Lua (no dependency,
// no risk of executing anything from the file) - a regex over two adjacent string literals.
const ENTRY_RE = /name\s*=\s*'([^']+)',\s*modelName\s*=\s*'([^']+)'/g;

// `category` sits later on the SAME row, so it is read per-row rather than folded into ENTRY_RE:
// one combined pattern would silently drop every row whose optional fields are ordered differently,
// which is exactly the kind of quiet data loss this file's header argues against.
const CATEGORY_RE = /category\s*=\s*'([^']+)'/;

// VehicleClassMap at the top of the same file: the internal category key -> the FR label players
// already see in the showroom filters. Read from the catalog for the same reason everything else
// here is, so CITADEL never carries a second copy of a list the game owns.
const CLASS_RE = /\{\s*name\s*=\s*'([^']+)'\s*,\s*label\s*=\s*'([^']+)'\s*\}/g;

/** One catalog row, as the game defines it. The internal category key is never exposed raw. */
export type VehicleModelInfo = {
  /** Rockstar's display name, e.g. "Dubsta 6x6". This is the MODEL as a human says it. */
  label: string;
  /** Spawn code, e.g. "dubsta3". The value a staff member transcribes into a command. */
  modelName: string;
  /** FR class label, e.g. "Off-Road", or null when the row declares no category. */
  categoryLabel: string | null;
};

function loadCatalog(): [string, VehicleModelInfo][] {
  let content: string;
  try {
    content = fs.readFileSync(VEHICLE_LIST_PATH, "utf8");
  } catch {
    return []; // catalog unreachable in this deployment - callers fall back to the hash
  }

  // Classes first: VehicleClassMap is declared above FleetRoster and the row loop needs it.
  //
  // BOUNDED to the text BEFORE the roster starts on purpose. The same `{ name = ..., label = ... }`
  // shape occurs elsewhere in the file, so scanning the whole thing would map a category key onto
  // whatever pair happened to match last.
  const classes = new Map<string, string>();
  const rosterAt = content.search(/FleetRoster\s*=/);
  const head = rosterAt > 0 ? content.slice(0, rosterAt) : content;
  let c: RegExpExecArray | null;
  CLASS_RE.lastIndex = 0;
  while ((c = CLASS_RE.exec(head))) classes.set(c[1], c[2]);

  const rows: [string, VehicleModelInfo][] = [];
  let m: RegExpExecArray | null;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(content))) {
    // The rest of THIS row only, bounded to the next newline, so a row without `category` cannot
    // borrow the next vehicle's value - the failure mode that makes a boat read as a supercar with
    // nothing on screen to show it was wrong.
    const lineEnd = content.indexOf("\n", ENTRY_RE.lastIndex);
    const rest = content.slice(ENTRY_RE.lastIndex, lineEnd === -1 ? undefined : lineEnd);
    const category = rest.match(CATEGORY_RE)?.[1] ?? null;
    rows.push([
      m[2],
      { label: m[1], modelName: m[2], categoryLabel: category ? classes.get(category) ?? null : null },
    ]);
  }
  return rows;
}

type ModelCache = { loadedAt: number; byHash: Map<number, VehicleModelInfo> };
const TTL_MS = 10 * 60_000; // the catalog changes about as often as vehicleList.lua is edited
// Key renamed with the shape change (was `citadelVehicleModelCache`, a Map<number, string>). A
// long-lived dev process that survived the edit would otherwise hand back the OLD shape, and every
// `.label` read would be undefined for as long as the TTL had left to run.
const globalForModels = globalThis as unknown as { citadelVehicleModelInfoCache?: ModelCache };

function cache(): ModelCache {
  const cached = globalForModels.citadelVehicleModelInfoCache;
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached;
  const byHash = new Map<number, VehicleModelInfo>();
  for (const [modelName, info] of loadCatalog()) byHash.set(joaat(modelName), info);
  const fresh = { loadedAt: Date.now(), byHash };
  globalForModels.citadelVehicleModelInfoCache = fresh;
  return fresh;
}

/**
 * The full catalog identity for a model hash, or null when unresolvable.
 *
 * THERE IS NO MANUFACTURER FIELD TO RETURN, and that is a fact about the data rather than an
 * omission here. `vehicleList.lua` carries name / modelName / price / category / seller and nothing
 * else - verified 2026-08-20: zero occurrences of brand, marque or manufacturer anywhere in the
 * resources tree, and no `vehicleMakeName` in any `.meta` either. Rockstar's own display name
 * sometimes embeds the make ("Benefactor BR8", "Ocelot R88") and usually does not ("Adder",
 * "Dubsta 6x6"), so `label` IS the make wherever the game says it is, and nothing can recover it
 * where the game does not. Do not close that gap with a hand-typed make table: it would be invented
 * data on a staff surface, which this panel's own design rule forbids outright.
 */
export function vehicleModelInfo(hash: number): VehicleModelInfo | null {
  return cache().byHash.get(hash >>> 0) ?? null;
}

/** Resolve a numeric GTA model hash to its stock catalog label, or null if unresolvable (custom/
 * add-on model, or vehicleList.lua unreachable here). Never fabricates a name. */
export function vehicleModelName(hash: number): string | null {
  return vehicleModelInfo(hash)?.label ?? null;
}

/**
 * The same resolution from a raw `owned_vehicles.vehicle` JSON blob, which is what callers actually
 * hold. Centralised here rather than repeated per page: the column stores a numeric hash in `model`
 * on this server, but some setups write a string `model`/`modelName` instead, and every consumer
 * that hand-rolled this got a slightly different subset of those cases right.
 *
 * Returns null only when the blob carries no usable model field at all. A hash that matches no
 * catalog row still yields a label, so the caller renders something true instead of an empty cell.
 */
export function vehicleModelInfoFromJson(vehicleJson: string | null | undefined): VehicleModelInfo | null {
  if (!vehicleJson) return null;
  try {
    const v = JSON.parse(vehicleJson) as { model?: unknown; modelName?: unknown };
    // A setup that stores the spawn code directly: hash it back so it resolves like any other.
    const spawn =
      typeof v.modelName === "string" && v.modelName
        ? v.modelName
        : typeof v.model === "string" && v.model && !/^\d+$/.test(v.model)
          ? v.model
          : null;
    if (spawn) {
      return vehicleModelInfo(joaat(spawn)) ?? { label: spawn, modelName: spawn, categoryLabel: null };
    }
    const hash = typeof v.model === "number" ? v.model : typeof v.model === "string" ? Number(v.model) : NaN;
    if (!Number.isFinite(hash)) return null;
    const hex = `#${(hash >>> 0).toString(16).toUpperCase()}`;
    return vehicleModelInfo(hash) ?? { label: `Modèle ${hex}`, modelName: hex, categoryLabel: null };
  } catch {
    return null;
  }
}
