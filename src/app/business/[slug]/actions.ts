"use server";

import { revalidatePath } from "next/cache";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, requireBusiness } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import { templateBillsCustoms, templateGrid } from "@/lib/business/templates";
import { searchVehicles, vehicleClassLabel } from "@/lib/business/fleet";
import { quoteCustoms, type QuotedGroup } from "@/lib/business/customMargin";
import {
  declareCustomSale,
  declareFreeSale,
  declareSale,
  type CustomLineInput,
  type DeclareLineInput,
  type DeclaredVehicle,
  type FreeDeclareError,
} from "@/lib/business/sales";
import {
  clientProblemText,
  CLIENT_FIELD_LABELS,
  type ClientRecordDraft,
} from "@/lib/business/clientRecord";
import { clientRecordBounds } from "@/lib/business/clientRecordRules";

/**
 * LES ACTIONS DU PORTAIL COMMERCES.
 *
 * ⚠⚠ CHAQUE ACTION RE-RÉSOUT SON ACCÈS, ET C'EST LA SEULE CHOSE QUI PROTÈGE QUOI QUE CE SOIT. Un
 * Server Action est un POST PUBLIC à l'URL de la page: il est joignable sans jamais avoir chargé la
 * page, donc le contrôle fait dans la mise en page ou dans le rendu ne vaut rien ici. Il se
 * re-résout aussi parce que la page a pu rester ouverte pendant que la personne quittait son
 * service, changeait de grade, ou se faisait virer.
 *
 * ⚠ La capacité est NOMMÉE par l'action, jamais devinée: `requireBusiness(id, slug, CAP.X)`.
 */

export type DeclareState =
  | { status: "idle" }
  | {
      status: "ok";
      publicRef: string;
      totalCents: number;
      commissionCents: number;
      duplicate: boolean;
      /** Ce qu'on a trouvé derrière la plaque. Voir `DeclaredVehicle` (accusé de réception). */
      vehicle?: DeclaredVehicle;
    }
  | { status: "error"; message: string };

/**
 * Les motifs de refus, en français et adressés à la personne.
 *
 * ⚠ On ne renvoie JAMAIS le code brut au navigateur: `rate_limited` ne dit rien à un barman. Et on
 * distingue les refus qui appellent une action (reprendre son service) de ceux qui appellent une
 * correction (une quantité aberrante), parce qu'un message qui n'indique pas quoi faire équivaut à
 * pas de message.
 */
const DECLARE_MESSAGES: Record<string, string> = {
  denied: "Vous devez être en service pour déclarer une vente.",
  rate_limited: "Trop de déclarations d'affilée. Patientez quelques instants.",
  empty: "Le ticket est vide.",
  too_many_lines: "Trop d'articles différents sur un même ticket.",
  bad_qty: "Une quantité est invalide.",
  unknown_item: "Un article n'existe plus au catalogue. Rechargez la page.",
  unknown_vehicle: "Ce véhicule n'est pas au catalogue de ce concessionnaire. Rechargez la page.",
  too_large: "Le montant du ticket est hors limite. Faites plusieurs tickets.",
  ref_exhausted: "Impossible d'attribuer une référence. Réessayez.",
  client_required:
    "La fiche client est obligatoire ici: identité de l'acheteur et plaque du véhicule.",
  client_invalid: "La fiche client est incomplète ou mal saisie.",
  // ⚠ Le refus doit dire QUOI FAIRE. "Un seul véhicule" sans la suite ressemble à une limite
  // arbitraire; la phrase explique que la fiche ne porte qu'une plaque, donc que deux voitures
  // demandent deux tickets - ce qui est aussi la réalité de la vente.
  too_many_vehicles:
    "Un seul véhicule par ticket: la fiche ne porte qu'une plaque. Faites un ticket par voiture.",
};

