/**
 * CE QUE L'ENTREPRISE A REELLEMENT PAYE POUR CETTE VOITURE-LA.
 *
 * Demande du proprietaire (2026-08-27), apres la correction de la prime concession: *"jte parle des
 * cout de achat que le job les achete pour calculer le profit"*. Le benefice ne doit pas se calculer
 * sur ce qu'un modele coute AUJOURD'HUI au catalogue, mais sur ce que CETTE voiture a coute le jour
 * ou elle est entree en flotte.
 *
 * La source est `job_vehicle_purchases`, ecrite par le kiosque du jeu
 * (`gs_jobs/modules/vehicleShop/server/main.lua`, `RecordJobVehiclePurchase`) avec le montant que le
 * serveur a REELLEMENT debite. Ce n'est pas une estimation: c'est la ligne comptable de l'achat.
 *
 * ⚠ POURQUOI CA N'EST PAS EQUIVALENT AU CATALOGUE, MEME QUAND LES DEUX COINCIDENT AUJOURD'HUI.
 * Mesure du 2026-08-27 sur les 144 achats de production: 139 au prix catalogue exact, et 5 Mesa R
 * dont UNE a 275 000 $ contre 70 000 $ pour les quatre autres, parce que son `dealerPrice` a ete
 * ajoute entre-temps. Calculer sur le catalogue aurait donc reecrit retroactivement la marge de
 * cette voiture-la, dans le sens qui gonfle la prime. Le prix paye, lui, ne bouge plus jamais.
 *
 * ⚠ ET C'EST AUSSI UNE PROTECTION, PAS SEULEMENT UNE PRECISION. La plaque vient de la fiche client,
 * donc d'un champ que l'EMPLOYE remplit, et un cout plus bas produit une prime plus haute: c'est un
 * curseur sur sa propre paie. La ligne d'achat est donc exigee sur SON metier ET sur le MEME modele
 * que la ligne declaree, sinon elle est ignoree. Sans ces deux verrous, taper la plaque d'une
 * Sanchez en vendant une supercar suffirait a s'attribuer tout le prix en benefice.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobVehiclePurchases } from "@/lib/db/schema/game";

/**
 * La meme normalisation que le jeu applique avant d'ecrire (`trimPlate`): les plaques GTA sont
 * completees d'espaces, et une comparaison brute rate alors la ligne sans rien signaler.
 */
function normalizePlate(raw: string): string {
  return String(raw ?? "").trim().toUpperCase().slice(0, 12);
}

/**
 * Le prix d'achat de la voiture portant cette plaque, en CENTIMES, ou `null` si rien de sur.
 *
 * ⚠ `null` VEUT DIRE "ON NE SAIT PAS", ET L'APPELANT DOIT RETOMBER SUR LE CATALOGUE, jamais sur
 * zero. Un cout de zero affirmerait que la voiture est du benefice pur, c'est-a-dire exactement le
 * bug de prime corrige ce meme jour.
 *
 * ⚠ NE JETTE JAMAIS. Une declaration de vente reelle ne doit pas echouer parce qu'une table du jeu
 * est indisponible; on retombe simplement sur le catalogue.
 */
export async function fleetPurchaseCostCents(
  job: string,
  plate: string,
  modelLabel: string,
): Promise<number | null> {
  const p = normalizePlate(plate);
  if (!p || !job || !modelLabel) return null;
  try {
    const rows = await db
      .select({ price: jobVehiclePurchases.price, model: jobVehiclePurchases.model })
      .from(jobVehiclePurchases)
      .where(and(eq(jobVehiclePurchases.jobName, job), eq(jobVehiclePurchases.plate, p)))
      // La plus RECENTE: une plaque peut etre reprise par la fourriere puis rachetee, et c'est
      // le dernier achat qui a coute quelque chose a l'entreprise aujourd'hui.
      .orderBy(desc(jobVehiclePurchases.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Le verrou de modele. `model` porte le LIBELLE ("Rumpo Trail"), pas le modelName.
    if (String(row.model ?? "").trim().toLowerCase() !== modelLabel.trim().toLowerCase()) return null;
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return Math.round(price) * 100;
  } catch {
    return null;
  }
}
