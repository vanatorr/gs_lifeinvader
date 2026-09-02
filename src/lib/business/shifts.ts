/**
 * LES POINTAGES: lecture, totaux, correction.
 *
 * ⚠ LES POINTAGES SONT ÉCRITS PAR LE JEU, jamais par le portail (sauf correction explicite d'un
 * gérant, plus bas). Une ligne ouverte au heartbeat frais EST la preuve d'être en service; c'est la
 * même ligne qui sert de fiche de pointage. Voir le commentaire de `citadelBusinessShifts`.
 *
 * ⚠⚠ LES POINTAGES SONT CLÉS PAR `job`, PAS PAR `business_id`, et c'est délibéré: le jeu ne connaît
 * que le métier ESX, et un service doit pouvoir s'ouvrir même si le portail n'a jamais été activé
 * pour ce commerce. Toute lecture ici prend donc un `job`, et c'est à l'appelant de l'avoir obtenu
 * depuis un `BusinessAccess` (donc d'un commerce où il travaille vraiment). Passer un `job` arbitraire
 * lirait les pointages d'une autre entreprise: le cloisonnement vient du résolveur, pas d'ici.
 */
import "server-only";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { citadelBusinessShifts } from "@/lib/db/schema/citadel";

/**
 * La fin RETENUE d'un service pour tout calcul de durée.
 *
 * ⚠ Pour un service ENCORE OUVERT c'est le dernier heartbeat, JAMAIS l'heure courante. Un serveur
 * qui plante à 3h du matin laisse des lignes ouvertes; les compter jusqu'à maintenant créditerait
 * huit heures de sommeil à toute l'équipe, et le lendemain neuf. Le dernier signe de vie est la
 * seule fin honnête. C'est aussi exactement ce que doit faire le balayage au boot côté jeu.
 */
const EFFECTIVE_END = sql`COALESCE(${citadelBusinessShifts.endedAt}, ${citadelBusinessShifts.heartbeatAt})`;
const WORKED_SECONDS = sql<number>`SUM(GREATEST(TIMESTAMPDIFF(SECOND, ${citadelBusinessShifts.startedAt}, ${EFFECTIVE_END}), 0))`;

export type ShiftRow = {
  id: number;
  identifier: string;
  name: string;
  grade: number;
  startedAt: Date;
  endedAt: Date | null;
  heartbeatAt: Date;
  endedReason: string | null;
  /** Durée retenue, en secondes. Pour un service ouvert: jusqu'au dernier heartbeat. */
  seconds: number;
};

/** Les pointages d'un métier sur une fenêtre, du plus récent au plus ancien. */
export async function listShifts(
  job: string,
  opts: { from?: Date; to?: Date; identifier?: string; limit?: number } = {},
): Promise<ShiftRow[]> {
  const where = [eq(citadelBusinessShifts.job, job)];
  if (opts.from) where.push(gte(citadelBusinessShifts.startedAt, opts.from));
  if (opts.to) where.push(lt(citadelBusinessShifts.startedAt, opts.to));
  if (opts.identifier) where.push(eq(citadelBusinessShifts.identifier, opts.identifier));

  const rows = await db
    .select({
      id: citadelBusinessShifts.id,
      identifier: citadelBusinessShifts.identifier,
      name: citadelBusinessShifts.name,
      grade: citadelBusinessShifts.grade,
      startedAt: citadelBusinessShifts.startedAt,
      endedAt: citadelBusinessShifts.endedAt,
      heartbeatAt: citadelBusinessShifts.heartbeatAt,
      endedReason: citadelBusinessShifts.endedReason,
      seconds: sql<number>`GREATEST(TIMESTAMPDIFF(SECOND, ${citadelBusinessShifts.startedAt}, ${EFFECTIVE_END}), 0)`,
    })
    .from(citadelBusinessShifts)
    .where(and(...where))
    .orderBy(desc(citadelBusinessShifts.startedAt))
    .limit(Math.min(opts.limit ?? 300, 1000));

  // TIMESTAMPDIFF revient en CHAÎNE via mysql2, comme tout agrégat numérique. `sql<number>` est une
  // assertion de type sans conversion: sans Number(), additionner deux durées les concatènerait.
  return rows.map((r) => ({ ...r, seconds: Number(r.seconds) }));
}

export type ShiftTotals = {
  identifier: string;
  name: string;
  shifts: number;
  seconds: number;
};

