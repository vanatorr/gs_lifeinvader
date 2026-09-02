/**
 * LA FICHE CLIENT D'UN TICKET: à QUI on a vendu, et SUR QUELLE VOITURE.
 *
 * Demande du propriétaire (2026-08-21): *"when declaring a car dealer's sale they need to insert the
 * firstname lastname birthdate and phone number of the person they sell to"*, *"same with car
 * mechanics"*, *"and all the customs and what car"*, *"also for both car dealer and mechanic also the
 * plate of the car"*. Une concession et un garage ne vendent pas une tournée: ils remettent un
 * véhicule identifiable à une personne identifiable, et la déclaration doit porter les deux.
 *
 * ⚠ CE FICHIER EST PUR, ET C'EST CE QUI LE REND UTILE DEUX FOIS. Il ne touche ni la base, ni le
 * disque, ni `server-only`: la caisse l'importe pour dire à l'employé ce qui cloche AVANT l'envoi, et
 * `declareSale` l'importe pour refuser exactement les mêmes saisies APRÈS. Même précédent, et même
 * raison, que `lib/data/discordMessagePayload.ts`: deux validateurs écrits séparément finissent par
 * diverger, et le jour où ils divergent l'écran dit "c'est bon" pendant que le serveur refuse.
 *
 * ⚠⚠ LE CONTRÔLE DE LA CAISSE NE VAUT RIEN À LUI SEUL. Un Server Action est un POST public: la fiche
 * revalidée serveur est la seule qui existe. Le miroir navigateur est du confort, jamais une
 * frontière.
 *
 * ⚠ CE QUI EST ÉCRIT ICI EST DÉCLARÉ, PAS VÉRIFIÉ, et c'est délibéré. On ne va PAS chercher le nom
 * dans `users` pour le confirmer: la vente se joue en RP, un client donne le nom qu'il donne, et une
 * caisse capable de répondre "ce nom + cette date existent" deviendrait un annuaire de personnages
 * interrogeable par n'importe quel employé en service. Le portail enregistre la déclaration, le reste
 * du module fait pareil (voir l'en-tête de `sales.ts`).
 *
 * ⚠ LES BORNES VIENNENT DU JEU, PAS D'ICI. `maxNameLength` / `lowestYear` / `highestYear` /
 * `phoneDigits` sont résolus côté serveur depuis `gs_identity/config.lua` et `gcphone/config.lua`
 * (voir `clientRecordRules.ts`) puis descendus jusqu'à l'écran. Les écrire en dur ferait qu'un
 * `Config.HighestYear` déplacé en jeu laisserait le portail refuser une date que la fiche d'identité
 * accepte, sans que rien ne le signale.
 */

/** Les bornes que le jeu impose à une identité. Résolues serveur, voir `clientRecordRules.ts`. */
export type ClientRecordBounds = {
  /** `Config.MaxNameLength` (gs_identity). Longueur maximale d'un prénom ou d'un nom. */
  maxNameLength: number;
  /** `Config.LowestYear` (gs_identity). Année de naissance la plus ancienne acceptée. */
  lowestYear: number;
  /** `Config.HighestYear` (gs_identity). Année de naissance la plus récente acceptée. */
  highestYear: number;
  /**
   * Combien de chiffres compte un numéro de téléphone, d'après le masque de génération de gcphone
   * (`Config.PhoneNumberMask` sur le téléphone de cet arbre, `Number = { Mask }` sur celui de production;
   * `clientRecordRules.ts` lit les deux formes, et explique pourquoi elles coexistent).
   *
   * ⚠ `null` VEUT DIRE "ON N'A PAS PU LIRE LE MASQUE", et ce n'est pas la même chose que "aucune
   * contrainte": on retombe alors sur une fourchette large plutôt que d'inventer une longueur. Un
   * validateur qui devine 7 chiffres et se trompe refuse des numéros parfaitement valides, et le
   * refus est incompréhensible pour l'employé qui a le téléphone du client sous les yeux.
   */
  phoneDigits: number | null;
};

/**
 * Le repli quand les fichiers du jeu sont illisibles depuis ce déploiement.
 *
 * ⚠ CE SONT LES VALEURS QUE `gs_identity/config.lua` DÉCLARE AUJOURD'HUI, recopiées comme DERNIER
 * recours et jamais comme source. Elles servent quand `citadel/` tourne sans `fivem/` à côté (un
 * build isolé, un test); en production le fichier est lu et ces nombres ne sont jamais consultés.
 */
