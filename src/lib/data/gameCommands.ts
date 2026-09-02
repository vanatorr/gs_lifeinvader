/**
 * Server-only helpers backing the PLAYERS action rail's write path (src/app/staff/players/actions.ts).
 * Every moderation write there queues through citadel_jobs (lib/data/jobs.ts's createJob - the
 * existing enqueue helper, reused, not reinvented). This module adds the pieces that don't already
 * exist elsewhere: the real job catalog for the "Changer de métier" picker, and small validators so
 * a queued job never carries garbage (an unknown job name, a negative amount, a nonsense grade).
 *
 * `kind` strings are centralized here (JOB_KIND) so every call site spells them identically - a typo
 * in a kind string would silently orphan a job (the future gs_citadel worker matches on exact string).
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { items, jobGrades, jobs, licenses } from "@/lib/db/schema/game";
import { fixMojibake } from "@/lib/text/fixMojibake";

/** citadel_jobs.kind values this action rail can enqueue. */
export const JOB_KIND = {
  KICK: "player.kick",
  WARN: "player.warn",
  /** Panel mirror of in-game `/reply` (staff.reports). Online-only. */
  REPLY: "player.reply",
  BAN: "player.ban",
  TELEPORT: "player.teleport",
  GIVE_MONEY: "player.give_money",
  TAKE_MONEY: "player.take_money",
  GIVE_ITEM: "player.give_item",
  GIVE_CONTAINER_ITEM: "container.give_item",
  TAKE_CONTAINER_ITEM: "container.take_item",
  SET_JOB: "player.set_job",
  SET_RANK: "player.set_rank",
  /** Rename a character (page joueur, admin+ via the `norename` division). Drained by
   *  CITADEL/server/commands.lua, which calls through to gs_identity:RenameCharacter - the single
   *  writer of users.firstname/lastname and the only VM holding string.normalizeName. */
  SET_NAME: "player.set_name",

  /* ── Inline panel management (2026-07-17) ──────────────────────────────────────────────────────
   * Owner: "like here i want to be able to directly manage" - these back the row-level actions on the
   * Inventaire / Emplois / Permis / Véhicules panels rather than a toolbar.
   *
   * ⚠ EVERY STRING BELOW IS A CROSS-PROCESS CONTRACT with an `executors['<kind>']` key in
   * gs_citadel/server/commands.lua. A typo does NOT throw: the drain filters its claim to the kinds it
   * has executors for, so an unmatched row is never claimed and sits `queued` FOREVER while the panel
   * happily reports success. Verified byte-identical against that file on 2026-07-17. If you add one
   * here, add the executor in the same change. */
  TAKE_ITEM: "player.take_item",
  SET_ITEM_QTY: "player.set_item_qty",
  GIVE_WEAPON: "player.give_weapon",
  TAKE_WEAPON: "player.take_weapon",
  SET_JOB2: "player.set_job2",
  GRANT_LICENSE: "player.grant_license",
  REVOKE_LICENSE: "player.revoke_license",
  VEHICLE_REPAIR: "vehicle.repair",
  VEHICLE_SET_GARAGE: "vehicle.set_garage",

  /* ── Véhicules / Propriétés depth tabs (2026-07-17) ────────────────────────────────────────────
   * Same cross-process contract as the block above, and verified the same way: each string below was
   * read off its `executors['<kind>']` key in gs_citadel/server/commands.lua (`vehicle.impound` :977,
   * `vehicle.clear_owner` :1012, `property.clear_owner` :1038), not guessed from the action's name.
   *
   * ⚠ THE KIND AND THE PERMISSION CODE ARE DIFFERENT STRINGS AND MUST NOT BE CONFLATED.
   * `vehicle.impound` happens to be spelled identically as a kind and as a CODES entry; the other two
   * are not (`vehicle.clear_owner` the kind vs `superadmin.clearvehicleowner` the code). Copying one
   * into the other's slot is the exact failure this table exists to prevent - a wrong code fails
   * loudly at the permission check, a wrong kind sits `queued` forever and reports success. */
  VEHICLE_IMPOUND: "vehicle.impound",
  VEHICLE_CLEAR_OWNER: "vehicle.clear_owner",
  PROPERTY_CLEAR_OWNER: "property.clear_owner",

  /* ── Playtime bypass (2026-07-17) ───────────────────────────────────────────────────────────
   * Executors are `resources/CITADEL/server/commands.lua` - per-player exemption and the global
   * switch, both writing gs_kvp (see lib/data/playtimeQuery.ts for the read side). */
  SET_PLAYTIME_EXEMPT: "player.set_playtime_exempt",
  SET_PLAYTIME_GLOBAL: "playtime.set_global",

  /* ── VIP / donator (Tebex -> CITADEL -> game, 2026-07-18) ───────────────────────────────────────
   * ABSOLUTE set of a player's gs_kvp `donatorLevel` - the single integer the whole in-game perk
   * surface already reads (gs_properties capacity/gates, gs_animals DonatorMaxPets, gs_identity donator
   * peds, gs_jobs inventory pricing, the dressing cap, the blackmarket, and gs_queue join priority).
   *
   * ONE kind, not grant/revoke, ON PURPOSE: CITADEL computes the player's EFFECTIVE level (the max
   * level across their active, non-expired entitlements) and pushes it absolute, so the game stays
   * dumb, there are no delta bugs, and it is idempotent -> safe in RetryableKinds. level 0 = no VIP
   * (that IS revoke). Executor `player.vip.set` in resources/CITADEL/server/commands.lua, added in
   * the SAME change (an orphan kind sits `queued` forever while the panel reports success). */
  VIP_SET: "player.vip.set",

  /* ── Prop deletion recycle bin (2026-07-18) ─────────────────────────────────────────────────────
   * Restore a deleted placed object. Payload carries the citadel_prop_deletions id + the full gs_props
   * snapshot; the executor re-inserts the gs_props row with the SAME id (so the surviving gs_inventory
   * contents reconnect) and respawns it. Idempotent: restoring an already-present prop is a no-op, so
   * it is safe in RetryableKinds. Executor `prop.restore` in resources/CITADEL/server/commands.lua. */
  PROP_RESTORE: "prop.restore",
  STORAGE_RESTORE: "storage.restore",

  /* -- Refund a player's belongings from a log row's snapshot (2026-08-24) ------------------------
   * "Restituer" on /staff/logs. Hands back exactly the objects a gs_logs snapshot recorded - the same
   * serial, the same wear, the same attachments - rather than a factory-new copy of their model.
   *
   * WARNING - THIS KIND MINTS OBJECTS, AND IT MUST NEVER BE ADDED TO CD.RetryableKinds. Every other
   * restore in this block is safe to replay because it converges on a state (a prop exists, a
   * container matches its snapshot); a refund is a DELTA and replaying it hands the belongings out
   * twice. The same reasoning already keeps every money/item kind out of that set - see the loud
   * block at commands.lua's storage.give_item. Idempotency lives one layer up, in
   * refundBelongingsAction's citadel_audit guard.
   *
   * As with every kind here, this string MUST match an `executors['inventory.refund']` key in
   * resources/CITADEL/server/commands.lua (added in the SAME change) - an orphan kind sits `queued`
   * forever with attempts = 0 while the panel reports success. */
  INVENTORY_REFUND: "inventory.refund",

  MORTRP_EXECUTE: "mortrp.execute",
  MORTRP_UNDO: "mortrp.undo",

  /* ── Territory sabotage revert (2026-07-24) ────────────────────────────────────────────────────
   * Undo a gang territory sabotage from its Logs row. Same cross-process contract as the blocks above:
   * this string MUST match an `executors['sabotage.revert']` key in resources/CITADEL/server/commands.lua
   * (added in the SAME change) - an orphan kind sits `queued` forever while the panel reports success.
   * The executor re-resolves zoneId server-side and calls gs_jobs' RevertSabotage export. */
  SABOTAGE_REVERT: "sabotage.revert",
} as const;

