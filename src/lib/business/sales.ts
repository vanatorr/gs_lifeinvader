/**
 * LES VENTES DÉCLARÉES: écriture et lecture.
 *
 * ⚠ UNE VENTE EST DÉCLARÉE, PAS MESURÉE, et tout ce fichier en découle. L'employé vend en RP, fait
 * sa facture à la main en jeu, et vient l'enregistrer ici. Rien côté serveur ne peut prouver qui a
 * vendu quoi: la caisse `pointOfSale` du jeu enregistre le CLIENT, jamais un vendeur. Ce qui EST
 * observable, c'est l'écart entre la somme des déclarations et le grand livre `gs_bank` du commerce,
 * et c'est une CORROBORATION à signaler au gérant, jamais une contrainte à imposer à l'employé.
 * Refuser une déclaration parce qu'elle ne colle pas au centime punirait le cas normal (un client
 * qui paie en plusieurs fois, un geste commercial) pour attraper un cas rare.
 *
 * Le portail ne paie personne et n'encaisse rien: aucun mouvement d'argent ne part d'ici.
 */
import "server-only";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isDuplicateKeyError } from "@/lib/db/dupKey";
import {
  citadelBusinessItems,
  citadelBusinessSaleLines,
  citadelBusinessSales,
} from "@/lib/db/schema/citadel";
import { insertedId } from "@/lib/db/insertId";
import { randomRefSuffix } from "@/lib/publicRef";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { unitCommissionCents as unitCommissionCents_, vehicleUnitCommissionCents } from "./commission";
import { vehicleCostCents, vehicleForJob, vehiclePriceCents } from "./fleet";
import { fleetPurchaseCostCents } from "./fleetCost";
import {
  clientRecordRequired,
  templateBillsCustoms,
  templateClientRecord,
  templateSellsVehicles,
  VEHICLE_CATEGORY_KEY,
} from "./templates";
import { quoteOne } from "./customMargin";
import {
  checkClientRecord,
  type ClientRecord,
  type ClientRecordDraft,
  type ClientRecordField,
  type ClientRecordProblem,
} from "./clientRecord";
import { clientRecordBounds } from "./clientRecordRules";
import {
  lookupSaleVehicle,
  parseVehicleMods,
  serializeVehicleMods,
  type SaleVehicleRecord,
  type SaleVehicleSnapshot,
} from "./vehicleLookup";
import type { VehicleMods } from "@/lib/data/vehicleMods";
import type { BusinessAccess } from "./access";

/**
 * Combien de déclarations par minute et par vendeur.
 *
 * Généreux exprès. Ce n'est pas une police du rythme de travail (un serveur qui rattrape sa soirée
 * en enchaîne légitimement une dizaine), c'est un plafond contre la boucle: un script ou un bouton
 * qui part en vrille écrirait des milliers de lignes avant que quiconque s'en aperçoive.
 */
const DECLARE_LIMIT = 20;
const DECLARE_WINDOW_MS = 60_000;

/** Bornes d'une ligne. Une quantité de 10 000 est une faute de frappe, jamais une commande. */
const MAX_QTY_PER_LINE = 999;
/** Articles DISTINCTS sur un ticket, après fusion des doublons. */
const MAX_LINES_PER_SALE = 60;
/** Lignes BRUTES acceptées avant fusion. Distinct de la limite ci-dessus, qui compte les articles. */
const MAX_RAW_LINES = 200;

/**
 * Plafond dur d'un ticket, en centimes.
 *
 * ⚠ Ce n'est pas une règle de gestion, c'est la borne de la COLONNE: `total_cents` et
 * `commission_cents` sont des `int` signés (2 147 483 647). Un total qui la dépasse ne produit pas
 * un gros chiffre, il produit une exception MySQL au milieu de la transaction, donc un échec brut
 * là où l'appelant attend un message en français. On refuse proprement avant d'y arriver.
 */
const MAX_TICKET_CENTS = 2_000_000_000;

/** Tentatives de génération de référence publique avant abandon. Voir declareSale. */
const REF_ATTEMPTS = 5;

export type DeclareLineInput = { itemId: number; qty: number };
export type DeclareVehicleInput = { model: string; qty: number };

/** Ce que la plaque a donné, en assez court pour tenir sur un ticket. */
export type DeclaredVehicle = {
  record: SaleVehicleRecord;
  modelLabel: string | null;
  classLabel: string | null;
  /** Combien de modifications ont été comptées. 0 sur une voiture d'origine, null si rien de lu. */
  modsTotal: number | null;
};

export type DeclareResult =
  | {
      ok: true;
      publicRef: string;
      totalCents: number;
      commissionCents: number;
      duplicate?: true;
      /**
       * CE QU'ON A TROUVÉ DERRIÈRE LA PLAQUE, renvoyé pour que le ticket imprimé le dise.
       *
       * ⚠ C'EST UN ACCUSÉ DE RÉCEPTION, PAS UNE DÉCORATION. Une plaque mal tapée s'enregistre
       * quand même (voir `lookupSaleVehicle`), et sans ce retour l'employé n'a AUCUN moyen de
       * s'apercevoir qu'il a écrit `46EEK527` au lieu de `46EEK572`: le ticket sort identique dans
       * les deux cas, et le patron découvre une fiche qui ne désigne aucune voiture des semaines
       * plus tard. Ici, l'écran affiche "plaque introuvable" tout de suite et la vente suivante est
       * faite correctement.
       *
       * Absent sur le rejeu d'un doublon: le ticket existait déjà, on ne relit pas sa voiture.
       */
      vehicle?: DeclaredVehicle;
    }
  | {
      ok: false;
      error: DeclareError;
      /**
       * Le champ de la fiche client qui cloche, et pourquoi. Renseignés SEULEMENT sur
       * `client_invalid`.
       *
       * ⚠ REMONTÉS JUSQU'À L'APPELANT AU LIEU D'ÊTRE APLATIS EN "fiche invalide", même raison que le
       * `slot` de `declareFreeSale` juste plus bas: sur cinq champs, un refus qui ne nomme pas le
       * champ fautif est une devinette, et une devinette sur un formulaire obligatoire fait retaper
       * les cinq.
       */
      field?: ClientRecordField;
      problem?: ClientRecordProblem;
    };

export type DeclareError =
  | "rate_limited"
  | "empty"
  | "too_many_lines"
  | "bad_qty"
  | "unknown_item"
  | "unknown_vehicle"
  | "too_large"
  | "ref_exhausted"
  | "client_required"
  | "client_invalid"
  | "too_many_vehicles";

/* Le rejeu du double-clic dépend de `isDuplicateKeyError` (lib/db/dupKey.ts), qui REMONTE LA CHAÎNE
 * DES CAUSES. Tester `e.code` sur l'erreur elle-même ne suffit pas et échoue en silence: drizzle
 * emballe l'erreur du pilote dans un `DrizzleQueryError`. La première version faisait ce test naïf, et
 * le résultat n'était pas une exception visible mais une DÉGRADATION: le double-clic, au lieu de rendre
 * poliment "déjà enregistrée", remontait une erreur brute à quelqu'un dont la vente venait justement de
 * passer. Attrapé en exerçant le rejeu pour de vrai (verify-business), jamais par relecture ni par le
 * typecheck. */

/**
 * DÉCLARER UNE VENTE. Le seul chemin d'écriture d'un ticket.
 *
 * L'appelant a DÉJÀ franchi `requireBusiness(identity, slug, CAP.SALE_DECLARE)`: cette fonction
 * suppose le droit acquis et ne le revérifie pas, mais elle ne fait confiance à AUCUNE valeur venue
 * du navigateur au-delà de "quel article, combien".
 *
 * Quatre protections, chacune contre une faute distincte:
 *
 *   1. LES PRIX VIENNENT DE LA BASE. Le client envoie des identifiants d'article et des quantités,
 *      jamais un montant. Accepter un prix affiché laisserait n'importe qui déclarer une tournée à
 *      un million, et la page n'est pas une frontière: un Server Action est un POST public.
 *   2. LES ARTICLES SONT LUS AVEC LEUR `business_id`. Sans ce filtre, un employé du bar pourrait
 *      déclarer des articles du garage d'à côté en devinant des identifiants. Le cloisonnement doit
 *      être DANS la requête, pas dans la page qui l'appelle.
 *   3. UN SEUL TRANSACTION pour le ticket et ses lignes. Une coupure entre les deux laisserait un
 *      ticket au bon total avec zéro ligne: le chiffre de la semaine serait juste et le détail
 *      introuvable, ce qui est pire qu'un échec franc.
 *   4. UNE CLÉ D'IDEMPOTENCE. Le double-clic est le geste le plus courant de l'interface; l'index
 *      unique le transforme en "déjà enregistré" au lieu d'un second ticket.
 */
