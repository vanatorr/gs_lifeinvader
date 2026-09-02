import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug, type BusinessAccess } from "@/lib/business/access";
import { visualFor } from "@/lib/business/art";
import { CAP } from "@/lib/business/capabilities";
import { listItems } from "@/lib/business/catalogue";
import { dailyTotals, listSales, saleLines, topProducts } from "@/lib/business/sales";
import { templateMeasuresCost } from "@/lib/business/templates";
import { listShifts } from "@/lib/business/shifts";
import { clientRecordView, type ClientRecordView } from "@/lib/business/clientRecord";
import MesVentesView from "./MesVentesView";

export const dynamic = "force-dynamic";

/**
 * MES VENTES: ses propres tickets, ses propres heures, rien d'autre.
 *
 * ⚠ LA PAGE RE-RÉSOUT SON ACCÈS ELLE-MÊME, même règle que caisse/page.tsx: la mise en page parente
 * n'est pas une frontière, Next peut rendre cette page sans elle lors d'une navigation côté client.
 *
 * `sale.read.self` est au palier SESSION (voir capabilities.ts): un employé hors ligne consulte sa
 * paie depuis son téléphone. C'est aussi la capacité par défaut du repli jour-un, donc n'y arriver
 * jamais veut dire que la direction l'a explicitement retirée à ce grade dans les Réglages. Dans ce
 * cas on NE LIT RIEN: la lecture elle-même est gardée, pas seulement son affichage.
 *
 * LA PAGE RÉPOND À TROIS QUESTIONS, dans cet ordre, et sa mise en page est cet ordre:
 *   1. combien j'ai fait      → le total de la période, seul et en gros, plus le rythme des 7 jours;
 *   2. qu'est-ce que je vends → la répartition par rayon puis le classement des articles, DESSINÉS;
 *   3. combien on me doit     → la part employé, dans sa propre boîte et jamais mêlée au chiffre.
 * Les tickets viennent après, groupés par journée: ils servent à vérifier, pas à découvrir.
 *
 * ⚠⚠ TOUT CHIFFRE DE CETTE PAGE VIENT D'UN AGRÉGAT SQL, PLUS JAMAIS D'UNE SOMME DE `listSales`.
 * C'était le défaut central corrigé le 2026-08-09, et il était SILENCIEUX. `listSales` est une
 * lecture d'AFFICHAGE plafonnée (`limit: Math.min(opts.limit ?? 200, 500)`, voir sales.ts): au-delà
 * du plafond elle ne rend QUE les ventes les plus RÉCENTES. La page additionnait ce tableau pour
 * produire le total de la période, le chiffre du jour, la semaine en barres, le classement des
 * articles, `itemsSold` et la commission - donc, dès qu'un vendeur dépassait 200 ventes sur la
 * fenêtre, chacun de ces nombres était la somme d'une FRACTION de la période, sans erreur, sans
 * avertissement, et sans rien à l'écran qui puisse le laisser deviner.
 *
 * Mesuré en base le 2026-08-09 sur `Bar du Vigneron` (business 21), semaine du 3 août, vendeur
 * `3f4649d5…`: la page affichait 36 156 $ pour un vrai total de 56 138 $, soit 35,6 % de moins.
 * L'autre vendeur de la même semaine (473 ventes) affichait 35 823 $ pour 87 841 $, soit 59,2 % de
 * moins. C'est le montant qu'un employé lit pour vérifier sa paie.
 *
 * Les totaux viennent donc de `dailyTotals` (SUM/COUNT groupés par `DATE(declared_at)` sur TOUTES
 * les lignes) et le classement de `topProducts` (SUM sur les lignes de vente jointes aux ventes).
 * `listSales` garde son plafond et ne sert plus qu'à CHOISIR QUELS TICKETS AFFICHER dans le journal,
 * ce qui est son rôle correct. Le journal dit alors combien il en montre sur combien il y en a
 * (`listedCount` face à `ticketCount`), plutôt que de laisser croire qu'il les montre tous.
 */
