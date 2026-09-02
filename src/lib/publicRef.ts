/**
 * LA référence publique citable: le suffixe aléatoire partagé par les tickets et les ventes.
 *
 * Extrait de lib/data/ticketTypes.ts (2026-08-08) quand le portail commerces a eu besoin du même
 * générateur. Copié, le raisonnement ci-dessous aurait dérivé dans une des deux copies, et il n'est
 * pas devinable: chacune de ces trois contraintes a une raison précise, et se tromper sur l'une
 * d'elles ne casse rien de visible.
 *
 * ⚠ Ce fichier est importé par des composants CLIENT (via ticketTypes.ts), donc: pas de `node:crypto`,
 * pas d'accès base, aucune dépendance serveur. `getRandomValues` est un standard web présent dans
 * Node 18+ et dans tous les navigateurs.
 */

/**
 * Crockford Base32: 32 symboles, délibérément SANS I, L, O ni U.
 *
 * L'alphabet est choisi pour la TRANSCRIPTION, pas pour l'entropie: la référence est lue à l'oeil sur
 * un message et retapée à la main, donc I/L contre 1 et O contre 0 sont le mode d'échec qui arrive
 * vraiment. Retirer U est l'astuce de Crockford lui-même: sur quatre caractères tirés au hasard, un
 * alphabet avec des voyelles finit par écrire un mot qu'on ne veut envoyer à personne.
 *
 * ⚠ CASSE UNIQUE, et ce n'est pas cosmétique. La collation des colonnes `public_ref` est
 * insensible à la casse, donc un alphabet mixte ne doublerait PAS l'espace de clés: 'a3f9' et 'A3F9'
 * sont la MÊME valeur pour l'index unique. Ajouter des minuscules fabriquerait des collisions, pas
 * de l'entropie.
 *
 * ⚠ 32 divise 256 exactement, donc `octet % 32` est non biaisé et n'a besoin d'aucun rejet
 * d'échantillon. Changer la longueur de l'alphabet pour une valeur qui ne divise pas 256 (36, par
 * exemple) biaiserait silencieusement le tirage vers les premiers symboles: si vous y touchez,
 * corrigez aussi l'échantillonnage.
 */
export const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Caractères aléatoires après le préfixe. 32^4 = 1 048 576 références par préfixe. */
export const REF_RANDOM_LENGTH = 4;

export function randomRefSuffix(length: number = REF_RANDOM_LENGTH): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return out;
}
