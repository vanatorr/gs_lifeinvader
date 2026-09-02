"use server";

import { revalidatePath } from "next/cache";
import { requireIdentity } from "@/lib/auth/session";
import { requireBusiness } from "@/lib/business/access";
import { PRODUCT_ART } from "@/lib/business/art";
import { CAP } from "@/lib/business/capabilities";
import {
  createItem,
  getCommissionPolicy,
  listItems,
  reorderItems,
  setCommissionPolicy,
  setItemActive,
  setLineCeiling,
  updateItem,
  type ItemError,
  type ItemInput,
  type ItemRow,
} from "@/lib/business/catalogue";
import {
  sanitizeCommission,
  type CommissionError,
  type CommissionPolicy,
} from "@/lib/business/commission";
import { employeesForJob } from "@/lib/business/roster";
import { gradesForJob } from "@/lib/data/gameCommands";
import { templateGrid } from "@/lib/business/templates";

/**
 * LES ACTIONS DE LA PAGE CATALOGUE (gestion).
 *
 * ⚠⚠ CHAQUE ACTION RE-RÉSOUT SON ACCÈS AVEC `CAP.CATALOGUE_WRITE`, ET C'EST LA SEULE CHOSE QUI
 * PROTÈGE QUOI QUE CE SOIT ICI. Un Server Action est un POST public à l'URL de la page: joignable
 * sans jamais avoir chargé /gestion/catalogue, et la page a pu rester ouverte pendant qu'on quittait
 * son service. Le `businessId` ne vient JAMAIS du client, il sort de `access` résolu ici même
 * (voir [slug]/actions.ts, même discipline).
 *
 * ⚠ RIEN DE CE QUE LE NAVIGATEUR ENVOIE N'EST UNE VÉRITÉ. Le type TypeScript d'un Server Action est
 * une déclaration d'intention, pas un contrôle: la charge utile arrive d'un POST et peut porter
 * n'importe quoi. Chaque valeur est donc re-typée ici (`Number`, `String`) avant d'atteindre
 * `lib/business/catalogue.ts`, qui applique ensuite ses propres bornes.
 */

export type ItemFormState = { status: "ok" } | { status: "error"; message: string };

/**
 * On ne renvoie jamais un code brut au navigateur, et chaque motif dit quoi FAIRE plutôt que quel
 * champ a échoué dans l'abstrait. La table est exhaustive par construction (`Record<ItemError, …>`):
 * ajouter un code à `ItemError` sans écrire sa phrase ne compile pas, ce qui est la seule façon
 * fiable d'éviter qu'un refus finisse par s'afficher comme un identifiant technique.
 */
const ITEM_MESSAGES: Record<ItemError, string> = {
  bad_label: "Donnez un nom à l'article, de 1 à 120 caractères.",
  bad_price:
    "Le prix client doit être un nombre entier de dollars, entre 0 et 1 000 000. Retirez les décimales et réessayez.",
  bad_commission:
    "La part employé doit être un nombre entier de dollars, entre 0 et 1 000 000. Elle peut dépasser le prix client, mais pas être négative.",
  unknown_category:
    "Ce rayon n'existe pas dans ce commerce. Choisissez-en un dans la liste, ou créez-le depuis les Réglages.",
  not_found: "Cet article n'existe plus. Rechargez la page pour repartir de l'état réel.",
};

const DENIED =
  "Modification refusée: prenez votre service en jeu, ou demandez ce droit à la direction, puis rechargez la page.";

const UNKNOWN_ART =
  "Cette illustration n'existe plus dans la bibliothèque. Choisissez-en une autre, ou retirez l'illustration.";

