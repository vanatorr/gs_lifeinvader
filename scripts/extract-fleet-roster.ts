/**
 * Extrait le catalogue véhicule du jeu (`gs_base/common/vehicleList.lua`) vers un JSON
 * que le portail LifeInvader peut lire SANS recopier chaque voiture à la main.
 *
 *   npm run business:extract-fleet
 *
 * ⚠ C'EST UNE COPIE FIGÉE, PAS UNE LECTURE LIVE. CITADEL n'exécute pas Lua. Quand un
 * modèle, un prix ou un concessionnaire change dans FleetRoster, relancer CE script et
 * committer `src/lib/business/fleetRoster.generated.json`. Un prix périmé ici est un
 * ticket faux, pas un plantage: le portail déclarerait le vieux montant.
 *
 * On ne garde que les lignes vendables: prix > 0 ET au moins un `seller`. Les RC à 0 $
 * et les flottes job-only n'ont rien à faire sur une caisse.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const LUA = path.join(
  ROOT,
  "fivem/server-data/resources/gs_base/common/vehicleList.lua",
);
const OUT = path.join(HERE, "../src/lib/business/fleetRoster.generated.json");

/**
 * ⚠⚠ CE PARSEUR NE DOIT PLUS JAMAIS DEPENDRE DE L'ORDRE NI DU VOISINAGE DES CHAMPS, et c'est une
 * correction, pas une preference de style. L'ancienne version etait UNE seule regex qui exigeait
 * `price` COLLE a `category` COLLE a `seller`. Toute ligne portant un champ intercalaire ne
 * correspondait plus, et une ligne qui ne correspond pas est SAUTEE EN SILENCE: le script
 * n'affiche qu'un total qui baisse, et rien ne dit lequel est tombe.
 *
 * Mesure du 2026-08-24: 11 voitures manquaient au portail pour cette seule raison. Les 10
 * remorques (`boattrailer`, `tanker`, `trailers2`, `trailerlogs`, ...) portent `netType = 'trailer'`
 * entre `category` et `seller`; `terminus` et `mesar` portent le nouveau `dealerPrice` entre
 * `price` et `category`. Aucune de ces lignes n'etait fautive.
 *
 * On repere donc d'abord la LIGNE entiere (accolade a accolade, en tolerant la table `seller`
 * imbriquee), puis on lit chaque champ INDEPENDAMMENT a l'interieur. Ajouter un champ a
 * FleetRoster demain ne casse plus rien.
 */