/**
 * citadel_jobs.kind values for Page · Factions. Same rule as JOB_KIND above - centralized so every
 * call site spells them identically, because a typo does NOT fail loudly: gs_citadel's drain matches
 * on an exact string, so a misspelled kind leaves the row sitting `queued` forever with no error.
 * (That is not hypothetical here - `bans.lift` and `anticheat.ban_request` are enqueued today with no
 * executor behind them and do exactly that.)
 *
 * Every one of these has a registered executor in gs_citadel/server/commands.lua, which calls straight
 * through to a gs_jobs export - gs_jobs owns the society-money cache and ConfigSociety, neither of
 * which is reachable from another resource's VM.
 *
 * ⚠ `society` in these payloads is always the BARE job name ('police'), matching
 * society_transactions.society and users.job. The executor derives 'society_<job>' itself.
 */
export const FACTION_JOB_KIND = {
  /** SIGNED delta - withdraw is negative, deposit positive. Never a `set` (see the action's comment). */
  ADJUST_MONEY: "faction.adjust_money",
  /** Hire / promote / demote / set grade. The SLOT (job vs job2) is resolved in-game, never sent. */
  SET_MEMBER: "faction.set_member",
  FIRE: "faction.fire",
  SET_GRADE_SALARY: "faction.set_grade_salary",
  SET_GRADE_LABEL: "faction.set_grade_label",
  CREATE_GRADE: "faction.create_grade",
  DELETE_GRADE: "faction.delete_grade",
  /** Rename the faction itself (jobs.label) - the label is what every player-facing surface shows. */
  SET_LABEL: "faction.set_label",
  /**
   * ⚠ NOT cosmetic. `jobs.whitelisted` is what stops a player self-assigning the job at the
   * Pôle-Emploi NPC (society.lua's saveDoubleJob refuses any whitelisted job). Turning it OFF opens
   * the faction to everyone, so the action requires a reason.
   */
  SET_WHITELIST: "faction.set_whitelist",
  /** Reused as-is from the players rail - no faction-specific give path is needed. */
  GIVE_ITEM: "player.give_item",
  /** Confiscation. Online-only, exactly like give_item. */
  TAKE_ITEM: "player.take_item",
  /**
   * Fleet upkeep - REUSED VERBATIM from the players rail's kinds (JOB_KIND above), whose executors a
   * parallel session already wrote and which are live in gs_citadel/server/commands.lua. Defining a
   * faction-specific twin would have orphaned rows behind a kind with no executor.
   * `vehicle.repair` refuses while the car is OUT (stored=0) - the store path would overwrite the
   * repair with the client's real damage. `vehicle.set_garage` with no garageId = "return it to its
   * own garage" (gs_garage exposes no garage-id validator, so a target garage is refused).
   */
  VEHICLE_REPAIR: "vehicle.repair",
  VEHICLE_RETURN: "vehicle.set_garage",
  /**
   * Impound a fleet vehicle - REUSED VERBATIM from the players rail (JOB_KIND.VEHICLE_IMPOUND,
   * executor `vehicle.impound` at gs_citadel/server/commands.lua:977). Owner ask 2026-07-17: staff
   * could SEE a fleet car in the pound (`stored=2`) and do nothing about it from the faction page.
   * The executor keys on the plate and is owner-agnostic, so a faction fleet car works unchanged;
   * guardFactionVehicle still confines the plate to THIS faction's fleet before enqueue.
   */
  VEHICLE_IMPOUND: "vehicle.impound",
  /**
   * Strip a fleet plate from the faction (owner ask 2026-08-19). REUSED VERBATIM from the players
   * rail (`vehicle.clear_owner`). AdminClearVehicleOwner already NULLs both `owner` and `job`, so a
   * faction row is the same transition as a personal one. A faction-specific twin would sit queued
   * with no executor. guardFactionVehicle still confines the plate to THIS faction's fleet first.
   */
  VEHICLE_CLEAR_OWNER: "vehicle.clear_owner",
  /**
   * ── Coffres de metier (2026-08-15) ────────────────────────────────────────────────────────────
   * Owner: "in citadel allow admin+ to withdraw and deposit items and weapons into each job storages
   * and view all of them even if empty". Executeurs `storage.*` dans
   * resources/CITADEL/server/commands.lua, ajoutes dans LE MEME changement - un kind orphelin reste
   * `queued` pour toujours pendant que le panneau annonce un succes.
   *
   * ⚠ CE NE SONT PAS LES KINDS `container.*`, ET LES DEUX FAMILLES DOIVENT RESTER SEPAREES.
   * `container.give_item` prend un `containerId` DEJA RESOLU et exige que le conteneur ait ete
   * ouvert au moins une fois; c'est ce qui le rend utilisable depuis la page d'un JOUEUR, ou l'on
   * regarde des conteneurs qui existent. Ici on part de (job, pointName) - la cle de config, jamais
   * un id - parce qu'un coffre de metier n'existe le plus souvent PAS encore en base: sur la prod le
   * 2026-08-15, 154 metiers en declaraient pour UNE ligne. Les executeurs `storage.*` provisionnent
   * donc le conteneur avant d'ecrire, ce que les `container.*` ne font pas et ne doivent pas faire.
   *
   * ⚠ AUCUN DES QUATRE N'EST RETRYABLE (CD.RetryableKinds, config.lua cote jeu): un depot est un
   * DELTA. La meme regle exclut deja tous les kinds money/item/faction, pour la meme raison.
   */
  STORAGE_GIVE_ITEM: "storage.give_item",
  STORAGE_TAKE_ITEM: "storage.take_item",
  STORAGE_GIVE_WEAPON: "storage.give_weapon",
  /** Confiscation. Prend l'`instanceId` de l'arme, JAMAIS son nom - voir StorageWeapon. */
  STORAGE_TAKE_WEAPON: "storage.take_weapon",
} as const;

