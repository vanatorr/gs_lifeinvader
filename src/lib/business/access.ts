/**
 * RÉSOLVEUR D'ACCÈS DU PORTAIL ENTREPRISES.
 *
 * Le pendant, côté joueurs, de lib/cad/access.ts. Même discipline, deux différences de fond:
 *
 *   1. L'APPARTENANCE remplace la nomination. Sur le CAD, un agent est rattaché à une agence par
 *      configuration. Ici, on est employé d'un commerce parce que `users.job` le dit, et gérant
 *      parce que son grade porte le nom `boss` dans `job_grades`. Rien à tenir à jour en double: le
 *      jeu reste la source de vérité de qui travaille où.
 *
 *   2. TROIS PALIERS, pas deux. Le CAD répond oui/non à "en service". Ici la question posée par le
 *      propriétaire était plus fine: certaines choses toujours, d'autres en jeu, d'autres en
 *      service seulement.
 *
 *        SESSION  toujours. Ses propres ventes, ses propres heures, la carte des prix.
 *                 On consulte sa paie depuis son téléphone dans le bus.
 *        INGAME   le personnage est connecté au serveur. Lire les CHIFFRES DES AUTRES est un acte
 *                 in-character: on ne consulte pas le rendement de ses collègues depuis son lit.
 *        SERVICE  pointé. Toute ÉCRITURE. Déclarer une vente, changer un prix, corriger un pointage.
 *
 * ⚠ LE NAVIGATEUR N'AFFIRME JAMAIS SON PALIER. `ingame` vient de citadel_online et `service` d'une
 * ligne de pointage ouverte, toutes deux écrites par le JEU. Un client qui prétend être en service
 * ne l'est pas: il n'existe aucun chemin par lequel il puisse le déclarer.
 *
 * ⚠ FAIL-CLOSED PAR EXPIRATION. Un pointage dont le heartbeat a vieilli n'est plus un pointage. Un
 * serveur qui tombe laisse donc tous les droits d'écriture s'éteindre d'eux-mêmes, plutôt que de
 * laisser quelqu'un écrire indéfiniment depuis un service jamais refermé. Même raison que
 * cad_presence.expires_at.
 *
 * ⚠ ON NE VOIT QUE LES MÉTIERS QU'ON A EN JEU, et ce fichier est le seul endroit qui en décide.
 * Un commerce n'apparaît que si un personnage du compte porte SON métier dans `users.job` OU dans
 * `users.job2` à l'instant de la lecture (les DEUX emplacements ESX, voir `employmentsFor`: n'en
 * lire qu'un ferme le portail à la moitié des employés).
 * Il n'existe aucune liste d'appartenance côté panel, donc rien à
 * synchroniser et rien qui puisse diverger: se faire virer en jeu ferme le commerce au rafraîchis-
 * sement suivant, et une promotion ouvre les droits du nouveau grade sans la moindre saisie.
 *   → `lifeinvader_businesses` ne doit être lue QUE par `getBusinessAccess`. Une page qui listerait
 *     les commerces elle-même contournerait cette règle sans en avoir l'air, et afficherait des
 *     enseignes où la personne ne travaille pas. Tout part d'ici.
 *   → Un compte à plusieurs personnages voit les commerces de CHACUN d'eux, chaque ligne portant
 *     le personnage qui l'ouvre (`employeeName`) et SON palier à lui. Le palier reste per-
 *     sonnage par personnage: être en service sur l'un ne donne rien sur l'autre.
 *
 * ⚠ À REVÉRIFIER À CHAQUE MUTATION. Une page n'est pas une frontière de sécurité: les Server
 * Actions sont des POST publics à l'URL de la page. Voir `requireBusiness`.
 */
import { cache } from "react";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  citadelBusinesses,
  citadelBusinessShifts,
  citadelOnline,
} from "@/lib/db/schema/citadel";
import { jobGrades, users } from "@/lib/db/schema/game";
import { UNEMPLOYED } from "@/lib/data/factions";
import { fixMojibake } from "@/lib/text/fixMojibake";
import { licensesForAccount, type Identity } from "@/lib/auth/identity";
import { isNetworkAdmin } from "./network";
import {
  CAP_TIER,
  CAPABILITY_CATALOG,
  FALLBACK_CAPS,
  type Capability,
} from "./capabilities";
import { moduleOfCapability, resolveModules } from "./modules";
import { rateFor, rateForGrade, resolveCommission, type CommissionMode } from "./commission";
import {
  FALLBACK_PALETTE,
  getTemplate,
  templateCommission,
  templateGrid,
  type ThemedPalette,
} from "./templates";

