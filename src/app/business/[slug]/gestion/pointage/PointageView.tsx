"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Clock3, Inbox, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { toneVars } from "@/lib/business/theme";
import { correctShiftAction, type CorrectShiftState } from "./actions";
import s from "./pointage.module.css";

/**
 * LE POINTAGE, côté navigateur.
 *
 * La page répond à quatre questions, dans cet ordre: COMBIEN d'heures au total, COMMENT elles se
 * répartissent (par jour, par heure de la journée), QUAND chacun a travaillé, et QUEL pointage
 * précis corriger.
 *
 * ⚠⚠ AUCUNE DURÉE N'EST RECALCULÉE ICI CONTRE L'HEURE COURANTE. `seconds` arrive déjà figé depuis
 * `lib/business/shifts.ts`: pour un service ouvert, c'est la durée jusqu'au DERNIER HEARTBEAT.
 * `effectiveEndMs` (= début + `seconds`) en découle, et c'est LUI qui dessine chaque marque, chaque
 * barre de graphique et chaque total. Recalculer côté client réintroduirait exactement le bug que
 * cette colonne existe pour empêcher: un serveur planté à 3h du matin qui crédite huit heures de
 * sommeil à toute l'équipe, puis neuf le lendemain. La seule soustraction de dates de ce fichier
 * porte sur les DEUX VALEURS SAISIES dans le formulaire de correction, ce qui est un aperçu de ce
 * que l'on s'apprête à écrire, pas une mesure du réel.
 *
 * ⚠ La fraîcheur vient d'un RAFRAÎCHISSEMENT SERVEUR périodique, jamais d'un compteur qui
 * s'incrémente tout seul. Un chiffre qui monte dans le navigateur pendant que le jeu est muet est un
 * mensonge confortable; ici le nombre ne bouge que parce que le serveur l'a recompté.
 *
 * ─── TROISIÈME PASSE (2026-08-09): LE PROBLÈME N'ÉTAIT PAS LE STYLE, C'ÉTAIT LA VISUALISATION ────
 * Verdicts successifs du propriétaire, en production: *"the layout isnt good. i look at it i feel
 * lost. or like there are as you can see uneven higfhts"*, puis *"its just not done correctly and
 * not clean [...] not animated"*, puis *"gestion/pointage needs to be completly redone using shadcn.
 * look how bad it looks"*. Les deux passes précédentes ont répondu en polissant (keyframes écrites à
 * la main, cascades, compte animé, retrait d'un axe Recharts inutile) et le verdict n'a pas bougé.
 * La cause n'était donc pas le fini: c'était LA FORME CHOISIE POUR MONTRER LA DONNÉE.
 *
 * MESURÉ, PAS SUPPOSÉ, sur les vraies lignes de `lifeinvader_business_shifts` (métier `vigneron`, 14
 * pointages): une journée réelle contient une douzaine de pointages de 2 à 22 minutes ÉPARPILLÉS de
 * 00h19 à 21h17. Une piste de temps CONTINUE sur cette donnée est vide à plus de 98 pour cent par
 * construction, et chaque service y mesure quelques pixels de large. Ce n'est pas un défaut de
 * réglage: la personne n'a réellement pas travaillé pendant 98 pour cent de la journée, et une frise
 * honnête doit le montrer. Le tort était de consacrer ~450px de hauteur à ce constat.
 *
 * ⚠ ZOOMER L'AXE SUR LA FENÊTRE ACTIVE NE SUFFIT PAS, et c'est le piège de ce problème. `dayWindow`
 * le fait déjà (marge symétrique autour de l'activité, recentrage sous une amplitude plancher), ce
 * qui aide beaucoup quand tout le monde travaille entre 19h et 23h. Sur la donnée réelle ci-dessus
 * la fenêtre active fait 21 heures: le vide est ENTRE les pointages, pas sur les bords, et aucun
 * cadrage ne le supprime. Le zoom est conservé parce qu'il sert le cas courant, il n'est simplement
 * pas la réponse.
 *
 * TROIS SURFACES REMPLACENT LA TOILE UNIQUE, chacune incapable de produire du vide:
 *
 *   1. LE GRAPHIQUE (`WorkChart`), un vrai graphique shadcn/Recharts, en tête de page. Deux vues
 *      choisies par un `<Select>` dans l'en-tête de la carte, exactement le motif de la maquette
 *      officielle "interactive area chart":
 *        - "Par jour": barres EMPILÉES par employé sur les 7 jours. 7 catégories occupent toujours
 *          toute la largeur, un jour à zéro est un emplacement vide de 1/7e, jamais un désert.
 *        - "Par heure": aire (gradient `<defs>`, `type="monotone"`) des heures travaillées par
 *          TRANCHE HORAIRE, cumulées sur la période. C'est la réponse honnête et sans vide à "quand
 *          travaille-t-on": 24 tranches remplissent la largeur quoi qu'il arrive, et le patron y lit
 *          d'un coup d'oeil les heures jamais couvertes. C'est précisément ce que la frise continue
 *          prétendait montrer et montrait mal.
 *   2. LE RUBAN (`Ribbon`), le concept que le propriétaire a explicitement gardé ("i like the concept
 *      of show punches are shown Répartition du temps"): un couloir par employé, les chevauchements
 *      et les trous se lisent verticalement. Ce qui change: il fait 22px par employé au lieu d'une
 *      toile de 450px, une marque ne porte AUCUN texte (le libellé débordait de la marque et deux
 *      marques voisines se noyaient l'une dans l'autre), et chaque marque a une largeur MINIMALE en
 *      pixels mesurés, avec décalage anti-collision. Le rapport vide/contenu est le même, l'aire de
 *      vide est divisée par vingt: un ruban de 60px avec des repères fins se lit comme une bande de
 *      temps, un rectangle de 450px presque vide se lit comme une panne.
 *   3. LE JOURNAL (`Table` shadcn), la liste ligne par ligne. Une liste n'a jamais de vide et tient
 *      aussi bien 1 pointage que 200. C'est aussi elle qui porte la correction.
 *
 * ⚠ LES SEPT PUCES DE JOUR NE SONT PLUS SEPT CARTES DE MÊME POIDS. Cinq d'entre elles disaient
 * "0,0 h" au même corps que les deux qui portaient une vraie valeur. Une journée sans pointage
 * n'affiche plus de nombre du tout (un tiret), s'atténue, et sa jauge reste vide; la puce
 * "Semaine" les remplace toutes quand on veut l'ensemble, ce qui fond l'ancien sélecteur
 * Jour/Semaine dans le même contrôle au lieu d'en aligner deux.
 */

const TZ = "America/Toronto";
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Le serveur est relu à cette cadence. Assez court pour qu'un service qui vient de se terminer
 *  devienne corrigible sans que personne n'ait à recharger, assez long pour ne rien coûter. */
const AUTO_REFRESH_MS = 60_000;

export type DayCell = {
  key: string;
  weekday: string;
  date: string;
  startMs: number;
  endMs: number;
  isToday: boolean;
  isFuture: boolean;
};

export type PointageShift = {
  id: number;
  identifier: string;
  name: string;
  /** Le jour de Toronto de la PRISE de service. Calculé côté serveur, jamais redérivé ici. */
  dayKey: string;
  startMs: number;
  /** Fin RETENUE: fin réelle, ou dernier heartbeat si le service est ouvert. Jamais maintenant. */
  effectiveEndMs: number;
  /** Fin RÉELLE. `null` tant que le service est ouvert, ce qui est aussi le test "pas corrigeable". */
  endedAtMs: number | null;
  endedReason: string | null;
  seconds: number;
};

export type TotalsRow = {
  identifier: string;
  name: string;
  /**
   * La personne a pointé pendant la période mais ne tient plus ce métier dans le jeu.
   *
   * ⚠ SA LIGNE RESTE, ET SES HEURES RESTENT EXACTES. Demande du propriétaire, verbatim: "this should
   * still show data of someone no longer in the job. just grayed out or whatever". Des heures
   * travaillées sont un fait: les masquer changerait en silence le total de la semaine chaque fois
   * que quelqu'un change de métier, ce qui est bien pire qu'une ligne en trop.
   */
  former: boolean;
  daySeconds: number;
  dayShifts: number;
  weekSeconds: number;
  weekShifts: number;
};

type OnDutyRow = { id: number; name: string; startMs: number; seconds: number };

type Figures = {
  onDutyCount: number;
  todaySeconds: number;
  weekSeconds: number;
  weekShiftCount: number;
  /** L'effectif RÉEL, lu dans l'annuaire du jeu. Jamais le nombre de lignes, anciens compris. */
  employeeCount: number;
  /** Combien de lignes appartiennent à quelqu'un qui ne tient plus ce métier. */
  formerCount: number;
};

type ReadyProps = {
  slug: string;
  canRead: true;
  canEdit: boolean;
  /** Pourquoi la correction est verrouillée, en une phrase qui dit quoi faire. */
  editReason: string;
  period: "cur" | "prev";
  days: DayCell[];
  defaultDayKey: string;
  weekFromMs: number;
  weekToMs: number;
  onDuty: OnDutyRow[];
  totals: TotalsRow[];
  shifts: PointageShift[];
  figures: Figures;
};

type Props = { slug: string; canRead: false; readReason: string } | ReadyProps;

// ---------------------------------------------------------------- chrome partagé
//
// Un seul rayon dans tout le portail commerce: celui de l'enseigne (`--r`, posé par `paletteStyle`
// dans `lib/business/theme.ts`). Chaque primitive shadcn arrive avec SON PROPRE rayon par défaut
// (`rounded-xl`, `rounded-lg`...), calé sur le panel STAFF et jamais raccordé à `--r`.
//
// ⚠⚠ CETTE CORRECTION PASSE PAR `pointage.module.css` (`.r`/`.lineBorder`/`.fieldInput`), PAS PAR
// UNE CLASSE TAILWIND ARBITRAIRE, ET CE N'EST PAS UN CHOIX DE STYLE. Vérifié le 2026-08-09 en
// compilant ce fichier précis avec `@tailwindcss/cli` 4.3.2: une classe dont la VALEUR est une
// variable CSS (`rounded-[var(--r)]`, `border-(--line)`, `bg-(--k)`) est SILENCIEUSEMENT absente de
// la feuille générée dans CE fichier, alors qu'une valeur fixe (`text-[11px]`) compile sans
// problème. Sans erreur de build, sans avertissement: le panneau retombe sur le chrome par défaut de
// shadcn et rien ne le signale. Une règle de module CSS ne dépend d'aucun scanner de classes.
const BOX = cn(s.rad, s.lineBorder, "border ring-0 shadow-none bg-card");

