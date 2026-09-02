/**
 * LE CATALOGUE ET LES RÉGLAGES: tout ce que la direction d'un commerce écrit.
 *
 * Tout ici suppose que l'appelant a franchi `requireBusiness(identity, slug, CAP.…)` avec la bonne
 * capacité. Ces fonctions ne revérifient pas le droit, mais elles cloisonnent TOUJOURS par
 * `business_id` DANS la requête: un contrôle qui vit dans l'appelant est un contrôle qu'un futur
 * appelant oubliera.
 */
import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { citadelBusinesses, citadelBusinessItems } from "@/lib/db/schema/citadel";
import { jobGrades } from "@/lib/db/schema/game";
import { insertedId } from "@/lib/db/insertId";
import { CAPABILITY_CATALOG } from "./capabilities";
import { resolveCommission, type CommissionPolicy } from "./commission";
import { BUSINESS_MODULES } from "./modules";
import { isSafePaletteEntry } from "./theme";
import { templateCommission, type BusinessCategory, type ThemedPalette } from "./templates";

/* ── Articles ─────────────────────────────────────────────────────────────────────────────────── */

export type ItemRow = {
  id: number;
  label: string;
  category: string;
  priceCents: number;
  commissionCents: number;
  artKey: string | null;
  imageUrl: string | null;
  active: boolean;
  sort: number;
};

export async function listItems(
  businessId: number,
  opts: { includeInactive?: boolean } = {},
): Promise<ItemRow[]> {
  const where = [eq(citadelBusinessItems.businessId, businessId)];
  if (!opts.includeInactive) where.push(eq(citadelBusinessItems.active, true));
  return db
    .select({
      id: citadelBusinessItems.id,
      label: citadelBusinessItems.label,
      category: citadelBusinessItems.category,
      priceCents: citadelBusinessItems.priceCents,
      commissionCents: citadelBusinessItems.commissionCents,
      artKey: citadelBusinessItems.artKey,
      imageUrl: citadelBusinessItems.imageUrl,
      active: citadelBusinessItems.active,
      sort: citadelBusinessItems.sort,
    })
    .from(citadelBusinessItems)
    .where(and(...where))
    .orderBy(asc(citadelBusinessItems.sort), asc(citadelBusinessItems.id));
}

export type ItemInput = {
  label: string;
  category: string;
  priceCents: number;
  commissionCents: number;
  artKey?: string | null;
  imageUrl?: string | null;
  sort?: number;
};

export type ItemError = "bad_label" | "bad_price" | "bad_commission" | "unknown_category" | "not_found";

/** Un article à 21 474 836 $ est un débordement d'entier signé, pas un prix. */
const MAX_PRICE_CENTS = 100_000_000;

/**
 * Valide un article contre les rayons DÉCLARÉS du commerce.
 *
 * ⚠ La part employé peut dépasser le prix, et c'est autorisé exprès: `commissionCents` ne sort PAS
 * de la facture du client, c'est l'employeur qui la verse en fin de semaine. La refuser au motif
 * qu'elle excède le prix supposerait que c'est une remise, ce qui est précisément l'inversion que le
 * propriétaire a corrigée. Seul le négatif est refusé.
 */
function validateItem(input: ItemInput, categories: BusinessCategory[]): ItemError | null {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 120) return "bad_label";
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > MAX_PRICE_CENTS) {
    return "bad_price";
  }
  if (
    !Number.isInteger(input.commissionCents) ||
    input.commissionCents < 0 ||
    input.commissionCents > MAX_PRICE_CENTS
  ) {
    return "bad_commission";
  }
  // Un rayon inconnu produirait un article invisible: la caisse groupe par rayon déclaré, donc
  // l'article existerait en base sans jamais s'afficher nulle part.
  if (categories.length > 0 && !categories.some((c) => c.key === input.category)) {
    return "unknown_category";
  }
  return null;
}

async function categoriesOf(businessId: number): Promise<BusinessCategory[]> {
  const [row] = await db
    .select({ categories: citadelBusinesses.categories })
    .from(citadelBusinesses)
    .where(eq(citadelBusinesses.id, businessId))
    .limit(1);
  return row?.categories ?? [];
}