export default async function MesVentesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const canRead = businessCan(access, CAP.SALE_READ_SELF);
  const showHours = access.modules.pointage !== false;
  const showCommission = access.modules.commissions !== false;
  /**
   * ⚠ LE BENEFICE NE S'AFFICHE QUE LA OU IL EST MESURE (`templateMeasuresCost`). Le vendeur d'une
   * concession doit voir sur quoi sa part est calculee; un barman n'a aucun cout de revient
   * enregistre et verrait un "0 $" qui ne veut rien dire.
   */
  const showMargin = templateMeasuresCost(access.template);

  let periods: { cur: PeriodView; prev: PeriodView } | null = null;
  let visuals: Record<string, Visual> = {};
  if (canRead) {
    const now = new Date();
    const curFrom = mondayOfWeek(now);
    const curTo = addDays(curFrom, 7);
    const prevFrom = addDays(curFrom, -7);

    const book = visualBook();
    const look = await lookups(access);

    // ⚠ SÉQUENTIEL, PAS `Promise.all`, et c'est la seule raison: les deux périodes ALIMENTENT le
    // même carnet de dessins, et deux écritures concurrentes dans la même Map se marcheraient
    // dessus. Le coût est nul à cette échelle (deux semaines d'un seul vendeur, et les lectures
    // internes à une période sont, elles, bien parallélisées).
    const cur = await buildPeriod(access, { from: curFrom, to: curTo }, now, showHours, look, book);
    const prev = await buildPeriod(access, { from: prevFrom, to: curFrom }, now, showHours, look, book);

    /**
     * LA COMPARAISON D'UNE SEMAINE SUR L'AUTRE, POSÉE ICI ET NULLE PART AILLEURS.
     *
     * Les deux fenêtres sont calées sur LUNDI et font exactement sept jours, donc l'indice `i` est le
     * MÊME JOUR DE LA SEMAINE dans les deux: le lundi se compare au lundi, pas à "sept lignes plus
     * haut dans un tableau". C'est ce qui rend la seconde courbe du graphe lisible plutôt que
     * décorative, et c'est aussi pourquoi elle se calcule ici, où les deux périodes existent, au lieu
     * de faire relire une troisième fenêtre à `buildPeriod`.
     *
     * ⚠ DANS UN SEUL SENS. La semaine dernière ne reçoit PAS la semaine en cours comme comparaison:
     * ce serait comparer une semaine finie à une semaine en cours de constitution, donc annoncer une
     * baisse à quelqu'un qui n'a simplement pas encore fini sa semaine. Même règle que `deltaPct`
     * dans la vue, qui se tait sur la période précédente pour exactement cette raison.
     */
    for (let i = 0; i < cur.week.length; i++) {
      const day = cur.week[i];
      const before = prev.week[i];
      if (day && before) day.prevCents = before.totalCents;
    }

    periods = { cur, prev };
    visuals = book.dict;
  }

  return (
    <MesVentesView
      employeeName={access.employeeName}
      gradeName={access.gradeName}
      canRead={canRead}
      showCommission={showCommission}
      showMargin={showMargin}
      showHours={showHours}
      periods={periods}
      visuals={visuals}
    />
  );
}

/* ── Fenêtres de période ──────────────────────────────────────────────────────────────────────────
 *
 * Semaines calées sur LUNDI, même convention que dayBitFromJsDay (lib/data/serverControlModel.ts):
 * c'est celle que le reste de CITADEL affiche déjà en français. `getDay()`/`getDate()` en HEURE
 * LOCALE sont corrects ici sans passer par Intl: ce fichier tourne côté serveur, et lib/db/types.ts
 * établit que le processus Node partage le fuseau de MariaDB (America/Toronto). Les dates lues depuis
 * `declaredAt`/`startedAt` sont donc déjà "locales" au sens où `new Date()` l'est ici même.
 */

