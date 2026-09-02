"use client";

import React, { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Crown,
  Info,
  Lock,
  Plus,
  Settings2,
  ShieldCheck,
  Tags,
  Trash2,
} from "lucide-react";
import { BUSINESS_MODULES, moduleOfCapability, type BusinessModule } from "@/lib/business/modules";
import { CAP, CAPABILITY_CATALOG, CAP_TIER, type Capability } from "@/lib/business/capabilities";
import { CATEGORY_ICONS, ICON_KEYS } from "@/lib/business/art";
import { toneVars } from "@/lib/business/theme";
import type { BusinessCategory } from "@/lib/business/templates";
import { setModulesAction, setCategoriesAction, setGrantsAction } from "./actions";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import s from "./reglages.module.css";

type Grade = { grade: number; label: string };

/**
 * Une clé de rayon à partir d'un libellé: minuscules, accents retirés, tirets. Sert uniquement pour
 * les NOUVEAUX rayons (un rayon existant garde sa clé, qui ancre déjà des articles - voir le
 * commentaire de `setCategories`). La coupe à 40 caractères matche la forme que
 * `setCategoriesAction` exige d'une clé créée.
 */
function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    // U+0300 a U+036F: la plage des accents diacritiques une fois decomposes par NFD, en
    // echappement Unicode explicite (jamais un caractere combinant litteral dans le code source:
    // ca depend de l'encodage exact du fichier et peut se combiner visuellement avec ce qui precede).
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 40);
}

/**
 * CE QUE CHAQUE DROIT LAISSE VOIR OU FAIRE, en une phrase, plus la page où il s'exerce.
 *
 * ⚠ `Record<Capability, …>` EXHAUSTIF, jamais `Partial`. Ajouter une capacité à `CAP` sans écrire sa
 * phrase ne compile pas. C'est la seule façon fiable d'éviter qu'un droit finisse par s'afficher
 * avec son code technique pour toute explication, ou pire, avec la phrase du voisin: un patron
 * distribue ici l'accès aux chiffres de ses employés, il ne doit jamais avoir à deviner.
 *
 * ⚠ Ces phrases DOUBLENT volontairement `CAPABILITY_CATALOG[].desc`, qui tient en trois mots
 * ("Ses propres tickets, ses heures, sa part"). Le catalogue nomme, celles-ci expliquent la
 * conséquence. Les fusionner rendrait l'un des deux emplois illisible.
 */
const CAP_MEANING: Record<Capability, { does: string; where: string }> = {
  [CAP.SALE_DECLARE]: {
    does: "Ouvrir la caisse et déclarer un ticket. Le portail ne déplace pas d'argent: la facture se fait en jeu.",
    where: "Caisse",
  },
  [CAP.SALE_READ_SELF]: {
    does: "Relire SES propres tickets, ses heures et sa part. Ne révèle rien sur les collègues.",
    where: "Mes ventes",
  },
  [CAP.CATALOGUE_READ]: {
    does: "Consulter la carte et les prix. Nécessaire pour se servir de la caisse.",
    where: "Catalogue, Caisse",
  },
  [CAP.TEAM_READ]: {
    does: "Voir le chiffre, les heures et la part de CHAQUE collègue, nommément. C'est lire la paie des autres.",
    where: "Équipe",
  },
  [CAP.SHIFT_READ]: {
    does: "Voir qui a pointé, à quelle heure, et combien de temps chacun a tenu son service.",
    where: "Pointage",
  },
  [CAP.SHIFT_EDIT]: {
    does: "Réécrire des heures déjà enregistrées. Touche directement à ce qu'une personne touche.",
    where: "Pointage",
  },
  [CAP.CATALOGUE_WRITE]: {
    does: "Changer un prix client ou une part employé, créer un article, en archiver un.",
    where: "Catalogue",
  },
  [CAP.SETTINGS_WRITE]: {
    does: "Allumer et éteindre les modules, tenir les rayons, et redistribuer ces droits, celui-ci compris.",
    where: "Réglages",
  },
};

/** Le palier de présence exigé EN PLUS du droit. Donnée réelle: `CAP_TIER`, jamais devinée. */
const TIER_LABEL: Record<"session" | "ingame" | "service", string> = {
  session: "depuis le téléphone",
  ingame: "connecté au jeu",
  service: "en service",
};

/**
 * Ce qu'un module change quand il n'ouvre AUCUN droit.
 *
 * `Partial` ici, contrairement à `CAP_MEANING`, et la différence est réelle: un module sans phrase
 * dégrade sur sa liste de capacités, qui est vraie par construction. Un DROIT sans phrase, lui,
 * n'aurait rien à quoi dégrader.
 */
const MODULE_EFFECT: Partial<Record<string, string>> = {
  commissions:
    "Décide si la part employé EXISTE ici: la colonne sur la carte, la ligne du ticket, le total dû à chaque personne. Aucun droit à distribuer, la part se règle depuis le Catalogue.",
  visuels:
    "Décide si la caisse dessine une vignette pour chaque article. Les dessins déjà choisis restent enregistrés pendant qu'il est éteint.",
  stock: "Suivi des quantités disponibles. Rien n'est encore construit derrière.",
};

/**
 * COMPTE JUSQU'À `target`, PLUTÔT QUE DE L'AFFICHER D'UN COUP. Copié à l'identique de
 * `useCountUp` (mes-ventes/MesVentesView.tsx): aucune dépendance, une seule boucle
 * `requestAnimationFrame`, une courbe ease-out cubique, respecte `prefers-reduced-motion`. Ici les
 * cibles sont de petits entiers (nombre de modules actifs, de rayons, d'articles classés, de
 * grades), jamais des centimes: la même mécanique s'applique sans changement, elle anime
 * n'importe quel nombre qui compte pour la page, pas seulement un chiffre d'affaires.
 */
