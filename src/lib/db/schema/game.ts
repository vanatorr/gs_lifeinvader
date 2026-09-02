/**
 * GAME-OWNED tables - FiveM/ESX provisions these at boot (CREATE TABLE IF NOT EXISTS in Lua).
 * CITADEL READS them; it never migrates them (drizzle.config.ts tablesFilter excludes them) and
 * never writes them directly - writes go through the gs_citadel bridge or the job queue.
 * Shapes verified against the live testlife DB (MariaDB 10.4) on 2026-07-16 - see
 * _server_build/CITADEL_DESIGN.md §2. Columns not needed by CITADEL yet are still declared when
 * cheap, so the read model matches reality; giant JSON blobs are typed as text.
 */
// `boolean` is imported for staffRanks.canTargetEqual. ⚠ Without it the module throws
// "boolean is not defined" at RUNTIME on first import - which takes the WHOLE app down, since
// practically every data module imports this file. tsc does say so ("'boolean' only refers to a type,
// but is being used as a value"), so it is only invisible if you filter tsc's output too narrowly.
import { bigint, boolean, float, int, mysqlEnum, mysqlTable, primaryKey, text, tinyint, varchar } from "drizzle-orm/mysql-core";
import { GAME_TABLES as GT } from "../tables";
import { localDatetime } from "../types";

// Every datetime here is naive-LOCAL (MariaDB CURRENT_TIMESTAMP from Lua). Stock drizzle
// datetime/timestamp would read them as UTC and be off by the local offset - see ../types.ts.
const datetime = localDatetime;
const timestamp = localDatetime;

/* ── ESX core ────────────────────────────────────────────────────────────────── */

export const users = mysqlTable(GT.users, {
  id: int("id"),
  identifier: varchar("identifier", { length: 60 }).primaryKey(), // "license:…"
  accounts: text("accounts"), // JSON: { money, bank, black_money }
  // Player's OWN carried inventory - JSON: { itemName: count } or { itemName: { count, meta } }
  // (es_extended/server/main.lua:220-239). Item catalog is the `items` table below (or, if that
  // row is missing, es_extended/config.items.lua's baseline - not read here, DB is authoritative
  // for CITADEL). This is NOT gs_inventory (that resource only owns SHARED containers - trunks,
  // bags, lockers - in `gs_inventory_storage`; a player's personal carry is plain ESX core).
  inventory: text("inventory"),
  // Player's OWN carried WEAPONS (ESX loadout), separate from `inventory` - guns are NOT items in this
  // build. JSON, written by es_extended (getLoadout, server/main.lua:413). Two shapes exist and a
  // reader must handle both: the full array `[{name:'WEAPON_PISTOL', ammo, label, components}]` and
  // the minimal map `{ 'WEAPON_PISTOL': {ammo, components} }` (classes/player.lua:229-244). This is the
  // ONLY place a player's actual firearms live - the `items` table has none. Added 2026-07-17 for the
  // carried-weapons view.
  loadout: text("loadout"),
  group: varchar("group", { length: 50 }), // RBAC group ↔ staff_ranks.ace_group
  job: varchar("job", { length: 20 }),
  jobGrade: int("job_grade"),
  job2: varchar("job2", { length: 50 }),
  job2Grade: int("job2_grade"),
  firstname: varchar("firstname", { length: 32 }),
  lastname: varchar("lastname", { length: 32 }),
  dateofbirth: varchar("dateofbirth", { length: 10 }),
  sex: varchar("sex", { length: 1 }),
  // Integer centimetres. Written at registration by gs_identity/server/main.lua:81-85,183
  // (`math.floor(height)`, validated against gs_identity/config.lua Config.MinHeight/MaxHeight,
  // 150-210 by default) - this column exists live but was never mapped here before, so CITADEL
  // could not read it. Nullable: a row with no completed registration yet has none.
  height: int("height"),
  ssn: varchar("ssn", { length: 11 }),
  phoneNumber: varchar("phone_number", { length: 20 }),
  disabled: tinyint("disabled"),
  isDead: tinyint("is_dead"),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").notNull(),
});

/* ── Jobs (ESX) - name → human label, so the UI shows "LSMC" not "ambulance" ──── */

export const jobs = mysqlTable(GT.jobs, {
  name: varchar("name", { length: 50 }).primaryKey(),
  label: varchar("label", { length: 50 }),
  type: varchar("type", { length: 50 }),
  whitelisted: tinyint("whitelisted"),
});

/**
 * The grade LADDER per job - this is what turns a bare `users.job_grade = 3` into "Patron".
 * Shape verified against es_extended's own reads: `SELECT * FROM job_grades` keyed by
 * `job_name` + `grade` (server/common.lua:214-218) and
 * `SELECT skin_male FROM job_grades WHERE job_name = ? AND grade = ?` (server/main.lua:1180).
 * `name` is the internal rung id ('recrue'|'employe'|'responsable'|'boss' - CLAUDE.md: boss is
 * always the TOP grade); `label` is the human text. es_extended falls back label -> name
 * (common.lua:216), so CITADEL does the same. Composite PK (job_name, grade) - no surrogate id.
 * skin_male/skin_female are big JSON blobs CITADEL has no use for; deliberately not declared.
 */
export const jobGrades = mysqlTable(
  GT.jobGrades,
  {
    jobName: varchar("job_name", { length: 50 }).notNull(),
    grade: int("grade").notNull(),
    name: varchar("name", { length: 50 }),
    label: varchar("label", { length: 50 }),
    salary: int("salary"),
  },
  (t) => [primaryKey({ columns: [t.jobName, t.grade] })],
);

/* ── Structured logging (gs_utils/modules/logging) ───────────────────────────── */

export const gsLogs = mysqlTable(GT.gsLogs, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  category: int("category").notNull(),
  message: varchar("message", { length: 1024 }).notNull(),
  color: int("color").notNull(),
  origin: varchar("origin", { length: 6 }).notNull(), // 'server' | 'client'
  sourceId: int("source_id"),
  sourceName: varchar("source_name", { length: 255 }),
  sourceIdentifier: varchar("source_identifier", { length: 60 }),
  targetId: int("target_id"),
  targetName: varchar("target_name", { length: 255 }),
  targetIdentifier: varchar("target_identifier", { length: 60 }),
  resource: varchar("resource", { length: 64 }),
  action: varchar("action", { length: 64 }),
  actorRank: varchar("actor_rank", { length: 32 }),
  objectRef: varchar("object_ref", { length: 64 }),
  data: text("data"), // JSON
  createdAt: datetime("created_at").notNull(),
});

export const gsLogsCategories = mysqlTable(GT.gsLogsCategories, {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 64 }).notNull(), // resolve by NAME, never hardcode an id
  label: varchar("label", { length: 128 }).notNull(),
});

/* ── Staff RBAC (gs_utils/modules/permissions - THE permission authority) ────── */

export const staffRanks = mysqlTable(GT.staffRanks, {
  id: varchar("id", { length: 32 }).primaryKey(), // support|mod|supermod|admin|superadmin
  label: varchar("label", { length: 64 }).notNull(),
  aceGroup: varchar("ace_group", { length: 32 }).notNull(), // ↔ users.group
  level: int("level").notNull(), // higher = more power; hierarchy checks use this
  /**
   * Mirrors the game's `ConfigStaff.CanTargetEqualRanks[id]` - may this rank act on a target of its
   * OWN level? (Admin + Fondateur, by default.) Published into this column by
   * gs_utils/modules/permissions/server/main.lua's seed so it is readable from outside that Lua VM;
   * the config there remains the source of truth and re-syncs the column on every boot.
   *
   * ⚠ WITHOUT THIS, canTarget() is strictly `actor.level > target.level` and the panel is DEAD on this
   * server: every staff member here is `fondateur` (level 5 - 8 of 8, verified live 2026-07-17), so
   * `5 > 5` was false on every staff-on-staff page and every action disabled at once.
   * See lib/auth/identity.ts canTarget().
   */
  canTargetEqual: boolean("can_target_equal").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull(),
});

export const staffRankPermissions = mysqlTable(
  GT.staffRankPermissions,
  {
    rankId: varchar("rank_id", { length: 32 }).notNull(),
    permission: varchar("permission", { length: 64 }).notNull(), // dot-notation capability codes
  },
  (t) => [primaryKey({ columns: [t.rankId, t.permission] })],
);

