/**
 * LA PLAQUE -> LA VOITURE: quel modèle, et quelles customs, au moment de la déclaration.
 *
 * Demande du propriétaire (2026-08-21): la déclaration d'une concession ou d'un garage doit porter
 * *"the plate of the car"*, *"all the customs and what car"*.
 *
 * ⚠⚠ MESURÉ, PAS SAISI, ET C'EST LE CHOIX CENTRAL DE CE FICHIER. On aurait pu faire cocher à
 * l'employé la liste des modifications posées; ce serait soixante-dix cases à cocher après chaque
 * réparation, donc quelque chose que personne ne remplit correctement au bout d'une semaine, et une
 * donnée qu'aucun gérant ne pourrait croire. La plaque suffit: le jeu SAIT déjà ce que la voiture
 * porte (`owned_vehicles.vehicle`), et `vehicleModsFromJson` sait déjà le dire en mots - c'est le
 * décodeur écrit pour la page joueur du panel staff, réutilisé tel quel plutôt que dédoublé.
 *
 * ⚠ CE QUI EST ENREGISTRÉ EST L'ÉTAT DE LA VOITURE, PAS "CE QUE CE MÉCANO A POSÉ AUJOURD'HUI". Rien
 * dans la base ne distingue les deux, et prétendre le contraire serait de la donnée inventée sur une
 * fiche que le patron lira comme une preuve de travail. L'écran le dit donc en toutes lettres
 * ("état du véhicule au moment de la déclaration"), et ce commentaire existe pour qu'on ne
 * "corrige" pas ce libellé un jour en croyant qu'il est imprécis.
 *
 * ⚠ ON ENREGISTRE LE DÉCODÉ, PAS LE BLOB BRUT, exactement pour la raison qui fait qu'une ligne de
 * vente copie son libellé et son prix (voir `citadelBusinessSaleLines`): un ticket est un fait daté.
 * Redécoder demain un blob d'hier avec un `esx_lscustom/config.lua` retouché réécrirait ce que le
 * client a vu sur sa facture, ce que ce module interdit partout ailleurs.
 *
 * ⚠ ET L'ÉCHEC EST UNE VALEUR, PAS UNE ERREUR. Une plaque absente de `owned_vehicles` est le cas
 * NORMAL d'une concession qui déclare avant la livraison, ou d'un garage qui travaille sur un
 * véhicule de service. Refuser la déclaration pour ça bloquerait la caisse sur un fait qui n'a rien
 * d'anormal; on enregistre `absent` et on l'affiche tel quel. Voir `record`, tri-état, ci-dessous.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ownedVehicles } from "@/lib/db/schema/game";
import { vehicleModelInfoFromJson } from "@/lib/data/vehicleModels";
import { vehicleModsFromJson, type VehicleMods } from "@/lib/data/vehicleMods";

/**
 * CE QUE LA BASE DE JEU SAVAIT, ce qui n'est pas la même question que "la voiture est-elle modifiée".
 *
 * ⚠ TRI-ÉTAT, ET `absent` COMME `unreadable` SONT LES BRUYANTS. Les confondre avec "aucune
 * modification" affirmerait tranquillement quelque chose de faux sur une voiture que le patron
 * s'apprête à facturer. Même distinction, et même raison, que `VehicleMods.record` (`lib/data/
 * vehicleMods.ts`), qui documente les 10 lignes de production sur 26 sans clé d'apparence.
 *
 *   found       la plaque existe et son blob a pu être lu
 *   absent      aucune ligne `owned_vehicles` pour cette plaque
 *   unreadable  la ligne existe mais son blob ne dit rien d'exploitable
 */
export type SaleVehicleRecord = "found" | "absent" | "unreadable";

export type SaleVehicleSnapshot = {
  record: SaleVehicleRecord;
  /** Le nom que dit un humain: "Dubsta 6x6". null quand rien ne permet de le résoudre. */
  modelLabel: string | null;
  /** Le code de spawn: "dubsta3". Ce qu'un staff retranscrit dans une commande. */
  modelName: string | null;
  /** La classe FR: "Off-Road". */
  classLabel: string | null;
  /**
   * Le métier propriétaire quand c'est un véhicule de FLOTTE (`owner` nul et `job` renseigné).
   *
   * ⚠ ON NE STOCKE JAMAIS `owned_vehicles.owner`. Un identifiant de joueur sur une fiche de vente
   * ferait de la caisse un moyen de savoir à qui appartient n'importe quelle plaque qu'on croise en
   * ville, ce qui n'est ni ce qui a été demandé ni quelque chose qu'un employé de garage devrait
   * pouvoir faire. Le métier, lui, est public: la voiture porte la livrée.
   */
  fleetJob: string | null;
  /** Ce que la voiture portait, en mots. null quand rien n'a pu être décodé. */
  mods: VehicleMods | null;
};

