/**
 * LA PART EMPLOYÉ: combien l'employeur verse à la personne qui a fait la vente.
 *
 * DEUX MODES, et le second est né du salon de tatouage. Un bar vend des articles au catalogue fixe,
 * donc "2 $ par bière" se règle article par article et c'est le mode `montant`, celui qui existait
 * seul jusqu'ici. Un tatoueur, lui, ne vend pas un article: il négocie une pièce, et sa rémunération
 * est une FRACTION de la facture, la même quel que soit le prix convenu. Exprimer ça en montant fixe
 * obligerait à retoucher vingt lignes de catalogue à chaque changement d'accord, et la part serait
 * fausse dès qu'un prix bouge.
 *
 * ⚠ CE FICHIER NE DÉPLACE AUCUN ARGENT, comme le reste du portail. Il calcule un CHIFFRE que
 * l'employeur verse à la main en jeu. Voir l'en-tête de sales.ts: une vente est DÉCLARÉE, pas mesurée.
 *
 * ⚠ LA PART NE SORT JAMAIS DE LA FACTURE DU CLIENT, dans les deux modes. Le client paie le prix
 * affiché; l'employeur verse la part en fin de semaine. Un pourcentage rend ce malentendu PLUS facile
 * à commettre qu'un montant ("50 % de la facture" se lit comme une remise), donc toute copie qui
 * l'affiche doit le dire, et c'est pour ça que la formulation "hors facture" est répétée partout.
 *
 * ⚠ EN POINTS DE BASE (bps), JAMAIS EN NOMBRE À VIRGULE. 62,5 % vaut 6250, un entier. Stocker 0.625
 * ferait rentrer un flottant dans un calcul d'argent, exactement ce que le schéma s'interdit ligne à
 * ligne en ne stockant que des centimes entiers. Un entier se compare, s'additionne et se relit sans
 * jamais produire un centime de dérive.
 */

/** `montant` = un montant fixe PAR ARTICLE. `pourcentage` = une fraction de la ligne facturée. */
export type CommissionMode = "montant" | "pourcentage";

export type CommissionPolicy = {
  mode: CommissionMode;
  /** Le taux qui s'applique à DÉFAUT, en points de base. 5000 = 50 %. Ignoré en mode `montant`. */
  bps: number;
  /**
   * Les écarts PAR PERSONNE, identifiant hex nu -> bps. Un salon de tatouage n'a pas un taux, il a
   * un accord par artiste, et c'est la demande d'origine ("the boss can choose % of which employee
   * gets paid"). Absent de la table = le taux par défaut, jamais zéro: une personne qu'on n'a pas
   * encore réglée doit toucher quelque chose, pas rien.
   *
   * ⚠ La clé est l'identifiant du PERSONNAGE (hex nu, `users.identifier`), la même forme que
   * `lifeinvader_business_sales.seller_identifier`. Jamais la forme préfixée `license:`, qui ne joint
   * rien nulle part sur ce serveur.
   */
  byEmployee: Record<string, number>;
  /**
   * ⚠⚠ RETIRÉ DU CALCUL LE 2026-08-27. LU ET ÉCRIT, PLUS JAMAIS APPLIQUÉ.
   *
   * C'était: "quelle fraction du prix catalogue est du profit", une marge estimée à la main par
   * concession, faute de connaître le coût réel d'une voiture. Son défaut valait 10 000 bps (100 %),
   * et il était resté à 100 % en base sur les DEUX concessions du serveur, ce qui faisait payer aux
   * grades un pourcentage du PRIX ENTIER au lieu du bénéfice. Voir `vehicleUnitCommissionCents`.
   *
   * Le bénéfice est désormais mesuré depuis le catalogue du jeu (`price` - `dealerPrice`), donc plus
   * rien n'a besoin de l'estimer.
   *
   * ⚠ LA CLÉ RESTE DANS LE TYPE ET DANS LE JSON EXPRÈS. La colonne `commission` porte les politiques
   * déjà enregistrées; la retirer du parseur ferait disparaître la valeur au premier enregistrement
   * du patron, et on perdrait la trace de ce qui a produit les primes déjà versées. Elle ne doit
   * simplement plus apparaître dans aucun calcul ni dans aucun formulaire.
   */
  vehicleProfitBps: number;
  /**
   * CONCESSION: grade ESX (`users.job_grade`) -> % du profit, en bps.
   *
   * ⚠ LA CLÉ EST LE NUMÉRO DE GRADE, pas le nom (`recrue`/`boss`). Le nom change, le numéro est
   * ce que le jeu porte sur le personnage au moment de la vente. Absent = 0, jamais le taux
   * boutique: confondre les deux paierait 50 % d'une supercar parce que le salon d'à côté paie
   * 50 % d'un tatouage.
   */
  byGrade: Record<string, number>;
};