/**
 * Au-delà de ce délai sans heartbeat, un pointage ouvert n'ouvre plus aucun droit.
 * Volontairement plus long que la cadence d'écriture du jeu: un tick manqué ne doit pas retirer
 * la caisse des mains de quelqu'un en plein service.
 */
const SHIFT_STALE_MS = 5 * 60_000;

/** Le grade patron est celui dont le NOM vaut `boss`, jamais un numéro de grade. */
const BOSS_GRADE_NAME = "boss";

export type BusinessTier = "session" | "ingame" | "service";

export type BusinessAccess = {
  businessId: number;
  job: string;
  slug: string;
  name: string;
  template: string;
  moduleOverrides: Record<string, boolean>;
  /** L'état EFFECTIF des modules: essentiels, puis modèle, puis écarts. Voir resolveModules. */
  modules: Record<string, boolean>;
  /**
   * La palette de l'enseigne, DEUX THEMES, celle du commerce si elle existe sinon celle du modèle.
   * Les clés sont des noms de variables CSS sans le `--`, consommées telles quelles par la page.
   */
  palette: ThemedPalette;
  /** Les rayons du catalogue, dans l'ordre d'affichage. `tone` désigne une entrée de la palette. */
  categories: { key: string; label: string; tone: number; icon?: string }[];
  /**
   * LA PART EMPLOYÉ, RÉSOLUE POUR CETTE PERSONNE-CI.
   *
   * ⚠ `bps` EST LE TAUX DE CE PERSONNAGE, pas celui du commerce: son accord s'il en a un, sinon le
   * taux général (voir `rateFor`). C'est ce qui fait qu'une vente déclarée et l'aperçu affiché au
   * moment de la déclarer parlent du même chiffre, sans que la caisse ait à connaître la table des
   * accords - qu'elle n'a d'ailleurs aucune raison de recevoir, puisqu'elle dirait à chaque employé
   * ce que touchent ses collègues.
   *
   * ⚠ CE N'EST PAS LA POLITIQUE COMPLÈTE. L'écran qui la RÈGLE lit la colonne `commission` du
   * commerce directement, exactement comme la page Réglages lit `grants` (que ce résolveur n'expose
   * pas non plus): un résolveur d'accès rend ce qui s'applique à quelqu'un, jamais le tableau
   * complet des décisions prises sur les autres.
   */
  commission: { mode: CommissionMode; bps: number; vehicleBps: number };
  /**
   * LE PLAFOND D'UNE LIGNE SAISIE À LA MAIN, en centimes, ou `null` si ce commerce n'est pas en
   * saisie libre (c'est-à-dire: presque tous - seul un modèle déclarant une grille l'est).
   *
   * ⚠ RÉSOLU ICI ET NULLE PART AILLEURS, comme tout le reste de cet objet. `declareFreeSale` le lit
   * d'ici, jamais de la requête: c'est le seul garde-fou du mode où le navigateur fixe les montants,
   * donc un plafond que le client pourrait envoyer ne serait pas un plafond.
   *
   * ⚠ `null` NE VEUT PAS DIRE "SANS LIMITE". `declareFreeSale` refuse la vente quand il ne peut pas
   * résoudre un plafond - un commerce ordinaire n'a rien à faire sur ce chemin de toute façon.
   */
  lineMaxCents: number | null;
  /** Le personnage employé ici (hex nu) et son nom RP au moment de la lecture. */
  identifier: string;
  employeeName: string;
  grade: number;
  /** Le libellé du grade tel qu'il est écrit en jeu. Affichage seulement, jamais une décision. */
  gradeName: string;
  /** Grade nommé `boss`. Détient TOUT, implicitement et sans aucune ligne en base. */
  isBoss: boolean;
  /**
   * Les capacités que le GRADE de cette personne détient dans ce commerce.
   * Patron: toutes. Sinon celles accordées à son grade, ou le repli jour-un si le commerce n'a
   * encore rien distribué. Ne dit rien du palier de présence, que `businessCan` ajoute par-dessus.
   */
  capabilities: Set<string>;
  tier: BusinessTier;
  /** Pointage ouvert et frais. `tier === "service"` en découle. */
  onDuty: boolean;
  shiftStartedAt: Date | null;
  /**
   * ACCÈS RÉSEAU: cette personne n'est pas employée ici, elle administre le portail (Fondateur ou
   * direction MIRAGE, voir lib/business/network.ts).
   *
   * ⚠ CE DRAPEAU LÈVE LE PALIER DE PRÉSENCE, PAS LE RESTE. Un administrateur réseau garde son palier
   * RÉEL (`tier`, `onDuty`): on ne lui invente pas un service qu'il n'a pas pris, parce que la barre
   * du portail affiche ce palier et qu'une présence inventée est exactement ce que ce panel s'interdit.
   * Ce que le drapeau fait, c'est dispenser de la règle "toute écriture exige d'être pointé" - une
   * règle de JEU DE RÔLE, qui modélise le fait d'être derrière son comptoir, et qui n'a aucun sens
   * pour une intervention de maintenance sur l'enseigne de quelqu'un d'autre.
   *
   * ⚠ IL N'EST JAMAIS LU DEPUIS LE NAVIGATEUR. Il est calculé côté serveur à chaque résolution, à
   * partir de l'identité de session et du grade en jeu. Rien de ce que le client envoie ne peut le
   * poser.
   */
  networkAdmin: boolean;
};