/** Le temps travaillé par personne sur une fenêtre. Agrégé en SQL: une semaine fait beaucoup de lignes. */
export async function shiftTotals(
  job: string,
  opts: { from?: Date; to?: Date } = {},
): Promise<ShiftTotals[]> {
  const where = [eq(citadelBusinessShifts.job, job)];
  if (opts.from) where.push(gte(citadelBusinessShifts.startedAt, opts.from));
  if (opts.to) where.push(lt(citadelBusinessShifts.startedAt, opts.to));

  const rows = await db
    .select({
      identifier: citadelBusinessShifts.identifier,
      name: sql<string>`MAX(${citadelBusinessShifts.name})`,
      shifts: sql<number>`COUNT(*)`,
      seconds: WORKED_SECONDS,
    })
    .from(citadelBusinessShifts)
    .where(and(...where))
    .groupBy(citadelBusinessShifts.identifier)
    .orderBy(desc(WORKED_SECONDS));

  return rows.map((r) => ({
    identifier: r.identifier,
    name: r.name,
    shifts: Number(r.shifts),
    seconds: Number(r.seconds ?? 0),
  }));
}

/** Qui est en service EN CE MOMENT sur ce métier, avec depuis quand. */
export async function onDutyNow(job: string, staleMs: number): Promise<ShiftRow[]> {
  const fresh = new Date(Date.now() - staleMs);
  const rows = await db
    .select({
      id: citadelBusinessShifts.id,
      identifier: citadelBusinessShifts.identifier,
      name: citadelBusinessShifts.name,
      grade: citadelBusinessShifts.grade,
      startedAt: citadelBusinessShifts.startedAt,
      endedAt: citadelBusinessShifts.endedAt,
      heartbeatAt: citadelBusinessShifts.heartbeatAt,
      endedReason: citadelBusinessShifts.endedReason,
      seconds: sql<number>`GREATEST(TIMESTAMPDIFF(SECOND, ${citadelBusinessShifts.startedAt}, ${EFFECTIVE_END}), 0)`,
    })
    .from(citadelBusinessShifts)
    .where(
      and(
        eq(citadelBusinessShifts.job, job),
        isNull(citadelBusinessShifts.endedAt),
        gte(citadelBusinessShifts.heartbeatAt, fresh),
      ),
    )
    .orderBy(desc(citadelBusinessShifts.startedAt));
  return rows.map((r) => ({ ...r, seconds: Number(r.seconds) }));
}

export type CorrectShiftResult = { ok: true } | { ok: false; error: CorrectShiftError };
export type CorrectShiftError = "not_found" | "wrong_job" | "still_open" | "inverted" | "too_long";

/**
 * Un service corrigé ne peut pas dépasser cette durée. 16 heures est déjà généreux pour une
 * soirée de RP; au-delà c'est une faute de frappe sur la date, et elle fausserait la semaine entière.
 */
const MAX_CORRECTED_HOURS = 16;

/**
 * CORRIGER un pointage déjà fermé.
 *
 * L'appelant a déjà franchi `requireBusiness(identity, slug, CAP.SHIFT_EDIT)`.
 *
 * ⚠ LE `job` EST DANS LE `WHERE`, pas seulement vérifié avant. Sans lui, un gérant qui devine un id
 * corrigerait les heures d'une autre entreprise; et un contrôle fait dans l'appelant est un contrôle
 * qu'un futur appelant oubliera.
 *
 * ⚠ UN SERVICE OUVERT NE SE CORRIGE PAS. Le jeu en est le seul écrivain tant qu'il est ouvert: le
 * fermer ici pendant que quelqu'un est en service lui retirerait ses droits d'écriture au milieu de
 * son service, et le prochain heartbeat réécrirait par-dessus la correction. On attend qu'il ferme.
 *
 * ⚠ `ended_reason` n'est PAS touché: il dit comment le service s'est terminé pour de vrai
 * (déconnexion, balayage après plantage), et c'est précisément l'information qui explique POURQUOI
 * une correction était nécessaire. L'écraser effacerait la trace du problème en même temps que le
 * problème.
 */
export async function correctShift(
  job: string,
  shiftId: number,
  next: { startedAt: Date; endedAt: Date },
): Promise<CorrectShiftResult> {
  if (next.endedAt.getTime() <= next.startedAt.getTime()) return { ok: false, error: "inverted" };
  const hours = (next.endedAt.getTime() - next.startedAt.getTime()) / 3_600_000;
  if (hours > MAX_CORRECTED_HOURS) return { ok: false, error: "too_long" };

  const [row] = await db
    .select({ id: citadelBusinessShifts.id, endedAt: citadelBusinessShifts.endedAt })
    .from(citadelBusinessShifts)
    .where(and(eq(citadelBusinessShifts.id, shiftId), eq(citadelBusinessShifts.job, job)))
    .limit(1);
  // "Introuvable" et "pas à vous" renvoient la MÊME erreur: distinguer les deux confirmerait
  // l'existence d'un pointage chez le voisin à qui saurait deviner un id.
  if (!row) return { ok: false, error: "not_found" };
  if (row.endedAt === null) return { ok: false, error: "still_open" };

  await db
    .update(citadelBusinessShifts)
    .set({ startedAt: next.startedAt, endedAt: next.endedAt, heartbeatAt: next.endedAt })
    .where(and(eq(citadelBusinessShifts.id, shiftId), eq(citadelBusinessShifts.job, job)));
  return { ok: true };
}