/**
 * 100 %, et pas plus.
 *
 * ⚠ Volontairement PLUS STRICT que le mode `montant`, qui autorise une part supérieure au prix (voir
 * `validateItem`: c'est légitime, l'employeur peut décider de payer 15 $ sur une bière à 10 $). Un
 * POURCENTAGE au-dessus de 100 n'est presque jamais ça: c'est une virgule mal placée ou un zéro de
 * trop, et l'erreur ne se voit qu'à la paie, une semaine plus tard, sur des ventes déjà figées. Qui
 * veut vraiment payer plus que la facture le dit en montant, où la borne n'existe pas.
 */
export const MAX_COMMISSION_BPS = 10_000;

/** Le pas de saisie: un dixième de pourcent. 62,5 % est un accord courant; 62,53 % n'existe pas. */
export const COMMISSION_BPS_STEP = 10;

/**
 * CE QU'UN COMMERCE QUI N'A JAMAIS RIEN RÉGLÉ APPLIQUE.
 *
 * Mode `montant` à 0 bps: exactement le comportement d'avant l'existence de ce fichier, pour que les
 * commerces déjà en service ne changent de rien. Un défaut en pourcentage aurait réécrit la paie de
 * tout le monde à la première mise en ligne.
 */
export const DEFAULT_COMMISSION: CommissionPolicy = {
  mode: "montant",
  bps: 0,
  byEmployee: {},
  vehicleProfitBps: 10_000,
  byGrade: {},
};

/** Un mode connu, ou null. Sert autant à la lecture (donnée douteuse) qu'à l'écriture (POST forgé). */
function readMode(raw: unknown): CommissionMode | null {
  return raw === "montant" || raw === "pourcentage" ? raw : null;
}

/**
 * Un taux en bps, borné, ou null s'il n'en est pas un.
 *
 * ⚠ `Math.trunc` et non `Math.round`: la conversion pourcent -> bps se fait à la frontière du
 * formulaire (voir `percentToBps`), donc tout ce qui arrive ici avec des décimales est du bruit, pas
 * une précision qu'on voudrait arrondir au plus proche.
 */
function readBps(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const v = Math.trunc(n);
  if (v < 0 || v > MAX_COMMISSION_BPS) return null;
  return v;
}

/**
 * LA POLITIQUE EFFECTIVE: ce qui est enregistré sur le commerce, sinon ce que propose son modèle,
 * sinon le défaut.
 *
 * Même cascade et même raison que `resolveModules`: le commerce ne stocke QUE ce qu'il a décidé, donc
 * un salon qui n'a jamais ouvert la page hérite du taux que le modèle "tatouage" propose, et retoucher
 * le modèle met à jour tous les salons qui n'ont rien personnalisé.
 *
 * ⚠ ON NE FUSIONNE PAS CLÉ PAR CLÉ AVEC LE MODÈLE UNE FOIS QUE LE COMMERCE A ÉCRIT. Un modèle propose
 * un point de départ; une politique de paie à moitié héritée produirait un couple (mode, taux) que
 * personne n'a choisi - typiquement un mode `pourcentage` gardé du modèle avec un taux remis à zéro,
 * c'est-à-dire des employés payés zéro sans que rien ne l'ait dit.
 *
 * ⚠ FAIL-SOFT, JAMAIS D'EXCEPTION. La colonne est du JSON libre qu'un humain peut avoir édité à la
 * main: une valeur illisible retombe sur le défaut plutôt que de faire tomber le résolveur d'accès,
 * qui tourne à CHAQUE rendu et à CHAQUE mutation de tout le portail.
 */