export const CLIENT_RECORD_BOUNDS_FALLBACK: ClientRecordBounds = {
  maxNameLength: 20,
  lowestYear: 1910,
  highestYear: 2010,
  phoneDigits: null,
};

/** Bornes de longueur des colonnes, pour que la saisie ne puisse jamais faire échouer l'INSERT. */
export const PLATE_MAX_LENGTH = 8;
export const PHONE_MAX_DIGITS = 20;

export type ClientRecordField = "firstname" | "lastname" | "dob" | "phone" | "plate";

/**
 * Pourquoi une saisie est refusée. Un CODE, jamais une phrase: le français vit dans `actions.ts`
 * (serveur) et dans la caisse (navigateur), et les deux doivent pouvoir dire la même chose
 * autrement, l'un dans un bandeau d'erreur et l'autre sous le champ fautif.
 */
export type ClientRecordProblem =
  | "empty"
  | "length"
  | "digit"
  | "charset"
  | "noletter"
  | "separator"
  | "date_format"
  | "date_range"
  | "date_day"
  | "phone_format"
  | "phone_length"
  | "plate_format";

/** Ce que l'employé tape. Toutes les valeurs sont brutes: rien n'est encore normalisé. */
export type ClientRecordDraft = {
  firstname: string;
  lastname: string;
  dob: string;
  phone: string;
  plate: string;
};

/** Ce qui est écrit en base, après normalisation. */
export type ClientRecord = {
  firstname: string;
  lastname: string;
  /** `JJ/MM/AAAA`, exactement la forme de `users.dateofbirth`. */
  dob: string;
  /** Chiffres uniquement, exactement la forme de `users.phone_number`. */
  phone: string;
  /** Majuscules, espaces internes conservés, exactement la forme de `owned_vehicles.plate`. */
  plate: string;
};

export type ClientRecordCheck =
  | { ok: true; value: ClientRecord }
  | { ok: false; field: ClientRecordField; problem: ClientRecordProblem };

export const EMPTY_CLIENT_DRAFT: ClientRecordDraft = {
  firstname: "",
  lastname: "",
  dob: "",
  phone: "",
  plate: "",
};

/* ── Le nom ───────────────────────────────────────────────────────────────────────────────────── */