type Employment = {
  identifier: string;
  name: string;
  job: string;
  grade: number;
  /** Le libellé du grade en jeu. Affichage seulement, jamais une décision. */
  gradeName: string;
  /** Le grade porte le NOM `boss`. Détient tout, implicitement. */
  isBoss: boolean;
  /** Lequel des deux emplacements ESX porte ce métier. Diagnostic seulement, jamais une décision. */
  slot: "job" | "job2";
};

/**
 * QUI TRAVAILLE OÙ, ET À QUEL GRADE.
 *
 * ⚠⚠ DEUX EMPLACEMENTS DE MÉTIER, ET EN OUBLIER UN FERME LE PORTAIL À LA MOITIÉ DES GENS. ESX donne
 * à chaque personnage `job`/`job_grade` ET `job2`/`job2_grade`, et sur ce serveur un employé porte
 * son commerce indifféremment dans l'un ou dans l'autre. Cette fonction ne lisait que `job`, donc
 * quelqu'un dont le commerce vivait en `job2` n'avait AUCUN portail: pas un droit manquant, pas un
 * message, pas une enseigne barrée - la page d'accueil lui disait qu'il ne travaillait nulle part.
 * Signalé par le propriétaire ("the lifeinvader website doesnt detect when jobs are in job2").
 *   → `roster.ts` couvrait déjà les deux emplacements, et son en-tête DÉSIGNAIT NOMMÉMENT ce
 *     fichier comme ne le faisant pas. Un commerce pouvait donc lister sur sa page Équipe un
 *     employé à qui le portail refusait la porte. La correction remet les deux du même côté.
 *
 * ⚠ UNE PERSONNE PEUT AVOIR DEUX EMPLOIS, DONC DEUX LIGNES. C'est tout l'intérêt: deux commerces
 * ouverts, et le sélecteur d'entreprise permet de passer de l'un à l'autre. La clé d'une ligne est
 * donc le COUPLE (personnage, emplacement), jamais le personnage seul.
 *
 * ⚠ LE MÊME MÉTIER DANS LES DEUX EMPLACEMENTS NE COMPTE QU'UNE FOIS. Ce serait deux fois le même
 * commerce dans le sélecteur, avec deux grades possibles et aucune règle pour dire lequel gagne.
 * `job` l'emporte, comme dans `roster.ts`, pour que les deux modules répondent la même chose.
 *
 * ⚠ LE LIBELLÉ DE GRADE EST RÉSOLU EN MÉMOIRE, PAS PAR UNE JOINTURE, et c'est le raisonnement
 * qu'écrit déjà `roster.ts`. La jointure d'origine s'écrivait sur `users.job` uniquement; la
 * dédoubler pour `job2` demanderait une seconde jointure aliasée ou un `CASE` dans la condition,
 * deux façons compliquées de faire ce qu'une `Map` fait ici. Les échelles concernées sont celles
 * des quelques métiers que ce compte porte, pas celles du serveur.
 *
 * ⚠ `boss` est un NOM de grade, jamais un indice. Même règle que lib/data/gameCommands.ts.
 *
 * ⚠ `unemployed` est EXCLU des DEUX emplacements, et ce n'est pas une coquetterie: ESX y range tout
 * le monde par défaut, donc un commerce enregistré sur ce métier serait visible par LE SERVEUR
 * ENTIER, avec le repli jour-un qui va avec. Filtrer ici rend la faute impossible à commettre depuis
 * la configuration, plutôt que de compter sur personne pour ne jamais la taper.
 */