export function resolveCommission(
  stored: unknown,
  fromTemplate?: Partial<CommissionPolicy> | null,
): CommissionPolicy {
  const base: CommissionPolicy = {
    mode: readMode(fromTemplate?.mode) ?? DEFAULT_COMMISSION.mode,
    bps: readBps(fromTemplate?.bps) ?? DEFAULT_COMMISSION.bps,
    byEmployee: {},
    vehicleProfitBps: readBps(fromTemplate?.vehicleProfitBps) ?? DEFAULT_COMMISSION.vehicleProfitBps,
    byGrade: readByGrade(fromTemplate?.byGrade),
  };
  if (!stored || typeof stored !== "object") return base;

  const raw = stored as Partial<CommissionPolicy>;
  const mode = readMode(raw.mode);
  if (mode === null) return base;

  return {
    mode,
    bps: readBps(raw.bps) ?? 0,
    byEmployee: readByEmployee(raw.byEmployee),
    vehicleProfitBps: readBps(raw.vehicleProfitBps) ?? base.vehicleProfitBps,
    byGrade: readByGrade(raw.byGrade),
  };
}

/**
 * La table des écarts, nettoyée.
 *
 * ⚠ UNE CLÉ HORS-FORMAT EST ÉCARTÉE, pas corrigée. Ces clés sont des identifiants de personnage et
 * servent de jointure en mémoire avec `users.identifier`; une clé inventée depuis un POST forgé ne
 * joindrait rien, mais elle s'accumulerait en base où elle ressemblerait plus tard à un accord réel.
 */
function readByEmployee(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isIdentifier(id)) continue;
    const bps = readBps(v);
    if (bps === null) continue;
    out[id] = bps;
  }
  return out;
}

/**
 * Une clé qui a la FORME d'un identifiant de personnage.
 *
 * ⚠ DÉLIBÉRÉMENT PLUS LARGE QUE `^[0-9a-f]{40}$`, la forme que prend `users.identifier` sur ce
 * serveur aujourd'hui. Ce contrôle n'autorise personne: la vraie porte est la liste blanche de
 * l'effectif réel dans `sanitizeCommission`, et elle est infranchissable. Ce qu'il fait, c'est
 * écarter du JSON manifestement bidon. Le rendre strictement hexadécimal l'aurait transformé en
 * seconde autorisation, muette celle-là: le jour où un personnage porte un identifiant d'une autre
 * forme (une base importée, un `steam:` resté d'un ancien import), son patron ne pourrait plus lui
 * régler de taux et RIEN ne le lui dirait - le champ se viderait tout seul à l'enregistrement.
 */
function isIdentifier(v: string): boolean {
  return /^[A-Za-z0-9:_-]{4,60}$/.test(v);
}

/**
 * LE TAUX QUI S'APPLIQUE À CETTE PERSONNE: son accord s'il existe, sinon celui du commerce.
 *
 * ⚠ `??` ET SURTOUT PAS `||`. Un accord à 0 % est une DÉCISION (un apprenti non commissionné), et
 * `||` la remplacerait silencieusement par le taux par défaut - c'est-à-dire payerait quelqu'un que
 * le patron a explicitement mis à zéro. Le zéro est une valeur, pas une absence.
 */
function readByGrade(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) continue;
    const bps = readBps(v);
    if (bps === null) continue;
    out[k] = bps;
  }
  return out;
}

