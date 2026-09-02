/**
 * LES CAPACITÉS DU PORTAIL ENTREPRISES.
 *
 * En CODE, délibérément, comme le registre des modules. Une capacité est adossée à du code qui
 * l'applique; une capacité qui n'existe qu'en base est une promesse que rien ne tient, et on
 * pourrait l'accorder à un grade sans qu'elle protège quoi que ce soit. Ce qui vit en base, c'est
 * QUI l'obtient (lifeinvader_business_grants), pas ce qu'elle est.
 *
 * Le patron détient tout, sans ligne en base. Le reste se distribue par GRADE DE MÉTIER EN JEU
 * depuis la page Réglages.
 */

export const CAP = {
  /** Encaisser: déclarer une vente depuis la caisse. Le geste de base d'un employé. */
  SALE_DECLARE: "sale.declare",
  /** Voir SES ventes et SA part. Ne révèle rien sur les collègues. */
  SALE_READ_SELF: "sale.read.self",
  /** Voir le catalogue et les prix. Nécessaire pour se servir de la caisse. */
  CATALOGUE_READ: "catalogue.read",

  /** Voir les chiffres des COLLÈGUES: page Équipe, fiches employé. */
  TEAM_READ: "team.read",
  /** Voir le journal de pointage de tout le monde. */
  SHIFT_READ: "shift.read",
  /** Corriger un pointage. Touche directement aux heures, donc à la paie. */
  SHIFT_EDIT: "shift.edit",
  /** Modifier articles, PRIX et PART EMPLOYÉ. Décide de ce que les gens touchent. */
  CATALOGUE_WRITE: "catalogue.write",
  /** Modifier les modules et l'identité du commerce. */
  SETTINGS_WRITE: "settings.write",
} as const;

export type Capability = (typeof CAP)[keyof typeof CAP];

/** Ce que la page Réglages propose au patron, dans cet ordre, avec sa copie. */
export const CAPABILITY_CATALOG: {
  code: Capability;
  label: string;
  desc: string;
  /** Sensible: exclue du repli jour-un (voir FALLBACK_CAPS). */
  sensitive: boolean;
}[] = [
  { code: CAP.SALE_DECLARE,    label: "Encaisser",              desc: "Déclarer une vente depuis la caisse", sensitive: false },
  { code: CAP.SALE_READ_SELF,  label: "Voir ses ventes",        desc: "Ses propres tickets, ses heures, sa part", sensitive: false },
  { code: CAP.CATALOGUE_READ,  label: "Voir le catalogue",      desc: "Consulter les articles et leurs prix", sensitive: false },
  { code: CAP.TEAM_READ,       label: "Voir l'équipe",          desc: "Chiffres et parts des collègues", sensitive: true },
  { code: CAP.SHIFT_READ,      label: "Voir les pointages",     desc: "Journal des prises et fins de service", sensitive: true },
  { code: CAP.SHIFT_EDIT,      label: "Corriger un pointage",   desc: "Modifier des heures déjà enregistrées", sensitive: true },
  { code: CAP.CATALOGUE_WRITE, label: "Tenir le catalogue",     desc: "Prix client et part employé", sensitive: true },
  { code: CAP.SETTINGS_WRITE,  label: "Modifier les réglages",  desc: "Modules et identité du commerce", sensitive: true },
];

/**
 * LE REPLI JOUR-UN. Un commerce qu'on vient d'activer n'a aucune ligne de droits, et personne
 * n'a encore ouvert la page Réglages. Sans repli, le portail serait inutilisable pour tout le
 * monde sauf le patron, et la première impression serait "ça ne marche pas".
 *
 * ⚠ Le repli ne contient QUE des capacités non sensibles. Un employé peut donc encaisser et
 * consulter ses propres chiffres immédiatement, mais lire les gains de ses collègues, corriger des
 * heures ou changer un prix restent au patron tant qu'il n'a rien distribué. C'est la même logique
 * que NO_FALLBACK_CAPS côté CAD: un défaut permissif est acceptable pour un geste routinier,
 * jamais pour ce qui touche à l'argent ou à la vie privée des autres.
 */
export const FALLBACK_CAPS: ReadonlySet<string> = new Set<string>([
  CAP.SALE_DECLARE,
  CAP.SALE_READ_SELF,
  CAP.CATALOGUE_READ,
]);

/**
 * Le palier de présence exigé POUR CHAQUE capacité, en plus du droit lui-même.
 *
 * Un droit dit "cette personne y a droit". Un palier dit "depuis où". Les deux se cumulent: un
 * patron hors ligne détient team.read et ne peut toujours pas s'en servir, parce que consulter le
 * rendement de ses employés est un acte in-character. Tout ce qui ÉCRIT exige d'être en service.
 */
export const CAP_TIER: Record<Capability, "session" | "ingame" | "service"> = {
  [CAP.SALE_READ_SELF]:  "session", // sa propre paie, depuis son téléphone
  [CAP.CATALOGUE_READ]:  "session", // la carte des prix n'est pas un secret
  [CAP.TEAM_READ]:       "ingame",  // lire les chiffres des autres est in-character
  [CAP.SHIFT_READ]:      "ingame",
  [CAP.SALE_DECLARE]:    "service", // toute écriture exige d'être pointé
  [CAP.SHIFT_EDIT]:      "service",
  [CAP.CATALOGUE_WRITE]: "service",
  [CAP.SETTINGS_WRITE]:  "service",
};