export type MoneyAccount = "cash" | "bank" | "black" | "chips";

const MONEY_ACCOUNT_SET: Record<MoneyAccount, true> = {
  cash: true,
  bank: true,
  black: true,
  chips: true,
};

export function isValidMoneyAccount(v: unknown): v is MoneyAccount {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MONEY_ACCOUNT_SET, v);
}

export type JobOption = { name: string; label: string };

/** Every job the server recognizes, label-sorted - backs the "Changer de métier" picker. A
 * free-text job field would risk queuing a job.set for a name gs_jobs has no grade ladder for at
 * all, so the picker only ever offers names that exist in the real `jobs` table (CLAUDE.md's
 * "never hardcode job names" rule, applied here as "never invent one either"). */
export async function listJobs(): Promise<JobOption[]> {
  const rows = await db
    .select({ name: jobs.name, label: jobs.label })
    .from(jobs)
    .orderBy(asc(jobs.label));
  return rows.map((r) => ({ name: r.name, label: fixMojibake(r.label ?? r.name) }));
}

/** Re-validate a job name server-side - never trust that the client's <select> actually reflects
 * the current `jobs` table (it could be stale, or the request forged outright). */
export async function jobExists(name: string): Promise<boolean> {
  const rows = await listJobs();
  return rows.some((j) => j.name === name);
}

