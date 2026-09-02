import { notFound } from "next/navigation";
import { requireIdentity } from "@/lib/auth/session";
import { businessCan, getBusinessBySlug } from "@/lib/business/access";
import { CAP } from "@/lib/business/capabilities";
import { moduleOfCapability } from "@/lib/business/modules";
import { employeesForJob, type RosterMember } from "@/lib/business/roster";
import { listShifts, onDutyNow, shiftTotals, type ShiftTotals } from "@/lib/business/shifts";
import PointageView, {
  type DayCell,
  type PointageShift,
  type TotalsRow,
} from "./PointageView";

export const dynamic = "force-dynamic";

/**
 * LE POINTAGE.
 *
 * ⚠ LA PAGE RE-RÉSOUT SON ACCÈS: `getBusinessBySlug` puis `notFound()` si absent, même si la mise en
 * page parente l'a déjà fait. Next peut rendre cette page sans son layout lors d'une navigation
 * côté client, donc rien en amont ne protège ce fichier tout seul.
 *
 * ⚠ DEUX PALIERS DISTINCTS, PAS UN SEUL. Lire la frise exige `SHIFT_READ` (palier "en jeu": on ne
 * consulte pas le rendement des collègues depuis son lit). Corriger un pointage exige `SHIFT_EDIT`
 * (palier "en service", en plus du droit). Un grade qui détient SHIFT_READ mais pas SHIFT_EDIT voit
 * tout, avec le formulaire de correction PRÉSENT, désactivé, et son motif écrit à côté.
 * Un grade qui n'a même pas SHIFT_READ, ou qui l'a mais n'est pas en jeu, ne reçoit AUCUNE donnée:
 * la page se ferme et explique pourquoi, elle n'affiche jamais une frise vide qui laisserait croire
 * qu'il ne s'est rien passé.
 *
 * ⚠ TOUTE LA GÉOMÉTRIE DE LA FRISE EST CALCULÉE À PARTIR DE `seconds`, jamais de l'heure courante.
 * Un service ouvert se termine, sur la frise comme dans les totaux, à son DERNIER HEARTBEAT: c'est
 * la seule fin honnête, et c'est exactement ce que `lib/business/shifts.ts` existe pour garantir.
 * D'où `effectiveEndMs = startedAt + seconds`, et non `endedAt` (qui vaut null tant que le service
 * est ouvert) ni `Date.now()` (qui crédite des heures de sommeil à toute l'équipe après un plantage).
 */

const TZ = "America/Toronto";

/** Les composantes d'un instant, lues dans le fuseau de Toronto. Sert à la fois à borner "aujourd'hui"
 *  et "cette semaine" sur l'heure murale de Toronto plutôt que sur celle du serveur qui héberge le
 *  panel, qui peut tourner dans un tout autre fuseau. */
function torontoParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    da: Number(get("day")),
    h: Number(get("hour")),
    mi: Number(get("minute")),
    weekday: get("weekday"),
  };
}

/**
 * L'instant réel correspondant à une heure murale de Toronto, sans passer par une bibliothèque de
 * fuseaux. On devine d'abord en traitant les chiffres comme de l'UTC, puis on mesure l'écart réel en
 * reformattant cette estimation dans le fuseau de Toronto (l'écart EST/EDT ne se lit nulle part,
 * il faut le mesurer), et on corrige. La même technique sert au formulaire de correction côté client.
 */