export async function declareSaleAction(
  slug: string,
  input: {
    lines: DeclareLineInput[];
    vehicles?: { model: string; qty: number }[];
    /** La fiche client. Exigée par le MODÈLE du commerce, jamais par sa présence ici. */
    client?: Partial<ClientRecordDraft> | null;
    note?: string | null;
    clientRef: string;
  },
): Promise<DeclareState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SALE_DECLARE);
  // Une seule réponse pour "pas le droit", "pas en service" et "ce commerce n'est pas le vôtre":
  // les séparer renseignerait sur l'existence d'un commerce et sur la présence de quelqu'un.
  if (!access) return { status: "error", message: DECLARE_MESSAGES.denied! };

  const res = await declareSale(access, {
    lines: input.lines,
    vehicles: input.vehicles ?? [],
    client: input.client ?? null,
    note: input.note ?? null,
    clientRef: input.clientRef,
  });

  if (!res.ok) {
    /**
     * ⚠ NOMMER LE CHAMP FAUTIF. Sur cinq champs obligatoires, "la fiche est mal saisie" fait tout
     * relire, et la personne a un client devant elle. Le libellé et la phrase viennent du module
     * partagé, donc la caisse dira exactement la même chose sous le champ concerné.
     */
    if (res.error === "client_invalid" && res.field && res.problem) {
      const bounds = clientRecordBounds();
      return {
        status: "error",
        message: `${CLIENT_FIELD_LABELS[res.field]}: ${clientProblemText(res.field, res.problem, bounds)}`,
      };
    }
    return { status: "error", message: DECLARE_MESSAGES[res.error] ?? "La déclaration a échoué." };
  }

  revalidatePath(`/business/${slug}/mes-ventes`);
  return {
    status: "ok",
    publicRef: res.publicRef,
    totalCents: res.totalCents,
    commissionCents: res.commissionCents,
    duplicate: Boolean(res.duplicate),
    vehicle: res.vehicle,
  };
}

/* ── La caisse en grille: l'employé saisit les prix ───────────────────────────────────────────── */

const FREE_MESSAGES: Record<FreeDeclareError, string> = {
  not_free_entry: "Cette caisse ne fonctionne pas à la saisie libre. Rechargez la page.",
  no_ceiling:
    "Le plafond par tatouage n'est pas réglé pour ce salon. La direction doit le fixer depuis la page Tarifs avant qu'une vente puisse être déclarée.",
  rate_limited: "Trop de déclarations d'affilée. Patientez quelques instants.",
  empty: "Aucun prix saisi. Renseignez au moins un tatouage.",
  too_many_lines: "Trop de lignes sur un même ticket.",
  bad_slot: "Une des cases n'existe pas. Rechargez la page.",
  bad_price: "Un prix est invalide: mettez un montant entier supérieur à zéro.",
  over_ceiling: "Un prix dépasse le plafond fixé par la direction pour un tatouage.",
  too_large: "Le montant du ticket est hors limite. Faites plusieurs tickets.",
  ref_exhausted: "Impossible d'attribuer une référence. Réessayez.",
};

/**
 * DÉCLARER UNE VENTE À PRIX SAISIS. Le salon de tatouage.
 *
 * ⚠⚠ LA GRILLE EST RÉSOLUE ICI, DEPUIS LE MODÈLE DU COMMERCE, ET JAMAIS REÇUE DU NAVIGATEUR. C'est
 * ce qui décide du rayon, du nombre de cases et du texte des libellés - trois choses qui finissent
 * copiées dans l'historique de ventes. Un commerce sans grille est refusé, donc cette action ne peut
 * pas ouvrir la saisie libre sur un bar en devinant un slug.
 *
 * Le PLAFOND, lui, n'est pas ici: il vit sur `access` (résolu serveur) et c'est `declareFreeSale`
 * qui l'applique. Deux endroits pour deux raisons: la grille est une propriété du MODÈLE, le plafond
 * est une décision du PATRON.
 */
