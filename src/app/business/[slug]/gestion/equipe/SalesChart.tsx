"use client";

import { useId, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { money } from "@/lib/business/theme";

/* ── LA PÉRIODE ───────────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠⚠ `Period` / `PERIOD_OPTIONS` / `parsePeriod` / `periodDays` ONT QUITTÉ CE FICHIER LE 2026-08-09,
 * POUR `./periods`, ET NE DOIVENT PAS Y REVENIR. Ce module porte `"use client"`, donc chacun de ses
 * exports de VALEUR devient une référence client: un `page.tsx` (composant serveur) qui appelait
 * `parsePeriod()` importé d'ici levait à l'exécution et rendait la page entière en 500.
 *
 *     Attempted to call parsePeriod() from the server but parsePeriod is on the client.
 *
 * Ni `tsc` ni `next build` ne peuvent l'attraper: la frontière serveur/client n'existe pas pour
 * TypeScript, et le build compile un tel import sans broncher. Voir l'en-tête de `./periods.ts`.
 *
 * ⚠ ET ON NE LES RÉEXPORTE PAS D'ICI NON PLUS, même si c'est tentant pour garder un import unique:
 * un réexport depuis un module `"use client"` FRANCHIT LA MÊME FRONTIÈRE et retombe exactement dans
 * la même panne. Chaque `page.tsx` importe donc `./periods` directement. Ce fichier ne fait plus que
 * les CONSOMMER, comme n'importe quel composant client.
 */
import { PERIOD_OPTIONS, type Period } from "./periods";

/**
 * LE SÉLECTEUR DE PÉRIODE, en tête de la carte du graphique.
 *
 * Le seul état de ces deux pages vit dans l'URL, donc ce composant ne garde rien: il pousse une
 * nouvelle adresse et le serveur re-rend. C'est aussi ce qui rend la période partageable par
 * copier-coller et survivable au rechargement, ce qu'un état local n'aurait pas donné.
 *
 * ⚠ `replace` et non `push`: changer de fenêtre d'analyse n'est pas une navigation, et empiler
 * quinze entrées d'historique ferait du bouton Retour une loterie au lieu d'un retour à la page
 * précédente.
 */
export function PeriodSelect({ base, period }: { base: string; period: Period }) {
  const router = useRouter();
  return (
    <Select value={period} onValueChange={(v) => router.replace(`${base}?p=${v}`)}>
      <SelectTrigger size="sm" aria-label="Période analysée">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERIOD_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ── LE VOCABULAIRE DE DONNÉES ────────────────────────────────────────────────────────────────── */

/**
 * Un jour de la période, tel que le serveur l'a construit.
 *
 * ⚠ `key` EST LA CLÉ SQL (`YYYY-MM-DD`, ce que rend `dailyTotals` via `DATE_FORMAT`), jamais
 * reconstruite ici:
 * c'est elle qui garantit qu'une somme agrégée en base tombe dans la bonne colonne du graphique.
 * `label` est ce que porte l'axe, `full` ce que porte la bulle. Les trois sont distincts parce
 * qu'aucun ne peut jouer les deux autres rôles: une abscisse doit tenir en trois caractères, une
 * bulle doit se lire en français, et une clé ne doit jamais changer de forme selon la locale.
 */
export type DayRow = {
  key: string;
  label: string;
  full: string;
  today: boolean;
  /**
   * Une valeur en CENTIMES par série, indexée par `Series.key`.
   *
   * ⚠ Les clés de série sont aplaties dans la ligne Recharts à côté de `label`/`full`/`today`, donc
   * elles ne doivent JAMAIS porter un de ces trois noms. Les appelants les nomment `s0`, `s1`, …
   * plutôt que d'utiliser le nom de l'employé, qui pourrait collisionner et qui changerait de clé
   * dès qu'un patron renomme quelqu'un.
   */
  values: Record<string, number>;
};

export type Series = {
  key: string;
  label: string;
  /**
   * L'entrée de palette à utiliser (1 à 5). Par défaut, la position dans la liste.
   *
   * ⚠ Découplée de la position PARCE QUE L'ORDRE DE LA PILE EST UNE DÉCISION DE LECTURE, pas une
   * décision de couleur. Recharts empile dans l'ordre des `<Area>`, donc le premier élément est la
   * BASE: la série "tous les autres" doit y être (elle est le socle sur lequel les têtes se
   * détachent), et elle doit pourtant garder la teinte neutre `--chart-5`, pas celle de l'enseigne.
   */
  tone?: number;
  /**
   * Série de CONTEXTE plutôt que de sujet: même place dans la pile, beaucoup moins d'encre.
   *
   * ⚠ `--chart-5` retombe sur `--faint`, un blanc translucide (voir `shadcnBridge` dans theme.ts).
   * Sur une surface sombre, une aire remplie à cette teinte avec l'opacité normale devient la plus
   * lumineuse du graphique - donc la queue du classement écrasait visuellement les quatre meilleurs
   * vendeurs, exactement l'inverse de ce que le graphique raconte. Mesuré à trente employés.
   */
  muted?: boolean;
};

/**
 * LES CINQ TEINTES DE GRAPHIQUE, ET RIEN D'AUTRE.
 *
 * `--chart-1..4` sont les quatre tons de rayon de l'enseigne (pont shadcn de lib/business/theme.ts),
 * `--chart-5` un neutre du portail. Une série au-delà de la cinquième n'existe pas: les appelants
 * regroupent la queue de classement dans une série "autres" plutôt que d'inventer une sixième
 * couleur, qui n'aurait aucun sens dans la palette du commerce.
 */
const CHART_TOKENS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

export const MAX_SERIES = CHART_TOKENS.length;

function tokenFor(index: number): string {
  return CHART_TOKENS[index % CHART_TOKENS.length]!;
}

/* ── LES CONSTANTES DE DESSIN. Nommées, jamais posées en dur au milieu d'un JSX. ───────────────── */

const GRID_DASH = "3 3";
const AXIS_TICK_SIZE = 9;
const AXIS_TICK_WEIGHT = 700;
const VALUE_AXIS_WIDTH = 46;
const X_TICK_DROP = 12;
const X_MIN_GAP = 14;
const AREA_STROKE = 2;
const FILL_TOP_OPACITY = 0.75;
const FILL_BOTTOM_OPACITY = 0.05;
const MUTED_TOP_OPACITY = 0.22;
const MUTED_BOTTOM_OPACITY = 0.02;
const MUTED_STROKE = 1;
const RADAR_FILL_CUR = 0.42;
const RADAR_FILL_PREV = 0.08;
const RADAR_DOT_R = 3;
const BAR_RADIUS: [number, number, number, number] = [3, 3, 0, 0];
const BAR_RADIUS_ROWS: [number, number, number, number] = [0, 3, 3, 0];
const CHART_MARGIN = { top: 6, right: 8, bottom: 0, left: 0 };

/**
 * L'ÉCHELLE DES ORDONNÉES QUAND LES MONTANTS SONT PETITS, ET POURQUOI ELLE A BESOIN D'UNE RÈGLE.
 *
 * ⚠⚠ MESURÉ AU BANC D'ESSAI LE 2026-08-10, PAS DÉDUIT. Sur une période dont le plus haut jour
 * empilé vaut 600 CENTIMES (6 $), l'axe affichait `0 $ / 2 $ / 3 $ / 5 $ / 6 $`: des écarts
 * apparents de 1, 1, 2 puis 1 dollar, sur un axe dont les graduations sont pourtant régulières. Le
 * tracé est juste, c'est l'ÉCHELLE qui ment, et elle ment parce que les deux moitiés du problème ne
 * parlent pas la même unité: Recharts choisit un pas « joli » en CENTIMES (ici 150), et
 * `axisMoney` n'écrit que des DOLLARS ENTIERS. Un pas de 1,50 $ ne peut donc pas s'écrire, et
 * l'arrondi le répartit au hasard des graduations.
 *
 * La règle, du coup: EN DESSOUS DU SEUIL OÙ UN PAS PEUT NE PAS TOMBER SUR UN DOLLAR ENTIER, on
 * impose le domaine sur une grille de dollars entiers; AU-DESSUS, on laisse Recharts faire, parce
 * qu'il fait mieux. Vérifié au banc d'essai sur les jeux réalistes (`0 $ / 300 $ / 600 $ / 900 $ /
 * 1,2 k$`), et l'imposer partout aurait dégradé ce cas-là: la grille à pas rond aurait poussé le
 * plafond à 2 000 $ pour une donnée qui culmine à 1 165 $, soit 40 pour cent de hauteur perdue.
 *
 * Le seuil vaut `TICK_INTERVALS x 1000` centimes: un pas fractionnaire en dollars suppose un pas
 * inférieur à 1 000 centimes, puisque les mantisses de Recharts vont par demis (1, 1,5, 2, 2,5, 3…)
 * et qu'à partir de 1 000 centimes une demi-mantisse reste un nombre entier de dollars.
 *
 * ⚠ Rien de tout ça ne DESSINE quoi que ce soit. Une période entièrement à zéro n'est pas rattrapée
 * ici, elle est interceptée en amont (voir `empty` dans `RhythmAreaChart`): un bel axe au-dessus
 * d'une toile vide reste une toile vide.
 */
const TICK_INTERVALS = 4;
const CENTS_PER_DOLLAR = 100;
const SMALL_AXIS_CENTS = TICK_INTERVALS * 10 * CENTS_PER_DOLLAR;

/**
 * Le plafond de l'axe: `"auto"` (Recharts décide) dès que les montants sont assez grands, sinon une
 * valeur posée sur une grille dont chaque intervalle vaut un nombre ENTIER de dollars.
 */
function axisTop(maxCents: number): number | "auto" {
  if (maxCents >= SMALL_AXIS_CENTS) return "auto";
  const perTick = Math.ceil(maxCents / TICK_INTERVALS / CENTS_PER_DOLLAR) * CENTS_PER_DOLLAR;
  return TICK_INTERVALS * Math.max(CENTS_PER_DOLLAR, perTick);
}
/** En dessous de trois axes, une toile d'araignée n'est plus une toile: voir `MixChart`. */
const MIN_RADAR_AXES = 3;
const THOUSAND = 1000;
const SECONDS_PER_HOUR = 3600;

/**
 * Un montant d'AXE, donc compact: "24 k$" plutôt que "24 471 $".
 *
 * Une graduation n'est pas une valeur qu'on lit au centime, c'est un repère d'échelle. Écrire le
 * montant complet sur cinq graduations force l'axe à 90px de large et vole cette largeur au tracé,
 * qui est la seule chose que le graphique existe pour montrer. La bulle, elle, donne le montant
 * exact via `money()`.
 */
function axisMoney(cents: number): string {
  const dollars = Math.round(cents / 100);
  if (Math.abs(dollars) < THOUSAND) return `${dollars} $`;
  const k = dollars / THOUSAND;
  return `${k.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k$`;
}

function hoursOf(seconds: number): number {
  return Math.round((seconds / SECONDS_PER_HOUR) * 10) / 10;
}

function hoursLabel(seconds: number): string {
  return `${hoursOf(seconds).toLocaleString("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}

/**
 * ⚠ `useId()` de React 19 rend une chaîne À GUILLEMETS FRANÇAIS (`«r0»`), et un identifiant SVG
 * référencé par `url(#…)` doit rester un jeton CSS. On la réduit donc aux caractères sûrs avant de
 * la coller dans un `id`. Sans ça, le dégradé n'est pas résolu et l'aire se dessine transparente:
 * une panne strictement visuelle, donc invisible à tout contrôle automatique.
 */
function safeId(raw: string, suffix: string): string {
  return `${raw.replace(/[^a-zA-Z0-9_-]/g, "")}-${suffix}`;
}

/**
 * Les étiquettes d'axe des jours, l'encre du jour courant venant de la palette de l'enseigne.
 *
 * Prend le plus petit contrat qui suffit (`label` + `today`) plutôt que `DayRow`: les barres
 * d'heures portent la même abscisse sans porter les mêmes valeurs, et il n'y a aucune raison de
 * leur imposer une forme de données qu'elles n'utilisent pas.
 */
function useDayTick(data: { label: string; today: boolean }[], anchor: "bottom" | "left") {
  const todayLabels = useMemo(
    () => new Set(data.filter((d) => d.today).map((d) => d.label)),
    [data],
  );
  // Nommée plutôt qu'anonyme: Recharts reçoit cette fonction comme `tick`, donc React la voit comme
  // un composant et exige un nom lisible dans ses traces d'erreur (règle `react/display-name`).
  const DayTick = (props: {
    x?: number | string;
    y?: number | string;
    payload?: { value?: string | number };
  }) => {
    const x = Number(props.x ?? 0);
    const y = Number(props.y ?? 0);
    const label = String(props.payload?.value ?? "");
    const fill = todayLabels.has(label) ? "var(--chart-1)" : "var(--muted-foreground)";
    return anchor === "left" ? (
      <text x={x} y={y} dy={4} textAnchor="end" fontSize={AXIS_TICK_SIZE} fontWeight={AXIS_TICK_WEIGHT} fill={fill}>
        {label}
      </text>
    ) : (
      <text
        x={x}
        y={y}
        dy={X_TICK_DROP}
        textAnchor="middle"
        fontSize={AXIS_TICK_SIZE}
        fontWeight={AXIS_TICK_WEIGHT}
        fill={fill}
      >
        {label}
      </text>
    );
  };
  DayTick.displayName = "DayTick";
  return DayTick;
}

/* ── LE GRAPHIQUE PRINCIPAL: LE RYTHME, EN AIRES EMPILÉES ─────────────────────────────────────── */

/**
 * LE RYTHME DE LA PÉRIODE, une aire par série, empilées.
 *
 * C'est le motif shadcn `charts/area-interactive` appliqué à la matière de ce portail: dégradés
 * `<linearGradient>`, grille horizontale seule, axe des jours formaté, bulle à pastille, légende.
 * Il sert DEUX lectures que la page ne pouvait pas donner avant:
 *   - la FORME de la semaine (quand le commerce tourne), qu'un total ne porte pas;
 *   - la RÉPARTITION de cette forme entre les personnes, jour par jour, que le classement ne porte
 *     pas non plus (deux employés à égalité sur la semaine peuvent avoir travaillé des jours
 *     opposés, ce qui change tout pour qui fait un planning).
 *
 * ⚠⚠ `monotone`, JAMAIS `natural`. Une spline "natural" dépasse ses points de passage pour rester
 * lisse: un jour à 0 $ coincé entre un jour moyen et un pic creusait une aire visible SOUS l'axe,
 * comme si le commerce avait perdu de l'argent ce jour-là. Repéré en direct le 2026-08-09 par le
 * propriétaire. `monotone` ne dépasse jamais le minimum ou le maximum LOCAL entre deux points
 * consécutifs. La règle vaut d'autant plus ici que les aires sont EMPILÉES: un dépassement sur la
 * série du bas déplace visuellement toutes celles du dessus.
 *
 * ⚠ AUCUNE AIRE NE CHANGE DE TEINTE POUR "AUJOURD'HUI": deux couleurs dans une même série se
 * liraient comme deux grandeurs mesurées. Le jour courant se distingue par l'encre de son étiquette
 * d'axe, et par rien d'autre.
 *
 * ─── LES TROIS DÉFAUTS À VALEUR NULLE, MESURÉS LE 2026-08-10 ET CORRIGÉS ICI ────────────────────
 * Signalés par le propriétaire ("when thing is lower or 0 graph doesnt display correctly"), puis
 * reproduits un par un dans un banc d'essai qui montait CE composant dans un Chromium sans tête,
 * avec la vraie palette du commerce, sur sept jeux de données fabriqués. Ce qui a été trouvé:
 *
 *   1. TOUT À ZÉRO -> RIEN DU TOUT. Recharts ne rend alors ni aire, ni courbe, ni la moindre
 *      graduation d'ordonnée (compté: 0 `recharts-area-area`, 0 `recharts-area-curve`, 0 étiquette
 *      d'axe Y). Il reste le titre de la carte et les sept jours en abscisse au-dessus d'un
 *      rectangle vide, ce qui ne se distingue pas d'un graphique en panne. -> `empty`.
 *   2. UNE SÉRIE À ZÉRO SUR TOUTE LA PÉRIODE -> UN FILET FANTÔME. Sa courbe est alors, point pour
 *      point, celle de la série qu'elle empile (vérifié en comparant les cubiques des deux tracés:
 *      y identiques à 0,01px près). Son trait de 2px REPEINT donc la bordure supérieure de la bande
 *      du dessous, dans SA couleur à elle: la bande d'un vendeur se retrouve soulignée de la teinte
 *      d'un autre, qui n'a pourtant rien vendu. -> `strokeWidth` nul pour ces séries-là, tout en
 *      les gardant dans la légende et dans la bulle, où « 0 $ » est une information.
 *   3. VALEURS MINUSCULES -> AXE À PAS INCOHÉRENT. Voir `MIN_AXIS_CENTS`.
 *
 * ⚠ CE QUE LE BANC D'ESSAI A DISCULPÉ, ET QU'IL NE FAUT DONC PAS « CORRIGER »: `monotone` ne produit
 * AUCUN artefact à valeur nulle sur une pile. Les trois hypothèses plausibles ont été testées en
 * comparant analytiquement les cubiques de deux séries voisines (leur composante X est une droite,
 * donc un même paramètre t désigne un même x sur les deux courbes), en 41 points par segment:
 * dépassement sous la ligne de base 0,00px, croisement de deux bandes empilées 0,00px, y compris
 * sur un 0 coincé entre deux pics (0 -> 200 000 -> 0 au-dessus d'un socle constant). `natural`, lui,
 * dépassait bel et bien, et c'est pour ça qu'il a été retiré: la règle ci-dessus tient toujours.
 */
export function RhythmAreaChart({
  data,
  series,
  className,
  stacked = true,
  empty,
}: {
  data: DayRow[];
  series: Series[];
  className?: string;
  /** Empilées (part de chacun dans un tout) ou superposées (deux mesures indépendantes). */
  stacked?: boolean;
  /**
   * Ce qu'on montre quand TOUTES les séries valent zéro sur toute la période.
   *
   * ⚠ La décision est prise ICI et pas au site d'appel, pour qu'aucun appelant ne puisse l'oublier:
   * un graphique vide ne se voit pas dans un test de types ni dans un build, seulement en ouvrant la
   * page le jour où le commerce n'a rien vendu. Sans `empty`, on retombe sur une phrase neutre
   * plutôt que sur une toile blanche.
   */
  empty?: React.ReactNode;
}) {
  const uid = useId();
  const dayTick = useDayTick(data, "bottom");

  const config = useMemo(
    () =>
      Object.fromEntries(
        series.map((s, i) => [s.key, { label: s.label, color: tokenFor((s.tone ?? i + 1) - 1) }]),
      ) as ChartConfig,
    [series],
  );

  const rows = useMemo(
    () => data.map((d) => ({ label: d.label, full: d.full, today: d.today, ...d.values })),
    [data],
  );

  /**
   * Les séries qui ne valent zéro nulle part sur la période, et le maximum EMPILÉ de la période.
   *
   * Le maximum est calculé ici plutôt que laissé à Recharts parce que le plancher d'axe doit porter
   * sur la valeur EMPILÉE (la hauteur réellement dessinée), pas sur la plus haute série prise
   * isolément. Une somme par jour, donc, jamais un max de max.
   */
  const { flatKeys, stackedMax } = useMemo(() => {
    const flat = new Set<string>();
    for (const s of series) {
      if (data.every((d) => (d.values[s.key] ?? 0) === 0)) flat.add(s.key);
    }
    let max = 0;
    for (const d of data) {
      let dayTotal = 0;
      let dayMax = 0;
      for (const s of series) {
        const v = d.values[s.key] ?? 0;
        dayTotal += v;
        if (v > dayMax) dayMax = v;
      }
      const h = stacked ? dayTotal : dayMax;
      if (h > max) max = h;
    }
    return { flatKeys: flat, stackedMax: max };
  }, [data, series, stacked]);

  if (stackedMax <= 0) {
    return (
      <div
        className={`${className ?? ""} flex items-center justify-center text-center`}
        data-chart-empty=""
      >
        {empty ?? <p className="pick">Aucune donnée sur cette période.</p>}
      </div>
    );
  }

  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={rows} margin={CHART_MARGIN}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={safeId(uid, s.key)} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor={`var(--color-${s.key})`}
                stopOpacity={s.muted ? MUTED_TOP_OPACITY : FILL_TOP_OPACITY}
              />
              <stop
                offset="95%"
                stopColor={`var(--color-${s.key})`}
                stopOpacity={s.muted ? MUTED_BOTTOM_OPACITY : FILL_BOTTOM_OPACITY}
              />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} strokeDasharray={GRID_DASH} stroke="var(--border)" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          minTickGap={X_MIN_GAP}
          tick={dayTick}
        />
        {/* ⚠ Le domaine part TOUJOURS de 0, et son plafond n'est imposé QUE sur les petits montants:
            voir `axisTop` pour la mesure qui l'impose et pour ce qu'imposer partout aurait coûté.
            `tickCount` est écrit explicitement pour que la grille et le nombre d'intervalles restent
            une seule et même décision, pas deux valeurs à tenir synchronisées. */}
        <YAxis
          tickLine={false}
          axisLine={false}
          width={VALUE_AXIS_WIDTH}
          domain={[0, axisTop(stackedMax)]}
          tickCount={TICK_INTERVALS + 1}
          tickFormatter={(v) => axisMoney(Number(v))}
          tick={{ fontSize: AXIS_TICK_SIZE, fill: "var(--muted-foreground)" }}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeDasharray: GRID_DASH }}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_, payload) => {
                const row = payload?.[0]?.payload as { full?: string } | undefined;
                const sum = (payload ?? []).reduce((acc, p) => acc + Number(p.value ?? 0), 0);
                return (
                  <div className="flex items-center justify-between gap-4">
                    <span>{row?.full ?? ""}</span>
                    {/* Le total du jour n'apparaît que s'il y a plusieurs séries: avec une seule il
                        répéterait mot pour mot la ligne juste en dessous. */}
                    {(payload?.length ?? 0) > 1 ? (
                      <span className="font-mono tabular-nums">{money(sum)}</span>
                    ) : null}
                  </div>
                );
              }}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: item?.color }}
                    />
                    {config[String(name)]?.label ?? String(name)}
                  </span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {money(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        {series.map((s) => (
          /**
           * ⚠ UNE SÉRIE PLATE À ZÉRO GARDE SA PLACE MAIS PERD SON TRAIT. Elle reste un `<Area>`,
           * donc la légende la nomme et la bulle affiche son « 0 $ », ce qui est exactement
           * l'information qu'un gérant vient chercher sur quelqu'un qui n'a rien vendu. Ce qu'elle
           * perd, c'est le trait de 2px qu'elle dessinait par-dessus la bande de la série du
           * dessous, dans sa propre couleur (voir l'en-tête, défaut nº2): une bordure d'une teinte
           * qui n'appartient pas à la bande qu'elle souligne.
           */
          <Area
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stackId={stacked ? "rythme" : undefined}
            stroke={`var(--color-${s.key})`}
            strokeWidth={flatKeys.has(s.key) ? 0 : s.muted ? MUTED_STROKE : AREA_STROKE}
            fill={`url(#${safeId(uid, s.key)})`}
            isAnimationActive={false}
          />
        ))}
        {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
      </AreaChart>
    </ChartContainer>
  );
}

/* ── LE PROFIL PAR RAYON ──────────────────────────────────────────────────────────────────────── */

export type MixPoint = {
  label: string;
  /** Chiffre du rayon sur la période, en centimes. */
  cur: number;
  /** Le même rayon sur la période précédente. Zéro si la personne n'y avait rien vendu. */
  prev: number;
};

const MIX_CONFIG = {
  cur: { label: "Cette période", color: "var(--chart-1)" },
  prev: { label: "Période précédente", color: "var(--chart-4)" },
} satisfies ChartConfig;

/**
 * CE QU'IL VEND, PAR RAYON, comparé à lui-même la période d'avant.
 *
 * ⚠ POURQUOI UN RADAR ICI ET PAS AILLEURS. Un radar est le bon outil pour exactement une question:
 * comparer DEUX PROFILS sur QUELQUES dimensions de même nature. C'est le cas ici (les rayons d'un
 * commerce, trois à huit, et deux périodes du même vendeur), et ce n'est le cas nulle part ailleurs
 * dans ce portail: le rythme est une série temporelle, donc une aire, et un classement d'articles
 * est un ordre, donc des barres. Ce que le radar montre et qu'aucun des deux ne montre: la FORME du
 * vendeur - quelqu'un qui a glissé du vin vers la cuisine a le même chiffre et un profil déformé.
 *
 * ⚠ EN DESSOUS DE TROIS RAYONS, ON NE DESSINE PAS UN RADAR. Deux axes donnent un segment et un seul
 * donne un point: une figure qui n'est plus lisible comme une aire, et qui ferait passer un commerce
 * à deux rayons pour un bug d'affichage. On retombe alors sur des barres horizontales, qui répondent
 * à la même question sans prétendre à une forme.
 */
export function MixChart({ data, className }: { data: MixPoint[]; className?: string }) {
  const tooltip = (
    <ChartTooltip
      cursor={false}
      content={
        <ChartTooltipContent
          indicator="line"
          formatter={(value, name, item) => (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 shrink-0 rounded-[2px]" style={{ background: item?.color }} />
                {MIX_CONFIG[name as keyof typeof MIX_CONFIG]?.label ?? String(name)}
              </span>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {money(Number(value))}
              </span>
            </div>
          )}
        />
      }
    />
  );

  if (data.length < MIN_RADAR_AXES) {
    return (
      <ChartContainer config={MIX_CONFIG} className={className}>
        <BarChart data={data} layout="vertical" margin={CHART_MARGIN} barCategoryGap="22%">
          <CartesianGrid horizontal={false} vertical strokeDasharray={GRID_DASH} stroke="var(--border)" />
          <YAxis
            dataKey="label"
            type="category"
            tickLine={false}
            axisLine={false}
            width={VALUE_AXIS_WIDTH}
            tick={{ fontSize: AXIS_TICK_SIZE, fill: "var(--muted-foreground)" }}
          />
          <XAxis type="number" tickFormatter={(v) => axisMoney(Number(v))} hide />
          {tooltip}
          <Bar dataKey="prev" fill="var(--color-prev)" radius={BAR_RADIUS_ROWS} isAnimationActive={false} />
          <Bar dataKey="cur" fill="var(--color-cur)" radius={BAR_RADIUS_ROWS} isAnimationActive={false} />
          <ChartLegend content={<ChartLegendContent />} />
        </BarChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={MIX_CONFIG} className={className}>
      <RadarChart data={data} margin={CHART_MARGIN}>
        {tooltip}
        <PolarAngleAxis
          dataKey="label"
          tick={{ fontSize: AXIS_TICK_SIZE, fill: "var(--muted-foreground)" }}
        />
        <PolarGrid stroke="var(--border)" />
        {/* La période précédente d'abord, donc SOUS l'actuelle: c'est le fond de comparaison, pas
            le sujet. L'inverse cacherait la forme du jour derrière celle d'avant-hier. */}
        <Radar
          dataKey="prev"
          stroke="var(--color-prev)"
          fill="var(--color-prev)"
          fillOpacity={RADAR_FILL_PREV}
          isAnimationActive={false}
        />
        <Radar
          dataKey="cur"
          stroke="var(--color-cur)"
          fill="var(--color-cur)"
          fillOpacity={RADAR_FILL_CUR}
          dot={{ r: RADAR_DOT_R, fillOpacity: 1 }}
          isAnimationActive={false}
        />
        <ChartLegend content={<ChartLegendContent />} />
      </RadarChart>
    </ChartContainer>
  );
}

/* ── HEURES ET RENDEMENT ──────────────────────────────────────────────────────────────────────── */

export type HourPoint = {
  label: string;
  full: string;
  today: boolean;
  seconds: number;
  /** Le chiffre déclaré ce jour-là, pour le rendement affiché dans la bulle. */
  cents: number;
};

const HOURS_CONFIG = {
  hours: { label: "Heures", color: "var(--chart-3)" },
} satisfies ChartConfig;

/**
 * LES HEURES POINTÉES PAR JOUR, et le rendement qu'elles ont produit.
 *
 * ⚠ UNE SEULE GRANDEUR EN BARRES, LE RESTE DANS LA BULLE, et ce n'est pas de la timidité. Un
 * deuxième axe de valeurs (les dollars à droite, les heures à gauche) laisse le lecteur croire à un
 * croisement de courbes qui ne dépend que du choix arbitraire des deux échelles. Le rendement
 * ($/h) est un RATIO: il se lit en chiffre, pas en hauteur comparée.
 *
 * ⚠ UN SERVICE EST RANGÉ AU JOUR OÙ IL A COMMENCÉ. Une soirée qui finit à 2h du matin compte donc
 * entière dans la veille. C'est la lecture qu'attend un gérant qui pense en "soirées", et la seule
 * qui n'exige pas de découper une ligne de pointage en deux morceaux dont aucun n'existe en base.
 */
export function HoursBarChart({ data, className }: { data: HourPoint[]; className?: string }) {
  const dayTick = useDayTick(data, "bottom");
  const rows = useMemo(
    () => data.map((d) => ({ ...d, hours: hoursOf(d.seconds) })),
    [data],
  );

  return (
    <ChartContainer config={HOURS_CONFIG} className={className}>
      <BarChart data={rows} margin={CHART_MARGIN} barCategoryGap="18%">
        <CartesianGrid vertical={false} strokeDasharray={GRID_DASH} stroke="var(--border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={X_MIN_GAP} tick={dayTick} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={VALUE_AXIS_WIDTH}
          tickFormatter={(v) => `${v} h`}
          tick={{ fontSize: AXIS_TICK_SIZE, fill: "var(--muted-foreground)" }}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_, payload) => {
                const row = payload?.[0]?.payload as HourPoint | undefined;
                return <span>{row?.full ?? ""}</span>;
              }}
              formatter={(value, _name, item) => {
                const row = item?.payload as HourPoint | undefined;
                const seconds = row?.seconds ?? 0;
                const cents = row?.cents ?? 0;
                return (
                  <div className="grid w-full gap-1">
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span
                          className="size-2 shrink-0 rounded-[2px]"
                          style={{ background: item?.color }}
                        />
                        Heures
                      </span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {hoursLabel(seconds)}
                      </span>
                    </div>
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="text-muted-foreground">Chiffre</span>
                      <span className="font-mono tabular-nums text-foreground">{money(cents)}</span>
                    </div>
                    {/* Le rendement n'est écrit QUE s'il existe. Sans heure pointée le ratio est une
                        division par zéro, et "0 $/h" affirmerait une improductivité qui n'a pas eu
                        lieu: la personne n'a simplement pas pointé ce jour-là. */}
                    {seconds > 0 ? (
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="text-muted-foreground">Rendement</span>
                        <span className="font-mono tabular-nums text-foreground">
                          {money(Math.round(cents / (seconds / SECONDS_PER_HOUR)))} / h
                        </span>
                      </div>
                    ) : null}
                    <span className="sr-only">{String(value)}</span>
                  </div>
                );
              }}
            />
          }
        />
        <Bar dataKey="hours" fill="var(--color-hours)" radius={BAR_RADIUS} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}