/** `-`, `'` et l'espace: les seuls séparateurs qu'un nom de personnage peut contenir. */
const SEPARATOR = /[-' ]/;

/**
 * NORMALISER UN PRÉNOM OU UN NOM, exactement comme le jeu le ferait.
 *
 * ⚠⚠ C'EST UN MIROIR DÉLIBÉRÉ DE `string.normalizeName` (gs_base/lib/string/shared.lua), l'unique
 * autorité du serveur sur ce qu'un nom de personnage peut contenir et comment il est capitalisé. Le
 * mimer n'est pas de la duplication gratuite: le nom saisi ici DÉSIGNE un personnage dont
 * `users.firstname` a été écrit par cette fonction-là. Normaliser autrement produirait une fiche que
 * personne ne peut rapprocher du joueur qu'elle nomme - "JEAN-pierre" d'un côté, "Jean-Pierre" de
 * l'autre, et un gérant qui cherche l'un ne trouve jamais l'autre.
 *
 * Le contrat repris tel quel: lettres ASCII plus `-`, `'` et l'espace, rien d'autre; chaque suite de
 * lettres capitalisée indépendamment (`jean-pierre` -> `Jean-Pierre`, `o'brien` -> `O'Brien`). Les
 * accents sont un REFUS et non un pliage, parce que c'est déjà la règle du jeu: `Émile` n'existe pas
 * comme nom de personnage, donc l'accepter ici fabriquerait une fiche qui ne désigne personne.
 */
export function normalizePersonName(
  raw: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; problem: ClientRecordProblem } {
  if (typeof raw !== "string") return { ok: false, problem: "empty" };

  const name = raw.replace(/\s+/g, " ").trim();

  if (name === "") return { ok: false, problem: "empty" };
  if (name.length > maxLength) return { ok: false, problem: "length" };

  // Les chiffres sont refusés AVANT le contrôle général de jeu de caractères, uniquement pour que
  // l'employé lise "pas de chiffres" plutôt que le plus vague "lettres uniquement". C'est la faute
  // que les gens font vraiment, et le jeu fait exactement la même distinction pour la même raison.
  if (/\d/.test(name)) return { ok: false, problem: "digit" };
  if (/[^A-Za-z\-' ]/.test(name)) return { ok: false, problem: "charset" };
  if (!/[A-Za-z]/.test(name)) return { ok: false, problem: "noletter" };

  // Un nom ne peut ni s'ouvrir ni se fermer sur un séparateur (`-jean`), ni les empiler
  // (`jean--pierre`): les deux passent le contrôle de jeu de caractères et produiraient un nom
  // d'affichage absurde.
  if (SEPARATOR.test(name[0]!) || SEPARATOR.test(name[name.length - 1]!)) {
    return { ok: false, problem: "separator" };
  }
  if (/[-' ][-' ]/.test(name)) return { ok: false, problem: "separator" };

  return {
    ok: true,
    value: name.toLowerCase().replace(/[a-z]+/g, (run) => run[0]!.toUpperCase() + run.slice(1)),
  };
}

/* ── La date de naissance ─────────────────────────────────────────────────────────────────────── */

const MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return year % 400 === 0 || (year % 100 !== 0 && year % 4 === 0);
}

/**
 * NORMALISER UNE DATE DE NAISSANCE vers `JJ/MM/AAAA`, la forme de `users.dateofbirth`.
 *
 * Miroir de `isValidDateOfBirth` (gs_identity/server/main.lua), bornes comprises: forme stricte,
 * mois et jour dans leurs bornes réelles, année dans l'intervalle du jeu, et jour du mois calculé en
 * tenant compte des années bissextiles - un 29/02/1999 n'existe pas et ne doit pas s'enregistrer.
 *
 * ⚠ LE TIRET EST ACCEPTÉ À LA SAISIE ET N'EST JAMAIS STOCKÉ. `12-04-1988` devient `12/04/1988`: le
 * séparateur est une habitude de frappe, pas une donnée, et deux formes de la même date en base
 * feraient que la recherche d'un gérant en trouve une sur deux.
 */
export function normalizeBirthdate(
  raw: string,
  bounds: ClientRecordBounds,
): { ok: true; value: string } | { ok: false; problem: ClientRecordProblem } {
  if (typeof raw !== "string") return { ok: false, problem: "date_format" };

  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return { ok: false, problem: "date_format" };

  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);

  if (year < bounds.lowestYear || year > bounds.highestYear) {
    return { ok: false, problem: "date_range" };
  }
  if (month < 1 || month > 12) return { ok: false, problem: "date_format" };

  const max = month === 2 && isLeap(year) ? 29 : MONTH_LENGTH[month - 1]!;
  if (day < 1 || day > max) return { ok: false, problem: "date_day" };

  const pad2 = (n: number) => String(n).padStart(2, "0");
  return { ok: true, value: `${pad2(day)}/${pad2(month)}/${year}` };
}

/* ── Le téléphone ─────────────────────────────────────────────────────────────────────────────── */

/**
 * NORMALISER UN NUMÉRO vers ses seuls chiffres, la forme de `users.phone_number`.
 *
 * ⚠ LA MISE EN FORME EST JETÉE, PAS REFUSÉE. `555-0134`, `555 0134` et `5550134` sont le même numéro
 * et le client le dicte comme il l'a en tête; refuser un tiret ferait échouer une saisie correcte.
 * Ce qui est stocké est ce que le jeu stocke, pour qu'un gérant puisse comparer les deux à l'oeil.
 *
 * La LONGUEUR vient du masque de gcphone quand on a pu le lire; sinon on borne large plutôt que de
 * deviner (voir `phoneDigits`).
 */
export function normalizePhone(
  raw: string,
  bounds: ClientRecordBounds,
): { ok: true; value: string } | { ok: false; problem: ClientRecordProblem } {
  if (typeof raw !== "string") return { ok: false, problem: "phone_format" };

  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, problem: "empty" };
  // Tout ce qui n'est ni un chiffre ni un signe de mise en forme courant est une faute de frappe.
  if (/[^\d\s+().-]/.test(trimmed)) return { ok: false, problem: "phone_format" };

  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return { ok: false, problem: "phone_format" };
  if (digits.length > PHONE_MAX_DIGITS) return { ok: false, problem: "phone_length" };

  if (bounds.phoneDigits !== null) {
    if (digits.length !== bounds.phoneDigits) return { ok: false, problem: "phone_length" };
  } else if (digits.length < 3) {
    return { ok: false, problem: "phone_length" };
  }

  return { ok: true, value: digits };
}

/* ── La plaque ────────────────────────────────────────────────────────────────────────────────── */

