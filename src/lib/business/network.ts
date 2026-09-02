/**
 * LA CONSOLE RÃ‰SEAU: qui gouverne le portail LifeInvader lui-mÃªme, et ce qu'il peut en faire.
 *
 * Le reste de `lib/business/` rÃ©pond Ã  "que puis-je faire DANS mon commerce". Ce fichier rÃ©pond Ã  la
 * question du dessus: "qui dÃ©cide QUELS mÃ©tiers ont un portail". Les deux ne se mÃ©langent pas, et
 * c'est dÃ©libÃ©rÃ©: `access.ts` ne connaÃ®t que l'appartenance Ã  un mÃ©tier, et il reste la seule porte
 * d'un employÃ© vers son enseigne. Rien ici ne l'assouplit pour un employÃ© ordinaire.
 *
 * âš âš  DEUX MOITIÃ‰S DE PORTE, DEUX AXES D'AUTORITÃ‰, ET IL NE FAUT PAS LES FUSIONNER.
 *   - Le FONDATEUR passe par le rang staff (`business.admin`, catalogue RBAC partagÃ© avec le jeu).
 *   - La DIRECTION DE MIRAGE passe par son GRADE PATRON EN JEU, comme n'importe quel patron.
 * Donner un rang staff au patron de MIRAGE pour lui ouvrir sa console lui livrerait au passage tout
 * ce que ce rang porte ailleurs dans le panel; lui inventer un code RBAC accordÃ© par mÃ©tier ferait
 * l'inverse et mettrait une notion de mÃ©tier dans une table de rangs. Les deux moitiÃ©s se
 * rejoignent ICI, dans une seule fonction, pour qu'il n'existe qu'un endroit Ã  relire.
 *
 * âš  CE FICHIER LIT `lifeinvader_businesses` EN ENTIER, ce que l'en-tÃªte d'`access.ts` interdit Ã  toute
 * page. L'interdiction vise les pages d'EMPLOYÃ‰: en lister d'autres afficherait des enseignes oÃ¹
 * l'on ne travaille pas. Une console d'administration du rÃ©seau est l'exception que cette rÃ¨gle
 * suppose, et elle doit Ãªtre Ã©crite comme telle - une porte explicite, une seule, et pas un
 * `select()` glissÃ© dans une page.
 */
import "server-only";
import { and, asc, eq, gte, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  citadelBusinesses,
  citadelBusinessItems,
  citadelBusinessSales,
} from "@/lib/db/schema/citadel";
import { jobGrades, jobs, users } from "@/lib/db/schema/game";
import { UNEMPLOYED } from "@/lib/data/factions";
import { fixMojibake } from "@/lib/text/fixMojibake";
import { licensesForAccount, type Identity } from "@/lib/auth/identity";
import { insertedId } from "@/lib/db/insertId";
import { BUSINESS_TEMPLATES, getTemplate, templateSeed } from "./templates";
import { isValidPortalSlug, slugifyPortal } from "./slug";
import { sql } from "drizzle-orm";

/**
 * LE MÃ‰TIER QUI GOUVERNE LE RÃ‰SEAU, et son grade patron.
 *
 * Une constante nommÃ©e et un seul point de lecture: le jour oÃ¹ l'enseigne qui administre le portail
 * change, c'est cette ligne qui change, pas une chaÃ®ne recopiÃ©e dans une page. `boss` est un NOM de
 * grade (`job_grades.name`), jamais un numÃ©ro - mÃªme rÃ¨gle que partout ailleurs dans ce dÃ©pÃ´t.
 */
const NETWORK_ADMIN_JOB = "mirage";
const BOSS_GRADE_NAME = "boss";


function devStaffNetworkAdmin(discordId: string | null): boolean {
  if (!discordId) return false;
  const raw = process.env.DEV_NETWORK_ADMIN_DISCORD_IDS ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(discordId);
}

export type NetworkAdmin = {
  /** Par le rang staff (`business.admin`, ou le '*' du Fondateur). */
  viaStaff: boolean;
  /** Par le grade patron du mÃ©tier qui gouverne le rÃ©seau. */
  viaJob: boolean;
};

/**
 * Cette personne gouverne-t-elle le rÃ©seau, et par quelle moitiÃ© de la porte.
 *
 * Rend `null` pour "non", jamais `false`, pour que l'appelant ne puisse pas confondre "aucun droit"
 * avec "droit sans dÃ©tail". Le dÃ©tail sert Ã  l'affichage (dire Ã  la personne d'oÃ¹ vient son accÃ¨s)
 * et jamais Ã  une dÃ©cision: les deux moitiÃ©s ouvrent exactement la mÃªme porte.
 */
