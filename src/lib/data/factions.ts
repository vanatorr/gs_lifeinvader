/**
 * Factions - the ORG side of Page · Factions (money lives in society.ts, mirroring the game's own
 * core.lua / society.lua split).
 *
 * A "faction" here is a row in the ESX `jobs` table. Two verified facts decide how they're presented:
 *
 *   1. `jobs.type` IS USELESS FOR GROUPING - 125 rows are 'civ' and exactly 1 is 'gov' (police;
 *      LSMC is 'civ'). It is populated, just not meaningfully, so grouping by it yields one bucket of
 *      125. `jobs.whitelisted` is the real signal (39 / 87) AND it is the game's own definition of a
 *      faction: esx_joblisting / society.lua's saveDoubleJob only permit self-joining a NON-whitelisted
 *      job, so whitelisted literally means "you must be recruited". Owner decision 2026-07-16.
 *      (`typeLabel` is still surfaced so the day someone seeds a real taxonomy, the UI lights up.)
 *
 *   2. ONLY ~12 OF 125 FACTIONS HAVE ANY SIGNAL (members, money, or ledger history). 113 are empty
 *      shells. Hence `hasSignal` - the list defaults to the ones that matter and never hides the rest.
 *
 * MEMBERSHIP IS DUAL-SLOT. ESX has `job` AND `job2`, and society.lua:406's own getEmployees covers
 * both - verified live: one player is boss of `haters` (job) and `police` (job2). A `job`-only roster
 * would silently hide the LSPD boss. Every query here covers both slots.
 *
 * BOSS IS DETECTED BY NAME, NEVER BY MAX(grade) - `grade_name == 'boss'`, with the legacy
 * `grade_label IN ('boss','patron')` fallback, exactly as gs_jobs/server/core.lua:154-166 does.
 *
 * LABELS ONLY (owner rule): every type here carries resolved labels. `name` is present solely as a
 * routing key/id and must never be rendered.
 */