const ROW = /\{\s*name\s*=[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
const FIELD_NAME = /\bname\s*=\s*'((?:\\'|[^'])*)'/;
const FIELD_MODEL = /\bmodelName\s*=\s*'((?:\\'|[^'])*)'/;
// ⚠ `price` est ce que paie le CLIENT, `dealerPrice` ce que la CONCESSION paie pour stocker le
// modele. Le garde-fou `[^a-zA-Z]` empeche `dealerPrice = N` d'etre lu comme le prix client, ce qui
// facturerait le client au prix d'achat sans rien signaler.
//
// ⚠ LES DEUX SONT EXTRAITS DEPUIS LE 2026-08-27, ET C'EST LE COEUR D'UNE CORRECTION DE PAIE. Le
// portail ne lisait que `price`, donc il n'avait AUCUN cout a soustraire et ne pouvait pas connaitre
// le benefice d'une vente. La prime vehicule se rabattait sur un pourcentage de marge saisi a la
// main par concession (`vehicleProfitBps`), laisse a 100 % partout: un stagiaire a 5 % du "benefice"
// touchait 5 % du PRIX ENTIER, soit 8 000 $ sur une Raiden a 160 000 $. Voir
// `vehicleUnitCommissionCents` dans lib/business/commission.ts.
const FIELD_PRICE = /(?:^|[^a-zA-Z])price\s*=\s*(\d+)/;
const FIELD_DEALER_PRICE = /\bdealerPrice\s*=\s*(\d+)/;
const FIELD_CATEGORY = /\bcategory\s*=\s*'((?:\\'|[^'])*)'/;
const FIELD_SELLER = /\bseller\s*=\s*\{([^}]*)\}/;

/**
 * ⚠ LA REVENTE CROISEE N'EST PAS DANS LES LIGNES DE FleetRoster, ELLE EST APPLIQUEE APRES.
 *
 * `vehicleList.lua` porte un bloc `VehicleSellerMirrors` (temporaire, demande du proprietaire du
 * 2026-08-26) qui recopie le catalogue d'un concessionnaire vers un autre a l'execution, en mutant
 * les tables `seller` APRES la declaration de FleetRoster. Les regex ci-dessus ne lisent que le
 * TEXTE des lignes, donc elles ne peuvent pas voir ce que cette passe ajoute.
 *
 * Sans ce parseur, le portail vendrait strictement moins que le jeu et rien ne le signalerait: la
 * caisse LifeInvader de PDM refuserait une moto que la concession vend en jeu, avec pour seul
 * symptome un vehicule introuvable dans la recherche. On relit donc le meme bloc et on applique la
 * meme regle, pour que les deux cotes repondent la meme chose.
 *
 * Bloc absent ou `Enabled = false` valent tous deux "pas de revente croisee", c'est-a-dire le
 * catalogue d'origine: c'est l'interrupteur, et il ne doit pas faire echouer l'extraction.
 */
const MIRRORS_BLOCK = /VehicleSellerMirrors\s*=\s*\{([\s\S]*?)\n\}/;
const MIRRORS_ENABLED = /\bEnabled\s*=\s*(true|false)\b/;
// Volontairement `[^']+` et non le motif tolerant-aux-echappements des champs ci-dessus: un nom de
// metier est un identifiant en minuscules (`motodealer`, `cardealer`), jamais une chaine libre, et
// un motif qui accepte une apostrophe echappee accepte aussi de deborder sur le guillemet fermant.
const MIRROR_ENTRY = /\{\s*From\s*=\s*'([^']+)'\s*,\s*To\s*=\s*'([^']+)'\s*\}/g;

type SellerMirror = { from: string; to: string };

function parseMirrors(lua: string): SellerMirror[] {
  const block = MIRRORS_BLOCK.exec(lua);
  if (!block) return [];
  const body = block[1] ?? "";
  const enabled = MIRRORS_ENABLED.exec(body);
  if (!enabled || enabled[1] !== "true") return [];
  const out: SellerMirror[] = [];
  for (const m of body.matchAll(MIRROR_ENTRY)) {
    const from = (m[1] ?? "").trim();
    const to = (m[2] ?? "").trim();
    if (from && to && from !== to) out.push({ from, to });
  }
  return out;
}

/** Meme regle que la passe Lua: a sens unique, jamais de doublon, `from` n'est jamais modifie. */
function applyMirrors(who: string[], mirrors: SellerMirror[]): string[] {
  if (mirrors.length === 0) return who;
  const out = [...who];
  for (const { from, to } of mirrors) {
    if (out.includes(from) && !out.includes(to)) out.push(to);
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/\\'/g, "'");
}

function sellers(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/'((?:\\'|[^'])*)'/g)) {
    const name = unquote(m[1] ?? "").trim();
    if (name) out.push(name);
  }
  return out;
}

const src = fs.readFileSync(LUA, "utf8");
const MIRRORS = parseMirrors(src);
const rows: {
  name: string;
  model: string;
  priceDollars: number;
  /**
   * Ce que la CONCESSION paie pour stocker le modele. Absent de la ligne Lua = le meme que
   * `priceDollars`, exactement comme `ResolveVehicleDealerPriceByHash` le fait cote jeu.
   *
   * ⚠ ON ECRIT LE REPLI PLUTOT QUE DE LAISSER LE CHAMP ABSENT. Un `undefined` cote portail
   * obligerait chaque lecteur a refaire le repli, et un lecteur qui l'oublie lit `NaN` puis
   * facture zero sans rien dire. Une ligne sans marge porte donc deux fois le meme nombre, ce qui
   * se lit comme ce que c'est: benefice nul.
   */
  dealerPriceDollars: number;
  category: string;
  sellers: string[];
}[] = [];
const seen = new Set<string>();

// Lignes qui ressemblent a une ligne FleetRoster mais dont un champ ne se lit pas. Voir le bloc
// ⚠⚠ ci-dessus: c'est precisement ce cas qui disparaissait sans bruit, donc il s'affiche et il
// fait echouer le script au lieu de baisser le total d'un cran.
const malformed: string[] = [];

for (const m of src.matchAll(ROW)) {
  const row = m[0];
  const nameM = FIELD_NAME.exec(row);
  const modelM = FIELD_MODEL.exec(row);
  // Pas une ligne de vehicule (le fichier contient d'autres tables). Ignoree sans rien signaler.
  if (!nameM || !modelM) continue;

  const priceM = FIELD_PRICE.exec(row);
  const categoryM = FIELD_CATEGORY.exec(row);
  const sellerM = FIELD_SELLER.exec(row);
  if (!priceM || !categoryM || !sellerM) {
    malformed.push(row.replace(/\s+/g, " ").trim());
    continue;
  }

  const name = unquote(nameM[1] ?? "");
  const model = unquote(modelM[1] ?? "").toLowerCase();
  const priceDollars = Number(priceM[1]);
  const dealerPriceM = FIELD_DEALER_PRICE.exec(row);
  const dealerRaw = dealerPriceM ? Number(dealerPriceM[1]) : priceDollars;
  // Un `dealerPrice` illisible ou superieur au prix client n'est pas une marge negative: c'est une
  // ligne fautive, et la traiter comme "pas de marge" est le seul repli qui ne paie personne a tort.
  const dealerPriceDollars =
    Number.isInteger(dealerRaw) && dealerRaw > 0 && dealerRaw <= priceDollars
      ? dealerRaw
      : priceDollars;
  const category = unquote(categoryM[1] ?? "");
  const who = applyMirrors(sellers(sellerM[1] ?? ""), MIRRORS);
  // Volontairement PAS une erreur: un prix a 0 (RC) ou une flotte sans `seller` (job-only) n'a rien
  // a faire sur une caisse. C'est le filtre "vendable" documente en tete de fichier.
  if (!model || !Number.isInteger(priceDollars) || priceDollars <= 0 || who.length === 0) continue;
  if (seen.has(model)) continue;
  seen.add(model);
  rows.push({ name, model, priceDollars, dealerPriceDollars, category, sellers: who });
}

if (malformed.length > 0) {
  console.error(
    `${malformed.length} ligne(s) FleetRoster illisibles: elles ont un name et un modelName mais pas les trois champs price/category/seller.`,
  );
  for (const row of malformed.slice(0, 10)) console.error(`  ${row}`);
  process.exit(1);
}

rows.sort((a, b) => a.name.localeCompare(b.name, "fr") || a.model.localeCompare(b.model));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(rows)}\n`);

const bySeller = new Map<string, number>();
for (const r of rows) {
  for (const s of r.sellers) bySeller.set(s, (bySeller.get(s) ?? 0) + 1);
}

console.log(`Wrote ${rows.length} vendable models -> ${path.relative(ROOT, OUT)}`);

/**
 * COMBIEN DE MODELES RAPPORTENT QUELQUE CHOSE A LEUR VENDEUR.
 *
 * ⚠ CE N'EST PAS UNE STATISTIQUE DECORATIVE. La prime vehicule vaut `% du grade x (prix client -
 * prix concession)`: un modele sans `dealerPrice` a un benefice de zero, donc il ne paie personne.
 * Le chiffre est imprime ici parce que c'est le SEUL endroit ou l'absence se voit; sur la caisse
 * elle se lit "prime 0 $", ce qui ressemble a une panne et pas a un catalogue a remplir.
 */
const withMargin = rows.filter((r) => r.dealerPriceDollars < r.priceDollars);
console.log(
  `  marge concession renseignee: ${withMargin.length}/${rows.length} modeles (dealerPrice dans vehicleList.lua)`,
);
if (withMargin.length < rows.length) {
  console.log(
    `  ${rows.length - withMargin.length} modele(s) sans dealerPrice: benefice 0, donc prime vehicule 0 pour le vendeur`,
  );
}
if (MIRRORS.length === 0) {
  console.log("  (aucune revente croisee active)");
} else {
  for (const { from, to } of MIRRORS) {
    const n = rows.filter((r) => r.sellers.includes(from) && r.sellers.includes(to)).length;
    console.log(`  revente croisee: ${from} -> ${to} (+${n} modeles)`);
  }
}
for (const [job, n] of [...bySeller.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${job}: ${n}`);
}

if (rows.length < 50) {
  console.error("Too few rows parsed; FleetRoster format probably drifted.");
  process.exit(1);
}