export async function declareFreeSaleAction(
  slug: string,
  input: { lines: { slot: number; priceDollars: number }[]; note?: string | null; clientRef: string },
): Promise<DeclareState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SALE_DECLARE);
  if (!access) return { status: "error", message: DECLARE_MESSAGES.denied! };

  const grid = templateGrid(access.template);
  if (!grid) return { status: "error", message: FREE_MESSAGES.not_free_entry };

  if (!Array.isArray(input?.lines)) return { status: "error", message: FREE_MESSAGES.empty };

  const res = await declareFreeSale(access, grid, {
    // ⚠ Les DOLLARS deviennent des CENTIMES ici, à la frontière serveur, et nulle part ailleurs -
    // même règle que le catalogue: les montants de ce portail sont des dollars ENTIERS, et
    // `money()` arrondit déjà tout affichage au dollar près. On arrondit PUIS on multiplie, sinon
    // 12,5 $ passerait en 1250 centimes, c'est-à-dire un prix à virgule que l'écran afficherait 13 $.
    lines: input.lines.map((l) => ({
      slot: Number(l?.slot),
      priceCents: Math.round(Number(l?.priceDollars)) * 100,
    })),
    note: input.note ?? null,
    clientRef: input.clientRef,
  });

  if (!res.ok) {
    const base = FREE_MESSAGES[res.error] ?? "La déclaration a échoué.";
    // Nommer la case fautive: sur vingt lignes, "un prix est invalide" est une devinette.
    return {
      status: "error",
      message: res.slot === undefined ? base : `Tatouage ${res.slot + 1}: ${base}`,
    };
  }

  revalidatePath(`/business/${slug}/mes-ventes`);
  return {
    status: "ok",
    publicRef: res.publicRef,
    totalCents: res.totalCents,
    commissionCents: res.commissionCents,
    duplicate: Boolean(res.duplicate),
  };
}

/* ── LA CAISSE CUSTOMS (garage, et concession depuis le 2026-08-27): chercher une voiture, la
 *    coter, déclarer. Les actions gardent leur nom historique "Garage"; la porte est
 *    `templateBillsCustoms`, pas le nom du modèle. ──────────────────────────────────────────────── */

/**
 * CHERCHER UNE VOITURE PAR SON NOM.
 *
 * ⚠⚠ NE RENVOIE JAMAIS LA VALEUR DU VÉHICULE. Décision du propriétaire (2026-08-23): *"don't display
 * car price itself on the mechanic lifeinvader"*. Ce n'est pas qu'un choix d'affichage: la valeur du
 * véhicule est l'ENTRÉE de la formule de prix, donc la publier permettrait de retrouver la marge par
 * simple division sur n'importe quelle ligne cotée. La liste ne porte que le nom, le code de spawn
 * et la classe.
 *
 * ⚠ `catalogue.read` et non `sale.declare`: chercher une voiture ne déclare rien, et un employé hors
 * service doit pouvoir préparer son ticket. C'est la déclaration qui exige le service.
 */
export async function searchGarageVehiclesAction(
  slug: string,
  query: string,
): Promise<{ name: string; model: string; classLabel: string }[]> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_READ);
  if (!access) return [];
  if (!templateBillsCustoms(access.template)) return [];

  return searchVehicles(String(query ?? "").slice(0, 40)).map((v) => ({
    name: v.name,
    model: v.model,
    classLabel: vehicleClassLabel(v.category),
  }));
}

export type GarageQuoteState =
  | { status: "idle" }
  | { status: "ok"; model: string; vehicleName: string; groups: QuotedGroup[] }
  | { status: "error"; message: string };

const QUOTE_MESSAGES: Record<string, string> = {
  unknown_model: "Ce véhicule n'existe pas. Relancez la recherche.",
  no_catalog:
    "La liste des modifications du jeu est illisible. Prévenez un développeur: rien ne peut être coté.",
  // ⚠ Ce message décrit une panne de CONFIGURATION, pas une erreur de l'employé, et il le dit.
  // Sans barème, le serveur refuse de coter plutôt que d'inventer une marge.
  no_global_rule:
    "Aucun barème de prix n'est configuré. Prévenez la direction du serveur: la facturation est à l'arrêt.",
};

