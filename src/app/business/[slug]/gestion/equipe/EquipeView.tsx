import Link from "next/link";
import type { RealProfit } from "@/lib/business/realProfit";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { initials, money } from "@/lib/business/theme";
import {
  MAX_SERIES,
  PeriodSelect,
  RhythmAreaChart,
  type DayRow,
  type Series,
} from "./SalesChart";
// `Period` vient de `./periods`, pas de `./SalesChart`: voir l'en-tête de periods.ts (un module
// "use client" ne peut pas servir de point de passage pour ce que le serveur lit aussi).
import { type Period } from "./periods";
import s from "./equipe.module.css";

export type { Period };

export type TeamRow = {
  identifier: string;
  name: string;
  /**
   * Le libellé du grade tel qu'il est écrit en jeu. `null` quand la base n'en connaît AUCUN, ce qui
   * n'arrive qu'à un ancien employé sans pointage: l'annuaire ne le porte plus et aucune ligne de
   * pointage ne porte d'instantané. On n'écrit alors pas de grade du tout, jamais "Grade 0", qui
   * est un vrai rang (Recrue) détenu par de vraies personnes.
   */
  gradeLabel: string | null;
  /**
   * La personne a été active pendant la période mais ne tient plus ce métier dans le jeu.
   *
   * ⚠ SA LIGNE RESTE, ET SES CHIFFRES RESTENT EXACTS. Demande du propriétaire, verbatim: "this
   * should still show data of someone no longer in the job. just grayed out or whatever". Masquer
   * la ligne changerait en silence les totaux de la semaine dernière chaque fois que quelqu'un
   * change de métier, ce qui est la pire des deux erreurs possibles: une vente qui a eu lieu a eu
   * lieu.
   */
  former: boolean;
  sales: number;
  totalCents: number;
  commissionCents: number;
  /** Le benefice mesurable de la periode. Voir `margin_cents` dans le schema: 0 = non mesure. */
  marginCents: number;
  seconds: number;
  /** Le chiffre de la période PRÉCÉDENTE, pour la tendance. `0` veut dire "aucune vente", et c'est
   *  une information en soi: le relevé le dit en toutes lettres plutôt que d'afficher "+100 %". */
  prevTotalCents: number;
  /** Service ouvert et frais EN CE MOMENT: les secondes écoulées depuis la prise, sinon null. */
  onDutySeconds: number | null;
  /** Son chiffre jour par jour, aligné sur `days`. Agrégé en SQL, donc jamais tronqué. */
  days: number[];
};

/**
 * Un jour de la période.
 *
 * `key` est la clé SQL (`YYYY-MM-DD`), `label` l'abscisse, `full` l'intitulé de bulle, `cents` le
 * total de l'équipe ce jour-là. Voir `dayList` dans page.tsx pour pourquoi les trois premiers sont
 * distincts.
 */
export type DayCell = { key: string; label: string; full: string; today: boolean; cents: number };

/** Une vente au fil de l'eau, pour le rail. */
export type FeedRow = { id: number; seller: string; when: string; totalCents: number };

/** Qui est en service en ce moment, pour le rail. */
export type DutyRow = { identifier: string; name: string; seconds: number };

/** La hauteur et la largeur, en pixels de tracé, du mini-graphique d'une ligne de relevé. */
const SPARK_W = 88;
const SPARK_H = 28;
/** Le tracé ne touche jamais le haut de sa boîte: une pointe collée au bord se lit comme coupée. */
const SPARK_HEADROOM = 3;
const SPARK_STROKE = 1.5;
const SPARK_FILL_OPACITY = 0.22;
const SPARK_TODAY_R = 2;

/**
 * "18,5 h" depuis des secondes.
 *
 * `fr-FR` pour la virgule décimale, même convention que `money()` dans theme.ts: la maquette a été
 * validée avec cette locale, pas `fr-CA`.
 */