export async function declareSale(
  access: BusinessAccess,
  input: {
    lines: DeclareLineInput[];
    vehicles?: DeclareVehicleInput[];
    /**
     * LA FICHE CLIENT: à qui, et sur quelle voiture. Exigée par le MODÈLE du commerce
     * (`templateClientRecord`), jamais par la présence ou l'absence de ce champ.
     *
     * ⚠ CE QUE LE NAVIGATEUR ENVOIE ICI EST DE LA SAISIE, PAS UNE AUTORITÉ, et c'est la seule
     * entrée de ce genre à côté du prix libre du salon de tatouage. La différence est qu'aucun
     * montant n'en dépend: une fiche fausse ne paie personne, elle rend juste la paperasse fausse.
     * Elle est donc normalisée et bornée (voir `checkClientRecord`), et le VÉHICULE qu'elle nomme
     * est ensuite relu dans la base de jeu plutôt que cru sur parole.
     */
    client?: Partial<ClientRecordDraft> | null;
    note?: string | null;
    clientRef: string;
    backdated?: boolean;
  },
): Promise<DeclareResult> {
  const gate = checkRateLimit(
    `business:declare:${access.businessId}:${access.identifier}`,
    DECLARE_LIMIT,
    DECLARE_WINDOW_MS,
  );
  if (!gate.allowed) return { ok: false, error: "rate_limited" };

  // ⚠ BORNER LE TABLEAU AVANT DE LE PARCOURIR. `merged.size` ne compte que les articles DISTINCTS,
  // donc il ne dit rien du nombre de lignes reçues: un tableau d'un million d'entrées passerait la
  // boucle entière avant d'être refusé.
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const rawVehicles = Array.isArray(input.vehicles) ? input.vehicles : [];
  if (rawLines.length + rawVehicles.length === 0) return { ok: false, error: "empty" };
  if (rawLines.length > MAX_RAW_LINES || rawVehicles.length > MAX_RAW_LINES) {
    return { ok: false, error: "too_many_lines" };
  }

  // Fusionner les doublons AVANT de valider: l'interface peut envoyer deux fois le même article, et
  // deux lignes identiques sur un ticket se lisent comme une erreur de saisie.
  const merged = new Map<number, number>();
  for (const l of rawLines) {
    const id = Number(l?.itemId);
    const qty = Math.trunc(Number(l?.qty));
    if (!Number.isFinite(id) || id <= 0) return { ok: false, error: "unknown_item" };
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_LINE) {
      return { ok: false, error: "bad_qty" };
    }
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  if (merged.size > MAX_LINES_PER_SALE) return { ok: false, error: "too_many_lines" };

  /**
   * ⚠⚠ REVALIDER LA QUANTITÉ **APRÈS** LA FUSION, et pas seulement ligne par ligne.
   *
   * C'est un vrai trou, trouvé par l'audit du 2026-08-08, pas une ceinture de sécurité. La boucle
   * ci-dessus plafonne CHAQUE ligne à 999, puis les additionne dans `merged`. Envoyer 501 fois le
   * MÊME article à 999 satisfait donc tous les contrôles existants: chaque ligne est sous le
   * plafond, et `merged.size` vaut 1, donc très en dessous de la limite d'articles distincts. Le
   * ticket enregistré porte 500 499 unités.
   *
   * Ce que ça coûte n'est pas cosmétique: `commission_cents` est le montant que l'employeur verse
   * en fin de semaine, et le total pollue le classement de l'équipe et le rapprochement avec le
   * grand livre. Une seule requête suffit, donc le plafond de cadence ne protège de rien ici.
   */
  for (const [, qty] of merged) {
    if (qty > MAX_QTY_PER_LINE) return { ok: false, error: "bad_qty" };
  }

  const mergedVehicles = new Map<string, number>();
  if (rawVehicles.length > 0) {
    // Un bar qui recevrait des modelName est refusé: la liste FleetRoster n'est pas un second
    // catalogue ouvert à tout le monde, c'est le stock D'UN métier.
    if (!templateSellsVehicles(access.template)) return { ok: false, error: "unknown_vehicle" };
    for (const v of rawVehicles) {
      const model = String(v?.model ?? "").trim().toLowerCase();
      const qty = Math.trunc(Number(v?.qty));
      if (!model) return { ok: false, error: "unknown_vehicle" };
      if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_LINE) {
        return { ok: false, error: "bad_qty" };
      }
      mergedVehicles.set(model, (mergedVehicles.get(model) ?? 0) + qty);
    }
    if (mergedVehicles.size > MAX_LINES_PER_SALE) return { ok: false, error: "too_many_lines" };
    for (const [, qty] of mergedVehicles) {
      if (qty > MAX_QTY_PER_LINE) return { ok: false, error: "bad_qty" };
    }
  }
  if (merged.size + mergedVehicles.size === 0) return { ok: false, error: "empty" };
  if (merged.size + mergedVehicles.size > MAX_LINES_PER_SALE) {
    return { ok: false, error: "too_many_lines" };
  }

  /**
   * ── LA FICHE CLIENT ──────────────────────────────────────────────────────────────────────────
   *
   * ⚠⚠ L'EXIGENCE VIENT DU MODÈLE DU COMMERCE, RÉSOLU SERVEUR, JAMAIS DE LA PRÉSENCE DU CHAMP DANS
   * LA REQUÊTE. C'est toute la différence entre une obligation et une suggestion: si l'absence de
   * `input.client` suffisait à s'en dispenser, il suffirait de ne pas l'envoyer. Un Server Action
   * est un POST public, donc "l'écran l'a demandé" ne veut rien dire ici.
   */
  const ticketVehicleUnits = [...mergedVehicles.values()].reduce((a, b) => a + b, 0);
  const recordMode = templateClientRecord(access.template);
  const recordRequired = clientRecordRequired(recordMode, ticketVehicleUnits > 0);

  const rawClient = input.client ?? null;
  // "Rien du tout" et "à moitié rempli" sont deux situations différentes: la première est légitime
  // sur un ticket de boutique, la seconde est toujours une erreur de saisie qu'il faut nommer.
  const clientTouched =
    rawClient !== null &&
    (["firstname", "lastname", "dob", "phone", "plate"] as const).some(
      (k) => String(rawClient[k] ?? "").trim() !== "",
    );

  if (recordRequired && !clientTouched) return { ok: false, error: "client_required" };

  /**
   * ⚠ UN SEUL VÉHICULE PAR TICKET QUAND LA FICHE EST EXIGÉE, et ce n'est pas une limite arbitraire:
   * la fiche porte UNE plaque. Deux voitures sous une seule plaque produiraient un document qui
   * affirme quelque chose de faux sur au moins l'une des deux, et c'est précisément le document
   * qu'on est en train de créer pour qu'on puisse s'y fier. Deux voitures vendues = deux tickets,
   * ce qui est aussi la réalité: chacune a sa plaque et son acheteur.
   *
   * ⚠ La boutique n'est pas concernée: un ticket peut porter la voiture ET ses accessoires.
   */
  if (recordRequired && ticketVehicleUnits > 1) return { ok: false, error: "too_many_vehicles" };

  let clientRecord: ClientRecord | null = null;
  if (clientTouched) {
    // Les bornes viennent des fichiers du jeu (gs_identity / gcphone), jamais d'ici. Voir
    // clientRecordRules.ts.
    const check = checkClientRecord(rawClient, clientRecordBounds());
    if (!check.ok) {
      return { ok: false, error: "client_invalid", field: check.field, problem: check.problem };
    }
    clientRecord = check.value;
  }

  // Protections 1 et 2: prix et part lus en base, et cloisonnés par commerce DANS la requête.
  const items =
    merged.size === 0
      ? []
      : await db
          .select({
            id: citadelBusinessItems.id,
            label: citadelBusinessItems.label,
            category: citadelBusinessItems.category,
            priceCents: citadelBusinessItems.priceCents,
            commissionCents: citadelBusinessItems.commissionCents,
          })
          .from(citadelBusinessItems)
          .where(
            and(
              eq(citadelBusinessItems.businessId, access.businessId),
              eq(citadelBusinessItems.active, true),
              inArray(citadelBusinessItems.id, [...merged.keys()]),
            ),
          );
  if (items.length !== merged.size) return { ok: false, error: "unknown_item" };

  // La part employé n'est comptée que si le module est allumé: éteint, elle ne doit pas s'accumuler
  // en silence pour réapparaître le jour où quelqu'un le rallume.
  const withCommission = access.modules.commissions !== false;

  /**
   * ⚠⚠ LE TAUX VIENT DE `access`, RÉSOLU CÔTÉ SERVEUR, JAMAIS DE LA REQUÊTE. C'est la protection 1 de
   * l'en-tête appliquée à la part: le navigateur envoie des identifiants d'article et des quantités,
   * point. Accepter un taux du client laisserait n'importe quel employé se déclarer à 100 % - et
   * contrairement à un prix gonflé, qui saute aux yeux sur le ticket, une part gonflée ne se voit que
   * sur la paie de fin de semaine, une fois versée.
   *
   * ⚠ ET ELLE EST FIGÉE SUR LA LIGNE, comme le prix. `unit_commission_cents` est une COPIE DATÉE:
   * remonter le taux d'un artiste demain ne doit pas réécrire ce qu'il a gagné hier, exactement pour
   * la même raison qu'un changement de prix ne réécrit pas le chiffre d'affaires de la semaine
   * dernière. C'est aussi ce qui permet au mode de changer sans rendre l'historique illisible.
   */
  const byRate = withCommission && access.commission.mode === "pourcentage";

  let totalCents = 0;
  let commissionCents = 0;
  const lines: CommitLine[] = items.map((it) => {
    const qty = merged.get(it.id) as number;
    const unitCommission = !withCommission
      ? 0
      : byRate
        ? unitCommissionCents_(it.priceCents, access.commission.bps)
        : it.commissionCents;
    totalCents += it.priceCents * qty;
    commissionCents += unitCommission * qty;
    return {
      itemId: it.id,
      // Copies datées: un prix qui change demain ne doit pas réécrire le chiffre d'hier.
      label: it.label,
      category: it.category,
      qty,
      unitPriceCents: it.priceCents,
      unitCommissionCents: unitCommission,
    };
  });

  for (const [model, qty] of mergedVehicles) {
    const row = vehicleForJob(access.job, model);
    if (!row) return { ok: false, error: "unknown_vehicle" };
    const unitPrice = vehiclePriceCents(row);
    /**
     * ⚠ LE COUT EST CELUI QUE L'ENTREPRISE A REELLEMENT PAYE, sinon le catalogue. JAMAIS la requete,
     * jamais un reglage du patron. Meme protection que le prix juste au-dessus: un cout choisi par
     * l'employe (ou par un POST forge) serait un curseur direct sur sa propre paie, puisque la prime
     * vaut un pourcentage de `prix - cout`.
     *
     * Demande du proprietaire (2026-08-27): *"jte parle des cout de achat que le job les achete pour
     * calculer le profit"*. La ligne d'achat (`job_vehicle_purchases`, ecrite par le kiosque du jeu)
     * dit ce que CETTE voiture a coute, la ou le catalogue ne dit que ce que le modele coute
     * aujourd'hui. Les deux divergent des qu'un prix bouge, et le catalogue reecrirait alors une
     * marge passee.
     *
     * ⚠ LE REPLI EST LE CATALOGUE (`vehicleCostCents`, qui retombe lui-meme sur le prix client),
     * JAMAIS ZERO: un cout nul affirmerait un benefice egal au prix. Une voiture sans ligne d'achat
     * (flotte d'avant la table, voiture recuperee autrement) vaut donc zero de benefice, pas tout.
     *
     * ⚠ LA PLAQUE VIENT DE LA FICHE, DONC DE L'EMPLOYE: `fleetPurchaseCostCents` exige que la ligne
     * d'achat appartienne a SON metier et porte le MEME modele, sinon elle est ignoree. Sans ces
     * verrous, taper la plaque d'une Sanchez en vendant une supercar s'attribuerait tout le prix en
     * benefice.
     */
    const paid = clientRecord ? await fleetPurchaseCostCents(access.job, clientRecord.plate, row.name) : null;
    const unitCost = paid ?? vehicleCostCents(row);
    const unitMargin = Math.max(0, unitPrice - unitCost);
    const unitCommission = !withCommission
      ? 0
      : vehicleUnitCommissionCents(unitMargin, access.commission.vehicleBps);
    totalCents += unitPrice * qty;
    commissionCents += unitCommission * qty;
    lines.push({
      itemId: null,
      label: row.name.slice(0, 120),
      category: VEHICLE_CATEGORY_KEY,
      qty,
      unitPriceCents: unitPrice,
      unitCommissionCents: unitCommission,
      // Copie datee, comme le prix: le ticket doit rester lisible meme si le catalogue du jeu
      // rebaisse ce modele demain. C'est aussi ce qui rend le benefice verifiable apres coup, au
      // lieu d'etre recalculable seulement par celui qui connait la version du catalogue du jour.
      unitCostCents: unitCost,
    });
  }

  // Le total est calculé à partir de la base, mais il reste borné par ce que la colonne accepte.
  if (totalCents > MAX_TICKET_CENTS || commissionCents > MAX_TICKET_CENTS) {
    return { ok: false, error: "too_large" };
  }

  /**
   * ⚠ LA VOITURE EST RELUE DANS LA BASE DE JEU, PAS DÉCRITE PAR L'EMPLOYÉ. Le navigateur n'envoie
   * qu'une PLAQUE; le modèle, la classe et les customs viennent d'`owned_vehicles`. C'est la même
   * protection que "les prix viennent de la base" appliquée à la fiche: une liste de modifications
   * saisie à la main serait à la fois impossible à remplir honnêtement après chaque réparation et
   * impossible à croire ensuite.
   *
   * ⚠ ET ÇA NE PEUT PAS FAIRE ÉCHOUER LA DÉCLARATION. Une plaque absente d'`owned_vehicles` est le
   * cas NORMAL d'une concession qui déclare avant la livraison; `lookupSaleVehicle` ne jette jamais
   * et rend `absent` / `unreadable`, qu'on enregistre tel quel plutôt que de bloquer une vente
   * réelle sur une lecture qui n'a rien d'anormal.
   */
  const vehicleSnapshot = clientRecord ? await lookupSaleVehicle(clientRecord.plate) : null;

  return commitSale(access, {
    lines,
    totalCents,
    commissionCents,
    note: input.note,
    clientRef: input.clientRef,
    backdated: input.backdated,
    client: clientRecord,
    vehicle: vehicleSnapshot,
  });
}