/**
 * COTER TOUTES LES PRESTATIONS POUR UNE VOITURE, en un seul aller-retour.
 *
 * C'est ce qui fait que *"prices automatically display billing price"*: l'employé choisit la voiture
 * et les 92 lignes arrivent déjà chiffrées. Le navigateur n'envoie qu'un modèle et ne reçoit que des
 * prix, jamais les coefficients qui les produisent.
 *
 * ⚠ LE COÛT DES PIÈCES N'EST ENVOYÉ QU'À QUI PEUT DÉJÀ VOIR LES CHIFFRES DU COMMERCE (`team.read`).
 * Un employé voit ce qu'il facture, pas la marge: prix ET coût côte à côte redonnent la marge par
 * division, donc masquer la valeur du véhicule sans masquer le coût ne masquerait rien.
 */
export async function quoteGarageVehicleAction(
  slug: string,
  model: string,
): Promise<GarageQuoteState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.CATALOGUE_READ);
  if (!access) return { status: "error", message: "Accès refusé." };
  if (!templateBillsCustoms(access.template)) {
    return { status: "error", message: "Ce commerce ne facture pas de modifications." };
  }

  const quote = await quoteCustoms(String(model ?? ""), {
    withCost: businessCan(access, CAP.TEAM_READ),
  });
  if (!quote.ok) {
    return { status: "error", message: QUOTE_MESSAGES[quote.error] ?? "Cotation impossible." };
  }
  return {
    status: "ok",
    model: quote.vehicle.model,
    vehicleName: quote.vehicle.name,
    groups: quote.groups,
  };
}

const CUSTOM_MESSAGES: Record<string, string> = {
  ...DECLARE_MESSAGES,
  not_custom_business: "Ce commerce ne facture pas de modifications de véhicule.",
  unknown_model: "Ce véhicule n'existe pas. Relancez la recherche.",
  bad_custom: "Une prestation n'existe plus. Rechargez la page.",
  duplicate_custom: "La même prestation apparaît deux fois sur le ticket.",
  no_global_rule:
    "Aucun barème de prix n'est configuré. Prévenez la direction du serveur.",
  no_rule: "Aucun barème ne couvre cette prestation. Prévenez la direction du serveur.",
};

export async function declareCustomSaleAction(
  slug: string,
  input: {
    model: string;
    customs: CustomLineInput[];
    client: ClientRecordDraft | null;
    note?: string | null;
    clientRef: string;
  },
): Promise<DeclareState> {
  const identity = await requireIdentity();
  const access = await requireBusiness(identity, slug, CAP.SALE_DECLARE);
  if (!access) return { status: "error", message: CUSTOM_MESSAGES.denied };

  const res = await declareCustomSale(access, {
    model: String(input?.model ?? ""),
    customs: Array.isArray(input?.customs) ? input.customs : [],
    client: input?.client ?? null,
    note: input?.note ?? null,
    clientRef: String(input?.clientRef ?? ""),
  });

  if (!res.ok) {
    // La fiche client nomme le champ fautif, comme sur la caisse ordinaire: "la fiche est
    // incomplète" sur cinq champs est une devinette.
    if (res.error === "client_invalid" && "field" in res && res.field) {
      const label = CLIENT_FIELD_LABELS[res.field] ?? res.field;
      const problem =
        "problem" in res && res.problem
          ? clientProblemText(res.field, res.problem, clientRecordBounds())
          : "";
      return { status: "error", message: problem ? `${label}: ${problem}` : `${label}: valeur invalide.` };
    }
    return {
      status: "error",
      message: CUSTOM_MESSAGES[res.error] ?? "La déclaration a échoué.",
    };
  }

  revalidatePath(`/business/${slug}/mes-ventes`);
  return {
    status: "ok",
    publicRef: res.publicRef,
    totalCents: res.totalCents,
    commissionCents: res.commissionCents,
    duplicate: Boolean(res.duplicate),
    vehicle: res.vehicle,
  };
}
