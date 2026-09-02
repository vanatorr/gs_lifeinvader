/**
 * LES BORNES D'UNE IDENTITÉ, LUES DANS LES FICHIERS DU JEU.
 *
 * ⚠⚠ RIEN N'EST ÉCRIT EN DUR ICI, ET C'EST LE POINT. `gs_identity/config.lua` décide déjà de la
 * longueur d'un nom et de l'intervalle d'années de naissance; `gcphone/config.lua` décide déjà de la
 * longueur d'un numéro. Recopier ces trois nombres dans CITADEL fabriquerait un second jeu de règles
 * qui dérive en silence: le jour où le propriétaire déplace `Config.HighestYear`, la fiche d'identité
 * en jeu accepte une date que la caisse du concessionnaire refuse, et le refus est incompréhensible
 * des deux côtés parce que chacun a raison chez lui.
 *
 * Même discipline, et même raison, que `lib/data/vehicleMods.ts` lisant `esx_lscustom/config.lua` et
 * `lib/data/vehicleModels.ts` lisant `vehicleList.lua`: la donnée appartient au jeu, CITADEL la lit.
 *
 * ⚠ SI UN FICHIER EST ILLISIBLE, ON RETOMBE SUR `CLIENT_RECORD_BOUNDS_FALLBACK` PLUTÔT QUE DE
 * REFUSER TOUTE SAISIE. Un `citadel/` déployé sans `fivem/` à côté ne doit pas rendre la caisse
 * inutilisable; il doit être un peu plus permissif, ce qui est le bon côté de l'erreur pour un champ
 * de paperasse. Le masque du téléphone, lui, passe à `null` (fourchette large) au lieu de deviner
 * sept chiffres - voir `phoneDigits` dans `clientRecord.ts`.
 */
import "server-only";
import fs from "node:fs";
import path from "node:path";
import {
  CLIENT_RECORD_BOUNDS_FALLBACK,
  PHONE_MAX_DIGITS,
  type ClientRecordBounds,
} from "./clientRecord";

// citadel/ et fivem/ sont voisins; `process.cwd()` est la racine de ce paquet sous next dev/start.
// Même résolution que vehicleMods.ts, pour que les deux cassent ou marchent ensemble.
const RESOURCES_DIR = path.resolve(process.cwd(), "../fivem/server-data/resources");
const IDENTITY_CONFIG = path.join(RESOURCES_DIR, "gs_identity", "config.lua");
const PHONE_CONFIG = path.join(RESOURCES_DIR, "gcphone", "config.lua");

function readOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** `Config.MaxNameLength    = 20` - un entier nommé au premier niveau de la table Config. */
function luaInt(src: string, key: string): number | null {
  const m = src.match(new RegExp(`Config\\.${key}\\s*=\\s*(-?\\d+)`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Le nombre de `#` du masque de génération des numéros.
 *
 * ⚠ DEUX FORMES COEXISTENT, ET LES DEUX SONT VIVANTES: CET ARBRE ET LA PRODUCTION NE FONT PAS
 * TOURNER LE MÊME TÉLÉPHONE. Le gcphone de cet arbre déclare `Config.PhoneNumberMask = '#######'`
 * au premier niveau (`gcphone/config.lua:35`); celui qui tourne en production déclare le même
 * masque dans un bloc `Number = { Mask = '#######' }` (`config.lua:379-388`, byte pour byte le
 * `gcphone_old/config.lua` de cet arbre, vérifié sur la VM le 2026-08-27). On lit donc LES DEUX,
 * jamais l'une à la place de l'autre: ne garder que la forme du poste de travail ferait appliquer
 * une borne de secours à la SEULE machine où de vrais employés saisissent des numéros, et rien ne
 * le signalerait, puisque le repli est précisément conçu pour ne pas casser la caisse. Voir le bloc
 * "DO NOT DEPLOY THE NEW gcphone" de `CLAUDE.md`: cet écart de forme est délibéré et il dure.
 *
 * L'ordre suit le jeu, ce n'est pas une préférence: le téléphone actuel lit `Config.PhoneNumberMask`
 * et ignorerait un bloc `Number` resté derrière lui, donc le scalaire l'emporte quand il existe.
 *
 * ⚠ ON SE PLACE DANS LE BLOC `Number = {` POUR LA SECONDE FORME. Le même fichier y déclare
 * `HiddenLabel = '#######'` quelques lignes plus bas, et un jour un troisième masque s'ajoutera:
 * cadrer sur le bloc évite de lire le mauvais, ce qui ne produirait aucune erreur, juste une
 * longueur fausse appliquée à tous les numéros saisis par les concessionnaires.
 *
 * ⚠ LES DEUX MOTIFS SONT ANCRÉS EN DÉBUT DE LIGNE, CE QUI ÉCARTE LES COMMENTAIRES LUA. Ces deux
 * fichiers en sont pleins et y citent des masques verbatim (`-- '#######' (7 digits, NO separator)`,
 * et une ligne qui nomme `Config.Phone.Number.Mask`): un motif flottant finirait par lire l'exemple
 * d'un commentaire à la place de la valeur, en silence. Une forme mise en page autrement rend `null`
 * plutôt qu'un nombre faux, ce qui est le bon côté de l'erreur ici, et l'assertion de
 * `verify:business` le voit.
 *
 * ⚠ ET ON NE COMPTE QUE LES `#`. Le masque copie verbatim tout autre caractère, mais la règle du
 * propriétaire (2026-07-15) est que ce masque reste EN CHIFFRES SEULS, et `normalizePhone` ne stocke
 * que des chiffres. Compter la longueur de la chaîne au lieu de ses `#` ferait mentir la contrainte
 * dès que quelqu'un y remettrait un séparateur.
 */
function phoneDigitsFromMask(src: string): number | null {
  // Forme A, le téléphone de cet arbre: un scalaire au premier niveau de `Config`.
  let m = src.match(/^[ \t]*Config\.PhoneNumberMask\s*=\s*'([^']*)'/m);

  if (!m) {
    // Forme B, le téléphone de production: le masque vit dans le bloc `Number = {`.
    const block = src.match(/Number\s*=\s*\{([\s\S]{0,4000}?)\}/);
    const scope = block?.[1] ?? src;
    m = scope.match(/^[ \t]*Mask\s*=\s*'([^']*)'/m);
  }

  if (!m) return null;
  const count = (m[1]!.match(/#/g) ?? []).length;
  if (count <= 0 || count > PHONE_MAX_DIGITS) return null;
  return count;
}

type Cache = { loadedAt: number; bounds: ClientRecordBounds };
// Ces fichiers changent à peu près aussi souvent que la liste de prix du garagiste.
const TTL_MS = 10 * 60_000;
const globalForRules = globalThis as unknown as { citadelClientRecordBounds?: Cache };

/**
 * LES BORNES, résolues une fois puis mises en cache.
 *
 * ⚠ SYNCHRONE ET MIS EN CACHE SUR `globalThis`, comme `vehicleMods.ts`: ces lectures arrivent sur le
 * chemin du rendu de la caisse et de chaque déclaration, et relire deux fichiers à chaque appel
 * mettrait un accès disque dans une transaction.
 */
export function clientRecordBounds(): ClientRecordBounds {
  const now = Date.now();
  const cached = globalForRules.citadelClientRecordBounds;
  if (cached && now - cached.loadedAt < TTL_MS) return cached.bounds;

  const identity = readOrEmpty(IDENTITY_CONFIG);
  const phone = readOrEmpty(PHONE_CONFIG);

  const maxNameLength = luaInt(identity, "MaxNameLength");
  const lowestYear = luaInt(identity, "LowestYear");
  const highestYear = luaInt(identity, "HighestYear");

  const resolved: ClientRecordBounds = {
    maxNameLength: maxNameLength ?? CLIENT_RECORD_BOUNDS_FALLBACK.maxNameLength,
    lowestYear: lowestYear ?? CLIENT_RECORD_BOUNDS_FALLBACK.lowestYear,
    highestYear: highestYear ?? CLIENT_RECORD_BOUNDS_FALLBACK.highestYear,
    phoneDigits: phoneDigitsFromMask(phone),
  };

  // ⚠ Un intervalle inversé (quelqu'un a interverti les deux lignes en jeu) refuserait TOUTE date
  // sans rien dire. On retombe alors sur le repli plutôt que de rendre la caisse inutilisable.
  const bounds =
    resolved.lowestYear > resolved.highestYear
      ? {
          ...resolved,
          lowestYear: CLIENT_RECORD_BOUNDS_FALLBACK.lowestYear,
          highestYear: CLIENT_RECORD_BOUNDS_FALLBACK.highestYear,
        }
      : resolved;

  globalForRules.citadelClientRecordBounds = { loadedAt: now, bounds };
  return bounds;
}