function mondayOfWeek(d: Date): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const sinceMonday = (day.getDay() + 6) % 7; // getDay(): 0 = dimanche, donc 6 jours depuis lundi
  day.setDate(day.getDate() - sinceMonday);
  return day;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-08-09`, la clé de regroupement d'une journée. Locale, comme tout le reste de ce fichier. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * LA MÊME CLÉ, DEPUIS CE QUE `dailyTotals` RETOURNE VRAIMENT.
 *
 * `DailyTotal.day` est typé `string` et l'EST bel et bien depuis le 2026-08-09: sales.ts groupe sur
 * `DATE_FORMAT(declared_at, '%Y-%m-%d')`. Cette fonction accepte quand même les deux formes, et ce
 * n'est pas de la superstition, c'est le souvenir d'une panne mesurée le jour même.
 *
 * ⚠⚠ CE QUE CETTE FONCTION EMPÊCHE DE REVENIR. Le regroupement s'écrivait `DATE(declared_at)`, qui
 * donne le bon jour en SQL mais revient en objet `Date` côté JavaScript (le pilote tourne en
 * `dateStrings: false`, et une EXPRESSION n'a aucun mapper drizzle, contrairement à une colonne).
 * `sql<string>` étant une ASSERTION de type et jamais une conversion, tsc validait sereinement du
 * code qui rangeait des objets `Date` dans une Map lue avec des clés `"2026-08-09"`: la Map ne
 * trouvait RIEN, chaque journée du graphe retombait à zéro, et ça se lisait comme une semaine creuse
 * plutôt que comme un bug. Aucune exception, aucun avertissement.
 *
 * Le correctif est à la source (dans sales.ts), donc ceci est une ceinture, pas la bretelle: le
 * prochain agrégat de jour écrit à la va-vite avec `DATE()` ne pourra pas faire retomber CETTE page
 * à zéro en silence. `unknown` en entrée plutôt que `string`, sinon TypeScript refuse le test
 * `instanceof` sur un type qu'il croit déjà primitif.
 */
function dayKeyOf(day: unknown): string {
  if (day instanceof Date) return dayKey(day);
  return String(day).slice(0, 10);
}

/**
 * TOUT CE QUI EST DATÉ EST FORMATÉ ICI, CÔTÉ SERVEUR, et jamais dans la vue cliente: un `Date`
 * envoyé au navigateur s'affiche dans LE FUSEAU DU NAVIGATEUR, pas celui du serveur, et un employé
 * qui consulte depuis un poste réglé sur un autre fuseau verrait une heure fausse. Une chaîne déjà
 * formée n'a plus ce problème.
 *
 * ⚠ Ça vaut AUSSI pour les étiquettes du graphe. La maquette shadcn officielle formate ses dates
 * dans le `tickFormatter`/`labelFormatter` côté client (`new Date(value).toLocaleDateString(...)`);
 * ici ce serait doublement faux, parce que `new Date("2026-08-03")` (forme ISO courte) est parsé en
 * UTC par la spec et retombe donc sur la VEILLE dès que le navigateur est à l'ouest de Greenwich.
 * Les libellés du graphe voyagent déjà formés, dans `WeekBar.label`.
 */
const FMT_DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const FMT_SHORT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Aujourd'hui" / "Hier" / "Vendredi 8 août". */
function dayLabel(d: Date, now: Date): string {
  if (isSameLocalDay(d, now)) return "Aujourd'hui";
  if (isSameLocalDay(d, addDays(now, -1))) return "Hier";
  return upperFirst(FMT_DAY.format(d));
}

/** "du 4 au 10 août", ou "du 28 juillet au 3 août" à cheval sur deux mois. */
function rangeLabel(from: Date, to: Date): string {
  const last = addDays(to, -1); // `to` est exclusif (voir listSales), donc le dernier jour est la veille
  return `du ${FMT_SHORT.format(from)} au ${FMT_SHORT.format(last)}`;
}

/* ── Ce qui traverse jusqu'au navigateur ──────────────────────────────────────────────────────── */

export type Visual = { svg: string; kind: "art" | "icon" };

/** Une ligne d'un ticket, prête à dessiner. `vis` indexe le carnet, jamais un contenu. */
export type LineView = {
  key: string;
  qty: number;
  label: string;
  vis: string;
  tone: number;
};

export type TicketView = {
  publicRef: string;
  /** "14:32". Formaté serveur, voir plus haut. */
  time: string;
  amountCents: number;
  commissionCents: number;
  /** Le benefice mesurable du ticket. Voir `margin_cents` dans le schema: 0 = non mesure. */
  marginCents: number;
  lines: LineView[];
  /** Lignes non affichées faute de place sur la carte. 0 quand tout tient. */
  hidden: number;
  /**
   * LA FICHE CLIENT du ticket, ou null quand il n'en porte pas.
   *
   * ⚠ MISE EN FORME PAR `clientRecordView`, la MÊME fonction que la fiche de paie du gérant. Deux
   * mises en forme écrites séparément finiraient par décrire différemment le même ticket, et un
   * document qui se contredit selon l'écran est un document qu'on cesse de lire.
   */
  client: ClientRecordView | null;
};

export type DayView = {
  key: string;
  label: string;
  /** Le VRAI total de la journée (agrégat SQL), même quand le journal n'en liste qu'une partie. */
  totalCents: number;
  /** Le VRAI nombre de tickets de la journée. Comparer à `tickets.length` dit si le journal tronque. */
  ticketCount: number;
  tickets: TicketView[];
};

export type ProductView = {
  key: string;
  label: string;
  categoryLabel: string;
  tone: number;
  vis: string;
  qty: number;
  revenueCents: number;
  /** Part de la barre, 0 à 1, relative au PREMIER du classement. Comparaison, pas mesure. */
  share: number;
};

/**
 * UN RAYON DE LA PÉRIODE: ce que la personne vend, vu de haut.
 *
 * Distinct du classement d'articles juste au-dessus, et ce n'est pas la même question: le classement
 * dit QUEL article part le plus, la répartition dit DE QUOI est fait le chiffre. Un employé qui vend
 * surtout de la cuisine et un employé qui vend surtout du vin peuvent avoir exactement le même
 * article en tête de classement.
 */
export type RayonView = {
  key: string;
  label: string;
  /** 1 à 4, l'indice du ton de rayon de l'enseigne (voir toneVars / le pont shadcn de theme.ts). */
  tone: number;
  qty: number;
  revenueCents: number;
  /** Part du chiffre articles de la période, 0 à 1. */
  share: number;
};

export type WeekBar = {
  /** `2026-08-03`. UNIQUE, donc utilisable comme abscisse: `letter` ne l'est pas (deux "M"). */
  key: string;
  letter: string;
  /** "Lundi 3 août" / "Aujourd'hui". Déjà formaté (voir FMT_DAY): la vue ne formate aucune date. */
  label: string;
  totalCents: number;
  ticketCount: number;
  /**
   * Le MÊME JOUR DE LA SEMAINE sur la période précédente, ou `null` quand il n'y a rien à comparer
   * (période précédente elle-même, ou pas d'antécédent chargé). Posé par la page, voir le
   * commentaire de la boucle qui l'écrit.
   */
  prevCents: number | null;
  /** Hauteur relative au meilleur jour de la période, 0 à 1. */
  share: number;
  today: boolean;
};

export type PeriodView = {
  rangeLabel: string;
  totalCents: number;
  /** Le VRAI nombre de tickets de la période (agrégat), pas le nombre de tickets listés. */
  ticketCount: number;
  /** Combien le journal en montre vraiment. Inférieur à `ticketCount` sur une période chargée. */
  listedCount: number;
  /** Panier moyen. 0 quand il n'y a aucun ticket: une moyenne sur zéro n'existe pas. */
  avgTicketCents: number;
  todaySumCents: number;
  todayCount: number;
  commissionCents: number;
  /** Le benefice mesurable de la periode, agrege en SQL comme le reste. */
  marginCents: number;
  hoursSeconds: number;
  itemsSold: number;
  /** Articles DISTINCTS vendus, dont `products` ne montre que les premiers. */
  productCount: number;
  /** Journées de la période où quelque chose a été vendu. Sert à savoir si "meilleur jour" a un sens. */
  activeDays: number;
  days: DayView[];
  week: WeekBar[];
  bestDay: { label: string; totalCents: number } | null;
  products: ProductView[];
  rayons: RayonView[];
};

/** Combien d'articles au classement. Au delà, la liste déborde du panneau et se met à défiler. */
const MAX_PRODUCTS = 6;

/**
 * COMBIEN DE TICKETS LE JOURNAL VA CHERCHER.
 *
 * ⚠ C'EST UN PLAFOND D'AFFICHAGE, PLUS UNE BASE DE CALCUL, et c'est toute la correction du
 * 2026-08-09 (voir l'entête du fichier). Il est nommé ici pour que l'endroit qui écrit "les N plus
 * récents" dans la vue et l'endroit qui borne la requête soient le MÊME endroit: un plafond écrit en
 * dur dans `listSales` et une phrase écrite en dur dans le JSX finiraient par ne plus se
 * correspondre, et la page mentirait à nouveau, en plus petit.
 *
 * 200 est la valeur par défaut de `listSales`, conservée: le journal se lit en défilant, personne ne
 * descend soixante tickets, et le coût (une requête `saleLines` par ticket, mesurée à ~18 ms pour
 * 200 en local) ne justifie pas de le baisser au prix d'un journal plus court.
 */
const JOURNAL_TICKETS = 200;

/**
 * COMBIEN DE LIGNES DESSINÉES PAR TICKET, ET POURQUOI CE N'EST PAS UNE CONSTANTE.
 *
 * Le plafond existe pour qu'une semaine chargée reste lisible: soixante tickets détaillés ligne à
 * ligne redeviennent le mur de texte que cette page remplace. Mais sur une semaine calme il n'y a
 * rien à protéger, et masquer le détail derrière "et 2 autres articles" dans un panneau qui a de la
 * place libre est le pire des deux mondes: la place ne sert à rien ET l'information manque. La
 * densité du contenu suit donc le volume, ce qui est aussi ce qui fait tenir la composition dans le
 * cas creux, celui que ce commerce connaît le plus souvent (un employé, quelques tickets).
 */
const QUIET_WEEK_TICKETS = 8;
const LINES_QUIET = 8;
const LINES_BUSY = 3;
/** Les sept jours d'une semaine calée sur lundi. Deux "M": la convention française l'assume. */
const DAY_LETTERS = ["L", "M", "M", "J", "V", "S", "D"];

/**
 * LE CARNET DE DESSINS.
 *
 * ⚠ ON ENVOIE UN INDEX, PAS LE DESSIN, LIGNE PAR LIGNE. Un même article revient sur des dizaines de
 * tickets; sérialiser son SVG à chaque fois gonflerait la charge utile de la page d'un facteur dix
 * pour un contenu strictement identique. Le carnet le sérialise UNE FOIS et chaque ligne le désigne.
 *
 * ⚠ ET C'EST AUSSI CE QUI GARDE L'INVARIANT DE `art.ts`: les valeurs du carnet sortent UNIQUEMENT
 * des tables figées `PRODUCT_ART` / `CATEGORY_ICONS`, jamais de la base. `artKey` et l'icône de rayon
 * sont des chaînes stockées, donc potentiellement n'importe quoi, et elles ne servent ici qu'à
 * CHERCHER dans ces tables; une clé inconnue retombe sur le repli. C'est la seule raison pour
 * laquelle la vue peut les rendre par `dangerouslySetInnerHTML` (même distinction index/contenu que
 * la faille de palette du 2026-08-08).
 */
function visualBook() {
  const dict: Record<string, Visual> = {};
  const bySvg = new Map<string, string>();
  return {
    dict,
    ref(artKey: string | null | undefined, icon: string | null | undefined): string {
      const v = visualFor(artKey, icon);
      let id = bySvg.get(v.svg);
      if (!id) {
        id = `v${bySvg.size}`;
        bySvg.set(v.svg, id);
        dict[id] = v;
      }
      return id;
    },
  };
}

type Lookups = {
  /** itemId → clé de dessin de l'article, si l'article existe encore au catalogue. */
  art: Map<number, string | null>;
  /** clé de rayon → son libellé, sa teinte et son icône de repli. */
  cats: Map<string, { label: string; tone: number; icon?: string }>;
};

/**
 * De quoi DESSINER une ligne de vente: la clé d'illustration de l'article et le rayon dont elle
 * tire sa couleur.
 *
 * ⚠ CETTE LECTURE N'OUVRE AUCUN DROIT SUR LE CATALOGUE. `listItems` rend aussi les prix, mais rien
 * d'autre que `artKey` ne quitte cette fonction: la vue reçoit un identifiant de dessin, pas un
 * tarif. Un employé sans `catalogue.read` voit donc ses propres ventes illustrées sans rien
 * apprendre de la carte des prix. Le prix qu'il voit sur ses tickets est celui de SA vente, copié
 * sur la ligne au moment où il l'a déclarée (voir declareSale), pas celui du catalogue d'aujourd'hui.
 *
 * `includeInactive`: un article archivé garde ses ventes passées (voir setItemActive), et son
 * historique mérite son dessin. Un article carrément supprimé retombe sur l'icône de son rayon,
 * puis sur `box`: `visualFor` ne laisse jamais de trou.
 */
async function lookups(access: BusinessAccess): Promise<Lookups> {
  const items = await listItems(access.businessId, { includeInactive: true });
  const cats = new Map(access.categories.map((c) => [c.key, { label: c.label, tone: c.tone, icon: c.icon }]));
  return { art: new Map(items.map((it) => [it.id, it.artKey])), cats };
}

/**
 * Une période complète.
 *
 * `seller`/`identifier` sont TOUJOURS l'employé courant: voir sales.ts et shifts.ts, aucune des deux
 * lectures n'accepte de lister un collègue depuis ce fichier. Lire les chiffres d'autrui est
 * `team.read`, une autre capacité et une autre page.
 *
 * TROIS LECTURES, TROIS RÔLES QUI NE SE MÉLANGENT PLUS:
 *   `dailyTotals` → TOUS les montants et TOUS les comptes (SUM/COUNT en SQL sur la période entière);
 *   `topProducts` → le classement et la répartition par rayon (SUM sur les lignes, période entière);
 *   `listSales`   → uniquement QUELS tickets afficher, plafonné, et rien d'autre.
 * Voir l'entête du fichier pour ce que coûtait de confondre les trois.
 *
 * ⚠ "Aujourd'hui" se déduit de l'agrégat par journée, sans requête séparée: la période "en cours"
 * contient forcément aujourd'hui, et sur "semaine dernière" la clé du jour n'existe honnêtement pas
 * dans la fenêtre (la vue n'affiche alors pas la mention plutôt que d'afficher un zéro qui
 * ressemblerait à une mauvaise journée).
 *
 * ⚠ N+1 ASSUMÉ, PAS UN OUBLI, et désormais BORNÉ POUR DE BON. `saleLines` n'a pas de forme
 * "plusieurs ventes à la fois" (lu dans sales.ts, jamais réécrit ici). Ce qui a changé le
 * 2026-08-09, c'est que le nombre de tickets lus est maintenant un CHOIX D'AFFICHAGE assumé
 * (`JOURNAL_TICKETS`) et non plus la base des calculs: allonger ou raccourcir le journal ne peut
 * plus déplacer un seul montant de la page. Mesuré: 200 appels en parallèle, ~18 ms en local.
 */
async function buildPeriod(
  access: BusinessAccess,
  range: { from: Date; to: Date },
  now: Date,
  showHours: boolean,
  look: Lookups,
  book: ReturnType<typeof visualBook>,
): Promise<PeriodView> {
  const [daily, prods, sales] = await Promise.all([
    dailyTotals(access.businessId, range, { seller: access.identifier }),
    topProducts(access.businessId, range, access.identifier),
    listSales(access.businessId, {
      seller: access.identifier,
      from: range.from,
      to: range.to,
      limit: JOURNAL_TICKETS,
    }),
  ]);
  const lineSets = await Promise.all(sales.map((s) => saleLines(access.businessId, s.id)));

  /* ── Les montants, tous depuis l'agrégat ─────────────────────────────────────────────────────── */

  const byDay = new Map<string, { sales: number; totalCents: number; commissionCents: number }>();
  let totalCents = 0;
  let commissionCents = 0;
  let marginCents = 0;
  let ticketCount = 0;
  for (const r of daily) {
    // ⚠ `dayKeyOf` et pas `r.day`: la colonne agrégée arrive en `Date` malgré son type. Voir sa
    // propre documentation, c'est un mensonge de type qui coûte tout le graphe s'il passe.
    byDay.set(dayKeyOf(r.day), { sales: r.sales, totalCents: r.totalCents, commissionCents: r.commissionCents });
    totalCents += r.totalCents;
    commissionCents += r.commissionCents;
    marginCents += r.marginCents;
    ticketCount += r.sales;
  }

  const todayRow = byDay.get(dayKey(now));
  const todaySumCents = todayRow?.totalCents ?? 0;
  const todayCount = todayRow?.sales ?? 0;

  /* ── Le classement des articles et la répartition par rayon ──────────────────────────────────── */

  let itemsSold = 0;
  const rayonAcc = new Map<string, { qty: number; revenueCents: number }>();
  for (const p of prods) {
    itemsSold += p.qty;
    const cur = rayonAcc.get(p.category);
    if (cur) {
      cur.qty += p.qty;
      cur.revenueCents += p.revenueCents;
    } else {
      rayonAcc.set(p.category, { qty: p.qty, revenueCents: p.revenueCents });
    }
  }

  /**
   * ⚠ LA PART D'UN RAYON SE MESURE SUR LE CHIFFRE DES ARTICLES, PAS SUR `totalCents`.
   *
   * Les deux devraient être égaux (le total d'un ticket est calculé depuis ses lignes au moment de
   * la déclaration, voir declareSale), mais rien ne le GARANTIT dans la base: un ticket dont les
   * lignes auraient disparu porte un total sans lignes. Diviser par `totalCents` ferait alors des
   * parts qui ne somment pas à 100 % sans qu'on sache pourquoi. Diviser par le chiffre réellement
   * réparti donne une répartition qui se lit toujours comme une répartition.
   */
  const rayonBase = [...rayonAcc.values()].reduce((acc, r) => acc + r.revenueCents, 0);
  const rayons: RayonView[] = [...rayonAcc.entries()]
    .map(([key, r]) => {
      const cat = look.cats.get(key);
      return {
        key,
        label: cat?.label ?? key,
        tone: cat?.tone ?? 1,
        qty: r.qty,
        revenueCents: r.revenueCents,
        share: rayonBase > 0 ? r.revenueCents / rayonBase : 0,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);

  /**
   * ⚠ ON TRIE ET ON COUPE AVANT DE DEMANDER LES DESSINS. `book.ref` sérialise un SVG dans la charge
   * utile de la page; l'appeler pour les cent articles de la période pour n'en afficher que six
   * enverrait au navigateur des dessins que personne ne verra. Le carnet dédoublonne par contenu,
   * donc le surcoût réel est plafonné, mais "ne pas envoyer ce qui ne sert pas" reste la règle.
   *
   * ⚠ `topProducts` a DÉJÀ fait le regroupement délicat (par `item_id` quand il existe, par
   * `(category, label)` sinon, pour qu'une ligne dont l'article a disparu du catalogue ne fusionne
   * pas avec les autres orphelines). On ne le refait pas ici: la clé composite est reconstruite à
   * l'identique, uniquement pour servir de clé React stable.
   */
  const ranked: ProductView[] = [...prods]
    .sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents)
    .slice(0, MAX_PRODUCTS)
    .map((p) => {
      const cat = look.cats.get(p.category);
      return {
        key: p.itemId === null ? `l:${p.category}|${p.label}` : `i:${p.itemId}`,
        // Le libellé est la COPIE datée portée par la ligne (voir declareSale): c'est le nom sous
        // lequel la vente a eu lieu, pas celui d'aujourd'hui.
        label: p.label,
        categoryLabel: cat?.label ?? p.category,
        tone: cat?.tone ?? 1,
        vis: book.ref(p.itemId === null ? null : (look.art.get(p.itemId) ?? null), cat?.icon),
        qty: p.qty,
        revenueCents: p.revenueCents,
        share: 0,
      };
    });
  const topQty = ranked[0]?.qty ?? 0;
  for (const p of ranked) p.share = topQty > 0 ? p.qty / topQty : 0;

  /* ── Le journal: les tickets réellement affichés ─────────────────────────────────────────────── */

  const days = new Map<string, DayView>();
  const lineCap = sales.length <= QUIET_WEEK_TICKETS ? LINES_QUIET : LINES_BUSY;

  for (let i = 0; i < sales.length; i++) {
    const s = sales[i]!;
    const lines = lineSets[i] ?? [];

    const drawn: LineView[] = [];
    for (const l of lines) {
      const cat = look.cats.get(l.category);
      const vis = book.ref(l.itemId === null ? null : (look.art.get(l.itemId) ?? null), cat?.icon);
      drawn.push({ key: `${s.id}:${l.id}`, qty: l.qty, label: l.label, vis, tone: cat?.tone ?? 1 });
    }

    const dk = dayKey(s.declaredAt);
    let day = days.get(dk);
    if (!day) {
      const agg = byDay.get(dk);
      day = {
        key: dk,
        label: dayLabel(s.declaredAt, now),
        // ⚠ LE TOTAL ET LE COMPTE DE LA JOURNÉE VIENNENT DE L'AGRÉGAT, pas des tickets listés en
        // dessous. Sur une journée tronquée par le plafond du journal, additionner ce qui est
        // affiché donnerait une entête de journée plus basse que la somme des journées voisines,
        // sans rien qui l'explique. La vue dit combien de tickets elle montre quand elle en montre
        // moins qu'il n'y en a.
        totalCents: agg?.totalCents ?? 0,
        ticketCount: agg?.sales ?? 0,
        tickets: [],
      };
      days.set(dk, day);
    }
    day.tickets.push({
      publicRef: s.publicRef,
      time: `${pad(s.declaredAt.getHours())}:${pad(s.declaredAt.getMinutes())}`,
      amountCents: s.totalCents,
      marginCents: s.marginCents,
      commissionCents: s.commissionCents,
      lines: drawn.slice(0, lineCap),
      hidden: Math.max(0, drawn.length - lineCap),
      client: clientRecordView(s.client),
    });
  }

  // `listSales` rend déjà du plus récent au plus ancien, donc les journées naissent dans cet ordre
  // et les tickets d'une journée aussi: rien à retrier.
  const dayList = [...days.values()];

  /* ── Les sept jours de la fenêtre ────────────────────────────────────────────────────────────── */

  // TOUJOURS les sept, y compris ceux à zéro: une semaine à laquelle il manque les jours creux ne se
  // lit plus comme une semaine, et une courbe qui saute un jour ment sur sa pente.
  const bestOfWeek = Math.max(0, ...daily.map((r) => r.totalCents));
  const week: WeekBar[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(range.from, i);
    const k = dayKey(d);
    const agg = byDay.get(k);
    const cents = agg?.totalCents ?? 0;
    week.push({
      key: k,
      letter: DAY_LETTERS[i]!,
      label: dayLabel(d, now),
      totalCents: cents,
      ticketCount: agg?.sales ?? 0,
      prevCents: null,
      share: bestOfWeek > 0 ? cents / bestOfWeek : 0,
      today: isSameLocalDay(d, now),
    });
  }

  // Le meilleur jour se lit dans le tableau qu'on vient de construire plutôt que de reformater une
  // date depuis l'agrégat: `week` porte déjà le libellé français de chaque journée, et les sept
  // couvrent toute la période par construction.
  const best = week.reduce<WeekBar | null>(
    (acc, w) => (w.totalCents > 0 && (!acc || w.totalCents > acc.totalCents) ? w : acc),
    null,
  );

  // Le pointage est clé par MÉTIER (voir shifts.ts), et `access.job` en vient déjà: lire un job
  // arbitraire ici lirait le pointage d'une autre entreprise, donc on ne passe jamais autre chose.
  const hoursSeconds = showHours
    ? (
        await listShifts(access.job, { from: range.from, to: range.to, identifier: access.identifier })
      ).reduce((acc, sft) => acc + sft.seconds, 0)
    : 0;

  return {
    rangeLabel: rangeLabel(range.from, range.to),
    totalCents,
    ticketCount,
    listedCount: sales.length,
    avgTicketCents: ticketCount > 0 ? Math.round(totalCents / ticketCount) : 0,
    todaySumCents,
    todayCount,
    commissionCents,
    marginCents,
    hoursSeconds,
    itemsSold,
    productCount: prods.length,
    activeDays: daily.length,
    days: dayList,
    week,
    bestDay: best ? { label: best.label, totalCents: best.totalCents } : null,
    products: ranked,
    rayons,
  };
}