export const staffPermissionCatalog = mysqlTable(GT.staffPermissionCatalog, {
  permission: varchar("permission", { length: 64 }).primaryKey(),
  label: varchar("label", { length: 96 }),
  category: varchar("category", { length: 48 }),
});

export const staffConfig = mysqlTable(GT.staffConfig, {
  k: varchar("k", { length: 32 }).primaryKey(), // includes 'version' - the game reload signal
  v: varchar("v", { length: 255 }),
});

/**
 * Anti-cheat detector config - gs_utils/modules/anticheat/server/citadel_overrides.lua CREATEs and
 * owns this. Same k/v/version shape as staffConfig above (`k='version'` is the game's reload signal,
 * `k='detector.<id>'` holds a JSON patch of only the fields that are overridden - an absent field
 * means "use the config.lua default"). `v` is TEXT here (not staffConfig's varchar(255)): a weapon or
 * ped-model deny-list can outgrow 255 characters.
 *
 * ⚠ CITADEL READS this directly (safe - GAME_TABLES is always read-open) but NEVER writes it
 * directly. A write goes through createJob("anticheat.config_set", ...) -> citadel_jobs ->
 * CITADEL/server/commands.lua's executor -> gs_utils' ApplyAnticheatOverride export, which is the
 * ONLY place a field is validated against its allowlist/bounds. Writing this table from Next.js code
 * would bypass that validation entirely - see lib/data/anticheatConfig.ts.
 */
export const anticheatConfig = mysqlTable(GT.anticheatConfig, {
  k: varchar("k", { length: 64 }).primaryKey(),
  v: text("v"),
  updatedBy: varchar("updated_by", { length: 120 }),
  updatedAt: timestamp("updated_at"),
});

/**
 * Attestation ENFORCEMENT switches - gs_weather/server/citadel_overrides.lua CREATEs and owns this.
 * Identical k/v/version shape to anticheatConfig above (`k='version'` is the game's reload signal,
 * `k='detector.enforcement'` holds a JSON patch of only the overridden switches), but a genuinely
 * SEPARATE table: gs_weather is its own resource/VM and owns Config.Attestation, not ConfigAntiCheat,
 * so there is no shared row to reuse across the two.
 *
 * ⚠ CITADEL READS this directly (safe - GAME_TABLES is always read-open) but NEVER writes it directly.
 * A write goes through createJob("attestation.config_set", ...) -> citadel_jobs ->
 * CITADEL/server/commands.lua's executor -> gs_weather's ApplyAttestationOverride export, which is the
 * ONLY place a field is validated against its 4-switch allowlist. See
 * lib/data/anticheatConfig.ts's ATTESTATION_ENFORCEMENT section for the read model and catalog.
 */
export const attestationConfig = mysqlTable(GT.attestationConfig, {
  k: varchar("k", { length: 64 }).primaryKey(),
  v: text("v"),
  updatedBy: varchar("updated_by", { length: 120 }),
  updatedAt: timestamp("updated_at"),
});

/* ── Staff DIVISIONS - the SECOND, orthogonal RBAC axis (gs_utils owns; added 2026-07-16) ─────
 * holds(code) = rank grants it OR any ACTIVE division the person is in grants it.
 * A division is NOT a rank: `min_level` is an ELIGIBILITY FLOOR, not an auto-grant, and it is
 * re-checked on every permission check so a demotion de-fangs a stale membership instantly.
 * Fondateur ('*') bypasses divisions entirely and never needs a membership row.
 * Full design: fivem/server-data/_server_build/CITADEL_TICKETS_DIVISIONS.md §2.
 * NOTE: gs_utils CREATEs these (utf8mb4_general_ci) - never migrate them from here. */

export const staffDivisions = mysqlTable(GT.staffDivisions, {
  id: varchar("id", { length: 32 }).primaryKey(), // mortrp|siem|dossier|norename
  label: varchar("label", { length: 64 }).notNull(),
  minLevel: int("min_level").notNull(), // rank level floor for ELIGIBILITY (never an auto-grant)
  updatedAt: timestamp("updated_at").notNull(),
});

export const staffDivisionGrants = mysqlTable(
  GT.staffDivisionGrants,
  {
    divisionId: varchar("division_id", { length: 32 }).notNull(),
    permission: varchar("permission", { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.divisionId, t.permission] })],
);

export const staffDivisionMembers = mysqlTable(
  GT.staffDivisionMembers,
  {
    divisionId: varchar("division_id", { length: 32 }).notNull(),
    // users.identifier - BARE HEX, never 'license:xxx'. ⚠ Any join to users.identifier MUST go
    // through eqCollate(): this table is gs_utils-created (utf8mb4_general_ci) while users is
    // ESX-created (utf8mb4_unicode_ci), and MariaDB throws on the mixed comparison at RUNTIME.
    identifier: varchar("identifier", { length: 60 }).notNull(),
    grantedBy: varchar("granted_by", { length: 60 }),
    grantedAt: timestamp("granted_at").notNull(),
    // Revoked rows are kept (active=0) for audit - only active=1 ever grants.
    active: tinyint("active").notNull(),
  },
  (t) => [primaryKey({ columns: [t.divisionId, t.identifier] })],
);

/* ── Ban backend (gs_weather owns the connect gate; CITADEL sits on top) ─────── */

export const bans = mysqlTable(GT.bans, {
  id: int("id").primaryKey(),
  license: varchar("license", { length: 60 }),
  playerName: varchar("player_name", { length: 100 }),
  reason: varchar("reason", { length: 255 }).notNull(),
  bannedBy: varchar("banned_by", { length: 100 }).notNull(),
  date: datetime("date").notNull(),
  /**
   * UNIX EPOCH SECONDS - a point in time, NOT a duration. NULL = permanent.
   * Verified in gs_weather: written as `os.time() + duration*60` (server/main.lua:224-225, :359-362),
   * read by the connect gate as `expire IS NULL OR expire > ?` (:260-266). Only the admin `/ban`
   * can produce a permanent ban; the anti-cheat path always falls back to DefaultBanDurationMinutes.
   * NOTE this column is epoch-int, so it is immune to the naive-local datetime issue in ../types.ts.
   */
  expire: int("expire", { unsigned: true }),
});

export const bansIdentifiers = mysqlTable(GT.bansIdentifiers, {
  id: int("id").primaryKey(),
  banId: int("ban_id").notNull(),
  identifier: varchar("identifier", { length: 100 }).notNull(),
});

/* ── Licenses (gs_jobs/modules/license) ──────────────────────────────────────── */

// CREATE TABLE verified: gs_jobs/modules/license/server/main.lua:64-71. `owner` = bare-hex
// identifier (joins users.identifier), `type` = free-form license-type string ('drive', 'weapon',
// 'diploma_ems1', …) with no FK to a fixed enum.
export const userLicenses = mysqlTable(GT.userLicenses, {
  id: int("id").primaryKey(),
  type: varchar("type", { length: 60 }).notNull(),
  owner: varchar("owner", { length: 60 }).notNull(),
});

// Label catalog for user_licenses.type - the schema's source of truth (gs_utils/server/main.lua
// LicenseListLookup: "SELECT `type`, `label` FROM `licenses`"). Pre-existing table, no CREATE TABLE in
// this extract; read-only lookup.
export const licenses = mysqlTable(GT.licenses, {
  type: varchar("type", { length: 60 }).primaryKey(),
  label: varchar("label", { length: 128 }),
});

/* ── Vehicle ownership (ESX core; no CREATE TABLE in this extract) ──────────────
   Columns verified via gs_garage/server/main.lua:52-56 (schema comment) and the INSERT at :1449-1450:
   `owned_vehicles(owner, plate, vehicle, type, job, stored, parking, pound)`.
   `vehicle` is a JSON blob ({model, plate, ...props}) - model is a numeric hash, not a name, so a
   human vehicle label needs a hash->name table this codebase does not ship (streamed vehicles.meta,
   excluded per CLAUDE.md). `stored`: 0 = out, 1 = stored in `parking` (garage id), 2 = impounded
   (`pound` holds the impounding job, or 'insurance'). */
export const ownedVehicles = mysqlTable(GT.ownedVehicles, {
  owner: varchar("owner", { length: 60 }),
  plate: varchar("plate", { length: 12 }).primaryKey(),
  vehicle: text("vehicle").notNull(),
  type: varchar("type", { length: 20 }),
  job: varchar("job", { length: 50 }),
  stored: tinyint("stored").notNull(),
  parking: varchar("parking", { length: 60 }),
  pound: varchar("pound", { length: 60 }),
});

