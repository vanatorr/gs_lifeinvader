/**
 * L'ADRESSE D'UN PORTAIL, dérivée de l'enseigne.
 *
 * ⚠ FICHIER PUR, SANS `server-only`, ET C'EST LA RAISON DE SON EXISTENCE. La console réseau
 * pré-remplit l'adresse pendant qu'on tape l'enseigne, donc le NAVIGATEUR a besoin de cette
 * fonction; `lib/business/network.ts` est `server-only` et l'y laisser aurait fait échouer la
 * compilation du composant client. Recopier la règle dans la page aurait été pire: deux copies
 * divergent, et ici la divergence produirait une adresse proposée qui n'est pas celle enregistrée.
 * Même raisonnement que `lib/data/discordMessagePayload.ts`, partagé entre l'aperçu et l'envoi.
 *
 * ⚠ LES APOSTROPHES ET LES ACCENTS NE SONT PAS DES SÉPARATEURS. Une première version faisait
 * `[^a-z0-9]+ -> "-"`, ce qui transformait "Benny's Motorworks" en `benny-s-motorworks`. On dépose
 * donc les accents, on SUPPRIME les apostrophes, et seul ce qui reste devient un tiret.
 */
export function slugifyPortal(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * `reseau` EST la console elle-même (`/business/reseau`), donc aucun commerce ne peut le porter.
 *
 * Next résout un segment statique avant un segment dynamique, donc un portail nommé `reseau`
 * n'ouvrirait pas une mauvaise page: il serait simplement INATTEIGNABLE, ce qui est plus difficile
 * à comprendre qu'un refus à la saisie.
 */
export const RESERVED_PORTAL_SLUGS = new Set(["reseau"]);

/** Minuscules, chiffres et tirets, sans tiret en bordure, et pas un slug réservé. */
export function isValidPortalSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/.test(slug) && !RESERVED_PORTAL_SLUGS.has(slug);
}
