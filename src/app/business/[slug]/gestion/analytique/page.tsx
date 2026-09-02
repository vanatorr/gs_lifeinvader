import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug, type BusinessAccess } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import {
  dailyTotals,
  productTotals,
  salesClock,
  sellerTotals,
  type DailyTotal,
} from "@/lib/business/sales";
import { shiftTotals } from "@/lib/business/shifts";
import AnalytiqueView from "./AnalytiqueView";

export const dynamic = "force-dynamic";

/**
 * ANALYTIQUE: comment va le commerce, et QU'EST-CE QUI A CHANGÉ.
 *
 * ⚠ CETTE PAGE RE-RÉSOUT SON ACCÈS ELLE-MÊME, comme toutes ses voisines: `layout.tsx` n'est pas une
 * frontière de sécurité (Next peut rendre une page sans sa mise en page parente lors d'une
 * navigation côté client, et un Server Action est un POST public à l'URL de la page).
 *
 * ⚠ ELLE EST GARDÉE PAR `team.read`, LA MÊME CAPACITÉ QUE LA PAGE ÉQUIPE, et pas par une nouvelle.
 * Ce n'est pas de la paresse: la question qu'on se pose est "qui a le droit de voir les chiffres
 * des AUTRES", et le portail y a déjà répondu une fois. Une capacité `analytics.read` distincte
 * aurait créé une seconde porte vers exactement les mêmes données (le chiffre par vendeur, le
 * rendement par personne, la part employé de l'équipe), donc un moyen de contourner la première en
 * accordant la seconde par inadvertance. `team.read` est au palier `ingame` (voir capabilities.ts):
 * consulter le rendement de ses employés est un acte in-character, et ça vaut ici comme ailleurs.
 *   → Conséquence assumée: éteindre le module `equipe` ferme AUSSI cette page, puisque c'est lui qui
 *     porte `team.read` (voir modules.ts). C'est cohérent, un commerce qui ne veut pas de chiffres
 *     par personne ne veut pas non plus du classement par vendeur qui est ici.
 *
 * ⚠⚠ AUCUN CHIFFRE DE CETTE PAGE NE VIENT D'UNE LISTE PLAFONNÉE. `listSales` n'est appelée nulle
 * part ici, volontairement: c'est une lecture d'AFFICHAGE bornée à 200 lignes (500 au plus), donc
 * en additionner le contenu rend la somme des ventes les plus RÉCENTES et pas le total de la
 * période. Mesuré en direct le 2026-08-09 sur une page voisine: 36 156 $ affichés contre 56 138 $
 * réels, soit 35,6 % de moins, sans le moindre avertissement. Tout ce que cette page montre sort
 * donc d'un agrégat SQL (`dailyTotals`, `sellerTotals`, `productTotals`, `salesClock`,
 * `shiftTotals`), qui porte sur TOUTES les lignes de la fenêtre.
 */

/** Les fenêtres proposées, en jours. */
const PERIODS = [7, 14, 30, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];

/**
 * SEPT JOURS PAR DÉFAUT, ET C'EST UN CHOIX DE PRODUIT, PAS UN NOMBRE PRIS AU HASARD.
 *
 * Deux raisons, la seconde étant la plus forte. D'abord, tout le portail est cadré à la SEMAINE
 * (mes-ventes et Équipe ne proposent que "semaine en cours" et "semaine dernière"): ouvrir
 * l'analytique sur trente jours ferait dire à trois pages voisines trois chiffres différents pour
 * la même enseigne, et personne ne saurait laquelle regarder. Ensuite, et surtout, la fenêtre par
 * défaut décide de ce à quoi on COMPARE: à trente jours, un commerce en service depuis moins d'un
 * mois se compare aux trente jours d'avant son ouverture, donc à rien, et les quatre écarts de la
 * page se taisent tous en même temps (voir `deltaPct`, qui refuse d'inventer un pourcentage face à
 * zéro). Une page d'analytique dont la première chose que l'on voit est "aucune comparaison" a raté
 * ce pour quoi on l'ouvre. Sept jours a presque toujours sept jours derrière lui.
 *
 * Les fenêtres plus larges restent à un clic, et elles ne mentent pas quand l'historique manque:
 * elles montrent simplement une longue plage à zéro, ce qui est la vérité.
 */