function useCountUp(target: number, durationMs = 450): number {
  const [value, setValue] = useState(0);
  const prevTarget = useRef<number | null>(null);

  useEffect(() => {
    const from = prevTarget.current ?? 0;
    prevTarget.current = target;

    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (from === target || reduceMotion) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}

/**
 * LES RÉGLAGES, côté navigateur: modules, rayons, droits par grade.
 *
 * ⚠⚠ REFONTE IA/LISIBILITÉ DU 2026-08-09 (quatrième passe), après le verdict du propriétaire sur
 * l'ENSEMBLE du portail ("same with reglage not user friendly", prononcé juste après le même reproche
 * sur Pointage). La passe shadcn du même jour (voir plus bas dans l'historique) avait déjà remplacé le
 * balisage maison par des primitives `@/components/ui/*`, mais n'avait pas touché à la DENSITÉ ni à
 * l'ORDRE DE LECTURE: c'est précisément ce que cette passe corrige, en trois endroits.
 *
 * ⚠ AUCUN CONTRAT DE DONNÉES NI CHEMIN D'ÉCRITURE NE CHANGE ICI NON PLUS. Les trois actions serveur
 * (`setModulesAction`, `setCategoriesAction`, `setGrantsAction`) sont toujours appelées avec
 * exactement les mêmes arguments; `setCategories`/`setGrants`/`setModuleOverrides` et leurs validations
 * n'ont pas été rouvertes. Le grade patron n'a toujours aucune colonne dans la matrice.
 *
 * 1. LES RAYONS SE REPLIENT: une rangée compacte (icône teintée, libellé, clé dérivée, nombre
 *    d'articles) par rayon, et l'éditeur complet (icône à choisir, libellé, couleur, ordre, retrait)
 *    ne s'ouvre que pour CELUI qu'on modifie, un seul à la fois - même règle que le Popover de choix
 *    d'icône qu'elle remplace. Avant cette passe, un commerce à six rayons affichait SIX éditeurs
 *    complets empilés en permanence: six fois le sélecteur d'icône, six fois les quatre pastilles de
 *    couleur, six fois les boutons Monter/Descendre/Retirer, pour une tâche qui ne concerne quasiment
 *    toujours qu'UN rayon à la fois. `toggleRayon` (plus bas) ouvre/ferme; `addCat` ouvre directement
 *    le rayon tout juste créé, qui a justement besoin d'être rempli. L'accordéon est un `<button>`
 *    entier (grande cible, pas juste un chevron) avec `aria-expanded`, et le corps replié porte
 *    `inert` (natif, React 19): un clavier ne peut plus atteindre un champ qu'on ne voit pas.
 *
 * 2. LA MATRICE DES DROITS PERD UNE LIGNE DE TEXTE PAR CAPACITÉ, PAS UNE INFORMATION. La phrase
 *    "Page {où}." (une ligne entière à elle seule) devient un badge accolé au badge de palier déjà
 *    présent: même mot, moins de hauteur. Chaque case accordée reçoit en plus une teinte de fond
 *    (`bg-primary/5`), pour que le motif "qui a quoi" se lise d'un coup d'oeil plutôt que
 *    case-par-case, et l'en-tête de chaque grade porte une barre de progression (`Progress`, shadcn)
 *    sous son libellé: la question "ce grade est-il permissif ou strict" ne demande plus de lire huit
 *    interrupteurs. Rien n'est masqué derrière un clic: un manager qui n'a jamais vu cette page doit
 *    comprendre un droit SANS deviner, donc `CAP_MEANING[cap.code].does` reste toujours affiché en
 *    clair, jamais dans une infobulle qu'il faudrait penser à ouvrir. Le bloc sensible (argent, heures,
 *    données des collègues) porte désormais un repère latéral constant plutôt qu'un simple mot en
 *    majuscules au-dessus du tableau. Chaque cellule (en-tête ET ligne) gagne aussi en respiration
 *    verticale (`py-3`/`py-3.5`, contre `py-2`/`py-2.5` avant): c'est précisément le risque nommé
 *    "wall of checkboxes" du calibrage "Shopify grade UI/UX" - une grille dense se lit par des lignes
 *    aérées et un état de survol net, pas en rétrécissant chaque case pour tout faire tenir.
 *
 * 3. LE BANDEAU DE CHIFFRES ANIME SES QUATRE VALEURS (`useCountUp` ci-dessus), et le contenu sous le
 *    titre apparaît en fondu à l'ouverture de la page (`.pageFade`). Aucune des deux n'existait avant
 *    cette passe: la page entière était statique, ce qui faisait partie du même reproche que sur
 *    Pointage ("not animated"). Les deux respectent `prefers-reduced-motion`.
 *
 * ⚠⚠ HISTORIQUE - PASSE PRÉCÉDENTE (2026-08-09, plus tôt le même jour). Verdict du propriétaire sur
 * l'ensemble du portail: "lowky it doesnt look good. use shadcn and shadcn graphs and things. but
 * still colorful." Le découpage structurel (bandeau de chiffres, Modules et Rayons côte à côte, Droits
 * pleine largeur) était déjà en place et reste inchangé par CETTE passe - cette passe-ci retouche la
 * densité à l'intérieur de ce découpage, pas le découpage lui-même. Chaque composant hérite la couleur
 * DE CE COMMERCE via le pont sémantique de `lib/business/theme.ts`, donc rien ici ne fixe une teinte
 * en dur.
 *
 * ⚠ LA MATRICE DES DROITS RESTE UN SEUL `<Table>`, PAS DEUX RENDUS PARALLÈLES: `<Table>`
 * (`components/ui/table.tsx`) s'enveloppe déjà dans son propre conteneur `overflow-x-auto`, donc un
 * métier à huit échelons défile HORIZONTALEMENT au lieu de se réécrire en un second balisage à tenir
 * à jour.
 */
export default function ReglagesView({
  slug,
  name,
  hasAccess,
  canWrite,
  writeReason,
  templateLabel,
  templateModules,
  moduleOverrides,
  modules,
  categories,
  categoryCounts,
  grades,
  bossGradeLabel,
  initialGrants,
  hadCustomGrants,
}: {
  slug: string;
  name: string;
  hasAccess: boolean;
  canWrite: boolean;
  /** Pourquoi l'écriture est fermée. Un contrôle grisé sans motif se lit comme une panne. */
  writeReason: string | null;
  templateLabel: string;
  templateModules: Record<string, boolean>;
  moduleOverrides: Record<string, boolean>;
  /** L'état EFFECTIF des modules tel qu'il est ENREGISTRÉ, pas le brouillon de cet écran. */
  modules: Record<string, boolean>;
  categories: BusinessCategory[];
  /** Combien d'articles portent chaque rayon, archivés compris. Voir `reglages/page.tsx`. */
  categoryCounts: Record<string, number>;
  grades: Grade[];
  /** Le libellé de l'échelon patron dans ce métier, pour le nommer au lieu de dire "le patron". */
  bossGradeLabel: string | null;
  initialGrants: Record<string, string[]>;
  hadCustomGrants: boolean;
}) {
  const router = useRouter();

  const [overrides, setOverrides] = useState<Record<string, boolean>>(moduleOverrides);
  const [modPending, startModules] = useTransition();
  const [moduleError, setModuleError] = useState<string | null>(null);

  const [catState, setCatState] = useState<BusinessCategory[]>(categories);
  const [catPending, startCategories] = useTransition();
  const [catError, setCatError] = useState<string | null>(null);
  /** Quel rayon a son éditeur complet ouvert. Un seul à la fois, même règle que le Popover d'icône
   *  qu'il contient - voir le commentaire d'en-tête. */
  const [activeRayon, setActiveRayon] = useState<number | null>(null);
  /** Le Popover de choix d'icône DU rayon actif. Une seule case suffit puisqu'un seul rayon peut
   *  être ouvert à la fois. */
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  const [grantsState, setGrantsState] = useState<Record<string, string[]>>(initialGrants);
  const [grantsPending, startGrants] = useTransition();
  const [grantsError, setGrantsError] = useState<string | null>(null);
  /** Quel grade est affiché dans le détail des droits. Un métier à sept ou huit échelons ne tient
   *  plus dans une matrice: on regarde UN grade à la fois, comme les rayons. `grades` est une prop
   *  stable pour la durée de vie de la page, donc l'initialiser au premier grade une seule fois est
   *  sûr - un métier réel n'a jamais 0 grade ET des droits à distribuer en même temps (voir plus
   *  bas, l'état vide est géré séparément). */
  const [selectedGrade, setSelectedGrade] = useState<number | null>(grades[0]?.grade ?? null);

  /* ── Modules ────────────────────────────────────────────────────────────────────────────────── */

  /**
   * L'état d'un module DANS CET ÉCRAN: essentiels, puis à venir, puis l'écart en cours d'édition,
   * puis le modèle. Même ordre que `resolveModules` côté serveur, qui reste l'autorité.
   */
  function effectiveModule(m: BusinessModule): boolean {
    if (m.core) return true;
    if (m.soon) return false;
    if (m.key in overrides) return overrides[m.key]!;
    if (m.key in templateModules) return templateModules[m.key]!;
    return true;
  }

  /** Le même calcul, mais contre les écarts ENREGISTRÉS: sert à repérer ce qui n'est pas sauvé. */
  function savedModule(m: BusinessModule): boolean {
    if (m.core) return true;
    if (m.soon) return false;
    if (m.key in moduleOverrides) return moduleOverrides[m.key]!;
    if (m.key in templateModules) return templateModules[m.key]!;
    return true;
  }

  // Sept modules: le calcul direct est moins cher que le mémo qui l'entourerait, et il ne peut pas
  // se désynchroniser d'une liste de dépendances qu'il faudrait tenir à jour.
  const modulesDirty = BUSINESS_MODULES.some((m) => effectiveModule(m) !== savedModule(m));

  /** Combien d'articles sont classés dans un rayon, archivés compris. Somme des comptes réels. */
  const totalClassed = Object.values(categoryCounts).reduce((n, v) => n + v, 0);

  const activeModules = BUSINESS_MODULES.filter((m) => !m.soon && effectiveModule(m)).length;
  const realModules = BUSINESS_MODULES.filter((m) => !m.soon).length;

  // Appelés AVANT le retour anticipé "page fermée" plus bas: les Rules of Hooks interdisent un hook
  // conditionnel. Sur cette branche les quatre valeurs valent 0 (props neutres passées par
  // reglages/page.tsx), donc l'animation n'a simplement rien à compter.
  const activeModulesAnim = useCountUp(activeModules);
  const rayonCountAnim = useCountUp(catState.length);
  const totalClassedAnim = useCountUp(totalClassed);
  const gradesCountAnim = useCountUp(grades.length);

  function toggleModule(m: BusinessModule) {
    if (m.core || m.soon || !canWrite) return;
    setOverrides((o) => ({ ...o, [m.key]: !effectiveModule(m) }));
  }

  function saveModules() {
    if (modPending) return;
    startModules(async () => {
      const res = await setModulesAction(slug, overrides);
      if (res.status === "error") {
        setModuleError(res.message);
        return;
      }
      setModuleError(null);
      router.refresh();
    });
  }

  function resetModules() {
    if (modPending) return;
    startModules(async () => {
      const res = await setModulesAction(slug, {});
      if (res.status === "error") {
        setModuleError(res.message);
        return;
      }
      setOverrides({});
      setModuleError(null);
      router.refresh();
    });
  }

  /* ── Rayons ─────────────────────────────────────────────────────────────────────────────────── */

  function updateCat(i: number, patch: Partial<BusinessCategory>) {
    setCatState((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  /** Un rayon fraîchement ajouté s'ouvre directement: c'est justement celui qui a besoin d'être
   *  rempli, le laisser replié forcerait un clic de plus pour rien. */
  function addCat() {
    const newIndex = catState.length;
    setCatState((rows) => [
      ...rows,
      { key: "", label: "Nouveau rayon", tone: (rows.length % 4) + 1, icon: "box" },
    ]);
    setActiveRayon(newIndex);
    setIconPickerOpen(false);
  }

  function removeCat(i: number) {
    setCatState((rows) => rows.filter((_, idx) => idx !== i));
    // Les rayons après `i` reculent d'un cran: le rayon ouvert doit suivre le même décalage, ou
    // rester fermé s'il vient d'être supprimé.
    setActiveRayon((cur) => {
      if (cur === null) return null;
      if (cur === i) return null;
      return cur > i ? cur - 1 : cur;
    });
    setIconPickerOpen(false);
  }

  /** Déplacer un rayon: son rang EST son ordre d'affichage à la caisse et sur le catalogue. */
  function moveCat(i: number, dir: -1 | 1) {
    const to = i + dir;
    setCatState((rows) => {
      if (to < 0 || to >= rows.length) return rows;
      const next = [...rows];
      const [row] = next.splice(i, 1);
      next.splice(to, 0, row!);
      return next;
    });
    // Le rayon ouvert suit son propre déplacement, pour ne pas perdre le fil de ce qu'on éditait.
    setActiveRayon((cur) => {
      if (cur === i) return to;
      if (cur === to) return i;
      return cur;
    });
    setIconPickerOpen(false);
  }

  /** Combien d'articles portent ce rayon. Un rayon tout juste ajouté n'en porte aucun. */
  function countFor(c: BusinessCategory, i: number): number {
    const key = c.key || slugify(c.label) || `rayon-${i + 1}`;
    return categoryCounts[key] ?? 0;
  }

  /**
   * Les rayons RETIRÉS de l'écran qui portent encore des articles.
   *
   * ⚠ On le dit AVANT d'enregistrer, pas après. `setCategories` refuse ce retrait (`in_use`), donc
   * sans cet avertissement on cliquerait Enregistrer, tout serait refusé d'un bloc, y compris les
   * changements de libellé et de couleur qui n'avaient rien à voir.
   */
  const orphaned = useMemo(() => {
    const kept = new Set(catState.map((c, i) => c.key || slugify(c.label) || `rayon-${i + 1}`));
    return Object.entries(categoryCounts)
      .filter(([key, n]) => n > 0 && !kept.has(key))
      .map(([key, n]) => ({ key, n }));
  }, [catState, categoryCounts]);

  function saveCategories() {
    if (catPending) return;
    // Une clé existante reste intouchée (elle ancre déjà des articles). Une clé vide (rayon tout
    // juste ajouté) se dérive du libellé au moment d'enregistrer, jamais avant: la retaper en
    // continu à chaque frappe donnerait l'illusion qu'elle est déjà figée.
    const next: BusinessCategory[] = catState.map((c, i) => ({
      key: c.key || slugify(c.label) || `rayon-${i + 1}`,
      label: c.label.trim() || "Rayon",
      tone: c.tone,
      ...(c.icon ? { icon: c.icon } : {}),
    }));
    startCategories(async () => {
      const res = await setCategoriesAction(slug, next);
      if (res.status === "error") {
        setCatError(res.message);
        return;
      }
      setCatError(null);
      setIconPickerOpen(false);
      router.refresh();
    });
  }

  /** Ouvre/ferme l'éditeur complet d'un rayon. Un seul ouvert à la fois: ouvrir en referme un autre. */
  function toggleRayon(i: number) {
    setActiveRayon((cur) => (cur === i ? null : i));
    setIconPickerOpen(false);
  }

  /* ── Droits par grade ───────────────────────────────────────────────────────────────────────── */

  function hasCap(grade: number, code: string): boolean {
    return (grantsState[String(grade)] ?? []).includes(code);
  }

  function toggleGrant(grade: number, code: string) {
    if (!canWrite) return;
    setGrantsState((g) => {
      const key = String(grade);
      const cur = new Set(g[key] ?? []);
      if (cur.has(code)) cur.delete(code);
      else cur.add(code);
      return { ...g, [key]: Array.from(cur) };
    });
  }

  function countForGrade(grade: number): number {
    const held = new Set(grantsState[String(grade)] ?? []);
    return CAPABILITY_CATALOG.filter((c) => held.has(c.code)).length;
  }

  function saveGrants() {
    if (grantsPending) return;
    startGrants(async () => {
      const res = await setGrantsAction(slug, grantsState);
      if (res.status === "error") {
        setGrantsError(res.message);
        return;
      }
      setGrantsError(null);
      router.refresh();
    });
  }

  /**
   * Un droit accordé dont le MODULE est éteint ne s'applique pas: `businessCan` le refuse même au
   * patron (voir modules.ts). On le dit sur la ligne, plutôt que de laisser cocher une case inerte.
   */
  function inertBecause(code: Capability): string | null {
    const key = moduleOfCapability(code);
    if (!key || modules[key] !== false) return null;
    const mod = BUSINESS_MODULES.find((m) => m.key === key);
    return `Sans effet: le module ${mod?.label ?? key} est éteint pour ce commerce.`;
  }

  /**
   * UNE LIGNE DE DROIT, POUR LE GRADE ACTUELLEMENT AFFICHÉ. Remplace une cellule de matrice: le
   * libellé, son palier, sa page et sa phrase d'explication ont maintenant toute la largeur pour
   * respirer, et l'interrupteur reste la seule chose qu'on peut confondre avec un autre - il n'y a
   * plus sept autres colonnes à côté de lui pour brouiller l'oeil.
   *
   * ⚠ FONCTION EN MINUSCULE APPELÉE COMME UNE FONCTION (`capabilityRow(...)`), JAMAIS `<CapabilityRow
   * .../>`. Une majuscule utilisée en balise JSX serait un NOUVEAU type de composant à chaque rendu
   * de ReglagesView (une fonction redéfinie à chaque appel n'est jamais `===` à la précédente), donc
   * React démonterait et remonterait cette ligne entière - et l'interrupteur avec elle - à la moindre
   * frappe ailleurs sur la page. Un simple appel de fonction qui renvoie du JSX n'a pas ce problème:
   * React ne voit que l'arbre renvoyé, jamais un "composant" séparé.
   */
  function capabilityRow({ cap, grade, gradeLabel }: { cap: (typeof CAPABILITY_CATALOG)[number]; grade: number; gradeLabel: string }) {
    const inert = inertBecause(cap.code);
    const granted = hasCap(grade, cap.code);
    return (
      <div
        className={cn(
          "flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3.5 transition-colors",
          granted && "border-primary/25 bg-primary/5",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold text-foreground">
            {cap.label}
            <Badge variant="outline" className="font-normal tracking-normal normal-case">
              {TIER_LABEL[CAP_TIER[cap.code]]}
            </Badge>
            <Badge variant="secondary" className="font-normal tracking-normal text-muted-foreground normal-case">
              {CAP_MEANING[cap.code].where}
            </Badge>
          </div>
          {/* Toujours affiché en clair, jamais derrière une infobulle: un manager qui n'a jamais vu
              cette page doit comprendre le droit sans avoir à penser à cliquer quelque chose pour
              le découvrir. */}
          <span className="text-xs leading-relaxed font-normal text-muted-foreground">
            {CAP_MEANING[cap.code].does}
          </span>
          {inert ? <span className="text-xs font-normal text-[var(--warn)]">{inert}</span> : null}
        </div>
        <Switch
          checked={granted}
          disabled={!canWrite}
          aria-label={`${cap.label}, ${gradeLabel}`}
          title={!canWrite && writeReason ? writeReason : undefined}
          onCheckedChange={() => toggleGrant(grade, cap.code)}
          className="mt-0.5 shrink-0"
        />
      </div>
    );
  }

  /* ── Page fermée ────────────────────────────────────────────────────────────────────────────── */

  if (!hasAccess) {
    return (
      <>
        <div className="head">
          <h1>Réglages</h1>
          <span className="sub">{name}</span>
        </div>
        <Empty className="border border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock className="size-4" />
            </EmptyMedia>
            <EmptyTitle>Accès restreint</EmptyTitle>
            <EmptyDescription>
              Vous n&apos;avez pas accès aux réglages de cette entreprise. C&apos;est la direction qui
              distribue ce droit par grade.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const nonSensitive = CAPABILITY_CATALOG.filter((c) => !c.sensitive);
  const sensitive = CAPABILITY_CATALOG.filter((c) => c.sensitive);

  return (
    <>
      <div className="head">
        <h1>Réglages</h1>
        <span className="sub">{name}</span>
      </div>

      {!canWrite ? (
        <Alert className="mb-4 border-[var(--warn)] [&>svg]:text-[var(--warn)]">
          <Lock />
          <AlertTitle>Modification verrouillée.</AlertTitle>
          <AlertDescription className="text-foreground/85">
            {writeReason ?? "La prise de service est requise pour changer les réglages."} Tout reste
            consultable, rien n&apos;est enregistrable.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Fondu d'ouverture de page, une seule fois au montage: la page était entièrement statique
          avant cette passe, ce qui faisait partie du même reproche du propriétaire que sur Pointage
          ("not animated"). Respecte prefers-reduced-motion (voir reglages.module.css). */}
      <div className={s.pageFade}>
        {/* ⚠ LE BANDEAU DE CHIFFRES EST LE POINT D'ENTRÉE DE LA PAGE, pas une décoration. Le reproche
            du propriétaire ("i look at it i feel lost") vise trois sections de même poids empilées
            sans rien qui dise par où commencer. Quatre valeurs RÉELLES, lues des mêmes données que
            les sections en dessous, donnent à l'oeil un endroit où se poser et un état du commerce en
            une ligne. Aucune n'est estimée: si la base ne sait pas, la figure ne s'affiche pas.
            Chaque valeur compte désormais jusqu'à elle-même (`useCountUp`) au lieu de s'afficher d'un
            bloc: le même geste que Mes ventes sur son chiffre d'affaires, appliqué au seul endroit de
            cette page qui a des nombres à montrer. Chrome de page inchangé (classes de business.css). */}
        <div className="figs">
          <div className="fig">
            <div className="k cap">Modules actifs</div>
            <div className="v lead">
              {activeModulesAnim}
              <span className={s.outOf}>/{realModules}</span>
            </div>
            <div className="m">{modulesDirty ? "modifications non enregistrées" : "conformes à ce qui est enregistré"}</div>
          </div>
          <div className="fig">
            <div className="k cap">Rayons</div>
            <div className="v">{rayonCountAnim}</div>
            <div className="m">dans cet ordre à la caisse</div>
          </div>
          <div className="fig">
            <div className="k cap">Articles classés</div>
            <div className="v">{totalClassedAnim}</div>
            <div className="m">archivés compris</div>
          </div>
          <div className="fig">
            <div className="k cap">Grades à équiper</div>
            <div className="v">{gradesCountAnim}</div>
            <div className="m">
              {bossGradeLabel ? `${bossGradeLabel} détient tout` : "le patron détient tout"}
            </div>
          </div>
        </div>

        {/* ⚠ DEUX PANNEAUX SUR UNE RANGÉE, HAUTEURS ÉGALES PAR CONSTRUCTION - squelette de mise en page
            inchangé par cette passe. `Card` est déjà `flex flex-col`; `h-full` sur chaque carte plus
            `align-items: stretch` (comportement par défaut de la grille) suffit à ce que leurs pieds
            d'actions se rejoignent, et `mt-auto` sur chaque `CardFooter` loge l'écart de contenu entre
            les cartes et le pied plutôt que de décaler le bord du panneau. */}
        <div className={s.workRow}>
          {/* ══ 1. MODULES ════════════════════════════════════════════════════════════════════════ */}
          <Card className="h-full">
            <CardHeader className="gap-1.5 border-b">
              <div className="flex items-center gap-2">
                <Settings2 className="size-4 text-primary" aria-hidden="true" />
                <CardTitle>Modules</CardTitle>
              </div>
              <CardDescription>
                {activeModules} actif{activeModules > 1 ? "s" : ""} sur {realModules}, modèle{" "}
                {templateLabel}
              </CardDescription>
              {modulesDirty ? (
                <CardAction>
                  <Badge variant="outline" className="border-[var(--warn)] text-[var(--warn)]">
                    Non enregistré
                  </Badge>
                </CardAction>
              ) : null}
            </CardHeader>

            <CardContent className="flex flex-1 flex-col gap-4 pt-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Un module est une <strong className="font-semibold text-foreground">capacité du commerce</strong>,
                pas une préférence d&apos;affichage: l&apos;éteindre ferme aussi les droits qu&apos;il
                alimente, y compris pour la direction. Ce commerce part du modèle{" "}
                <strong className="font-semibold text-foreground">{templateLabel}</strong> et ne garde que ses
                différences, donc retoucher le modèle met à jour tous les commerces qui en dépendent, sauf
                ceux qui ont personnalisé le module en question.
              </p>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                {BUSINESS_MODULES.map((m) => {
                  const on = effectiveModule(m);
                  const custom = !m.core && !m.soon && m.key in overrides;
                  const changed = on !== savedModule(m);

                  // L'origine de l'état, en un mot, et le motif du verrou, en une phrase. Un module
                  // essentiel et un module à venir sont tous deux grisés POUR DES RAISONS OPPOSÉES: le
                  // premier ne peut pas s'éteindre, le second ne peut pas s'allumer.
                  const origin = m.core
                    ? "Essentiel"
                    : m.soon
                      ? "Bientôt"
                      : custom
                        ? "Personnalisé"
                        : "Hérité du modèle";
                  const why = m.core
                    ? "Ne peut pas être éteint: sans caisse ni catalogue, ce commerce n'a plus rien à vendre ni de quoi rouvrir."
                    : m.soon
                      ? "Ne peut pas être allumé: rien n'est encore construit derrière, la case mentirait."
                      : on
                        ? "Cliquez pour éteindre."
                        : "Cliquez pour allumer.";

                  const opens = CAPABILITY_CATALOG.filter((c) =>
                    (m.capabilities as readonly string[]).includes(c.code),
                  );

                  return (
                    <Card
                      key={m.key}
                      className={cn(
                        "h-full gap-0 py-0 transition-shadow",
                        m.soon && "border-dashed",
                        changed && "ring-[var(--warn)]",
                      )}
                    >
                      <CardHeader className="gap-1.5 px-3 pt-3 pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className={cn("text-sm", !on && "text-muted-foreground")}>
                            {m.label}
                          </CardTitle>
                          <Badge
                            variant={custom ? "default" : m.soon ? "outline" : "secondary"}
                            className={cn("shrink-0", m.soon && "border-[var(--warn)] text-[var(--warn)]")}
                          >
                            {origin}
                          </Badge>
                        </div>
                        <CardDescription className="text-xs leading-relaxed">{m.desc}</CardDescription>
                      </CardHeader>

                      <CardContent className="flex flex-1 flex-col gap-1 px-3 py-2">
                        <span className="text-[10px] font-bold tracking-[0.12em] text-muted-foreground/80 uppercase">
                          {opens.length > 0 ? "Ce qu'il ouvre" : "Ce qu'il change"}
                        </span>
                        {opens.length > 0 ? (
                          <ul className="flex flex-col gap-1">
                            {opens.map((c) => (
                              <li key={c.code} className="flex gap-1.5 text-xs leading-snug text-muted-foreground">
                                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden="true" />
                                <span>
                                  {c.label}
                                  {" : "}
                                  {c.desc.toLowerCase()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs leading-snug text-muted-foreground">
                            {MODULE_EFFECT[m.key] ?? "Aucun droit à distribuer: ce module change l'affichage."}
                          </p>
                        )}
                      </CardContent>

                      <CardFooter className="mt-auto flex items-center gap-2.5 px-3 py-2.5">
                        <Switch
                          checked={on}
                          disabled={m.core || m.soon || !canWrite}
                          aria-label={m.label}
                          onCheckedChange={() => toggleModule(m)}
                        />
                        <span className="flex flex-1 flex-col gap-0.5">
                          <b
                            className={cn(
                              "text-[10px] font-bold tracking-[0.1em] uppercase",
                              on ? "text-[var(--ok)]" : "text-muted-foreground",
                            )}
                          >
                            {on ? "Actif" : "Éteint"}
                          </b>
                          <span className="text-[10px] leading-snug text-muted-foreground">
                            {!canWrite && writeReason ? writeReason : why}
                          </span>
                        </span>
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>

              {moduleError ? <p className="text-sm text-destructive">{moduleError}</p> : null}
            </CardContent>

            <CardFooter className="mt-auto flex-wrap gap-2">
              <Button disabled={!canWrite || modPending} onClick={saveModules}>
                {modPending ? "Enregistrement…" : "Enregistrer les modules"}
              </Button>
              <Button variant="outline" disabled={!canWrite || modPending} onClick={resetModules}>
                Reprendre le modèle {templateLabel}
              </Button>
              <span className="flex-1 min-w-[180px] text-xs leading-relaxed text-muted-foreground">
                Reprendre le modèle efface les personnalisations de ce commerce et le remet sur les
                réglages partagés.
              </span>
            </CardFooter>
          </Card>

          {/* ══ 2. RAYONS ═════════════════════════════════════════════════════════════════════════ */}
          <Card className="h-full">
            <CardHeader className="gap-1.5 border-b">
              <div className="flex items-center gap-2">
                <Tags className="size-4 text-primary" aria-hidden="true" />
                <CardTitle>Rayons</CardTitle>
              </div>
              <CardDescription>
                {catState.length} rayon{catState.length > 1 ? "s" : ""}, dans cet ordre à la caisse
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-1 flex-col gap-3 pt-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Un rayon porte une <strong className="font-semibold text-foreground">couleur</strong> et une{" "}
                <strong className="font-semibold text-foreground">icône</strong>: la couleur teinte la puce
                et la vignette de ses articles, l&apos;icône est le dessin que prend un article qui
                n&apos;a pas le sien. Cliquez un rayon pour l&apos;ouvrir et le modifier; un seul reste
                ouvert à la fois.
              </p>

              {orphaned.length > 0 ? (
                <Alert className="border-[var(--warn)] [&>svg]:text-[var(--warn)]">
                  <AlertTriangle />
                  <AlertTitle>Ces rayons portent encore des articles.</AlertTitle>
                  <AlertDescription className="text-foreground/85">
                    {orphaned.map((o) => `${o.key} (${o.n})`).join(", ")}. Tant qu&apos;ils ne sont pas
                    vidés depuis le Catalogue, l&apos;enregistrement sera refusé EN ENTIER, y compris les
                    libellés et les couleurs que vous venez de changer.
                  </AlertDescription>
                </Alert>
              ) : null}

              {/* ⚠ UNE SEULE CARTE, DES RANGÉES SÉPARÉES PAR UN FILET - PAS N CARTES EMPILÉES.
                  Calibrage "Shopify grade UI/UX": une liste de réglages (fournisseurs de paiement,
                  utilisateurs, dans l'admin Shopify) n'empile pas une boîte bordée par ligne, elle
                  tient dans UN panneau et sépare ses lignes par une bordure fine à un seul côté. Six
                  rayons affichaient avant six coins arrondis et six contours: une seule bordure
                  extérieure ici, `border-t` entre les rangées (jamais autour de chacune). */}
              <div className="flex flex-1 flex-col gap-3">
                {catState.length > 0 ? (
                <Card className="gap-0 overflow-hidden py-0">
                    {catState.map((c, i) => {
                  // La clé est `c.key` quand il existe, sinon l'index: un rayon tout juste ajouté n'a
                  // pas encore de clé stable (elle se dérive du libellé seulement à l'enregistrement,
                  // voir `saveCategories`), donc l'index reste le seul identifiant sûr pendant que ce
                  // rayon n'existe que dans cet état local.
                  const n = countFor(c, i);
                  const derived = c.key || slugify(c.label) || "clé à venir";
                  const icon = (c.icon && CATEGORY_ICONS[c.icon]) || CATEGORY_ICONS.box || "";
                  const open = activeRayon === i;
                  const panelId = `rayon-panel-${i}`;
                  return (
                    <div
                      key={c.key || `new-${i}`}
                      className={cn(i > 0 && "border-t border-border")}
                      style={toneVars(c.tone) as React.CSSProperties}
                    >
                      {/* LA RANGÉE REPLIÉE: ce qu'on voit pour TOUS les rayons à la fois. Assez pour
                          reconnaître un rayon (icône teintée, libellé, clé, nombre d'articles) sans
                          faire le poids d'un éditeur complet. Toute la rangée est le bouton, pour une
                          cible de clic large plutôt qu'un seul petit chevron. */}
                      <button
                        type="button"
                        className={s.rayonHead}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => toggleRayon(i)}
                      >
                        <span className={s.rayonPlate} aria-hidden="true">
                          <span
                            style={{ color: "var(--k, var(--foreground))" }}
                            dangerouslySetInnerHTML={{ __html: icon }}
                          />
                          {/* LA PASTILLE PLEINE DE LA COULEUR DU RAYON, EN PLUS DU TRAIT TEINTÉ DE
                              L'ICÔNE. Verdict propriétaire du 2026-08-09 sur cette section précise
                              ("same with this Rayons"): un trait fin teinté suffit à ancrer le dessin,
                              pas à repérer d'un coup d'oeil que deux rayons partagent le MÊME ton
                              parmi les quatre disponibles. Un aplat, lui, se compare instantanément
                              en parcourant la liste. */}
                          <span className={s.rayonToneDot} style={{ background: "var(--k)" }} />
                        </span>
                        <span className={s.rayonInfo}>
                          <span className={s.rayonLabel}>{c.label.trim() || "Rayon"}</span>
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            {derived}
                          </span>
                        </span>
                        <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
                          {n === 0 ? "aucun article" : `${n} article${n > 1 ? "s" : ""}`}
                        </Badge>
                        <ChevronRight
                          className={cn(s.rayonChevron, open && s.rayonChevronOpen)}
                          aria-hidden="true"
                        />
                      </button>

                      {/* L'ÉDITEUR COMPLET: replié à `grid-template-rows: 0fr` (voir
                          reglages.module.css), et `inert` tant qu'il est fermé - un Tab ne doit plus
                          pouvoir atteindre un champ invisible. */}
                      <div id={panelId} className={s.rayonBody} data-open={open}>
                        <div className={s.rayonBodyInner} inert={!open}>
                          <div key={i} className={cn("flex flex-col gap-3 px-3 pt-2 pb-3", s.rayonFade)}>
                            <div className="flex items-center gap-2.5">
                              {/* ⚠ `dangerouslySetInnerHTML` acceptable pour la même unique raison que
                                  dans la caisse et la vignette produit: la chaîne vient d'une table
                                  FIGÉE du code (`lib/business/art.ts`), et `c.icon`, qui vient de la
                                  base, ne sert que de CLÉ de recherche. Index contre contenu. */}
                              <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen}>
                                <PopoverTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-lg"
                                    disabled={!canWrite}
                                    aria-label={`Icône du rayon ${c.label}`}
                                    title="Changer l'icône du rayon"
                                    className="shrink-0"
                                    style={{ background: "var(--plate)", color: "var(--k, var(--foreground))" }}
                                  >
                                    <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-72" align="start">
                                  <div className="grid max-h-56 grid-cols-5 gap-1.5 overflow-y-auto overscroll-contain">
                                    {ICON_KEYS.map((k) => (
                                      <Button
                                        key={k}
                                        type="button"
                                        variant={(c.icon ?? "box") === k ? "default" : "outline"}
                                        size="icon-lg"
                                        aria-pressed={(c.icon ?? "box") === k}
                                        aria-label={k}
                                        title={k}
                                        disabled={!canWrite}
                                        onClick={() => updateCat(i, { icon: k })}
                                        style={
                                          (c.icon ?? "box") === k
                                            ? undefined
                                            : { background: "var(--plate)", color: "var(--k, var(--foreground))" }
                                        }
                                      >
                                        <span
                                          aria-hidden="true"
                                          dangerouslySetInnerHTML={{ __html: CATEGORY_ICONS[k] ?? "" }}
                                        />
                                      </Button>
                                    ))}
                                  </div>
                                </PopoverContent>
                              </Popover>

                              <label className="flex min-w-0 flex-1 flex-col gap-1">
                                <Input
                                  value={c.label}
                                  disabled={!canWrite}
                                  maxLength={60}
                                  aria-label="Libellé du rayon"
                                  onChange={(e) => updateCat(i, { label: e.target.value })}
                                />
                                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                  {derived}
                                </span>
                              </label>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              {[1, 2, 3, 4].map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  className={s.tone}
                                  aria-pressed={c.tone === t}
                                  disabled={!canWrite}
                                  aria-label={`Couleur ${t} du commerce`}
                                  title={`Couleur ${t} du commerce`}
                                  style={toneVars(t) as React.CSSProperties}
                                  onClick={() => updateCat(i, { tone: t })}
                                />
                              ))}
                              <span className="flex-1" />
                              {/* LA PUCE EXACTE QUE LA CAISSE DESSINE. Le choix d'une couleur se fait
                                  sur ce qu'on verra, pas sur un carré isolé. `aria-hidden`: c'est un
                                  aperçu du rendu, pas un contrôle, et le libellé est déjà annoncé par
                                  le champ juste au-dessus. */}
                              <Badge
                                aria-hidden="true"
                                className="border-transparent"
                                style={{ background: "var(--k)", color: "var(--onk, var(--primary-foreground))" }}
                              >
                                {c.label.trim() || "Rayon"}
                              </Badge>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!canWrite || i === 0}
                                onClick={() => moveCat(i, -1)}
                                title="Placer plus tôt à la caisse"
                              >
                                <ChevronUp />
                                Monter
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!canWrite || i === catState.length - 1}
                                onClick={() => moveCat(i, 1)}
                                title="Placer plus tard à la caisse"
                              >
                                <ChevronDown />
                                Descendre
                              </Button>
                              <span className="flex-1" />
                              {/* ⚠ MONTRÉ ET EXPLIQUÉ, JAMAIS RETIRÉ. Un rayon qui porte des articles
                                  ne peut pas disparaître (`setCategories` le refuse: ses articles
                                  deviendraient invisibles à la caisse tout en restant vendables par
                                  leur identifiant). Le bouton reste donc là, grisé, avec la marche à
                                  suivre. Variante destructive UNIQUEMENT quand le geste est réellement
                                  possible: peindre en rouge un bouton déjà grisé laisserait deviner
                                  pourquoi, et `--destructive` reste le seul rouge de cette page, jamais
                                  teinté par la couleur DE CE commerce (voir theme.ts). */}
                              <Button
                                type="button"
                                variant={n > 0 ? "outline" : "destructive"}
                                size="sm"
                                disabled={!canWrite || n > 0}
                                title={
                                  n > 0
                                    ? `Ce rayon porte ${n} article${n > 1 ? "s" : ""}. Reclassez-les ou archivez-les depuis le Catalogue avant de le retirer.`
                                    : "Retirer ce rayon"
                                }
                                onClick={() => removeCat(i)}
                              >
                                <Trash2 />
                                Retirer
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                    })}
                </Card>
                ) : (
                  <Empty className="border border-dashed py-6">
                    <EmptyHeader>
                      <EmptyTitle>Aucun rayon</EmptyTitle>
                      <EmptyDescription>
                        La caisse ne saura grouper aucun article tant qu&apos;il n&apos;y en a pas au
                        moins un.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}

                {/* LE GESTE AU BOUT DE LA LISTE QU'ON TIENT, et pas dans le pied du panneau: le geste
                    posé là où le regard finit, exactement comme la vignette "ajouter" au bout d'un
                    rayon du Catalogue. */}
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={addCat}
                  className="w-full justify-center gap-2 border-dashed text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-4" />
                  Ajouter un rayon
                </Button>
              </div>

              {catError ? <p className="text-sm text-destructive">{catError}</p> : null}
            </CardContent>

            <CardFooter className="mt-auto flex-wrap gap-2">
              <Button disabled={!canWrite || catPending} onClick={saveCategories}>
                {catPending ? "Enregistrement…" : "Enregistrer les rayons"}
              </Button>
              <span className="flex-1 min-w-[180px] text-xs leading-relaxed text-muted-foreground">
                L&apos;ordre ci-dessus est celui des puces à la caisse et des sections du Catalogue. Un
                rayon ajouté n&apos;existe qu&apos;une fois enregistré.
              </span>
            </CardFooter>
          </Card>
        </div>

        {/* ══ 3. DROITS PAR GRADE ═══════════════════════════════════════════════════════════════════ */}
        <Card className="mb-4">
          <CardHeader className="gap-1.5 border-b">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              <CardTitle>Droits par grade</CardTitle>
            </div>
            <CardDescription>
              {grades.length} grade{grades.length > 1 ? "s" : ""} sous la direction
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4 pt-4">
            {!hadCustomGrants ? (
              <Alert>
                <Info />
                <AlertTitle>Rien n&apos;a encore été distribué dans ce commerce.</AlertTitle>
                <AlertDescription>
                  Les cases ci-dessous montrent déjà le repli du premier jour (encaisser, voir ses
                  ventes, voir le catalogue), qui s&apos;applique à tous les grades tant que vous
                  n&apos;enregistrez pas. Le premier enregistrement le remplace: ce que vous voyez
                  devient ce qui s&apos;applique, grade par grade.
                </AlertDescription>
              </Alert>
            ) : null}

            {grades.length === 0 ? (
              <Empty className="border border-dashed py-6">
                <EmptyHeader>
                  <EmptyTitle>Aucun grade à équiper</EmptyTitle>
                  <EmptyDescription>
                    Ce métier n&apos;a aucun grade en dessous du patron: il n&apos;y a rien à distribuer.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              /* ⚠⚠ REFONTE DU 2026-08-09 (verdict direct du propriétaire sur la page EN LIGNE,
               * *"Droits par grade this isnt done properly"*): la matrice `<Table>` (une colonne par
               * grade, huit lignes de droits, chaque case une intersection à repérer) est REMPLACÉE
               * par UN GRADE À LA FOIS, choisi dans une bande de vignettes, chacune montrant déjà sa
               * propre barre de progression. Trois raisons concrètes, pas une préférence esthétique:
               *
               *   1. SCANNABILITÉ. "Ce grade a-t-il ce droit" demandait de suivre une ligne ET une
               *      colonne au doigt dans une grille de huit sur (jusqu'à huit, voir la vignette
               *      patron plus bas) cases. Choisir un grade puis lire HUIT lignes verticales, une
               *      seule case cochée à la fois par ligne, ne demande plus de suivre une
               *      intersection: c'est la seule question à laquelle chaque ligne répond.
               *   2. VOLUME RÉEL. `job_grades` n'est pas borné à trois échelons - un métier comme la
               *      police ou une supérette avec plusieurs paliers d'encadrement peut en compter
               *      sept ou huit (voir gameCommands.ts `gradesForJob`). Huit colonnes de commutateurs
               *      dans un tableau qui défile horizontalement était déjà la limite de ce qu'un
               *      tableau peut porter; sur un téléphone (375px), chaque colonne n'aurait plus eu
               *      la place de recevoir un doigt sans viser une case voisine par erreur.
               *   3. DENSITÉ "Shopify grade UI/UX" (calibrage donné en cours de cette même passe): une
               *      ligne de droit a maintenant toute la largeur du panneau pour sa phrase
               *      d'explication ET son interrupteur, au lieu de se compresser dans une cellule de
               *      tableau partagée avec sept voisines.
               *
               * ⚠ CE QUI NE CHANGE PAS: `hasCap`/`toggleGrant`/`countForGrade`/`inertBecause` sont les
               * MÊMES fonctions qu'avant, appelées avec les mêmes arguments; seul l'endroit d'où elles
               * sont appelées change de forme. `saveGrants` envoie toujours `grantsState` en entier.
               *
               * ⚠⚠ LE PATRON EST DÉSORMAIS UNE VIGNETTE DE TÊTE DE BANDE, PAS SEULEMENT UNE PHRASE
               * AU-DESSUS. Avant cette passe il vivait dans une bande `Alert` séparée, au-dessus de la
               * grille - correcte mais DÉCONNECTÉE visuellement des grades qu'elle décrit, ce qui
               * pouvait se lire comme une note à part plutôt que comme "voici TOUS les échelons de ce
               * métier, patron compris". Il ouvre maintenant la même bande de vignettes que les
               * grades réels, à la même hauteur, avec le même langage visuel (nom, un repère de
               * niveau) - mais n'est ni un onglet Radix ni cliquable (`<div>`, pas `<TabsTrigger>`):
               * `setGrants` retire ce grade avant d'écrire quoi que ce soit (voir son commentaire),
               * donc lui donner un panneau à éditer serait un contrôle qui ne fait rien. La phrase
               * complète ("pourquoi il ne peut pas en avoir") reste écrite en toutes lettres sous son
               * nom, jamais réduite à une seule couleur qu'il faudrait deviner.
               */
              <Tabs
                value={selectedGrade === null ? undefined : String(selectedGrade)}
                onValueChange={(v) => setSelectedGrade(Number(v))}
                className="gap-4"
              >
                <div className="flex flex-col gap-2">
                  <div className={s.gradeStrip}>
                    <div className={s.gradeStripBoss}>
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                        <Crown className="size-3.5 shrink-0" aria-hidden="true" />
                        {bossGradeLabel ?? "Patron"}
                      </span>
                      <span className="text-[10px] leading-relaxed font-medium text-primary/85">
                        Tout, toujours. Ne se retire jamais.
                      </span>
                    </div>

                    <TabsList
                      variant="line"
                      className={cn(s.gradeList, "h-auto w-fit shrink-0 justify-start gap-2 border-0 bg-transparent p-0")}
                    >
                      {grades.map((g) => {
                        const granted = countForGrade(g.grade);
                        return (
                          <TabsTrigger key={g.grade} value={String(g.grade)} className={s.gradeTab}>
                            <span className="text-sm font-semibold text-foreground">{g.label}</span>
                            <Progress value={(granted / CAPABILITY_CATALOG.length) * 100} className="h-1 w-full" />
                            <span className="text-[10px] font-medium tracking-normal text-muted-foreground normal-case tabular-nums">
                              {granted}/{CAPABILITY_CATALOG.length} droits
                            </span>
                          </TabsTrigger>
                        );
                      })}
                    </TabsList>
                  </div>

                  {/* La phrase complète reste écrite, pas seulement devinable depuis le contour de la
                      vignette: un survol n'est pas une explication sur un écran tactile, et personne
                      ne doit avoir à chercher pourquoi CE nom-là n'ouvre aucun panneau. */}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <strong className="font-semibold text-foreground">{bossGradeLabel ?? "Patron"}</strong>{" "}
                    n&apos;est pas un onglet: il n&apos;a pas de panneau à ouvrir parce qu&apos;il
                    détient déjà tous les droits ci-dessous, pour chaque grade. Une case qui lui
                    retirerait un droit enfermerait l&apos;entreprise dehors, sans personne à
                    l&apos;intérieur pour rouvrir - la révocation est rendue impossible à écrire, pas
                    seulement déconseillée.
                  </p>
                </div>

                {grades.map((g) => (
                  <TabsContent key={g.grade} value={String(g.grade)} className="flex flex-col gap-5 outline-none">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[10px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
                          Le quotidien
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                      <div className="flex flex-col gap-2">
                        {nonSensitive.map((cap) => (
                          <React.Fragment key={cap.code}>
                            {capabilityRow({ cap, grade: g.grade, gradeLabel: g.label })}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>

                    <div className={cn("flex flex-col gap-2", s.hotBlock)}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-[10px] font-bold tracking-[0.12em] text-[var(--warn)] uppercase">
                          Argent, heures et données des collègues
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                      <div className="flex flex-col gap-2">
                        {sensitive.map((cap) => (
                          <React.Fragment key={cap.code}>
                            {capabilityRow({ cap, grade: g.grade, gradeLabel: g.label })}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            )}

            {grantsError ? <p className="text-sm text-destructive">{grantsError}</p> : null}
          </CardContent>

          {grades.length > 0 ? (
            <CardFooter className="flex-wrap gap-2">
              <Button disabled={!canWrite || grantsPending} onClick={saveGrants}>
                {grantsPending ? "Enregistrement…" : "Enregistrer les droits"}
              </Button>
              <span className="flex-1 min-w-[180px] text-xs leading-relaxed text-muted-foreground">
                Un droit accordé ne suffit pas: chacun exige en plus un palier de présence, rappelé sur
                sa ligne.
              </span>
            </CardFooter>
          ) : null}
        </Card>
      </div>
    </>
  );
}