import { and, asc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { eqCollate } from "@/lib/db/collation";
import { jobGrades, jobs, ownedVehicles, users } from "@/lib/db/schema/game";
import { jobGradeLabels, rankLabelForGroup } from "@/lib/data/labels";
import { lastMovementFor, societyBalances, societyBalancesFor } from "@/lib/data/society";
import { factionAssetCounts, type FactionAssetCounts } from "@/lib/data/factionAssets";
import { vehicleModelInfoFromJson } from "@/lib/data/vehicleModels";
import { vehicleModsFromJson, type VehicleMods } from "@/lib/data/vehicleMods";

/** ESX's canonical "no job" sentinel - gs_jobs/server/society.lua:801 FIRED_JOB_NAME. Never a literal
 *  at a call site. ⚠ users.job2 DEFAULTS to this STRING, not to NULL (verified live). */
export const UNEMPLOYED = "unemployed";

/** The boss rung test, kept identical to gs_jobs/server/core.lua:154-166 (name first, label fallback
 *  for legacy jobs seeded before the ladder convention). Never `MAX(grade)`. */
const BOSS_SQL = sql`(LOWER(TRIM(${jobGrades.name})) = 'boss' OR LOWER(TRIM(${jobGrades.label})) IN ('boss','patron'))`;

export type FactionSummary = {
  /** Routing key ONLY - never rendered (owner rule: labels only). */
  name: string;
  label: string;
  /** jobs.type resolved to a label, or null. Today effectively always 'civ' - see the file header. */
  typeLabel: string | null;
  whitelisted: boolean;
  /** Members across BOTH slots. */
  members: number;
  online: number;
  bosses: { identifier: string; name: string; rankLabel: string | null }[];
  /** null = NO society account row (≠ 0 - see society.ts). Renders as "-", not "0 $". */
  balance: number | null;
  lastMovementAt: Date | null;
  /** members > 0 OR balance > 0 OR any ledger history. Drives the "Actives" filter. */
  hasSignal: boolean;
  /** What the faction OWNS - coffres / propriétés / fleet. On the LIST purely so these are
   *  DISCOVERABLE: only ~3 of 125 factions have a coffre and ~4 have a property, so without a count
   *  here you would have to open factions one by one to find them (owner, 2026-07-17). */
  assets: FactionAssetCounts;
};

export type FactionEmployee = {
  identifier: string;
  name: string;
  rankLabel: string | null;
  /** 1 = users.job (principal), 2 = users.job2 (secondaire). */
  slot: 1 | 2;
  grade: number;
  gradeLabel: string | null;
  isBoss: boolean;
  salary: number | null;
};

export type FactionGrade = {
  grade: number;
  /** The rung's human label ("Patron"). */
  label: string | null;
  /** The internal rung id ('boss'/'recrue'/'grade_3'). Needed to render the boss chip honestly. */
  rungName: string | null;
  salary: number | null;
  isBoss: boolean;
  /** Members sitting on this rung (both slots) - the UI disables "supprimer" when > 0, and the Lua
   *  refuses it anyway (a rung with no row would strand them on a grade ESX cannot resolve). */
  headcount: number;
};

export type FactionVehicleRow = {
  plate: string;
  ownerIdentifier: string | null;
  ownerName: string | null;
  stored: number;
  parking: string | null;
  pound: string | null;
  /**
   * Rockstar's display name, e.g. "Dubsta 6x6", or null when the row's model resolves to nothing.
   *
   * ⚠ THIS IS THE CLOSEST THING TO A "MARQUE" THAT EXISTS. `vehicleList.lua` has no manufacturer
   * field (verified 2026-08-20: zero brand/marque/manufacturer anywhere in the resources tree, and
   * no `vehicleMakeName` in any `.meta`). Rockstar's own name embeds the make for some vehicles
   * ("Benefactor BR8") and not for most ("Adder"). Never synthesise the missing half.
   */
  model: string | null;
  /** Spawn code, e.g. "dubsta3" - the value staff transcribe into a command. Mono in the UI. */
  modelCode: string | null;
  /** FR class label, e.g. "Off-Road". */
  vehicleClass: string | null;
  /**
   * What the car is WEARING, decoded server-side into words (owner 2026-08-21). Same shape and same
   * decoder as the players rail, so the fleet table and a player's own vehicle card cannot describe
   * the same car differently. null when the blob is unparseable; `record === "none"` means the row
   * stores no appearance at all, which is a different and louder fact than "no mods fitted".
   */
  mods: VehicleMods | null;
};

/** `label` falls back to `name` only when the jobs row has none - same convention as labels.ts. */
const labelOf = (name: string, label: string | null) => label ?? name;

/** Just the presence field these functions need. Structurally satisfied by `OnlinePlayer`
 *  (lib/data/onlinePlayers.ts), whose `license` is the BARE hex that joins users.identifier - so the
 *  caller can pass fetchOnlineSeed().players straight through without a mapping step. Deliberately a
 *  minimal shape rather than importing OnlinePlayer: this module has no other reason to depend on the
 *  presence layer, and a narrow structural type keeps that coupling from growing. */
type OnlineLike = { license: string | null };

/**
 * Every faction, with staffing / bosses / balance / activity - for the list.
 *
 * ONE query for the org data (126 rows, correlated subqueries), plus two grouped lookups for money.
 * Deliberately NOT N+1. No virtualization needed at this size (players/ renders 50 much wider rows).
 */
export async function listFactions(
  online: OnlineLike[] = [],
): Promise<FactionSummary[]> {
  const memberCount = sql<number>`(
    SELECT COUNT(*) FROM ${users} u
    WHERE (u.job = ${jobs.name} OR u.job2 = ${jobs.name})
  )`;

  const rows = await db
    .select({
      name: jobs.name,
      label: jobs.label,
      type: jobs.type,
      whitelisted: jobs.whitelisted,
      members: memberCount,
    })
    .from(jobs)
    .where(ne(jobs.name, UNEMPLOYED)) // no society account, and not a faction - see header
    .orderBy(asc(jobs.label));

  const names = rows.map((r) => r.name);
  const [balances, lastMoves, bossRows, assets] = await Promise.all([
    societyBalancesFor(names),
    lastMovementFor(names),
    bossesFor(names),
    factionAssetCounts(names),
  ]);

  // Presence is keyed by license (bare hex) - the same key users.identifier uses.
  const onlineIds = new Set(online.map((o) => o.license).filter(Boolean) as string[]);
  const onlineByJob = await onlineCountsFor(names, onlineIds);

  return rows.map((r) => {
    const balance = balances.get(r.name) ?? null;
    const lastMovementAt = lastMoves.get(r.name) ?? null;
    const members = Number(r.members ?? 0);
    return {
      name: r.name,
      label: labelOf(r.name, r.label),
      typeLabel: r.type ?? null,
      whitelisted: r.whitelisted === 1,
      members,
      online: onlineByJob.get(r.name) ?? 0,
      bosses: bossRows.get(r.name) ?? [],
      balance,
      lastMovementAt,
      hasSignal: members > 0 || (balance ?? 0) > 0 || lastMovementAt !== null,
      assets: assets.get(r.name) ?? { storage: 0, properties: 0, fleet: 0 },
    };
  });
}

/** Bosses for many jobs at once (both slots), resolved by rung NAME. Backs the list's PATRON column. */
async function bossesFor(
  names: string[],
): Promise<Map<string, { identifier: string; name: string; rankLabel: string | null }[]>> {
  const out = new Map<string, { identifier: string; name: string; rankLabel: string | null }[]>();
  if (names.length === 0) return out;

  // jobs.name <-> users.job are BOTH utf8mb4_unicode_ci, so no collation bridge is needed here
  // (verified live). job_grades.job_name is unicode_ci too.
  const rows = await db
    .select({
      job: sql<string>`CASE WHEN ${users.job} = ${jobGrades.jobName} THEN ${users.job} ELSE ${users.job2} END`,
      identifier: users.identifier,
      firstname: users.firstname,
      lastname: users.lastname,
      group: users.group,
    })
    .from(users)
    .innerJoin(
      jobGrades,
      or(
        and(eq(jobGrades.jobName, users.job), eq(jobGrades.grade, users.jobGrade)),
        and(eq(jobGrades.jobName, users.job2), eq(jobGrades.grade, users.job2Grade)),
      ),
    )
    .where(and(sql`${jobGrades.jobName} IN ${names}`, BOSS_SQL));

  const labels = await Promise.all(rows.map((r) => rankLabelForGroup(r.group)));
  rows.forEach((r, i) => {
    if (!r.job) return;
    const list = out.get(r.job) ?? [];
    list.push({
      identifier: r.identifier,
      name: `${r.firstname ?? ""} ${r.lastname ?? ""}`.trim() || "Sans nom",
      rankLabel: labels[i],
    });
    out.set(r.job, list);
  });
  return out;
}

/** How many CURRENTLY-ONLINE players hold each job (either slot). */
async function onlineCountsFor(names: string[], onlineIds: Set<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (names.length === 0 || onlineIds.size === 0) return out;

  const rows = await db
    .select({ identifier: users.identifier, job: users.job, job2: users.job2 })
    .from(users)
    .where(sql`${users.identifier} IN ${[...onlineIds]}`);

  for (const r of rows) {
    for (const j of [r.job, r.job2]) {
      if (!j || j === UNEMPLOYED) continue;
      out.set(j, (out.get(j) ?? 0) + 1);
    }
  }
  return out;
}

/** One faction, for the detail route. null = unknown job (the page 404s). */
export async function getFaction(job: string, online: OnlineLike[] = []): Promise<FactionSummary | null> {
  if (!job || job === UNEMPLOYED) return null;
  const [row] = await db
    .select({ name: jobs.name, label: jobs.label, type: jobs.type, whitelisted: jobs.whitelisted })
    .from(jobs)
    .where(eq(jobs.name, job))
    .limit(1);
  if (!row) return null;

  const [{ balance }, lastMoves, bossRows, memberRow] = await Promise.all([
    societyBalances(job),
    lastMovementFor([job]),
    bossesFor([job]),
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(users)
      .where(or(eq(users.job, job), eq(users.job2, job)))
      .then((r) => r[0]),
  ]);

  const onlineIds = new Set(online.map((o) => o.license).filter(Boolean) as string[]);
  const onlineByJob = await onlineCountsFor([job], onlineIds);
  const members = Number(memberRow?.n ?? 0);
  const lastMovementAt = lastMoves.get(job) ?? null;

  return {
    name: row.name,
    label: labelOf(row.name, row.label),
    typeLabel: row.type ?? null,
    whitelisted: row.whitelisted === 1,
    members,
    online: onlineByJob.get(job) ?? 0,
    bosses: bossRows.get(job) ?? [],
    balance,
    lastMovementAt,
    hasSignal: members > 0 || (balance ?? 0) > 0 || lastMovementAt !== null,
    // The detail page renders the real panels (and their own counts), so it does not need this - but
    // the field is part of FactionSummary, so fill it honestly rather than lie with zeros.
    assets: (await factionAssetCounts([job])).get(job) ?? { storage: 0, properties: 0, fleet: 0 },
  };
}

/**
 * The roster - BOTH slots, in one query.
 * A player holding the job in job AND job2 is impossible in practice but would legitimately produce
 * two rows (one per slot), which is the honest rendering rather than a silent dedupe.
 */
export async function rosterFor(job: string): Promise<FactionEmployee[]> {
  if (!job || job === UNEMPLOYED) return [];

  const rows = await db
    .select({
      identifier: users.identifier,
      firstname: users.firstname,
      lastname: users.lastname,
      group: users.group,
      job: users.job,
      jobGrade: users.jobGrade,
      job2: users.job2,
      job2Grade: users.job2Grade,
    })
    .from(users)
    .where(or(eq(users.job, job), eq(users.job2, job)));

  // Flatten to one entry per SLOT the player holds this job in.
  const flat = rows.flatMap((r) => {
    const out: { r: typeof r; slot: 1 | 2; grade: number }[] = [];
    if (r.job === job) out.push({ r, slot: 1, grade: Number(r.jobGrade ?? 0) });
    if (r.job2 === job) out.push({ r, slot: 2, grade: Number(r.job2Grade ?? 0) });
    return out;
  });

  const [gradeLabelList, rankList, ladder] = await Promise.all([
    jobGradeLabels(flat.map((f) => ({ job, grade: f.grade }))),
    Promise.all(flat.map((f) => rankLabelForGroup(f.r.group))),
    gradeLadderFor(job),
  ]);
  const bossGrades = new Set(ladder.filter((g) => g.isBoss).map((g) => g.grade));
  const salaryByGrade = new Map(ladder.map((g) => [g.grade, g.salary]));

  const out: FactionEmployee[] = flat.map((f, i) => ({
    identifier: f.r.identifier,
    name: `${f.r.firstname ?? ""} ${f.r.lastname ?? ""}`.trim() || "Sans nom",
    rankLabel: rankList[i],
    slot: f.slot,
    grade: f.grade,
    gradeLabel: gradeLabelList[i],
    isBoss: bossGrades.has(f.grade),
    salary: salaryByGrade.get(f.grade) ?? null,
  }));

  // Bosses first, then descending rung, then name - the order a staff member scans in.
  out.sort((a, b) => b.grade - a.grade || a.name.localeCompare(b.name, "fr"));
  return out;
}

/** The grade ladder, ascending, with live headcount per rung. */
export async function gradeLadderFor(job: string): Promise<FactionGrade[]> {
  if (!job || job === UNEMPLOYED) return [];

  const rows = await db
    .select({
      grade: jobGrades.grade,
      name: jobGrades.name,
      label: jobGrades.label,
      salary: jobGrades.salary,
      isBoss: sql<number>`CASE WHEN ${BOSS_SQL} THEN 1 ELSE 0 END`,
      headcount: sql<number>`(
        SELECT COUNT(*) FROM ${users} u
        WHERE (u.job = ${jobGrades.jobName} AND u.job_grade = ${jobGrades.grade})
           OR (u.job2 = ${jobGrades.jobName} AND u.job2_grade = ${jobGrades.grade})
      )`,
    })
    .from(jobGrades)
    .where(eq(jobGrades.jobName, job))
    .orderBy(asc(jobGrades.grade));

  return rows.map((r) => ({
    grade: r.grade,
    // es_extended falls back label -> name (common.lua:216); match it so panel and game agree.
    label: r.label ?? r.name,
    rungName: r.name,
    salary: r.salary,
    isBoss: Number(r.isBoss) === 1,
    headcount: Number(r.headcount ?? 0),
  }));
}

/**
 * Faction fleet - owned_vehicles.job.
 * ⚠ NO model column: `owned_vehicles.vehicle` is a JSON blob whose `model` is a numeric HASH, and this
 * codebase ships no hash->name table (streamed vehicles.meta is excluded per CLAUDE.md). Inventing one
 * would be fabrication, so the plate is the identity here.
 * ⚠ owner -> users.identifier is a cross-collation column join (general_ci vs unicode_ci) -> eqCollate.
 */
export async function vehiclesForFaction(job: string): Promise<FactionVehicleRow[]> {
  if (!job || job === UNEMPLOYED) return [];

  const rows = await db
    .select({
      plate: ownedVehicles.plate,
      owner: ownedVehicles.owner,
      // The model blob. Selected since 2026-08-20 (owner: "it should also show the car brand and
      // model") - the panel used to say a model column "could only be fabricated", which was wrong:
      // vehicleModels.ts has resolved hashes against the game's own catalog since 2026-07-16, this
      // query simply never asked for the column.
      vehicle: ownedVehicles.vehicle,
      stored: ownedVehicles.stored,
      parking: ownedVehicles.parking,
      pound: ownedVehicles.pound,
      firstname: users.firstname,
      lastname: users.lastname,
    })
    .from(ownedVehicles)
    .leftJoin(users, eqCollate(users.identifier, ownedVehicles.owner))
    .where(eq(ownedVehicles.job, job))
    .orderBy(asc(ownedVehicles.plate))
    .limit(200);

  return rows.map((r) => {
    const name = `${r.firstname ?? ""} ${r.lastname ?? ""}`.trim();
    const info = vehicleModelInfoFromJson(r.vehicle);
    return {
      plate: r.plate,
      ownerIdentifier: r.owner,
      // A society vehicle legitimately has no owner - say so rather than rendering a blank cell.
      ownerName: name || null,
      stored: Number(r.stored ?? 0),
      parking: r.parking,
      pound: r.pound,
      model: info?.label ?? null,
      modelCode: info?.modelName ?? null,
      vehicleClass: info?.categoryLabel ?? null,
      mods: vehicleModsFromJson(r.vehicle),
    };
  });
}

/**
 * Membership gate for every employee-scoped write. Covers BOTH slots.
 * Not optional: without it, fireEmployeeAction('police', <an LSMC medic>) would happily queue a fire
 * for a job the target isn't in. The Lua re-resolves the slot itself too - this is the CITADEL-side
 * half of the same rule.
 */
export async function isEmployeeOf(job: string, identifier: string): Promise<boolean> {
  if (!job || job === UNEMPLOYED || !identifier) return false;
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(users)
    .where(and(eq(users.identifier, identifier), or(eq(users.job, job), eq(users.job2, job))));
  return Number(row?.n ?? 0) > 0;
}

/** The employee's live grade in this faction, per slot - backs the optimistic-concurrency guard. */
export async function memberGrade(job: string, identifier: string): Promise<number | null> {
  const [row] = await db
    .select({ job: users.job, jobGrade: users.jobGrade, job2: users.job2, job2Grade: users.job2Grade })
    .from(users)
    .where(eq(users.identifier, identifier))
    .limit(1);
  if (!row) return null;
  if (row.job === job) return Number(row.jobGrade ?? 0);
  if (row.job2 === job) return Number(row.job2Grade ?? 0);
  return null;
}

/**
 * Hire picker - players NOT already in this faction (either slot).
 * Pre-filtering here is the same discipline players/actions.ts uses for the rank picker: the dropdown
 * can never offer someone the server would refuse.
 */
export async function hireCandidates(job: string, q: string, limit = 25) {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term}%`;

  const rows = await db
    .select({
      identifier: users.identifier,
      firstname: users.firstname,
      lastname: users.lastname,
      job: users.job,
      group: users.group,
    })
    .from(users)
    .where(
      and(
        sql`(CONCAT(COALESCE(${users.firstname},''), ' ', COALESCE(${users.lastname},'')) LIKE ${like} OR ${users.identifier} LIKE ${like})`,
        sql`(${users.job} IS NULL OR ${users.job} <> ${job})`,
        sql`(${users.job2} IS NULL OR ${users.job2} <> ${job})`,
        isNotNull(users.identifier),
      ),
    )
    .limit(limit);

  const rankList = await Promise.all(rows.map((r) => rankLabelForGroup(r.group)));
  return rows.map((r, i) => ({
    identifier: r.identifier,
    name: `${r.firstname ?? ""} ${r.lastname ?? ""}`.trim() || "Sans nom",
    rankLabel: rankList[i],
    /** True when the primary slot is occupied - the Lua refuses the hire, so the UI says why up front. */
    hasPrimaryJob: !!r.job && r.job !== UNEMPLOYED,
  }));
}