/** Une ligne prête à écrire. Prix et part sont déjà DÉCIDÉS par l'appelant, jamais recalculés ici. */
type CommitLine = {
  itemId: number | null;
  label: string;
  category: string;
  qty: number;
  unitPriceCents: number;
  unitCommissionCents: number;
  /**
   * Le cout de revient de la ligne, en centimes. Absent partout sauf sur une ligne de custom.
   *
   * ⚠ `undefined` ET `0` NE SONT PAS LA MEME CHOSE. Une tournee de bar n'a pas de cout mesurable et
   * laisse la colonne a NULL; ecrire 0 affirmerait une marge de 100 % sur une ligne dont personne
   * n'a jamais connu le prix de revient. Voir `unit_cost_cents` dans le schema.
   */
  unitCostCents?: number | null;
};

/**
 * ÉCRIRE LE TICKET: la moitié commune aux deux chemins de déclaration.
 *
 * ⚠ FACTORISÉE, ET SEULEMENT ELLE. Ce qui est partagé ici est le mécanisme d'écriture (transaction,
 * référence publique, idempotence), pas la DÉCISION du prix - qui est justement ce qui sépare
 * `declareSale` (prix lus en base) de `declareFreeSale` (prix saisis par l'employé, plafonnés).
 * Mélanger les deux moitiés ferait un seul chemin avec un drapeau, et un drapeau qu'on oublie de
 * poser ouvre le mode le plus permissif par défaut.
 *
 * Générer-et-réessayer, jamais vérifier-puis-insérer: ce dernier est une course, deux ventes
 * simultanées pouvant lire "libre" pour la même référence. L'unicité vit dans l'index.
 *
 * ⚠ Une collision sur `client_ref` n'est PAS un échec: c'est le double-clic, et la bonne réponse
 * est de dire "déjà enregistrée" en rendant le ticket existant, pas d'afficher une erreur à
 * quelqu'un dont la vente est passée.
 */