/**
 * NORMALISER UNE PLAQUE vers la forme de `owned_vehicles.plate`.
 *
 * ⚠ LES MAJUSCULES NE SONT PAS COSMÉTIQUES: c'est la CLÉ de recherche du véhicule. Une plaque
 * enregistrée en minuscules retrouverait quand même sa ligne (la collation du jeu est
 * insensible à la casse), mais elle s'afficherait ensuite différemment de partout ailleurs dans
 * CITADEL, et un gérant qui compare deux fiches croirait voir deux véhicules.
 *
 * ⚠ LES ESPACES INTERNES SONT CONSERVÉS, seuls les bords sont coupés. GTA génère des plaques à
 * espace (`46EEK572`, mais aussi `11 ABC12`), et les retirer fabriquerait une plaque qui n'existe pas.
 */
export function normalizePlate(
  raw: string,
): { ok: true; value: string } | { ok: false; problem: ClientRecordProblem } {
  if (typeof raw !== "string") return { ok: false, problem: "plate_format" };

  const plate = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (plate === "") return { ok: false, problem: "empty" };
  if (plate.length > PLATE_MAX_LENGTH) return { ok: false, problem: "plate_format" };
  if (!/^[A-Z0-9 ]+$/.test(plate)) return { ok: false, problem: "plate_format" };
  if (!/[A-Z0-9]/.test(plate)) return { ok: false, problem: "plate_format" };

  return { ok: true, value: plate };
}

/* ── La fiche entière ─────────────────────────────────────────────────────────────────────────── */

/**
 * VALIDER LA FICHE COMPLÈTE, dans l'ordre où l'employé l'a sous les yeux.
 *
 * ⚠ ON REND LE PREMIER CHAMP FAUTIF, PAS UNE LISTE. Sur cinq champs, une liste de cinq refus est
 * illisible et pousse à tout retaper; un refus nommé sur un champ se corrige. L'ordre suit celui de
 * l'écran pour que le message désigne toujours le champ le plus haut qui cloche, jamais un champ
 * plus bas que celui qu'on est en train de remplir.
 */
export function checkClientRecord(
  draft: Partial<ClientRecordDraft> | null | undefined,
  bounds: ClientRecordBounds,
): ClientRecordCheck {
  const d = draft ?? {};

  const firstname = normalizePersonName(String(d.firstname ?? ""), bounds.maxNameLength);
  if (!firstname.ok) return { ok: false, field: "firstname", problem: firstname.problem };

  const lastname = normalizePersonName(String(d.lastname ?? ""), bounds.maxNameLength);
  if (!lastname.ok) return { ok: false, field: "lastname", problem: lastname.problem };

  const dob = normalizeBirthdate(String(d.dob ?? ""), bounds);
  if (!dob.ok) return { ok: false, field: "dob", problem: dob.problem };

  const phone = normalizePhone(String(d.phone ?? ""), bounds);
  if (!phone.ok) return { ok: false, field: "phone", problem: phone.problem };

  const plate = normalizePlate(String(d.plate ?? ""));
  if (!plate.ok) return { ok: false, field: "plate", problem: plate.problem };

  return {
    ok: true,
    value: {
      firstname: firstname.value,
      lastname: lastname.value,
      dob: dob.value,
      phone: phone.value,
      plate: plate.value,
    },
  };
}

/** Le libellé FR d'un champ, pour préfixer un refus. Partagé écran/serveur, même raison que le reste. */
export const CLIENT_FIELD_LABELS: Readonly<Record<ClientRecordField, string>> = {
  firstname: "Prénom du client",
  lastname: "Nom du client",
  dob: "Date de naissance",
  phone: "Téléphone",
  plate: "Plaque",
};

/**
 * Le refus, en français et adressé à la personne qui tape.
 *
 * ⚠ CHAQUE PHRASE DIT QUOI FAIRE. "Format invalide" sur une date n'apprend rien à quelqu'un qui vient
 * d'écrire `1988-04-12`; "attendu JJ/MM/AAAA" se corrige en trois secondes.
 */
export function clientProblemText(
  field: ClientRecordField,
  problem: ClientRecordProblem,
  bounds: ClientRecordBounds,
): string {
  switch (problem) {
    case "empty":
      return "Ce champ est obligatoire.";
    case "length":
      return `${bounds.maxNameLength} caractères au maximum.`;
    case "digit":
      return "Un nom ne contient pas de chiffres.";
    case "charset":
      return "Lettres non accentuées, tiret et apostrophe uniquement.";
    case "noletter":
      return "Il faut au moins une lettre.";
    case "separator":
      return "Un nom ne commence ni ne finit par un tiret, une apostrophe ou un espace.";
    case "date_format":
      return "Date attendue au format JJ/MM/AAAA.";
    case "date_range":
      return `Année de naissance entre ${bounds.lowestYear} et ${bounds.highestYear}.`;
    case "date_day":
      return "Ce jour n'existe pas dans ce mois.";
    case "phone_format":
      return "Chiffres uniquement (les espaces et tirets sont acceptés).";
    case "phone_length":
      return bounds.phoneDigits !== null
        ? `Un numéro compte ${bounds.phoneDigits} chiffres.`
        : `Numéro trop court ou trop long (${PHONE_MAX_DIGITS} chiffres au maximum).`;
    case "plate_format":
      return `Lettres et chiffres, ${PLATE_MAX_LENGTH} caractères au maximum.`;
    default:
      return `${CLIENT_FIELD_LABELS[field]}: saisie invalide.`;
  }
}