/**
 * Ce que le formulaire envoie: des DOLLARS, jamais des centimes.
 *
 * ⚠ La conversion se fait ICI, à la frontière serveur, et NULLE PART AILLEURS. Les prix de ce portail
 * sont des dollars ENTIERS: `theme.ts` `money()` et `priceParts()` arrondissent déjà tout affichage au
 * dollar près (caisse, ticket, page Équipe), donc un article à 12,50 $ serait lu 13 $ partout tout en
 * facturant 12,50 $, un écart permanent entre ce qu'on lit et ce qu'on doit.
 *
 * ⚠ ON ARRONDIT LES DOLLARS PUIS ON MULTIPLIE, jamais l'inverse. `Math.round(12.5 * 100)` vaut 1250,
 * un entier parfaitement valide que `validateItem` accepte: l'ancienne formule laissait donc passer
 * exactement ce que son propre commentaire prétendait interdire. `Math.round(12.5) * 100` vaut 1300 et
 * applique vraiment l'invariant.
 */
export type ItemFormInput = {
  label: string;
  category: string;
  priceDollars: number;
  commissionDollars: number;
  /** Une clé de `PRODUCT_ART`, ou null pour "aucune illustration, l'icône du rayon suffit". */
  artKey: string | null;
};

/** Dollars vers centimes entiers. Rend `NaN` sur une saisie non finie, que `validateItem` refuse. */
function dollarsToCents(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n) * 100;
}

/**
 * La clé d'illustration, PROUVÉE contre la table figée du code.
 *
 * ⚠ `hasOwnProperty` et non `PRODUCT_ART[raw]`. Une clé comme `constructor` ou `toString` remonte la
 * chaîne de prototypes et rend une valeur TRUTHY qui n'est pas un dessin: la stocker mettrait en base
 * une clé que `visualFor` prendrait ensuite pour valide et passerait à un `dangerouslySetInnerHTML`.
 * Le rendu s'en sortirait (React coerce en texte, ce n'est pas une injection), mais on refuse
 * d'écrire ce qu'on refuserait de lire.
 *
 * ⚠ ON REFUSE, ON NE CORRIGE PAS EN SILENCE. Retomber sur `null` effacerait le choix de la personne
 * sans le dire, et c'est précisément le bug que cette page existe pour réparer: l'ancien formulaire
 * n'envoyait PAS `artKey`, donc `updateItem` recevait `undefined` et écrivait `null`, ce qui effaçait
 * l'illustration d'un article à chaque changement de prix.
 */
function resolveArtKey(raw: unknown): { ok: true; key: string | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, key: null };
  if (typeof raw !== "string") return { ok: false };
  return Object.prototype.hasOwnProperty.call(PRODUCT_ART, raw) ? { ok: true, key: raw } : { ok: false };
}

/**
 * L'article tel qu'il existe DÉJÀ en base, ou null.
 *
 * Passe par `listItems`, le seul lecteur du module de données, qui cloisonne par `business_id` DANS
 * la requête. Un `SELECT … WHERE id = ?` écrit à la main ici serait un contrôle de plus à ne pas
 * oublier, dans le fichier le moins bien placé pour s'en souvenir.
 */
async function existingItem(businessId: number, itemId: number): Promise<ItemRow | null> {
  const rows = await listItems(businessId, { includeInactive: true });
  return rows.find((r) => r.id === itemId) ?? null;
}

/** Les deux pages qui lisent ce catalogue. La caisse le lit aussi, donc elle se revalide avec. */
function revalidateBoth(slug: string) {
  revalidatePath(`/business/${slug}/gestion/catalogue`);
  revalidatePath(`/business/${slug}/caisse`);
}