export async function createItem(
  businessId: number,
  input: ItemInput,
): Promise<{ ok: true; id: number } | { ok: false; error: ItemError }> {
  const err = validateItem(input, await categoriesOf(businessId));
  if (err) return { ok: false, error: err };

  const res = await db.insert(citadelBusinessItems).values({
    businessId,
    label: input.label.trim(),
    category: input.category,
    priceCents: input.priceCents,
    commissionCents: input.commissionCents,
    artKey: input.artKey ?? null,
    imageUrl: input.imageUrl ?? null,
    sort: input.sort ?? 0,
  });
  return { ok: true, id: insertedId(res) };
}

export async function updateItem(
  businessId: number,
  itemId: number,
  input: ItemInput,
): Promise<{ ok: true } | { ok: false; error: ItemError }> {
  const err = validateItem(input, await categoriesOf(businessId));
  if (err) return { ok: false, error: err };

  const res = await db
    .update(citadelBusinessItems)
    .set({
      label: input.label.trim(),
      category: input.category,
      priceCents: input.priceCents,
      commissionCents: input.commissionCents,
      artKey: input.artKey ?? null,
      imageUrl: input.imageUrl ?? null,
      ...(input.sort === undefined ? {} : { sort: input.sort }),
    })
    .where(and(eq(citadelBusinessItems.id, itemId), eq(citadelBusinessItems.businessId, businessId)));

  const affected = Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
  return affected > 0 ? { ok: true } : { ok: false, error: "not_found" };
}

/**
 * ARCHIVER un article, jamais le supprimer.
 *
 * ⚠ Une suppression franche est tentante et fausse. `lifeinvader_business_sale_lines.item_id` pointe cet
 * article, et les lignes déjà vendues gardent une COPIE de son libellé et de son prix: l'historique
 * survivrait donc à un DELETE. Ce qui ne survivrait pas, c'est la possibilité de reconnaître qu'une
 * ligne de la semaine dernière et un article remis au catalogue sont le même produit. Un article
 * inactif disparaît de la caisse et reste attachable à son passé.
 */
export async function setItemActive(businessId: number, itemId: number, active: boolean) {
  await db
    .update(citadelBusinessItems)
    .set({ active })
    .where(and(eq(citadelBusinessItems.id, itemId), eq(citadelBusinessItems.businessId, businessId)));
}

/** Réordonner: une passe, cloisonnée, les identifiants étrangers au commerce sont simplement ignorés. */
export async function reorderItems(businessId: number, orderedIds: number[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(citadelBusinessItems)
        .set({ sort: i })
        .where(
          and(eq(citadelBusinessItems.id, orderedIds[i]!), eq(citadelBusinessItems.businessId, businessId)),
        );
    }
  });
}

/* ── Part employé ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Écrire la politique de part employé EN ENTIER.
 *
 * Même contrat que `setGrants` et `setCategories`: on réécrit tout, parce que l'écran qui l'envoie
 * affiche tout. Un enregistrement partiel obligerait à décider ce que veut dire l'absence d'une clé,
 * et l'absence d'un accord veut déjà dire quelque chose (voir `rateFor`).
 *
 * ⚠ L'APPELANT A DÉJÀ NETTOYÉ (`sanitizeCommission`), y compris en prouvant chaque identifiant contre
 * l'effectif RÉEL du métier - ce que cette fonction ne peut pas faire, puisqu'elle ne connaît que le
 * `businessId` et que l'effectif se lit dans les tables du JEU, dans une autre collation.
 */
export async function setCommissionPolicy(businessId: number, policy: CommissionPolicy): Promise<void> {
  await db.update(citadelBusinesses).set({ commission: policy }).where(eq(citadelBusinesses.id, businessId));
}

/** La politique BRUTE d'un commerce, telle qu'elle est stockée. Pour l'écran qui la règle. */
export async function getCommissionPolicy(businessId: number, template: string): Promise<CommissionPolicy> {
  const [row] = await db
    .select({ commission: citadelBusinesses.commission })
    .from(citadelBusinesses)
    .where(eq(citadelBusinesses.id, businessId))
    .limit(1);
  return resolveCommission(row?.commission, templateCommission(template));
}

/* ── Le plafond d'une ligne saisie à la main ──────────────────────────────────────────────────── */

/** Un plafond au-delà de la borne de la colonne (`int` signé) est un débordement, pas une décision. */
const MAX_LINE_CEILING_CENTS = 100_000_000;

export type CeilingError = "bad_ceiling";

