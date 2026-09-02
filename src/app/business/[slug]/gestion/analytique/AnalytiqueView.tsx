"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts";
import { ChartNoAxesCombined, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { money, toneVars } from "@/lib/business/theme";
import type { Analytics, DayPoint, HourPoint, ProductRow } from "./page";
import s from "./analytique.module.css";

/**
 * ANALYTIQUE, côté navigateur.
 *
 * ⚠ CE FICHIER NE CALCULE AUCUN MONTANT. Tout arrive déjà agrégé et déjà formaté depuis page.tsx
 * (voir son entête: aucun chiffre ne vient d'une liste plafonnée, et aucune date n'est formatée
 * ici pour ne pas la rendre dans le fuseau du navigateur). Ce qui se passe ici est de la mise en
 * forme: choisir une vue, mettre à l'échelle une barre, peindre une série.
 *
 * LA PAGE RÉPOND À CINQ QUESTIONS, DANS CET ORDRE, ET SA COMPOSITION EST CET ORDRE:
 *   1. combien, et EST-CE QUE ÇA MONTE     → la rangée de chiffres, chacun avec son écart réel;
 *   2. comment ça a évolué                 → la courbe, avec la période précédente en repère;
 *   3. de quoi ce chiffre est fait         → les rayons, puis les articles (deux classements);
 *   4. quand ça vend                       → le rythme de la semaine et les heures d'affluence;
 *   5. par qui                             → le rendement de chacun, à l'heure de service.
 *
 * ⚠ CHAQUE GRAPHIQUE PORTE SES CHIFFRES EN TOUTES LETTRES QUELQUE PART. Le camembert a sa légende
 * chiffrée, la courbe a la rangée de chiffres au-dessus, le rythme et les heures ont leur pied de
 * carte qui NOMME le meilleur jour et l'heure de pointe. Rien n'existe uniquement sous forme de
 * couleur ou d'angle: un gérant agit sur ces nombres.
 *
 * ⚠ LA COULEUR EST CELLE DU COMMERCE, jamais un jeu de couleurs choisi ici. `--chart-1..4` sont les
 * quatre tons de rayon de l'enseigne (pont shadcn de lib/business/theme.ts), donc le vin du Bar du
 * Vigneron et l'orange d'un garage sortent des mêmes composants sans une ligne de conditionnel.
 * Une seule règle à ne pas oublier: `--chart-N` (donc `--kN`) est un REMPLISSAGE, `--kNt` est la
 * même teinte en TEXTE, et les deux ne sont pas interchangeables.
 */

/** Le libellé d'une fenêtre. Une seule table, lue par le sélecteur ET par les écarts. */
const PERIOD_LABEL: Record<number, string> = {
  7: "7 derniers jours",
  14: "14 derniers jours",
  30: "30 derniers jours",
  90: "90 derniers jours",
};

type MainView = "total" | "seller";
type ProductMetric = "rev" | "qty";

/** Le nombre d'articles affichés dans le classement. Les rangs, eux, portent sur tout le catalogue. */
const PRODUCTS_SHOWN = 8;

/**
 * L'écart avec la période précédente, en pourcentage, ou RIEN.
 *
 * ⚠ RIEN, et surtout pas "+100 %", quand la période précédente est à zéro. Un commerce ouvert la
 * semaine dernière afficherait sinon une croissance inventée sur chacune de ses quatre tuiles, et
 * c'est exactement le genre de chiffre qu'on ne peut pas contredire de mémoire. Même règle, mot
 * pour mot, que `deltaPct` dans mes-ventes.
 */
function deltaPct(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/**
 * Un montant COMPACT, pour une graduation d'axe seulement.
 *
 * Jamais pour un chiffre qu'on lit: "23,2 k$" est bon pour situer une hauteur, mauvais pour un
 * total qu'un gérant recopie. Les montants du texte passent tous par `money`, qui rend la valeur
 * entière.
 */
function axisMoney(cents: number): string {
  const d = Math.round(cents / 100);
  if (Math.abs(d) >= 1000) {
    return `${(d / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k$`;
  }
  return `${d.toLocaleString("fr-FR")} $`;
}

/** L'ordinal français abrégé. `1er`, puis `2e`, `3e`... `1e` n'existe pas et saute aux yeux. */
function ordinal(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
}

/** "7 h 45", "7 h". Arithmétique pure sur des secondes: aucune date, donc aucun piège de fuseau. */
function hoursText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

/** La couleur d'un ton de rayon, ou le neutre du cinquième créneau quand le rayon n'existe plus. */
function toneColor(tone: number | null): string {
  return tone === null ? "var(--chart-5)" : `var(--chart-${tone})`;
}

/**
 * COMPTE JUSQU'À `target` PLUTÔT QUE DE L'AFFICHER D'UN COUP.
 *
 * ⚠ RECOPIÉ DEPUIS mes-ventes/MesVentesView.tsx, DÉLIBÉRÉMENT, ET PAS IMPORTÉ. Ce portail ne couple
 * pas deux pages voisines par un utilitaire partagé tant qu'il n'a pas de maison commune: un import
 * croisé entre deux vues clientes ferait dépendre celle-ci d'un fichier qu'une autre refonte peut
 * réécrire ou déplacer sans le savoir. Le jour où trois pages en ont besoin, il ira dans
 * `lib/business`, pas dans la page qui l'a écrit en premier.
 *
 * Une seule boucle `requestAnimationFrame`, une courbe ease-out cubique, aucune dépendance. Anime
 * depuis la valeur PRÉCÉDENTE et pas depuis zéro sur un changement de période: repartir de zéro
 * ferait clignoter la page au lieu de montrer un écart. Respecte `prefers-reduced-motion`.
 */
function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(0);
  const prevTarget = useRef<number | null>(null);

  useEffect(() => {
    const from = prevTarget.current ?? 0;
    prevTarget.current = target;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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

/* ── Petites briques d'affichage ──────────────────────────────────────────────────────────────── */

/** L'écart avec la période précédente: une flèche, un pourcentage, une couleur. Ou rien du tout. */
function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const Icon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;
  return (
    <span className={`delta ${dir}`}>
      <Icon size={13} strokeWidth={2} className={s.deltaIcon} aria-hidden="true" />
      {pct > 0 ? "+" : ""}
      {pct} %
    </span>
  );
}

function Kpi({
  label,
  value,
  pct,
  before,
  beforeLabel,
}: {
  label: string;
  value: string;
  pct: number | null;
  before: string | null;
  beforeLabel: string;
}) {
  return (
    <Card className={s.kpi}>
      <span className={`cap ${s.kpiK}`}>{label}</span>
      <span className={s.kpiV}>{value}</span>
      <span className={s.kpiFoot}>
        <Delta pct={pct} />
        {/* La valeur précédente est écrite, pas seulement le pourcentage: "+12 %" sans son point de
            départ ne dit pas si on parle de deux cents dollars ou de vingt mille. */}
        {before === null ? <span>{beforeLabel} : aucune vente</span> : <span>{beforeLabel} : {before}</span>}
      </span>
    </Card>
  );
}

/** Une ligne de l'infobulle: la pastille de série, son nom, son montant. Le format shadcn, en argent. */
function TipRow({ color, name, text }: { color: string | undefined; name: string; text: string }) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span
          className="size-2 shrink-0 rounded-[2px]"
          style={{ background: color }}
          aria-hidden="true"
        />
        {name}
      </span>
      <span className="font-mono font-medium tabular-nums text-foreground">{text}</span>
    </div>
  );
}

/* ── La vue ───────────────────────────────────────────────────────────────────────────────────── */

export default function AnalytiqueView({
  name,
  canRead,
  deniedReason,
  days,
  periods,
  data,
}: {
  name: string;
  canRead: boolean;
  deniedReason: string | null;
  days: number;
  periods: number[];
  data: Analytics | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const [view, setView] = useState<MainView>("total");
  const [metric, setMetric] = useState<ProductMetric>("rev");

  // Appelé AVANT tout retour anticipé: les Rules of Hooks interdisent un hook conditionnel.
  const heroCents = useCountUp(data?.cur.totalCents ?? 0);

  /**
   * LE CHANGEMENT DE PÉRIODE REPASSE PAR LE SERVEUR, et ce n'est pas un raccourci.
   *
   * Le camembert, le classement d'articles, les heures d'affluence et le rendement sont quatre
   * agrégats SQL DIFFÉRENTS, calculés sur la fenêtre demandée: aucun d'eux ne se déduit des points
   * de la courbe. Filtrer côté navigateur, comme le fait l'exemple shadcn, ne marcherait donc que
   * pour la courbe et laisserait les quatre autres blocs afficher les chiffres de l'ancienne
   * période, sans que rien ne le signale. La fenêtre vit dans l'URL (`?j=`), même convention que
   * `?p=` sur la page Équipe, donc elle se partage et se recharge.
   *
   * ⚠ L'URL EST RECONSTRUITE, PAS LUE VIA `useSearchParams`. Ce hook force Next à exiger une
   * frontière `<Suspense>` autour du composant sous peine d'échouer au build sur toute page qu'il
   * juge rendable statiquement, et `?j` est le SEUL paramètre de cette route: la valeur courante
   * arrive déjà en propriété depuis le serveur, qui l'a validée contre la liste des fenêtres
   * autorisées. Lire l'URL une seconde fois côté client n'apporterait rien et coûterait ce piège.
   */
  const setDays = (next: string) => {
    startTransition(() => router.replace(`${pathname}?j=${next}`, { scroll: false }));
  };

  const periodSelect = (
    <Select value={String(days)} onValueChange={setDays}>
      <SelectTrigger aria-label="Période analysée" className="w-[168px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {periods.map((p) => (
          <SelectItem key={p} value={String(p)}>
            {PERIOD_LABEL[p] ?? `${p} jours`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (!canRead || !data) {
    return (
      <>
        <div className="head">
          <h1>Analytique</h1>
          <span className="sub">{name}</span>
        </div>
        <div className="note">{deniedReason}</div>
      </>
    );
  }

  const hasSales = data.cur.sales > 0;

  return (
    <>
      <div className="head">
        <h1>Analytique</h1>
        <span className="sub">
          {name}, {data.rangeLabel}
        </span>
        <div className="spacer" />
        {periodSelect}
      </div>

      {/* `key` sur la fenêtre: un vrai remontage React, donc `.fadeIn` rejoue à chaque changement
          de période. Sans lui l'animation ne se déclencherait qu'au premier chargement. */}
      <div key={days} className={`${s.wrap} ${s.fadeIn} ${pending ? s.busy : ""}`}>
        {!hasSales ? (
          <Empty className={s.hollow}>
            <EmptyHeader className={s.hollowHead}>
              <EmptyMedia variant="icon">
                <ChartNoAxesCombined aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle className="cap">Aucune vente sur la période</EmptyTitle>
              <EmptyDescription className={s.hollowP}>
                {data.days < 90
                  ? "Rien n'a été déclaré sur cette fenêtre. Élargissez la période ci-dessus, ou encaissez une première vente depuis la Caisse : l'analytique se remplit dès la première déclaration."
                  : "Rien n'a été déclaré depuis trois mois. L'analytique se remplit dès la première vente enregistrée à la Caisse."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Figures data={data} heroCents={heroCents} />
            <MainChart data={data} view={view} onView={setView} />
            <div className={s.duoMix}>
              <RayonCard data={data} />
              <ProductCard data={data} metric={metric} onMetric={setMetric} />
            </div>
            <div className={s.duoWhen}>
              <WeekRhythm data={data} />
              <RushHours data={data} />
            </div>
            {data.showHours ? <CrewCard data={data} /> : null}
          </>
        )}
      </div>
    </>
  );
}

/* ── 1. Combien, et est-ce que ça monte ───────────────────────────────────────────────────────── */

function Figures({ data, heroCents }: { data: Analytics; heroCents: number }) {
  const beforeLabel = `${data.days} j précédents`;
  return (
    <>
      <div className={s.kpis}>
        <Kpi
          label="Chiffre d'affaires"
          value={money(heroCents)}
          pct={deltaPct(data.cur.totalCents, data.prev.totalCents)}
          before={data.hasPrevious ? money(data.prev.totalCents) : null}
          beforeLabel={beforeLabel}
        />
        <Kpi
          label="Tickets"
          value={data.cur.sales.toLocaleString("fr-FR")}
          pct={deltaPct(data.cur.sales, data.prev.sales)}
          before={data.hasPrevious ? data.prev.sales.toLocaleString("fr-FR") : null}
          beforeLabel={beforeLabel}
        />
        <Kpi
          label="Panier moyen"
          value={money(data.cur.avgTicketCents)}
          pct={deltaPct(data.cur.avgTicketCents, data.prev.avgTicketCents)}
          before={data.hasPrevious ? money(data.prev.avgTicketCents) : null}
          beforeLabel={beforeLabel}
        />
        {/* La part employé n'est une ligne de coût que si le module existe. Éteint, la tuile
            disparaît et les trois autres se répartissent la largeur (voir `.kpis`). */}
        {data.showCommission ? (
          <Kpi
            label="Part employé"
            value={money(data.cur.commissionCents)}
            pct={deltaPct(data.cur.commissionCents, data.prev.commissionCents)}
            before={data.hasPrevious ? money(data.prev.commissionCents) : null}
            beforeLabel={beforeLabel}
          />
        ) : null}
      </div>
      {/* ⚠ DIT EN TOUTES LETTRES QUE LE DERNIER JOUR EST INCOMPLET. La fenêtre courante se termine
          maintenant, la précédente était entière: sans cette phrase, un écart légèrement négatif en
          milieu de journée se lit comme une baisse alors que c'est l'heure qu'il est. */}
      <p className={s.kpiNote}>
        Comparé aux {data.days} jours précédents ({data.prevRangeLabel}). La journée en cours n&apos;est
        pas terminée.
      </p>
    </>
  );
}

/* ── 2. Comment ça a évolué ───────────────────────────────────────────────────────────────────── */

function MainChart({
  data,
  view,
  onView,
}: {
  data: Analytics;
  view: MainView;
  onView: (v: MainView) => void;
}) {
  const gradId = useId();
  const bySeller = view === "seller" && data.sellers.length > 0;

  /**
   * Les points, APLATIS: Recharts lit ses séries sur les clés de premier niveau de chaque ligne,
   * donc `sellers` doit devenir `s0`, `s1`... Chaque série est initialisée à 0 pour TOUS les jours,
   * y compris ceux où la personne n'a rien vendu: une clé absente laisse un trou dans l'empilement
   * et la pile du jour se réduirait silencieusement à ceux qui ont travaillé.
   */
  const rows = useMemo(() => {
    const base: Record<string, number> = {};
    for (const s of data.sellers) base[s.key] = 0;
    return data.points.map((p) => ({
      label: p.label,
      full: p.full,
      prevFull: p.prevFull ?? "",
      totalCents: p.totalCents,
      prevCents: p.prevCents,
      ...base,
      ...p.sellers,
    }));
  }, [data.points, data.sellers]);

  const config = useMemo(() => {
    const out: ChartConfig = {
      totalCents: { label: "Chiffre", color: "var(--chart-1)" },
      prevCents: { label: "Période précédente", color: "var(--muted-foreground)" },
    };
    for (const seller of data.sellers) {
      out[seller.key] = { label: seller.name, color: toneColor(seller.tone) };
    }
    return out;
  }, [data.sellers]);

  const best = data.points.reduce<DayPoint | null>(
    (acc, p) => (p.totalCents > 0 && (!acc || p.totalCents > acc.totalCents) ? p : acc),
    null,
  );

  return (
    <Card className={s.card}>
      <div className={s.chead}>
        <div className={s.ctitles}>
          <span className={s.ctitle}>Chiffre d&apos;affaires</span>
          <span className={s.csub}>
            {bySeller
              ? "Empilé par vendeur, jour par jour"
              : data.hasPrevious
                ? "Jour par jour, la période précédente en repère"
                : "Jour par jour"}
          </span>
        </div>
        <div className={s.cactions}>
          <div className="seg" role="group" aria-label="Vue du graphique">
            <button type="button" aria-pressed={view === "total"} onClick={() => onView("total")}>
              Total
            </button>
            <button
              type="button"
              aria-pressed={view === "seller"}
              onClick={() => onView("seller")}
              disabled={data.sellers.length === 0}
            >
              Par vendeur
            </button>
          </div>
        </div>
      </div>

      <div className={s.cbody}>
        {/* ⚠ `ComposedChart` ET PAS `AreaChart`, PARCE QUE LA VUE "TOTAL" MÊLE UNE AIRE ET UNE
            LIGNE. Un `AreaChart` déclare `Area` comme son seul enfant graphique, et c'est cet
            enfant-là qui sert à calculer le domaine des axes: une `Line` posée dedans se dessine
            quand même mais SANS être comptée dans l'échelle, donc une période précédente plus forte
            que la période courante sortirait par le haut du cadre et se ferait rogner. Le défaut
            serait invisible tant qu'on regarde une période en progression, c'est-à-dire exactement
            tant qu'on ne cherche pas le bug. */}
        <ChartContainer config={config} className={s.chartMain}>
          <ComposedChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`${gradId}-t`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-totalCents)" stopOpacity={0.75} />
                <stop offset="95%" stopColor="var(--color-totalCents)" stopOpacity={0.04} />
              </linearGradient>
              {data.sellers.map((seller) => (
                <linearGradient
                  key={seller.key}
                  id={`${gradId}-${seller.key}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={toneColor(seller.tone)} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={toneColor(seller.tone)} stopOpacity={0.12} />
                </linearGradient>
              ))}
            </defs>

            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={26}
              interval="preserveStartEnd"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={54}
              tickMargin={4}
              tickFormatter={(v: number) => axisMoney(Number(v))}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  indicator="dot"
                  labelFormatter={(_label, items) => {
                    const row = items?.[0]?.payload as { full?: string } | undefined;
                    return row?.full ?? "";
                  }}
                  formatter={(value, seriesName, item) => {
                    const key = String(seriesName);
                    const row = item.payload as { prevFull?: string } | undefined;
                    const label =
                      key === "prevCents" && row?.prevFull
                        ? row.prevFull
                        : String(config[key]?.label ?? key);
                    return <TipRow color={item.color} name={label} text={money(Number(value))} />;
                  }}
                />
              }
            />

            {bySeller ? (
              <>
                {data.sellers.map((seller) => (
                  <Area
                    key={seller.key}
                    dataKey={seller.key}
                    name={seller.key}
                    // ⚠ `monotone`, PAS `natural`. Une spline "natural" dépasse ses points de
                    // passage pour rester lisse: un jour à 0 $ coincé entre deux journées pleines
                    // creusait une aire visible SOUS l'axe, comme si le commerce perdait de
                    // l'argent ce jour-là (repéré en direct le 2026-08-09 sur la page Équipe).
                    // `monotone` ne dépasse jamais le minimum ni le maximum local entre deux
                    // points: la courbe reste lisse sans jamais mentir sur le signe d'une valeur.
                    type="monotone"
                    stackId="a"
                    stroke={toneColor(seller.tone)}
                    strokeWidth={1.5}
                    fill={`url(#${gradId}-${seller.key})`}
                    isAnimationActive={false}
                  />
                ))}
                <ChartLegend content={<ChartLegendContent />} />
              </>
            ) : (
              <>
                <Area
                  dataKey="totalCents"
                  name="totalCents"
                  type="monotone"
                  stroke="var(--color-totalCents)"
                  strokeWidth={2}
                  fill={`url(#${gradId}-t)`}
                  isAnimationActive={false}
                />
                {/* La période précédente est un REPÈRE, donc une ligne fine en pointillé et non une
                    seconde aire: deux aires pleines se lisent comme deux grandeurs à additionner.
                    Elle n'est tracée que s'il y a vraiment quelque chose à comparer, sinon elle
                    dessinerait une ligne plate à zéro qui ressemble à une mauvaise période.
                    ⚠ DÉCLARÉE APRÈS L'AIRE, donc dessinée PAR-DESSUS: Recharts empile ses enfants
                    dans l'ordre du JSX, et une ligne posée avant disparaît sous le dégradé dès que
                    la période courante passe au-dessus d'elle, c'est-à-dire exactement quand on
                    veut voir de combien. */}
                {data.hasPrevious ? (
                  <Line
                    dataKey="prevCents"
                    name="prevCents"
                    type="monotone"
                    stroke="var(--color-prevCents)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : null}
              </>
            )}
          </ComposedChart>
        </ChartContainer>
      </div>

      <div className={s.cfoot}>
        {best ? (
          <span>
            Meilleure journée : <b>{best.full.toLowerCase()}</b>, <b>{money(best.totalCents)}</b>
          </span>
        ) : null}
        {bySeller && data.sellersFolded > 0 ? (
          <span>
            Les {data.sellers.length - 1} premiers vendeurs, {data.sellersFolded} autre
            {data.sellersFolded > 1 ? "s" : ""} regroupé{data.sellersFolded > 1 ? "s" : ""}.
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/* ── 3a. De quoi c'est fait: les rayons ───────────────────────────────────────────────────────── */

function RayonCard({ data }: { data: Analytics }) {
  /**
   * ⚠⚠ LES CLÉS DE SÉRIE SONT SYNTHÉTIQUES (`r1`, `r2`, …) ET C'EST UNE BARRIÈRE, PAS UN CONFORT -
   * même discipline que RayonMix (mes-ventes/MesVentesView.tsx). `ChartStyle`
   * (components/ui/chart.tsx) écrit chaque clé de `ChartConfig` dans un `<style
   * dangerouslySetInnerHTML>`, sous la forme `--color-<clé>: <couleur>;`. Or `r.key` ici est
   * `p.category` (page.tsx), une colonne de la base modifiable depuis les Réglages - une clé forgée
   * refermerait la balise et exécuterait du script sur l'origine de CITADEL, pour chaque gérant qui
   * ouvre la page. Un indice de position ne porte rien ; le libellé, lui, ne traverse que du texte
   * React, qui est échappé.
   */
  const series = useMemo(() => data.rayons.map((r, i) => ({ ...r, id: `r${i + 1}` })), [data.rayons]);

  const config = useMemo(() => {
    const out: ChartConfig = {};
    for (const r of series) out[r.id] = { label: r.label, color: toneColor(r.tone) };
    return out;
  }, [series]);

  const total = data.rayons.reduce((acc, r) => acc + r.revenueCents, 0);
  const lead = data.rayons[0] ?? null;

  return (
    <Card className={s.card}>
      <div className={s.chead}>
        <div className={s.ctitles}>
          <span className={s.ctitle}>Par rayon</span>
          <span className={s.csub}>Ce qui fait le chiffre</span>
        </div>
      </div>
      <div className={s.cbody}>
        {data.rayons.length === 0 ? (
          <p className={s.cnone}>Aucune ligne d&apos;article sur la période.</p>
        ) : (
          <>
            {/* ⚠ LE TOTAL AU CENTRE DU BEIGNET EST DU HTML POSÉ PAR-DESSUS, PAS UN `<Label>`
                RECHARTS. Le trou tombe au centre du conteneur (un camembert se centre tout seul,
                `cx`/`cy` valant 50 % par défaut), donc il n'y a aucune coordonnée à calculer, le
                texte reste du texte (sélectionnable, à la même fonte que le reste de la page) au
                lieu d'un `<text>` SVG, et on évite le `content` de `Label`, dont les props ne sont
                typées que par un `viewBox` optionnel qu'il faudrait affirmer à la main.
                `pointer-events: none` laisse l'infobulle du camembert fonctionner à travers. */}
            <div className={s.donut}>
              <ChartContainer config={config} className={s.chartSquare}>
                <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        hideLabel
                        formatter={(value, seriesName, item) => (
                          <TipRow
                            color={item.color}
                            name={String(seriesName)}
                            text={money(Number(value))}
                          />
                        )}
                      />
                    }
                  />
                  <Pie
                    data={series}
                    dataKey="revenueCents"
                    nameKey="label"
                    innerRadius="58%"
                    outerRadius="88%"
                    paddingAngle={2}
                    // Le liseré est la couleur de la CARTE, pas du blanc: sur un panneau sombre un
                    // trait blanc entre deux parts se lit comme une cinquième part lumineuse.
                    stroke="var(--card)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {series.map((r) => (
                      <Cell key={r.id} fill={toneColor(r.tone)} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
              <div className={s.donutCenter} aria-hidden="true">
                <span className={s.donutV}>{money(total)}</span>
                <span className={s.donutK}>{data.rayons.length} rayons</span>
              </div>
            </div>

            <div className={s.legend}>
              {series.map((r) => (
                <div
                  key={r.id}
                  className={s.lrow}
                  // ⚠ `toneVars` SEULEMENT quand le rayon a vraiment un ton. Retomber sur le ton 4
                  // pour un rayon disparu du catalogue peindrait son NOM de la couleur d'un rayon
                  // existant, donc mentirait sur son appartenance; sans les variables, `.lname`
                  // retombe sur l'encre normale et la pastille sur le neutre du cinquième créneau.
                  style={r.tone === null ? undefined : (toneVars(r.tone) as React.CSSProperties)}
                >
                  <i
                    className={s.ldot}
                    style={{ background: toneColor(r.tone) }}
                    aria-hidden="true"
                  />
                  <span className={s.lname}>{r.label}</span>
                  <span className={s.lshare}>{Math.round(r.share * 100)} %</span>
                  <span className={s.lval}>{money(r.revenueCents)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {lead ? (
        <div className={s.cfoot}>
          <span>
            <b>{lead.label}</b> pèse <b>{Math.round(lead.share * 100)} %</b> du chiffre, sur{" "}
            {money(total)}.
          </span>
        </div>
      ) : null}
    </Card>
  );
}

/* ── 3b. De quoi c'est fait: les articles ─────────────────────────────────────────────────────── */

function ProductCard({
  data,
  metric,
  onMetric,
}: {
  data: Analytics;
  metric: ProductMetric;
  onMetric: (m: ProductMetric) => void;
}) {
  const rows = useMemo(() => {
    const sorted = [...data.products].sort((a, b) =>
      metric === "rev" ? a.revRank - b.revRank : a.qtyRank - b.qtyRank,
    );
    return sorted.slice(0, PRODUCTS_SHOWN);
  }, [data.products, metric]);

  const valueOf = (p: ProductRow) => (metric === "rev" ? p.revenueCents : p.qty);
  const top = rows.length > 0 ? valueOf(rows[0]!) : 0;

  /**
   * LA DIVERGENCE ENTRE LES DEUX CLASSEMENTS EST L'INFORMATION.
   *
   * Un café premier en volume et huitième en chiffre ne se pilote pas comme une bouteille première
   * des deux côtés: l'un fait venir du monde, l'autre paie les factures. Un classement unique ne
   * peut pas le dire, donc chaque ligne porte SON rang dans l'autre métrique, et on ne le répète
   * pas quand les deux tombent pareil (ce serait du bruit sur la ligne qui n'a rien à signaler).
   */
  return (
    <Card className={s.card}>
      <div className={s.chead}>
        <div className={s.ctitles}>
          <span className={s.ctitle}>Meilleures ventes</span>
          <span className={s.csub}>
            {metric === "rev" ? "Classées par chiffre" : "Classées par quantité vendue"}
          </span>
        </div>
        <div className={s.cactions}>
          <div className="seg" role="group" aria-label="Classer les articles par">
            <button type="button" aria-pressed={metric === "rev"} onClick={() => onMetric("rev")}>
              Chiffre
            </button>
            <button type="button" aria-pressed={metric === "qty"} onClick={() => onMetric("qty")}>
              Quantité
            </button>
          </div>
        </div>
      </div>
      <div className={s.cbody}>
        {rows.length === 0 ? (
          <p className={s.cnone}>Aucune ligne d&apos;article sur la période.</p>
        ) : (
          <div className={s.plist}>
            {rows.map((p, i) => {
              const v = valueOf(p);
              const otherRank = metric === "rev" ? p.qtyRank : p.revRank;
              const thisRank = metric === "rev" ? p.revRank : p.qtyRank;
              return (
                <div
                  key={p.key}
                  className={s.prow}
                  // Voir la légende des rayons: pas de ton emprunté pour un article dont le rayon
                  // n'existe plus. Sans variables, la barre retombe sur `--brand` et le libellé de
                  // rayon sur le texte secondaire, ce qui est exactement ce qu'on veut dire.
                  style={p.tone === null ? undefined : (toneVars(p.tone) as React.CSSProperties)}
                >
                  <span className={s.prank}>{i + 1}</span>
                  <span className={s.pmid}>
                    <span className={s.pnamerow}>
                      <span className={s.pname}>{p.label}</span>
                      <span className={s.pcat}>{p.categoryLabel}</span>
                    </span>
                    <span className={s.pbar}>
                      <i style={{ width: `${top > 0 ? Math.max(2, Math.round((v / top) * 100)) : 0}%` }} />
                    </span>
                  </span>
                  <span className={s.pend}>
                    <span className={s.pval}>
                      {metric === "rev" ? money(p.revenueCents) : `${p.qty.toLocaleString("fr-FR")} vendus`}
                    </span>
                    <span className={s.palt}>
                      {otherRank === thisRank
                        ? metric === "rev"
                          ? `${p.qty.toLocaleString("fr-FR")} vendus`
                          : money(p.revenueCents)
                        : metric === "rev"
                          ? `${p.qty.toLocaleString("fr-FR")} vendus, ${ordinal(otherRank)} en volume`
                          : `${money(p.revenueCents)}, ${ordinal(otherRank)} en chiffre`}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ── 4a. Quand ça vend: le rythme de la semaine ───────────────────────────────────────────────── */

const WEEK_CONFIG = {
  totalCents: { label: "Chiffre", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * ⚠ UN RADAR ICI, ET UNE HISTOGRAMME POUR LES HEURES, POUR UNE RAISON ET PAS PAR VARIÉTÉ. Une
 * semaine est CYCLIQUE et fermée sur elle-même (le dimanche touche le lundi suivant), et sept
 * points suffisent à en faire une forme qu'on reconnaît d'une semaine sur l'autre: c'est
 * exactement ce que le radar sait montrer et qu'un histogramme, qui a un début et une fin, ne dit
 * pas. Les heures, elles, sont vingt-quatre valeurs dont la moitié peut être à zéro (un bar ouvre
 * à midi): un radar aurait replié la moitié de la figure sur son centre et donné l'impression
 * d'une erreur de rendu.
 */
function WeekRhythm({ data }: { data: Analytics }) {
  return (
    <Card className={s.card}>
      <div className={s.chead}>
        <div className={s.ctitles}>
          <span className={s.ctitle}>Rythme de la semaine</span>
          <span className={s.csub}>Chiffre cumulé par jour</span>
        </div>
      </div>
      <div className={s.cbody}>
        <ChartContainer config={WEEK_CONFIG} className={s.chartSquare}>
          <RadarChart data={data.weekdays} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, items) => {
                    const row = items?.[0]?.payload as { full?: string } | undefined;
                    return row?.full ?? "";
                  }}
                  formatter={(value, _seriesName, item) => (
                    <TipRow color={item.color} name="Chiffre" text={money(Number(value))} />
                  )}
                />
              }
            />
            <PolarGrid stroke="var(--border)" />
            <PolarAngleAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            {/* ⚠ LE RAYON EST BORNÉ AU MEILLEUR JOUR, sinon Recharts arrondit son maximum au tick
                supérieur et la figure flotte au milieu de sa grille sans jamais la toucher: on lit
                alors "aucun jour n'est fort" là où il fallait lire "voici le jour le plus fort".
                L'axe est MASQUÉ parce que ses graduations diraient un montant, et le montant est
                déjà écrit en toutes lettres dans le pied de la carte. */}
            <PolarRadiusAxis domain={[0, "dataMax"]} tick={false} axisLine={false} />
            <Radar
              dataKey="totalCents"
              stroke="var(--color-totalCents)"
              strokeWidth={2}
              fill="var(--color-totalCents)"
              fillOpacity={0.4}
              dot={{ r: 2.5, fillOpacity: 1 }}
              isAnimationActive={false}
            />
          </RadarChart>
        </ChartContainer>
      </div>
      <div className={s.cfoot}>
        {data.bestWeekday ? (
          <span>
            Meilleur jour : <b>{data.bestWeekday.full.toLowerCase()}</b>,{" "}
            <b>{money(data.bestWeekday.totalCents)}</b> cumulés
          </span>
        ) : (
          <span>Pas assez de ventes pour dégager un jour fort.</span>
        )}
      </div>
    </Card>
  );
}

/* ── 4b. Quand ça vend: les heures d'affluence ────────────────────────────────────────────────── */

/**
 * ⚠ MÊME TEINTE QUE LA COURBE PRINCIPALE (`--chart-1`), PAS UNE COULEUR PAR GRAPHIQUE. Ces barres
 * mesurent EXACTEMENT la même grandeur que l'aire du haut, du camembert et du radar: le chiffre
 * d'affaires. Lui donner une couleur différente par carte ferait de la teinte une décoration, alors
 * qu'elle porte une information ailleurs sur cette page (chaque ton nomme un rayon, chaque ton
 * nomme un vendeur). Une couleur, une chose.
 */
const HOUR_CONFIG = {
  totalCents: { label: "Chiffre", color: "var(--chart-1)" },
} satisfies ChartConfig;

function RushHours({ data }: { data: Analytics }) {
  const peak = data.bestHour;
  /**
   * Les heures OUVERTES seulement, mais jamais un trou au milieu.
   *
   * Un bar qui ouvre à midi laisserait douze barres à zéro à gauche du graphe, soit la moitié de la
   * largeur pour dire "fermé". On coupe donc aux extrémités, de la première à la dernière heure où
   * quelque chose s'est vendu, et jamais entre les deux: une heure creuse EN PLEIN SERVICE est une
   * information (le coup de mou de 18 h), et la masquer resserrerait les barres autour d'un axe qui
   * ne serait plus continu.
   */
  const shown = useMemo(() => {
    const first = data.hours.findIndex((h) => h.sales > 0);
    if (first < 0) return data.hours;
    let last = data.hours.length - 1;
    while (last > first && (data.hours[last]?.sales ?? 0) === 0) last -= 1;
    return data.hours.slice(first, last + 1);
  }, [data.hours]);

  return (
    <Card className={s.card}>
      <div className={s.chead}>
        <div className={s.ctitles}>
          <span className={s.ctitle}>Heures d&apos;affluence</span>
          <span className={s.csub}>
            {shown.length === data.hours.length
              ? "Chiffre cumulé par heure"
              : `Chiffre cumulé par heure, de ${shown[0]?.label ?? ""} à ${shown[shown.length - 1]?.label ?? ""}`}
          </span>
        </div>
      </div>
      <div className={s.cbody}>
        <ChartContainer config={HOUR_CONFIG} className={s.chartWide}>
          <BarChart data={shown} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="hour"
              tickLine={false}
              axisLine={false}
              tickMargin={7}
              minTickGap={14}
              tickFormatter={(v: number) => String(v).padStart(2, "0")}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={54}
              tickMargin={4}
              tickFormatter={(v: number) => axisMoney(Number(v))}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
            <ChartTooltip
              cursor={{ fill: "var(--accent)" }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, items) => {
                    const row = items?.[0]?.payload as HourPoint | undefined;
                    // La tranche entière, pas seulement son heure de départ: "18 h" seul se lit
                    // comme un instant alors que la barre couvre soixante minutes.
                    return row ? `${row.label} à ${String(row.hour).padStart(2, "0")} h 59` : "";
                  }}
                  formatter={(value, _seriesName, item) => {
                    const row = item.payload as HourPoint | undefined;
                    const n = row?.sales ?? 0;
                    return (
                      <TipRow
                        color={item.color}
                        name={`${n} ticket${n > 1 ? "s" : ""}`}
                        text={money(Number(value))}
                      />
                    );
                  }}
                />
              }
            />
            {/* ⚠ L'HEURE DE POINTE RESSORT PAR LA SATURATION, PAS PAR UNE SECONDE COULEUR. Deux
                teintes sur un même histogramme se lisent comme deux grandeurs mesurées, et cette
                page en peint déjà quatre pour nommer les rayons: une cinquième ici brouillerait la
                règle. La même teinte à deux opacités dit ce qu'il faut, "c'est la même chose, et
                voilà laquelle est la plus forte", sans ajouter un sens de couleur à retenir. */}
            <Bar dataKey="totalCents" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {shown.map((h) => (
                <Cell
                  key={h.hour}
                  fill="var(--chart-1)"
                  fillOpacity={peak && h.hour === peak.hour ? 1 : 0.42}
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>
      <div className={s.cfoot}>
        {peak ? (
          <span>
            Heure de pointe : <b>{peak.label}</b>, <b>{money(peak.totalCents)}</b> sur{" "}
            {peak.sales} ticket{peak.sales > 1 ? "s" : ""}
          </span>
        ) : (
          <span>Pas assez de ventes pour dégager une heure de pointe.</span>
        )}
      </div>
    </Card>
  );
}

/* ── 5. Par qui ───────────────────────────────────────────────────────────────────────────────── */

function CrewCard({ data }: { data: Analytics }) {
  const rated = data.crew.filter((c) => c.perHourCents !== null);
  const top = rated.reduce((acc, c) => Math.max(acc, c.perHourCents ?? 0), 0);

  return (
    <Card className={s.card}>
      <div className={s.chead}>
        <div className={s.ctitles}>
          <span className={s.ctitle}>Rendement par personne</span>
          <span className={s.csub}>Chiffre déclaré rapporté aux heures pointées en jeu</span>
        </div>
      </div>
      <div className={s.cbody}>
        {data.crew.length === 0 ? (
          <p className={s.cnone}>Personne n&apos;a vendu ni pointé sur la période.</p>
        ) : (
          <div className={s.plist}>
            <div className={`${s.crow} ${s.chead2}`}>
              <span>Employé</span>
              <span className={s.cnum}>Heures</span>
              <span className={`${s.cnum} ${s.hideNarrow}`}>Tickets</span>
              <span className={s.cnum}>Par heure</span>
            </div>
            {data.crew.map((c) => (
              <div key={c.id} className={s.crow}>
                <span className={s.cname}>
                  <span className={s.cnm}>{c.name}</span>
                  <span className={s.pbar}>
                    <i
                      style={{
                        width: `${top > 0 && c.perHourCents !== null ? Math.max(2, Math.round((c.perHourCents / top) * 100)) : 0}%`,
                        background: "var(--ok)",
                      }}
                    />
                  </span>
                </span>
                <span className={s.cnum}>{hoursText(c.seconds)}</span>
                <span className={`${s.cnum} ${s.hideNarrow}`}>{c.sales.toLocaleString("fr-FR")}</span>
                <span className={s.cnum}>
                  {c.perHourCents === null ? (
                    // ⚠ PAS DE CHIFFRE PLUTÔT QU'UN CHIFFRE ABERRANT. Diviser un chiffre par deux
                    // minutes de service donne un taux horaire spectaculaire et faux, qui écrase
                    // l'échelle de toute l'équipe. Voir MIN_RATED_SECONDS dans page.tsx.
                    <span className={s.cnone}>trop peu d&apos;heures</span>
                  ) : (
                    <b className={s.crate}>{money(c.perHourCents)}</b>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={s.cfoot}>
        <span>
          Les heures viennent du pointage enregistré en jeu, le chiffre des ventes déclarées : un
          écart entre les deux se lit ici avant de se voir ailleurs.
        </span>
      </div>
    </Card>
  );
}