async function commitSale(
  access: BusinessAccess,
  input: {
    lines: CommitLine[];
    totalCents: number;
    commissionCents: number;
    note?: string | null;
    clientRef: string;
    backdated?: boolean;
    /**
     * La fiche client, déjà validée et normalisée par l'appelant. `null` = ce ticket n'en porte pas,
     * ce qui est le cas de tous les commerces dont le modèle n'en demande pas.
     *
     * ⚠ NORMALISÉE EN AMONT, JAMAIS ICI, exactement comme le prix des lignes: cette fonction écrit
     * ce qu'on lui donne et ne DÉCIDE de rien. Y remettre une validation en ferait une seconde
     * autorité, donc deux règles à tenir en phase.
     */
    client?: ClientRecord | null;
    vehicle?: SaleVehicleSnapshot | null;
  },
): Promise<DeclareResult> {
  const note = (typeof input.note === "string" ? input.note : "").trim().slice(0, 300) || null;
  const { totalCents, commissionCents } = input;

  /**
   * LE BENEFICE DU TICKET, derive des lignes ICI et jamais passe par l'appelant.
   *
   * ⚠ CALCULE AU POINT DE PASSAGE UNIQUE, exactement pour qu'il ne puisse pas diverger. Les trois
   * chemins de declaration (`declareSale`, `declareFreeSale`, `declareCustomSale`) aboutissent tous
   * ici; le faire calculer par chacun d'eux, ce serait trois occasions d'oublier, et un oubli
   * n'echouerait pas - il ecrirait simplement 0, c'est-a-dire "cette vente n'a rien rapporte", ce
   * que personne ne relirait.
   *
   * ⚠ SEULES LES LIGNES QUI PORTENT UN COUT COMPTENT. `unitCostCents` absent veut dire "cout de
   * revient inconnu" (une tournee de bar), pas "cout nul": le traiter comme zero affirmerait un
   * benefice egal au prix, soit le bug de prime concession du 2026-08-27 ressuscite dans le rapport.
   */
  const marginCents = input.lines.reduce((acc, l) => {
    const cost = l.unitCostCents;
    if (typeof cost !== "number") return acc;
    return acc + Math.max(0, l.unitPriceCents - cost) * l.qty;
  }, 0);

  /**
   * Les colonnes de la fiche, ou des NULL francs.
   *
   * ⚠ TOUT OU RIEN. Sans fiche, les onze colonnes valent NULL: écrire une plaque sans identité, ou
   * un modèle sans plaque, produirait une fiche partielle qu'un gérant lirait comme une saisie
   * bâclée alors que ce serait notre écriture qui l'est. `client` est validée en bloc en amont, donc
   * elle est ici soit entière soit absente, et ces colonnes suivent.
   *
   * ⚠ `vehicle_record` VAUT NULL QUAND IL N'Y A PAS DE FICHE, et jamais `absent`. Les deux se
   * lisent pareil de loin et ne disent pas du tout la même chose: NULL = "ce ticket ne parle pas
   * d'une voiture" (un bar), `absent` = "on a cherché cette plaque et on ne l'a pas trouvée".
   */
  const client = input.client ?? null;
  const vehicle = client ? (input.vehicle ?? null) : null;
  const fiche = {
    clientFirstname: client?.firstname ?? null,
    clientLastname: client?.lastname ?? null,
    clientDob: client?.dob ?? null,
    clientPhone: client?.phone ?? null,
    vehiclePlate: client?.plate ?? null,
    vehicleRecord: vehicle?.record ?? null,
    vehicleModel: vehicle?.modelLabel ?? null,
    vehicleModelName: vehicle?.modelName ?? null,
    vehicleClass: vehicle?.classLabel ?? null,
    vehicleFleetJob: vehicle?.fleetJob ?? null,
    vehicleMods: serializeVehicleMods(vehicle?.mods ?? null),
  };

  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
    const publicRef = `#V-${randomRefSuffix()}`;
    try {
      // Protection 3: le ticket et ses lignes, ou rien.
      const saleId = await db.transaction(async (tx) => {
        const res = await tx.insert(citadelBusinessSales).values({
          businessId: access.businessId,
          publicRef,
          clientRef: input.clientRef,
          sellerIdentifier: access.identifier,
          sellerName: access.employeeName,
          totalCents,
          commissionCents,
          marginCents,
          backdated: Boolean(input.backdated),
          note,
          ...fiche,
        });
        const id = insertedId(res);
        await tx.insert(citadelBusinessSaleLines).values(input.lines.map((l) => ({ ...l, saleId: id })));
        return id;
      });
      void saleId;
      return {
        ok: true,
        publicRef,
        totalCents,
        commissionCents,
        ...(vehicle
          ? {
              vehicle: {
                record: vehicle.record,
                modelLabel: vehicle.modelLabel,
                classLabel: vehicle.classLabel,
                modsTotal: vehicle.mods?.total ?? null,
              } satisfies DeclaredVehicle,
            }
          : {}),
      };
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;

      // Distinguer les DEUX index uniques: le rejeu du même geste contre une référence malchanceuse.
      const existing = await db
        .select({
          publicRef: citadelBusinessSales.publicRef,
          totalCents: citadelBusinessSales.totalCents,
          commissionCents: citadelBusinessSales.commissionCents,
        })
        .from(citadelBusinessSales)
        .where(
          and(
            eq(citadelBusinessSales.businessId, access.businessId),
            eq(citadelBusinessSales.clientRef, input.clientRef),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return {
          ok: true,
          publicRef: existing[0].publicRef,
          totalCents: existing[0].totalCents,
          commissionCents: existing[0].commissionCents,
          duplicate: true,
        };
      }
      // Sinon c'est `public_ref` qui a collisionné: on retire une référence.
    }
  }
  // Épuiser cinq tirages sur 1 048 576 veut dire que REF_RANDOM_LENGTH est devenu trop court pour
  // le volume, pas qu'il faut boucler plus longtemps. Échouer franchement est la bonne réponse.
  return { ok: false, error: "ref_exhausted" };
}

/* ── La caisse en grille: l'employé saisit les prix ───────────────────────────────────────────── */

/** Une case remplie à la caisse: son NUMÉRO et le prix tapé. Rien d'autre ne vient du navigateur. */
export type FreeLineInput = { slot: number; priceCents: number };

export type FreeDeclareError =
  | "not_free_entry"
  | "no_ceiling"
  | "rate_limited"
  | "empty"
  | "too_many_lines"
  | "bad_slot"
  | "bad_price"
  | "over_ceiling"
  | "too_large"
  | "ref_exhausted";

export type FreeDeclareResult =
  | { ok: true; publicRef: string; totalCents: number; commissionCents: number; duplicate?: true }
  | { ok: false; error: FreeDeclareError; slot?: number };

/**
 * DÉCLARER UNE VENTE DONT L'EMPLOYÉ A TAPÉ LES PRIX. Le salon de tatouage, et rien d'autre.
 *
 * ⚠⚠ UNE FONCTION SOEUR NOMMÉE, PAS UN DRAPEAU SUR `declareSale`, et c'est le même raisonnement que
 * `topProducts` / `productTotals` plus bas dans ce fichier: rendre le mode optionnel sur la fonction
 * existante ferait qu'un appelant qui OUBLIE un argument tombe dans le mode le plus permissif. Ici
 * le mode permissif est "le navigateur fixe les montants". Il doit être IMPOSSIBLE d'y arriver sans
 * l'avoir écrit noir sur blanc.
 *
 * Ce qui remplace la protection "les prix viennent de la base", puisqu'ici ils n'en viennent pas:
 *
 *   1. LE COMMERCE DOIT DÉCLARER UNE GRILLE. Un bar qui recevrait cet appel est refusé, donc la
 *      saisie libre ne peut pas être ouverte par une requête forgée sur un commerce ordinaire.
 *   2. UN PLAFOND PAR LIGNE, LU EN BASE, JAMAIS DANS LA REQUÊTE. C'est le garde-fou principal: la
 *      part employé est un POURCENTAGE de ce que l'employé vient de taper, donc sans plafond
 *      "je tape mon prix" est exactement "je tape ma paie". Sans plafond résoluble, on REFUSE la
 *      vente au lieu de supposer qu'il n'y en a pas.
 *   3. LE NUMÉRO DE CASE EST BORNÉ PAR LA GRILLE, et le LIBELLÉ est fabriqué par le serveur à
 *      partir de ce numéro. Le client ne choisit ni le rayon, ni le texte qui finira dans
 *      l'historique de tout le monde.
 *   4. UNE CASE NE PEUT PARAÎTRE QU'UNE FOIS. Deux lignes pour la case 3 ne veulent rien dire (une
 *      case est UN tatouage) et seraient le moyen évident de contourner le plafond.
 *
 * Le reste (cadence, idempotence, transaction) est celui de `declareSale`, via `commitSale`.
 */
export async function declareFreeSale(
  access: BusinessAccess,
  grid: { slots: number; category: string; labelPrefix: string },
  input: { lines: FreeLineInput[]; note?: string | null; clientRef: string },
): Promise<FreeDeclareResult> {
  const gate = checkRateLimit(
    `business:declare:${access.businessId}:${access.identifier}`,
    DECLARE_LIMIT,
    DECLARE_WINDOW_MS,
  );
  if (!gate.allowed) return { ok: false, error: "rate_limited" };

  // Protection 2. `access.lineMaxCents` est résolu côté serveur (voir access.ts) et vaut null quand
  // le commerce n'est pas en saisie libre - auquel cas on n'a rien à faire ici.
  const ceiling = access.lineMaxCents;
  if (ceiling === null || !Number.isInteger(ceiling) || ceiling <= 0) {
    return { ok: false, error: "no_ceiling" };
  }

  if (!Array.isArray(input.lines)) return { ok: false, error: "empty" };
  if (input.lines.length > grid.slots) return { ok: false, error: "too_many_lines" };

  const seen = new Set<number>();
  const lines: CommitLine[] = [];
  let totalCents = 0;
  let commissionCents = 0;

  // La part n'est comptée que si le module est allumé, et un commerce en grille n'a aucun article,
  // donc aucune part FIXE possible: seul le pourcentage a un sens ici. `setCommissionAction` force
  // d'ailleurs ce mode pour un commerce en grille, ce qui rend cette branche cohérente des deux côtés.
  const rate =
    access.modules.commissions !== false && access.commission.mode === "pourcentage"
      ? access.commission.bps
      : 0;

  for (const raw of input.lines) {
    const slot = Math.trunc(Number(raw?.slot));
    if (!Number.isInteger(slot) || slot < 0 || slot >= grid.slots) {
      return { ok: false, error: "bad_slot", slot };
    }
    if (seen.has(slot)) return { ok: false, error: "bad_slot", slot };
    seen.add(slot);

    /**
     * ⚠ UN MONTANT ENTIER, ET EN DOLLARS ENTIERS. Pas de `Math.trunc` de politesse: tronquer
     * accepterait 1,5 centime comme 1 centime, c'est-à-dire écrirait un ticket que personne n'a
     * voulu. Et le multiple de 100 n'est pas une coquetterie non plus - `money()` et `priceParts()`
     * arrondissent TOUT affichage au dollar près, donc un prix à 12,50 $ se lirait 13 $ partout tout
     * en étant enregistré à 12,50 $, un écart permanent entre ce qu'on lit et ce qu'on doit. Le
     * formulaire convertit déjà des dollars entiers; cette vérification est là parce que la frontière
     * de sécurité ne doit rien devoir à la bonne conduite de son appelant.
     */
    const priceCents = Number(raw?.priceCents);
    if (!Number.isInteger(priceCents) || priceCents <= 0 || priceCents % 100 !== 0) {
      return { ok: false, error: "bad_price", slot };
    }
    if (priceCents > ceiling) return { ok: false, error: "over_ceiling", slot };

    totalCents += priceCents;
    const unitCommissionCents = unitCommissionCents_(priceCents, rate);
    commissionCents += unitCommissionCents;

    lines.push({
      // ⚠ Aucun article derrière: `item_id` reste NULL, ce que le schéma prévoit déjà. L'analytique
      // groupe alors sur `(category, label)` (voir `topProducts`), donc "Tatouage 7" se compare bien
      // d'une vente à l'autre - c'est pour ça que le libellé est déterministe et pas décoratif.
      itemId: null,
      label: `${grid.labelPrefix} ${slot + 1}`,
      category: grid.category,
      qty: 1,
      unitPriceCents: priceCents,
      unitCommissionCents,
    });
  }

  if (lines.length === 0) return { ok: false, error: "empty" };
  if (totalCents > MAX_TICKET_CENTS || commissionCents > MAX_TICKET_CENTS) {
    return { ok: false, error: "too_large" };
  }

  const res = await commitSale(access, {
    lines,
    totalCents,
    commissionCents,
    note: input.note,
    clientRef: input.clientRef,
  });
  return res.ok ? res : { ok: false, error: res.error as FreeDeclareError };
}