export async function networkAdminFor(identity: Identity | null): Promise<NetworkAdmin | null> {
  if (!identity) return null;

  const viaStaff = devStaffNetworkAdmin(identity.discordId);

  // âš  La moitiÃ© MÃ‰TIER se lit Ã  CHAQUE appel, jamais en session: se faire retirer le grade patron en
  // jeu doit fermer la console au chargement suivant, sans qu'aucune table du panel ait Ã  Ãªtre tenue
  // Ã  jour. MÃªme raisonnement que `employmentsFor`, dont c'est la rÃ¨gle fondatrice.
  let viaJob = false;
  const licenses = await licensesForAccount(identity.accountId);
  if (licenses.length > 0) {
    const rows = await db
      .select({ job: users.job, grade: users.jobGrade, job2: users.job2, grade2: users.job2Grade })
      .from(users)
      .where(
        and(
          // Les DEUX emplacements ESX. N'en lire qu'un est exactement le bogue corrigÃ© dans
          // access.ts le 2026-08-13: la direction porte souvent son mÃ©tier en second.
          or(eq(users.job, NETWORK_ADMIN_JOB), eq(users.job2, NETWORK_ADMIN_JOB)),
          inArray(users.identifier, licenses),
        ),
      );

    if (rows.length > 0) {
      const ladder = await db
        .select({ grade: jobGrades.grade, name: jobGrades.name })
        .from(jobGrades)
        .where(eq(jobGrades.jobName, NETWORK_ADMIN_JOB));
      const bossRungs = new Set(
        ladder.filter((g) => (g.name ?? "").toLowerCase() === BOSS_GRADE_NAME).map((g) => g.grade),
      );
      viaJob = rows.some(
        (r) =>
          (r.job === NETWORK_ADMIN_JOB && bossRungs.has(r.grade ?? -1)) ||
          (r.job2 === NETWORK_ADMIN_JOB && bossRungs.has(r.grade2 ?? -1)),
      );
    }
  }

  if (!viaStaff && !viaJob) return null;
  return { viaStaff, viaJob };
}

/** Raccourci boolÃ©en, pour les gardes qui n'ont pas besoin de savoir d'oÃ¹ vient le droit. */
export async function isNetworkAdmin(identity: Identity | null): Promise<boolean> {
  return (await networkAdminFor(identity)) !== null;
}

/* â”€â”€ Ce que la console voit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export type PortalRow = {
  id: number;
  job: string;
  /** Le libellÃ© du mÃ©tier EN JEU (`jobs.label`), distinct de l'enseigne choisie pour le portail. */
  jobLabel: string | null;
  slug: string;
  name: string;
  template: string;
  active: boolean;
  /** Articles au catalogue (actifs et inactifs): le seul chiffre qui dit si le portail sert. */
  items: number;
  /** Personnes portant ce mÃ©tier en jeu, DANS L'UN OU L'AUTRE des deux emplacements ESX. */
  employees: number;
  /**
   * CE QUI A Ã‰TÃ‰ DÃ‰CLARÃ‰, en centimes, aujourd'hui et depuis lundi.
   *
   * âš  DÃ‰CLARÃ‰, PAS MESURÃ‰, et le mot compte plus que le chiffre. La vente se joue en RP: un employÃ©
   * sert un client, Ã©tablit une facture en jeu, le client paie - le serveur n'a aucun moyen de
   * savoir ce qui s'est passÃ© dans la scÃ¨ne, et surtout pas si le client a payÃ© en liquide. C'est
   * la raison d'Ãªtre de tout ce module (voir l'en-tÃªte de `schema/citadel.ts`), et un en-tÃªte de
   * colonne qui dirait "chiffre d'affaires" transformerait une dÃ©claration en mesure.
   *
   * âš  LA PART EMPLOYÃ‰ N'EST PAS DÃ‰DUITE. `commissionCents` ne sort jamais de la facture du client;
   * c'est la sociÃ©tÃ© qui la verse en fin de semaine. La soustraire ici ferait passer une charge de
   * l'entreprise pour une remise au client, exactement l'inversion que le propriÃ©taire a dÃ©jÃ 
   * corrigÃ©e une fois sur ce module. Elle est rendue Ã  part.
   */
  declaredTodayCents: number;
  declaredWeekCents: number;
  /** La part employÃ© due sur ces mÃªmes ventes: une CHARGE, jamais une dÃ©duction du montant ci-dessus. */
  commissionTodayCents: number;
  commissionWeekCents: number;
  /** Nombre de tickets. Un montant sans volume ne se lit pas: 1 000 $ en un ticket ou en vingt. */
  ticketsToday: number;
  ticketsWeek: number;
};

