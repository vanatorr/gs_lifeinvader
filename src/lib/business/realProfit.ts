/**
 * LE VRAI RESULTAT DE L'ENTREPRISE, lu dans le grand livre du JEU et pas dans les tickets declares.
 *
 * Demande du proprietaire (2026-08-27): "ok so thats what it needs to show in the damn lifeinvader
 * website not 0$". Le portail affichait un benefice tire des tickets declares (prix moins cout de
 * revient, ligne a ligne), qui vaut 0 chez les deux concessions parce que le catalogue leur fait
 * acheter et revendre au meme prix. Pendant ce temps la caisse REELLE de PDM avait bouge de
 * +106 192 $ sur douze jours. Le portail ne montrait donc pas un chiffre trop bas: il montrait le
 * mauvais chiffre.
 *
 * SOURCE: `gs_bank_accounts` / `gs_bank_txn` / `gs_bank_entries`, les tables que `gs_bank` ecrit
 * quand l'argent bouge vraiment. CITADEL les LIT, ne les ecrit jamais (CITADEL_DESIGN.md §4).
 *
 * ⚠ LE COMPTE `blocked` EST EXCLU, ET L'OUBLIER DOUBLE LE RESULTAT. Chaque entreprise a DEUX lignes
 * dans `gs_bank_accounts` pour le meme `job_name`: la tresorerie (`subaccount = ''`) et le pot ou
 * s'accumule la part bloquee des factures (`subaccount = 'blocked'`). C'est le meme piege que
 * `society_<job>` / `society_<job>_blocked` cote ESX, deja documente dans le schema.
 *
 * ⚠⚠ `admin_adjust` N'EST PAS DU CHIFFRE, ET LE COMPTER RENDRAIT DEUX ENTREPRISES DEFICITAIRES
 * RENTABLES A L'ECRAN. Ce sont des creations d'argent par le staff. Mesure du 2026-08-27: Luxury a
 * recu 1 455 000 $ et Benny's 1 039 703 $ de cette facon, alors que leur exploitation perd
 * respectivement 1 122 265 $ et 383 334 $. Les inclure aurait affiche "benefice" a deux commerces
 * qui vivent d'une perfusion. Ils sont donc sortis du resultat ET montres a part, parce que les
 * cacher ferait mentir le rapprochement avec le solde du compte.
 *
 * ⚠ LES DEPOTS ET RETRAITS DU PATRON SONT SORTIS AUSSI. Retirer de l'argent de sa societe n'est pas
 * une charge, y remettre le sien n'est pas une recette: les deux deplacent de la tresorerie sans
 * rien produire. Meme traitement, meme raison, et montres a part pour la meme raison.
 *
 * ⚠ AUCUNE REPARTITION PAR EMPLOYE N'EST POSSIBLE ICI, ET IL NE FAUT PAS EN INVENTER UNE. Mesure du
 * 2026-08-27: les 409 mouvements `billing_payout` des trois commerces ont TOUS un
 * `actor_identifier` vide, et ni `service_ref` ni `meta` renseignes - le jeu n'enregistre pas qui a
 * emis la facture. Les COUTS, eux, portent bien un acteur. Attribuer un resultat par personne
 * demanderait donc de repartir les recettes au prorata de quelque chose, c'est-a-dire de fabriquer
 * un chiffre sur lequel une paie serait versee. La fiche employe garde donc le benefice DECLARE,
 * dit comme tel.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gsBankAccounts, gsBankEntries, gsBankTxn } from "@/lib/db/schema/game";

/**
 * LES CATEGORIES QUI NE SONT NI UNE RECETTE NI UNE CHARGE.
 *
 * ⚠ UNE LISTE FERMEE, ET C'EST DELIBERE: toute categorie inconnue compte dans le resultat, selon son
 * sens (credit = recette, debit = charge). Le repli inverse - ignorer ce qu'on ne connait pas -
 * ferait disparaitre en silence une source de revenu le jour ou le jeu en ajoute une, et un resultat
 * trop bas ne se remarque pas.
 */
const NEUTRAL_CATEGORIES = new Set(["admin_adjust", "society_deposit", "society_withdraw"]);

export type ProfitLine = {
  category: string;
  direction: "credit" | "debit";
  amountCents: number;
  count: number;
};

export type RealProfit = {
  /** Solde de la tresorerie, maintenant. Pas une somme de la periode: l'etat du compte. */
  balanceCents: number;
  /** Le pot bloque, a cote et jamais additionne. */
  blockedCents: number;
  incomeCents: number;
  costCents: number;
  /** `incomeCents - costCents`. Peut etre negatif, et c'est souvent le cas. */
  profitCents: number;
  /** Injections du staff sur la periode. Hors resultat, montrees a part. */
  adjustmentCents: number;
  /** Depots moins retraits du patron sur la periode. Hors resultat, montres a part. */
  ownerFlowCents: number;
  lines: ProfitLine[];
  /** Faux quand ce metier n'a aucun compte d'entreprise: l'ecran doit le DIRE, pas afficher 0. */
  hasLedger: boolean;
};