/* ── Item catalog - backs the item PICKER (2026-07-17) ───────────────────────── */

export type ItemOption = { name: string; label: string; weight: number };

/**
 * Every item the server recognizes, label-sorted - backs the item picker that replaces the
 * free-text item box on the players action rail.
 *
 * SOURCE OF TRUTH: the ESX `items` table (name/label/weight), the same catalog es_extended itself
 * loads via ESX.RefreshItems (`SELECT * FROM items`, server/common.lua) and the same one
 * lib/data/inventory.ts resolves labels against. Verified live 2026-07-16: 622 rows. Exactly the
 * reasoning listJobs() above records: a free-text field can queue a give_item for a name no item
 * row exists for, which the game then silently drops - the picker only ever offers names that
 * really exist, and itemExists() re-checks server-side.
 *
 * Sorted in JS with localeCompare(fr) rather than SQL ORDER BY - item labels are French and heavily
 * accented ("Téléphone"), which a raw SQL sort under this DB's collation does not order correctly.
 * Same call inventory.ts makes for the same reason.
 */
export async function listItems(): Promise<ItemOption[]> {
  const rows = await db
    .select({ name: items.name, label: items.label, weight: items.weight })
    .from(items);
  const out: ItemOption[] = rows.map((r) => ({
    // label is NOT NULL in the schema, but a legacy row can hold ''; fall back to the raw name so a
    // real item is never rendered as a blank option (inventory.ts's label ?? name convention).
    name: r.name,
    label: fixMojibake(r.label || r.name),
    weight: r.weight,
  }));
  out.sort((a, b) => a.label.localeCompare(b.label, "fr"));
  return out;
}