/**
 * Le lundi 00:00 de la semaine qui contient `d`, et minuit ce matin.
 *
 * âš  SEMAINE CALENDAIRE LUNDI->LUNDI, la mÃªme que la page Ã‰quipe (`gestion/equipe/page.tsx`
 * `mondayOf`) et que la page Analytique. Une console qui compterait sa semaine sur sept jours
 * glissants afficherait un total diffÃ©rent de celui que le patron lit sur sa propre page, pour la
 * mÃªme enseigne et au mÃªme instant - et c'est la console qu'on croirait fausse.
 *
 * âš  On avance la DATE (`setDate`), jamais des millisecondes: le passage Ã  l'heure d'Ã©tÃ© fait des
 * journÃ©es de 23 et 25 heures, donc une semaine soustraite en `7 * 86 400 000` tombe une heure Ã 
 * cÃ´tÃ© deux fois par an. MÃªme piÃ¨ge que celui dÃ©jÃ  documentÃ© sur la page Ã‰quipe.
 */
function weekAndDayStart(): { weekStart: Date; dayStart: Date } {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date(dayStart);
  const day = weekStart.getDay(); // 0 = dimanche
  weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));

  return { weekStart, dayStart };
}

/**
 * Tous les portails, actifs ou non, avec de quoi juger d'un coup d'oeil s'ils servent.
 *
 * âš  Trois requÃªtes plates rapprochÃ©es par `Map`, et AUCUNE jointure entre `lifeinvader_business_items`
 * et les tables ESX: les tables du panel (citadel_* comme lifeinvader_*, meme jeu de migrations) sont en utf8mb4_general_ci et les tables de jeu en
 * utf8mb4_unicode_ci, et MariaDB lÃ¨ve l'erreur 1267 Ã€ L'EXÃ‰CUTION alors que les deux cÃ´tÃ©s se typent
 * `string`. `tsc` ne peut pas la voir. MÃªme discipline que `roster.ts`.
 */