async function employmentsFor(licenses: string[]): Promise<Employment[]> {
  if (licenses.length === 0) return [];
  const rows = await db
    .select({
      identifier: users.identifier,
      firstname: users.firstname,
      lastname: users.lastname,
      job: users.job,
      grade: users.jobGrade,
      job2: users.job2,
      grade2: users.job2Grade,
    })
    .from(users)
    .where(inArray(users.identifier, licenses));

  /** Un emploi retenu, avant que son grade ne soit nommé. */
  type Slotted = { identifier: string; name: string; job: string; grade: number; slot: "job" | "job2" };
  const held: Slotted[] = [];
  for (const r of rows) {
    const name = fixMojibake(`${r.firstname ?? ""} ${r.lastname ?? ""}`.trim()) || "Employé";
    const seen = new Set<string>();
    const slots: { job: string | null; grade: number | null; slot: "job" | "job2" }[] = [
      { job: r.job, grade: r.grade, slot: "job" },
      { job: r.job2, grade: r.grade2, slot: "job2" },
    ];
    for (const s of slots) {
      if (!s.job || s.job === UNEMPLOYED || seen.has(s.job)) continue;
      seen.add(s.job);
      held.push({ identifier: r.identifier, name, job: s.job, grade: s.grade ?? 0, slot: s.slot });
    }
  }
  if (held.length === 0) return [];

  // Les échelles des seuls métiers effectivement portés. `job_grades` n'a pas de ligne pour chaque
  // grade de chaque métier (ladder retouchée, seed incomplet): un grade non trouvé reste un emploi
  // au grade non nommé, jamais un employé qui s'évapore du portail. Même repli que l'ancien
  // `leftJoin`, pour la même raison.
  const ladder = await db
    .select({ jobName: jobGrades.jobName, grade: jobGrades.grade, name: jobGrades.name, label: jobGrades.label })
    .from(jobGrades)
    .where(inArray(jobGrades.jobName, [...new Set(held.map((h) => h.job))]));

  const byRung = new Map(ladder.map((g) => [`${g.jobName}|${g.grade}`, g]));

  return held.map((h) => {
    const rung = byRung.get(`${h.job}|${h.grade}`);
    return {
      identifier: h.identifier,
      name: h.name,
      job: h.job,
      grade: h.grade,
      gradeName: fixMojibake(rung?.label || rung?.name || `Grade ${h.grade}`),
      isBoss: (rung?.name ?? "").toLowerCase() === BOSS_GRADE_NAME,
      slot: h.slot,
    };
  });
}

/**
 * Le personnage est-il connecté au serveur en ce moment.
 *
 * La colonne est `license` (hex nu, qui joint users.identifier) et non `identifier`: sur
 * citadel_online la clé primaire est le SLOT FiveM, pas la personne, puisqu'une même personne
 * occupe un slot différent à chaque connexion.
 */
async function onlineIdentifiers(licenses: string[]): Promise<Set<string>> {
  if (licenses.length === 0) return new Set();
  const rows = await db
    .select({ license: citadelOnline.license })
    .from(citadelOnline)
    .where(inArray(citadelOnline.license, licenses));
  return new Set(rows.map((r) => r.license).filter((v): v is string => Boolean(v)));
}

/**
 * Les pointages ouverts et FRAIS de tous ces personnages, indexés par `identifier|job`.
 *
 * En une seule requête, et pas une par commerce: le résolveur tourne à CHAQUE rendu et à CHAQUE
 * mutation, donc une requête par ligne se paie sur tout le portail, pas seulement ici.
 */
