/**
 * LE CATALOGUE VÉHICULE DU PORTAIL: une copie figée de FleetRoster, filtrée par métier.
 *
 * ⚠ ON NE RECOPIE PAS CES VOITURES DANS `lifeinvader_business_items`. Il y en a des centaines
 * par concession, chacune avec son prix, et le patron n'a aucune raison de les retaper. Le prix
 * fait autorité ICI (extrait de `gs_base/common/vehicleList.lua`). La caisse n'envoie qu'un
 * `model`; `declareSale` relit ce fichier. Un prix venu du navigateur serait exactement
 * "je tape ma paie" pour une voiture à huit millions.
 *
 * Relancer `npm run business:extract-fleet` après un changement de FleetRoster.
 */
import roster from "./fleetRoster.generated.json";

export type FleetVehicle = {
  name: string;
  model: string;
  /** Ce que paie le CLIENT. C'est ce que la caisse affiche et ce que le ticket facture. */
  priceDollars: number;
  /**
   * Ce que la CONCESSION a paye pour stocker le modele (`dealerPrice` cote jeu, repli sur `price`).
   *
   * ⚠ PEUT MANQUER SUR UN JSON PAS ENCORE REGENERE, d'ou le repli dans `vehicleCostCents` et non
   * ici. Le fichier est un artefact committe: une branche qui n'a pas relance
   * `npm run business:extract-fleet` lit encore l'ancienne forme, et un `undefined x 100` vaut
   * `NaN`, qui traverse chaque comparaison en silence et finit en `unit_cost_cents` NULL.
   */
  dealerPriceDollars?: number;
  category: string;
  sellers: string[];
};

/** Libellés FR des classes FleetRoster. Même liste que VehicleClassMap côté jeu. */
export const VEHICLE_CLASS_LABELS: Readonly<Record<string, string>> = {
  compacts: "Compacts",
  coupes: "Coupés",
  sedans: "Sedans",
  sports: "Sports",
  sportsclassics: "Sports Classics",
  super: "Supers",
  muscle: "Muscles",
  offroad: "Off-Road",
  suvs: "SUVs",
  vans: "Vans",
  trailer: "Remorques",
  motorcycles: "Motos",
  bike: "Vélos",
  job: "Jobs",
  heli: "Hélicoptères",
  boat: "Bateaux",
  plane: "Avions",
  reaper: "Reaper",
  rc: "RC",
};

const ALL = roster as FleetVehicle[];
const BY_MODEL = new Map(ALL.map((r) => [r.model, r]));

export function vehiclesForJob(job: string): FleetVehicle[] {
  if (!job) return [];
  return ALL.filter((r) => r.sellers.includes(job));
}

/**
 * UNE voiture vendable PAR CE MÉTIER, ou null.
 *
 * ⚠ LE FILTRE `sellers` EST LA CLOISON. Sans lui, un employé PDM déclarerait une voiture Luxury
 * en devinant le modelName, au prix Luxury, et le ticket dirait que PDM l'a vendue.
 */
export function vehicleForJob(job: string, model: string): FleetVehicle | null {
  const key = String(model ?? "").trim().toLowerCase();
  if (!key) return null;
  const row = BY_MODEL.get(key);
  if (!row || !row.sellers.includes(job)) return null;
  return row;
}

/**
 * UNE voiture PAR SON MODÈLE, SANS filtre vendeur.
 *
 * ⚠⚠ L'ABSENCE DE FILTRE EST LE POINT, ET CE N'EST PAS UN OUBLI DE `vehicleForJob` JUSTE AU-DESSUS.
 * La cloison `sellers` protège la CONCESSION: un employé PDM ne doit pas déclarer une Luxury au
 * prix Luxury. Un GARAGE est l'exact opposé: il répare ce qui entre dans l'atelier, et une Zentorno
 * chez un mécano n'a rien d'anormal. Appliquer la cloison ici rendrait infacturable toute voiture
 * que le garage ne vend pas, c'est-à-dire toutes. Ne "corrigez" pas cette fonction en y ajoutant le
 * filtre: c'est `vehicleForJob` qu'il faut appeler quand la cloison est voulue.
 */