/* ── La fiche telle qu'un écran la lit ────────────────────────────────────────────────────────── */

/**
 * LA FICHE PRÊTE À AFFICHER, une seule fois pour tous les écrans qui la montrent.
 *
 * ⚠ CONSTRUITE ICI ET NON DANS CHAQUE PAGE. Le journal de l'employé et la fiche de paie du gérant
 * montrent la même chose; deux mises en forme écrites séparément finissent par ne plus dire pareil
 * du même ticket, et c'est exactement le genre d'écart qui fait qu'un patron cesse de se fier au
 * document. `vehicleNote` porte à lui seul la distinction la plus importante du module.
 *
 * ⚠ L'ARGUMENT EST STRUCTUREL, sans rien importer de `sales.ts`: ce fichier reste pur et donc
 * chargeable par le navigateur, ce qui est toute sa raison d'être.
 */
export type ClientRecordView = {
  /** "Jean Dupont". Déjà normalisé à l'écriture, donc rien à recapitaliser ici. */
  name: string;
  dob: string;
  phone: string;
  plate: string;
  /** "Dubsta 6x6 · Off-Road", ou null quand la voiture n'a pas pu être nommée. */
  vehicle: string | null;
  /**
   * CE QUI CLOCHE AVEC CETTE VOITURE, en une phrase, ou null quand tout va bien.
   *
   * ⚠⚠ C'EST LA VALEUR LA PLUS IMPORTANTE DE CE TYPE. Sans elle, un ticket dont la plaque ne
   * désigne rien s'affiche exactement comme un ticket dont la voiture est d'origine: aucune option,
   * aucun modèle, rien. Le patron lit "voiture de série" là où la vérité est "cette fiche ne
   * désigne aucune voiture connue". Voir `SaleVehicleRecord`.
   */
  vehicleNote: string | null;
  /** Le métier propriétaire quand c'est un véhicule de flotte ("police"). Jamais un joueur. */
  fleetJob: string | null;
  /** Au plus quatre pastilles, les plus parlantes d'abord. Vide sur une voiture d'origine. */
  mods: string[];
  /** Combien de modifications ont été comptées. 0 est une vraie réponse: voiture de série. */
  modsTotal: number;
  /** `true` quand le blob du jeu ne portait aucune apparence: MANQUE, et non "pas de modifications". */
  modsMissing: boolean;
};

type ViewInput = {
  firstname: string;
  lastname: string;
  dob: string;
  phone: string;
  plate: string;
  vehicle: {
    record: "found" | "absent" | "unreadable";
    modelLabel: string | null;
    classLabel: string | null;
    fleetJob: string | null;
    mods: { summary: string[]; total: number; record: "full" | "partial" | "none" } | null;
  };
};

export function clientRecordView(r: ViewInput | null | undefined): ClientRecordView | null {
  if (!r) return null;

  const v = r.vehicle;
  const name = v.modelLabel
    ? v.classLabel
      ? `${v.modelLabel} · ${v.classLabel}`
      : v.modelLabel
    : null;

  // ⚠ Trois situations, trois phrases, et surtout PAS de silence sur les deux dernières.
  const note =
    v.record === "absent"
      ? "Plaque introuvable dans les véhicules enregistrés"
      : v.record === "unreadable"
        ? "Véhicule illisible au moment de la déclaration"
        : v.mods === null || v.mods.record === "none"
          ? "Aucune fiche d'apparence enregistrée pour ce véhicule"
          : null;

  return {
    name: `${r.firstname} ${r.lastname}`.trim(),
    dob: r.dob,
    phone: r.phone,
    plate: r.plate,
    vehicle: name,
    vehicleNote: note,
    fleetJob: v.fleetJob,
    mods: v.mods?.summary ?? [],
    modsTotal: v.mods?.total ?? 0,
    modsMissing: v.record !== "found" || v.mods === null || v.mods.record === "none",
  };
}