async function openShiftsFor(identifiers: string[]): Promise<Map<string, ShiftRow>> {
  const out = new Map<string, ShiftRow>();
  if (identifiers.length === 0) return out;
  const fresh = new Date(Date.now() - SHIFT_STALE_MS);
  const rows = await db
    .select({
      id: citadelBusinessShifts.id,
      identifier: citadelBusinessShifts.identifier,
      job: citadelBusinessShifts.job,
      startedAt: citadelBusinessShifts.startedAt,
    })
    .from(citadelBusinessShifts)
    .where(
      and(
        inArray(citadelBusinessShifts.identifier, identifiers),
        isNull(citadelBusinessShifts.endedAt),
        gt(citadelBusinessShifts.heartbeatAt, fresh),
      ),
    )
    .orderBy(desc(citadelBusinessShifts.heartbeatAt));

  // Trié par heartbeat décroissant, donc le premier vu pour une clé est le plus frais.
  for (const r of rows) {
    const key = `${r.identifier}|${r.job}`;
    if (!out.has(key)) out.set(key, { id: r.id, startedAt: r.startedAt });
  }
  return out;
}

type ShiftRow = { id: number; startedAt: Date | null };

/**
 * La part employé applicable à UN personnage dans UN commerce.
 *
 * Deux replis empilés, et l'ordre est le même que partout ailleurs dans ce portail: ce que le
 * commerce a écrit, sinon ce que propose son modèle. `rateFor` ajoute le troisième, le plus fin:
 * l'accord de la personne, sinon le taux général.
 */
function commissionFor(
  stored: unknown,
  template: string,
  identifier: string,
  grade: number,
): { mode: CommissionMode; bps: number; vehicleBps: number } {
  const policy = resolveCommission(stored, templateCommission(template));
  return {
    mode: policy.mode,
    bps: rateFor(policy, identifier),
    // ⚠ `policy.vehicleProfitBps` N'EST PLUS EXPOSE ICI, ET NE DOIT PAS Y REVENIR (2026-08-27). Il
    // estimait une marge faute de connaitre le cout d'une voiture; le cout se lit maintenant dans le
    // catalogue du jeu (fleet.ts `vehicleCostCents`). Le republier inviterait un appelant a
    // re-multiplier le prix par une marge devinee, ce qui est exactement le bug corrige.
    vehicleBps: rateForGrade(policy, grade),
  };
}

/**
 * Le plafond d'une ligne saisie à la main: celui du commerce, sinon celui de départ de son modèle.
 *
 * ⚠ Rend `null` dès que le modèle ne déclare pas de grille, quelle que soit la valeur en base. Une
 * colonne remplie sur un bar (par une bascule de modèle, ou une main dans la base) ne doit pas
 * ouvrir la saisie libre sur un commerce dont la caisse n'en a pas.
 *
 * ⚠ Une valeur stockée aberrante (négative, zéro, non entière) est traitée comme absente et retombe
 * sur le modèle, plutôt que de bloquer toutes les ventes du salon sur un `<= 0` refusé plus loin.
 */
function lineMaxFor(stored: number | null | undefined, template: string): number | null {
  const grid = templateGrid(template);
  if (!grid) return null;
  const v = Number(stored);
  return Number.isInteger(v) && v > 0 ? v : grid.maxLineCents;
}

/**
 * Tous les commerces auxquels ce compte a accès, dans l'ordre alphabétique de l'enseigne.
 *
 * ⚠ ENVELOPPÉ DANS React `cache()`, STRICTEMENT PAR REQUÊTE - même règle et même raisonnement que
 * resolveSessionIdentity dans lib/auth/session.ts: ne JAMAIS remplacer ceci par un cache au niveau du
 * module ou par `globalThis`, sous peine de servir les commerces d'un joueur à la requête d'un autre.
 * Peu coûteux à ajouter ici précisément parce que `identity` est déjà l'objet mémoïsé que
 * resolveSessionIdentity() rend pour cette requête - les appels répétés avec cette même référence
 * retombent sur le cache au lieu de relire l'effectif ESX et les pointages depuis zéro.
 */