export function rateFor(policy: CommissionPolicy, identifier: string): number {
  if (policy.mode !== "pourcentage") return 0;
  return policy.byEmployee[identifier] ?? policy.bps;
}

/**
 * LA PART SUR UNE UNITÉ VENDUE, en centimes entiers.
 *
 * ⚠ CALCULÉE PAR UNITÉ ET NON SUR LE TOTAL DE LA LIGNE, parce que c'est ce que la colonne stocke
 * (`sale_lines.unit_commission_cents`) et que l'invariant du ticket est
 * `sale.commission_cents == Σ ligne.unit_commission * qty`. Calculer sur le total puis diviser
 * casserait cet invariant d'un centime dès que la division ne tombe pas juste, et cet écart-là ne se
 * verrait nulle part avant un rapprochement de fin de semaine.
 *
 * L'arrondi au plus proche, et non vers le bas: sur une part de 50 % d'un prix impair, tronquer
 * ferait perdre un centime à l'employé à chaque vente, systématiquement du même côté.
 */
export function unitCommissionCents(priceCents: number, bps: number): number {
  if (bps <= 0 || priceCents <= 0) return 0;
  return Math.round((priceCents * bps) / 10_000);
}

export function rateForGrade(policy: CommissionPolicy, grade: number): number {
  if (!Number.isInteger(grade) || grade < 0) return 0;
  return policy.byGrade[String(grade)] ?? 0;
}

/**
 * LA PART SUR UNE VOITURE, en centimes: le % du grade SUR LE BÉNÉFICE RÉEL DE LA CONCESSION.
 *
 * ⚠⚠ CE N'EST PLUS UN POURCENTAGE DU PRIX CATALOGUE, ET C'EST LA CORRECTION DU 2026-08-27. La
 * version précédente prenait `prix x vehicleProfitBps x gradeBps`, où `vehicleProfitBps` était une
 * marge saisie à la main par concession. Son défaut valait 10 000 bps, c'est-à-dire 100 %, et
 * personne ne l'avait jamais changé: PDM et Luxury étaient toutes les deux à 100 % en base. "5 % du
 * profit" pour un stagiaire voulait donc dire 5 % du PRIX ENTIER, soit 8 000 $ sur une Raiden à
 * 160 000 $ et 20 900 $ de primes générées sur 17 voitures. Le propriétaire l'a résumé ainsi:
 * *"its not acc actulating profit client cost - car dealer cost"*.
 *
 * Le bénéfice est maintenant MESURÉ, jamais estimé: `prix client - prix concession`, les deux lus
 * dans le catalogue du jeu (`price` et `dealerPrice` de FleetRoster, voir fleet.ts). Un modèle sans
 * `dealerPrice` a un bénéfice de zéro et ne paie donc rien: c'est un catalogue à compléter, pas une
 * panne, et l'extracteur imprime la couverture à chaque passe pour que ça se voie.
 *
 * ⚠ PLAFONNÉE AU BÉNÉFICE, comme la part customs (`declareCustomSale`, sales.ts). Un taux mal réglé
 * doit plafonner, pas creuser: sans ça un grade réglé à 150 % par erreur ferait perdre de l'argent
 * à l'entreprise sur chaque vente, et ça ne se verrait qu'à la paie.
 *
 * ⚠ `marginCents` EST DÉJÀ LE BÉNÉFICE, pas le prix. Lui passer un prix rendrait exactement l'ancien
 * bug, en silence: les deux sont des entiers positifs en centimes et rien ne les distingue ici.
 */
export function vehicleUnitCommissionCents(marginCents: number, gradeBps: number): number {
  if (marginCents <= 0) return 0;
  return Math.min(marginCents, unitCommissionCents(marginCents, gradeBps));
}

/* ── Frontière du formulaire ──────────────────────────────────────────────────────────────────── */