/** Re-validate an item name server-side - never trust the client's <select> (stale, or forged
 *  outright). Same contract as jobExists() above. */
export async function itemExists(name: string): Promise<boolean> {
  const rows = await db
    .select({ name: items.name })
    .from(items)
    .where(eq(items.name, name))
    .limit(1);
  return rows.length > 0;
}

/* ── Job grade ladder - the REAL grade picker (2026-07-17) ───────────────────── */

export type JobGradeOption = {
  grade: number;
  name: string;
  label: string;
  salary: number | null;
  /** True iff `job_grades.name` is literally 'boss'. See the ⚠ below - never infer this from index. */
  isBoss: boolean;
};

/**
 * The real grade ladder for one job, backing a grade picker instead of a free integer box.
 *
 * SOURCE OF TRUTH: the `job_grades` table, keyed (job_name, grade) - the same rows es_extended reads
 * at boot (`SELECT * FROM job_grades`, server/common.lua:214-218).
 *
 * ⚠ THE DB IS THE AUTHORITY, NOT ESX.Jobs. es_extended loads job_grades into an in-memory `ESX.Jobs`
 *   cache at boot and that cache goes stale the moment a grade is created/edited without a
 *   `restart es_extended` - CLAUDE.md documents gs_jobs falling back to a DB read for exactly this
 *   reason. CITADEL never sees ESX.Jobs anyway (it is another VM's Lua table), and reading the table
 *   directly means the picker is right even when the game's cache is not.
 *
 * ⚠ BOSS IS A NAME, NEVER AN INDEX. `isBoss` is `name === 'boss'` and nothing else. CLAUDE.md is
 *   explicit and it is load-bearing: boss is always the TOP grade in the seeded ladder
 *   (recrue→employé→responsable→boss), so `grade === 3` or `grade === max` LOOKS equivalent and is
 *   not - a job with a custom ladder breaks both guesses, and a wrong boss flag is a privilege
 *   escalation (boss gates the society funds / HR menu), not a cosmetic bug.
 *
 * Ordered by `grade` ascending - a numeric ladder rung, so SQL order is correct here (unlike the
 * label sorts above, which need fr collation).
 */