export function vehicleByModel(model: string): FleetVehicle | null {
  const key = String(model ?? "").trim().toLowerCase();
  if (!key) return null;
  return BY_MODEL.get(key) ?? null;
}

/** Sans accents, sans casse: "Coquette Améliorée" et "coquette amelioree" doivent se rencontrer. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // propriete Unicode, en ASCII pur: un caractere combinant litteral dans le source est invisible et ne survit pas a une copie
    .toLowerCase()
    .trim();
}

/**
 * LA RECHERCHE DE LA CAISSE GARAGE: on tape un bout de nom, on retrouve la voiture.
 *
 * Demande du propriétaire (2026-08-23): *"they just chose the car by smart name search"*.
 *
 * Cherche dans le nom affiché ET dans le code de spawn, parce que les deux circulent: le mécano lit
 * "Primo" sur la carrosserie, le staff tape `primo2` dans une commande. Le classement va du plus
 * sûr au plus vague (modèle exact, puis début de nom, puis nom contenu, puis modèle contenu), pour
 * qu'une frappe complète ne soit jamais reléguée derrière une correspondance partielle.
 *
 * ⚠ RIEN N'EST FILTRÉ PAR MÉTIER ICI, même raison que `vehicleByModel` ci-dessus.
 */
export function searchVehicles(query: string, limit = 12): FleetVehicle[] {
  const q = fold(query);
  if (q.length < 1) return [];
  const scored: { row: FleetVehicle; score: number }[] = [];
  for (const row of ALL) {
    const name = fold(row.name);
    const model = fold(row.model);
    let score = -1;
    if (model === q) score = 0;
    else if (name === q) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 3;
    else if (model.includes(q)) score = 4;
    if (score >= 0) scored.push({ row, score });
  }
  scored.sort((a, b) => a.score - b.score || a.row.name.localeCompare(b.row.name, "fr"));
  return scored.slice(0, limit).map((s) => s.row);
}

export function vehiclePriceCents(row: FleetVehicle): number {
  return row.priceDollars * 100;
}

/**
 * CE QUE LA CONCESSION A PAYE POUR CETTE VOITURE, en centimes.
 *
 * ⚠ LE REPLI EST `priceDollars`, PAS ZERO, et l'inverse serait une fuite de paie. Un cout de zero
 * dirait que la voiture est du benefice PUR, donc qu'un stagiaire a 5 % touche 5 % du prix entier:
 * exactement le bug du 2026-08-27 (8 000 $ de prime sur une Raiden a 160 000 $). Egaler le prix
 * client dit "aucune marge connue", donc "aucune prime", ce qui est faux dans l'autre sens mais ne
 * verse rien a tort et se corrige en renseignant `dealerPrice` sur la ligne du catalogue.
 */
export function vehicleCostCents(row: FleetVehicle): number {
  const dealer = row.dealerPriceDollars;
  if (!Number.isInteger(dealer) || (dealer as number) <= 0) return row.priceDollars * 100;
  return Math.min(dealer as number, row.priceDollars) * 100;
}

/**
 * LE BENEFICE DE LA CONCESSION SUR CETTE VOITURE, en centimes. Jamais negatif.
 *
 * C'est la SEULE base de la prime vehicule. Voir `vehicleUnitCommissionCents` (commission.ts).
 */
export function vehicleMarginCents(row: FleetVehicle): number {
  return Math.max(0, vehiclePriceCents(row) - vehicleCostCents(row));
}

export function vehicleClassLabel(category: string): string {
  return VEHICLE_CLASS_LABELS[category] ?? category;
}

export function fleetModelCount(): number {
  return ALL.length;
}
