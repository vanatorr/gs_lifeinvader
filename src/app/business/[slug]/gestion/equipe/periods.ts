/**
 * LES PÉRIODES DE LA PAGE ÉQUIPE, ET LA SEULE TABLE QUI LES DÉCLARE.
 *
 * ⚠⚠ CE FICHIER EXISTE PARCE QUE CES QUATRE CHOSES SONT LUES DES DEUX CÔTÉS DE LA FRONTIÈRE
 * SERVEUR/CLIENT, et qu'elles vivaient dans `SalesChart.tsx`, qui porte `"use client"`.
 *
 * Le symptôme, en production, était une page 500 complète (`/gestion/equipe`), avec ce message côté
 * serveur et rien d'utile côté navigateur (Next masque le détail en production, il ne reste qu'un
 * digest):
 *
 *     Attempted to call parsePeriod() from the server but parsePeriod is on the client.
 *     It's not possible to invoke a client function from the server, it can only be rendered as a
 *     Component or passed to props of a Client Component.
 *
 * ⚠ POURQUOI NI `tsc` NI LE BUILD NE L'ONT VU. Un module `"use client"` reste parfaitement typé et
 * importable depuis un composant serveur: TypeScript ne connaît pas la frontière, et le build
 * compile sans broncher. Next remplace simplement chaque export de VALEUR par une référence
 * client, qui lève À L'EXÉCUTION quand le serveur tente de l'appeler. Donc la seule chose qui
 * pouvait attraper ça était d'ouvrir la page. Les TYPES, eux, passent sans problème (ils sont
 * effacés à la compilation), ce qui explique que `type Period`, `type MixPoint` et `type HourPoint`
 * n'aient jamais posé de problème depuis les mêmes imports: seuls `parsePeriod` et `periodDays`,
 * deux FONCTIONS, cassaient.
 *
 * La règle générale, pour la prochaine fois: une fonction pure partagée par un `page.tsx` et un
 * composant client n'a rien à faire dans le fichier du composant. Elle va dans un module neutre,
 * que les deux importent.
 *
 * ⚠ UNE SEULE TABLE, PARTAGÉE PAR LE SÉLECTEUR ET PAR LES DEUX `page.tsx`, ET C'EST VOULU. Le reste
 * de ce portail duplique délibérément ses helpers de date d'une page à l'autre (chaque page
 * re-résout tout elle-même), mais ici la duplication serait un BUG et non une précaution: le menu
 * écrit une valeur dans l'URL et le serveur la relit. Deux listes qui divergent produisent une
 * entrée de menu qui ne correspond à aucune fenêtre côté serveur, donc un choix qui retombe en
 * silence sur "semaine en cours" pendant que le menu affiche autre chose.
 */

export type Period = "cur" | "prev" | "d14" | "d30";

/**
 * `days` n'est utilisé que par les fenêtres GLISSANTES. Les deux premières sont des semaines
 * CALENDAIRES (lundi au lundi), donc leur longueur est une conséquence du calendrier, pas un
 * paramètre: `periodRange` ne lit pas `days` pour elles.
 */
export const PERIOD_OPTIONS: readonly { value: Period; label: string; days: number }[] = [
  { value: "cur", label: "Semaine en cours", days: 7 },
  { value: "prev", label: "Semaine dernière", days: 7 },
  { value: "d14", label: "14 derniers jours", days: 14 },
  { value: "d30", label: "30 derniers jours", days: 30 },
];

/** La valeur `?p=` de l'URL, ramenée à une période connue. Tout le reste retombe sur la semaine. */
export function parsePeriod(raw: string | undefined): Period {
  return PERIOD_OPTIONS.some((o) => o.value === raw) ? (raw as Period) : "cur";
}

/** La longueur d'une fenêtre glissante, en jours. Sans objet pour les deux semaines calendaires. */
export function periodDays(period: Period): number {
  return PERIOD_OPTIONS.find((o) => o.value === period)?.days ?? PERIOD_OPTIONS[0]!.days;
}