/**
 * Pourcent saisi -> bps stockés. `62,5` -> `6250`.
 *
 * ⚠ ON ARRONDIT AU PAS AVANT DE BORNER. Sans le pas, une saisie collée depuis un tableur
 * (`62.4999999`) entrerait en base comme 6249, et l'écran réafficherait 62,49 % à quelqu'un qui a
 * tapé 62,5: une valeur qui change toute seule est indiscernable d'une panne.
 */
export function percentToBps(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const stepped = Math.round((n * 100) / COMMISSION_BPS_STEP) * COMMISSION_BPS_STEP;
  if (stepped < 0 || stepped > MAX_COMMISSION_BPS) return null;
  return stepped;
}

/** bps -> pourcent affichable. `6250` -> `62.5`. */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/** `62,5 %`, en français. Le seul endroit qui met le symbole, pour qu'il ne se perde pas ailleurs. */
export function formatRate(bps: number): string {
  return `${bpsToPercent(bps).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;
}

export type CommissionError = "bad_mode" | "bad_rate" | "unknown_employee";

/**
 * CE QU'ON ACCEPTE D'ÉCRIRE. Rien de ce que le navigateur envoie n'est une vérité (voir l'en-tête des
 * Server Actions du catalogue): un Server Action est un POST public.
 *
 * ⚠ LES IDENTIFIANTS SONT PROUVÉS CONTRE L'EFFECTIF RÉEL, pas seulement contre une expression
 * régulière. Sans ça, un POST forgé remplirait `byEmployee` de milliers de clés bien formées mais
 * étrangères au commerce: elles ne paieraient personne, mais elles gonfleraient une colonne JSON lue
 * à chaque rendu du portail, et elles ressembleraient à des accords réels le jour où quelqu'un
 * ouvrirait la ligne en base.
 *
 * ⚠ ON PURGE AUSSI LES ANCIENS: un accord ne survit pas au départ de la personne. Ce n'est pas du
 * ménage cosmétique - un identifiant qui revient plus tard dans l'effectif (réembauche) reprendrait
 * sinon un taux négocié il y a six mois, sans que personne ne l'ait décidé.
 */
export function sanitizeCommission(
  raw: unknown,
  knownIdentifiers: ReadonlySet<string>,
  knownGrades?: ReadonlySet<number>,
): { ok: true; policy: CommissionPolicy } | { ok: false; error: CommissionError } {
  const input = (raw ?? {}) as Partial<CommissionPolicy>;

  const mode = readMode(input.mode);
  if (mode === null) return { ok: false, error: "bad_mode" };

  const bps = readBps(input.bps);
  if (bps === null) return { ok: false, error: "bad_rate" };

  const vehicleProfitBps = readBps(input.vehicleProfitBps ?? DEFAULT_COMMISSION.vehicleProfitBps);
  if (vehicleProfitBps === null) return { ok: false, error: "bad_rate" };

  const byEmployee: Record<string, number> = {};
  for (const [id, v] of Object.entries(input.byEmployee ?? {})) {
    if (!isIdentifier(id) || !knownIdentifiers.has(id)) continue;
    const rate = readBps(v);
    if (rate === null) return { ok: false, error: "bad_rate" };
    // Un écart égal au taux du commerce n'est pas un écart: ne pas le stocker garde la ligne petite
    // et fait que remonter le taux général emporte bien tout le monde, au lieu de laisser des gens
    // figés sur une valeur qu'ils avaient l'air d'avoir choisie.
    if (rate === bps) continue;
    byEmployee[id] = rate;
  }

  const byGrade: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.byGrade ?? {})) {
    if (!/^\d+$/.test(k)) continue;
    const grade = Number(k);
    if (knownGrades && !knownGrades.has(grade)) continue;
    const rate = readBps(v);
    if (rate === null) return { ok: false, error: "bad_rate" };
    byGrade[k] = rate;
  }

  return { ok: true, policy: { mode, bps, byEmployee, vehicleProfitBps, byGrade } };
}