/**
 * LE PRIX D'ACHAT REEL D'UNE VOITURE DE FLOTTE. Ecrite par gs_jobs, lue seule par CITADEL.
 *
 * ⚠ `model` PORTE LE LIBELLE, PAS LE modelName. `RecordJobVehiclePurchase` reçoit
 * `entry.name or tostring(modelHash)`, donc la valeur est "Rumpo Trail" et non `rumpo3` (verifie sur
 * les 144 lignes de production). Un rapprochement avec FleetRoster se fait donc sur `name`, et un
 * rapprochement sur `modelName` ne trouverait jamais rien - sans erreur, juste zero ligne.
 */
export const jobVehiclePurchases = mysqlTable(GT.jobVehiclePurchases, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  jobName: varchar("job_name", { length: 50 }).notNull(),
  buyerName: varchar("buyer_name", { length: 120 }),
  model: varchar("model", { length: 120 }),
  plate: varchar("plate", { length: 12 }).notNull(),
  price: int("price").notNull(),
});

/**
 * MortRP ledger, written by gs_identity and read by CITADEL.
 * The snapshot stores the full before-state so a wipe can be inspected, and undone, later.
 */
export const gsMortrp = mysqlTable(GT.gsMortrp, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  targetIdentifier: varchar("target_identifier", { length: 60 }).notNull(),
  executedBy: varchar("executed_by", { length: 60 }),
  reason: varchar("reason", { length: 255 }),
  ticketId: bigint("ticket_id", { mode: "number" }),
  snapshot: text("snapshot"),
  state: mysqlEnum("state", ["executed", "undone", "purged"]).notNull(),
  executedAt: bigint("executed_at", { mode: "number" }).notNull(),
  undoneBy: varchar("undone_by", { length: 60 }),
  undoneAt: bigint("undone_at", { mode: "number" }),
  purgeAfter: bigint("purge_after", { mode: "number" }).notNull(),
});

export const gsMortrpRows = mysqlTable(GT.gsMortrpRows, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  mortrpId: bigint("mortrp_id", { mode: "number" }).notNull(),
  tableName: varchar("table_name", { length: 80 }).notNull(),
  rowCount: int("row_count").notNull(),
});

/* ── Item catalog (ESX core - es_extended/server/common.lua ESX.RefreshItems) ────
   `SELECT * FROM items` appliedBodyMarks this on top of the client-side Config.Items baseline; DB row wins
   when present. Verified live 2026-07-16: 622 rows. Read-only lookup - resolves a
   users.inventory JSON key ("phone") to its real label ("Téléphone"). */
export const items = mysqlTable(GT.items, {
  name: varchar("name", { length: 50 }).primaryKey(),
  label: varchar("label", { length: 50 }).notNull(),
  weight: int("weight").notNull(),
  rare: tinyint("rare").notNull(),
  canRemove: tinyint("can_remove").notNull(),
});

/* ── gs_utils KVP store ───────────────────────────────────────────────────────
 * Provisioned by gs_utils/server/main.lua:56-64. A generic owner/key/value store; `owner` is the
 * BARE ESX identifier (so it joins users.identifier directly) or a global sentinel, and `value` is
 * ALWAYS json.encode'd by KvpOverride (main.lua:80-89) - even a bare number, which lands as the string
 * "1234". Never read `value` as a raw scalar.
 *
 * The table name was already listed in tables.ts, but no Drizzle definition existed and nothing ever
 * queried it - which is why the player panel claimed playtime was untracked. It isn't: it lives
 * here under key='playtime'. See lib/data/playtime.ts.
 *
 * `key` is a MySQL reserved word; Drizzle quotes identifiers, so this is safe as-is.
 */
export const gsKvp = mysqlTable(GT.gsKvp, {
  id: int("id").primaryKey(),
  owner: varchar("owner", { length: 64 }).notNull(),
  key: varchar("key", { length: 128 }).notNull(),
  value: text("value"),
});

/* ── Staff warnings (gs_utils/modules/staffcommands `/warn`) ─────────────────── */

// CREATE TABLE verified: gs_utils/modules/staffcommands/server/main.lua:194-206. Append-only - no
// resolved/active flag; every warning is a permanent audit row.
export const staffWarnings = mysqlTable(GT.staffWarnings, {
  id: int("id").primaryKey(),
  identifier: varchar("identifier", { length: 60 }).notNull(), // the WARNED player
  targetName: varchar("target_name", { length: 255 }),
  warnedBy: varchar("warned_by", { length: 255 }),
  warnedByIdentifier: varchar("warned_by_identifier", { length: 60 }),
  reason: varchar("reason", { length: 255 }).notNull(),
  createdAt: datetime("created_at").notNull(),
});

/* ── Society money (esx_addonaccount core, reconstructed in gs_jobs/server/society.lua) ─────────
 * Backs Page · Factions. Shapes verified against the live DB 2026-07-16.
 *
 * ⚠ READ-ONLY, AND NOT MERELY BY CONVENTION. gs_jobs keeps an in-memory `SharedAccounts` cache
 *   (society.lua:174) and `persistAccountMoney` (:176) writes `money = ?` ABSOLUTELY from that
 *   cached value. So an `UPDATE addon_account_data SET money = money + ?` from anywhere else is
 *   silently REVERTED by the next in-game deposit - a guaranteed economy hole, not a race window.
 *   Every write goes CITADEL -> citadel_jobs -> gs_citadel -> gs_jobs export. Never from here.
 *
 * ⚠ COLLATION. Every column below is utf8mb4_general_ci while jobs.name / users.identifier are
 *   utf8mb4_unicode_ci - MariaDB THROWS (ERROR 1267) on the mixed comparison at RUNTIME, not at
 *   compile time. Verified live. Use lib/db/collation.ts on EVERY join out of these three tables.
 */

/** ⚠ TWO POTS PER JOB: 'society_<job>' AND 'society_<job>_blocked' (verified live: 250 rows = 125x2).
 *  Match the name EXACTLY - `LIKE 'society_%'` double-counts and doubles every reported balance.
 *  No AUTO_INCREMENT (PK is the name varchar) - gs_jobs dedupes with INSERT IGNORE. */
export const addonAccount = mysqlTable(GT.addonAccount, {
  name: varchar("name", { length: 60 }).primaryKey(), // 'society_police'
  label: varchar("label", { length: 100 }).notNull(),
  shared: int("shared").notNull(),
});

export const addonAccountData = mysqlTable(GT.addonAccountData, {
  id: int("id").primaryKey(),
  accountName: varchar("account_name", { length: 100 }),
  money: int("money").notNull(),
  /** NULL = the SHARED (society) pot; non-null = a personal sub-account. ALWAYS filter `owner IS NULL`.
   *  ⚠ UNIQUE(account_name, owner) does NOT dedupe two NULLs in MySQL, which is why gs_jobs guards its
   *  lazy row-creation with an explicit NOT EXISTS (society.lua:295-302). */
  owner: varchar("owner", { length: 60 }),
});

/** Society ledger. CREATE TABLE: gs_jobs/server/society.lua:783-795.
 *  ⚠ `society` holds the BARE job name ('police') while addon_account.name is 'society_police' -
 *    they do NOT join directly.
 *  ⚠ `name` is a write-time SNAPSHOT and goes stale (verified live: one identifier stored as both
 *    'Vana' and 'Vanator Charles'). Render the LIVE name; keep this as the historical record. */