/**
 * Écrire le plafond d'une ligne saisie à la main, en centimes.
 *
 * ⚠ REFUSE ZÉRO ET LE NÉGATIF plutôt que de les stocker. Un plafond à zéro ne veut pas dire "gratuit"
 * ni "sans limite": il rendrait toute vente impossible dans ce salon, en silence, et le patron
 * chercherait la panne ailleurs. `access.ts` traite d'ailleurs une valeur aberrante comme absente et
 * retombe sur le modèle, pour la même raison - la porte ferme des deux côtés.
 */
export async function setLineCeiling(
  businessId: number,
  cents: number,
): Promise<{ ok: true } | { ok: false; error: CeilingError }> {
  const v = Math.trunc(Number(cents));
  if (!Number.isInteger(v) || v <= 0 || v > MAX_LINE_CEILING_CENTS) {
    return { ok: false, error: "bad_ceiling" };
  }
  await db
    .update(citadelBusinesses)
    .set({ freeLineMaxCents: v })
    .where(eq(citadelBusinesses.id, businessId));
  return { ok: true };
}

/* ── Rayons ───────────────────────────────────────────────────────────────────────────────────── */

export type CategoryError = "empty" | "duplicate_key" | "bad_tone" | "in_use";

/**
 * Réécrire les rayons EN ENTIER.
 *
 * ⚠ Un rayon qui PORTE ENCORE DES ARTICLES ne peut pas disparaître. `items.category` désigne son
 * rayon par son NOM: le retirer laisserait des articles rattachés à un rayon qui n'existe plus, donc
 * invisibles à la caisse tout en restant vendables par leur id. Renommer le LIBELLÉ reste libre,
 * c'est la CLÉ qui est le point d'ancrage.
 */
export async function setCategories(
  businessId: number,
  next: BusinessCategory[],
): Promise<{ ok: true } | { ok: false; error: CategoryError; detail?: string }> {
  if (next.length === 0) return { ok: false, error: "empty" };
  const keys = new Set<string>();
  for (const c of next) {
    if (keys.has(c.key)) return { ok: false, error: "duplicate_key", detail: c.key };
    keys.add(c.key);
    if (!Number.isInteger(c.tone) || c.tone < 1 || c.tone > 4) {
      return { ok: false, error: "bad_tone", detail: c.key };
    }
  }

  const used = await db
    .selectDistinct({ category: citadelBusinessItems.category })
    .from(citadelBusinessItems)
    .where(eq(citadelBusinessItems.businessId, businessId));
  const orphaned = used.map((u) => u.category).filter((c) => !keys.has(c));
  if (orphaned.length > 0) return { ok: false, error: "in_use", detail: orphaned.join(", ") };

  await db.update(citadelBusinesses).set({ categories: next }).where(eq(citadelBusinesses.id, businessId));
  return { ok: true };
}

/* ── Droits par grade ─────────────────────────────────────────────────────────────────────────── */

const VALID_CAPS = new Set(CAPABILITY_CATALOG.map((c) => c.code));

/**
 * Le NUMÉRO du grade patron pour ce métier, ou null s'il n'y en a pas.
 *
 * `boss` est un NOM de grade (`job_grades.name`), jamais un indice. Même règle partout ailleurs.
 */
async function bossGradeFor(job: string): Promise<number | null> {
  const rows = await db
    .select({ grade: jobGrades.grade, name: jobGrades.name })
    .from(jobGrades)
    .where(eq(jobGrades.jobName, job));
  const hit = rows.find((r) => (r.name ?? "").toLowerCase() === "boss");
  return hit ? hit.grade : null;
}

/**
 * Réécrire les droits par grade EN ENTIER.
 *
 * ⚠⚠ LE GRADE PATRON EST RETIRÉ DE CE QU'ON ÉCRIT, silencieusement et sans erreur. C'est le coeur du
 * modèle: le patron détient tout implicitement, donc une ligne le concernant n'aurait qu'un seul
 * effet possible, lui RETIRER quelque chose. On ne se contente pas de le déconseiller ni de renvoyer
 * une erreur que quelqu'un contournerait: on rend la révocation IMPOSSIBLE À ÉCRIRE. Sinon une fausse
 * manoeuvre enferme une entreprise dehors et il ne reste personne à l'intérieur pour rouvrir la
 * porte. Même raisonnement que le `'*'` du Fondateur côté staff.
 *
 * ⚠ Écrire `{}` est LÉGITIME et différent de ne rien écrire: `null` veut dire "jamais configuré" et
 * déclenche le repli jour-un, `{}` veut dire "tout retiré à tout le monde" et se respecte. Cette
 * fonction n'écrit donc jamais `null`.
 *
 * Les capacités inconnues du code sont écartées: une clé inventée depuis une requête forgée ne doit
 * pas se retrouver stockée, où elle ressemblerait plus tard à un droit réel.
 */