export const getBusinessAccess = cache(async (identity: Identity): Promise<BusinessAccess[]> => {
  const licenses = await licensesForAccount(identity.accountId);
  const employments = await employmentsFor(licenses);
  if (employments.length === 0) return [];

  const enabled = await db
    .select()
    .from(citadelBusinesses)
    .where(
      and(
        eq(citadelBusinesses.active, true),
        inArray(
          citadelBusinesses.job,
          employments.map((e) => e.job),
        ),
      ),
    );
  if (enabled.length === 0) return [];

  const [online, shifts] = await Promise.all([
    onlineIdentifiers(licenses),
    openShiftsFor(employments.map((e) => e.identifier)),
  ]);

  const out: BusinessAccess[] = [];
  for (const biz of enabled) {
    /**
     * UN COMMERCE, UNE LIGNE, MÊME SI PLUSIEURS PERSONNAGES DU COMPTE Y TRAVAILLENT: on retient
     * celui qui est LE PLUS PRÉSENT, pas le premier venu.
     *
     * ⚠ C'était un `.find`, donc l'ordre de la table décidait. Un compte dont un personnage est en
     * service au commerce pendant qu'un autre y est employé hors ligne pouvait donc lire "Hors
     * ligne" et trouver sa caisse barrée alors qu'il était bel et bien en service - le palier
     * appartient au PERSONNAGE, et en tirer un au hasard revient à tirer le palier au hasard.
     * Trier ne coûte rien (une poignée de lignes) et rend la lecture déterministe.
     */
    const candidates = employments
      .filter((e) => e.job === biz.job)
      .map((e) => {
        const isOnline = online.has(e.identifier);
        const shift = isOnline ? (shifts.get(`${e.identifier}|${biz.job}`) ?? null) : null;
        return { emp: e, isOnline, shift };
      })
      .sort(
        (a, b) =>
          Number(Boolean(b.shift)) - Number(Boolean(a.shift)) ||
          Number(b.isOnline) - Number(a.isOnline) ||
          Number(b.emp.isBoss) - Number(a.emp.isBoss) ||
          b.emp.grade - a.emp.grade,
      );
    const best = candidates[0];
    if (!best) continue;
    const { emp, isOnline, shift } = best;

    const tier: BusinessTier = shift ? "service" : isOnline ? "ingame" : "session";

    const tpl = getTemplate(biz.template);
    // Le patron reçoit tout SANS rien de stocké, ce qui rend la révocation impossible à écrire.
    // `null` (jamais configuré) et `{}` (tout retiré) sont DEUX états distincts: seul le premier
    // déclenche le repli jour-un, le second est une décision du patron qu'on respecte.
    const capabilities = emp.isBoss
      ? new Set<string>(CAPABILITY_CATALOG.map((c) => c.code))
      : biz.grants
        ? new Set<string>(biz.grants[String(emp.grade)] ?? [])
        : new Set<string>(FALLBACK_CAPS);

    out.push({
      businessId: biz.id,
      job: biz.job,
      slug: biz.slug,
      name: biz.name,
      template: biz.template,
      moduleOverrides: biz.moduleOverrides ?? {},
      modules: resolveModules(tpl?.modules, biz.moduleOverrides),
      // La palette du commerce l'emporte ENTIÈREMENT sur celle du modèle, sans fusion clé par clé:
      // une palette à moitié héritée produit des paires de couleurs que personne n'a choisies.
      palette: biz.palette ?? tpl?.palette ?? FALLBACK_PALETTE,
      categories: biz.categories ?? tpl?.categories ?? [],
      commission: commissionFor(biz.commission, biz.template, emp.identifier, emp.grade),
      lineMaxCents: lineMaxFor(biz.freeLineMaxCents, biz.template),
      identifier: emp.identifier,
      employeeName: emp.name,
      grade: emp.grade,
      gradeName: emp.gradeName,
      isBoss: emp.isBoss,
      capabilities,
      tier,
      onDuty: Boolean(shift),
      shiftStartedAt: shift?.startedAt ?? null,
      networkAdmin: false,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
});

/**
 * UN COMMERCE OÙ L'ON NE TRAVAILLE PAS, ouvert au titre de l'administration du réseau.
 *
 * ⚠ CETTE FONCTION EST LA SEULE FISSURE DANS LA RÈGLE "on ne voit que les métiers qu'on a en jeu",
 * et elle est volontairement étroite: elle exige `isNetworkAdmin`, elle ne s'appelle QUE depuis
 * `getBusinessBySlug` en dernier recours, et elle ne rend jamais de LISTE. C'est ce qui fait que le
 * sélecteur d'entreprise et la barre latérale d'un administrateur montrent ses propres commerces et
 * pas les cent autres: on ouvre une enseigne nommément, on ne se promène pas dedans.
 *
 * ⚠ ON N'INVENTE NI PERSONNAGE NI SERVICE. L'accès rendu porte le palier RÉEL de la personne
 * (`session` par défaut, `ingame` si un de ses personnages est connecté) et `onDuty: false`. Le nom
 * d'employé est celui de son identité de panel, jamais un personnage du commerce visité. C'est
 * `businessCan` qui, en voyant `networkAdmin`, dispense de la règle de présence - et rien d'autre.
 */
export async function getBusinessAsNetworkAdmin(
  identity: Identity,
  slug: string,
): Promise<BusinessAccess | null> {
  if (!(await isNetworkAdmin(identity))) return null;

  const [biz] = await db
    .select()
    .from(citadelBusinesses)
    .where(and(eq(citadelBusinesses.slug, slug), eq(citadelBusinesses.active, true)))
    .limit(1);
  if (!biz) return null;

  const licenses = await licensesForAccount(identity.accountId);
  const online = await onlineIdentifiers(licenses);
  const tpl = getTemplate(biz.template);

  return {
    businessId: biz.id,
    job: biz.job,
    slug: biz.slug,
    name: biz.name,
    template: biz.template,
    moduleOverrides: biz.moduleOverrides ?? {},
    modules: resolveModules(tpl?.modules, biz.moduleOverrides),
    palette: biz.palette ?? tpl?.palette ?? FALLBACK_PALETTE,
    categories: biz.categories ?? tpl?.categories ?? [],
    // ⚠ Le taux GÉNÉRAL du commerce, jamais un accord personnel: `identifier` est vide ici (voir
    // juste en dessous), donc `rateFor` ne peut trouver personne dans la table des accords et rend
    // le taux par défaut. C'est le bon chiffre pour ce que cet accès sert à faire - lire et régler
    // l'enseigne de quelqu'un d'autre - et il n'y a personne à payer sous cet accès.
    commission: commissionFor(biz.commission, biz.template, "", -1),
    lineMaxCents: lineMaxFor(biz.freeLineMaxCents, biz.template),
    // Pas d'identifiant de personnage: on ne travaille pas ici. Une chaîne vide plutôt qu'un
    // identifiant emprunté, pour qu'une vente déclarée sous cet accès soit impossible à confondre
    // avec celle d'un employé - et `sale.declare` reste de toute façon derrière le catalogue de
    // capacités, que l'interface de caisse n'offre pas dans cet état.
    identifier: "",
    employeeName: identity.displayName,
    grade: -1,
    gradeName: "Réseau",
    // ⚠ `isBoss` reste FAUX. Il sert à REMPLIR le jeu de capacités, une fois, et le remplissage est
    // fait juste en dessous. Le mettre à vrai ferait mentir tout code qui le lirait pour dire "le
    // patron de cette enseigne", ce que le portail affiche par endroits.
    isBoss: false,
    capabilities: new Set<string>(CAPABILITY_CATALOG.map((c) => c.code)),
    tier: online.size > 0 ? "ingame" : "session",
    onDuty: false,
    shiftStartedAt: null,
    networkAdmin: true,
  };
}

/**
 * Un commerce précis, par slug d'URL, ou null si ce compte n'y a rien à faire.
 *
 * L'appartenance D'ABORD: un administrateur réseau qui travaille réellement dans ce commerce y entre
 * comme employé, avec son grade, son personnage et son palier. L'accès réseau n'est qu'un dernier
 * recours, sinon la direction de MIRAGE cesserait d'être la direction de MIRAGE sur sa propre page.
 */
export async function getBusinessBySlug(
  identity: Identity,
  slug: string,
): Promise<BusinessAccess | null> {
  const all = await getBusinessAccess(identity);
  const mine = all.find((b) => b.slug === slug);
  if (mine) return mine;
  return getBusinessAsNetworkAdmin(identity, slug);
}

const TIER_RANK: Record<BusinessTier, number> = { session: 0, ingame: 1, service: 2 };

/** Le palier atteint couvre-t-il le palier demandé. */
export function hasTier(access: BusinessAccess, needed: BusinessTier): boolean {
  return TIER_RANK[access.tier] >= TIER_RANK[needed];
}

/**
 * LA porte, et il n'y en a qu'une (même discipline que `cadCan`).
 *
 * Trois conditions qui se CUMULENT et ne se remplacent pas:
 *   0. le MODULE qui porte cette capacité est allumé pour ce commerce;
 *   1. le GRADE EN JEU détient la capacité (le patron les détient toutes);
 *   2. le PALIER DE PRÉSENCE exigé par cette capacité est atteint.
 *
 * La condition 0 est ce qui fait qu'éteindre "pointage" ferme vraiment la correction d'heures, au
 * lieu de simplement retirer un onglet pendant que l'action reste joignable en POST direct. Elle
 * passe AVANT le grade, parce qu'un module éteint n'est pas un refus de droit: la fonctionnalité
 * n'existe pas pour ce commerce, et même le patron n'y a pas accès.
 *
 * Le second n'est pas une redite du premier. Un patron hors ligne détient `team.read` et ne peut
 * toujours pas s'en servir, parce que consulter le rendement de ses employés est un acte
 * in-character. Et toute écriture exige d'être pointé, patron compris.
 *
 * ⚠ Aucune page ne doit tester `isBoss` pour décider d'afficher quelque chose. `isBoss` sert à
 * remplir le jeu de capacités, une fois, ici. Le tester ailleurs recréerait une hiérarchie en dur
 * dans l'interface, alors que c'est précisément ce que le patron distribue par grade.
 *
 * ⚠ LE PALIER, ET LUI SEUL, SAUTE POUR UN ACCÈS RÉSEAU. Les conditions 0 et 1 s'appliquent quand
 * même: un module éteint reste éteint pour tout le monde, y compris l'administrateur, parce que la
 * fonctionnalité n'existe pas pour ce commerce. Ce qui saute est la règle de PRÉSENCE, qui modélise
 * le fait de se tenir derrière son comptoir et ne veut rien dire pour une intervention sur
 * l'enseigne d'autrui. On ne le fait pas en gonflant `tier`, ce qui ferait afficher "En service" à
 * quelqu'un qui ne l'est pas: la donnée reste vraie, c'est la règle qui est levée.
 */
export function businessCan(access: BusinessAccess, cap: Capability): boolean {
  const mod = moduleOfCapability(cap);
  if (mod && access.modules[mod] === false) return false;
  if (!access.capabilities.has(cap)) return false;
  if (access.networkAdmin) return true;
  return hasTier(access, CAP_TIER[cap]);
}

/** Les capacités utilisables MAINTENANT, palier de présence compris. Pour peindre un menu. */
export function usableCapabilities(access: BusinessAccess): Capability[] {
  return CAPABILITY_CATALOG.map((c) => c.code).filter((c) => businessCan(access, c));
}

/**
 * Porte d'ÉCRITURE, à rappeler DANS CHAQUE Server Action.
 *
 * Résout l'accès à nouveau au moment de la mutation: une valeur calculée au rendu de la page ne
 * prouve rien, la page ayant pu rester ouverte pendant que la personne quittait son service.
 * Renvoie null pour "pas le droit", que l'appelant transforme en erreur.
 *
 * La capacité est NOMMÉE par l'appelant, jamais devinée: `requireBusiness(id, slug,
 * CAP.CATALOGUE_WRITE)`. Un booléen `bossOnly` aurait figé la hiérarchie dans le code, alors que
 * c'est exactement ce que le patron doit pouvoir redistribuer par grade depuis les Réglages.
 *
 * Sert aussi aux LECTURES sensibles, pour la même raison: une page n'est pas une frontière.
 */
export async function requireBusiness(
  identity: Identity,
  slug: string,
  cap: Capability,
): Promise<BusinessAccess | null> {
  const access = await getBusinessBySlug(identity, slug);
  if (!access) return null;
  if (!businessCan(access, cap)) return null;
  return access;
}