function hoursLabel(seconds: number): string {
  const hours = seconds / 3600;
  return `${hours.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** Un pourcentage entier, borné à [0, 100]. Sert aussi bien à la largeur d'une jauge qu'au libellé. */
function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * LA TENDANCE D'UN EMPLOYÉ, et pourquoi elle ne se résume pas à un pourcentage.
 *
 * ⚠ Une variation n'a de sens que s'il y avait quelque chose à faire varier. Avec un chiffre
 * précédent nul, tout ratio est une division par zéro déguisée: "+100 %", "nouveau", "infini" sont
 * trois façons différentes d'affirmer ce que la base ne dit pas. Elle ne dit qu'une chose, et c'est
 * celle qu'on écrit: aucune vente la période précédente. Le gérant en tire lui-même la conclusion
 * (embauche récente, absence, retour), qu'aucune de ces trois étiquettes n'aurait su distinguer.
 */
function trendOf(current: number, previous: number): { tone: "up" | "down" | "flat"; label: string } | null {
  if (previous <= 0) return null;
  const delta = Math.round(((current - previous) / previous) * 100);
  if (delta > 0) return { tone: "up", label: `+${delta} %` };
  if (delta < 0) return { tone: "down", label: `${delta} %` };
  return { tone: "flat", label: "0 %" };
}

/** Le rang: rempli à l'accent de l'enseigne pour le premier, contour pour les autres. */
function RankBadge({ index }: { index: number }) {
  return (
    <Badge variant={index === 0 ? "default" : "outline"} className={s.rankBadge}>
      {index + 1}
    </Badge>
  );
}

/** Le compte à rebours de service, réutilisé identique dans le relevé et dans la fiche employé. */
function DutyTag({ seconds }: { seconds: number }) {
  return (
    <span className="tag on" title={`En service depuis ${hoursLabel(seconds)}`}>
      <i />
      En service
    </span>
  );
}

/**
 * L'ÉTIQUETTE D'UN ANCIEN EMPLOYÉ.
 *
 * ⚠ UNE MENTION CALME, PAS UN AVERTISSEMENT. Ce n'est ni une erreur ni un problème: c'est un fait
 * de calendrier, et la ligne le dit une fois, en gris, à côté du nom. Elle emprunte `--muted-text`
 * et `--line` (le jeton "neutre" du portail, celui de `.tag.q`), jamais `--warn` ni `--bad`, qui
 * appellent une action, et jamais un gris en dur, qui ne suivrait pas le thème clair.
 */
function FormerTag() {
  return (
    <span className={`tag q ${s.formerTag}`} title="Ne tient plus ce métier dans le jeu">
      Ancien employé
    </span>
  );
}

/**
 * LE MINI-GRAPHIQUE D'UNE LIGNE DE RELEVÉ.
 *
 * ⚠⚠ DESSINÉ EN SVG À LA MAIN, ET C'EST UNE DÉCISION, PAS UNE FACILITÉ. Les vrais graphiques de ces
 * deux pages sont des composants shadcn/Recharts (`SalesChart.tsx`), et c'est bien la bonne
 * primitive dès qu'un graphique a une bulle, des axes et une légende. Ici il n'a rien de tout ça:
 * c'est une FORME de 88 par 28 pixels dans une cellule de tableau, et le relevé doit rester lisible
 * à trente lignes. Trente `ResponsiveContainer` veulent dire trente `ResizeObserver`, trente
 * balises `<style>` injectées et trente arbres Recharts hydratés pour une décoration de la taille
 * d'un mot. Le composant ci-dessous ne coûte RIEN au navigateur: il est rendu sur le serveur, il
 * n'embarque pas une ligne de JavaScript, et il n'a aucun état à reprendre côté client.
 *
 * ⚠ `scale` EST COMMUNE À TOUTES LES LIGNES, ET C'EST LA PROPRIÉTÉ QUI COMPTE. Une courbe remise à
 * l'échelle de son propre maximum rendrait une journée à 50 $ identique à une journée à 500 $: les
 * trente lignes se ressembleraient toutes et la colonne ne dirait plus rien. Le maximum jour toutes
 * personnes confondues est la seule échelle qui rende deux lignes comparables d'un coup d'oeil.
 * C'est la même règle que portait la prop `scale` de l'ancien graphique de carte, et elle survit
 * intacte au changement de forme.
 *
 * ⚠ POLYLIGNE DROITE, aucune interpolation. Une spline lissée sur 28 pixels de haut invente des
 * creux et des bosses entre deux points, et sur une aire on l'a déjà vue passer sous zéro
 * (voir `RhythmAreaChart`). À cette taille, la ligne brisée est à la fois plus honnête et plus lisible.
 */
function RowSpark({ values, scale, label }: { values: number[]; scale: number; label: string }) {
  const n = values.length;
  const usable = SPARK_H - SPARK_HEADROOM;
  const step = n > 1 ? SPARK_W / (n - 1) : 0;
  const yOf = (v: number) => (scale > 0 ? SPARK_H - (v / scale) * usable : SPARK_H);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const area = n > 1 ? `${SPARK_W},${SPARK_H} 0,${SPARK_H}` : "";

  return (
    <svg
      className={s.spark}
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      role="img"
      aria-label={label}
    >
      {n > 1 ? (
        <polygon points={`${points} ${area}`} fill="var(--chart-1)" fillOpacity={SPARK_FILL_OPACITY} />
      ) : null}
      <polyline
        points={points}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth={SPARK_STROKE}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Le dernier point est marqué, pas coloré différemment: c'est un REPÈRE de lecture ("où en
          est-on"), pas une seconde grandeur mesurée. */}
      {n > 0 ? (
        <circle
          cx={(n - 1) * step}
          cy={yOf(values[n - 1] ?? 0)}
          r={SPARK_TODAY_R}
          fill="var(--chart-1)"
        />
      ) : null}
    </svg>
  );
}

/**
 * ÉQUIPE, côté navigateur.
 *
 * Composant serveur: le seul état de cette page vit dans l'URL (`?p=`), et le sélecteur de période
 * (`PeriodSelect`, le seul îlot client) ne fait que pousser une nouvelle adresse. Aucune écriture
 * ne part d'ici.
 *
 * ⚠⚠ LE TROMBINOSCOPE A DISPARU, ET C'EST LA DEMANDE DU PROPRIÉTAIRE, VERBATIM: "gestion/equipe
 * look how it is. this should just be a list that opens team page", "more mulyi employee proof".
 * La version précédente basculait entre DEUX mises en page - grandes cartes portraits jusqu'à
 * quatre personnes, relevé en tableau au-delà - et il a vu la première avec deux employés: deux
 * blocs énormes et une page vide en dessous. Le défaut n'était pas le dessin des cartes, c'était
 * le BASCULEMENT: une composition réglée pour un effectif est forcément fausse pour tous les
 * autres, et celui de ce serveur en a deux. Il n'y a donc plus qu'UNE forme, un relevé, qui a
 * exactement la même silhouette à un employé qu'à trente - seul le nombre de lignes change, ce qui
 * est le comportement normal d'une liste et n'a besoin d'aucun réglage.
 *
 * ⚠ CE QUI REMPLACE LE CONTENU DES CARTES: leurs chiffres sont devenus des COLONNES (comparables
 * verticalement, ce qu'une grille de cartes ne permet pas), et leur graphique un mini-tracé par
 * ligne à échelle commune. Rien n'a été perdu; tout est devenu comparable.
 *
 * ⚠ AUCUNE COMMANDE DE PAIEMENT, NULLE PART. Le portail CONSTATE ce qui est dû ("Part à verser",
 * "Part due"); il ne verse rien et n'affiche aucun bouton qui pourrait le laisser croire. Le
 * versement se fait en jeu, par l'employeur. Règle du propriétaire, verbatim: "there is and should
 * be no system on the panel to pay people directly."
 */
export default function EquipeView({
  slug,
  name,
  period,
  canRead,
  deniedReason,
  showHours,
  showCommission,
  showMargin,
  realProfit,
  rows,
  days,
  feed,
  duty,
  prevTotalCents,
  currentCount,
  formerCount,
}: {
  slug: string;
  name: string;
  period: Period;
  canRead: boolean;
  deniedReason: string | null;
  showHours: boolean;
  /** Ce commerce connait-il son cout de revient. Voir `templateMeasuresCost`. */
  showCommission: boolean;
  showMargin: boolean;
  /**
   * Le vrai resultat de l'entreprise sur la periode, lu dans le grand livre du jeu. `null` quand ce
   * commerce ne mesure pas de cout, ou quand la lecture a echoue: l'ecran le DIT, il n'affiche
   * jamais 0 a la place.
   */
  realProfit: RealProfit | null;
  rows: TeamRow[];
  days: DayCell[];
  feed: FeedRow[];
  duty: DutyRow[];
  prevTotalCents: number;
  /** L'effectif RÉEL, lu dans l'annuaire du jeu. Jamais `rows.length`, qui compte aussi les anciens. */
  currentCount: number;
  /** Combien de lignes du relevé appartiennent à quelqu'un qui ne tient plus ce métier. */
  formerCount: number;
}) {
  const base = `/business/${slug}/gestion/equipe`;
  const keep = period === "cur" ? "" : `?p=${period}`;

  const totals = rows.reduce(
    (acc, r) => {
      acc.sales += r.sales;
      acc.total += r.totalCents;
      acc.commission += r.commissionCents;
      acc.margin += r.marginCents;
      acc.seconds += r.seconds;
      return acc;
    },
    { sales: 0, total: 0, commission: 0, margin: 0, seconds: 0 },
  );

  // ⚠ Échelle COMMUNE à tous les mini-tracés: voir `RowSpark`. Le maximum jour toutes personnes
  // confondues est la seule échelle qui rende deux lignes comparables entre elles.
  const dayScale = rows.reduce((m, r) => Math.max(m, ...r.days), 0);
  const trend = trendOf(totals.total, prevTotalCents);

  /**
   * LES SÉRIES DE LA COURBE EMPILÉE: les meilleurs vendeurs, puis TOUS LES AUTRES EN UNE SEULE.
   *
   * ⚠ La palette d'une enseigne compte QUATRE tons de rayon plus un neutre (`--chart-1..5`, pont
   * shadcn de theme.ts). Au-delà, il n'existe aucune couleur à distribuer qui appartienne encore à
   * ce commerce, et trente aires empilées seraient de toute façon illisibles. Le reste du
   * classement est donc regroupé dans une série nommée, ce qui garde la courbe EXACTE (la somme des
   * aires reste le chiffre de l'équipe, jamais un sous-ensemble) tout en restant lisible: c'est le
   * même arbitrage que le relevé, qui montre tout le monde en lignes.
   */
  /**
   * ⚠⚠ LE GRAPHIQUE SE CLASSE AU CHIFFRE SEUL, PAS DANS L'ORDRE DU RELEVÉ, ET C'EST NÉCESSAIRE
   * DEPUIS QUE L'EFFECTIF EST AFFICHÉ. Le relevé range les employés actuels avant les anciens, ce
   * qui est la bonne lecture pour une liste d'équipe. Appliqué au graphique, ce même ordre donnait
   * une des quatre couleurs à un employé actuel à 0 $ pendant qu'un ancien qui a réellement vendu
   * pendant la période se retrouvait fondu dans « autres »: le graphique aurait alors classé les
   * gens par leur statut d'emploi, alors qu'il ne parle que d'argent. Une bande à zéro n'occupe
   * aucune place à l'écran, mais elle occupe une COULEUR et une entrée de légende, et il n'y en a
   * que quatre.
   *
   * Les employés à zéro passent donc en dernier et ne prennent une teinte que s'il en reste une,
   * ce qui est le cas courant d'une petite équipe: leur « 0 $ » apparaît alors dans la bulle, où
   * c'est une information utile ("il n'a rien vendu ce jour-là non plus").
   */
  const chartOrder = [...rows].sort(
    (a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name, "fr"),
  );
  const leadCount = Math.min(chartOrder.length, MAX_SERIES - 1);
  const lead = chartOrder.slice(0, leadCount);
  const rest = chartOrder.slice(leadCount);
  const restHasSales = rest.some((r) => r.totalCents > 0);
  const series: Series[] = [];
  // ⚠ LA QUEUE DU CLASSEMENT EN PREMIER, DONC AU FOND DE LA PILE (vérifié en navigateur: Recharts
  // pose la PREMIÈRE aire empilée sur la ligne de base). Mise en dernier, elle recouvrait les
  // quatre meilleurs vendeurs, qui sont pourtant le sujet du graphique. En socle, et à l'encre
  // atténuée, les têtes se détachent dessus. La LÉGENDE, elle, n'annonce pas le même ordre que la
  // pile; c'est un détail de Recharts, pas une information, et la teinte suffit à s'y retrouver.
  if (restHasSales) {
    series.push({
      key: "srest",
      label: `${rest.length} autre${rest.length > 1 ? "s" : ""}`,
      tone: MAX_SERIES,
      muted: true,
    });
  }
  lead.forEach((r, i) => series.push({ key: `s${i}`, label: r.name, tone: i + 1 }));

  const chartRows: DayRow[] = days.map((d, di) => {
    const values: Record<string, number> = {};
    lead.forEach((r, i) => {
      values[`s${i}`] = r.days[di] ?? 0;
    });
    if (restHasSales) values.srest = rest.reduce((acc, r) => acc + (r.days[di] ?? 0), 0);
    return { key: d.key, label: d.label, full: d.full, today: d.today, values };
  });

  // La carte du graphique dit elle-même quelle fenêtre elle couvre: le sélecteur est en tête de
  // page et gouverne tout l'écran, donc la légende sous le titre est ce qui empêche de lire une
  // courbe sans savoir de quand elle date.
  const first = days[0];
  const last = days[days.length - 1];
  const rangeLabel =
    first && last ? `Du ${first.full.toLowerCase()} au ${last.full.toLowerCase()}` : "";

  return (
    <>
      <div className="head">
        <h1>Équipe</h1>
        <span className="sub">{name}</span>
        <div className="spacer" />
        <PeriodSelect base={base} period={period} />
      </div>

      {!canRead ? (
        // TEAM_READ est au palier "ingame": un patron hors ligne échoue légitimement cette porte.
        // On l'explique plutôt que de rendre une page blanche ou un 403, même règle que le rail de
        // navigation pour une entrée bloquée.
        <div className="panel">
          <p className="pick">{deniedReason}</p>
        </div>
      ) : (
        <>
          {/* ⚠ Au moins TROIS figures en toutes circonstances (chiffre, ventes, effectif), les deux
              autres suivant les modules. Une bande pleine largeur qui ne porterait qu'un seul
              chiffre est exactement le "panneau presque vide" que le propriétaire a signalé. */}
          <div className="figs">
            <div className="fig">
              <div className="k">Chiffre d&apos;affaires</div>
              <div className="v lead">{money(totals.total)}</div>
              <div className="m">
                {trend ? (
                  <>
                    <span className={`delta ${trend.tone}`}>{trend.label}</span> vs {money(prevTotalCents)} la
                    période précédente
                  </>
                ) : (
                  "aucune vente la période précédente"
                )}
              </div>
            </div>
            <div className="fig">
              <div className="k">Ventes</div>
              <div className="v num">{totals.sales}</div>
              <div className="m">
                {totals.sales > 0
                  ? `${money(Math.round(totals.total / totals.sales))} en moyenne`
                  : "aucun ticket déclaré"}
              </div>
            </div>
            {/* ⚠ `currentCount` ET NON `rows.length`: le relevé porte aussi les anciens employés, et
                les compter dans l'effectif annoncerait une équipe plus grande qu'elle ne l'est. Ils
                sont mentionnés séparément, à leur juste place. */}
            <div className="fig">
              <div className="k">Effectif</div>
              <div className="v num">{currentCount}</div>
              <div className="m">
                {duty.length > 0 ? `${duty.length} en service maintenant` : "personne en service"}
                {formerCount > 0
                  ? `, ${formerCount} ancien${formerCount > 1 ? "s" : ""} sur la période`
                  : ""}
              </div>
            </div>
            {showHours ? (
              <div className="fig">
                <div className="k">Heures cumulées</div>
                <div className="v">{hoursLabel(totals.seconds)}</div>
                <div className="m">
                  {totals.seconds > 0 && totals.total > 0
                    ? `${money(Math.round(totals.total / (totals.seconds / 3600)))} par heure`
                    : "sur la période"}
                </div>
              </div>
            ) : null}
            {/*
              ⚠ LE BÉNÉFICE AVANT LA PART, et pour la même raison qu'ailleurs: la part est une
              FRACTION du bénéfice, donc la lire sans lui est ce qui rend une paie aberrante
              invisible. `showMargin` est le MODÈLE du commerce, jamais `marginCents > 0`: un
              bénéfice réellement nul chez une concession est une information, un bar n'a
              simplement aucun coût de revient enregistré (voir `templateMeasuresCost`).
            */}
            {/*
              ⚠⚠ CETTE FIGURE LIT LE GRAND LIVRE DU JEU, PAS LES TICKETS DÉCLARÉS, et c'est la
              correction du 2026-08-27. Le bénéfice déclaré vaut 0 chez les deux concessions parce
              que le catalogue leur fait acheter et revendre au même prix, pendant que la caisse
              réelle de PDM bougeait de +106 192 $. Un patron doit lire ce que son entreprise a
              vraiment gagné, pas la somme de ce que ses employés ont saisi. Le bénéfice déclaré
              reste sur la fiche de chaque employé, où il est dit comme tel.
              ⚠ LES INJECTIONS STAFF SONT HORS DU CHIFFRE ET DITES A PART: elles se comptent en
              millions sur ce serveur et les inclure ferait passer deux commerces déficitaires pour
              rentables. Voir realProfit.ts.
            */}
            {showMargin ? (
              <div className="fig">
                <div className="k">Résultat réel</div>
                <div className="v">{realProfit?.hasLedger ? money(realProfit.profitCents) : "-"}</div>
                <div className="m">
                  {!realProfit?.hasLedger
                    ? "compte d'entreprise illisible"
                    : `${money(realProfit.incomeCents)} encaissés, ${money(realProfit.costCents)} dépensés${
                        realProfit.adjustmentCents !== 0
                          ? `, hors ${money(Math.abs(realProfit.adjustmentCents))} d'ajustements staff`
                          : ""
                      }`}
                </div>
              </div>
            ) : null}
            {showMargin && realProfit?.hasLedger ? (
              <div className="fig">
                <div className="k">Trésorerie</div>
                <div className="v">{money(realProfit.balanceCents)}</div>
                <div className="m">
                  {realProfit.blockedCents > 0
                    ? `${money(realProfit.blockedCents)} en plus sur le compte bloqué`
                    : "solde du compte d'entreprise"}
                </div>
              </div>
            ) : null}
            {showCommission ? (
              <div className="fig">
                <div className="k">Part à verser</div>
                <div className="v">{money(totals.commission)}</div>
                {/* Jamais un bouton: le portail constate ce qui est dû, il ne verse rien. */}
                <div className="m">
                  {showMargin && totals.margin > 0
                    ? `due aux employés, ${Math.round((totals.commission / totals.margin) * 100)} % du bénéfice`
                    : "due aux employés, versée en jeu"}
                </div>
              </div>
            ) : null}
          </div>

          {/* LA CHARPENTE: colonne principale plus rail, et les deux colonnes se rejoignent en bas
              par construction (voir `.work` / `.absorb` dans equipe.module.css). */}
          <div className={s.work}>
            <div className={s.wmain}>
              {/* LE GRAPHIQUE DE TÊTE. C'est lui qui ABSORBE le mou de la colonne, et c'est le seul
                  bloc de la page qui s'améliore vraiment en grandissant: une aire de sept à trente
                  points gagne à respirer, là qu'une liste ne gagne rien à écarter ses lignes. */}
              <Card
                className={`${s.chartCard} ${s.chartLead} rounded-[var(--r)] border border-border ring-0`}
              >
                {/* ⚠ `grid-cols-1` EXPLICITE. `CardHeader` déclare une grille dont les colonnes ne
                    sont fixées que par la variante `has-data-[slot=card-action]`; sans action, la
                    colonne implicite se dimensionne sur son contenu et la légende se retrouve À
                    CÔTÉ du titre au lieu de dessous, sur une seule rangée trop courte pour les deux.
                    Mesuré en navigateur, pas déduit. */}
                <CardHeader className="grid-cols-1">
                  <CardTitle>Rythme de l&apos;équipe</CardTitle>
                  <CardDescription>
                    {rangeLabel}
                    {series.length > 1 ? ", par vendeur" : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className={s.chartBody}>
                  {rows.length === 0 ? (
                    <p className="pick">Aucune vente ni pointage sur cette période.</p>
                  ) : (
                    /**
                     * ⚠ `empty` N'EST PAS UNE COQUETTERIE, C'EST LA CORRECTION DU 2026-08-10.
                     * Mesuré au banc d'essai: quand TOUTES les séries valent 0 sur toute la période,
                     * Recharts ne rend NI aire, NI courbe, NI la moindre graduation d'ordonnée. La
                     * carte gardait donc son titre et ses sept jours en abscisse au-dessus d'un
                     * rectangle parfaitement vide, ce qui ne se distingue pas d'un graphique en
                     * panne. Depuis que l'effectif est affiché, ce cas est devenu ORDINAIRE: une
                     * équipe au complet qui n'a rien vendu de la semaine y tombe.
                     */
                    <RhythmAreaChart
                      data={chartRows}
                      series={series}
                      className={`${s.chartFill} aspect-auto h-full w-full`}
                      empty={
                        <p className="pick">
                          Aucune vente sur cette période. L&apos;équipe est listée en dessous.
                        </p>
                      }
                    />
                  )}
                </CardContent>
              </Card>

              <div className={`panel ${s.rosterPanel}`}>
                <div className="ph">
                  <span className="cap">Par employé</span>
                  {/* Deux nombres distincts et jamais additionnés: l'effectif d'aujourd'hui, et le
                      nombre de lignes en plus qui appartiennent à quelqu'un qui est parti. */}
                  <span className="dim">
                    {currentCount === 0 ? "aucun employé" : `${currentCount} employé${currentCount > 1 ? "s" : ""}`}
                    {formerCount > 0 ? ` + ${formerCount} ancien${formerCount > 1 ? "s" : ""}` : ""}
                  </span>
                </div>

                {rows.length === 0 ? (
                  /* ⚠ Ce vide ne veut plus dire "aucune activité", il veut dire "PERSONNE NE TIENT
                     CE MÉTIER". Depuis que l'effectif vient de l'annuaire du jeu, une équipe sans
                     activité produit des lignes à zéro, pas une liste vide: la seule façon d'arriver
                     ici est que le commerce n'ait aucun employé du tout, et le texte doit le dire,
                     sans quoi un patron cherche des ventes là où il manque des embauches. */
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Users strokeWidth={1.75} aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>Aucun employé sur ce métier</EmptyTitle>
                      <EmptyDescription>
                        Personne ne porte ce métier en jeu, et personne n&apos;a vendu ni pointé sur
                        cette période.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  /**
                   * LE RELEVÉ, ET LE SEUL GABARIT DE CETTE PAGE.
                   *
                   * ⚠ LES COLONNES DISPARAISSENT PAR ORDRE D'IMPORTANCE, elles ne se compriment
                   * jamais. Un tableau à huit colonnes sur un téléphone ne se lit pas: soit il
                   * déborde en défilement horizontal (et la moitié des chiffres est hors de vue
                   * sans que rien ne le dise), soit chaque cellule casse ses mots. Ici chaque
                   * colonne annonce à partir de quelle largeur elle existe, et les deux qui
                   * répondent à la question de base - QUI, et COMBIEN - ne disparaissent jamais.
                   *
                   * ⚠⚠ LES DEUX DERNIERS PALIERS SONT DES VALEURS LIBRES (1340, 1440) ET PAS `xl`.
                   * La largeur de la COLONNE PRINCIPALE n'est pas monotone en largeur de fenêtre:
                   * jusqu'au palier de `.work` le rail est empilé dessous et la colonne vaut
                   * `fenêtre - 284`, au-delà le rail se met à côté et elle RETOMBE à
                   * `fenêtre - 638`. Une fenêtre de 1281px offre donc moins de place qu'une de
                   * 1024px. Régler ces colonnes sur `xl` (1280) les ferait apparaître exactement au
                   * moment où la place disparaît, c'est-à-dire déborder. Les deux valeurs ci-dessous
                   * sont les premières largeurs où la colonne principale, RAIL COMPRIS, tient
                   * réellement la colonne en plus: mesurées au banc d'essai, pas déduites. Un palier
                   * ne peut jamais retirer une colonne quand on ÉLARGIT la fenêtre: une colonne qui
                   * disparaît en agrandissant se lit comme un bug (même règle que la grille de la
                   * Caisse, qui descend 4 -> 3 -> 2 et jamais l'inverse).
                   */
                  <Table className={s.roster}>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="hidden pl-3 text-right sm:table-cell">#</TableHead>
                        <TableHead className="pl-3 sm:pl-2">Employé</TableHead>
                        <TableHead className="hidden min-[1440px]:table-cell">Rythme</TableHead>
                        <TableHead className="text-right">Chiffre</TableHead>
                        <TableHead className="hidden text-right md:table-cell">Ventes</TableHead>
                        <TableHead className="hidden min-[1340px]:table-cell">Part équipe</TableHead>
                        {showHours ? (
                          <TableHead className="hidden text-right lg:table-cell">Heures</TableHead>
                        ) : null}
                        {showCommission ? (
                          <TableHead className="hidden pr-3 text-right sm:table-cell">Part due</TableHead>
                        ) : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r, i) => {
                        const rowTrend = trendOf(r.totalCents, r.prevTotalCents);
                        const shareOfTeam = pct(r.totalCents, totals.total);
                        return (
                          /**
                           * ⚠ TOUTE LA LIGNE OUVRE LA FICHE, et le lien reste un VRAI lien. La
                           * demande était "a list that opens team page", donc viser un nom de
                           * quinze pixels de haut serait rater la moitié des clics. Le lien du nom
                           * s'étend à la ligne entière par un pseudo-élément (`.rowLink::after`,
                           * la ligne étant `position: relative`) plutôt que par un `onClick` sur la
                           * rangée: un gestionnaire de clic n'est ni focalisable au clavier, ni
                           * ouvrable dans un nouvel onglet, ni lisible par un lecteur d'écran, et
                           * il forcerait cette page entière à devenir un composant client.
                           */
                          <TableRow
                            key={r.identifier}
                            className={`${s.clickRow} ${r.former ? s.formerRow : ""}`}
                          >
                            <TableCell className="hidden pl-3 text-right sm:table-cell">
                              <RankBadge index={i} />
                            </TableCell>
                            <TableCell className="pl-3 sm:pl-2">
                              <span className={s.rowWho}>
                                <Avatar size="sm">
                                  <AvatarFallback>{initials(r.name)}</AvatarFallback>
                                </Avatar>
                                <span className={s.who}>
                                  <Link
                                    href={`${base}/${encodeURIComponent(r.identifier)}${keep}`}
                                    className={s.rowLink}
                                  >
                                    {r.name}
                                  </Link>
                                  <span className={s.idline}>
                                    {r.gradeLabel !== null ? (
                                      <Badge variant="secondary">{r.gradeLabel}</Badge>
                                    ) : null}
                                    {r.former ? <FormerTag /> : null}
                                    {r.onDutySeconds !== null ? <DutyTag seconds={r.onDutySeconds} /> : null}
                                  </span>
                                </span>
                              </span>
                            </TableCell>
                            <TableCell className="hidden min-[1440px]:table-cell">
                              <RowSpark
                                values={r.days}
                                scale={dayScale}
                                label={`Rythme de ${r.name} sur la période`}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <span className={s.rowAmt}>{money(r.totalCents)}</span>
                              <span className={s.cm}>
                                {rowTrend ? (
                                  <span className={`delta ${rowTrend.tone}`}>{rowTrend.label}</span>
                                ) : (
                                  "sans précédent"
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="hidden text-right tabular-nums md:table-cell">
                              <span className={s.rowAmt}>{r.sales}</span>
                              <span className={s.cm}>
                                {r.sales > 0 ? `${money(Math.round(r.totalCents / r.sales))} / ticket` : "aucun"}
                              </span>
                            </TableCell>
                            <TableCell className="hidden min-[1340px]:table-cell">
                              <div className={s.rowShare}>
                                <Progress value={shareOfTeam} className="h-1.5 flex-1" />
                                <span className={s.sharePct}>{shareOfTeam} %</span>
                              </div>
                            </TableCell>
                            {showHours ? (
                              <TableCell className="hidden text-right tabular-nums lg:table-cell">
                                <span className={s.rowAmt}>{hoursLabel(r.seconds)}</span>
                                <span className={s.cm}>
                                  {r.seconds > 0 && r.totalCents > 0
                                    ? `${money(Math.round(r.totalCents / (r.seconds / 3600)))} / h`
                                    : "non pointé"}
                                </span>
                              </TableCell>
                            ) : null}
                            {showCommission ? (
                              <TableCell className="hidden pr-3 text-right tabular-nums sm:table-cell">
                                <span className={`${s.rowAmt} ${s.ok}`}>{money(r.commissionCents)}</span>
                                <span className={s.cm}>versée en jeu</span>
                              </TableCell>
                            ) : null}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>

            <div className={s.wrail}>
              <div className="panel">
                <div className="ph">
                  <span className="cap">En service</span>
                  <span className="dim">maintenant</span>
                </div>
                {duty.length === 0 ? (
                  <Empty className="p-4">
                    <EmptyDescription>Personne n&apos;est en service.</EmptyDescription>
                  </Empty>
                ) : (
                  <div className={s.rows}>
                    {duty.map((d) => (
                      <div className={s.row} key={d.identifier}>
                        <span className={s.rmain}>
                          <span className={s.rn}>{d.name}</span>
                          <span className={s.rs}>depuis {hoursLabel(d.seconds)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* L'ABSORBEUR du rail: il prend la hauteur restante et fait défiler son contenu,
                  donc le bas du rail rejoint toujours exactement celui de la colonne principale,
                  quelle que soit la longueur des deux. */}
              <div className={`panel ${s.absorb}`}>
                <div className="ph">
                  <span className="cap">Dernières ventes</span>
                  <span className="dim">{feed.length}</span>
                </div>
                {feed.length === 0 ? (
                  <Empty className="p-4">
                    <EmptyDescription>Aucune vente déclarée.</EmptyDescription>
                  </Empty>
                ) : (
                  <div className={s.scroll}>
                    <div className={s.rows}>
                      {feed.map((f) => (
                        <div className={s.row} key={f.id}>
                          <span className={s.rmain}>
                            <span className={s.rn}>{f.seller}</span>
                            <span className={s.rs}>{f.when}</span>
                          </span>
                          <span className={s.ra}>{money(f.totalCents)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