/* ── Lectures ─────────────────────────────────────────────────────────────────────────────────── */

export type SaleRow = {
  id: number;
  publicRef: string;
  sellerIdentifier: string;
  sellerName: string;
  totalCents: number;
  commissionCents: number;
  /**
   * Le benefice mesurable de CE ticket. Voir `margin_cents` dans le schema.
   *
   * ⚠ 0 N'EST PAS "AUCUNE MARGE": c'est "aucune ligne de ce ticket ne porte de cout de revient".
   * Un ticket de bar vaut 0 pour toujours, un ticket de concession anterieur au 2026-08-27 aussi.
   * L'ecran ne doit donc afficher ce chiffre que la ou un cout est reellement enregistre.
   */
  marginCents: number;
  backdated: boolean;
  note: string | null;
  declaredAt: Date;
  /**
   * LA FICHE CLIENT, ou `null` quand ce ticket n'en porte pas.
   *
   * ⚠ UN SEUL OBJET NULLABLE ET NON ONZE CHAMPS À CÔTÉ, parce que ces colonnes sont écrites en bloc
   * ou pas du tout (voir `commitSale`). Les rendre à plat obligerait chaque écran à redécider
   * lui-même ce que "un prénom sans plaque" veut dire, et quatre écrans finiraient par répondre
   * différemment à une situation qui n'existe pas.
   */
  client: SaleClientRecord | null;
};

/** La fiche telle qu'on la relit. Les libellés sont des COPIES DATÉES, pas une vue sur le jeu. */
export type SaleClientRecord = {
  firstname: string;
  lastname: string;
  dob: string;
  phone: string;
  plate: string;
  vehicle: {
    /** Voir `SaleVehicleRecord`: `absent` n'est pas "aucune option", c'est "pas trouvée". */
    record: SaleVehicleRecord;
    modelLabel: string | null;
    modelName: string | null;
    classLabel: string | null;
    fleetJob: string | null;
    mods: VehicleMods | null;
  };
};

/**
 * Recomposer la fiche depuis les colonnes plates d'une ligne de vente.
 *
 * ⚠ LA FICHE N'EXISTE QUE SI L'IDENTITÉ ET LA PLAQUE SONT LÀ. Une ligne d'historique antérieure à
 * cette fonctionnalité porte onze NULL, et une ligne à moitié remplie ne devrait pas exister (voir
 * `commitSale`); dans les deux cas on rend `null` plutôt que de fabriquer une fiche avec des trous,
 * qui s'afficherait comme une saisie incomplète imputée à l'employé.
 */
function toClientRecord(r: {
  clientFirstname: string | null;
  clientLastname: string | null;
  clientDob: string | null;
  clientPhone: string | null;
  vehiclePlate: string | null;
  vehicleRecord: SaleVehicleRecord | null;
  vehicleModel: string | null;
  vehicleModelName: string | null;
  vehicleClass: string | null;
  vehicleFleetJob: string | null;
  vehicleMods: string | null;
}): SaleClientRecord | null {
  if (!r.clientFirstname || !r.clientLastname || !r.vehiclePlate) return null;
  return {
    firstname: r.clientFirstname,
    lastname: r.clientLastname,
    dob: r.clientDob ?? "",
    phone: r.clientPhone ?? "",
    plate: r.vehiclePlate,
    vehicle: {
      // Une fiche écrite avant que la colonne existe, ou dont la lecture a échoué, n'est pas une
      // voiture d'origine: `unreadable` est le repli honnête, jamais `found`.
      record: r.vehicleRecord ?? "unreadable",
      modelLabel: r.vehicleModel,
      modelName: r.vehicleModelName,
      classLabel: r.vehicleClass,
      fleetJob: r.vehicleFleetJob,
      mods: parseVehicleMods(r.vehicleMods),
    },
  };
}

/**
 * Les ventes d'un commerce sur une fenêtre.
 *
 * ⚠ `businessId` est TOUJOURS dans le WHERE, jamais laissé à la page. Un filtre de cloisonnement
 * qui vit dans l'appelant est un filtre qu'un futur appelant oubliera.
 *
 * `seller` restreint à une personne: c'est ce qui sépare `sale.read.self` (ses propres ventes, un
 * droit de base) de `team.read` (celles des collègues, un droit sensible). L'appelant choisit selon
 * la capacité qu'il a vérifiée; les deux lectures passent par la même requête pour qu'elles ne
 * puissent pas diverger.
 */
/* -- LA CAISSE DU GARAGE: declarer des modifications au bareme ---------------------------------- */

export type CustomLineInput = { slotKey: string; level: number };

export type CustomDeclareResult =
  | DeclareResult
  | {
      ok: false;
      error: "not_custom_business" | "unknown_model" | "bad_custom" | "duplicate_custom" | "no_rule";
      slotKey?: string;
    };

/**
 * DECLARER DES MODIFICATIONS DE VEHICULE. Le garage et, depuis le 2026-08-27, la concession:
 * tout modele qui pose `billsCustoms`, et rien d'autre.
 *
 * Demande du proprietaire (2026-08-23): "how would we make it so in lifeinvader all of them can get
 * declared there? they just chose the car by smart name search and prices automaticcly display
 * billing price". Puis (2026-08-27) la concession a recu le meme volet: "and also be able to do
 * customs with required customer info".
 *
 * ⚠⚠ UNE TROISIEME FONCTION SOEUR NOMMEE, PAS UN DRAPEAU SUR `declareSale`, exactement pour la
 * raison ecrite en tete de `declareFreeSale`: rendre le mode optionnel ferait qu'un appelant qui
 * OUBLIE un argument tombe dans un autre mode de prix. Ici la difference n'est pas la permissivite,
 * c'est la SOURCE du prix - ni un catalogue, ni une saisie, mais un calcul. Trois sources, trois
 * portes nommees.
 *
 * CE QUI REMPLACE "LES PRIX VIENNENT DE LA BASE", puisqu'ils ne viennent pas d'une table d'articles:
 *
 *   1. LE MODELE DU COMMERCE DOIT DECLARER `billsCustoms`. Un bar qui recevrait cet appel est
 *      refuse, donc ce chemin de prix ne s'ouvre pas par une requete forgee sur un commerce
 *      ordinaire. Resolu serveur, jamais recu du navigateur.
 *   2. LE NAVIGATEUR N'ENVOIE AUCUN MONTANT. Il envoie un modele et des couples (slot, palier); le
 *      prix est RE-CALCULE ici par `quoteOne`, au moment du commit. Le prix affiche a l'employe ne
 *      fait donc autorite sur rien: entre l'affichage et la validation, le bareme a pu changer.
 *   3. CHAQUE CUSTOM AU PLUS UNE FOIS. Deux lignes pour le meme (slot, palier) ne veulent rien dire
 *      - on ne pose pas deux fois le meme moteur - et seraient le moyen evident de gonfler un
 *      ticket. Meme protection, et meme raison, que l'unicite des cases de la grille.
 *   4. LA FICHE CLIENT EST OBLIGATOIRE: un ticket de customs porte une voiture par construction,
 *      donc `clientRecordRequired(mode, true)` l'exige sous les deux modes de fiche ('always'
 *      comme 'with-vehicle'). C'est elle qui porte la plaque, donc ce qui rend le ticket
 *      retrouvable plus tard. verify:business prouve l'invariant pour chaque modele `billsCustoms`.
 *
 * ⚠⚠ LA PART EMPLOYE EST UN POURCENTAGE DE LA MARGE, PAS DU PRIX, ET C'EST LA SEULE FORME SURE ICI.
 * Sur un moteur 4 de Primo facture 8 210 $, les pieces en ont deja coute 6 842 $ a la societe (elle
 * les paie au jeu, `ChargeBusinessAccount` dans esx_lscustom/server/main.lua), donc le benefice reel
 * est de 1 368 $. Une part de 20 % du PRIX vaudrait 1 642 $, c'est-a-dire PLUS que tout le benefice:
 * le garage paierait son employe pour perdre de l'argent, sur chaque grosse piece, et le patron ne
 * le verrait qu'en fin de semaine. C'est exactement le raisonnement que la CONCESSION a fini par
 * adopter aussi, le 2026-08-27: sa prime vehicule est passee d'un pourcentage du prix catalogue a un
 * pourcentage de `prix client - prix concession`. La part est en outre bornee a la marge, pour qu'un
 * taux mal regle plafonne au lieu de creuser.
 */