export async function setGrants(
  businessId: number,
  job: string,
  next: Record<string | number, string[]>,
): Promise<{ ok: true; grants: Record<string, string[]> }> {
  const boss = await bossGradeFor(job);
  const clean: Record<string, string[]> = {};

  for (const [rawGrade, caps] of Object.entries(next)) {
    const grade = Number(rawGrade);
    if (!Number.isInteger(grade) || grade < 0) continue;
    if (boss !== null && grade === boss) continue; // irrévocable par construction

    const kept = [...new Set(caps)].filter((c) => VALID_CAPS.has(c as never));
    clean[String(grade)] = kept;
  }

  await db.update(citadelBusinesses).set({ grants: clean }).where(eq(citadelBusinesses.id, businessId));
  return { ok: true, grants: clean };
}

/* ── Modules ──────────────────────────────────────────────────────────────────────────────────── */

const CORE_KEYS = new Set(BUSINESS_MODULES.filter((m) => m.core).map((m) => m.key));
const SOON_KEYS = new Set(BUSINESS_MODULES.filter((m) => m.soon).map((m) => m.key));
const MODULE_KEYS = new Set(BUSINESS_MODULES.map((m) => m.key));

/**
 * Écrire les ÉCARTS de modules par rapport au modèle.
 *
 * ⚠ On stocke les écarts, pas l'état complet: c'est ce qui fait que retoucher le modèle "bar" met à
 * jour les onze bars, et que seuls les modules explicitement personnalisés résistent. Stocker l'état
 * complet figerait une copie le jour de l'activation et le modèle ne servirait plus à rien.
 *
 * ⚠ Un module ESSENTIEL ne peut pas être éteint et un module À VENIR ne peut pas être allumé, et on
 * l'applique ICI en plus de `resolveModules`. La double barrière est voulue: `resolveModules` protège
 * la LECTURE contre des données déjà écrites de travers, celle-ci empêche de les écrire.
 */
export async function setModuleOverrides(
  businessId: number,
  next: Record<string, boolean>,
): Promise<{ ok: true; overrides: Record<string, boolean> }> {
  const clean: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(next)) {
    if (!MODULE_KEYS.has(k) || CORE_KEYS.has(k) || SOON_KEYS.has(k)) continue;
    clean[k] = Boolean(v);
  }
  await db
    .update(citadelBusinesses)
    .set({ moduleOverrides: clean })
    .where(eq(citadelBusinesses.id, businessId));
  return { ok: true, overrides: clean };
}

/** Renommer l'enseigne / changer la palette. Le `slug` n'est PAS touché: des liens sont déjà partagés. */
export async function updateIdentity(
  businessId: number,
  next: { name?: string; palette?: ThemedPalette },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (next.name !== undefined) patch.name = next.name.trim().slice(0, 120);
  // ⚠ La palette est REFILTRÉE à l'écriture, alors que `theme.ts` la refiltre déjà au rendu. Ce
  // n'est pas une redite inutile: le rendu protège la PAGE (c'est lui qui produit le CSS), celle-ci
  // protège la BASE. Sans elle, une charge utile hostile resterait stockée, invisible tant que
  // personne ne change le rendu, et réarmée le jour où quelqu'un ajoute un second consommateur de
  // la palette qui ne penserait pas à filtrer. On refuse de conserver ce qu'on refuserait d'écrire.
  if (next.palette !== undefined) patch.palette = sanitizePalette(next.palette);
  if (Object.keys(patch).length === 0) return;
  await db.update(citadelBusinesses).set(patch).where(eq(citadelBusinesses.id, businessId));
}

/** Ne garde que les paires (variable connue, couleur hexadécimale). Voir isSafePaletteEntry. */
function sanitizePalette(p: ThemedPalette): ThemedPalette {
  const clean = (side: Record<string, string> | undefined) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(side ?? {})) {
      if (isSafePaletteEntry(k, v)) out[k] = v.trim();
    }
    return out;
  };
  return { dark: clean(p?.dark), light: clean(p?.light) };
}