export async function createItemAction(slug: string, input: ItemFormInput): Promise<ItemFormState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_WRITE);
  if (!access) return { status: "error", message: DENIED };

  const art = resolveArtKey(input?.artKey);
  if (!art.ok) return { status: "error", message: UNKNOWN_ART };

  // Un article neuf se range EN DERNIER, pas en tête. `sort` par défaut vaut 0, donc un ajout serait
  // remonté devant tout ce qui a déjà été rangé à la main, et la carte se réordonnerait toute seule
  // à chaque création: exactement l'inverse de "arranger sa carte".
  const rows = await listItems(access.businessId, { includeInactive: true });
  const nextSort = rows.reduce((max, r) => Math.max(max, r.sort), -1) + 1;

  const payload: ItemInput = {
    label: String(input?.label ?? ""),
    category: String(input?.category ?? ""),
    priceCents: dollarsToCents(input?.priceDollars),
    commissionCents: dollarsToCents(input?.commissionDollars),
    artKey: art.key,
    // Aucun téléversement n'existe encore sur ce portail: le champ reste vide plutôt que d'accepter
    // une URL du client, qui serait une adresse arbitraire servie à tous les employés.
    imageUrl: null,
    sort: nextSort,
  };

  const res = await createItem(access.businessId, payload);
  if (!res.ok) return { status: "error", message: ITEM_MESSAGES[res.error] };

  revalidateBoth(slug);
  return { status: "ok" };
}

export async function updateItemAction(
  slug: string,
  itemId: number,
  input: ItemFormInput,
): Promise<ItemFormState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_WRITE);
  if (!access) return { status: "error", message: DENIED };

  const art = resolveArtKey(input?.artKey);
  if (!art.ok) return { status: "error", message: UNKNOWN_ART };

  const id = Number(itemId);
  if (!Number.isInteger(id)) return { status: "error", message: ITEM_MESSAGES.not_found };

  // ⚠ `updateItem` réécrit `imageUrl` À CHAQUE FOIS (`input.imageUrl ?? null`): ne pas le fournir
  // l'EFFACERAIT. On relit donc la valeur EN BASE et on la repasse telle quelle. Elle ne transite
  // jamais par le navigateur, qui n'a aucune raison de pouvoir choisir une adresse d'image.
  const current = await existingItem(access.businessId, id);
  if (!current) return { status: "error", message: ITEM_MESSAGES.not_found };

  /**
   * ⚠⚠ QUAND LE CHAMP N'EST PAS AFFICHÉ, ON GARDE LA VALEUR EN BASE - on n'écrit PAS le zéro que
   * le navigateur a envoyé faute de champ. Exactement le piège d'`imageUrl` juste au-dessus, et il
   * s'est armé le jour où la part employé a gagné un mode POURCENTAGE: dans ce mode la fiche
   * n'affiche plus de part par article (elle ne paierait personne, voir `declareSale`), donc
   * `CatalogueView` envoie 0, donc un simple changement de prix effaçait DÉFINITIVEMENT toutes les
   * parts fixes du catalogue. Personne ne l'aurait vu avant de revenir au mode montant, des semaines
   * plus tard, pour trouver un catalogue entier à zéro.
   *
   * ⚠ La même protection couvre le module `commissions` ÉTEINT, où l'ancien code écrasait déjà en
   * silence. Ce n'était pas voulu non plus: le module décide si la part EXISTE pour ce commerce, pas
   * si on a le droit d'oublier ce que le patron avait réglé. Le rallumer doit rendre ses chiffres.
   */
  const keepShare = access.modules.commissions === false || access.commission.mode !== "montant";

  const payload: ItemInput = {
    label: String(input?.label ?? ""),
    category: String(input?.category ?? ""),
    priceCents: dollarsToCents(input?.priceDollars),
    commissionCents: keepShare ? current.commissionCents : dollarsToCents(input?.commissionDollars),
    artKey: art.key,
    imageUrl: current.imageUrl,
    // `sort` absent veut dire "ne touche pas au rangement": le déplacement a sa propre action.
  };

  const res = await updateItem(access.businessId, id, payload);
  if (!res.ok) return { status: "error", message: ITEM_MESSAGES[res.error] };

  revalidateBoth(slug);
  return { status: "ok" };
}

