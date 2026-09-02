"use server";

import { revalidatePath } from "next/cache";
import { requireIdentity } from "@/lib/auth/session";
import { requireBusiness } from "@/lib/business/access";
import { CATEGORY_ICONS } from "@/lib/business/art";
import { CAP } from "@/lib/business/capabilities";
import {
  setCategories,
  setGrants,
  setModuleOverrides,
  type CategoryError,
} from "@/lib/business/catalogue";
import type { BusinessCategory } from "@/lib/business/templates";

/**
 * LES ACTIONS DE LA PAGE RÉGLAGES.
 *
 * ⚠⚠ CHAQUE ACTION RE-RÉSOUT SON ACCÈS AVEC `CAP.SETTINGS_WRITE`, ET C'EST LA SEULE CHOSE QUI
 * PROTÈGE QUOI QUE CE SOIT. Un Server Action est un POST public à l'URL de la page, joignable sans
 * jamais avoir chargé /gestion/reglages. Même discipline que [slug]/actions.ts et
 * gestion/catalogue/actions.ts.
 *
 * ⚠ RIEN DE CE QUE LE NAVIGATEUR ENVOIE N'EST UNE VÉRITÉ. Le type TypeScript d'un Server Action est
 * une déclaration d'intention, pas un contrôle: la charge utile arrive d'un POST et peut porter
 * n'importe quoi. Chaque valeur est re-typée et re-bornée ici avant d'atteindre
 * `lib/business/catalogue.ts`.
 */

export type SettingsState = { status: "ok" } | { status: "error"; message: string };

const DENIED = "Prise de service requise pour modifier les réglages.";

/** Modules: écarts par rapport au modèle. `next` est l'état COMPLET des écarts, jamais un delta:
 *  voir le commentaire de `setModuleOverrides`, qui réécrit la colonne en entier. */
export async function setModulesAction(slug: string, next: Record<string, boolean>): Promise<SettingsState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SETTINGS_WRITE);
  if (!access) return { status: "error", message: DENIED };

  await setModuleOverrides(access.businessId, next);

  revalidatePath(`/business/${slug}/gestion/reglages`);
  revalidatePath(`/business/${slug}`); // le rail de navigation dépend des modules actifs
  return { status: "ok" };
}

/** On ne renvoie jamais le code brut: chaque motif dit quoi FAIRE. `detail` porte le rayon en cause
 *  quand `setCategories` en fournit un. */
const CATEGORY_MESSAGES: Record<CategoryError, (detail?: string) => string> = {
  empty: () => "Il faut garder au moins un rayon.",
  duplicate_key: (d) =>
    `Deux rayons partagent la même clé interne${d ? ` (${d})` : ""}. Changez le libellé de l'un des deux.`,
  bad_tone: (d) =>
    `Le ton du rayon${d ? ` "${d}"` : ""} est invalide. Choisissez l'une des quatre couleurs proposées.`,
  in_use: (d) =>
    `Ce rayon contient encore des articles et ne peut pas être retiré${d ? ` : ${d}` : ""}. ` +
    "Déplacez ou archivez ces articles depuis le Catalogue avant de retirer le rayon.",
};

/** La forme d'une clé de rayon CRÉÉE ici: minuscules, chiffres, tirets, 40 au plus. */
const KEY_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const BAD_ICON =
  "Cette icône de rayon n'existe pas dans la bibliothèque. Choisissez-en une dans la grille proposée.";
const BAD_KEY =
  "La clé interne d'un rayon ne peut contenir que des minuscules, des chiffres et des tirets (40 caractères au plus). Rechargez la page et repartez du libellé.";
const BAD_LABEL = "Donnez un libellé à chaque rayon, de 1 à 60 caractères.";