const EMPTY: RealProfit = {
  balanceCents: 0,
  blockedCents: 0,
  incomeCents: 0,
  costCents: 0,
  profitCents: 0,
  adjustmentCents: 0,
  ownerFlowCents: 0,
  lines: [],
  hasLedger: false,
};

/**
 * ⚠ LES MONTANTS DU JEU SONT DES DOLLARS ENTIERS, LE PORTAIL COMPTE EN CENTIMES. Tout ce qui sort
 * d'ici est donc multiplie par 100 une fois, ici et nulle part ailleurs: repartir la conversion sur
 * les appelants garantit qu'un ecran finira par afficher un montant cent fois trop petit.
 */
const toCents = (dollars: number) => Math.round(Number(dollars) || 0) * 100;

export async function realProfitForJob(
  job: string,
  range?: { from: Date; to: Date },
): Promise<RealProfit> {
  if (!job) return EMPTY;
  try {
    const accounts = await db
      .select({
        id: gsBankAccounts.id,
        balance: gsBankAccounts.balance,
        subaccount: gsBankAccounts.subaccount,
      })
      .from(gsBankAccounts)
      .where(and(eq(gsBankAccounts.jobName, job), eq(gsBankAccounts.kind, "business")));
    if (accounts.length === 0) return EMPTY;

    const main = accounts.filter((a) => a.subaccount === "");
    const blocked = accounts.filter((a) => a.subaccount !== "");
    const mainIds = main.map((a) => a.id);
    if (mainIds.length === 0) return EMPTY;

    const where = [inArray(gsBankEntries.accountId, mainIds), eq(gsBankTxn.status, "applied")];
    // Les horodatages du grand livre sont en MILLISECONDES depuis l'epoque (voir le schema), pas des
    // datetime SQL: comparer a une Date directement ne filtrerait rien.
    if (range) {
      where.push(gte(gsBankEntries.createdAt, range.from.getTime()));
      where.push(lt(gsBankEntries.createdAt, range.to.getTime()));
    }

    const rows = await db
      .select({
        category: gsBankTxn.category,
        direction: gsBankEntries.direction,
        total: sql<number>`COALESCE(SUM(${gsBankEntries.amount}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(gsBankEntries)
      .innerJoin(gsBankTxn, eq(gsBankTxn.id, gsBankEntries.txnId))
      .where(and(...where))
      .groupBy(gsBankTxn.category, gsBankEntries.direction);

    let incomeCents = 0;
    let costCents = 0;
    let adjustmentCents = 0;
    let ownerFlowCents = 0;
    const lines: ProfitLine[] = [];

    for (const r of rows) {
      // ⚠ SUM/COUNT reviennent en CHAINES via mysql2: sans Number(), une addition concatene.
      const amount = toCents(Number(r.total));
      const direction = r.direction === "debit" ? "debit" : "credit";
      lines.push({ category: r.category, direction, amountCents: amount, count: Number(r.count) });

      if (NEUTRAL_CATEGORIES.has(r.category)) {
        if (r.category === "admin_adjust") {
          adjustmentCents += direction === "credit" ? amount : -amount;
        } else {
          ownerFlowCents += direction === "credit" ? amount : -amount;
        }
        continue;
      }
      if (direction === "credit") incomeCents += amount;
      else costCents += amount;
    }

    lines.sort((a, b) => b.amountCents - a.amountCents);

    return {
      balanceCents: toCents(main.reduce((acc, a) => acc + Number(a.balance), 0)),
      blockedCents: toCents(blocked.reduce((acc, a) => acc + Number(a.balance), 0)),
      incomeCents,
      costCents,
      profitCents: incomeCents - costCents,
      adjustmentCents,
      ownerFlowCents,
      lines,
      hasLedger: true,
    };
  } catch {
    // Une page de gestion ne doit pas tomber parce qu'une table du jeu est indisponible: `hasLedger`
    // reste faux et l'ecran dit qu'il n'a pas pu lire, au lieu d'afficher un zero qui ment.
    return EMPTY;
  }
}

/** Libelles FR des categories du grand livre. Une categorie inconnue s'affiche telle quelle. */
export const LEDGER_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  billing_payout: "Factures encaissées",
  vehicle_purchase_society: "Achats de flotte",
  vehicle_resale: "Reventes au concessionnaire",
  vehicle_mod: "Pièces LS Customs",
  salary: "Salaires",
  salary_bonus: "Primes versées",
  bill_business: "Factures fournisseurs",
  custom_clothes: "Tenues",
  society_deposit: "Dépôts",
  society_withdraw: "Retraits",
  admin_adjust: "Ajustements staff",
};

export function ledgerCategoryLabel(key: string): string {
  return LEDGER_CATEGORY_LABELS[key] ?? key;
}