/** Archiver / réactiver. Jamais de suppression: voir le commentaire de `setItemActive`. */
export async function setItemActiveAction(
  slug: string,
  itemId: number,
  active: boolean,
): Promise<ItemFormState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_WRITE);
  if (!access) return { status: "error", message: DENIED };

  const id = Number(itemId);
  if (!Number.isInteger(id)) return { status: "error", message: ITEM_MESSAGES.not_found };
  if (!(await existingItem(access.businessId, id))) {
    return { status: "error", message: ITEM_MESSAGES.not_found };
  }

  await setItemActive(access.businessId, id, Boolean(active));

  revalidateBoth(slug);
  return { status: "ok" };
}

/**
 * DÉPLACER UN ARTICLE D'UNE PLACE DANS SON RAYON.
 *
 * ⚠ LE CLIENT ENVOIE UN GESTE, PAS UN ORDRE DE TRI. Recevoir la liste complète des identifiants
 * telle que le navigateur la voit aurait paru plus simple et aurait laissé un POST forgé réécrire le
 * rangement entier, ou en amputer la moitié (`reorderItems` numérote ce qu'on lui donne, donc une
 * liste partielle écrase les rangs des absents). Ici le serveur relit l'ordre réel, applique UN
 * échange, et renvoie la liste complète: le navigateur ne peut décrire qu'un déplacement à la fois.
 *
 * Le voisin cherché est le prochain article DU MÊME RAYON ET DU MÊME ÉTAT, parce que c'est ce que la
 * personne voit: la page groupe par rayon et sépare les archivés, donc "la place d'avant" veut dire
 * la place d'avant DANS SON GROUPE, pas dans la liste globale.
 */
export async function moveItemAction(
  slug: string,
  itemId: number,
  direction: "up" | "down",
): Promise<ItemFormState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_WRITE);
  if (!access) return { status: "error", message: DENIED };

  const id = Number(itemId);
  const step = direction === "up" ? -1 : 1;

  const rows = await listItems(access.businessId, { includeInactive: true });
  const from = rows.findIndex((r) => r.id === id);
  if (from < 0) return { status: "error", message: ITEM_MESSAGES.not_found };

  const me = rows[from]!;
  let to = from + step;
  while (to >= 0 && to < rows.length) {
    const other = rows[to]!;
    if (other.category === me.category && other.active === me.active) break;
    to += step;
  }
  // Déjà en bout de groupe: rien à faire, et ce n'est pas une erreur. Le bouton est déjà grisé côté
  // navigateur; une course entre deux gérants ne doit pas produire un message alarmant.
  if (to < 0 || to >= rows.length) return { status: "ok" };

  const next = rows.map((r) => r.id);
  next[from] = rows[to]!.id;
  next[to] = me.id;

  await reorderItems(access.businessId, next);

  revalidateBoth(slug);
  return { status: "ok" };
}

/* ── Le plafond d'une ligne saisie à la main ──────────────────────────────────────────────────── */

/**
 * RÉGLER LE PRIX MAXIMUM D'UNE LIGNE saisie par l'employé à la caisse.
 *
 * ⚠⚠ CE RÉGLAGE EST UN CONTRÔLE DE SÉCURITÉ, PAS UN CONFORT, et c'est pour ça qu'il vit derrière
 * `catalogue.write` avec les prix et la part: la caisse d'un salon laisse l'employé taper le montant,
 * et sa part est un POURCENTAGE de ce montant. Sans plafond, "je tape mon prix" est exactement
 * "je tape ma paie".
 *
 * ⚠ REFUSÉ SUR UN COMMERCE SANS GRILLE. Une valeur écrite sur un bar n'ouvrirait rien (voir
 * `lineMaxFor`, qui rend null dès que le modèle n'a pas de grille), mais elle laisserait en base un
 * réglage qui ressemble à une règle appliquée.
 */
export async function setLineCeilingAction(slug: string, dollars: number): Promise<ItemFormState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_WRITE);
  if (!access) return { status: "error", message: DENIED };

  if (!templateGrid(access.template)) {
    return {
      status: "error",
      message: "Ce commerce n'a pas de caisse à saisie libre, il n'y a donc pas de plafond à régler.",
    };
  }

  const res = await setLineCeiling(access.businessId, dollarsToCents(dollars));
  if (!res.ok) {
    return {
      status: "error",
      message:
        "Le plafond doit être un nombre entier de dollars supérieur à zéro. Un plafond à zéro rendrait toute vente impossible dans ce salon.",
    };
  }

  revalidateBoth(slug);
  return { status: "ok" };
}