const DEFAULT_DAYS: PeriodDays = 7;

/** Combien de vendeurs reçoivent leur propre couleur dans l'aire empilée. Voir `SERIES_KEYS`. */
const MAX_SELLER_SERIES = 4;

/** Combien d'articles traversent, par métrique. Le classement, lui, est calculé sur TOUS. */
const MAX_PRODUCTS = 10;

/**
 * En dessous de ce temps de service, on n'affiche PAS de chiffre par heure.
 *
 * Une division par une durée minuscule ne produit pas une information imprécise, elle produit un
 * nombre spectaculaire et faux: quelqu'un qui a pointé deux minutes et déclaré une bouteille
 * ressortirait à 2 850 $/h et écraserait l'échelle de tout le monde. `null` et une mention en
 * toutes lettres valent mieux qu'un chiffre qu'un gérant pourrait prendre au sérieux.
 */
const MIN_RATED_SECONDS = 15 * 60;

const DAY_MS = 86_400_000;

function parseDays(raw: string | undefined): PeriodDays {
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? (n as PeriodDays) : DEFAULT_DAYS;
}

/**
 * La fenêtre [from, to) des `days` derniers jours, AUJOURD'HUI COMPRIS.
 *
 * ⚠ Construite en avançant la DATE, jamais en soustrayant `days * 86 400 000`. Le passage à l'heure
 * d'été fait des journées de 23 et de 25 heures: une arithmétique en millisecondes décalerait la
 * borne basse d'une heure, et les ventes du premier soir de la fenêtre tomberaient dehors. Même
 * règle que `dayBounds` dans gestion/equipe/page.tsx.
 */
function lastDays(now: Date, days: number): { from: Date; to: Date } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  to.setDate(to.getDate() + 1); // borne haute exclusive: demain minuit, donc aujourd'hui est dedans
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from, to };
}