export async function declareCustomSale(
  access: BusinessAccess,
  input: {
    model: string;
    customs: CustomLineInput[];
    client: ClientRecordDraft | null;
    note?: string | null;
    clientRef: string;
    backdated?: boolean;
  },
): Promise<CustomDeclareResult> {
  const gate = checkRateLimit(
    `business:declare:${access.businessId}:${access.identifier}`,
    DECLARE_LIMIT,
    DECLARE_WINDOW_MS,
  );
  if (!gate.allowed) return { ok: false, error: "rate_limited" };

  // Protection 1.
  if (!templateBillsCustoms(access.template)) return { ok: false, error: "not_custom_business" };

  if (!Array.isArray(input.customs) || input.customs.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (input.customs.length > MAX_LINES_PER_SALE) return { ok: false, error: "too_many_lines" };

  // Protection 4: la fiche, validee exactement comme dans `declareSale` (memes bornes, memes
  // messages), parce qu'un employe ne doit pas rencontrer deux grammaires selon l'ecran.
  const recordRequired = clientRecordRequired(templateClientRecord(access.template), true);
  const rawClient = input.client ?? null;
  const clientTouched =
    rawClient !== null &&
    (["firstname", "lastname", "dob", "phone", "plate"] as const).some(
      (k) => String(rawClient[k] ?? "").trim() !== "",
    );
  if (recordRequired && !clientTouched) return { ok: false, error: "client_required" };

  let clientRecord: ClientRecord | null = null;
  if (clientTouched) {
    const check = checkClientRecord(rawClient, clientRecordBounds());
    if (!check.ok) {
      return { ok: false, error: "client_invalid", field: check.field, problem: check.problem };
    }
    clientRecord = check.value;
  }

  /**
   * La part employe: le POURCENTAGE du commerce, applique a la marge (voir l'avertissement en tete).
   * Un commerce en mode `montant` n'a pas de part fixe possible sur un custom, faute d'article de
   * catalogue derriere: la part vaut alors zero, exactement comme dans `declareFreeSale`.
   */
  const rate =
    access.modules.commissions !== false && access.commission.mode === "pourcentage"
      ? access.commission.bps
      : 0;

  const seen = new Set<string>();
  const lines: CommitLine[] = [];
  let totalCents = 0;
  let commissionCents = 0;

  for (const raw of input.customs) {
    const slotKey = String(raw?.slotKey ?? "");
    const level = Math.trunc(Number(raw?.level));
    if (!slotKey || !Number.isInteger(level)) return { ok: false, error: "bad_custom", slotKey };

    // Protection 3.
    const dedupe = `${slotKey}#${level}`;
    if (seen.has(dedupe)) return { ok: false, error: "duplicate_custom", slotKey };
    seen.add(dedupe);

    // Protection 2: le prix est calcule ICI, jamais recu.
    const quote = await quoteOne(input.model, slotKey, level);
    if (!quote.ok) {
      if (quote.error === "unknown_model") return { ok: false, error: "unknown_model" };
      if (quote.error === "no_rule") return { ok: false, error: "no_rule", slotKey };
      return { ok: false, error: "bad_custom", slotKey };
    }

    const margin = Math.max(0, quote.priceCents - quote.costCents);
    // Bornee a la marge: un taux mal regle plafonne au lieu de creuser.
    const unitCommission = Math.min(margin, unitCommissionCents_(margin, rate));

    totalCents += quote.priceCents;
    commissionCents += unitCommission;
    lines.push({
      // Aucun article de catalogue derriere: `item_id` reste NULL, ce que le schema prevoit deja.
      // L'analytique groupe alors sur `(category, label)`, et le libelle est DETERMINISTE
      // ("moteur niveau 4") precisement pour que deux tickets se comparent.
      itemId: null,
      label: quote.label.slice(0, 120),
      category: quote.category,
      qty: 1,
      unitPriceCents: quote.priceCents,
      unitCommissionCents: unitCommission,
      unitCostCents: quote.costCents,
    });
  }

  if (lines.length === 0) return { ok: false, error: "empty" };
  if (totalCents > MAX_TICKET_CENTS || commissionCents > MAX_TICKET_CENTS) {
    return { ok: false, error: "too_large" };
  }

  // La voiture est relue dans la base de jeu a partir de la seule plaque, comme dans `declareSale`.
  // Un echec de lecture n'echoue jamais la declaration: voir `lookupSaleVehicle`.
  const vehicleSnapshot = clientRecord ? await lookupSaleVehicle(clientRecord.plate) : null;

  return commitSale(access, {
    lines,
    totalCents,
    commissionCents,
    note: input.note,
    clientRef: input.clientRef,
    backdated: input.backdated,
    client: clientRecord,
    vehicle: vehicleSnapshot,
  });
}

export async function listSales(
  businessId: number,
  opts: { from?: Date; to?: Date; seller?: string; limit?: number } = {},
): Promise<SaleRow[]> {
  const where = [eq(citadelBusinessSales.businessId, businessId)];
  if (opts.from) where.push(gte(citadelBusinessSales.declaredAt, opts.from));
  if (opts.to) where.push(lt(citadelBusinessSales.declaredAt, opts.to));
  if (opts.seller) where.push(eq(citadelBusinessSales.sellerIdentifier, opts.seller));

  const rows = await db
    .select({
      id: citadelBusinessSales.id,
      publicRef: citadelBusinessSales.publicRef,
      sellerIdentifier: citadelBusinessSales.sellerIdentifier,
      sellerName: citadelBusinessSales.sellerName,
      totalCents: citadelBusinessSales.totalCents,
      commissionCents: citadelBusinessSales.commissionCents,
      marginCents: citadelBusinessSales.marginCents,
      backdated: citadelBusinessSales.backdated,
      note: citadelBusinessSales.note,
      declaredAt: citadelBusinessSales.declaredAt,
      clientFirstname: citadelBusinessSales.clientFirstname,
      clientLastname: citadelBusinessSales.clientLastname,
      clientDob: citadelBusinessSales.clientDob,
      clientPhone: citadelBusinessSales.clientPhone,
      vehiclePlate: citadelBusinessSales.vehiclePlate,
      vehicleRecord: citadelBusinessSales.vehicleRecord,
      vehicleModel: citadelBusinessSales.vehicleModel,
      vehicleModelName: citadelBusinessSales.vehicleModelName,
      vehicleClass: citadelBusinessSales.vehicleClass,
      vehicleFleetJob: citadelBusinessSales.vehicleFleetJob,
      vehicleMods: citadelBusinessSales.vehicleMods,
    })
    .from(citadelBusinessSales)
    .where(and(...where))
    .orderBy(desc(citadelBusinessSales.declaredAt))
    .limit(Math.min(opts.limit ?? 200, 500));

  return rows.map(({ ...r }) => ({
    id: r.id,
    publicRef: r.publicRef,
    sellerIdentifier: r.sellerIdentifier,
    sellerName: r.sellerName,
    totalCents: r.totalCents,
    commissionCents: r.commissionCents,
    marginCents: r.marginCents,
    backdated: r.backdated,
    note: r.note,
    declaredAt: r.declaredAt,
    client: toClientRecord(r),
  }));
}

export type SellerTotals = {
  sellerIdentifier: string;
  sellerName: string;
  sales: number;
  totalCents: number;
  commissionCents: number;
  /**
   * Le benefice mesurable de la periode. Voir `margin_cents` dans le schema: 0 veut dire "rien de
   * mesurable ici" (aucune ligne ne portait de cout de revient), jamais "vendu a prix coutant".
   */
  marginCents: number;
};

/**
 * Le classement de la période: une ligne par vendeur.
 *
 * Agrégé en SQL et non en JS parce que la page Équipe couvre une semaine entière et qu'on ne veut
 * pas charger chaque ticket pour en faire une somme. `sellerName` est pris par MAX faute de
 * `ANY_VALUE`: le nom est une copie par ticket, donc identique en pratique, et MAX rend simplement
 * la plus récente des orthographes si quelqu'un a été renommé en cours de semaine.
 */
export async function sellerTotals(
  businessId: number,
  opts: { from?: Date; to?: Date } = {},
): Promise<SellerTotals[]> {
  const where = [eq(citadelBusinessSales.businessId, businessId)];
  if (opts.from) where.push(gte(citadelBusinessSales.declaredAt, opts.from));
  if (opts.to) where.push(lt(citadelBusinessSales.declaredAt, opts.to));

  const rows = await db
    .select({
      sellerIdentifier: citadelBusinessSales.sellerIdentifier,
      sellerName: sql<string>`MAX(${citadelBusinessSales.sellerName})`,
      sales: sql<number>`COUNT(*)`,
      totalCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.totalCents}), 0)`,
      commissionCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.commissionCents}), 0)`,
      marginCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.marginCents}), 0)`,
    })
    .from(citadelBusinessSales)
    .where(and(...where))
    .groupBy(citadelBusinessSales.sellerIdentifier)
    .orderBy(desc(sql`SUM(${citadelBusinessSales.totalCents})`));

  // ⚠ SUM et COUNT reviennent en CHAÎNES via mysql2 (DECIMAL/BIGINT). `sql<number>` est une
  // assertion de type sans conversion: sans ce Number(), un tri ou une addition côté page
  // concaténerait les montants au lieu de les additionner, silencieusement.
  return rows.map((r) => ({
    sellerIdentifier: r.sellerIdentifier,
    sellerName: r.sellerName,
    sales: Number(r.sales),
    totalCents: Number(r.totalCents),
    commissionCents: Number(r.commissionCents),
    marginCents: Number(r.marginCents),
  }));
}

export type DailyTotal = {
  /** `YYYY-MM-DD`, la valeur SQL `DATE()` telle quelle (jamais reconstruite en JS: voir le
   *  commentaire de la fonction pour le piège de fuseau que ça évite). */
  day: string;
  /** `null` quand `opts.bySeller` n'est pas demandé (agrégat pour tout le commerce). */
  sellerIdentifier: string | null;
  sales: number;
  totalCents: number;
  commissionCents: number;
  marginCents: number;
};

/**
 * LE RYTHME JOUR PAR JOUR, AGRÉGÉ EN SQL, JAMAIS EN SOMMANT UNE LISTE DÉJÀ PLAFONNÉE.
 *
 * ⚠⚠ POURQUOI CETTE FONCTION EXISTE: `mes-ventes/page.tsx` et `gestion/equipe/page.tsx` calculaient
 * tous les deux leurs totaux (le chiffre du jour, la semaine en barres, le rythme de l'équipe) en
 * ADDITIONNANT `listSales(...)`, une lecture plafonnée pour l'affichage (200 par défaut, 400 côté
 * Équipe). Correct tant qu'un vendeur reste en dessous du plafond sur la période - et FAUX EN
 * SILENCE au-delà, puisque `listSales` ne retourne alors QUE les ventes les plus RÉCENTES: le total
 * affiché devient la somme d'une fraction de la semaine, pas de la semaine entière, sans le moindre
 * avertissement. Mesuré en direct le 2026-08-09: un vendeur à ~700 ventes/semaine (volume réaliste
 * pour un bar, pas un cas limite) rendait le chiffre de mes-ventes et le rythme d'Équipe silencieusement
 * incomplets - Équipe au moins le DÉTECTAIT (`rhythmUnavailable`) et refusait d'afficher un graphe
 * trompeur plutôt que d'afficher un total faux, mais mes-ventes n'avait aucun garde-fou du tout.
 *
 * Cette fonction résout le problème à la racine plutôt que de repousser le plafond: `SUM`/`COUNT`
 * en SQL portent sur TOUTES les lignes de la période, jamais sur un sous-ensemble déjà découpé côté
 * lecture. `listSales` garde son plafond - il sert désormais UNIQUEMENT à choisir quels tickets
 * afficher dans le journal, plus jamais à calculer un total.
 *
 * `DATE(declared_at)` plutôt qu'une division en millisecondes: la colonne est déjà l'heure locale du
 * serveur (voir `localDatetime` dans lib/db/types.ts), donc `DATE()` MySQL et le calendrier du
 * gérant tombent sur le même jour sans arithmétique de fuseau à reproduire ici.
 */
export async function dailyTotals(
  businessId: number,
  range: { from: Date; to: Date },
  opts: { seller?: string; bySeller?: boolean } = {},
): Promise<DailyTotal[]> {
  const where = [
    eq(citadelBusinessSales.businessId, businessId),
    gte(citadelBusinessSales.declaredAt, range.from),
    lt(citadelBusinessSales.declaredAt, range.to),
  ];
  if (opts.seller) where.push(eq(citadelBusinessSales.sellerIdentifier, opts.seller));

  /**
   * ⚠⚠ `DATE_FORMAT`, ET SURTOUT PAS `DATE()`. Les deux donnent le même jour en SQL, mais pas le même
   * TYPE en JavaScript, et `sql<string>` est une ASSERTION de type, jamais une conversion: tsc croit
   * donc sur parole ce qu'on lui écrit ici, et ne peut pas rattraper l'erreur.
   *
   * Mesuré sur cette base le 2026-08-09: `DATE(declared_at)` revient en `Date` (mysql2 tourne avec
   * `dateStrings: false`, et une EXPRESSION n'a aucun mapper drizzle pour la ramener), tandis que
   * `DATE_FORMAT(..., '%Y-%m-%d')` revient bien en `string`.
   *
   *     DATE()       -> typeof "object", instanceof Date, 2026-07-30T04:00:00.000Z
   *     DATE_FORMAT()-> typeof "string", "2026-07-30"
   *
   * La panne que ça évite est SILENCIEUSE, ce qui est le pire des cas: un appelant qui range ces
   * lignes dans une Map par jour puis lit `map.get("2026-07-30")` ne trouve JAMAIS rien, parce que la
   * clé posée était un objet Date. Aucune exception, aucun avertissement: chaque journée du graphique
   * retombe simplement à zéro, ce qui se lit comme "il n'y a pas eu de ventes" plutôt que comme un
   * bug. Exactement la classe de faute que la colonne `localDatetime` (lib/db/types.ts) documente
   * déjà pour les datetime, et pour la même raison.
   */
  const dayExpr = sql<string>`DATE_FORMAT(${citadelBusinessSales.declaredAt}, '%Y-%m-%d')`;
  const sellerExpr = opts.bySeller
    ? citadelBusinessSales.sellerIdentifier
    : sql<string | null>`NULL`;

  const rows = await db
    .select({
      day: dayExpr,
      sellerIdentifier: sellerExpr,
      sales: sql<number>`COUNT(*)`,
      totalCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.totalCents}), 0)`,
      commissionCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.commissionCents}), 0)`,
      marginCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.marginCents}), 0)`,
    })
    .from(citadelBusinessSales)
    .where(and(...where))
    .groupBy(opts.bySeller ? sql`${dayExpr}, ${citadelBusinessSales.sellerIdentifier}` : dayExpr);

  // ⚠ Même piège que `sellerTotals`: SUM/COUNT reviennent en chaînes via mysql2.
  return rows.map((r) => ({
    day: r.day,
    sellerIdentifier: r.sellerIdentifier,
    sales: Number(r.sales),
    totalCents: Number(r.totalCents),
    commissionCents: Number(r.commissionCents),
    marginCents: Number(r.marginCents),
  }));
}

