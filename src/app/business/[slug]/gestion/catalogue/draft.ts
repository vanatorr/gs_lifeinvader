/**
 * LE BROUILLON D'UN ARTICLE: ce que le navigateur tient pendant qu'on tape, avant tout envoi.
 *
 * Module PUR, sans React et sans accès base: la vue le manipule, l'aperçu de vignette le lit, et
 * `actions.ts` n'en voit jamais rien (il reçoit des nombres, pas ce type). Le séparer évite que la
 * conversion dollars vers centimes existe en deux exemplaires légèrement différents, ce qui est
 * exactement la manière dont un prix affiché finit par ne plus être le prix enregistré.
 *
 * ⚠ LES MONTANTS SONT DU TEXTE ICI, PAS DES NOMBRES. Un champ que l'on vide passe par la chaîne
 * vide, qui n'a aucune représentation numérique honnête: la forcer en `0` réécrirait le champ sous
 * les doigts de la personne, et `NaN` contaminerait l'aperçu. Le texte reste du texte jusqu'à la
 * frontière serveur, où il devient un entier ou une erreur.
 */
import type { ItemRow } from "@/lib/business/catalogue";
import { suggestArtKey } from "@/lib/business/itemArt";

export type Draft = {
  label: string;
  category: string;
  /** DOLLARS, en texte. Le prix que le client paie. */
  price: string;
  /** DOLLARS, en texte. La part que l'EMPLOYEUR verse à l'employé, hors facture client. */
  commission: string;
  /** Une clé de `PRODUCT_ART`, ou null pour "pas d'illustration, l'icône du rayon suffit". */
  artKey: string | null;
  /**
   * LA PERSONNE A-T-ELLE CHOISI SON DESSIN À LA MAIN SUR CETTE FICHE.
   *
   * ⚠⚠ C'EST CE DRAPEAU QUI REND IMPOSSIBLE LA CLASSE DE BUG, pas un contrôle posé au bon endroit.
   * La pré-sélection automatique (voir `artSuggestion`) n'a le droit d'écrire `artKey` que tant que
   * ce drapeau est faux. Sans lui, il faudrait se souvenir, à CHAQUE endroit qui touche au libellé,
   * de ne pas écraser un choix: le premier oubli remplacerait en silence le dessin qu'un patron
   * vient de choisir, et personne ne le signalerait puisque le résultat reste plausible.
   *
   * Il vaut `false` sur une fiche NEUVE (il n'y a rien à écraser, donc la proposition s'applique
   * toute seule) et `true` dès qu'on ouvre un article EXISTANT: ce qui est en base est un choix,
   * y compris `null`. Sur une fiche existante la proposition se voit et s'applique d'un clic, mais
   * jamais toute seule.
   *
   * Il ne fait PAS partie de ce qui est enregistré: voir `sameDraft`.
   */
  artTouched: boolean;
};

/**
 * DOLLARS ENTIERS, décidé ici et une seule fois.
 *
 * ⚠ `theme.ts` `money()` et `priceParts()` ARRONDISSENT DÉJÀ au dollar partout ailleurs (caisse,
 * ticket, page Équipe). Accepter 12,50 $ produirait donc un article que le portail entier afficherait
 * à 13 $ tout en facturant 12,50 $: un écart permanent entre ce qu'on lit et ce qu'on doit.
 *
 * ⚠ CETTE VUE NE PRODUIT JAMAIS DE CENTIMES. La conversion vers l'unité de stockage appartient à
 * `actions.ts`, à la frontière serveur, et à lui seul: deux convertisseurs finissent toujours par
 * arrondir différemment, et c'est ainsi qu'un prix affiché cesse d'être le prix enregistré.
 *
 * Rend `NaN` sur une saisie qui n'est pas un nombre fini, y compris le champ vide: c'est la valeur
 * que la validation refuse, plutôt qu'un `0` silencieux qui offrirait un article gratuit sur une
 * faute de frappe.
 */
export function dollarsInt(text: string): number {
  const raw = String(text).trim().replace(",", ".");
  if (raw === "") return Number.NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : Number.NaN;
}

/** Le même calcul pour un AFFICHAGE seulement: une saisie illisible ou négative vaut zéro à l'écran. */
export function previewCents(text: string): number {
  const d = dollarsInt(text);
  return Number.isFinite(d) && d > 0 ? d * 100 : 0;
}

/** Centimes vers le texte du champ. Un article déjà enregistré en centimes s'arrondit au dollar. */
function centsToField(cents: number): string {
  return String(Math.round(cents / 100));
}

/**
 * LE DESSIN QUE LE NOM TAPÉ SUGGÈRE, ou `null` quand on ne sait pas.
 *
 * ⚠ `lib/business/itemArt.ts` existait avec sa table de 200 correspondances et ses 33 règles de
 * repli sur le libellé français, et RIEN NE L'APPELAIT: un patron qui tapait `atomburger` ou
 * "Verre de rouge" devait quand même parcourir 125 dessins à l'oeil pour retrouver celui que le
 * code connaissait déjà par coeur.
 *
 * ⚠ LE TEXTE TAPÉ SERT AUX DEUX ARGUMENTS, ET CE N'EST PAS UNE PARESSE. `suggestArtKey` essaie
 * d'abord un NOM D'ARTICLE DU JEU (`atomburger` donne le hamburger par correspondance exacte), puis
 * seulement ensuite les règles sur le LIBELLÉ français ("Bière pression" donne la bouteille). Le
 * champ du portail est un seul champ de texte libre où l'un comme l'autre peut être tapé, donc on
 * lui laisse les deux chances plutôt que de deviner laquelle des deux la personne voulait.
 *
 * ⚠ `null` EST UNE RÉPONSE, jamais un échec à masquer. Proposer un dessin plausible mettrait une
 * bière sur une ligne de pizza, ce qui est pire qu'une case vide parce que personne ne la corrigera.
 */
export function artSuggestion(label: string): string | null {
  const text = label.trim();
  if (text.length < 2) return null;
  return suggestArtKey(text, text);
}

export function draftFromRow(row: ItemRow): Draft {
  return {
    label: row.label,
    category: row.category,
    price: centsToField(row.priceCents),
    commission: centsToField(row.commissionCents),
    artKey: row.artKey,
    // Ce qui est en base est un choix, `null` compris: la proposition ne s'appliquera donc pas
    // toute seule sur cette fiche, elle s'offrira d'un clic.
    artTouched: true,
  };
}

export function emptyDraft(category: string): Draft {
  return { label: "", category, price: "0", commission: "0", artKey: null, artTouched: false };
}

/**
 * Deux brouillons identiques champ par champ. Sert uniquement à savoir si quelque chose est en jeu.
 *
 * ⚠ `artTouched` EST VOLONTAIREMENT EXCLU: c'est un état de l'interface, pas une donnée enregistrée.
 * Le comparer allumerait le bandeau "non enregistré" quand on reclique le dessin DÉJÀ choisi, donc
 * sur un geste qui ne change rien, et le bandeau ne voudrait plus rien dire.
 */
export function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.label === b.label &&
    a.category === b.category &&
    a.price === b.price &&
    a.commission === b.commission &&
    a.artKey === b.artKey
  );
}