export async function gradesForJob(jobName: string): Promise<JobGradeOption[]> {
  const rows = await db
    .select({
      grade: jobGrades.grade,
      name: jobGrades.name,
      label: jobGrades.label,
      salary: jobGrades.salary,
    })
    .from(jobGrades)
    .where(eq(jobGrades.jobName, jobName))
    .orderBy(asc(jobGrades.grade));

  return rows.map((r) => {
    const name = r.name ?? "";
    return {
      grade: r.grade,
      name,
      // es_extended falls back label -> name (common.lua:216); CITADEL mirrors that exactly, then
      // to the rung number so an option is never blank.
      label: fixMojibake(r.label || name || String(r.grade)),
      salary: r.salary ?? null,
      isBoss: name === "boss",
    };
  });
}

/**
 * Re-validate a (job, grade) pair against the real ladder - the DB-backed authority that supersedes
 * isValidJobGrade()'s free 0-20 shape check (see its @deprecated note below). A grade that passes
 * the integer check but has no `job_grades` row is not a "high grade", it is a NON-EXISTENT one:
 * the game would set users.job_grade to a rung with no salary, label, or permissions attached.
 */
export async function jobGradeExists(jobName: string, grade: number): Promise<boolean> {
  if (!Number.isInteger(grade)) return false;
  const rows = await db
    .select({ grade: jobGrades.grade })
    .from(jobGrades)
    .where(and(eq(jobGrades.jobName, jobName), eq(jobGrades.grade, grade)))
    .limit(1);
  return rows.length > 0;
}

/* ── License catalog - backs grant/revoke (2026-07-17) ───────────────────────── */

export type LicenseTypeOption = { type: string; label: string };

/**
 * Every license type the server recognizes, label-sorted - backs a grant/revoke picker.
 *
 * SOURCE OF TRUTH: the `licenses` table (type -> label). This is not a CITADEL-side choice of
 * catalog: it is the SAME table the game validates against - gs_jobs/modules/license/server/main.lua:95
 * gates every grant on `SELECT 1 FROM licenses WHERE type = ? LIMIT 1`, and gs_utils' LicenseListLookup
 * reads `SELECT type, label FROM licenses` (server/main.lua:108). So the picker offers exactly the
 * set the game will accept, and licenseTypeExists() below applies the game's own predicate.
 *
 * ⚠ COLUMN NAMES VERIFIED, NOT ASSUMED (2026-07-17): `licenses(type, label)` and the who-has-what
 *   side is `user_licenses(id, type, owner)` - CREATE TABLE at
 *   gs_jobs/modules/license/server/main.lua:64-71. Note `owner`, NOT `identifier`/`user_id`, and it
 *   holds the BARE-HEX identifier (joins users.identifier). The player-scoped read of that table
 *   already exists as licensesForPlayer() in lib/data/players.ts:231 - this module deliberately
 *   holds only the global CATALOG (the picker's option list), leaving the per-player state there,
 *   the same split inventory.ts/items observes.
 */
export async function listLicenseTypes(): Promise<LicenseTypeOption[]> {
  const rows = await db
    .select({ type: licenses.type, label: licenses.label })
    .from(licenses);
  const out: LicenseTypeOption[] = rows.map((r) => ({
    // `label` is nullable here (unlike items.label) - fall back to the raw type, the same convention
    // licensesForPlayer() uses for an unknown type.
    type: r.type,
    label: fixMojibake(r.label || r.type),
  }));
  out.sort((a, b) => a.label.localeCompare(b.label, "fr"));
  return out;
}

/** Re-validate a license type server-side. Mirrors the game's own check
 *  (gs_jobs/modules/license/server/main.lua:95) rather than inventing a second predicate. */
export async function licenseTypeExists(type: string): Promise<boolean> {
  const rows = await db
    .select({ type: licenses.type })
    .from(licenses)
    .where(eq(licenses.type, type))
    .limit(1);
  return rows.length > 0;
}

/**
 * Sanity ceilings for numbers typed into a form. These are NOT game-economy values (those stay in
 * the FiveM Lua config, per CLAUDE.md - CITADEL never invents a price/limit) - they only guard
 * against an obviously-wrong input (a fat-fingered extra zero, a negative) before it reaches the
 * queue. The bridge and the game's own money/inventory/job code remain the real authority.
 */
