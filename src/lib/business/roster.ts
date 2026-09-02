/**
 * QUI TRAVAILLE ICI, INDÉPENDAMMENT DE CE QU'ILS ONT FAIT.
 *
 * ⚠⚠ CE FICHIER EXISTE PARCE QUE LES DEUX PAGES DE GESTION CONSTRUISAIENT LEUR LISTE D'EMPLOYÉS À
 * PARTIR DE L'ACTIVITÉ, ET QUE C'ÉTAIT LE BUG. `sellerTotals` (a vendu), `shiftTotals` (a pointé) et
 * `onDutyNow` (est en service maintenant) sont trois listes de CE QUI S'EST PASSÉ; leur union n'est
 * pas un effectif. Quelqu'un qui tient le métier mais n'a rien vendu et n'a jamais pointé
 * n'apparaissait donc dans aucune des trois, et n'existait tout simplement pas sur la page. Constaté
 * en direct par le propriétaire ("i should see everyone even with 0 sales 0 punches"), et reproduit
 * sur le vigneron: trois employés dans `users`, un seul invisible sur Équipe ET sur Pointage.
 *
 * La seule source qui répond à "qui travaille ici" est l'annuaire du JEU (`users` + `job_grades`),
 * exactement comme pour l'accès au portail (voir `employmentsFor` dans access.ts, dont ce module
 * reprend la discipline). Ce module ne décide de RIEN: il rend l'effectif, et l'appelant y raccroche
 * les chiffres qu'il a déjà.
 *
 * ⚠ DEUX EMPLACEMENTS DE MÉTIER, ET EN OUBLIER UN PERD LA MOITIÉ DE L'ÉQUIPE. ESX donne à chaque
 * personnage `job`/`job_grade` ET `job2`/`job2_grade`; sur ce serveur, un employé du Bar du Vigneron
 * peut porter le métier dans l'un OU l'autre (mesuré: David Charles l'a en `job2`, les deux autres
 * en `job`). La sélection teste donc les deux colonnes, et le grade est lu dans l'emplacement QUI A
 * RÉPONDU, jamais dans `job_grade` par défaut.
 *
 * ⚠ LE LIBELLÉ DE GRADE EST RÉSOLU EN MÉMOIRE, PAS PAR UNE JOINTURE, et c'est un choix mesuré.
 * `access.ts` joint `users` à `job_grades` sur `(job_name = users.job AND grade = users.job_grade)`,
 * ce qui est légal (deux tables ESX, même collation) mais n'est écrit QUE pour l'emplacement `job`.
 * Servir aussi `job2` demanderait soit une seconde jointure aliasée, soit un `CASE` dans la
 * condition de jointure: deux façons compliquées de faire ce qu'un `Map` fait ici en trois lignes,
 * puisque l'échelle d'UN métier tient en une poignée de lignes (quatre pour le vigneron) et qu'on
 * la lit de toute façon. Une requête minuscule et une jointure en mémoire, donc, et le même code
 * sert les deux emplacements sans se dédoubler.
 *
 * ⚠ CE QUE CE MODULE NE FAIT PAS: il ne joint RIEN à `citadel_*`. Les agrégats du portail
 * (`lifeinvader_business_sales`, `lifeinvader_business_shifts`) sont en `utf8mb4_general_ci` et les tables
 * ESX en `utf8mb4_unicode_ci`; MariaDB lève l'erreur 1267 À L'EXÉCUTION alors que les deux côtés se
 * typent `string`, donc `tsc` ne peut pas la voir. L'appelant rapproche par `Map` sur l'identifiant,
 * comme toutes les autres pages de ce portail.
 *
 * ⚠ L'IDENTIFIANT EST DU HEX NU (`users.identifier`), la même forme que
 * `lifeinvader_business_sales.seller_identifier` et `lifeinvader_business_shifts.identifier`. Jamais la
 * forme préfixée `license:`, qui ne joint rien nulle part.
 */
import "server-only";
import { eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema/game";
import { UNEMPLOYED } from "@/lib/data/factions";
import { gradesForJob } from "@/lib/data/gameCommands";
import { fixMojibake } from "@/lib/text/fixMojibake";

export type RosterMember = {
  /** Hex nu, la clé de rapprochement avec les agrégats du portail. */
  identifier: string;
  /** Le nom RP du personnage. Jamais le pseudo FiveM, qui n'est pas dans cette table. */
  name: string;
  /** Le grade lu dans l'emplacement qui porte ce métier. `0` est un VRAI grade, pas un "inconnu". */
  grade: number;
  /** Le libellé du grade tel qu'il est écrit en jeu. Affichage seulement, jamais une décision. */
  gradeLabel: string;
  /** Lequel des deux emplacements ESX porte ce métier pour cette personne. */
  slot: "job" | "job2";
};

/** Le repli quand l'échelle du métier n'a pas de ligne pour ce grade (seed incomplet, ladder retouchée). */
function fallbackGradeLabel(grade: number): string {
  return `Grade ${grade}`;
}

/**
 * L'EFFECTIF D'UN MÉTIER, trié par grade décroissant puis par nom.
 *
 * ⚠ `unemployed` rend une liste VIDE, et ce n'est pas une coquetterie: ESX y range tout le monde par
 * défaut, donc un commerce enregistré sur ce métier ferait de ce module une liste du serveur entier.
 * Même garde-fou qu'`employmentsFor` dans access.ts, pour la même raison, au même endroit: dans la
 * requête, pas dans la confiance qu'on accorde à la configuration.
 *
 * ⚠ Un personnage qui porte le métier dans LES DEUX emplacements n'apparaît qu'UNE fois, sur `job`.
 * La clé de cette liste est la personne, pas le contrat.
 */
export async function employeesForJob(job: string): Promise<RosterMember[]> {
  if (!job || job === UNEMPLOYED) return [];

  const [rows, ladder] = await Promise.all([
    db
      .select({
        identifier: users.identifier,
        firstname: users.firstname,
        lastname: users.lastname,
        job: users.job,
        jobGrade: users.jobGrade,
        job2: users.job2,
        job2Grade: users.job2Grade,
      })
      .from(users)
      .where(or(eq(users.job, job), eq(users.job2, job))),
    gradesForJob(job),
  ]);

  const gradeLabels = new Map(ladder.map((g) => [g.grade, g.label]));

  const out: RosterMember[] = [];
  for (const r of rows) {
    // `job` d'abord: si les deux emplacements portent le métier, c'est le principal qui compte.
    const slot: "job" | "job2" = r.job === job ? "job" : "job2";
    const grade = (slot === "job" ? r.jobGrade : r.job2Grade) ?? 0;
    const name = fixMojibake(`${r.firstname ?? ""} ${r.lastname ?? ""}`.trim()) || "Employé";
    out.push({
      identifier: r.identifier,
      name,
      grade,
      gradeLabel: gradeLabels.get(grade) ?? fallbackGradeLabel(grade),
      slot,
    });
  }

  return out.sort((a, b) => b.grade - a.grade || a.name.localeCompare(b.name, "fr"));
}