export const societyTransactions = mysqlTable(GT.societyTransactions, {
  id: int("id").primaryKey(),
  society: varchar("society", { length: 40 }).notNull(),
  type: tinyint("type").notNull(), // 0 = withdraw | 1 = deposit | 2 = bonus
  identifier: varchar("identifier", { length: 60 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  amount: int("amount").notNull(), // always POSITIVE; `type` carries the direction
  reason: varchar("reason", { length: 100 }),
  createdAt: datetime("created_at").notNull(), // naive-LOCAL (localDatetime) - see ../types.ts
});

/* ── gs_inventory SHARED containers ─────────────────────────────────────────────
 * CREATE TABLE: gs_inventory/server/main.lua. Shapes verified live 2026-07-17.
 *
 * ⚠ NOT a player's carried inventory - that is `users.inventory` (lib/data/inventory.ts explains the
 *   split). This table holds SHARED containers only: trunks, gloveboxes, bags, lockers, job coffres,
 *   property stashes.
 * ⚠ THERE IS NO JOB COLUMN. The owning job lives INSIDE the opaque `id`, as a `job=<name>` segment:
 *     job_job=ballas_name=society_ballas_inventory          (kind='job')
 *     locker_identifier=3f46…_job=police_location=missionrow (kind='locker')
 *   lib/data/factionAssets.ts parses it - and note `_` is a LIKE WILDCARD, so any pattern matching
 *   against this id must escape it.
 * ⚠ `inventory` carries its OWN label/count/weight per entry, unlike users.inventory's bare counts -
 *   so it needs no `items` join. */
/**
 * APPEND-ONLY archive of every committed container state - the CONTAINER CHANGE FEED.
 *
 * gs_inventory's `PersistInventory` writes `gs_inventory_storage` (the current state) AND appends one
 * row here, on every single mutation. So unlike a player's pockets, container contents were already
 * correct in the database at every moment; what was missing was any way for CITADEL to LEARN that
 * they had changed, because the storage table is an upsert with no cursor to walk. That made the
 * container panels one-shot renders, which is the other half of the owner's "faction inventory arent
 * live" (2026-08-24).
 *
 * This table's auto-increment `id` is exactly the monotonic feed `ensurePoller` was written for, and
 * it has been filling since 2026-07-28. Making containers live therefore needed NO game-side code -
 * only a poller that reads a signal already being written. See lib/realtime/registry.ts.
 *
 * ⚠ READ THE TAIL, NEVER THE TABLE. It holds a full copy of a container's contents per mutation:
 * 99,518 rows and 59 MB on production at 2026-08-24, growing ~3,700 rows a day with no retention.
 * The poller walks `id > cursor` and touches nothing else; a query that scans it will get slower
 * every day. Retention lives in scripts/prune-retention.ts.
 *
 * ⚠ `object_ref` IS THE CONTAINER ID, NOT AN OWNER. It is gs_inventory's opaque structured id
 * (`trunk_<plate>`, `bag_i<N>`, `job_job=ballas_name=…`, `prop_prop:<id>`), and attributing one to a
 * person needs the same joins lib/data/siem.ts documents - `gs_bags_instances` for a bag, the plate
 * for a trunk, and so on. Never treat the string itself as an identifier.
 */
export const gsInventorySnapshots = mysqlTable(GT.gsInventorySnapshots, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  objectRef: varchar("object_ref", { length: 150 }).notNull(),
  kind: varchar("kind", { length: 60 }).notNull(),
  inventory: text("inventory"),
  loadout: text("loadout"),
  accounts: text("accounts"),
  data: text("data"),
  weight: float("weight"),
  maxWeight: float("max_weight"),
  createdAt: timestamp("created_at"),
});

export const storage = mysqlTable(GT.gsInventoryStorage, {
  id: varchar("id", { length: 150 }).primaryKey(),
  kind: varchar("kind", { length: 60 }).notNull(),
  inventory: text("inventory"), // JSON: { item: { count, label, weight, meta } }
  loadout: text("loadout"),
  accounts: text("accounts"),
  data: text("data"),
  weight: float("weight"),
  maxWeight: float("max_weight"),
  updatedAt: timestamp("updated_at"),
});

/* ── gs_base/propMenu placed world objects ("VIP storages" and every other placed prop) ──────────
 * CREATE TABLE: gs_base/modules/propMenu/server/main.lua:363-379 (+ the idempotent `light_color`
 * ALTER at :387). READ-ONLY here, like every other game table.
 *
 * WHAT A "VIP STORAGE" IS, since nothing else in this schema says it: a row with
 * `category = 'Stockage'`. Placing ANY prop is a donator perk - every level-0 entry in
 * ConfigPropMenu.DonatorPropCount / DonatorPropCountInsideProperty / CategoryMaxCount.Stockage /
 * CategoryCountInsideProperty.Stockage is 0 (propMenu/config.lua:16-58), so a non-donator cannot
 * place one at all, and a Stockage prop is a personal container a paying player planted in the world.
 *
 * ⚠ THE CONTENTS ARE NOT IN THIS TABLE. They live in `gs_inventory_storage` under the id
 * `prop_prop:<id>` - propMenu builds `'prop:'..dbId` (server/main.lua:124) and hands it to
 * gs_inventory as `data.id`, whose DeriveInventoryId prefixes the kind (`gs_inventory/server/
 * main.lua:346-349`). There is NO foreign key and no coords column on the storage row: this table is
 * the only place a placed container's position exists, and that string is the only join.
 *
 * ⚠ DELETING THE PROP DOES NOT DELETE THE CONTAINER (propMenu/server/main.lua:686-687, deliberate -
 * a removal must never destroy stored goods). So a `gs_inventory_storage` row keyed `prop_prop:<id>`
 * with no `gs_props` row is a real, normal state: the container outlived its world object.
 *
 * ⚠⚠ `password` IS A LIVE SECRET AND MUST NEVER LEAVE THE SERVER. It is the plaintext code that
 * opens someone else's Stockage (propMenu's own brute-force counter-measures exist because guessing
 * it is a real attack - config_server.lua:57-72). It is declared here so a reader knows the column
 * exists and so `hasPassword` can be derived server-side; every read model in lib/data/vipStorage.ts
 * projects a BOOLEAN and never the value. Do not add it to a select list that reaches a client.
 *
 * ⚠ AND IT IS NOT THE ONLY COPY. propMenu writes the SAME plaintext into the recycle-bin snapshot on
 * every removal (`citadel_prop_deletions.snapshot`, propMenu/server/main.lua:646). That copy WAS
 * reaching browsers - the deletions page and the player page both returned the raw row - which made
 * this very sentence false next door for as long as both existed. It is now stripped in exactly one
 * place, `stripSnapshotSecrets` in lib/data/propDeletions.ts. A THIRD reader of that column must
 * strip it too: a rule enforced per-caller is a rule that lasts until the next caller. */
export const gsProps = mysqlTable(GT.gsProps, {
  id: int("id").primaryKey(),
  /** The placer's identifier - BARE HEX, same shape as users.identifier (propMenu resolves it from
   *  xPlayer.getIdentifier(), server/main.lua:412). This is "who owns it". */
  owner: varchar("owner", { length: 64 }).notNull(),
  /** GTA model HASH (joaat of the spawn code), never a name - resolve via lib/data/propModels.ts. */
  model: bigint("model", { mode: "number" }).notNull(),
  x: float("x").notNull(),
  y: float("y").notNull(),
  z: float("z").notNull(),
  rx: float("rx").notNull(),
  ry: float("ry").notNull(),
  rz: float("rz").notNull(),
  sx: float("sx"),
  sy: float("sy"),
  sz: float("sz"),
  tint: int("tint"),
  /** gs_instance routing-bucket id, NULL in the open world. propMenu treats an instance whose name
   *  contains 'property_' as "inside a property" (server/main.lua:324) - that string test is the only
   *  interpretation the game itself makes of this column, and it is the one CITADEL reuses. */
  instance: varchar("instance", { length: 64 }),
  /** 'Stockage' is the container category. Others ('Mobilier', lights, ...) are decor with no stash. */
  category: varchar("category", { length: 32 }),
  job: varchar("job", { length: 32 }),
  /** Stock upgrade level (1..maxLevel). Capacity = ConfigPropMenu.StockBaseCapacity * level
   *  (propMenu/common/main.lua:92-94) - but that number is computed CLIENT-side and handed to
   *  gs_inventory, which does not re-derive it for kind='prop', so it is NOT trustworthy as a
   *  capacity. Render the level; take the capacity from gs_inventory_storage.max_weight. */
  level: int("level").notNull(),
  customLabel: varchar("custom_label", { length: 32 }),
  /** ⚠ SECRET - see the header. Never project this to a client. */
  password: varchar("password", { length: 32 }),
  lightColor: int("light_color"),
});

/* ── gs_bags instance registry ──────────────────────────────────────────────────
 * CREATE TABLE verified: gs_bags/server/main.lua:184-198. Shape + rows verified live 2026-07-17.
 *
 * WHY IT MUST BE READ INSTEAD OF PARSING THE ID: bags became their own entities on 2026-07-17, and a
 * new bag's storage id is `bag_i<N>` - it encodes NO identifier. gs_inventory's own resolver documents
 * the trap (server/owner.lua's resolveIdentifierOwner): the LEGACY `bag_<identifier>` pattern still
 * matches `bag_i42` and yields the nonsense identifier "i42", so parsing the id first would attribute a
 * bag to a player who does not exist. This table is the authority for BOTH shapes.
 *
 * The game's own resolver reaches this data through the non-yielding `gs_bags:GetBagInstanceOwner`
 * export, which answers ONLY for a bag someone is CURRENTLY WEARING (it scans in-memory EquippedBags,
 * main.lua:797-806). CITADEL cannot call a Lua export and must serve offline players anyway, so it
 * reads the durable row instead - which is also the only way to see a DROPPED bag's last owner.
 *
 * ⚠ utf8mb4_general_ci (verified live) vs users.identifier's utf8mb4_unicode_ci - any column-to-column
 *   join to users MUST go through eqCollate() or MariaDB throws at RUNTIME. See lib/db/collation.ts.
 * ⚠ UNIQUE(owner) - one instance per player, so this is a 1:1 lookup, not a list.
 * `bags_1`/`bags_2` are prop/model ids for rendering the bag, not capacity; capacity lives on the
 * gs_inventory_storage row. Declared for completeness, not read. */
export const gsBagsInstances = mysqlTable(GT.gsBagsInstances, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  storageId: varchar("storage_id", { length: 150 }), // -> gs_inventory_storage.id
  owner: varchar("owner", { length: 60 }), // BARE hex -> users.identifier; NULL = dropped/unowned
  bags1: int("bags_1").notNull(),
  bags2: int("bags_2").notNull(),
  label: varchar("label", { length: 40 }),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/* ── gs_properties ──────────────────────────────────────────────────────────────
 * ⚠ `job_owned = 1` ⇒ `owner` holds the JOB NAME ('yakuza'), NOT a license, and `real_owner` is NULL.
 *   Verified live: all 9 job-owned rows are gang labs (AcidLab→vagos, CokeLab→yakuza…). Reading
 *   `owner` as a license for those returns nothing, silently.
 * ⚠ `access_grades` is a JSON ARRAY OF GRADE NUMBERS with no foreign key - one of the ~6 places a
 *   grade number is referenced, and the reason the ladder is append-only and never renumbered.
 *   (Live 2026-07-17: every row holds `"{}"` - Lua's json.encode of an EMPTY table emits an object,
 *   not `[]`, so a parser here must tolerate both shapes and never assume an array.)
 * ⚠ `real_owner` is a JOB NAME (a rental agency), NOT a license - `row.real_owner ~= jobName`
 *   (server/jobMenu.lua:444,:575). It is set only while `rented = 1`; buying out clears it
 *   (jobMenu.lua:472). So it never joins users.identifier. Live: NULL on all 22 rows.
 * ⚠ COLLATION: every varchar here is utf8mb4_general_ci (gs_utils/gs_properties-created) while
 *   users.identifier is utf8mb4_unicode_ci - verified live 2026-07-17. Any join to users MUST go
 *   through eqCollate() or MariaDB throws ER_CANT_AGGREGATE_2COLLATIONS at RUNTIME. See lib/db/collation.ts.
 * CREATE TABLE verified: gs_properties/server/main.lua:131-150. */
export const ownedProperties = mysqlTable(GT.ownedProperties, {
  // The COMPOSITE primary key: propertyId .. propertyType .. roomId, CONCATENATED WITH NO SEPARATOR
  // (MakePropertyId, server/main.lua:207-209). ⚠ IT CANNOT BE PARSED BACK APART - and this is not a
  // theoretical concern: two live rows share property_id 'TourMoMiltonDriveSouth13' as
  // ('EclipseTower1', room 3) -> "…EclipseTower13" and ('EclipseTower2', room 1) -> "…EclipseTower21",
  // where "…EclipseTower13" is equally readable as type 'EclipseTower13'. Always use the three real
  // columns below; treat `id` as opaque.
  id: varchar("id", { length: 191 }).primaryKey(),
  propertyId: varchar("property_id", { length: 80 }).notNull(),
  propertyType: varchar("property_type", { length: 80 }).notNull(),
  roomId: int("room_id"),
  owner: varchar("owner", { length: 60 }), // license, OR the job name when job_owned = 1
  jobOwned: tinyint("job_owned"),
  realOwner: varchar("real_owner", { length: 60 }), // a JOB name (rental agency) - see header
  rented: tinyint("rented"),
  unlocked: tinyint("unlocked"),
  accessGrades: text("access_grades"), // JSON grade numbers - live rows are "{}", not "[]"
  attacked: tinyint("attacked"),
  // Per-property IPL/decoration state (JSON, e.g. {"Style":"sharp"}). Declared because it is live
  // data CITADEL may want later; not read today.
  propertyIpl: text("property_ipl"),
  /** UNIX EPOCH SECONDS (BIGINT), not a datetime - same convention as bans.expire. NULL = not under
   * attack. Written from Lua's os.time(). Never wrap in localDatetime: it is an int column. */
  attackExpires: bigint("attack_expires", { mode: "number" }),
  /** UNIX EPOCH SECONDS. A lab freshly lost to an attack is un-claimable until this passes
   * (server/labs.lua:406,:500). NULL = claimable now. */
  labBlockedUntil: bigint("lab_blocked_until", { mode: "number" }),
  /** UNIX EPOCH SECONDS (BIGINT NOT NULL) - when the ROW was provisioned, which is NOT when the
   * current owner acquired it (the row pre-exists ownership; ClaimProperty only UPDATEs owner,
   * main.lua:276-280). So this is NOT a "date d'achat" and must never be labelled as one. */
  createdAt: bigint("created_at", { mode: "number" }),
});

/** Doubles de clés - who else can get into a property.
 *  CREATE TABLE verified: gs_properties/server/main.lua:154-164.
 *  ⚠ `name` is the KEY's nickname chosen by the GIVER (live: "hunter"), NOT the holder's RP name -
 *    the INSERT binds `keyName` there (main.lua:1021) while the holder is `identifier`. Rendering
 *    `name` as a person is the obvious misread; resolve the holder through users.identifier instead.
 *  ⚠ `property_key` -> owned_properties.id (the composite), NOT property_id.
 *  ⚠ Same utf8mb4_general_ci collation trap as owned_properties - eqCollate() on any users join. */
export const propertySharedKeys = mysqlTable(GT.propertySharedKeys, {
  id: int("id").primaryKey(),
  propertyKey: varchar("property_key", { length: 191 }).notNull(),
  name: varchar("name", { length: 64 }).notNull(), // the KEY's nickname, not a person
  identifier: varchar("identifier", { length: 60 }).notNull(), // BARE hex -> users.identifier
  // Revoked-but-kept: toggled off rather than deleted (main.lua:1044). Only activated=1 opens a door
  // (the access check filters on it, main.lua:382) - so a count must filter it too.
  activated: tinyint("activated").notNull(),
  createdAt: bigint("created_at", { mode: "number" }), // UNIX EPOCH SECONDS, not a datetime
});

/* ── gcphone - SMS + calls (CREATE TABLE: gcphone/server/server.lua:409-522) ─────
 * ⚠ KEYED BY PHONE NUMBER, NOT BY IDENTIFIER. Every column below that holds a "number" is a
 *   varchar(20) in ONE OF THREE DISJOINT NUMBER SPACES (gcphone/server/server.lua:9-24):
 *     1. PLAYER  - digits, generated from Config.Phone.Number.Mask, stored in `users.phone_number`.
 *     2. FIXED   - Config.FixedPhone keys ('911', '811', …): physical props, no owner at all.
 *     3. SERVICE - a JOB NAME used AS a number ('police', 'olympian'). Verified live: real rows.
 *   So a number does NOT always resolve to a person, and lib/data/comms.ts must say which space it
 *   landed in rather than assume a player. Resolution is `users.phone_number` - see comms.ts.
 * ⚠ COLLATION: these are utf8mb4_general_ci; users.phone_number is utf8mb4_unicode_ci. A raw
 *   column-to-column join THROWS ER_CANT_AGGREGATE_2COLLATIONS (proved live 2026-07-17). comms.ts
 *   sidesteps it entirely with bound params, which coerce - see the note there.
 * ⚠ `time` is UNIX EPOCH **MILLISECONDS** (BIGINT), not seconds and not a datetime: gcphone writes
 *   os.time()*1000 because the NUI does `new Date(time)` (tchat.lua:19-20, messages.lua:41).
 *   Verified live: 1784240304000. Treating it as seconds dates every message to 1970. */

/** ONE ROW PER SIDE - the same SMS is stored once per mailbox that must see it, distinguished by
 *  `owner`. Verified live 2026-07-17: a single faction SMS existed as 3 rows (ids 10/11/12).
 *  ⚠ THIS IS WHY `owner` IS THE ONLY CORRECT PLAYER SCOPE. On a faction/service SMS the recipients'
 *    rows have owner NOT IN (transmitter, receiver) - live row id 12 is owner='7775119',
 *    transmitter='6089921', receiver='olympian'. So filtering on transmitter/receiver silently drops
 *    every faction message a player received. Rides KEY idx_owner_id (owner, id) = keyset order. */
export const phoneMessages = mysqlTable(GT.phoneMessages, {
  id: int("id").primaryKey(),
  /** WHOSE mailbox this row is. The player scope - see the warning above. */
  owner: varchar("owner", { length: 20 }).notNull(),
  transmitter: varchar("transmitter", { length: 20 }).notNull(), // sender's number
  receiver: varchar("receiver", { length: 20 }).notNull(), // destination number (may be a SERVICE)
  message: text("message").notNull(),
  isRead: tinyint("is_read").notNull(),
  groupId: int("group_id"), // -> phone_chat_groups.id; NULL on a 1:1 SMS
  time: bigint("time", { mode: "number" }).notNull(), // EPOCH MILLISECONDS
  /** Soft-delete (messages.lua: single message, whole thread, or "supprimer tout" - SEVEN write
   *  sites). Same treatment as Contacts/Marketplace/Onyx/Photos: comms.ts must NEVER filter on this,
   *  only mark - see smsForPlayer/SmsRow. */
  deletedAt: timestamp("deleted_at"),
});

/** ONE ROW PER CALL (not per side - unlike phone_messages). Forced by the client: gcPhone:blockCalls
 *  is fired with a live call id AND with history row ids interchangeably, so both must be the same id
 *  (gcphone/server/server.lua:463-468). Per-side deletion therefore lives in phoneCallsHidden.
 *  ⚠ LEGACY COLUMNS STILL ON THE LIVE TABLE: `owner`, `num`, `incoming`, `accepts` are the pre-2026
 *    owner-scoped schema. gcphone migrates them in place (server.lua:483-507) and writes ONLY the
 *    transmitter/receiver/is_accepts set now. Live rows carry owner='' / num='' / incoming=0 -
 *    reading them would give a wrong answer with no error, so they are deliberately NOT declared. */
export const phoneCalls = mysqlTable(GT.phoneCalls, {
  id: int("id").primaryKey(),
  /** Nullable only because the in-place migration ADDs it nullable (server.lua:489). */
  transmitter: varchar("transmitter", { length: 20 }), // caller's number
  receiver: varchar("receiver", { length: 20 }), // callee's number
  /** 1 = the callee picked up. 0 = missed OR declined - the table does not distinguish them, and
   *  there is NO duration column anywhere, so call LENGTH is not recoverable. See comms.ts. */
  isAccepts: tinyint("is_accepts").notNull(),
  /** Caller ID was MASKED (numéro masqué) - a property of the call, NOT a staff-visible/hidden flag.
   *  Per-side deletion is phoneCallsHidden; do not confuse the two. */
  hidden: tinyint("hidden").notNull(),
  time: bigint("time", { mode: "number" }).notNull(), // EPOCH MILLISECONDS
});

/** A call one side DELETED from their own history. The call row itself survives, so staff still see
 *  it - comms.ts surfaces this as a flag rather than filtering on it (deleting evidence is signal). */
export const phoneCallsHidden = mysqlTable(
  GT.phoneCallsHidden,
  {
    callId: int("call_id").notNull(),
    number: varchar("number", { length: 20 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.callId, t.number] })],
);

/* ── gcphone - Contacts / Marketplace / Onyx / Weazel News / Bank / Photos (2026-07-25) ─────────
 * Added for the Comms tab expansion (plan §2a). Unlike phoneMessages/phoneCalls above, EVERY one of
 * these is keyed by the ESX `identifier` directly, not by phone number - verified against each
 * table's own `CREATE TABLE` in gcphone/server/{contacts,marketplace,twitter,weazel,bank}.lua, so no
 * users.phone_number resolution is needed to scope a query to "this player's rows".
 *
 * ⚠ SOFT-DELETE IS A PARALLEL, IN-FLIGHT MIGRATION (plan §1a). `deleted_at` on phoneContacts /
 *   phoneMarketPlace / phoneTwitterTweets is landing on the game-server side alongside this change -
 *   confirmed already live on phone_market_place (`marketplace.lua`'s `provision()` adds
 *   `deleted_at TIMESTAMP NULL DEFAULT NULL` + a backfill ALTER for a pre-existing table) but NOT YET
 *   on phone_contacts / phone_twitter_tweets as of this commit. comms.ts queries these WITHOUT a
 *   `deleted_at IS NULL` filter on purpose: staff must see deleted rows too, marked as deleted - that
 *   is the entire point of a soft delete.
 * ⚠⚠ IF THE COLUMN HASN'T LANDED YET, A QUERY THAT SELECTS IT THROWS - it does NOT read NULL. MariaDB
 *   raises ER_BAD_FIELD_ERROR for an unknown column, so on a server whose ALTER hasn't run yet (it is
 *   allowed to give up after a bounded wait - see gcphone/server/contacts.lua) every query built against
 *   this Drizzle table definition rejects. A caller that awaits all ten Comms feeds in one `Promise.all`
 *   loses every feed to one missing column on one table - see loadPlayerCommsAction's `Promise.allSettled`
 *   switch and its per-feed fallback. Do not reintroduce the "harmless default" assumption here.
 * ⚠ COLLATION - same as every other gcphone table (see the phoneMessages header above): these are
 *   DEFAULT CHARSET=utf8mb4 with no explicit COLLATE, i.e. the server default (utf8mb4_general_ci),
 *   while users.identifier is utf8mb4_unicode_ci. comms.ts never compares these columns to
 *   users.identifier directly - only via a BOUND PARAM (eq()/inArray() with a JS string), which
 *   coerces to the column's own collation and never throws. Do not add a raw column-to-column join.
 */

/** `gcphone/server/contacts.lua` - the address book. Keyed by the OWNER's `identifier`, not their
 *  number (contacts must survive the owner's own number changing). */
export const phoneContacts = mysqlTable(GT.phoneContacts, {
  id: int("id").primaryKey(),
  identifier: varchar("identifier", { length: 60 }).notNull(),
  display: varchar("display", { length: 64 }).notNull(), // player-typed contact name
  number: varchar("number", { length: 20 }).notNull(), // NOT required to resolve to a real user
  deletedAt: timestamp("deleted_at"), // soft-delete, in-flight migration - see header
});

/** `gcphone/server/marketplace.lua` - classified ads. `type`: 0=VEHICLES 1=REALESTATE 2=OTHERS.
 *  `sell`: true = selling, false = looking to buy. `number` is FORCED server-side to the poster's own
 *  real number (never the client's claim), so it is safe to treat as a real player line. */
export const phoneMarketPlace = mysqlTable(GT.phoneMarketPlace, {
  id: int("id").primaryKey(),
  identifier: varchar("identifier", { length: 60 }).notNull(), // the poster
  type: tinyint("type").notNull(),
  title: varchar("title", { length: 64 }).notNull(),
  desc: text("desc").notNull(),
  img: varchar("img", { length: 255 }),
  price: bigint("price", { mode: "number" }).notNull(),
  number: varchar("number", { length: 20 }).notNull(),
  premium: tinyint("premium").notNull(),
  sell: tinyint("sell").notNull(),
  time: bigint("time", { mode: "number" }).notNull(), // EPOCH MILLISECONDS, same convention as phoneMessages
  deletedAt: timestamp("deleted_at"), // soft-delete, already live on this one table - see header
});

/** `gcphone/server/twitter.lua` - Bleeter/Onyx accounts. A SEPARATE identity from the ESX character
 *  (its own username+password), so a tweet's author is reached by joining tweets -> this table, never
 *  read off the tweet row directly. `password_hash`/`password_salt` are deliberately NOT declared -
 *  CITADEL has no legitimate reason to read them. */
export const phoneTwitterAccounts = mysqlTable(GT.phoneTwitterAccounts, {
  id: int("id").primaryKey(),
  username: varchar("username", { length: 24 }).notNull(),
  avatarUrl: varchar("avatar_url", { length: 255 }),
  certified: tinyint("certified").notNull(),
  identifier: varchar("identifier", { length: 60 }).notNull(), // the account's OWNER
  time: bigint("time", { mode: "number" }).notNull(),
});

/** `gcphone/server/twitter.lua` - tweets. `account_id` -> phoneTwitterAccounts.id (int = int, no
 *  collation concern on that join). `answers` is a JSON array when the tweet is a poll, else NULL. */
export const phoneTwitterTweets = mysqlTable(GT.phoneTwitterTweets, {
  id: int("id").primaryKey(),
  accountId: int("account_id").notNull(),
  message: text("message").notNull(),
  answers: text("answers"),
  time: bigint("time", { mode: "number" }).notNull(),
  deletedAt: timestamp("deleted_at"), // soft-delete, in-flight migration - see header
});

/** `gcphone/server/weazel.lua` - Weazel News articles. `author` is a WRITE-TIME SNAPSHOT of the RP
 *  name (resolved server-side from `source`, never client-supplied - see the Lua file's own security
 *  note), not a live-joinable identifier; `identifier` is the actual author for scoping a query to
 *  "this player's articles". No `deleted_at`: weazel.lua has no delete handler at all (verified - no
 *  `DeleteWeazelNewsInfo` event exists), so this table is never soft-deleted, unlike the four above. */
export const phoneWeazelNews = mysqlTable(GT.phoneWeazelNews, {
  id: int("id").primaryKey(),
  author: varchar("author", { length: 64 }).notNull(),
  title: varchar("title", { length: 96 }).notNull(),
  message: text("message").notNull(),
  identifier: varchar("identifier", { length: 60 }).notNull(),
  time: bigint("time", { mode: "number" }).notNull(),
});

/** `gcphone/server/bank.lua` - the real, server-authoritative bank transfer ledger (BUILT
 *  2026-07-24, replacing a dead okokBanking delegation - see that file's own header). ONE ROW PER
 *  TRANSFER, both sides' identifier/number captured directly - no owner-scoped fan-out like
 *  phoneMessages, and no soft-delete (a money transfer is a permanent ledger fact; nothing in
 *  bank.lua ever deletes one). */
export const phoneBankTransactions = mysqlTable(GT.phoneBankTransactions, {
  id: int("id").primaryKey(),
  senderIdentifier: varchar("sender_identifier", { length: 60 }).notNull(),
  senderNumber: varchar("sender_number", { length: 20 }).notNull(),
  receiverIdentifier: varchar("receiver_identifier", { length: 60 }).notNull(),
  receiverNumber: varchar("receiver_number", { length: 20 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(), // UNSIGNED in the DB; always positive
  time: bigint("time", { mode: "number" }).notNull(), // EPOCH MILLISECONDS
});

/** `phone_photos` - PROVISIONED, `gcphone/server/photos.lua` owns the `CREATE TABLE IF NOT EXISTS`
 *  (id, identifier, url, time, deleted_at) and every read/write handler for the phone-camera gallery.
 *  `url` is `VARCHAR(512)` on the live table (photos.lua's own CREATE TABLE), not 255 - matched below. */
export const phonePhotos = mysqlTable(GT.phonePhotos, {
  id: int("id").primaryKey(),
  identifier: varchar("identifier", { length: 60 }).notNull(), // the taker
  url: varchar("url", { length: 512 }).notNull(),
  time: bigint("time", { mode: "number" }).notNull(), // EPOCH MILLISECONDS, same convention as the rest
  deletedAt: timestamp("deleted_at"), // soft-delete, in-flight migration - see header
});

/* ── Justice / warrants / billing (added 2026-07-25, JUSTICE_CAD_DESIGN_2026-07-25.md §1) ──────
   None of these three tables were previously declared here at all - CITADEL could not read
   warrants, police warrants, or outstanding bills. Added as plain read declarations (this file's
   convention: GAME zone, never migrated by CITADEL, see the header comment at the top of this
   file) ahead of any page that will actually consume them. */

/** `warrants` - CREATE TABLE verified: gs_jobs/jobs/justice/server/main.lua:43-53. Issued by
 *  Justice/Prosecutor via `gs_justice:deliverWarrant`, which writes this table AND
 *  `police_warrants` (below) in one handler - the two are siblings, not a foreign-key pair, and
 *  can drift (see `police_warrants`' own comment). `target_identifier` is nullable: a
 *  department-wide notice with no specific named suspect is legal (JUSTICE_CAD_DESIGN §4). */
export const warrants = mysqlTable(GT.warrants, {
  id: int("id").primaryKey(),
  targetIdentifier: varchar("target_identifier", { length: 60 }),
  issuerIdentifier: varchar("issuer_identifier", { length: 60 }).notNull(),
  reason: varchar("reason", { length: 255 }).notNull(),
  createdAt: datetime("created_at").notNull(),
  expiresAt: datetime("expires_at").notNull(),
  active: tinyint("active").notNull(),
});

/** `police_warrants` - CREATE TABLE verified: gs_jobs/jobs/police/server/warrants.lua:38-49, with
 *  two later ALTERs at :52-53 (target_identifier loosened to nullable, issuer_job added - both
 *  reflected here since Drizzle reads live shape, not history). Police/sheriff's own copy of a
 *  warrant, written by the SAME `gs_justice:deliverWarrant` handler that writes `warrants` above -
 *  they are two independent rows from one event, not a normalized relation, so a query that needs
 *  "the" warrant for a person must decide which table it means. `used` flips true when
 *  `gs_warrant:useWarrant` (gs_jobs/jobs/police/server/warrants.lua) turns it into a live in-game
 *  search zone - that in-game search-zone STATE itself is RAM-only (`gs_jobs/server/warrants.lua`'s
 *  `ActiveWarrants`), not persisted here or anywhere; it resets on a resource restart. */
export const policeWarrants = mysqlTable(GT.policeWarrants, {
  id: int("id").primaryKey(),
  job: varchar("job", { length: 20 }).notNull(),
  targetIdentifier: varchar("target_identifier", { length: 60 }),
  issuerIdentifier: varchar("issuer_identifier", { length: 60 }).notNull(),
  issuerJob: varchar("issuer_job", { length: 20 }),
  reason: varchar("reason", { length: 255 }),
  expirationDate: datetime("expiration_date").notNull(),
  used: tinyint("used").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/** `billing` - CREATE TABLE verified: gs_utils/modules/billing/server/main.lua:108-121.
 *  ⚠ THIS TABLE ONLY EVER HOLDS UNPAID INVOICES. A paid bill is `DELETE`d immediately
 *  (billing/server/main.lua:972) - there is no historical/paid ledger anywhere in the game DB
 *  (confirmed in that file's own header comment and JUSTICE_CAD_DESIGN_2026-07-25.md §1). A page
 *  built on this table shows the CURRENT outstanding queue, never a payment history - do not
 *  build a "past invoices" view against this table alone; `gs_logs` category 91 (`billing`) is
 *  the only durable record of a paid/refused bill, and even that is prose-plus-partial-data, not
 *  a queryable row. `splits` is a frozen JSON snapshot taken at creation time (job-menu invoices
 *  split 97/3 into a society + its `_blocked` pot) - `NULL` means 100% to `target`, and a
 *  corrupted snapshot is read as `NULL` by the game's own decoder (fail-closed, never redirects
 *  payment). `target_type`/`target` together name who gets paid (a society name, or a player
 *  identifier for a direct player-to-player bill) - there is no single FK this joins against. */
export const billing = mysqlTable(GT.billing, {
  id: int("id").primaryKey(),
  identifier: varchar("identifier", { length: 60 }).notNull(), // the DEBTOR
  sender: varchar("sender", { length: 60 }).notNull(), // who created the bill
  targetType: varchar("target_type", { length: 50 }).notNull(),
  target: varchar("target", { length: 40 }).notNull(), // society name OR a player identifier
  label: varchar("label", { length: 255 }).notNull(),
  amount: int("amount").notNull(),
  splits: varchar("splits", { length: 255 }), // frozen JSON snapshot, NULL = 100% to `target`
  createdAt: timestamp("created_at").notNull(),
});

/* ── gs_bank ledger (added 2026-07-25, BANKING_DESIGN_2026-07-25.md) ────────────────────────────
   CORRECTED 2026-07-26 - the "Phase 1 only, nothing calls it" note below was accurate on
   2026-07-25 and is stale now: as of 2026-07-26 gs_bank is authoritative for personal balances,
   ESX's automatic paycheck, and the large majority of society/business money (see
   BANKING_DESIGN_2026-07-25.md §19-21) - these tables carry real, live data, not just a one-time
   migration backfill. `status` can now be 'active' | 'frozen' (Justice CAD account freeze,
   accounts.lua's FreezeAccount) | 'closed'. First real reader: bankSearch.ts (LEO financial
   search, 2026-07-26). `gs_bank_cards` (Phase 2, real and provisioned since 2026-07-25) is STILL
   NOT declared here - nothing in CITADEL reads it yet, and the "don't declare speculatively" rule
   below remains correct for tables that genuinely have no reader; it no longer applies to the three
   below, which do.

   Card, invoice, service-event and ATM-state tables (beyond gs_bank_cards) do not exist as gs_bank
   tables at all (invoice/service-event/ATM-state are Phase 3 scope) and are deliberately NOT
   declared here - schema for a table that isn't provisioned would silently return "table doesn't
   exist" errors, which is worse than not declaring it. */

/** `gs_bank_accounts` - CREATE TABLE verified: gs_bank/server/schema.lua. One row per ledger
 *  account (`kind`: personal/business/system). `ownerIdentifier` is NULL for the singleton
 *  `system:mint` suspense account and for business accounts (not created until Phase 2) - see
 *  that file's own UNIQUE KEY comment for why NULL is safe there (MySQL never treats two NULLs
 *  as colliding). `balance` is signed: every real personal/business account is floored at 0 by
 *  the atomic CAS debit, but the mint account is deliberately allowed to go negative. */
export const gsBankAccounts = mysqlTable(GT.gsBankAccounts, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  number: varchar("number", { length: 20 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  ownerIdentifier: varchar("owner_identifier", { length: 60 }),
  jobName: varchar("job_name", { length: 50 }),
  label: varchar("label", { length: 80 }).notNull(),
  balance: bigint("balance", { mode: "number" }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  openedAt: bigint("opened_at", { mode: "number" }).notNull(), // EPOCH MILLISECONDS
  closedAt: bigint("closed_at", { mode: "number" }),
  /**
   * WHICH POT. `''` = the main treasury, `'blocked'` = the twin the invoice split accumulates in.
   * Verified live 2026-08-21: 151 main + 154 blocked business accounts.
   *
   * ⚠ WITHOUT THIS COLUMN A `job_name` LOOKUP RETURNS TWO ROWS AND DOUBLE-COUNTS THE FACTION. It is
   * the same trap `society_<job>` / `society_<job>_blocked` sets on the ESX side, which
   * societyModel.ts already documents at length.
   */
  subaccount: varchar("subaccount", { length: 24 }).notNull(),
  currency: varchar("currency", { length: 16 }).notNull(),
});

/** `gs_bank_txn` - CREATE TABLE verified: gs_bank/server/schema.lua. `idempotencyKey` is the
 *  UNIQUE key the ledger's reserve-then-act idempotency is built on - a caller retry with the
 *  same key returns the prior outcome rather than moving money twice. `status`:
 *  pending/applied/failed. `fromAccountId`/`toAccountId` are nullable only in the sense that a
 *  row always has both once `applied` - `mintLeggedMove` (gs_bank/server/ledger.lua) always
 *  names the mint account on one side for Charge/Credit/OfflineApply. */
export const gsBankTxn = mysqlTable(GT.gsBankTxn, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  idempotencyKey: varchar("idempotency_key", { length: 80 }).notNull(),
  ref: varchar("ref", { length: 20 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  actorIdentifier: varchar("actor_identifier", { length: 60 }),
  fromAccountId: bigint("from_account_id", { mode: "number" }),
  toAccountId: bigint("to_account_id", { mode: "number" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  category: varchar("category", { length: 40 }).notNull(),
  description: varchar("description", { length: 255 }).notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  serviceRef: varchar("service_ref", { length: 64 }), // Phase 3 (justification chain), unused today
  meta: text("meta"), // JSON
  reversedBy: bigint("reversed_by", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // EPOCH MILLISECONDS
  appliedAt: bigint("applied_at", { mode: "number" }),
});

/** `gs_bank_entries` - CREATE TABLE verified: gs_bank/server/schema.lua. The double-entry legs:
 *  every APPLIED `gs_bank_txn` writes exactly two rows here (one debit, one credit). Anti-dupe
 *  invariant: `SUM(direction='debit' amount) = SUM(direction='credit' amount)` globally, and
 *  per-account `balance_after` on the latest row should equal the account's live `balance`. */
export const gsBankEntries = mysqlTable(GT.gsBankEntries, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  txnId: bigint("txn_id", { mode: "number" }).notNull(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  direction: varchar("direction", { length: 6 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // EPOCH MILLISECONDS
});

/* ── Weapon serialisation ledger (gs_base/modules/weaponRegistry) ─────────────
 * CREATE TABLE verified: gs_base/modules/weaponRegistry/server/main.lua:33-74.
 *
 * TWO tables and they answer DIFFERENT questions - do not merge them in a read model:
 *   `gs_weapon_registry`  = ONE ROW PER WEAPON, its CURRENT holder. "Where is SN-XXXX right now."
 *   `gs_weapon_transfers` = append-only chain of custody. "How did it get there."
 * Joined to each other by `serial` (VARCHAR), never by id: transfers rows are written before the
 * registry row exists on the mint path, so an FK could not hold.
 *
 * ⚠ Both are utf8mb4_general_ci (gs_base creates them); `users` is utf8mb4_unicode_ci. EVERY join
 * onto a player must go through eqCollate() or it throws ER_CANT_AGGREGATE_2COLLATIONS at runtime -
 * not at build time. See lib/db/collation.ts.
 *
 * ⚠ `status = 'legacy_unverified'` means the weapon predates serialisation and was backfilled. It is
 * NOT a suspicion flag: the module's own header says arming "no serial = illegitimate" before the
 * backfill completes would ban legitimate players. Never render it as an alert.
 */
export const gsWeaponRegistry = mysqlTable(GT.gsWeaponRegistry, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  serial: varchar("serial", { length: 24 }).notNull(),
  weaponName: varchar("weapon_name", { length: 64 }).notNull(),
  /** Who it was MINTED to. Provenance, never the current owner - read the holder columns for that. */
  issuedToIdentifier: varchar("issued_to_identifier", { length: 60 }).notNull(),
  /** 'black_market', a job name, 'admin', ... - who had the authority to issue it. */
  issuingAuthority: varchar("issuing_authority", { length: 60 }).notNull(),
  issueSourceKind: varchar("issue_source_kind", { length: 30 }).notNull(),
  issuedAt: timestamp("issued_at"),
  /** "x,y,z" as a plain string, written by the Lua side. Parse defensively, it can be NULL. */
  issuedAtCoords: varchar("issued_at_coords", { length: 60 }),
  currentHolderType: mysqlEnum("current_holder_type", ["player", "container", "ground", "unknown"]).notNull(),
  currentHolderIdentifier: varchar("current_holder_identifier", { length: 60 }),
  /** e.g. `trunk_EKA 0796`, `locker_identifier=<hex>_job=lspd_location=missionrow`, `bag_i712`. */
  currentHolderContainerId: varchar("current_holder_container_id", { length: 150 }),
  status: mysqlEnum("status", ["active", "confiscated", "destroyed", "legacy_unverified"]).notNull(),
  updatedAt: timestamp("updated_at"),
});

export const gsWeaponTransfers = mysqlTable(GT.gsWeaponTransfers, {
  id: bigint("id", { mode: "number" }).primaryKey(),
  serial: varchar("serial", { length: 24 }).notNull(),
  transferKind: mysqlEnum("transfer_kind", [
    "issue",
    "player_give",
    "container_deposit",
    "container_withdraw",
    "container_move",
    "ground_drop",
    "ground_pickup",
    "confiscate",
    "admin_action",
    "legacy_seed",
  ]).notNull(),
  fromType: mysqlEnum("from_type", ["player", "container", "ground", "none"]).notNull(),
  fromIdentifier: varchar("from_identifier", { length: 60 }),
  fromContainerId: varchar("from_container_id", { length: 150 }),
  toType: mysqlEnum("to_type", ["player", "container", "ground", "none"]).notNull(),
  toIdentifier: varchar("to_identifier", { length: 60 }),
  toContainerId: varchar("to_container_id", { length: 150 }),
  /** WHO performed the move, which is not always the from/to party (a staff seizure, a boss). */
  actorIdentifier: varchar("actor_identifier", { length: 60 }),
  /** 'denied' rows are REFUSED attempts and are kept on purpose - they are the interesting ones. */
  result: mysqlEnum("result", ["ok", "denied"]).notNull(),
  data: text("data"), // JSON
  occurredAt: timestamp("occurred_at"),
});
