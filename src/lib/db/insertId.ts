/**
 * L'identifiant de la ligne qu'on vient d'insérer.
 *
 * Avec le pilote mysql2, `await db.insert(t).values(v)` rend le tuple `[ResultSetHeader, FieldPacket[]]`,
 * donc `insertId` vit dans l'ÉLÉMENT 0. L'idiome du reste du code est de déstructurer:
 * `const [res] = await db.insert(...)` puis `res.insertId`. Drizzle le type correctement, et
 * `tsc` refuse bien un accès direct à `res.insertId` sur le tuple.
 *
 * ⚠ CE QUI A CASSÉ, ET POURQUOI CE FICHIER EXISTE (2026-08-08). Le premier jet écrivait
 * `Number((res as unknown as { insertId: number }).insertId)`, sans déstructurer. Le double cast a
 * DÉSACTIVÉ exactement la vérification qui aurait attrapé la faute: `as unknown as X` dit au
 * compilateur de se taire, donc il s'est tu. À l'exécution la propriété valait `undefined`, `Number()`
 * a rendu `NaN`, et le `NaN` est parti dans la colonne `business_id` de l'insertion suivante où MySQL
 * l'a refusé avec "Unknown column 'NaN' in 'field list'" - un message qui ne désigne pas du tout un
 * accès de propriété raté. La leçon n'est pas "drizzle ment", c'est "un cast qui traverse `unknown`
 * est un contournement du typage, et il faut le traiter comme tel".
 *
 * La fonction accepte les DEUX formes plutôt que d'imposer la déstructuration à l'appelant, et elle
 * ÉCHOUE BRUYAMMENT si aucun identifiant exploitable n'en sort - un `NaN` qui voyage produit son
 * erreur trois requêtes plus loin, sans rapport visible avec sa cause.
 */
export function insertedId(res: unknown): number {
  const header = (Array.isArray(res) ? res[0] : res) as { insertId?: number | string } | undefined;
  const id = Number(header?.insertId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("insertedId: aucun identifiant exploitable dans le résultat d'insertion");
  }
  return id;
}