function torontoWallToDate(y: number, mo: number, da: number, h = 0, mi = 0): Date {
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const seen = torontoParts(new Date(guess));
  const seenAsUtc = Date.UTC(seen.y, seen.mo - 1, seen.da, seen.h, seen.mi);
  return new Date(guess - (seenAsUtc - guess));
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const pad2 = (n: number) => String(n).padStart(2, "0");

/** La clé d'un JOUR de Toronto: `2026-08-09`. C'est le seul regroupement temporel que la frise
 *  connaisse, et il est calculé ici pour que le navigateur n'ait aucune arithmétique de fuseau à
 *  refaire (deux implémentations du même décalage EST/EDT finiraient par diverger). */
function dayKeyOf(d: Date): string {
  const p = torontoParts(d);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.da)}`;
}

/** "lun.", sans le point: la puce de jour est déjà une étiquette, la ponctuation y est du bruit. */
const FMT_WEEKDAY = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short" });
const FMT_DATE = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit" });

/** Minuit à minuit, en heure de Toronto. */
function todayBounds(): { from: Date; to: Date } {
  const now = torontoParts(new Date());
  return { from: torontoWallToDate(now.y, now.mo, now.da), to: torontoWallToDate(now.y, now.mo, now.da + 1) };
}

/**
 * Les SEPT JOURS de la semaine affichée, lundi en premier, en heure de Toronto.
 *
 * ⚠ Chaque jour est construit en décalant le NUMÉRO DE JOUR (`da - dow + i`), jamais en ajoutant
 * 86 400 000 ms: la nuit du changement d'heure ne dure pas 24 h, et une semaine bâtie sur un nombre
 * de secondes fixe déplacerait toutes les frontières de jour d'une heure à partir de ce dimanche-là.
 * `Date.UTC` normalise le débordement de mois tout seul, donc `da + i` reste valide fin de mois.
 */
function weekDays(period: "cur" | "prev"): DayCell[] {
  const nowMs = Date.now();
  const now = torontoParts(new Date(nowMs));
  const dow = WEEKDAY_INDEX[now.weekday] ?? 0;
  const base = now.da - dow - (period === "prev" ? 7 : 0);
  const todayKey = `${now.y}-${pad2(now.mo)}-${pad2(now.da)}`;

  const out: DayCell[] = [];
  for (let i = 0; i < 7; i++) {
    const start = torontoWallToDate(now.y, now.mo, base + i);
    const end = torontoWallToDate(now.y, now.mo, base + i + 1);
    const key = dayKeyOf(start);
    out.push({
      key,
      weekday: FMT_WEEKDAY.format(start).replace(/\.$/, ""),
      date: FMT_DATE.format(start),
      startMs: start.getTime(),
      endMs: end.getTime(),
      isToday: key === todayKey,
      isFuture: start.getTime() > nowMs,
    });
  }
  return out;
}

/**
 * L'EFFECTIF, PUIS LES HEURES: qui travaille ici, et ce que chacun a pointé.
 *
 * ⚠⚠ L'EFFECTIF PASSE EN PREMIER, ET C'EST LA CORRECTION DU 2026-08-10. Cette fusion ne partait que
 * de `shiftTotals`, c'est-à-dire de DEUX LISTES DE POINTAGES: quelqu'un qui n'avait pas pointé de la
 * semaine n'était dans ni l'une ni l'autre, donc n'apparaissait NULLE PART sur cette page. Le
 * propriétaire l'a signalé en ces termes: "i still dont see people who have 0 pointage". Or "personne
 * n'a pointé" est exactement l'information qu'un gérant vient chercher ici, et une absence de ligne
 * ne la donne pas: elle se lit comme "je ne sais pas". Chaque employé de l'annuaire reçoit donc sa
 * ligne, à zéro, avant que la moindre heure ne soit lue.
 *
 * Les totaux du jour et ceux de la semaine restent DEUX requêtes séparées (`shiftTotals` ne prend
 * qu'une fenêtre), fusionnées ici par personne: absent de l'une, on garde des zéros pour cette
 * moitié plutôt que de disparaître de la ligne.
 *
 * ⚠ Une personne présente dans les pointages mais absente de l'annuaire est un ANCIEN EMPLOYÉ: elle
 * garde sa ligne et ses heures exactes (elles ont été travaillées), en retrait, et après tout le
 * monde. La masquer changerait en silence le total de la semaine dernière le jour où quelqu'un
 * change de métier.
 *
 * ⚠ LE NOM VIENT DE L'ANNUAIRE quand la personne y figure. `lifeinvader_business_shifts.name` est une
 * copie datée, prise à la prise de service, donc un employé renommé s'afficherait sous son ancien
 * nom. Pour un ancien employé, cette copie est au contraire la seule identité qui reste.
 */
function mergeTotals(day: ShiftTotals[], week: ShiftTotals[], roster: RosterMember[]): TotalsRow[] {
  const rows = new Map<string, TotalsRow>();
  const blank = (identifier: string, name: string, former: boolean): TotalsRow => {
    const row: TotalsRow = {
      identifier,
      name,
      former,
      daySeconds: 0,
      dayShifts: 0,
      weekSeconds: 0,
      weekShifts: 0,
    };
    rows.set(identifier, row);
    return row;
  };

  for (const m of roster) blank(m.identifier, m.name, false);
  const upsert = (r: ShiftTotals) => rows.get(r.identifier) ?? blank(r.identifier, r.name, true);

  for (const r of day) {
    const row = upsert(r);
    row.daySeconds = r.seconds;
    row.dayShifts = r.shifts;
  }
  for (const r of week) {
    const row = upsert(r);
    row.weekSeconds = r.seconds;
    row.weekShifts = r.shifts;
  }

  return Array.from(rows.values()).sort(
    (a, b) =>
      Number(a.former) - Number(b.former) ||
      b.weekSeconds - a.weekSeconds ||
      b.daySeconds - a.daySeconds ||
      a.name.localeCompare(b.name, "fr"),
  );
}

/**
 * Le jour ouvert à l'arrivée. Aujourd'hui s'il fait partie de la semaine affichée (le cas courant),
 * sinon le DERNIER jour où quelqu'un a pointé, sinon le dimanche.
 *
 * ⚠ Choisi ICI et passé en propriété, pas deviné au premier rendu du navigateur: `new Date()` côté
 * client donne un autre instant que côté serveur, et l'écart se paie en désynchronisation
 * d'hydratation sur une page rendue à chaque requête.
 */
function defaultDay(days: DayCell[], shiftDayKeys: Set<string>): string {
  const today = days.find((d) => d.isToday);
  if (today) return today.key;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (shiftDayKeys.has(d.key)) return d.key;
  }
  return days[days.length - 1]!.key;
}

export default async function PointagePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ periode?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const period: "cur" | "prev" = sp.periode === "prev" ? "prev" : "cur";

  const identity = await requireIdentity();
  const access = await getBusinessBySlug(identity, slug);
  if (!access) notFound();

  const canRead = businessCan(access, CAP.SHIFT_READ);
  if (!canRead) {
    // Aucune donnée n'est chargée: SHIFT_READ manquant ne doit jamais se traduire par une frise
    // vide, qui laisserait croire qu'il ne s'est rien passé plutôt que "vous n'y avez pas accès".
    // ⚠ TROIS causes possibles, et les nommer séparément est le seul moyen que la personne sache
    // quoi faire. Deviner la troisième à chaque fois envoie quelqu'un prendre son service pour un
    // droit que son grade n'a pas, ce qui ne changera jamais rien.
    const mod = moduleOfCapability(CAP.SHIFT_READ);
    const reason =
      mod && access.modules[mod] === false
        ? "Le module Pointage est désactivé pour ce commerce. La direction peut le rallumer depuis les Réglages."
        : access.capabilities.has(CAP.SHIFT_READ)
          ? "Connectez-vous en jeu avec ce personnage pour consulter les pointages."
          : "Votre grade n'a pas accès aux pointages. Demandez ce droit à la direction.";
    return <PointageView slug={access.slug} canRead={false} readReason={reason} />;
  }

  const canEdit = businessCan(access, CAP.SHIFT_EDIT);
  // Même discipline que ci-dessus, côté écriture: "prise de service requise" adressé à quelqu'un
  // dont le grade n'a simplement pas le droit est une impasse polie.
  const editReason = access.capabilities.has(CAP.SHIFT_EDIT)
    ? "Prenez votre service en jeu pour corriger un pointage."
    : "Votre grade n'a pas le droit de corriger un pointage. Demandez-le à la direction.";

  // ⚠ Même seuil que `SHIFT_STALE_MS` dans lib/business/access.ts (non exporté, donc dupliqué ici
  // volontairement, comme `DurationUnits` entre gs_weather et CITADEL): un pointage ouvert dont le
  // heartbeat a plus de cinq minutes ne doit pas apparaître "en service" ici alors que le rail, à
  // côté, l'a déjà considéré hors ligne. Si ce fichier dérive de access.ts, les deux surfaces se
  // contrediraient sur qui est en service en ce moment.
  const SHIFT_STALE_MS = 5 * 60_000;

  const today = todayBounds();
  const days = weekDays(period);
  const week = { from: new Date(days[0]!.startMs), to: new Date(days[6]!.endMs) };

  const [onDuty, dayTotals, weekTotals, shifts, roster] = await Promise.all([
    onDutyNow(access.job, SHIFT_STALE_MS),
    shiftTotals(access.job, today),
    shiftTotals(access.job, week),
    listShifts(access.job, week),
    // L'effectif, la seule des cinq lectures qui ne soit pas de l'activité. Voir `mergeTotals`.
    employeesForJob(access.job),
  ]);

  const totals = mergeTotals(dayTotals, weekTotals, roster);
  const formerCount = totals.filter((t) => t.former).length;
  const todaySeconds = dayTotals.reduce((acc, r) => acc + r.seconds, 0);
  const weekSeconds = weekTotals.reduce((acc, r) => acc + r.seconds, 0);
  const weekShiftCount = weekTotals.reduce((acc, r) => acc + r.shifts, 0);

  const rows: PointageShift[] = shifts.map((r) => ({
    id: r.id,
    identifier: r.identifier,
    name: r.name,
    dayKey: dayKeyOf(r.startedAt),
    startMs: r.startedAt.getTime(),
    // La fin RETENUE, celle qui dessine la barre et qui correspond exactement à la durée affichée.
    effectiveEndMs: r.startedAt.getTime() + r.seconds * 1000,
    // La fin RÉELLE, celle que le formulaire de correction doit renvoyer. `null` tant que le service
    // est ouvert, ce qui est aussi le test "ce pointage ne se corrige pas encore".
    endedAtMs: r.endedAt ? r.endedAt.getTime() : null,
    endedReason: r.endedReason,
    seconds: r.seconds,
  }));

  return (
    <PointageView
      slug={access.slug}
      canRead
      canEdit={canEdit}
      editReason={editReason}
      period={period}
      days={days}
      defaultDayKey={defaultDay(days, new Set(rows.map((r) => r.dayKey)))}
      weekFromMs={days[0]!.startMs}
      weekToMs={days[6]!.endMs}
      onDuty={onDuty.map((r) => ({ id: r.id, name: r.name, startMs: r.startedAt.getTime(), seconds: r.seconds }))}
      totals={totals}
      shifts={rows}
      figures={{
        // ⚠ Plus de liste de noms ici: la bande "En service" de la colonne latérale les nomme un par
        // un avec leur durée. Deux surfaces qui affichent la même liste finissent par se contredire
        // le jour où l'une des deux change de règle de fraîcheur.
        onDutyCount: onDuty.length,
        todaySeconds,
        weekSeconds,
        weekShiftCount,
        // ⚠ `roster.length` ET NON `totals.length`: ce dernier compte aussi les anciens employés,
        // et annoncerait donc un effectif plus grand que celui qui travaille réellement ici.
        employeeCount: roster.length,
        formerCount,
      }}
    />
  );
}