/**
 * La couleur d'un badge de motif, empruntée aux jetons de statut déjà utilisés partout ailleurs sur
 * cette page (`--ok`/`--warn`/`--bad`/`--line`/`--muted-text`), jamais une teinte shadcn neuve.
 *
 * ⚠ `--muted-text`, pas `--muted`: `lib/business/theme.ts` (`shadcnBridge`) déclare son PROPRE
 * `--muted` sous `[data-biz]`, au sens shadcn ("surface discrète", un fond). `business.css` possédait
 * le sens du portail ("texte secondaire", une couleur) sous le MÊME nom avant que le pont n'existe,
 * et celui du pont gagnait EN SILENCE (texte quasi noir sur fond sombre, mesuré le 2026-08-09).
 * Corrigé à la racine le même jour par le renommage en `--muted-text` dans `business.css`.
 */
const REASON_TONE: Record<string, React.CSSProperties> = {
  on: { borderColor: "var(--ok)", color: "var(--ok)" },
  warn: { borderColor: "var(--warn)", color: "var(--warn)" },
  bad: { borderColor: "var(--bad)", color: "var(--bad)" },
  q: { borderColor: "var(--line)", color: "var(--muted-text)" },
  off: { borderColor: "var(--line)", color: "var(--muted-text)" },
};

/**
 * L'ÉTIQUETTE D'UN ANCIEN EMPLOYÉ.
 *
 * ⚠ CALME, PAS ALARMANTE. Reprend le jeton neutre `q` (`--line` / `--muted-text`), jamais `warn` ni
 * `bad`, qui annoncent quelque chose à faire: quitter un métier n'est pas une anomalie. Pas de
 * pastille non plus, contrairement à un motif de fin de service, parce qu'il n'y a aucun état à
 * signaler par une couleur.
 */
function FormerTag() {
  return (
    <Badge
      variant="outline"
      className={cn(s.rad, "px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider")}
      style={REASON_TONE.q}
      title="Ne tient plus ce métier dans le jeu"
    >
      Ancien
    </Badge>
  );
}

function ReasonBadge({ tag, className }: { tag: { cls: string; label: string }; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(s.rad, "gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", className)}
      style={REASON_TONE[tag.cls]}
    >
      <i className={s.tagDot} aria-hidden="true" />
      {tag.label}
    </Badge>
  );
}

// ---------------------------------------------------------------- fuseau et durées
//
// Les mêmes conversions Toronto vers instant réel que page.tsx, dupliquées volontairement: les deux
// fichiers n'ont pas de module utilitaire commun dans le périmètre de cette tâche. La page affiche
// l'heure de Toronto (même convention que players/lib/format.ts); éditer un pointage dans un fuseau
// différent de celui affiché ferait saisir une heure qui ne correspond pas à ce qu'on regarde.

function torontoParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { y: get("year"), mo: get("month"), da: get("day"), h: get("hour"), mi: get("minute") };
}

/**
 * L'écart entre l'heure murale de Toronto et l'instant réel, en millisecondes, MESURÉ et non lu:
 * l'écart EST/EDT ne se trouve nulle part, il faut reformatter l'instant dans le fuseau et comparer.
 * Sert au découpage par tranche horaire du graphique "Par heure".
 */
function torontoOffsetMs(ms: number): number {
  const p = torontoParts(new Date(ms));
  return Date.UTC(Number(p.y), Number(p.mo) - 1, Number(p.da), Number(p.h), Number(p.mi)) - Math.floor(ms / MIN_MS) * MIN_MS;
}

/** Valeur pour <input type="datetime-local">: l'heure murale de Toronto, sans indication de fuseau. */
function toLocalInputValue(ms: number): string {
  const p = torontoParts(new Date(ms));
  return `${p.y}-${p.mo}-${p.da}T${p.h}:${p.mi}`;
}

/**
 * L'inverse: une heure murale de Toronto saisie dans le formulaire vers l'instant UTC réel qu'elle
 * désigne. On devine d'abord en traitant les chiffres comme de l'UTC, on mesure l'écart réel en
 * reformattant cette estimation dans le fuseau de Toronto, puis on corrige.
 */