export async function listPortals(): Promise<PortalRow[]> {
  const { weekStart, dayStart } = weekAndDayStart();

  const [rows, jobRows, itemCounts, staffCounts, money] = await Promise.all([
    db.select().from(citadelBusinesses).orderBy(asc(citadelBusinesses.name)),
    db.select({ name: jobs.name, label: jobs.label }).from(jobs),
    db
      .select({ businessId: citadelBusinessItems.businessId, n: sql<number>`COUNT(*)` })
      .from(citadelBusinessItems)
      .groupBy(citadelBusinessItems.businessId),
    // âš  AUCUN filtre `job != unemployed` dans la requÃªte: il exclurait aussi les personnes dont le
    // PREMIER emplacement est vide mais dont le SECOND porte un vrai mÃ©tier, c'est-Ã -dire exactement
    // la moitiÃ© d'Ã©quipe que le portail vient de cesser d'ignorer. Le tri par emplacement se fait
    // plus bas, une valeur Ã  la fois.
    db.select({ job: users.job, job2: users.job2 }).from(users),
    /**
     * LE JOUR ET LA SEMAINE EN UNE SEULE PASSE.
     *
     * âš  UNE requÃªte et non deux, parce que la journÃ©e est CONTENUE dans la semaine: `mondayOf`
     * n'est jamais postÃ©rieur Ã  ce matin, donc filtrer sur le lundi ramÃ¨ne dÃ©jÃ  toutes les lignes du
     * jour, et un CASE les sÃ©pare. Deux requÃªtes liraient deux fois le mÃªme index
     * (`idx_business_sales_biz_date`, exactement business_id + declared_at) pour rien.
     *
     * âš  `COALESCE`, parce qu'un SUM sur zÃ©ro ligne rend NULL et non 0: sans lui, une enseigne sans
     * la moindre vente cette semaine remonterait `null`, que `Number(null)` transforme en 0 par
     * accident plutÃ´t que par dÃ©cision - et un `.toLocaleString` sur null aurait plantÃ© la page.
     */
    db
      .select({
        businessId: citadelBusinessSales.businessId,
        dayCents: sql<number>`COALESCE(SUM(CASE WHEN ${citadelBusinessSales.declaredAt} >= ${dayStart} THEN ${citadelBusinessSales.totalCents} ELSE 0 END), 0)`,
        weekCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.totalCents}), 0)`,
        dayCommission: sql<number>`COALESCE(SUM(CASE WHEN ${citadelBusinessSales.declaredAt} >= ${dayStart} THEN ${citadelBusinessSales.commissionCents} ELSE 0 END), 0)`,
        weekCommission: sql<number>`COALESCE(SUM(${citadelBusinessSales.commissionCents}), 0)`,
        dayTickets: sql<number>`COALESCE(SUM(CASE WHEN ${citadelBusinessSales.declaredAt} >= ${dayStart} THEN 1 ELSE 0 END), 0)`,
        weekTickets: sql<number>`COUNT(*)`,
      })
      .from(citadelBusinessSales)
      .where(gte(citadelBusinessSales.declaredAt, weekStart))
      .groupBy(citadelBusinessSales.businessId),
  ]);

  const labels = new Map(jobRows.map((j) => [j.name, j.label ? fixMojibake(j.label) : null]));
  const items = new Map(itemCounts.map((c) => [c.businessId, Number(c.n)]));
  const sales = new Map(money.map((m) => [m.businessId, m]));

  const headcount = new Map<string, number>();
  for (const u of staffCounts) {
    for (const j of [u.job, u.job2]) {
      if (!j || j === UNEMPLOYED) continue;
      headcount.set(j, (headcount.get(j) ?? 0) + 1);
    }
  }

  return rows.map((b) => {
    // MariaDB rend un SUM en DECIMAL, que le pilote livre en CHAÃŽNE: sans Number(), les totaux se
    // concatÃ¨neraient au lieu de s'additionner dÃ¨s qu'une page en ferait la somme.
    const m = sales.get(b.id);
    return {
      id: b.id,
      job: b.job,
      jobLabel: labels.get(b.job) ?? null,
      slug: b.slug,
      name: b.name,
      template: b.template,
      active: b.active,
      items: items.get(b.id) ?? 0,
      employees: headcount.get(b.job) ?? 0,
      declaredTodayCents: Number(m?.dayCents ?? 0),
      declaredWeekCents: Number(m?.weekCents ?? 0),
      commissionTodayCents: Number(m?.dayCommission ?? 0),
      commissionWeekCents: Number(m?.weekCommission ?? 0),
      ticketsToday: Number(m?.dayTickets ?? 0),
      ticketsWeek: Number(m?.weekTickets ?? 0),
    };
  });
}

export type CandidateJob = { name: string; label: string; employees: number };

/**
 * Les mÃ©tiers qui PEUVENT recevoir un portail: tous ceux du jeu, moins `unemployed`, moins ceux qui
 * en ont dÃ©jÃ  un.
 *
 * âš  `unemployed` EST EXCLU ICI ET RE-EXCLU Ã€ L'Ã‰CRITURE. ESX y range tout le monde par dÃ©faut, donc
 * un portail sur ce mÃ©tier serait ouvert au SERVEUR ENTIER, chacun avec le repli jour-un. Le filtrer
 * seulement dans la liste laisserait la faute possible via un POST direct: une liste est de la
 * prÃ©sentation, pas une porte.
 */
export async function listCandidateJobs(): Promise<CandidateJob[]> {
  const [jobRows, taken, holders] = await Promise.all([
    db.select({ name: jobs.name, label: jobs.label }).from(jobs).orderBy(asc(jobs.name)),
    db.select({ job: citadelBusinesses.job }).from(citadelBusinesses),
    db.select({ job: users.job, job2: users.job2 }).from(users),
  ]);

  const used = new Set(taken.map((t) => t.job));
  const headcount = new Map<string, number>();
  for (const u of holders) {
    for (const j of [u.job, u.job2]) {
      if (!j || j === UNEMPLOYED) continue;
      headcount.set(j, (headcount.get(j) ?? 0) + 1);
    }
  }

  return jobRows
    .filter((j) => j.name !== UNEMPLOYED && !used.has(j.name))
    .map((j) => ({
      name: j.name,
      label: j.label ? fixMojibake(j.label) : j.name,
      employees: headcount.get(j.name) ?? 0,
    }));
}

/* â”€â”€ Ce que la console Ã©crit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export type PortalError =
  | "bad_job"
  | "unknown_job"
  | "job_taken"
  | "bad_name"
  | "bad_slug"
  | "slug_taken"
  | "unknown_template"
  | "not_found";

// La rÃ¨gle d'adresse vit dans `./slug`, un module PUR: la console la fait tourner dans le navigateur
// pour prÃ©-remplir le champ pendant la frappe, et ce fichier est `server-only`. Une seule rÃ¨gle, donc
// l'adresse proposÃ©e ne peut pas diffÃ©rer de l'adresse acceptÃ©e.
const validSlug = isValidPortalSlug;

/**
 * OUVRIR UN PORTAIL POUR UN MÃ‰TIER.
 *
 * L'activation reste une dÃ©cision EXPLICITE: il y a ~130 mÃ©tiers, et un mÃ©tier absent de
 * `lifeinvader_businesses` n'a simplement pas de portail. Cette console rend la dÃ©cision cliquable, elle
 * ne la rend pas automatique - rien ici n'ouvre un portail parce qu'un mÃ©tier existe.
 *
 * Les rayons sont MATÃ‰RIALISÃ‰S depuis le modÃ¨le et appartiennent ensuite au commerce: un article
 * dÃ©signe son rayon par son NOM, donc un modÃ¨le qui renommerait un rayon plus tard rendrait
 * orphelins tous les articles de tous les commerces adossÃ©s Ã  lui.
 *
 * `grants` reste NULL exprÃ¨s: `null` veut dire "jamais configurÃ©" et dÃ©clenche le repli jour-un,
 * alors que `{}` voudrait dire "tout retirÃ© Ã  tout le monde". Deux Ã©tats distincts.
 */
export async function createPortal(input: {
  job: string;
  name: string;
  slug?: string;
  template: string;
}): Promise<{ ok: true; id: number; slug: string } | { ok: false; error: PortalError }> {
  const job = input.job.trim();
  const name = input.name.trim();
  if (!job || job === UNEMPLOYED) return { ok: false, error: "bad_job" };
  if (name.length === 0 || name.length > 120) return { ok: false, error: "bad_name" };
  if (!getTemplate(input.template)) return { ok: false, error: "unknown_template" };

  // Le mÃ©tier doit EXISTER en jeu: l'appartenance se lit dans `users.job`, donc un portail sur un
  // mÃ©tier inventÃ© serait une enseigne que personne ne peut jamais voir.
  const [exists] = await db.select({ name: jobs.name }).from(jobs).where(eq(jobs.name, job)).limit(1);
  if (!exists) return { ok: false, error: "unknown_job" };

  const [taken] = await db
    .select({ id: citadelBusinesses.id })
    .from(citadelBusinesses)
    .where(eq(citadelBusinesses.job, job))
    .limit(1);
  if (taken) return { ok: false, error: "job_taken" };

  const slug = (input.slug?.trim() || slugifyPortal(name) || job).slice(0, 80);
  if (!validSlug(slug)) return { ok: false, error: "bad_slug" };
  const [slugTaken] = await db
    .select({ id: citadelBusinesses.id })
    .from(citadelBusinesses)
    .where(eq(citadelBusinesses.slug, slug))
    .limit(1);
  if (slugTaken) return { ok: false, error: "slug_taken" };

  const seed = templateSeed(input.template);
  const res = await db.insert(citadelBusinesses).values({
    job,
    slug,
    name,
    template: input.template,
    palette: seed.palette,
    categories: seed.categories,
  });

  return { ok: true, id: insertedId(res), slug };
}

/**
 * MODIFIER L'IDENTITÃ‰ D'UN PORTAIL: enseigne, adresse, modÃ¨le, ouvert/fermÃ©.
 *
 * âš  LE MÃ‰TIER N'EST PAS MODIFIABLE, et c'est structurel. Le dÃ©placer changerait d'un coup QUI a
 * accÃ¨s au portail, Ã  ses ventes dÃ©clarÃ©es et Ã  ses pointages, sans rien dÃ©placer de ces donnÃ©es:
 * l'historique d'une enseigne resterait attachÃ© Ã  une Ã©quipe qui ne le regarde plus. Fermer le
 * portail et en ouvrir un autre est la manoeuvre honnÃªte.
 *
 * âš  CHANGER L'ADRESSE CASSE LES LIENS DÃ‰JÃ€ PARTAGÃ‰S. C'est pour Ã§a que `slug` est stockÃ© et non
 * calculÃ© depuis l'enseigne: renommer l'enseigne ne dÃ©place personne. La console le permet quand
 * mÃªme (l'adresse est parfois franchement mauvaise), mais l'interface le dit.
 *
 * âš  `active = false` N'EST PAS UNE SUPPRESSION, et rien ici ne supprime. `getBusinessAccess` filtre
 * sur `active`, donc le portail disparaÃ®t pour ses employÃ©s, pendant que le catalogue, les ventes
 * dÃ©clarÃ©es et les pointages restent en place et redeviennent lisibles Ã  la rÃ©ouverture. Une
 * suppression, elle, orphelinerait des lignes de vente qui portent des montants rÃ©ellement encaissÃ©s.
 */
export async function updatePortal(
  id: number,
  input: { name?: string; slug?: string; template?: string; active?: boolean },
): Promise<{ ok: true } | { ok: false; error: PortalError }> {
  const [row] = await db.select().from(citadelBusinesses).where(eq(citadelBusinesses.id, id)).limit(1);
  if (!row) return { ok: false, error: "not_found" };

  const patch: Partial<typeof citadelBusinesses.$inferInsert> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120) return { ok: false, error: "bad_name" };
    patch.name = name;
  }

  if (input.slug !== undefined) {
    const slug = input.slug.trim().slice(0, 80);
    if (!validSlug(slug)) return { ok: false, error: "bad_slug" };
    if (slug !== row.slug) {
      const [taken] = await db
        .select({ id: citadelBusinesses.id })
        .from(citadelBusinesses)
        .where(eq(citadelBusinesses.slug, slug))
        .limit(1);
      if (taken) return { ok: false, error: "slug_taken" };
      patch.slug = slug;
    }
  }

  if (input.template !== undefined && input.template !== row.template) {
    if (!getTemplate(input.template)) return { ok: false, error: "unknown_template" };
    patch.template = input.template;
    // âš  LA PALETTE N'EST PAS REPRISE DU NOUVEAU MODÃˆLE. Elle est matÃ©rialisÃ©e sur la ligne du
    // commerce, donc changer de modÃ¨le changerait ses MODULES sans changer ses couleurs, ce qui
    // surprend. Repasser la palette du modÃ¨le est une action sÃ©parÃ©e et explicite ci-dessous, parce
    // qu'elle Ã©crase un choix que le patron a peut-Ãªtre fait lui-mÃªme depuis ses RÃ©glages.
  }

  if (input.active !== undefined) patch.active = input.active;

  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(citadelBusinesses).set(patch).where(eq(citadelBusinesses.id, id));
  return { ok: true };
}

/**
 * Repasser la palette ET les rayons du modÃ¨le sur un portail.
 *
 * âš  REFUSE si un article utilise un rayon que le modÃ¨le ne porte pas: l'article existerait toujours
 * en base mais ne s'afficherait plus nulle part, la caisse groupant par rayon dÃ©clarÃ©. MÃªme garde
 * que `setCategories`, pour la mÃªme raison, et c'est pour Ã§a que ce n'est pas un effet de bord du
 * changement de modÃ¨le.
 */
export async function resetPortalLook(
  id: number,
): Promise<{ ok: true } | { ok: false; error: "not_found" | "in_use"; detail?: string }> {
  const [row] = await db.select().from(citadelBusinesses).where(eq(citadelBusinesses.id, id)).limit(1);
  if (!row) return { ok: false, error: "not_found" };

  const seed = templateSeed(row.template);
  const keys = new Set(seed.categories.map((c) => c.key));

  const used = await db
    .selectDistinct({ category: citadelBusinessItems.category })
    .from(citadelBusinessItems)
    .where(eq(citadelBusinessItems.businessId, id));
  const orphaned = used.map((u) => u.category).filter((c) => !keys.has(c));
  if (orphaned.length > 0) return { ok: false, error: "in_use", detail: orphaned.join(", ") };

  await db
    .update(citadelBusinesses)
    .set({ palette: seed.palette, categories: seed.categories })
    .where(eq(citadelBusinesses.id, id));
  return { ok: true };
}

/** Les modÃ¨les proposÃ©s par la console. Une seule source: `templates.ts`. */
export function portalTemplates(): { name: string; label: string }[] {
  return BUSINESS_TEMPLATES.map((t) => ({ name: t.name, label: t.label }));
}