export const MAX_MONEY_GIVE = 50_000_000;
export const MAX_ITEM_QUANTITY = 1_000;
export const MAX_JOB_GRADE = 20;
/**
 * Ammo ceiling for a give-weapon job. A SANITY guard, not a game value: the real per-weapon ammo
 * limits live in es_extended's Config.Weapons and the game's own addWeapon path remains the
 * authority (same reasoning as MAX_MONEY_GIVE above - CITADEL never re-declares an economy number).
 * This only stops a fat-fingered extra zero reaching the queue. 0 is legal (melee takes no ammo).
 */
export const MAX_WEAPON_AMMO = 10_000;

export function isValidMoneyAmount(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= MAX_MONEY_GIVE;
}

export function isValidItemQuantity(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= MAX_ITEM_QUANTITY;
}

/**
 * @deprecated SHAPE-ONLY, and superseded by jobGradeExists(job, grade) above - use that instead.
 *
 * This asks "is it an int in 0..20", which answers nothing useful: 0..20 is an invented range with
 * no basis in the data (the real ladder is whatever rows `job_grades` holds for that job, commonly
 * 0..3), so it accepts grade 17 for a job with four rungs and would set users.job_grade to a rung
 * that does not exist. It cannot be deleted yet: app/staff/players/actions.ts:62 still imports it
 * (used at :480), and that file is a Server Action outside this change's scope. Migrating that one
 * call site to `await jobGradeExists(job, grade)` - it already `await`s jobExists(job) on the line
 * above - is the intended follow-up, after which this and MAX_JOB_GRADE should be removed.
 */
export function isValidJobGrade(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_JOB_GRADE;
}

export function isValidBanDuration(minutes: number | null): boolean {
  return minutes === null || (Number.isInteger(minutes) && minutes > 0);
}

/**
 * SANITY ceiling for a VIP donator level pushed to the game. NOT an economy value: the real tiers and
 * their levels live in vipTiers.ts (1/2/3 by default), and the game's own donatorLevel gates are the
 * authority. This only stops an obviously-wrong integer (a negative, or a fat-fingered huge number)
 * reaching the queue. 0 is valid and meaningful - it is the revoke value.
 */
export const MAX_VIP_LEVEL = 100;

export function isValidVipLevel(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_VIP_LEVEL;
}

/* ── Page · Factions ──────────────────────────────────────────────────────────── */

/**
 * SHAPE-ONLY salary check: a non-negative integer.
 *
 * ⚠ The real ceiling is `ConfigSociety.MaxSalary` - a GAME value (gs_jobs/modules/society/config.lua).
 * CITADEL deliberately does NOT re-declare it: cross-resource exports msgpack-copy plain data, so that
 * config is only readable inside gs_jobs' own VM, and duplicating the number here would create a second
 * source of truth that silently drifts the day the owner tunes it. AdminSetGradeSalary re-checks
 * against the real cap and refuses; the action then settles to a visible error. Same reasoning as
 * MAX_MONEY_GIVE above: these guard a fat-fingered input, they are not the economy's authority.
 */
export function isValidSalary(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000;
}

/** Shape-only: non-empty after trim. The real cap is ConfigSociety.MaxGradeLabelLength (25), enforced
 *  in gs_jobs for the same reason as isValidSalary - but a generous client bound stops obvious abuse. */
export function isValidGradeLabel(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.length <= 64;
}

/** A society fund adjustment: a NON-ZERO integer. The hard ceiling is ConfigSociety.AdminMaxAdjust,
 *  enforced in gs_jobs (see isValidSalary's note). Sign carries the direction. */
export function isValidSocietyDelta(n: number): boolean {
  return Number.isInteger(n) && n !== 0 && Math.abs(n) <= MAX_MONEY_GIVE;
}