/* ── Part employé ─────────────────────────────────────────────────────────────────────────────── */

const COMMISSION_MESSAGES: Record<CommissionError, string> = {
  bad_mode: "Choisissez un mode de part employé: un montant par article, ou un pourcentage de la facture.",
  bad_rate: "Un pourcentage doit être un nombre entre 0 et 100. Le taux d'une personne aussi.",
  unknown_employee: "Cette personne ne travaille plus ici. Rechargez la page pour repartir de l'effectif réel.",
};

/**
 * ENREGISTRER LA PART EMPLOYÉ DU COMMERCE (mode, taux général, accords personnels).
 *
 * ⚠ DERRIÈRE `CATALOGUE_WRITE`, ET PAS `SETTINGS_WRITE`, ALORS QUE ÇA RESSEMBLE À UN RÉGLAGE. Le
 * catalogue d'un point de vue de droit, c'est "décide de ce que les gens touchent" - c'est écrit
 * dans la description de la capacité, et le montant fixe par article vit déjà derrière elle. Ranger
 * le POURCENTAGE derrière une autre capacité couperait une seule décision en deux droits: quelqu'un
 * pourrait fixer une part fixe sans pouvoir fixer le pourcentage qui la remplace, ce que personne ne
 * saurait expliquer.
 *
 * ⚠ L'EFFECTIF EST LU CÔTÉ SERVEUR ET SERT DE LISTE BLANCHE. Voir `sanitizeCommission`: sans lui,
 * un POST forgé remplirait la colonne d'identifiants étrangers au commerce.
 */
export async function setCommissionAction(
  slug: string,
  input: Partial<CommissionPolicy>,
): Promise<ItemFormState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_WRITE);
  if (!access) return { status: "error", message: DENIED };

  const roster = await employeesForJob(access.job);
  const known = new Set(roster.map((r) => r.identifier));
  const ladder = await gradesForJob(access.job);
  const knownGrades = new Set(ladder.map((g) => g.grade));

  const current = await getCommissionPolicy(access.businessId, access.template);

  /**
   * ⚠ UN COMMERCE À CAISSE LIBRE NE PEUT PAS PAYER "AU MONTANT PAR ARTICLE": il n'a aucun article.
   * Le mode est donc forcé ici, côté serveur, et pas seulement caché dans l'interface (`lockPercent`).
   * Sans ça, un POST forgé - ou simplement un vieil onglet ouvert avant la bascule - écrirait
   * `montant`, et `declareFreeSale` verserait alors ZÉRO à tout le monde sans une seule erreur nulle
   * part: la part disparaîtrait en silence, ce qui est la pire façon de casser une paie.
   */
  const forced = templateGrid(access.template)
    ? { ...current, ...(input ?? {}), mode: "pourcentage" as const }
    : { ...current, ...(input ?? {}) };

  const clean = sanitizeCommission(forced, known, knownGrades);
  if (!clean.ok) return { status: "error", message: COMMISSION_MESSAGES[clean.error] };

  await setCommissionPolicy(access.businessId, clean.policy);

  revalidateBoth(slug);
  // La part se lit aussi sur ces trois écrans, et ils ne partagent pas le cache du catalogue: sans
  // ça, un patron qui remonte un taux verrait l'ancien chiffre sur Mes ventes jusqu'au prochain
  // rendu complet, ce qui se lit comme un enregistrement raté.
  revalidatePath(`/business/${slug}/mes-ventes`);
  revalidatePath(`/business/${slug}/gestion/equipe`);
  revalidatePath(`/business/${slug}/gestion/analytique`);
  return { status: "ok" };
}