/** La fenêtre de MÊME LONGUEUR qui précède immédiatement celle-là. */
function previousOf(range: { from: Date; to: Date }, days: number): { from: Date; to: Date } {
  const from = new Date(range.from);
  from.setDate(from.getDate() - days);
  return { from, to: range.from };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-08-09`, en heure LOCALE. La clé qui rapproche un agrégat SQL et une case du calendrier. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * LA CLÉ DE JOURNÉE D'UNE LIGNE `dailyTotals`, NORMALISÉE, PARCE QUE SON TYPE SE TROMPE.
 *
 * ⚠ `DailyTotal.day` est déclaré `string` et n'en est PAS un à l'exécution. La colonne calculée
 * `DATE(declared_at)` n'a aucun mappeur drizzle (c'est une expression, pas une colonne typée), donc
 * mysql2 la rend telle qu'il la comprend: un objet `Date` posé à MINUIT LOCAL, le pool étant
 * configuré `dateStrings: false` (lib/db/index.ts). Vérifié sur la base le 2026-08-09:
 * `typeof === "object"`, `instanceof Date === true`. C'est exactement le piège que documente
 * `toLocalDate` dans lib/db/types.ts pour les expressions datetime, appliqué ici à une expression
 * DATE. Le typecheck ne peut rien voir: `sql<string>` est une ASSERTION, pas une conversion.
 *
 * Conséquence si on fait confiance au type: `row.day.slice(0, 10)` rendrait `"Thu Jul 3"` (les dix
 * premiers caractères du `toString()` d'une Date), donc aucune journée ne se rapprocherait de sa
 * case de calendrier et la courbe entière serait plate à zéro. On accepte donc les DEUX formes,
 * plutôt que de parier sur celle d'aujourd'hui: le jour où quelqu'un corrige le type en amont,
 * cette page continue de fonctionner sans qu'on ait à s'en apercevoir.
 */
function dayKeyOfRow(day: DailyTotal["day"]): string {
  const raw: unknown = day;
  if (raw instanceof Date) return dayKey(raw);
  return String(raw).slice(0, 10);
}

/* ── Mise en forme, TOUJOURS côté serveur ─────────────────────────────────────────────────────────
 *
 * ⚠ Aucun `Date` ne traverse jusqu'au navigateur, et aucune date n'y est formatée: un `Date`
 * sérialisé s'affiche dans LE FUSEAU DU NAVIGATEUR, donc un gérant connecté depuis un poste réglé
 * ailleurs verrait des journées décalées d'un cran par rapport aux totaux qui les accompagnent.
 * Même règle que mes-ventes/page.tsx. Ce fichier tourne dans le fuseau de MariaDB (voir
 * lib/db/types.ts), donc `getDay()`/`getDate()` en heure locale sont la bonne lecture ici.
 */

const FMT_FULL = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const FMT_DAY_MONTH = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const FMT_WEEKDAY_DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric" });
const FMT_NUMERIC = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit" });
const FMT_WEEKDAY_LONG = new Intl.DateTimeFormat("fr-FR", { weekday: "long" });
const FMT_WEEKDAY_SHORT = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * L'étiquette d'abscisse, dont la FORME suit la longueur de la fenêtre.
 *
 * Trois formats et pas un seul: "jeu. 30" se lit d'un coup sur sept points et devient une bouillie
 * sur quatre-vingt-dix, où "30/07" tient dans la place qui reste. C'est décidé ici, côté serveur,
 * parce que c'est ici qu'on connaît le fuseau (voir l'entête de ce bloc).
 */
function axisLabel(d: Date, days: number): string {
  if (days <= 14) return FMT_WEEKDAY_DAY.format(d).replace(".", "");
  if (days <= 30) return FMT_DAY_MONTH.format(d).replace(".", "");
  return FMT_NUMERIC.format(d);
}

function rangeLabel(from: Date, to: Date): string {
  const last = new Date(to.getTime() - DAY_MS); // `to` est exclusif: le dernier jour est la veille
  return `du ${FMT_DAY_MONTH.format(from).replace(".", "")} au ${FMT_DAY_MONTH.format(last).replace(".", "")}`;
}

/* ── Ce qui traverse jusqu'au navigateur ──────────────────────────────────────────────────────── */

/** Les clés de série des vendeurs. Stables et courtes: elles servent de `dataKey` à Recharts. */
const SERIES_KEYS = ["s0", "s1", "s2", "s3", "sx"] as const;

export type SellerSeries = {
  /** `s0`..`s3`, ou `sx` pour le reliquat groupé. Voir `MAX_SELLER_SERIES`. */
  key: string;
  name: string;
  totalCents: number;
  sales: number;
  /** 1 à 4: le ton de rayon qui peint cette série. `null` pour le reliquat, peint en neutre. */
  tone: number | null;
};

export type DayPoint = {
  key: string;
  /** Étiquette d'axe, déjà formatée. Voir `axisLabel`. */
  label: string;
  /** "Jeudi 30 juillet", pour l'entête de l'infobulle. */
  full: string;
  sales: number;
  totalCents: number;
  /** Le même rang de jour dans la fenêtre PRÉCÉDENTE, pour la courbe de comparaison. */
  prevCents: number;
  /** La date de ce point de comparaison, en toutes lettres. `null` s'il n'y a rien à comparer. */
  prevFull: string | null;
  /** Un montant par série de vendeur, clé = `SERIES_KEYS`. Absent = ce vendeur n'a rien vendu ce jour. */
  sellers: Record<string, number>;
};

export type RayonSlice = {
  key: string;
  label: string;
  /** 1 à 4, ou `null` pour un rayon qui n'existe plus au catalogue (ventes anciennes). */
  tone: number | null;
  qty: number;
  revenueCents: number;
  /** Part du chiffre de la période, 0 à 1. */
  share: number;
};

export type ProductRow = {
  key: string;
  label: string;
  categoryLabel: string;
  tone: number | null;
  qty: number;
  revenueCents: number;
  /** Rang sur TOUT le catalogue vendu, pas seulement sur les lignes envoyées. 1 = premier. */
  revRank: number;
  qtyRank: number;
};

export type HourPoint = { hour: number; label: string; totalCents: number; sales: number };
export type WeekdayPoint = { key: string; label: string; full: string; totalCents: number; sales: number };

export type CrewRow = {
  id: string;
  name: string;
  seconds: number;
  totalCents: number;
  sales: number;
  /** Chiffre par heure de service. `null` sous `MIN_RATED_SECONDS`: voir sa justification. */
  perHourCents: number | null;
};

export type Totals = {
  totalCents: number;
  sales: number;
  /** Panier moyen. 0 sans ticket: une moyenne sur zéro n'existe pas, elle ne vaut pas zéro. */
  avgTicketCents: number;
  commissionCents: number;
};

export type Analytics = {
  days: PeriodDays;
  rangeLabel: string;
  prevRangeLabel: string;
  cur: Totals;
  prev: Totals;
  /** `true` dès que la fenêtre précédente porte au moins une vente: sinon rien à comparer. */
  hasPrevious: boolean;
  points: DayPoint[];
  sellers: SellerSeries[];
  /** Vendeurs présents sur la période mais absents du graphe empilé (regroupés dans `sx`). */
  sellersFolded: number;
  rayons: RayonSlice[];
  products: ProductRow[];
  hours: HourPoint[];
  weekdays: WeekdayPoint[];
  /** Le jour de semaine le plus fort, et l'heure la plus forte. `null` sans vente. */
  bestWeekday: WeekdayPoint | null;
  bestHour: HourPoint | null;
  crew: CrewRow[];
  showHours: boolean;
  showCommission: boolean;
};

/**
 * Pourquoi `team.read` échoue, dans l'ordre exact où `businessCan` la refuserait.
 *
 * ⚠ NE PAS DEVINER LA CAUSE: les trois raisons sont distinctes et une seule est actionnable par la
 * personne elle-même. Le rail masque l'entrée quand le module est éteint ou le grade démuni, donc
 * il n'affiche jamais que la troisième; cette page reste joignable par URL directe, où les trois
 * redeviennent possibles. Même fonction, mot pour mot, que gestion/equipe/page.tsx.
 */
function deniedReason(access: BusinessAccess): string {
  if (access.modules.equipe === false) {
    return "Ce module n'est pas activé pour ce commerce.";
  }
  if (!access.capabilities.has(CAP.TEAM_READ)) {
    return "Votre grade ne donne pas accès aux chiffres de l'ensemble du commerce.";
  }
  return "Consultable en jeu : connectez votre personnage pour voir l'analytique.";
}

export default async function AnalytiquePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ j?: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const canRead = businessCan(access, CAP.TEAM_READ);
  const sp = await searchParams;
  const days = parseDays(sp.j);

  const data = canRead ? await buildAnalytics(access, days) : null;

  return (
    <AnalytiqueView
      name={access.name}
      canRead={canRead}
      deniedReason={canRead ? null : deniedReason(access)}
      days={days}
      periods={[...PERIODS]}
      data={data}
    />
  );
}

async function buildAnalytics(access: BusinessAccess, days: PeriodDays): Promise<Analytics> {
  const now = new Date();
  const range = lastDays(now, days);
  const prevRange = previousOf(range, days);
  const showHours = access.modules.pointage !== false;
  const showCommission = access.modules.commissions !== false;

  const [perSellerDays, prevDays, sellerRows, products, clock, hours] = await Promise.all([
    // Une seule lecture porte la courbe ET la répartition par vendeur: `bySeller` donne une ligne
    // par (jour, vendeur), et le total d'un jour est la somme de ses lignes. Sommer DES AGRÉGATS
    // n'est pas sommer une liste plafonnée: chacune de ces lignes est déjà un `SUM` sur toutes les
    // ventes du couple, donc leur addition reste exacte (voir l'entête de ce fichier).
    dailyTotals(access.businessId, range, { bySeller: true }),
    dailyTotals(access.businessId, prevRange),
    sellerTotals(access.businessId, range),
    productTotals(access.businessId, range),
    salesClock(access.businessId, range),
    // Requête sautée quand le module est éteint: rien à afficher, rien à payer.
    showHours ? shiftTotals(access.job, range) : Promise.resolve([]),
  ]);

  /* ── Les totaux des deux fenêtres ───────────────────────────────────────────────────────────── */

  const cur = totalsOf(perSellerDays);
  const prev = totalsOf(prevDays);

  /* ── Les séries de vendeurs ─────────────────────────────────────────────────────────────────── */

  /**
   * ⚠ LE CLASSEMENT VIENT DE `sellerTotals`, PAS DE LA SOMME DES JOURS. Les deux donneraient le même
   * chiffre aujourd'hui, mais `sellerTotals` porte aussi le NOM du vendeur, que `dailyTotals` ne
   * rend pas: reconstruire un classement depuis les jours obligerait à inventer un libellé pour un
   * identifiant, ou à faire une seconde requête pour l'obtenir.
   */
  const charted = sellerRows.slice(0, MAX_SELLER_SERIES);
  const folded = sellerRows.slice(MAX_SELLER_SERIES);
  const seriesOf = new Map<string, string>();
  const sellers: SellerSeries[] = charted.map((s, i) => {
    seriesOf.set(s.sellerIdentifier, SERIES_KEYS[i]!);
    return {
      key: SERIES_KEYS[i]!,
      name: s.sellerName,
      totalCents: s.totalCents,
      sales: s.sales,
      // Les quatre tons de rayon du commerce, dans l'ordre du classement: la couleur reste celle de
      // l'enseigne (voir le pont shadcn de theme.ts) au lieu d'un jeu de couleurs inventé par page.
      tone: i + 1,
    };
  });
  for (const s of folded) seriesOf.set(s.sellerIdentifier, "sx");
  if (folded.length > 0) {
    sellers.push({
      key: "sx",
      name: `${folded.length} autre${folded.length > 1 ? "s" : ""}`,
      totalCents: folded.reduce((acc, s) => acc + s.totalCents, 0),
      sales: folded.reduce((acc, s) => acc + s.sales, 0),
      tone: null,
    });
  }

  /* ── La courbe, jour par jour ───────────────────────────────────────────────────────────────── */

  const curByDay = new Map<string, { total: number; sales: number; sellers: Record<string, number> }>();
  for (const row of perSellerDays) {
    const k = dayKeyOfRow(row.day);
    let cell = curByDay.get(k);
    if (!cell) {
      cell = { total: 0, sales: 0, sellers: {} };
      curByDay.set(k, cell);
    }
    cell.total += row.totalCents;
    cell.sales += row.sales;
    const series = row.sellerIdentifier === null ? null : seriesOf.get(row.sellerIdentifier);
    if (series) cell.sellers[series] = (cell.sellers[series] ?? 0) + row.totalCents;
  }

  const prevByDay = new Map<string, number>();
  for (const row of prevDays) prevByDay.set(dayKeyOfRow(row.day), row.totalCents);

  /**
   * TOUS les jours de la fenêtre, y compris les jours creux.
   *
   * Une courbe à laquelle il manque ses jours à zéro n'est plus une courbe: Recharts espacerait
   * régulièrement des points qui ne le sont pas, et une fermeture de trois jours se lirait comme
   * une baisse d'un seul cran. Le calendrier est posé ici, la base ne le fabrique pas (elle ne
   * connaît que les jours où quelque chose s'est passé).
   */
  const points: DayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(range.from);
    d.setDate(d.getDate() + i);
    const p = new Date(prevRange.from);
    p.setDate(p.getDate() + i);

    const k = dayKey(d);
    const cell = curByDay.get(k);
    points.push({
      key: k,
      label: axisLabel(d, days),
      full: upperFirst(FMT_FULL.format(d)),
      sales: cell?.sales ?? 0,
      totalCents: cell?.total ?? 0,
      prevCents: prevByDay.get(dayKey(p)) ?? 0,
      prevFull: prev.sales > 0 ? upperFirst(FMT_FULL.format(p)) : null,
      sellers: cell?.sellers ?? {},
    });
  }

  /* ── Les rayons ─────────────────────────────────────────────────────────────────────────────── */

  const catMeta = new Map(access.categories.map((c) => [c.key, { label: c.label, tone: c.tone }]));
  const rayonMap = new Map<string, RayonSlice>();
  for (const p of products) {
    let slice = rayonMap.get(p.category);
    if (!slice) {
      const meta = catMeta.get(p.category);
      slice = {
        key: p.category,
        // Un rayon retiré du catalogue garde ses ventes: on affiche sa CLÉ plutôt que de le taire,
        // sinon son chiffre disparaîtrait du camembert et la somme des parts ne ferait plus 100 %.
        label: meta?.label ?? p.category,
        tone: meta?.tone ?? null,
        qty: 0,
        revenueCents: 0,
        share: 0,
      };
      rayonMap.set(p.category, slice);
    }
    slice.qty += p.qty;
    slice.revenueCents += p.revenueCents;
  }
  const rayons = [...rayonMap.values()].sort((a, b) => b.revenueCents - a.revenueCents);
  /**
   * ⚠ LA PART EST CALCULÉE SUR LE CHIFFRE DES LIGNES, PAS SUR CELUI DES TICKETS. Les deux devraient
   * coïncider et peuvent diverger: une vente déclarée puis vidée de ses lignes garde son total.
   * Diviser par `cur.totalCents` donnerait alors des parts qui ne somment pas à 100 % dans un
   * camembert, ce qui est précisément le genre de chiffre qu'un gérant remarque et ne peut pas
   * expliquer. On divise par ce qu'on additionne.
   */
  const rayonBase = rayons.reduce((acc, r) => acc + r.revenueCents, 0);
  for (const r of rayons) r.share = rayonBase > 0 ? r.revenueCents / rayonBase : 0;

  /* ── Les articles, DEUX classements ─────────────────────────────────────────────────────────── */

  /**
   * Les rangs sont calculés sur TOUT ce qui s'est vendu, puis seules les premières lignes partent
   * au navigateur. C'est ce qui rend la divergence lisible: un article premier en volume et
   * huitième en chiffre porte son "8e" avec lui, alors qu'un rang recalculé sur les dix lignes
   * envoyées aurait inventé un classement de dix articles.
   */
  const byRevenue = [...products].sort((a, b) => b.revenueCents - a.revenueCents || b.qty - a.qty);
  const byQty = [...products].sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents);
  const keyOf = (p: (typeof products)[number]) =>
    p.itemId === null ? `l:${p.category}|${p.label}` : `i:${p.itemId}`;
  const revRank = new Map(byRevenue.map((p, i) => [keyOf(p), i + 1]));
  const qtyRank = new Map(byQty.map((p, i) => [keyOf(p), i + 1]));

  const kept = new Map<string, ProductRow>();
  for (const p of [...byRevenue.slice(0, MAX_PRODUCTS), ...byQty.slice(0, MAX_PRODUCTS)]) {
    const key = keyOf(p);
    if (kept.has(key)) continue;
    kept.set(key, {
      key,
      label: p.label,
      categoryLabel: catMeta.get(p.category)?.label ?? p.category,
      tone: catMeta.get(p.category)?.tone ?? null,
      qty: p.qty,
      revenueCents: p.revenueCents,
      revRank: revRank.get(key) ?? 0,
      qtyRank: qtyRank.get(key) ?? 0,
    });
  }

  /* ── Quand ça vend ──────────────────────────────────────────────────────────────────────────── */

  /**
   * Les grilles sont POSÉES ENTIÈRES, puis remplies. `salesClock` ne rend que les créneaux vus (voir
   * son commentaire), donc déduire les vingt-quatre heures de la longueur du résultat produirait un
   * axe à douze barres qui prétendrait couvrir la journée.
   *
   * Les libellés de jour se déduisent d'une VRAIE date connue pour être un lundi, plutôt que d'un
   * tableau de sept chaînes écrit à la main: c'est la même locale que le reste de la page, sans une
   * seconde liste à maintenir en français.
   */
  const mondayRef = mondayReference(now);
  const weekdays: WeekdayPoint[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayRef);
    d.setDate(d.getDate() + i);
    weekdays.push({
      key: `w${i}`,
      label: upperFirst(FMT_WEEKDAY_SHORT.format(d).replace(".", "")),
      full: upperFirst(FMT_WEEKDAY_LONG.format(d)),
      totalCents: 0,
      sales: 0,
    });
  }
  const hourPoints: HourPoint[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${pad(h)} h`,
    totalCents: 0,
    sales: 0,
  }));
  for (const cell of clock) {
    const w = weekdays[cell.weekday];
    if (w) {
      w.totalCents += cell.totalCents;
      w.sales += cell.sales;
    }
    const h = hourPoints[cell.hour];
    if (h) {
      h.totalCents += cell.totalCents;
      h.sales += cell.sales;
    }
  }
  const bestWeekday = weekdays.reduce<WeekdayPoint | null>(
    (acc, w) => (w.totalCents > 0 && (!acc || w.totalCents > acc.totalCents) ? w : acc),
    null,
  );
  const bestHour = hourPoints.reduce<HourPoint | null>(
    (acc, h) => (h.totalCents > 0 && (!acc || h.totalCents > acc.totalCents) ? h : acc),
    null,
  );

  /* ── Le rendement ───────────────────────────────────────────────────────────────────────────── */

  /**
   * ⚠ RAPPROCHEMENT EN MÉMOIRE, jamais en SQL: `lifeinvader_business_sales` (collation du panel, utf8mb4_general_ci) et
   * `lifeinvader_business_shifts` sont deux lectures déjà cloisonnées chacune de son côté, l'une par
   * `business_id` et l'autre par `job` (voir shifts.ts, les pointages ne connaissent pas le
   * commerce). Une `Map` par identifiant est le seul rapprochement demandé. Même choix, et même
   * justification, que gestion/equipe/page.tsx.
   *
   * ⚠ QUELQU'UN QUI A POINTÉ SANS RIEN VENDRE COMPTE. L'omettre ferait remonter la moyenne de
   * l'équipe en cachant précisément le cas que le gérant cherche.
   */
  const crewMap = new Map<string, CrewRow>();
  for (const s of sellerRows) {
    crewMap.set(s.sellerIdentifier, {
      id: s.sellerIdentifier,
      name: s.sellerName,
      seconds: 0,
      totalCents: s.totalCents,
      sales: s.sales,
      perHourCents: null,
    });
  }
  for (const h of hours) {
    const row = crewMap.get(h.identifier);
    if (row) row.seconds = h.seconds;
    else {
      crewMap.set(h.identifier, {
        id: h.identifier,
        name: h.name,
        seconds: h.seconds,
        totalCents: 0,
        sales: 0,
        perHourCents: null,
      });
    }
  }
  const crew = [...crewMap.values()];
  for (const row of crew) {
    row.perHourCents =
      row.seconds >= MIN_RATED_SECONDS ? Math.round((row.totalCents * 3600) / row.seconds) : null;
  }
  crew.sort(
    (a, b) =>
      (b.perHourCents ?? -1) - (a.perHourCents ?? -1) ||
      b.totalCents - a.totalCents ||
      a.name.localeCompare(b.name, "fr"),
  );

  return {
    days,
    rangeLabel: rangeLabel(range.from, range.to),
    prevRangeLabel: rangeLabel(prevRange.from, prevRange.to),
    cur,
    prev,
    hasPrevious: prev.sales > 0,
    points,
    sellers,
    sellersFolded: folded.length,
    rayons,
    products: [...kept.values()],
    hours: hourPoints,
    weekdays,
    bestWeekday,
    bestHour,
    crew,
    showHours,
    showCommission,
  };
}

/** Le lundi de la semaine courante, uniquement pour NOMMER les sept jours dans la bonne locale. */
function mondayReference(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay(): 0 = dimanche, donc 6 jours depuis lundi
  return d;
}

/** Le total d'une fenêtre, depuis ses agrégats journaliers. Voir l'entête: jamais depuis une liste. */
function totalsOf(rows: DailyTotal[]): Totals {
  let totalCents = 0;
  let sales = 0;
  let commissionCents = 0;
  for (const r of rows) {
    totalCents += r.totalCents;
    sales += r.sales;
    commissionCents += r.commissionCents;
  }
  return {
    totalCents,
    sales,
    avgTicketCents: sales > 0 ? Math.round(totalCents / sales) : 0,
    commissionCents,
  };
}
