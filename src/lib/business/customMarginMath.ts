/**
 * LA MATH DU BAREME, PURE ET SANS BASE DE DONNEES.
 *
 * Separee de `customMargin.ts` pour la meme raison que `discordMessagePayload.ts` est separe de son
 * action: toute la politique de prix du serveur tient dans ces deux fonctions, et les laisser
 * derriere un `import { db }` les rendrait verifiables seulement contre une base vivante,
 * c'est-a-dire jamais. `npm run verify:custom-pricing` les exerce sur les ancres du proprietaire
 * sans qu'aucun serveur ne tourne.
 *
 * ⚠ RIEN ICI N'EST DESTINE AU NAVIGATEUR malgre l'absence de `server-only`. Ce fichier ne LIT aucun
 * coefficient, il ne fait que les appliquer: ce sont les valeurs, qui vivent en base et ne sortent
 * que par `customMargin.ts`, qui doivent rester serveur. Expedier ces fonctions au client sans les
 * valeurs ne revele rien; expedier les valeurs revelerait tout.
 */
export type MarginRule = {
  id: number;
  vehicleModel: string | null;
  vehicleCategory: string | null;
  slotKey: string | null;
  slotLevel: number | null;
  rateBps: number;
  labourCents: number;
  capBpsOfVehicle: number | null;
  note: string | null;
};

/* -- L'echelle de resolution ------------------------------------------------------------------- */

/**
 * LE POIDS DE CHAQUE AXE, additionne pour donner un ordre TOTAL.
 *
 * ⚠ `modele` (8) PESE PLUS QUE `categorie + slot + palier` (4+2+1 = 7), ET C'EST VOULU: nommer une
 * voiture precise est une affirmation plus specifique que nommer sa classe, meme quand l'autre
 * regle descend jusqu'au palier. Le cas ne se presente que si une voiture appartient AUSSI a la
 * categorie visee, et la reponse attendue est alors "ce que j'ai dit de CETTE voiture".
 *
 * ⚠ Et `modele + slot` (10) bat `modele` seul (8), ce qui est la forme meme des exemples du
 * proprietaire ("sur une Primo, la peinture x8"). Si un jour ces poids changent, ce sont ces deux
 * phrases-la qu'il faut relire, pas l'arithmetique.
 */
const W_MODEL = 8;
const W_CATEGORY = 4;
const W_SLOT = 2;
const W_LEVEL = 1;

/** Le poids total de la portee. Zero = la regle GLOBALE, la seule obligatoire. */
export function scopeScore(r: MarginRule): number {
  return (
    (r.vehicleModel !== null ? W_MODEL : 0) +
    (r.vehicleCategory !== null ? W_CATEGORY : 0) +
    (r.slotKey !== null ? W_SLOT : 0) +
    (r.slotLevel !== null ? W_LEVEL : 0)
  );
}

/** Une regle s'applique si CHAQUE axe renseigne correspond. Un axe NULL ne contraint rien. */
function applies(
  r: MarginRule,
  ctx: { model: string; category: string; slotKey: string; level: number },
): boolean {
  if (r.vehicleModel !== null && r.vehicleModel !== ctx.model) return false;
  if (r.vehicleCategory !== null && r.vehicleCategory !== ctx.category) return false;
  if (r.slotKey !== null && r.slotKey !== ctx.slotKey) return false;
  if (r.slotLevel !== null && r.slotLevel !== ctx.level) return false;
  return true;
}

/**
 * LA REGLE GAGNANTE, ou null si AUCUNE ne s'applique.
 *
 * ⚠ PURE ET EXPORTEE POUR ETRE TESTEE. Toute la politique de prix du serveur tient dans cette
 * fonction; la laisser enfouie derriere une requete la rendrait verifiable seulement contre une base
 * vivante, c'est-a-dire jamais.
 *
 * ⚠ A EGALITE DE SPECIFICITE, LA PLUS RECENTE GAGNE (`id` le plus grand). Corriger un prix se fait
 * donc en ajoutant une ligne, jamais en cherchant laquelle editer. L'index unique interdit deja deux
 * lignes de meme portee, donc cette egalite ne devrait pas survenir: c'est un depart deterministe
 * pour le cas ou elle surviendrait quand meme, pas une fonctionnalite.
 */
export function pickRule(
  rules: MarginRule[],
  ctx: { model: string; category: string; slotKey: string; level: number },
): MarginRule | null {
  let best: MarginRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (!applies(r, ctx)) continue;
    const s = scopeScore(r);
    if (s > bestScore || (s === bestScore && best !== null && r.id > best.id)) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

/**
 * LE PRIX CLIENT depuis un cout et une regle. Pur, et arrondi au DOLLAR.
 *
 * ⚠ L'ARRONDI AU DOLLAR N'EST PAS COSMETIQUE. `money()` et `priceParts()` arrondissent TOUT
 * affichage au dollar pres, donc un prix a 711,82 $ se lirait 712 $ partout en etant enregistre a
 * 711,82 $: un ecart permanent entre ce que le client a lu sur sa facture et ce que la base dit
 * qu'il a paye. `declareFreeSale` impose deja la meme regle (`priceCents % 100 !== 0` est un refus).
 *
 * ⚠ LE PLAFOND S'APPLIQUE APRES, et il est exprime en part de la VALEUR DU VEHICULE. Il existe pour
 * le bas de gamme: sur une moto a 1 000 $, une peinture coute 11 $ de pieces et le seul forfait la
 * ferait sortir a 613 $, soit 61 % de l'engin. Un plafond en dollars ne pourrait rien dire de vrai
 * a la fois sur une voiture a 3 000 $ et sur une a 12 000 000 $.
 *
 * ⚠ LE PLAFOND NE DESCEND JAMAIS SOUS LE COUT DES PIECES. Un plafond mal regle ferait autrement
 * vendre a perte, en silence, sur toute une categorie: la societe paie les pieces au jeu quoi qu'il
 * arrive, donc un prix inferieur au cout est de l'argent que le garage donne au client.
 */
export function applyMargin(
  costCents: number,
  rule: MarginRule,
  vehicleValueCents: number,
): { priceCents: number; cappedBy: number | null } {
  const raw = (costCents * rule.rateBps) / 10_000 + rule.labourCents;
  let priceCents = Math.round(raw / 100) * 100;

  let cappedBy: number | null = null;
  if (rule.capBpsOfVehicle !== null && rule.capBpsOfVehicle > 0) {
    const ceiling = Math.round((vehicleValueCents * rule.capBpsOfVehicle) / 10_000 / 100) * 100;
    // Jamais sous le cout: voir l'avertissement ci-dessus.
    const floored = Math.max(ceiling, Math.ceil(costCents / 100) * 100);
    if (floored < priceCents) {
      priceCents = floored;
      cappedBy = rule.capBpsOfVehicle;
    }
  }
  return { priceCents, cappedBy };
}