/**
 * Plafond de sérialisation du cliché, en caractères.
 *
 * ⚠ CE N'EST PAS UNE RÈGLE DE GESTION, C'EST LA BORNE DE LA COLONNE. `vehicle_mods` est un `text`
 * (65 535 octets); un cliché qui la dépasse ne produit pas une donnée tronquée mais une exception
 * MySQL au milieu de la transaction du ticket, donc un échec brut là où l'employé attend un message.
 * Un cliché réel pèse 1 à 3 ko, on est très loin du plafond: il sert au cas dégénéré, jamais au cas
 * courant. Au-delà, on dégrade vers le résumé plutôt que d'échouer - le ticket vaut mieux que ses
 * détails.
 */
const MAX_SNAPSHOT_CHARS = 60_000;

/**
 * RÉSOUDRE UNE PLAQUE. Ne jette jamais: une panne de lecture dégrade en `unreadable`.
 *
 * ⚠ LA PLAQUE EST DÉJÀ NORMALISÉE PAR L'APPELANT (`normalizePlate`). On ne la retouche pas ici, pour
 * que ce qui est stocké dans `vehicle_plate` et ce qui a servi à chercher soient la même chaîne.
 *
 * ⚠ LA COMPARAISON EST INSENSIBLE À LA CASSE ET AUX ESPACES DE FIN, ET ÇA VIENT DE LA COLLATION, PAS
 * DE NOUS. `owned_vehicles` est en `utf8mb4_unicode_ci`, qui est `_ci` (casse ignorée) et PAD SPACE
 * (espaces de fin ignorés à la comparaison) - c'est ce qui fait qu'une plaque stockée `"46EEK572 "`
 * se retrouve depuis `"46eek572"`. Un espace INTERNE, lui, compte: `"11 ABC12"` ne se retrouve pas
 * en tapant `"11ABC12"`, et c'est pour ça que l'écran demande la plaque telle qu'elle est écrite.
 *
 * ⚠ AUCUNE JOINTURE avec une table du panel. `owned_vehicles` est en `utf8mb4_unicode_ci` et les
 * tables `lifeinvader_*` en `utf8mb4_general_ci`: une jointure colonne à colonne entre les deux jette
 * à l'exécution (voir l'avertissement de `lib/business/roster.ts`). Ici on compare une colonne à un
 * PARAMÈTRE, ce qui ne pose pas ce problème, et on rapproche en mémoire côté appelant.
 */
export async function lookupSaleVehicle(plate: string): Promise<SaleVehicleSnapshot> {
  const empty: SaleVehicleSnapshot = {
    record: "absent",
    modelLabel: null,
    modelName: null,
    classLabel: null,
    fleetJob: null,
    mods: null,
  };

  let rows: { owner: string | null; vehicle: string; job: string | null }[];
  try {
    rows = await db
      .select({
        owner: ownedVehicles.owner,
        vehicle: ownedVehicles.vehicle,
        job: ownedVehicles.job,
      })
      .from(ownedVehicles)
      .where(eq(ownedVehicles.plate, plate))
      .limit(1);
  } catch {
    // La déclaration ne doit pas mourir parce que la lecture du véhicule a échoué: le ticket, le
    // client et la plaque restent vrais et se déclarent quand même.
    return { ...empty, record: "unreadable" };
  }

  const row = rows[0];
  if (!row) return empty;

  const info = vehicleModelInfoFromJson(row.vehicle);
  const mods = vehicleModsFromJson(row.vehicle);
  // Une ligne dont le blob ne rend NI modèle NI apparence ne dit rien: l'annoncer comme trouvée
  // ferait afficher une voiture vide qu'on lirait comme "aucune option".
  if (!info && !mods) return { ...empty, record: "unreadable" };

  return {
    record: "found",
    modelLabel: info?.label ?? null,
    modelName: info?.modelName ?? null,
    classLabel: info?.categoryLabel ?? null,
    fleetJob: row.owner ? null : (row.job ?? null),
    mods,
  };
}

/**
 * Le cliché prêt à écrire dans `vehicle_mods`, ou null quand il n'y a rien à dire.
 *
 * ⚠ ON DÉGRADE VERS LE RÉSUMÉ AU LIEU D'ÉCHOUER quand le détail ne tient pas dans la colonne: perdre
 * la liste des groupes est regrettable, perdre le ticket ne l'est pas.
 */
export function serializeVehicleMods(mods: VehicleMods | null): string | null {
  if (!mods) return null;

  const full = JSON.stringify(mods);
  if (full.length <= MAX_SNAPSHOT_CHARS) return full;

  return JSON.stringify({ ...mods, groups: [] } satisfies VehicleMods);
}

/** Relire un cliché. Une chaîne illisible rend null plutôt que de jeter au milieu d'un rendu. */
export function parseVehicleMods(raw: string | null | undefined): VehicleMods | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as VehicleMods;
    return Array.isArray(v?.groups) && Array.isArray(v?.summary) ? v : null;
  } catch {
    return null;
  }
}
