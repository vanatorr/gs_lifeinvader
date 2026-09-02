/**
 * LES MODULES DU PORTAIL: ce qu'un commerce allume ou éteint.
 *
 * EN CODE, contrairement aux modèles qui vivent en base. Un module est adossé à une page et à des
 * actions qui l'implémentent, donc en inventer un depuis une interface d'administration créerait une
 * case à cocher qui n'allume rien. Un MODÈLE, lui, n'est qu'une combinaison de modules déjà écrits:
 * c'est pour ça qu'il est en base, et c'est ce qui rend le portail extensible horizontalement (un
 * nouveau genre de commerce) sans déploiement, et verticalement (une nouvelle fonctionnalité) avec.
 *
 * ⚠⚠ UN MODULE ÉTEINT FERME LA PORTE, il ne se contente pas de cacher un bouton. Chaque module
 * déclare les capacités qu'il alimente, et `businessCan` refuse une capacité dont le module est
 * éteint. Sans ça, éteindre "pointage" laisserait l'action de correction d'heures parfaitement
 * joignable en POST direct, et le réglage ne serait qu'une décoration: exactement le genre de
 * fausse sécurité qui se découvre le jour où quelqu'un s'en sert.
 */
import { CAP, type Capability } from "./capabilities";

export type BusinessModule = {
  key: string;
  label: string;
  desc: string;
  /**
   * Un module ESSENTIEL ne s'éteint pas. Ce n'est pas de la préciosité: `reglages` est le seul
   * chemin qui rallume les autres, donc l'éteindre enfermerait le commerce dehors sans personne
   * pour rouvrir. Même raisonnement que le grade patron absent de la table des droits.
   */
  core: boolean;
  /** Annoncé, pas encore construit. Affiché grisé "bientôt", jamais activable. */
  soon?: boolean;
  /** Les capacités que ce module alimente. Un module peut n'en porter aucune. */
  capabilities: Capability[];
};

export const BUSINESS_MODULES: BusinessModule[] = [
  {
    key: "caisse",
    label: "Caisse",
    desc: "Déclarer une vente et calculer le total de la facture",
    core: true,
    capabilities: [CAP.SALE_DECLARE, CAP.SALE_READ_SELF],
  },
  {
    key: "catalogue",
    label: "Catalogue",
    desc: "Les articles vendables et leurs prix",
    core: true,
    capabilities: [CAP.CATALOGUE_READ, CAP.CATALOGUE_WRITE],
  },
  {
    key: "commissions",
    label: "Part employé",
    desc: "Un montant par article que l'employeur verse en fin de semaine",
    core: false,
    // Aucune capacité propre: la part se règle depuis le catalogue et se lit depuis ses ventes.
    // Le module décide si la colonne EXISTE, pas qui a le droit d'y toucher.
    capabilities: [],
  },
  {
    key: "pointage",
    label: "Pointage",
    desc: "Prises et fins de service, totaux jour et semaine",
    core: false,
    capabilities: [CAP.SHIFT_READ, CAP.SHIFT_EDIT],
  },
  {
    key: "equipe",
    label: "Équipe",
    desc: "Fiches employé et chiffres par personne",
    core: false,
    capabilities: [CAP.TEAM_READ],
  },
  {
    key: "visuels",
    label: "Visuels produits",
    desc: "Une image ou une icône par article sur la caisse",
    core: false,
    capabilities: [],
  },
  {
    key: "stock",
    label: "Stock",
    desc: "Suivi des quantités disponibles",
    core: false,
    soon: true,
    capabilities: [],
  },
];

const BY_KEY = new Map(BUSINESS_MODULES.map((m) => [m.key, m]));

/**
 * La capacité -> le module qui la porte, ou null si aucune.
 *
 * ⚠ `settings.write` n'appartient volontairement à AUCUN module, et c'est la même règle
 * anti-enfermement que `core`: si les réglages dépendaient d'un module, éteindre ce module rendrait
 * les réglages inaccessibles, donc impossible à rallumer. Une capacité orpheline est ici la
 * réponse correcte, pas un oubli.
 */
const MODULE_OF_CAP = new Map<string, string>();
for (const m of BUSINESS_MODULES) {
  for (const c of m.capabilities) MODULE_OF_CAP.set(c, m.key);
}

export function moduleOfCapability(cap: Capability): string | null {
  return MODULE_OF_CAP.get(cap) ?? null;
}

export function getModule(key: string): BusinessModule | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Les modules allumés quand rien n'est configuré nulle part: TOUT sauf ce qui n'existe pas encore.
 *
 * ⚠ Et non "les essentiels seulement". `core` veut dire "ne peut pas être éteint", pas "seul allumé
 * par défaut": confondre les deux livrerait un commerce tout neuf avec une caisse et rien d'autre,
 * ni pointage ni fiches employé, alors que ce sont précisément les deux choses pour lesquelles le
 * portail a été demandé. Le patron éteint ce dont il ne veut pas; il n'a pas à deviner ce qu'il
 * lui manque.
 */
export function defaultModules(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of BUSINESS_MODULES) out[m.key] = !m.soon;
  return out;
}

/**
 * L'état effectif: les essentiels, puis le modèle, puis les écarts du commerce.
 *
 * L'ordre est la conception entière. Le commerce ne stocke QUE ses écarts, donc retoucher le modèle
 * "bar" met à jour les onze bars, et seuls les modules explicitement personnalisés résistent. Si le
 * commerce stockait son état complet, chaque commerce aurait figé une copie le jour de sa création
 * et le modèle ne servirait plus à rien après la première minute.
 *
 * ⚠ Un module ESSENTIEL ne peut pas être éteint, ni par le modèle ni par un écart: on force la
 * valeur après coup plutôt que de faire confiance à des données que quelqu'un peut avoir écrites à
 * la main. Un module `soon` est forcé éteint pour la raison symétrique: il n'existe pas encore.
 * Une clé inconnue du code (module retiré depuis) est ignorée, jamais une erreur.
 */
export function resolveModules(
  templateModules: Record<string, boolean> | null | undefined,
  overrides: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const out = defaultModules();
  for (const [k, v] of Object.entries(templateModules ?? {})) {
    if (BY_KEY.has(k)) out[k] = Boolean(v);
  }
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (BY_KEY.has(k)) out[k] = Boolean(v);
  }
  for (const m of BUSINESS_MODULES) {
    if (m.core) out[m.key] = true;
    if (m.soon) out[m.key] = false;
  }
  return out;
}