export type ProductTotal = {
  itemId: number | null;
  label: string;
  category: string;
  qty: number;
  revenueCents: number;
};

/**
 * LE CLASSEMENT DES ARTICLES, AGRÉGÉ EN SQL. Même raison que `dailyTotals` juste au-dessus: la page
 * additionnait les lignes des tickets renvoyés par `listSales` (plafonné), donc un vendeur au-delà
 * du plafond voyait un classement construit sur une fraction de ses ventes plutôt que sur toutes.
 *
 * ⚠ GROUPE PAR `item_id` QUAND IL EXISTE, PAR `(category, label)` SINON. Une ligne dont l'article a
 * disparu du catalogue porte `item_id = NULL` (voir le schéma) et son libellé COPIÉ est la seule
 * identité qui lui reste - la fusionner par hasard avec un autre article nul serait un classement
 * inventé. `MIN(id)` désambiguïse le NULL en SQL (`GROUP BY` ne peut pas grouper sur "NULL avec un
 * label différent" directement), donc le regroupement réel se termine en JS sur la clé composite.
 */
export async function topProducts(
  businessId: number,
  range: { from: Date; to: Date },
  seller: string,
): Promise<ProductTotal[]> {
  const rows = await db
    .select({
      itemId: citadelBusinessSaleLines.itemId,
      label: citadelBusinessSaleLines.label,
      category: citadelBusinessSaleLines.category,
      qty: sql<number>`SUM(${citadelBusinessSaleLines.qty})`,
      revenueCents: sql<number>`SUM(${citadelBusinessSaleLines.unitPriceCents} * ${citadelBusinessSaleLines.qty})`,
    })
    .from(citadelBusinessSaleLines)
    .innerJoin(citadelBusinessSales, eq(citadelBusinessSaleLines.saleId, citadelBusinessSales.id))
    .where(
      and(
        eq(citadelBusinessSales.businessId, businessId),
        eq(citadelBusinessSales.sellerIdentifier, seller),
        gte(citadelBusinessSales.declaredAt, range.from),
        lt(citadelBusinessSales.declaredAt, range.to),
      ),
    )
    .groupBy(
      citadelBusinessSaleLines.itemId,
      citadelBusinessSaleLines.category,
      citadelBusinessSaleLines.label,
    );

  const byKey = new Map<string, ProductTotal>();
  for (const r of rows) {
    const key = r.itemId === null ? `l:${r.category}|${r.label}` : `i:${r.itemId}`;
    const qty = Number(r.qty);
    const revenueCents = Number(r.revenueCents);
    const cur = byKey.get(key);
    if (cur) {
      cur.qty += qty;
      cur.revenueCents += revenueCents;
    } else {
      byKey.set(key, { itemId: r.itemId, label: r.label, category: r.category, qty, revenueCents });
    }
  }
  return [...byKey.values()];
}