function fromLocalInputValue(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const seen = torontoParts(new Date(guess));
  const seenAsUtc = Date.UTC(Number(seen.y), Number(seen.mo) - 1, Number(seen.da), Number(seen.h), Number(seen.mi));
  return guess - (seenAsUtc - guess);
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("fr-CA", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "7 h 12": la durée d'UN service, précise à la minute. */
function formatDurationHM(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(seconds, 0) / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

/** "18,5 h": un TOTAL agrégé (jour, semaine), lu comme un nombre décimal. Virgule française, jamais
 *  le point de `toFixed` brut. */
function formatDurationDecimal(seconds: number): string {
  const hours = Math.max(seconds, 0) / 3600;
  return `${hours.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** Un effectif. Passe par le même contrat `(n: number) => string` que les durées pour que
 *  `<Figure>` n'ait qu'une seule forme de formateur à connaître. */
function formatCount(n: number): string {
  return String(n);
}

// ---------------------------------------------------------------- motif de fin
//
// Les valeurs viennent de `citadelBusinessShifts.endedReason` (lib/db/schema/citadel.ts): un service
// encore ouvert n'a pas de motif du tout, ce que `isOpen` porte séparément.
//
// ⚠ CHAQUE MOTIF PORTE SA PROPRE EXPLICATION, ce qui remplace le bandeau générique qui occupait
// toute la largeur avant TOUTE donnée. Une débauche normale n'a rien à expliquer; un balayage après
// plantage, si. La phrase arrive donc sur le service concerné, au moment où quelqu'un se demande
// pourquoi cette durée-là est courte. Elle est COURTE et en gris: la version précédente écrivait un
// paragraphe ambré de quatre lignes sous chaque service, ce que le propriétaire a nommé en regardant
// la page.
const REASON_TAG: Record<string, { cls: string; label: string; why?: string }> = {
  debauche: { cls: "q", label: "Fin de service" },
  deconnexion: {
    cls: "q",
    label: "Déconnexion",
    why: "Déconnexion sans débauche. La durée s'arrête au dernier signe de vie.",
  },
  afk: {
    cls: "warn",
    label: "Inactivité",
    why: "Service fermé pour inactivité prolongée. La durée s'arrête au dernier signe de vie.",
  },
  crash_sweep: {
    cls: "bad",
    label: "Plantage",
    why: "Service fermé par le balayage qui suit un plantage serveur. La durée s'arrête au dernier signe de vie, jamais au redémarrage.",
  },
  job_change: {
    cls: "q",
    label: "Changement de métier",
    why: "La personne a changé de métier en jeu, ce qui ferme le service en cours.",
  },
  // ⚠ Présent dans l'énumération de la base ET dans les vraies lignes, mais absent de cette table
  // jusqu'au 2026-08-09: une mise hors service décidée par la direction s'affichait donc "Inconnu".
  // Le schéma explique pourquoi la valeur existe: sans elle, une fin SUBIE se rangeait sous
  // `debauche`, qui veut dire "parti de lui-même", sur une fiche de paie.
  force_off: {
    cls: "warn",
    label: "Mise hors service",
    why: "La direction a retiré cette personne du service depuis le menu patron.",
  },
};
const LIVE_TAG = { cls: "on", label: "En service", why: undefined };
const UNKNOWN_TAG = {
  cls: "q",
  label: "Inconnu",
  why: "Aucun motif n'a été enregistré pour cette fin de service.",
};

function reasonTag(endedReason: string | null, isOpen: boolean): { cls: string; label: string; why?: string } {
  if (isOpen) return LIVE_TAG;
  if (endedReason && REASON_TAG[endedReason]) return REASON_TAG[endedReason]!;
  return UNKNOWN_TAG;
}

/** La légende, montrée quand la période est vide: c'est là que la place existe, et c'est là qu'on se
 *  demande ce que veulent dire les étiquettes qu'on verra ailleurs. */
const LEGEND: { cls: string; label: string }[] = [
  { cls: "on", label: "En service" },
  { cls: "q", label: "Fin de service" },
  { cls: "q", label: "Déconnexion" },
  { cls: "warn", label: "Inactivité" },
  { cls: "bad", label: "Plantage" },
];

// ---------------------------------------------------------------- copie longue
// Sortie du JSX: une phrase française est pleine d'apostrophes, et les échapper une par une dans le
// balisage rend le texte illisible à la relecture, donc facile à casser sans s'en rendre compte.
const COPY = {
  sub: "Qui travaille, quand, et combien d'heures",
  openShift:
    "Service en cours: le jeu en est le seul écrivain, une correction serait réécrite au heartbeat suivant. Le formulaire s'ouvre dès la fin du service.",
  emptyDay: "Personne n'a pointé ce jour-là.",
  emptyWeek: "Aucun pointage sur cette semaine.",
  noEmployees: "Personne ne porte ce métier en jeu.",
  legendIntro: "Choisissez un pointage dans le journal pour voir son motif et corriger ses heures.",
  noDuty: "Personne n'est en service.",
  autoRefresh: "Recompté chaque minute",
  invalidDates: "Renseignez le jour et l'heure, pour la prise comme pour la fin de service.",
  inverted: "L'heure de fin doit être après l'heure de début.",
  corrected: "Pointage corrigé.",
  chartDay: "Heures travaillées par jour, empilées par employé.",
  chartHour: "Heures travaillées par tranche horaire, cumulées sur les sept jours.",
  ribbonHint: "Un couloir par employé. Survolez une marque pour la lire, cliquez pour la corriger.",
  noPunchSelected: "Aucun pointage sélectionné",
  scopeWeek: "Semaine",
};

// ---------------------------------------------------------------- géométrie du ruban

type Tick = { ms: number; label: string };
type Lane = {
  identifier: string;
  name: string;
  tone: number;
  seconds: number;
  live: boolean;
  former: boolean;
  shifts: PointageShift[];
};

/**
 * LA FENÊTRE D'UNE JOURNÉE.
 *
 * On entoure l'activité réelle d'une marge SYMÉTRIQUE, et si la fenêtre reste trop étroite on
 * l'élargit AUTOUR DE SON MILIEU. L'activité est donc toujours centrée et occupe environ 88 pour
 * cent de la piste, quelle que soit sa durée.
 *
 * ⚠ Un plancher ancré sur UNE borne n'est pas un plancher, c'est un décalage: la toute première
 * version arrondissait le début à l'heure inférieure puis imposait six heures À PARTIR DE CE DÉBUT,
 * ce qui laissait les deux tiers droits morts sur une courte nuit.
 *
 * ⚠ Les bornes ne sont PAS arrondies sur une graduation: l'arrondi sur un pas grossier réinjecte la
 * marge morte qu'on vient d'enlever (un axe de 8 h gradué aux 2 h se faisait arrondir à 12 h). Les
 * graduations tombent donc sur des heures rondes À L'INTÉRIEUR de la fenêtre.
 *
 * ⚠⚠ CE ZOOM N'EST PAS LA RÉPONSE AU PROBLÈME DE VIDE, seulement une aide dans le cas courant. Voir
 * l'en-tête de fichier: sur la donnée réelle mesurée, la fenêtre active fait 21 heures et le vide
 * est ENTRE les pointages. Ce qui règle le vide, c'est la HAUTEUR du ruban et le graphique.
 */
const PAD_RATIO = 0.06;
const PAD_MIN_MS = 15 * MIN_MS;
/** Sous cette amplitude, un unique service court occuperait toute la piste et paraîtrait interminable. */
const MIN_SPAN_MS = 90 * MIN_MS;
/** Les pas de graduation admissibles, en minutes. */
const STEPS_MIN = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

/** Largeur estimée d'une étiquette d'heure ("18:00") plus sa respiration, en pixels. Sert à choisir
 *  le pas de graduation à partir de la largeur RÉELLE de la piste plutôt que d'un palier CSS: une
 *  graduation qui disparaît à 519px et revient à 521px est un axe qui ne veut pas dire la même chose
 *  selon la fenêtre. */
const TICK_LABEL_PX = 58;
const MAX_TICK_GAPS = 8;
const MIN_TICK_GAPS = 2;

function dayWindow(minMs: number, maxMs: number, trackPx: number): { from: number; to: number; stepMs: number } {
  const span = Math.max(maxMs - minMs, 0);
  const pad = Math.max(PAD_MIN_MS, span * PAD_RATIO);
  let from = minMs - pad;
  let to = maxMs + pad;
  if (to - from < MIN_SPAN_MS) {
    const mid = (minMs + maxMs) / 2;
    from = mid - MIN_SPAN_MS / 2;
    to = mid + MIN_SPAN_MS / 2;
  }
  const total = to - from;
  const gaps = Math.max(MIN_TICK_GAPS, Math.min(MAX_TICK_GAPS, Math.floor(trackPx / TICK_LABEL_PX)));
  const stepMin = STEPS_MIN.find((x) => total / (x * MIN_MS) <= gaps) ?? 1440;
  return { from, to, stepMs: stepMin * MIN_MS };
}

/**
 * Les graduations INTÉRIEURES à la fenêtre, sur des heures rondes.
 *
 * ⚠ L'alignement se fait sur l'heure UTC, ce qui revient au même que l'heure murale de Toronto parce
 * que l'écart EST/EDT est un nombre ENTIER d'heures (et les pas sous l'heure divisent l'heure). Cela
 * ne serait pas vrai partout, Terre-Neuve est à la demi-heure, et ce fichier n'a qu'un fuseau à servir.
 */
function innerTicks(from: number, to: number, stepMs: number): Tick[] {
  const out: Tick[] = [];
  for (let ms = Math.ceil(from / stepMs) * stepMs; ms <= to; ms += stepMs) {
    out.push({ ms, label: formatTime(ms) });
  }
  return out;
}

function pctOf(ms: number, from: number, to: number): number {
  const span = Math.max(to - from, 1);
  return Math.min(100, Math.max(0, ((ms - from) / span) * 100));
}

/**
 * LES COULOIRS DU RUBAN: UN PAR EMPLOYÉ, Y COMPRIS CEUX QUI N'ONT PAS POINTÉ.
 *
 * ⚠⚠ `seed` EST L'EFFECTIF, ET C'EST LUI QUI CRÉE LES COULOIRS VIDES. Cette fonction ne groupait que
 * des pointages, donc elle ne pouvait produire de couloir que pour quelqu'un qui en avait un: un
 * employé absent de la période n'avait pas de ligne, et le ruban répondait "je ne sais pas" là où un
 * gérant lit "personne n'est venu". Un couloir NOMMÉ ET VIDE est une réponse; une ligne manquante
 * n'en est pas une. C'est la même correction que `mergeTotals`, appliquée à l'autre surface.
 *
 * L'ordre de sortie est celui d'arrivée dans la Map (pointages d'abord, puis l'effectif restant);
 * l'appelant le retrie selon la portée, jour ou semaine.
 */
function groupLanes(
  rows: PointageShift[],
  toneOf: (id: string) => number,
  liveIds: Set<number>,
  seed: TotalsRow[],
): Lane[] {
  const by = new Map<string, Lane>();
  const make = (identifier: string, name: string, former: boolean): Lane => {
    const lane: Lane = {
      identifier,
      name,
      tone: toneOf(identifier),
      seconds: 0,
      live: false,
      former,
      shifts: [],
    };
    by.set(identifier, lane);
    return lane;
  };

  const known = new Map(seed.map((t) => [t.identifier, t]));
  for (const r of rows) {
    // Le nom de l'effectif l'emporte sur la copie datée portée par la ligne de pointage.
    const lane = by.get(r.identifier) ?? make(r.identifier, known.get(r.identifier)?.name ?? r.name, known.get(r.identifier)?.former ?? true);
    lane.seconds += r.seconds;
    if (liveIds.has(r.id)) lane.live = true;
    lane.shifts.push(r);
  }
  for (const t of seed) if (!by.has(t.identifier)) make(t.identifier, t.name, t.former);
  for (const lane of by.values()) lane.shifts.sort((a, b) => a.startMs - b.startMs);
  return Array.from(by.values());
}

/**
 * LA MISE EN PLACE DES MARQUES D'UN COULOIR, EN PIXELS MESURÉS.
 *
 * ⚠⚠ C'EST LE COEUR DE LA CORRECTION DU "SLIVER". Un pointage de 8 secondes sur une fenêtre de 21
 * heures vaut 0,01 pour cent de la piste, soit un dixième de pixel: en pourcentage pur il est
 * invisible, et deux pointages séparés de 43 secondes se superposent exactement. Trois règles, dans
 * cet ordre:
 *   1. LARGEUR PLANCHER (`MARK_MIN_PX`): une marque est toujours cliquable et toujours visible.
 *   2. DÉCALAGE ANTI-COLLISION: si la marque suivante commencerait avant la fin de la précédente
 *      (une fois le plancher appliqué), on la pousse. La position est alors légèrement inexacte, ce
 *      qui est le compromis normal de tout diagramme de Gantt et infiniment préférable à deux
 *      marques fondues en une tache illisible.
 *   3. AUCUN TEXTE DANS UNE MARQUE. L'heure de prise s'écrivait dedans; à 5px de large l'étiquette
 *      était plus large que sa marque et débordait sur la voisine. Elle vit dans l'infobulle native
 *      et dans le journal, qui sont faits pour du texte.
 *
 * Le calcul a besoin de la largeur RÉELLE de la piste, d'où la mesure par `ResizeObserver` plus haut.
 * Avant la première mesure on travaille sur `FALLBACK_TRACK_PX`, valeur identique côté serveur et
 * côté navigateur: l'hydratation ne peut donc pas diverger.
 */
const MARK_MIN_PX = 5;
const MARK_GAP_PX = 2;
const FALLBACK_TRACK_PX = 720;

type Mark = { shift: PointageShift; left: number; width: number };

function layoutMarks(shifts: PointageShift[], from: number, to: number, trackPx: number): Mark[] {
  const span = Math.max(to - from, 1);
  const width = Math.max(trackPx, MARK_MIN_PX * 2);
  const out: Mark[] = [];
  let cursor = -Infinity;
  for (const shift of shifts) {
    const rawLeft = ((shift.startMs - from) / span) * width;
    const rawRight = ((shift.effectiveEndMs - from) / span) * width;
    const clampedLeft = Math.min(Math.max(rawLeft, 0), width);
    const clampedRight = Math.min(Math.max(rawRight, 0), width);
    const w = Math.max(clampedRight - clampedLeft, MARK_MIN_PX);
    let left = Math.max(clampedLeft, cursor);
    if (left + w > width) left = Math.max(0, width - w);
    out.push({ shift, left, width: w });
    cursor = left + w + MARK_GAP_PX;
  }
  return out;
}

// ---------------------------------------------------------------- animation
//
// ⚠⚠ AUCUNE BIBLIOTHÈQUE D'ANIMATION N'EST AJOUTÉE ICI, PAR CONSIGNE EXPLICITE DU PROPRIÉTAIRE:
// tout ce qui bouge sur cette page est soit une transition/keyframe CSS ordinaire, soit ce hook,
// écrit à la main, sans dépendance.
//
// COMPTE JUSQU'À `target` plutôt que de l'afficher d'un coup: une seule boucle
// `requestAnimationFrame`, une courbe ease-out cubique, rien d'autre. Anime au premier montage
// (0 vers la valeur du jour) ET à chaque changement de `target`, depuis la VALEUR PRÉCÉDENTE, jamais
// depuis zéro sur un changement: repartir de zéro à chaque bascule ferait clignoter la page plutôt
// que de montrer un écart.
//
// ⚠ RESPECTE `prefers-reduced-motion` en plus de la règle globale de `globals.css`: cette dernière
// écrase les transitions/keyframes CSS, pas une boucle `requestAnimationFrame` JS.
//
// ⚠ 420ms, pas 700: consigne "Shopify-grade" du propriétaire, précis et immédiat plutôt que
// spectaculaire, et cette page anime plusieurs chiffres à la fois.
function useCountUp(target: number, durationMs = 420): number {
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
 * LA MÊME VALEUR TANT QUE SON CONTENU N'A PAS CHANGÉ.
 *
 * ⚠ Existe pour UNE raison précise: Recharts rejoue son animation d'entrée quand l'IDENTITÉ du
 * tableau `data` change, pas quand son contenu change. Or `router.refresh()` s'exécute chaque minute
 * et reconstruit des propriétés neuves même quand la base n'a pas bougé, donc un `useMemo` ordinaire
 * rend un tableau neuf et le graphique se redessinerait de zéro toutes les minutes, sous les yeux de
 * quelqu'un en train de le lire. En comparant le CONTENU on garde l'animation là où elle a du sens
 * (arrivée, changement de vue, vraie donnée neuve) et nulle part ailleurs.
 */
function useStableData<T>(value: T): T {
  const ref = useRef<{ json: string; v: T } | null>(null);
  const json = JSON.stringify(value);
  if (ref.current === null || ref.current.json !== json) ref.current = { json, v: value };
  return ref.current.v;
}

/**
 * La largeur d'un élément, mesurée et tenue à jour. Rend 0 avant la première mesure, ce qui est le
 * signal "utilise le repli" pour l'appelant, et c'est aussi ce que rend le serveur: l'hydratation ne
 * peut donc pas diverger.
 *
 * ⚠⚠ UNE RÉFÉRENCE-FONCTION, PAS UN `useRef` + `useEffect([])`, ET DEUX BUGS MESURÉS L'IMPOSENT.
 * La piste observée vit sous un `key={activeScope}`, donc changer de portée REMONTE le noeud. Avec
 * un effet à dépendances vides: (1) l'observateur reste accroché à l'ancien noeud, détaché, et ne
 * mesure plus jamais le nouveau; (2) pire, `ResizeObserver` notifie un détachement comme une taille
 * de 0, donc la largeur retombait à 0 et tout le ruban repassait sur `FALLBACK_TRACK_PX`. Constaté
 * dans le banc d'essai le 2026-08-09: en portée Semaine à 375px, les marques étaient posées sur une
 * piste imaginaire de 720px et sortaient de l'écran. Une référence-fonction se rejoue à chaque
 * changement de noeud, et une mesure nulle est ignorée plutôt que crue.
 */
function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const first = node.getBoundingClientRect().width;
    if (first > 0) setWidth(first);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w <= 0) return;
      setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    });
    ro.observe(node);
    observer.current = ro;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

// ---------------------------------------------------------------- le graphique

/**
 * CHAQUE EMPLOYÉ EST UNE SÉRIE, ET SA TEINTE EST CELLE DE SON COULOIR DANS LE RUBAN.
 *
 * ⚠ Une première version nommait les quatre plus présents et cumulait le reste dans une série
 * "Autres" en `--chart-5` (un neutre translucide). Vérifié dans le banc d'essai avec huit employés
 * d'un bar: les quatre anonymes pesaient la moitié de chaque barre, donc la moitié du graphique était
 * un aplat gris qui ne disait rien, et la seule chose qu'on lisait de loin était "il manque des
 * gens". Le cumul rend service quand la queue est petite; ici elle ne l'est jamais, parce qu'un
 * commerce fait tourner son équipe.
 *
 * La teinte suit donc `(index dans totals) % 4`, EXACTEMENT la règle de `toneOf`: le même employé
 * porte la même couleur dans le graphique, dans son couloir du ruban, sur sa pastille de journal et
 * sur sa jauge d'heures. La couleur n'IDENTIFIE pas la personne (quatre tons pour N employés, son nom
 * est écrit à côté), elle sépare deux voisins, et deux séries consécutives ne peuvent jamais tomber
 * sur le même ton, donc deux segments empilés ne fusionnent jamais.
 */
const MAX_LEGEND_SERIES = 5;

type SeriesDef = { key: string; label: string; color: string };

/**
 * LE GRAPHIQUE DE LA PAGE, en deux vues, à la norme des maquettes shadcn officielles que le
 * propriétaire a données comme barème: `<Card>` + `<CardHeader>` + `<Select>` dans l'en-tête,
 * `<CartesianGrid vertical={false}>`, `<XAxis tickFormatter>`, `<ChartTooltip indicator="dot">` avec
 * `labelFormatter`, `<defs><linearGradient>` pour l'aire, `<ChartLegend>`.
 *
 * ⚠ `type="monotone"` ET SURTOUT PAS `"natural"`. Une heure travaillée ne descend jamais sous zéro,
 * mais une spline "natural" dépasse ses points de passage pour rester lisse: une tranche horaire à 0
 * coincée entre deux tranches actives creusait une aire visible SOUS l'axe, ce qui se lit comme des
 * heures négatives. Le cas s'est produit pour de vrai sur `mes-ventes` le 2026-08-09 et le
 * propriétaire l'a vu. `monotone` ne dépasse jamais le minimum ou le maximum local.
 *
 * ⚠ LES DEUX VUES NE SONT PAS LA MÊME DONNÉE PRÉSENTÉE DEUX FOIS. "Par jour" répond à "combien, et
 * qui", "Par heure" répond à "quand", qui est exactement la question à laquelle la frise continue
 * répondait mal. Elles n'ont ni le même axe, ni le même agrégat, ni la même primitive.
 */
function WorkChart({
  mode,
  dayData,
  hourData,
  series,
}: {
  mode: "jour" | "heure";
  dayData: Record<string, string | number | boolean>[];
  hourData: { hour: number; heures: number }[];
  series: SeriesDef[];
}) {
  const gradientId = useId();

  const dayConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    for (const x of series) cfg[x.key] = { label: x.label, color: x.color };
    return cfg;
  }, [series]);

  const hourConfig = useMemo<ChartConfig>(
    () => ({ heures: { label: "Heures travaillées", color: "var(--chart-1)" } }),
    [],
  );

  // Une valeur de graphique est en HEURES DÉCIMALES (l'axe doit pouvoir s'échelonner); l'infobulle,
  // elle, se lit en heures et minutes comme partout ailleurs sur la page.
  const valueRow = (label: string, colorVar: string, hours: number) => (
    <div className={s.ttRow}>
      <span className={s.ttName}>
        <span className={s.ttDot} style={{ background: colorVar }} />
        {label}
      </span>
      <span className={s.ttVal}>{formatDurationHM(hours * 3600)}</span>
    </div>
  );

  if (mode === "heure") {
    return (
      <ChartContainer config={hourConfig} className={cn("aspect-auto", s.chartBox)}>
        <AreaChart data={hourData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-heures)" stopOpacity={0.75} />
              <stop offset="95%" stopColor="var(--color-heures)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="hour"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
            tickFormatter={(v: number) => `${String(v).padStart(2, "0")}h`}
          />
          <YAxis hide domain={[0, "dataMax"]} />
          <ChartTooltip
            cursor={{ stroke: "var(--color-heures)", strokeDasharray: "3 3" }}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(_v, payload) => {
                  const h = Number(payload?.[0]?.payload?.hour ?? 0);
                  return `${String(h).padStart(2, "0")}h00 à ${String((h + 1) % 24).padStart(2, "0")}h00`;
                }}
                formatter={(value) => valueRow("Heures travaillées", "var(--color-heures)", Number(value))}
              />
            }
          />
          <Area
            dataKey="heures"
            type="monotone"
            stroke="var(--color-heures)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            animationDuration={520}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  const keys = series.map((x) => x.key);

  return (
    <ChartContainer config={dayConfig} className={cn("aspect-auto", s.chartBox)}>
      <BarChart data={dayData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} barCategoryGap="26%">
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: string) => v}
        />
        <YAxis hide domain={[0, "dataMax"]} />
        <ChartTooltip
          cursor={{ fill: "var(--accent)" }}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(value) => String(value)}
              formatter={(value, name) => {
                const key = String(name);
                const label = series.find((x) => x.key === key)?.label ?? key;
                return valueRow(label, `var(--color-${key})`, Number(value));
              }}
            />
          }
        />
        {/* La légende n'est utile que si elle tient sur une ligne et si chaque teinte y est unique.
            Au-delà, elle mange la carte et affiche deux fois la même pastille (quatre tons, N
            employés): le nom se lit alors dans l'infobulle et dans le ruban, qui portent les mêmes
            teintes. */}
        {keys.length > 1 && keys.length <= MAX_LEGEND_SERIES ? (
          <ChartLegend content={<ChartLegendContent />} />
        ) : null}
        {keys.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="h"
            fill={`var(--color-${k})`}
            // Seul le sommet de la pile est arrondi: arrondir chaque segment fendrait la barre en
            // tranches qui ne se touchent plus, ce qui se lit comme des valeurs séparées.
            radius={i === keys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
            animationDuration={520}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------- le ruban

/**
 * UN COULOIR DU RUBAN. Composant à part pour appeler `useCountUp` sur sa propre somme: les Rules of
 * Hooks interdisent un hook à l'intérieur d'un `.map()`.
 *
 * ⚠ `--i` (l'ordre de rendu, plafonné) pose LE SEUL délai d'entrée: les marques qu'il contient
 * n'en posent pas de second, elles HÉRITENT `--i` de ce couloir via l'héritage normal des propriétés
 * personnalisées CSS. Un couloir qui se révèle dessine donc ses marques au même instant.
 */
function RibbonLane({
  lane,
  index,
  marks,
  rules,
  selectedId,
  onPick,
}: {
  lane: Lane;
  index: number;
  marks: Mark[];
  /** Les graduations, en pourcentage de la piste. Dessinees DANS chaque couloir plutot qu'en un seul
   *  calque pose par-dessus le ruban: un calque devrait retrouver a quel pixel commence la piste, ce
   *  qui depend de la largeur de la gouttiere, qui change avec le palier adaptatif. Une graduation
   *  posee dans la piste elle-meme est juste par construction, a toutes les largeurs. */
  rules: number[];
  selectedId: number | null;
  onPick: (id: number) => void;
}) {
  const seconds = useCountUp(lane.seconds);
  return (
    <div
      className={cn(s.ribRow, s.cascade, lane.former ? s.former : "")}
      style={{ ...toneVars(lane.tone), "--i": Math.min(index, 14) } as React.CSSProperties}
    >
      <div className={s.ribGutter}>
        <span className={s.ribWho}>
          {lane.live ? <i className={cn(s.ribLive, s.pulse)} aria-hidden="true" /> : null}
          <span className={s.ribName}>{lane.name}</span>
          {lane.former ? <FormerTag /> : null}
        </span>
        {/* ⚠ "0 h 00" EST ÉCRIT, pas remplacé par un tiret. Un couloir sans marque veut dire que
            cette personne n'a pas pointé, et le zéro le dit sans ambiguïté; c'est l'inverse de la
            puce de jour plus bas, qui met un tiret parce que sept zéros alignés au même corps
            noyaient les deux jours qui portaient une vraie valeur. */}
        <span className={s.ribSum}>{formatDurationHM(seconds)}</span>
      </div>
      <div className={s.ribTrack}>
        {rules.map((p) => (
          <i key={p} className={s.ribRule} style={{ left: `${p}%` }} aria-hidden="true" />
        ))}
        {marks.map((m) => {
          const sh = m.shift;
          const open = sh.endedAtMs === null;
          const tag = reasonTag(sh.endedReason, open);
          return (
            <button
              key={sh.id}
              type="button"
              className={cn(s.mark, open ? s.markOpen : "", selectedId === sh.id ? s.markSel : "")}
              style={{ left: `${m.left}px`, width: `${m.width}px` }}
              aria-pressed={selectedId === sh.id}
              title={`${lane.name}, ${formatTime(sh.startMs)} à ${open ? "en cours" : formatTime(sh.effectiveEndMs)}, ${formatDurationHM(sh.seconds)}, ${tag.label}`}
              onClick={() => onPick(sh.id)}
            >
              <span className={s.srOnly}>
                {lane.name} {formatTime(sh.startMs)} {formatDurationHM(sh.seconds)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Une personne actuellement pointée, dans la colonne latérale. `useCountUp` sur sa propre durée
 *  pour la même raison que `RibbonLane`. Cette durée est la seule de la page qui progresse RÉELLEMENT
 *  d'un rafraîchissement au suivant (le serveur la recompte toutes les `AUTO_REFRESH_MS`), donc le
 *  compte animé n'y est pas un simple effet de révélation: il montre le temps qui avance. */
function DutyRow({ r, index }: { r: OnDutyRow; index: number }) {
  const seconds = useCountUp(r.seconds);
  return (
    <Item
      variant="outline"
      size="sm"
      role="listitem"
      className={cn(s.rad, s.lineBorder, s.cascade)}
      style={{ "--i": Math.min(index, 14) } as React.CSSProperties}
    >
      <ItemContent>
        <ItemTitle>{r.name}</ItemTitle>
        <ItemDescription className="text-[11px]">
          depuis <span className="mono">{formatTime(r.startMs)}</span>
        </ItemDescription>
      </ItemContent>
      <div className={s.liveDur}>{formatDurationHM(seconds)}</div>
    </Item>
  );
}

/**
 * Une ligne "heures par employé". `useCountUp` sur les DEUX durées affichées en texte, mais PAS sur
 * la valeur qui pilote `<Progress>`: cette dernière transitionne déjà toute seule via son propre
 * `transition-all`, et lui passer la valeur interpolée aurait fait courir deux animations
 * indépendantes après la même cible. Le texte compte, la barre glisse.
 */
function TotalsRowCard({
  t,
  tone,
  index,
  maxWeekSeconds,
  period,
}: {
  t: TotalsRow;
  tone: number;
  index: number;
  maxWeekSeconds: number;
  period: "cur" | "prev";
}) {
  const weekSeconds = useCountUp(t.weekSeconds);
  const daySeconds = useCountUp(t.daySeconds);
  return (
    <div
      className={cn(s.tot, s.cascade, t.former ? s.former : "")}
      style={{ ...toneVars(tone), "--i": Math.min(index, 14) } as React.CSSProperties}
    >
      <div className={s.totTop}>
        <span className={s.totWho}>
          <span className={s.totName}>{t.name}</span>
          {t.former ? <FormerTag /> : null}
        </span>
        <span className={s.totBig}>{formatDurationDecimal(weekSeconds)}</span>
      </div>
      <Progress
        value={maxWeekSeconds > 0 ? Math.max((t.weekSeconds / maxWeekSeconds) * 100, 1.5) : 0}
        className={s.totTrack}
      />
      <div className={s.totMeta}>
        {/* ⚠ "aucun service" ÉCRIT EN TOUTES LETTRES. Depuis que l'effectif est affiché, une ligne à
            zéro est un cas ORDINAIRE, et "0 service" au milieu d'une liste de vraies valeurs se lit
            comme une donnée manquante plutôt que comme une absence constatée. */}
        {t.weekShifts === 0 ? "aucun service" : `${t.weekShifts} service${t.weekShifts > 1 ? "s" : ""}`}
        {period === "cur" && t.daySeconds > 0 ? (
          <>
            {" · aujourd'hui "}
            <b>{formatDurationDecimal(daySeconds)}</b>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Une cellule du bandeau de chiffres. Le formateur est passé en propriété (fonction de module, donc
 *  référence stable) pour que la cellule ne connaisse ni les durées ni les effectifs. */
function Figure({
  k,
  value,
  format,
  lead,
  live,
}: {
  k: string;
  value: number;
  format: (n: number) => string;
  lead?: boolean;
  live?: boolean;
}) {
  const shown = useCountUp(value);
  return (
    <div className={s.figCell}>
      <div className={cn("cap", s.figK)}>{k}</div>
      <div className={cn(s.figV, lead ? s.figLead : "")}>
        {live ? <i className={cn(s.figDot, value > 0 ? s.pulse : s.figDotOff)} aria-hidden="true" /> : null}
        {format(shown)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- la page

export default function PointageView(props: Props) {
  if (!props.canRead) {
    return (
      <>
        <div className="head">
          <h1>Pointage</h1>
          <span className="sub">{COPY.sub}</span>
        </div>
        <Empty className={BOX}>
          <EmptyHeader>
            <EmptyTitle>Accès verrouillé</EmptyTitle>
            <EmptyDescription>{props.readReason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }
  return <Pointage {...props} />;
}

function Pointage({
  slug,
  canEdit,
  editReason,
  period,
  days,
  defaultDayKey,
  weekFromMs,
  weekToMs,
  onDuty,
  totals,
  shifts,
  figures,
}: ReadyProps) {
  const router = useRouter();
  const [chartMode, setChartMode] = useState<"jour" | "heure">("jour");
  const [scope, setScope] = useState<string>(defaultDayKey);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [trackRef, trackWidth] = useElementWidth<HTMLDivElement>();

  // ⚠ Le rafraîchissement se met en pause pendant un enregistrement: relire le serveur au milieu
  // d'une écriture ferait clignoter la fiche entre l'ancienne et la nouvelle valeur.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!busyRef.current) router.refresh();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [router]);

  const periodLabel = period === "prev" ? "semaine dernière" : "semaine en cours";

  /**
   * Le ton d'un employé, stable d'une vue à l'autre. L'indice boucle sur quatre, comme un rayon de
   * la caisse: un cinquième employé reprend le ton 1 plutôt que d'inventer une couleur. La couleur
   * n'IDENTIFIE pas la personne (son nom est écrit à côté), elle sépare deux couloirs voisins.
   */
  const toneOf = useMemo(() => {
    const m = new Map<string, number>();
    totals.forEach((t, i) => m.set(t.identifier, (i % 4) + 1));
    let next = totals.length;
    return (id: string) => {
      const known = m.get(id);
      if (known !== undefined) return known;
      const tone = (next++ % 4) + 1;
      m.set(id, tone);
      return tone;
    };
  }, [totals]);

  const liveIds = useMemo(() => new Set(onDuty.map((r) => r.id)), [onDuty]);

  /** Les heures travaillées par jour, pour les sept puces. Une somme de `seconds` déjà figés, et le
   *  jour retenu est celui de la PRISE de service, calculé côté serveur. */
  const hoursByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shifts) m.set(r.dayKey, (m.get(r.dayKey) ?? 0) + r.seconds);
    return m;
  }, [shifts]);

  const maxDaySeconds = useMemo(() => {
    let max = 0;
    for (const v of hoursByDay.values()) if (v > max) max = v;
    return max;
  }, [hoursByDay]);

  /**
   * ⚠ LA PORTÉE EST DÉRIVÉE, PAS SEULEMENT MÉMORISÉE. Passer de "semaine en cours" à "semaine
   * dernière" est une navigation (`router.push`) sur la MÊME route: React garde ce composant monté
   * et ne fait que remplacer ses propriétés, donc l'état `scope` continuerait de désigner un jour de
   * l'autre semaine et la page s'afficherait vide, ce qui se lit comme "personne n'a travaillé la
   * semaine dernière". Un `useEffect` de resynchronisation ferait le travail avec un rendu faux au
   * passage; une valeur dérivée n'a jamais l'état faux.
   */
  const activeScope = scope === "week" || days.some((d) => d.key === scope) ? scope : defaultDayKey;
  const isWeekScope = activeScope === "week";

  const visibleRows = useMemo(
    () => (isWeekScope ? shifts : shifts.filter((r) => r.dayKey === activeScope)),
    [isWeekScope, shifts, activeScope],
  );

  // ---- données des graphiques -------------------------------------------------
  //
  // Les quatre employés les plus présents portent leur nom, le reste est cumulé. L'ordre vient de
  // `totals`, déjà trié par le serveur sur les secondes de la semaine.
  /**
   * ⚠ LA CLÉ DE SÉRIE SUIT LA PLACE DANS `totals`, PAS LA PLACE DANS LE GRAPHIQUE. C'est elle qui
   * relie une barre à la couleur du couloir correspondant (`toneOf` boucle sur ce même indice), donc
   * la déduire de l'ordre du graphique ferait changer de couleur les mêmes personnes d'une surface à
   * l'autre.
   */
  const seriesIndex = useMemo(() => {
    const m = new Map<string, string>();
    totals.forEach((t, i) => m.set(t.identifier, `e${i}`));
    return m;
  }, [totals]);

  /**
   * ⚠⚠ SEULS LES EMPLOYÉS QUI ONT POINTÉ SONT DES SÉRIES, DEPUIS QUE `totals` PORTE TOUT L'EFFECTIF.
   * Une barre de zéro heure ne dessine rien, mais elle consomme une des quatre teintes et une entrée
   * de légende: mesuré à 375px, cinq séries dont deux vides poussaient la légende hors de la carte
   * (37px de débordement, l'entrée d'un employé sortant du cadre). Ceux qui n'ont pas pointé sont
   * déjà nommés deux fois en dessous, dans le ruban (un couloir vide) et dans "Heures par employé"
   * (0,0 h, aucun service), qui sont les deux endroits où l'information a un sens.
   *
   * Le classement est celui des HEURES, sans le regroupement actuels-puis-anciens du relevé: comme
   * sur la page Équipe, ce graphique ne parle que de temps travaillé, pas de statut d'emploi.
   */
  const series = useMemo<SeriesDef[]>(
    () =>
      totals
        .filter((t) => t.weekSeconds > 0)
        .sort((a, b) => b.weekSeconds - a.weekSeconds)
        .map((t) => ({
          key: seriesIndex.get(t.identifier) ?? t.identifier,
          // `--chart-N` et `--kN` sont la MÊME couleur (pont shadcn de `lib/business/theme.ts`); on
          // écrit ici la forme shadcn parce que c'est un graphique, et `toneVars` la forme portail
          // parce que c'est un aplat de couloir. La teinte vient de `toneOf`, donc les deux
          // surfaces s'accordent sans table de correspondance à maintenir.
          label: t.name,
          color: `var(--chart-${toneOf(t.identifier)})`,
        })),
    [totals, seriesIndex, toneOf],
  );

  const dayData = useStableData(
    useMemo(() => {
      const byKey = new Map<string, Record<string, string | number | boolean>>();
      const rows = days.map((d) => {
        const row: Record<string, string | number | boolean> = { label: `${d.weekday} ${d.date}` };
        for (const x of series) row[x.key] = 0;
        byKey.set(d.key, row);
        return row;
      });
      // ⚠ Une clé absente de `series` n'est PAS écrite: `series` ne contient que les employés qui
      // ont pointé, donc écrire une clé hors de cette liste poserait une donnée qu'aucune `<Bar>` ne
      // lit et qu'aucune entrée de config ne sait nommer dans l'infobulle.
      const known = new Set(series.map((x) => x.key));
      for (const r of shifts) {
        const row = byKey.get(r.dayKey);
        if (!row) continue;
        const key = seriesIndex.get(r.identifier);
        if (!key || !known.has(key)) continue;
        row[key] = (Number(row[key]) || 0) + r.seconds / 3600;
      }
      return rows;
    }, [days, shifts, series, seriesIndex]),
  );

  /**
   * LES HEURES PAR TRANCHE HORAIRE.
   *
   * Chaque service est découpé sur les frontières d'heure murale de Toronto, donc un service de
   * 23h40 à 00h20 pèse 20 minutes sur la tranche 23h et 20 minutes sur la tranche 00h, jamais 40
   * minutes sur une seule.
   *
   * ⚠ L'écart de fuseau est mesuré UNE FOIS par service, à sa prise. Le seul cas où il change en
   * cours de service est la nuit du passage EST/EDT, où une tranche serait décalée d'une heure sur
   * cet unique service; mesurer l'écart à chaque frontière coûterait un `Intl.DateTimeFormat` par
   * heure de chaque service pour corriger deux nuits par an.
   */
  const hourData = useStableData(
    useMemo(() => {
      const buckets = new Array<number>(24).fill(0);
      // ⚠ `shifts` (la semaine entière) et NON `visibleRows` (la portée choisie plus bas). La carte
      // du graphique est au-dessus du sélecteur de portée: y faire réagir une vue sur deux à un
      // contrôle situé plus bas, pendant que "Par jour" ne bougerait pas, est un piège. Cette carte
      // répond à la PÉRIODE (le sélecteur de l'en-tête de page), le journal répond à la portée.
      for (const r of shifts) {
        const end = r.effectiveEndMs;
        if (end <= r.startMs) continue;
        const offset = torontoOffsetMs(r.startMs);
        let cur = r.startMs;
        // Garde-fou: une ligne aberrante (heartbeat très ancien) ne doit pas boucler indéfiniment.
        for (let guard = 0; guard < 400 && cur < end; guard++) {
          const local = cur + offset;
          const hourStartLocal = Math.floor(local / HOUR_MS) * HOUR_MS;
          const boundary = Math.min(hourStartLocal + HOUR_MS - offset, end);
          const slot = ((Math.floor(hourStartLocal / HOUR_MS) % 24) + 24) % 24;
          buckets[slot] = (buckets[slot] ?? 0) + (boundary - cur) / HOUR_MS;
          cur = boundary;
        }
      }
      return buckets.map((heures, hour) => ({ hour, heures }));
    }, [shifts]),
  );

  // ---- géométrie du ruban -----------------------------------------------------
  const measuredTrack = trackWidth > 0 ? trackWidth : FALLBACK_TRACK_PX;

  const windowMs = useMemo(() => {
    if (isWeekScope) return { from: weekFromMs, to: weekToMs, stepMs: (weekToMs - weekFromMs) / 7 };
    const day = days.find((d) => d.key === activeScope) ?? days[0]!;
    if (visibleRows.length === 0) return { from: day.startMs, to: day.endMs, stepMs: 4 * 60 * MIN_MS };
    let min = Infinity;
    let max = -Infinity;
    for (const r of visibleRows) {
      if (r.startMs < min) min = r.startMs;
      if (r.effectiveEndMs > max) max = r.effectiveEndMs;
    }
    return dayWindow(min, max, measuredTrack);
  }, [isWeekScope, weekFromMs, weekToMs, days, activeScope, visibleRows, measuredTrack]);

  const ticks = useMemo<Tick[]>(() => {
    if (isWeekScope) return days.map((d) => ({ ms: d.startMs, label: d.weekday }));
    return innerTicks(windowMs.from, windowMs.to, windowMs.stepMs);
  }, [isWeekScope, days, windowMs]);

  const rulePcts = useMemo(
    () => ticks.map((t) => pctOf(t.ms, windowMs.from, windowMs.to)),
    [ticks, windowMs],
  );

  /**
   * ⚠ `totals` SERT DE SEMENCE AUX DEUX PORTÉES: il porte désormais TOUT l'effectif, y compris les
   * employés à zéro pointage, donc le ruban montre un couloir nommé et vide pour chacun d'eux. Voir
   * `groupLanes`. C'est la réponse directe au retour du propriétaire ("i still dont see people who
   * have 0 pointage") sur cette page-ci.
   */
  const lanes = useMemo(() => {
    const order = new Map(totals.map((t, i) => [t.identifier, i]));
    if (isWeekScope) {
      return groupLanes(shifts, toneOf, liveIds, totals).sort(
        (a, b) => (order.get(a.identifier) ?? 999) - (order.get(b.identifier) ?? 999),
      );
    }
    /**
     * Portée JOUR: ordre CHRONOLOGIQUE d'ouverture, pas par volume. C'est la lecture qui répond à
     * "qui a ouvert, qui a fermé, qui était seul", et c'est la question qu'on pose à une journée.
     *
     * ⚠ Un couloir SANS pointage ce jour-là n'a pas d'heure d'ouverture, donc rien à comparer: il
     * passe après tous ceux qui en ont un, dans l'ordre de la colonne "Heures par employé". Le
     * ranger à `0` l'aurait envoyé en TÊTE, avant la personne qui a réellement ouvert la journée,
     * et aurait retourné le sens même de ce tri.
     */
    return groupLanes(visibleRows, toneOf, liveIds, totals).sort((a, b) => {
      const sa = a.shifts[0]?.startMs ?? Infinity;
      const sb = b.shifts[0]?.startMs ?? Infinity;
      if (sa !== sb) return sa - sb;
      return (order.get(a.identifier) ?? 999) - (order.get(b.identifier) ?? 999);
    });
  }, [isWeekScope, shifts, visibleRows, totals, toneOf, liveIds]);

  /** Le journal se lit du plus récent au plus ancien: on cherche presque toujours ce qui vient de se
   *  passer. Le ruban, lui, reste chronologique parce qu'il est une ligne de temps. */
  const journal = useMemo(() => [...visibleRows].sort((a, b) => b.startMs - a.startMs), [visibleRows]);

  /**
   * ⚠ UN POINTAGE EST SÉLECTIONNÉ D'OFFICE: le plus récent parmi ceux affichés. La bande de détail
   * porte donc toujours un vrai contenu, et le verrou de correction est visible dès l'arrivée.
   *
   * ⚠ La valeur est DÉRIVÉE des propriétés, jamais posée dans un effet: le rendu du serveur et celui
   * du navigateur doivent produire exactement le même identifiant, sinon l'hydratation diverge sur
   * une page rendue à chaque requête. C'est aussi ce qui fait qu'un changement de portée ou de
   * période retombe tout seul sur un pointage valide.
   */
  const selected = useMemo(() => {
    const picked = pickedId !== null ? visibleRows.find((r) => r.id === pickedId) : undefined;
    if (picked) return picked;
    return journal[0] ?? null;
  }, [pickedId, visibleRows, journal]);

  const maxWeekSeconds = useMemo(() => totals.reduce((acc, t) => Math.max(acc, t.weekSeconds), 0), [totals]);

  const onPending = useCallback((p: boolean) => setBusy(p), []);

  const scopeLabel = isWeekScope
    ? periodLabel
    : (() => {
        const d = days.find((x) => x.key === activeScope);
        return d ? `${d.weekday} ${d.date}` : periodLabel;
      })();

  const windowLabel = isWeekScope
    ? `${days[0]!.weekday} ${days[0]!.date} au ${days[6]!.weekday} ${days[6]!.date}`
    : `${formatTime(windowMs.from)} à ${formatTime(windowMs.to)}`;

  return (
    <>
      <div className="head">
        <h1>Pointage</h1>
        <span className="sub">{COPY.sub}</span>
        <div className="spacer" />
        <Select
          value={period}
          onValueChange={(v) =>
            router.push(`/business/${slug}/gestion/pointage?periode=${v === "prev" ? "prev" : "cur"}`)
          }
        >
          <SelectTrigger size="sm" aria-label="Période" className={cn(s.rad, s.lineBorder, "min-w-[168px] text-[12px]")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={s.rad} align="end">
            <SelectItem value="cur">Semaine en cours</SelectItem>
            <SelectItem value="prev">Semaine dernière</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* LE BANDEAU DE CHIFFRES. Cinq cellules dans UNE carte plutôt que cinq cartes: un chiffre
          agrégé est une ligne de résumé, pas un objet à part entière, et cinq boîtes en tête de page
          était exactement le bruit qui faisait "se sentir perdu". */}
      {/* ⚠ `flex-row flex-wrap` EN CLASSES TAILWIND, pas dans le module: `<Card>` arrive avec
          `flex flex-col`, une classe de module a la meme specificite, et `flex-col` gagnait. Seul
          `cn`/tailwind-merge sait remplacer une utilitaire par une autre du meme groupe. */}
      <Card className={cn(s.figStrip, BOX, "flex-row flex-wrap gap-0 py-0")}>
        <Figure k="En service" value={figures.onDutyCount} format={formatCount} live />
        <Figure k="Aujourd'hui" value={figures.todaySeconds} format={formatDurationDecimal} lead />
        <Figure k={periodLabel} value={figures.weekSeconds} format={formatDurationDecimal} />
        <Figure k="Services" value={figures.weekShiftCount} format={formatCount} />
        <Figure k="Employés" value={figures.employeeCount} format={formatCount} />
      </Card>

      {/* ⚠ DEUX ENFANTS, EN `align-items: stretch`: le graphique et la colonne latérale se terminent
          à la même hauteur par construction, ce qui rend impossible la CLASSE de défaut nommée par le
          propriétaire ("uneven higfhts") plutôt que d'en corriger un cas. */}
      <div className={s.top}>
        <Card className={cn(s.chartCard, BOX, "gap-0 py-0")}>
          {/* ⚠ L'EN-TÊTE EST POSÉ EN FLEX, PAS LAISSÉ À LA GRILLE DE `<CardHeader>`. Mesuré dans le
              banc d'essai le 2026-08-09: avec `<CardAction>`, sa grille
              `has-data-[slot=card-action]:grid-cols-[1fr_auto]` rendait le titre, le sélecteur et la
              description SUR UNE SEULE LIGNE, dans cet ordre, la description finissant collée au
              bord droit derrière le sélecteur. Un titre et sa phrase d'explication doivent rester
              l'un sous l'autre, et le contrôle à droite. Trois enfants en ligne, c'est explicite et
              ça ne dépend d'aucun `:has()`. */}
          <CardHeader
            className={cn(s.lineBorder, "flex flex-row flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3")}
          >
            <div className={s.chartHeadText}>
              <CardTitle className={s.chartTitle}>Temps de travail</CardTitle>
              <CardDescription className={s.chartDesc}>
                {chartMode === "jour" ? COPY.chartDay : COPY.chartHour}
              </CardDescription>
            </div>
            <div className={s.flexGrow} />
            <Select value={chartMode} onValueChange={(v) => setChartMode(v === "heure" ? "heure" : "jour")}>
              <SelectTrigger
                size="sm"
                aria-label="Vue du graphique"
                className={cn(s.rad, s.lineBorder, "min-w-[124px] text-[12px]")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={s.rad} align="end">
                <SelectItem value="jour">Par jour</SelectItem>
                <SelectItem value="heure">Par heure</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          {/* `key` force un remontage à chaque bascule de vue: un changement de propriétés ne rejoue
              jamais une animation d'entrée, un remontage la rejoue à coup sûr. */}
          <div key={chartMode} className={cn(s.chartBody, s.reveal)}>
            {figures.weekShiftCount === 0 ? (
              <Empty className="h-full border-0 py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>Semaine vide</EmptyTitle>
                  <EmptyDescription>{COPY.emptyWeek}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <div className={s.legendTags}>
                    {LEGEND.map((l) => (
                      <ReasonBadge key={l.label} tag={l} />
                    ))}
                  </div>
                </EmptyContent>
              </Empty>
            ) : (
              <WorkChart mode={chartMode} dayData={dayData} hourData={hourData} series={series} />
            )}
          </div>
        </Card>

        <aside className={s.side}>
          <Card className={cn(figures.onDutyCount > 0 ? s.liveOn : "", BOX, "gap-0 py-0")} aria-label="En service maintenant">
            <div className="ph">
              <span className="cap">En service</span>
              <span className={s.muted}>{COPY.autoRefresh}</span>
            </div>
            {onDuty.length === 0 ? (
              <Empty className="border-0 py-5">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Users aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyDescription>{COPY.noDuty}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className={s.liveWrap} role="list">
                {onDuty.map((r, i) => (
                  <DutyRow key={r.id} r={r} index={i} />
                ))}
              </div>
            )}
          </Card>

          <Card className={cn(s.totals, BOX, "gap-0 py-0")}>
            <div className="ph">
              <span className="cap">Heures par employé</span>
              {/* Deux nombres jamais additionnés: l'effectif d'aujourd'hui, et les lignes en plus
                  qui appartiennent à quelqu'un qui est parti. */}
              <span className={s.muted}>
                {figures.employeeCount} employé{figures.employeeCount > 1 ? "s" : ""}
                {figures.formerCount > 0
                  ? ` + ${figures.formerCount} ancien${figures.formerCount > 1 ? "s" : ""}`
                  : ""}
              </span>
            </div>
            {totals.length === 0 ? (
              /* ⚠ Ce vide ne dit plus "semaine vide": l'effectif vient de l'annuaire du jeu, donc une
                 semaine sans heures produit des lignes à zéro, pas une liste vide. La seule façon
                 d'arriver ici est que PERSONNE ne porte ce métier. */
              <Empty className="border-0 py-5">
                <EmptyDescription>{COPY.noEmployees}</EmptyDescription>
              </Empty>
            ) : (
              <div className={s.totWrap}>
                {totals.map((t, i) => (
                  <TotalsRowCard
                    key={t.identifier}
                    t={t}
                    tone={toneOf(t.identifier)}
                    index={i}
                    maxWeekSeconds={maxWeekSeconds}
                    period={period}
                  />
                ))}
              </div>
            )}
          </Card>
        </aside>
      </div>

      {/* `grid` remplace le `flex` de `<Card>`: voir `.journal` dans le module, la piste
          `minmax(0, 1fr)` est ce qui empeche la largeur min-content du tableau de faire deborder la
          page entiere sous 730px. */}
      <Card className={cn(s.journal, BOX, "grid gap-0 py-0")}>
        <div className={s.jHead}>
          <span className="cap">Répartition du temps</span>
          <span className={s.muted}>{scopeLabel}</span>
          <div className={s.flexGrow} />
          <Badge
            variant="outline"
            className={cn(s.rad, s.lineBorder, "px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider")}
            style={REASON_TONE.q}
          >
            {journal.length} pointage{journal.length > 1 ? "s" : ""}
          </Badge>
        </div>

        {/* LE SÉLECTEUR DE PORTÉE. Une seule rangée remplace l'ancien couple "onglets Jour/Semaine" +
            "sept cartes de jour": la puce Semaine EST le mode semaine. Un jour sans pointage n'écrit
            plus de nombre (il disait "0,0 h" au même corps que les jours pleins), il s'atténue et sa
            jauge reste vide. */}
        <div className={s.scope} role="group" aria-label="Portée">
          <button
            type="button"
            className={cn(s.scopeChip, s.scopeWeek)}
            aria-pressed={isWeekScope}
            onClick={() => setScope("week")}
          >
            <span className={s.scopeW}>{COPY.scopeWeek}</span>
            <span className={s.scopeV}>{formatDurationDecimal(figures.weekSeconds)}</span>
            <span className={s.scopeBar} aria-hidden="true">
              <i style={{ width: figures.weekSeconds > 0 ? "100%" : "0%" }} />
            </span>
          </button>
          {days.map((d) => {
            const sec = hoursByDay.get(d.key) ?? 0;
            return (
              <button
                key={d.key}
                type="button"
                className={cn(
                  s.scopeChip,
                  sec === 0 ? s.scopeIdle : "",
                  d.isFuture ? s.scopeFuture : "",
                  d.isToday ? s.scopeToday : "",
                )}
                aria-pressed={activeScope === d.key}
                onClick={() => setScope(d.key)}
              >
                <span className={s.scopeW}>
                  {d.weekday} <em>{d.date}</em>
                </span>
                <span className={s.scopeV}>{sec > 0 ? formatDurationDecimal(sec) : "-"}</span>
                <span className={s.scopeBar} aria-hidden="true">
                  <i style={{ width: maxDaySeconds > 0 ? `${(sec / maxDaySeconds) * 100}%` : "0%" }} />
                </span>
              </button>
            );
          })}
        </div>

        {/* ⚠⚠ `key` FORCE UN VRAI REMONTAGE quand la portée change: un changement de propriétés ne
            rejoue jamais une animation CSS déclenchée au montage. `.reveal` porte le fondu d'ensemble
            ET fait repartir la cascade des couloirs et le dessin des marques. */}
        {/* ⚠ LE VIDE SE MESURE SUR LES POINTAGES, PLUS SUR LES COULOIRS. `lanes` contient maintenant
            tout l'effectif, donc il n'est presque jamais vide et la carte "Journée vide" ne serait
            plus jamais montrée: une journée sans le moindre pointage afficherait un mur de couloirs
            vides, ce qui demande de compter les marques pour comprendre qu'il n'y en a aucune. On
            garde donc les deux lectures à leur place: aucun pointage du tout -> on le dit en une
            phrase; au moins un -> le ruban, avec les absents nommés à côté des présents, qui est
            exactement la comparaison qu'on vient y chercher. */}
        <div key={activeScope} className={s.reveal}>
          {visibleRows.length === 0 ? (
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{isWeekScope ? "Semaine vide" : "Journée vide"}</EmptyTitle>
                <EmptyDescription>{isWeekScope ? COPY.emptyWeek : COPY.emptyDay}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className={s.ribbon}>
                <div className={cn(s.ribRow, s.ribRuler)}>
                  <div className={s.ribGutter} />
                  <div className={s.ribTrack} ref={trackRef}>
                    {ticks.map((t) => {
                      const pct = pctOf(t.ms, windowMs.from, windowMs.to);
                      const shift = pct <= 0.5 ? "0" : pct >= 99.5 ? "-100%" : "-50%";
                      return (
                        <span
                          key={t.ms}
                          className={s.ribTick}
                          style={{ left: `${pct}%`, transform: `translateX(${shift})` }}
                        >
                          {t.label}
                        </span>
                      );
                    })}
                  </div>
                </div>
                {lanes.map((lane, i) => (
                  <RibbonLane
                    key={lane.identifier}
                    lane={lane}
                    index={i}
                    marks={layoutMarks(lane.shifts, windowMs.from, windowMs.to, measuredTrack)}
                    rules={rulePcts}
                    selectedId={selected?.id ?? null}
                    onPick={setPickedId}
                  />
                ))}
                <div className={s.ribFoot}>
                  <span>{COPY.ribbonHint}</span>
                  <span className={s.ribWindow}>{windowLabel}</span>
                </div>
              </div>

              <div className={s.tableWrap}>
                <Table className={s.table}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={s.thGrow}>Employé</TableHead>
                      {isWeekScope ? <TableHead>Jour</TableHead> : null}
                      <TableHead>Prise</TableHead>
                      <TableHead>Fin</TableHead>
                      <TableHead className={s.thRight}>Durée</TableHead>
                      <TableHead>Motif</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journal.map((r, i) => {
                      const open = r.endedAtMs === null;
                      const tag = reasonTag(r.endedReason, open);
                      const day = days.find((d) => d.key === r.dayKey);
                      return (
                        <TableRow
                          key={r.id}
                          data-state={selected?.id === r.id ? "selected" : undefined}
                          className={cn(s.jRow, s.cascade)}
                          style={{ ...toneVars(toneOf(r.identifier)), "--i": Math.min(i, 14) } as React.CSSProperties}
                          onClick={() => setPickedId(r.id)}
                        >
                          <TableCell className={s.jWho}>
                            <i className={s.jDot} aria-hidden="true" />
                            {r.name}
                          </TableCell>
                          {isWeekScope ? (
                            <TableCell className={s.jDim}>{day ? `${day.weekday} ${day.date}` : r.dayKey}</TableCell>
                          ) : null}
                          <TableCell className="mono">{formatTime(r.startMs)}</TableCell>
                          <TableCell className={cn("mono", open ? s.jOpen : "")}>
                            {open ? "en cours" : formatTime(r.effectiveEndMs)}
                          </TableCell>
                          <TableCell className={cn(s.thRight, s.jDur)}>{formatDurationHM(r.seconds)}</TableCell>
                          <TableCell>
                            <ReasonBadge tag={tag} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>

        {/* LA FICHE DE DÉTAIL, DANS le panneau du journal et sous la ligne qu'on vient de cliquer.
            C'était un panneau voisin: à contenu inégal il finissait à une autre hauteur, et vide il
            n'affichait qu'un texte d'attente. Ici il n'y a plus de voisin à égaliser. */}
        <div className={s.strip}>
          {selected === null ? (
            <Empty className="border-0 py-5">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Clock3 aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{COPY.noPunchSelected}</EmptyTitle>
                <EmptyDescription>{COPY.legendIntro}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ShiftDetail
              key={selected.id}
              slug={slug}
              shift={selected}
              days={days}
              canEdit={canEdit}
              editReason={editReason}
              onPending={onPending}
            />
          )}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- fiche + correction

/**
 * LA FICHE D'UN POINTAGE, formulaire de correction compris.
 *
 * ⚠ Le composant est monté avec `key={shift.id}`: changer de ligne le REMONTE, donc les deux champs
 * repartent des valeurs du nouveau pointage. Sans cela, un `useState` initialisé une seule fois
 * garderait les heures du pointage précédent et on enregistrerait des dates prises sur une autre
 * ligne, ce qui est la pire faute possible ici.
 *
 * ⚠ LE VERROU DE CORRECTION S'ÉCRIT CONTRE LE BOUTON QU'IL DÉSACTIVE, et nulle part ailleurs. Un
 * contrôle désactivé se lit comme une panne tant que son motif n'est pas à côté de lui.
 */
function ShiftDetail({
  slug,
  shift,
  days,
  canEdit,
  editReason,
  onPending,
}: {
  slug: string;
  shift: PointageShift;
  days: DayCell[];
  canEdit: boolean;
  editReason: string;
  onPending: (p: boolean) => void;
}) {
  const router = useRouter();
  const open = shift.endedAtMs === null;
  const initialStart = toLocalInputValue(shift.startMs);
  const initialEnd = toLocalInputValue(shift.endedAtMs ?? shift.effectiveEndMs);

  const [startValue, setStartValue] = useState(initialStart);
  const [endValue, setEndValue] = useState(initialEnd);
  const [state, setState] = useState<CorrectShiftState>({ status: "idle" });
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    onPending(pending);
  }, [pending, onPending]);
  // ⚠ Si on clique une autre ligne pendant un enregistrement, ce composant est démonté avec
  // `pending` encore vrai, et le rafraîchissement automatique resterait en pause pour toujours.
  useEffect(() => () => onPending(false), [onPending]);

  const tag = reasonTag(shift.endedReason, open);
  const day = days.find((d) => d.key === shift.dayKey);
  const dayLabel = day ? `${day.weekday} ${day.date}` : shift.dayKey;

  const startMs = fromLocalInputValue(startValue);
  const endMs = fromLocalInputValue(endValue);
  const dirty = startValue !== initialStart || endValue !== initialEnd;
  // ⚠ Cet aperçu porte sur les DEUX VALEURS SAISIES, pas sur le réel: c'est ce qu'on s'apprête à
  // écrire. Il ne répète volontairement AUCUNE borne (la durée maximale vit dans `correctShift`),
  // parce qu'un second nombre à tenir synchronisé avec le premier finit toujours par diverger.
  const previewSeconds = startMs !== null && endMs !== null ? Math.round((endMs - startMs) / 1000) : null;
  const previewInverted = previewSeconds !== null && previewSeconds <= 0;

  function submit() {
    if (pending || !canEdit) return;
    if (startMs === null || endMs === null) {
      setState({ status: "error", message: COPY.invalidDates });
      return;
    }
    if (endMs <= startMs) {
      setState({ status: "error", message: COPY.inverted });
      return;
    }
    startTransition(async () => {
      const res = await correctShiftAction(slug, {
        shiftId: shift.id,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
      });
      setState(res);
      // Recharge depuis le serveur: la ligne corrigée doit être redessinée à partir de ce que la
      // base contient vraiment, jamais rejouée en local à partir de ce qu'on croit avoir envoyé.
      if (res.status === "ok") router.refresh();
    });
  }

  function reset() {
    setStartValue(initialStart);
    setEndValue(initialEnd);
    setState({ status: "idle" });
  }

  return (
    <div className={s.detail}>
      <div className={s.dHead}>
        <div className={s.dIdent}>
          <div className={s.dWho}>{shift.name}</div>
          <div className={s.dWhen}>
            {dayLabel} · <span className="mono">{formatTime(shift.startMs)}</span>
            {" à "}
            <span className="mono">{open ? "en cours" : formatTime(shift.effectiveEndMs)}</span>
          </div>
        </div>
        <ReasonBadge tag={tag} />
        <div className={s.flexGrow} />
        <div className={s.dDur}>
          <div className={cn("cap", s.dDurK)}>Durée retenue</div>
          <div className={s.dBig}>{formatDurationHM(shift.seconds)}</div>
        </div>
      </div>

      {open ? (
        <p className={s.dNote}>{COPY.openShift}</p>
      ) : (
        <>
          {tag.why ? <p className={s.dWhy}>{tag.why}</p> : null}
          <div className={s.formRow}>
            <label className={s.field}>
              <span className={s.fieldK}>Prise de service</span>
              <Input
                type="datetime-local"
                value={startValue}
                disabled={pending || !canEdit}
                onChange={(e) => {
                  setStartValue(e.target.value);
                  setState({ status: "idle" });
                }}
                className={s.fieldInput}
              />
            </label>
            <label className={s.field}>
              <span className={s.fieldK}>Fin de service</span>
              <Input
                type="datetime-local"
                value={endValue}
                disabled={pending || !canEdit}
                onChange={(e) => {
                  setEndValue(e.target.value);
                  setState({ status: "idle" });
                }}
                className={s.fieldInput}
              />
            </label>
            <div className={s.preview}>
              <span className={s.fieldK}>Après correction</span>
              <span className={cn(s.previewV, previewInverted ? s.previewBad : "")}>
                {previewSeconds === null || previewInverted ? "-" : formatDurationHM(previewSeconds)}
              </span>
            </div>
            <div className={s.formActs}>
              <Button variant="ghost" size="sm" onClick={reset} disabled={pending || !dirty}>
                Annuler
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={submit}
                disabled={!canEdit || pending || !dirty || previewInverted}
              >
                {pending ? "Enregistrement" : "Enregistrer"}
              </Button>
            </div>
          </div>

          {/* Un contrôle désactivé sans motif se lit comme une panne. C'est le SEUL endroit où le
              verrou est écrit: il est contre le bouton qu'il désactive. */}
          {!canEdit ? <span className={s.why}>{editReason}</span> : null}
          {previewInverted ? <span className={s.msgErr}>{COPY.inverted}</span> : null}
          {state.status === "error" ? <span className={s.msgErr}>{state.message}</span> : null}
          {state.status === "ok" ? <span className={s.msgOk}>{COPY.corrected}</span> : null}
        </>
      )}
    </div>
  );
}