/**
 * LES RAYONS: réécriture ENTIÈRE de la liste, voir le commentaire de `setCategories`.
 *
 * ⚠⚠ TROIS CHAMPS SONT VALIDÉS ICI ET NULLE PART AILLEURS, et ce n'est pas de la redite.
 * `setCategories` (couche données) vérifie la CLÉ en doublon, le TON, et qu'aucun rayon encore
 * porteur d'articles ne disparaisse. Il ne regarde ni le libellé, ni l'icône, ni la FORME de la clé,
 * parce que jusqu'ici aucune interface ne permettait d'écrire ces deux derniers: ils venaient d'un
 * modèle en code. La page Réglages les rend modifiables, donc ils arrivent maintenant du navigateur,
 * donc ils se prouvent ici.
 *
 * ⚠ L'ICÔNE SE PROUVE AVEC `hasOwnProperty` CONTRE LA TABLE FIGÉE, et une clé inconnue est REFUSÉE,
 * jamais ramenée à `undefined`. Deux raisons, dans cet ordre: `constructor` ou `toString` remonteraient
 * la chaîne de prototypes et rendraient une valeur TRUTHY qui n'est pas un dessin; et une correction
 * silencieuse effacerait un choix sans le dire, ce qui est exactement le bug que la page Catalogue
 * existe pour réparer (un formulaire qui n'envoyait pas `artKey` et l'écrivait donc à `null` à chaque
 * changement de prix). Même règle, même mot, que `resolveArtKey` dans gestion/catalogue/actions.ts.
 *
 * ⚠ UNE CLÉ DÉJÀ EN BASE PASSE TELLE QUELLE, MÊME HORS FORME. La forme canonique ne s'applique
 * qu'aux clés qu'on CRÉE. Un commerce dont un rayon porte une clé écrite à la main il y a six mois
 * (accents, majuscules) doit rester enregistrable: refuser sa propre donnée existante rendrait la
 * page inutilisable pour lui, et la clé est de toute façon l'ancre de ses articles, donc la dernière
 * chose qu'on veuille le forcer à changer.
 */
export async function setCategoriesAction(
  slug: string,
  next: BusinessCategory[],
): Promise<SettingsState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SETTINGS_WRITE);
  if (!access) return { status: "error", message: DENIED };

  if (!Array.isArray(next)) return { status: "error", message: CATEGORY_MESSAGES.empty() };

  // Les clés qui existent DÉJÀ sur ce commerce, résolues côté serveur et jamais reçues du client.
  const known = new Set(access.categories.map((c) => c.key));

  const clean: BusinessCategory[] = [];
  for (const raw of next) {
    const key = String(raw?.key ?? "");
    if (!known.has(key) && !KEY_SHAPE.test(key)) return { status: "error", message: BAD_KEY };

    const label = String(raw?.label ?? "").trim();
    if (label.length === 0 || label.length > 60) return { status: "error", message: BAD_LABEL };

    // Le ton est re-typé ici pour que `setCategories` juge un NOMBRE, pas la chaîne "2" qu'un POST
    // forgé enverrait: `Number.isInteger("2")` est faux, donc le refus serait juste, mais son motif
    // parlerait d'une palette invalide au lieu d'une saisie malformée.
    const tone = Number(raw?.tone);

    const icon = raw?.icon;
    if (icon !== undefined && icon !== null && icon !== "") {
      if (typeof icon !== "string" || !Object.prototype.hasOwnProperty.call(CATEGORY_ICONS, icon)) {
        return { status: "error", message: BAD_ICON };
      }
    }

    clean.push({ key, label, tone, ...(icon ? { icon } : {}) });
  }

  const res = await setCategories(access.businessId, clean);
  if (!res.ok) return { status: "error", message: CATEGORY_MESSAGES[res.error](res.detail) };

  revalidatePath(`/business/${slug}/gestion/reglages`);
  revalidatePath(`/business/${slug}/gestion/catalogue`);
  revalidatePath(`/business/${slug}/caisse`);
  return { status: "ok" };
}

/**
 * Droits par grade.
 *
 * ⚠ LE MÉTIER NE VIENT JAMAIS DU CLIENT. `next` ne porte que des numéros de grade et des listes de
 * capacités; c'est `access.job` (résolu ici même par `requireBusiness`, jamais transmis par le
 * navigateur) qui désigne le métier concerné. `setGrants` retire lui-même le grade patron avant
 * d'écrire quoi que ce soit (voir son commentaire): cette action n'a rien de plus à faire pour ça,
 * et l'interface n'affiche même pas de ligne pour lui.
 */
export async function setGrantsAction(
  slug: string,
  next: Record<string, string[]>,
): Promise<SettingsState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SETTINGS_WRITE);
  if (!access) return { status: "error", message: DENIED };

  await setGrants(access.businessId, access.job, next);

  revalidatePath(`/business/${slug}/gestion/reglages`);
  revalidatePath(`/business/${slug}`); // le rail de navigation dépend des capacités par grade
  return { status: "ok" };
}