/**
 * LE MÊME CLASSEMENT, MAIS POUR TOUT LE COMMERCE: aucun vendeur au filtre.
 *
 * ⚠ UNE FONCTION SOEUR PLUTÔT QU'UN ARGUMENT OPTIONNEL SUR `topProducts`, DÉLIBÉRÉMENT. Rendre son
 * troisième paramètre facultatif aurait transformé un oubli d'argument en une lecture BEAUCOUP plus
 * large que voulue: `topProducts(id, range)` compilerait sans broncher et rendrait les articles de
 * toute l'équipe à une page qui n'a vérifié que `sale.read.self`. Le cloisonnement par vendeur est
 * précisément ce qui sépare `sale.read.self` de `team.read` (voir `listSales`), donc il ne doit pas
 * pouvoir disparaître par omission. Deux noms, deux portées, deux capacités: l'appelant NOMME celle
 * qu'il veut. Même raisonnement que `requireBusiness`, qui exige qu'on nomme la capacité au lieu de
 * la deviner.
 *
 * Le regroupement est identique à celui de `topProducts` (voir son commentaire pour le pourquoi du
 * `item_id` nul rattrapé par `(category, label)`), et il est recopié plutôt que factorisé: cette
 * page-ci est écrite pendant que d'autres appellent `topProducts`, et une refonte commune des deux
 * pour économiser trente lignes se paierait en conflit sur une fonction déjà en service.
 */
export async function productTotals(
  businessId: number,
  range: { from: Date; to: Date },
): Promise<ProductTotal[]> {
  const rows = await db
    .select({
      itemId: citadelBusinessSaleLines.itemId,
      label: citadelBusinessSaleLines.label,
      category: citadelBusinessSaleLines.category,
      qty: sql<number>`SUM(${citadelBusinessSaleLines.qty})`,
      revenueCents: sql<number>`SUM(${citadelBusinessSaleLines.unitPriceCents} * ${citadelBusinessSaleLines.qty})`,
    })
    .from(citadelBusinessSaleLines)
    .innerJoin(citadelBusinessSales, eq(citadelBusinessSaleLines.saleId, citadelBusinessSales.id))
    .where(
      and(
        eq(citadelBusinessSales.businessId, businessId),
        gte(citadelBusinessSales.declaredAt, range.from),
        lt(citadelBusinessSales.declaredAt, range.to),
      ),
    )
    .groupBy(
      citadelBusinessSaleLines.itemId,
      citadelBusinessSaleLines.category,
      citadelBusinessSaleLines.label,
    );

  const byKey = new Map<string, ProductTotal>();
  for (const r of rows) {
    const key = r.itemId === null ? `l:${r.category}|${r.label}` : `i:${r.itemId}`;
    const qty = Number(r.qty);
    const revenueCents = Number(r.revenueCents);
    const cur = byKey.get(key);
    if (cur) {
      cur.qty += qty;
      cur.revenueCents += revenueCents;
    } else {
      byKey.set(key, { itemId: r.itemId, label: r.label, category: r.category, qty, revenueCents });
    }
  }
  return [...byKey.values()];
}

export type ClockCell = {
  /** 0 = lundi ... 6 = dimanche. C'est ce que rend `WEEKDAY()`, pas `DAYOFWEEK()`. Voir plus bas. */
  weekday: number;
  /** 0 à 23, heure locale du serveur (la colonne l'est déjà, voir `localDatetime`). */
  hour: number;
  sales: number;
  totalCents: number;
};

/**
 * QUAND ÇA VEND: le chiffre ventilé par jour de semaine ET par heure, en une seule requête.
 *
 * Une seule lecture pour deux graphiques (le rythme hebdomadaire et les heures d'affluence): les
 * deux profils sont des projections de la même grille, donc en faire deux requêtes reviendrait à
 * balayer deux fois la même table pour additionner les mêmes lignes dans un autre ordre.
 *
 * ⚠ `WEEKDAY()` ET SURTOUT PAS `DAYOFWEEK()`. Les deux existent, les deux rendent un entier, et
 * elles ne comptent NI depuis le même jour NI depuis le même nombre: `WEEKDAY()` rend 0 pour lundi
 * (0-6), `DAYOFWEEK()` rend 1 pour DIMANCHE (1-7). Se tromper ne lève aucune erreur, ne change
 * aucun total, et décale simplement toute la semaine d'un cran en la faisant commencer un jour
 * trop tôt: le "meilleur jour" affiché serait faux d'un jour, en silence. Le portail cale toutes
 * ses semaines sur lundi (voir `mondayOfWeek` côté pages), donc `WEEKDAY()` tombe juste sans
 * arithmétique de rattrapage à écrire, et sans un modulo de plus à relire.
 *
 * ⚠ Les cases VIDES n'existent pas dans le résultat: un `GROUP BY` ne fabrique pas les couples
 * (jour, heure) sans vente. C'est à l'appelant de poser sa grille complète et d'y verser ces
 * lignes, jamais de déduire le nombre de créneaux de la longueur du tableau.
 */
export async function salesClock(
  businessId: number,
  range: { from: Date; to: Date },
): Promise<ClockCell[]> {
  const weekdayExpr = sql<number>`WEEKDAY(${citadelBusinessSales.declaredAt})`;
  const hourExpr = sql<number>`HOUR(${citadelBusinessSales.declaredAt})`;

  const rows = await db
    .select({
      weekday: weekdayExpr,
      hour: hourExpr,
      sales: sql<number>`COUNT(*)`,
      totalCents: sql<number>`COALESCE(SUM(${citadelBusinessSales.totalCents}), 0)`,
    })
    .from(citadelBusinessSales)
    .where(
      and(
        eq(citadelBusinessSales.businessId, businessId),
        gte(citadelBusinessSales.declaredAt, range.from),
        lt(citadelBusinessSales.declaredAt, range.to),
      ),
    )
    .groupBy(weekdayExpr, hourExpr);

  // ⚠ Même piège que partout ailleurs dans ce fichier: SUM/COUNT reviennent en CHAÎNES via mysql2,
  // et `WEEKDAY`/`HOUR` ne sont pas des colonnes typées non plus.
  return rows.map((r) => ({
    weekday: Number(r.weekday),
    hour: Number(r.hour),
    sales: Number(r.sales),
    totalCents: Number(r.totalCents),
  }));
}

/**
 * Les lignes d'un ticket.
 *
 * ⚠ `businessId` EST DANS LA REQUÊTE, via une jointure sur le ticket parent. La première version
 * prenait le seul `saleId` en se justifiant par "cloisonné par le ticket, lui-même cloisonné par
 * commerce" - c'est-à-dire en confiant le cloisonnement à l'appelant, ce que ce fichier interdit
 * onze lignes plus haut: *un filtre qui vit dans l'appelant est un filtre qu'un futur appelant
 * oubliera*. Le futur appelant en question était une page de détail de ticket prenant son id dans
 * l'URL, qui aurait lu n'importe quel ticket du serveur, tous commerces confondus, sans jamais
 * passer par `team.read`.
 */
export async function saleLines(businessId: number, saleId: number) {
  return db
    .select({
      id: citadelBusinessSaleLines.id,
      itemId: citadelBusinessSaleLines.itemId,
      label: citadelBusinessSaleLines.label,
      category: citadelBusinessSaleLines.category,
      qty: citadelBusinessSaleLines.qty,
      unitPriceCents: citadelBusinessSaleLines.unitPriceCents,
      unitCommissionCents: citadelBusinessSaleLines.unitCommissionCents,
    })
    .from(citadelBusinessSaleLines)
    .innerJoin(citadelBusinessSales, eq(citadelBusinessSales.id, citadelBusinessSaleLines.saleId))
    .where(
      and(
        eq(citadelBusinessSaleLines.saleId, saleId),
        eq(citadelBusinessSales.businessId, businessId),
      ),
    )
    .orderBy(citadelBusinessSaleLines.id);
}
