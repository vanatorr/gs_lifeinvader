/**
 * LE CATALOGUE DES CUSTOMS ET LEUR COUT, lu dans les fichiers du jeu et jamais tape ici.
 *
 * Demande du proprietaire (2026-08-23): un garage doit pouvoir declarer n'importe quelle
 * modification depuis LifeInvader, l'employe choisit la voiture par recherche et "prices
 * automatically display billing price". Ce module fournit la moitie COUT de ce calcul; la moitie
 * MARGE vit dans `margin.ts`, et elle appartient au proprietaire seul.
 *
 * MEME DISCIPLINE, ET MEME RAISON, QUE `lib/data/vehicleMods.ts` ET `vehicleModels.ts`: tout vient
 * de `esx_lscustom/config.lua` et de `locales/fr.lua`, donc un pourcentage retouche dans le jeu
 * suit ici a la prochaine expiration du cache, sans une ligne a editer. Recopier les 92 lignes dans
 * CITADEL produirait deux baremes qui divergent le jour ou personne ne regarde, et c'est le garage
 * qui facturerait le mauvais.
 *
 * WARNING LE COUT EST CALCULE EN DOLLARS ENTIERS AVANT D'ETRE CONVERTI EN CENTIMES, et l'ordre
 * n'est pas negociable. Le jeu fait `math.floor(vehiclePrice * pct / 100)`
 * (esx_lscustom/server/main.lua, `flatPrice` / `levelPrice` / `resprayPrice`) et debite la societe
 * de CE nombre. Arrondir en centimes donnerait un cout different de celui reellement preleve, donc
 * une marge fausse sur chaque ligne et un ecart permanent entre le portail et la caisse de la
 * societe. On reproduit l'arithmetique du jeu, on ne l'ameliore pas.
 *
 * WARNING CE MODULE NE CONNAIT PAS LA MARGE, PAR CONSTRUCTION. Il ne sait dire que ce que les
 * pieces coutent a la societe. Le prix client se demande a `customQuote.ts`, qui est le seul
 * endroit ou les deux moities se rencontrent et le seul qui a le droit de lire le bareme.
 */
// PAS de `import "server-only"` ici, et c'est aligne sur `lib/data/vehicleMods.ts`, le module frere
// qui lit les memes fichiers: `node:fs` est deja la garde, un import client echouerait a la
// resolution. Le garde-fou `server-only` est reserve aux modules qui portent quelque chose de
// SECRET ou d'authoritatif (le bareme de marge, les cotations), pas a un lecteur de config publique.
import fs from "node:fs";
import path from "node:path";

// citadel/ et fivem/ sont freres; `process.cwd()` est la racine de ce paquet sous next dev/start.
// Chemins identiques a ceux de lib/data/vehicleMods.ts, deliberement: si l'un se casse en
// deploiement, les deux se cassent ensemble et de la meme facon, plutot qu'a moitie.
const LSCUSTOM_DIR = path.resolve(process.cwd(), "../fivem/server-data/resources/esx_lscustom");
const CONFIG_PATH = path.join(LSCUSTOM_DIR, "config.lua");
const LOCALE_PATH = path.join(LSCUSTOM_DIR, "locales", "fr.lua");

function readOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** `['key'] = 'valeur',` y compris les echappements que le fichier FR utilise. */
const LOCALE_RE = /\[\s*'([^']+)'\s*\]\s*=\s*'((?:\\.|[^'\\])*)'/g;
/** `label = _U('key')`, l'indirection que chaque entree de Config.Menus utilise. */
const U_RE = /_U\(\s*'([^']+)'\s*\)/;

/* -- Ce que le portail vend ------------------------------------------------------------------- */

/**
 * UN PALIER FACTURABLE. Une entree a prix unique en produit exactement un; `modEngine` en produit
 * cinq.
 *
 * WARNING `level` EST L'INDEX GTA, PAS LE NUMERO AFFICHE. Le jeu indexe son tableau de prix avec
 * `idx = level + 1` (`levelPrice`, esx_lscustom/server/main.lua), donc le "moteur niveau 4" que lit
 * le mecano est le niveau GTA 3. Confondre les deux facture le palier d'a cote, ce qui ne leve
 * aucune erreur nulle part: le prix est simplement faux d'un cran.
 */
export type CustomTier = {
  /** Index GTA (0-base), ou -1 pour une entree a prix unique qui n'a pas de palier. */
  level: number;
  /** Ce que lit le mecano: "niveau 4". null pour une entree a prix unique. */
  tierLabel: string | null;
  /** Le pourcentage de la valeur du vehicule, tel quel dans Config.Menus. */
  pct: number;
  /**
   * Le forfait en dollars qui s'ajoute au pourcentage, avant marge. Zero partout sauf sur les
   * peintures premium, ou le jeu ajoute `basePrice` (voir PREMIUM_PAINT_KEY plus bas).
   */
  baseDollars: number;
};

/** Le regroupement d'AFFICHAGE. Voir DISPLAY_GROUPS. */
export type CustomGroupKey = "performance" | "roues" | "peinture" | "carrosserie" | "esthetique";

export type CustomSlot = {
  /** La cle Config.Menus: "modEngine". Cle React et cle de facturation, jamais un texte affiche. */
  key: string;
  /** Ce qu'un humain appelle ca: "moteur", "vitres teintees". Droit sorti du locale du jeu. */
  label: string;
  group: CustomGroupKey;
  /**
   * LA CATEGORIE STOCKEE SUR LA LIGNE DE VENTE, qui doit exister dans les `categories` du modele
   * garage (templates.ts). Deliberement plus grossiere que `group`: l'analytique groupe sur
   * `(category, label)` et n'a rien a gagner a distinguer une jante d'un becquet, alors que l'ecran
   * de caisse, lui, devient illisible sans le detail. Meme partage, et meme raison, que le
   * commentaire "GROUPING is the one thing this module decides for itself" de vehicleMods.ts.
   */
  category: "performance" | "esthetique";
  tiers: CustomTier[];
};

/**
 * PARENT Config.Menus -> groupe d'affichage.
 *
 * WARNING UN PARENT INCONNU N'EST PAS DEVINE, IL TOMBE DANS `esthetique`. Deviner a partir du nom
 * de la cle ("mod" + quelque chose) marcherait sur les 71 entrees d'aujourd'hui et se tromperait en
 * silence sur la premiere ajoutee. Un mauvais rayon est un defaut d'affichage; un mauvais
 * pourcentage serait un defaut de facturation, et rien ici ne peut produire le second.
 */
const GROUP_BY_PARENT: Record<string, CustomGroupKey> = {
  upgrades: "performance",
  wheels: "roues",
  modFrontWheelsTypes: "roues",
  modFrontWheelsColor: "roues",
  resprays: "peinture",
  primaryRespray: "peinture",
  secondaryRespray: "peinture",
  pearlescentRespray: "peinture",
  otherColours: "peinture",
  intColour: "peinture",
  bodyparts: "carrosserie",
  cosmetics: "esthetique",
  main: "esthetique",
};

/** L'ordre des rayons a l'ecran. Le plus cher et le plus demande en premier. */
export const DISPLAY_GROUPS: { key: CustomGroupKey; label: string }[] = [
  { key: "performance", label: "Performance" },
  { key: "carrosserie", label: "Carrosserie" },
  { key: "peinture", label: "Peinture" },
  { key: "roues", label: "Roues" },
  { key: "esthetique", label: "Esthetique" },
];

/**
 * WARNING EXCLU DU CATALOGUE, ET CE N'EST PAS UN OUBLI. `esx_lscustom/server/main.lua` dit lui-meme
 * de `nitroCharges` qu'il est "menu-unreachable in this build but priced defensively": le mecano ne
 * peut pas l'installer. Le proposer a la caisse ferait facturer un client pour une piece que
 * personne ne peut poser, ce qui est pire qu'une ligne manquante.
 */
const UNSELLABLE = new Set(["nitroCharges"]);

/**
 * LA PEINTURE PREMIUM, une ligne a part et pas une variante de la peinture ordinaire.
 *
 * Les 82 teintes anodisees / flip de Config.Colors portent leur propre `price = 25.0` ET un
 * `basePrice = 100000` que `resprayPrice` ADDITIONNE au pourcentage. Sur une Primo cela fait
 * 2 000 + 100 000 = 102 000 $ de pieces la ou une teinte standard en coute 89. Les fondre dans une
 * seule ligne "Peinture" afficherait donc un prix faux d'un facteur mille selon la teinte choisie,
 * et l'employe n'aurait aucun moyen de le savoir avant que la societe ne soit debitee.
 *
 * Les valeurs sont RELUES dans config.lua (voir readPremiumPaint), jamais ecrites ici.
 */
const PREMIUM_PAINT_KEY = "premiumPaint";

/* -- Lecture ----------------------------------------------------------------------------------- */

export type CustomCatalog = {
  slots: CustomSlot[];
  /** false quand config.lua n'a pas pu etre lu du tout: l'appelant refuse alors de coter. */
  ok: boolean;
};

function readPremiumPaint(config: string): CustomTier | null {
  // `{ index = 161, name = 'ANOD_RED', basePrice = 100000, price = 25.0 },`
  const m = config.match(/basePrice\s*=\s*(\d+)\s*,\s*price\s*=\s*([\d.]+)/);
  if (!m) return null;
  const baseDollars = Number(m[1]);
  const pct = Number(m[2]);
  if (!Number.isFinite(baseDollars) || !Number.isFinite(pct)) return null;
  return { level: -1, tierLabel: null, pct, baseDollars };
}

function buildCatalog(): CustomCatalog {
  const config = readOrEmpty(CONFIG_PATH);
  const locale = readOrEmpty(LOCALE_PATH);
  if (!config) return { slots: [], ok: false };

  const words = new Map<string, string>();
  let l: RegExpExecArray | null;
  LOCALE_RE.lastIndex = 0;
  while ((l = LOCALE_RE.exec(locale))) words.set(l[1], l[2].replace(/\\'/g, "'"));
  const word = (key: string) => words.get(key) ?? null;
  const fromU = (text: string): string | null => {
    const m = text.match(U_RE);
    if (!m) return null;
    return word(m[1]) ?? m[1];
  };

  // "niveau %s" - le gabarit appartient au jeu, pas a nous.
  const levelTemplate = word("level") ?? "niveau %s";
  const tierLabelFor = (n: number) => levelTemplate.replace("%s", String(n));

  const slots: CustomSlot[] = [];

  // -- Config.Menus, borne a UNE tabulation d'indentation.
  //
  // WARNING C'est ce qui distingue une entree de premier niveau des cles imbriquees: `cosmetics`
  // liste `modEngine` comme enfant a deux tabulations, et un balayage plus laxiste lirait cette
  // entree de navigation comme une definition de slot. Copie telle quelle de vehicleMods.ts, qui a
  // deja paye ce piege.
  const menusAt = config.indexOf("Config.Menus = {");
  if (menusAt >= 0) {
    const menus = config.slice(menusAt);
    const entryRe = /^\t([A-Za-z0-9_]+)\s*=\s*\{/gm;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(menus))) {
      const key = e[1];
      const bodyEnd = menus.indexOf("\n\t},", e.index);
      const body = menus.slice(e.index, bodyEnd === -1 ? e.index + 2000 : bodyEnd);

      if (UNSELLABLE.has(key)) continue;

      // Pas de prix = entree de NAVIGATION (`resprays`, `cosmetics`), pas un article.
      const priceMatch = body.match(/price\s*=\s*(\{[^}]*\}|[\d.]+)/);
      if (!priceMatch) continue;

      const label = fromU(body);
      if (!label) continue;

      const parent = body.match(/parent\s*=\s*'([^']+)'/)?.[1] ?? "";
      const group = GROUP_BY_PARENT[parent] ?? "esthetique";

      const raw = priceMatch[1];
      const tiers: CustomTier[] = [];
      if (raw.startsWith("{")) {
        const nums = raw
          .slice(1, -1)
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        // level = i (index GTA), affiche i+1. Voir l'avertissement sur CustomTier.level.
        nums.forEach((pct, i) => {
          tiers.push({ level: i, tierLabel: tierLabelFor(i + 1), pct, baseDollars: 0 });
        });
      } else {
        const pct = Number(raw);
        if (Number.isFinite(pct)) tiers.push({ level: -1, tierLabel: null, pct, baseDollars: 0 });
      }
      if (tiers.length === 0) continue;

      slots.push({
        key,
        label,
        group,
        category: group === "performance" ? "performance" : "esthetique",
        tiers,
      });
    }
  }

  // -- La peinture premium, ajoutee comme sa propre ligne (voir PREMIUM_PAINT_KEY).
  const premium = readPremiumPaint(config);
  if (premium) {
    slots.push({
      key: PREMIUM_PAINT_KEY,
      label: "Peinture premium (anodisee / flip)",
      group: "peinture",
      category: "esthetique",
      tiers: [premium],
    });
  }

  return { slots, ok: true };
}

/**
 * Cache process-large, meme TTL et meme raison que vehicleMods.ts: ces fichiers changent a peu pres
 * aussi souvent que la liste de prix d'un garagiste.
 */
type Cache = { loadedAt: number; catalog: CustomCatalog };
const TTL_MS = 10 * 60_000;
const globalForCustoms = globalThis as unknown as { citadelCustomPriceCatalog?: Cache };

export function customCatalog(): CustomCatalog {
  const hit = globalForCustoms.citadelCustomPriceCatalog;
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.catalog;
  const fresh = { loadedAt: Date.now(), catalog: buildCatalog() };
  globalForCustoms.citadelCustomPriceCatalog = fresh;
  return fresh.catalog;
}

/** Retrouve un palier a partir de ce que le navigateur a envoye. null = introuvable, donc refus. */
export function findTier(slotKey: string, level: number): { slot: CustomSlot; tier: CustomTier } | null {
  const slot = customCatalog().slots.find((s) => s.key === slotKey);
  if (!slot) return null;
  const tier = slot.tiers.find((t) => t.level === level);
  if (!tier) return null;
  return { slot, tier };
}

/**
 * LE COUT DES PIECES POUR LA SOCIETE, en centimes, pour un vehicule de `vehicleValueDollars`.
 *
 * WARNING `Math.floor` EN DOLLARS PUIS x100, jamais l'inverse. Voir l'avertissement en tete de
 * fichier: c'est l'arithmetique exacte du jeu, et s'en ecarter d'un centime fausse la marge de
 * chaque ligne.
 */
export function partsCostCents(vehicleValueDollars: number, tier: CustomTier): number {
  if (!Number.isFinite(vehicleValueDollars) || vehicleValueDollars <= 0) return 0;
  const dollars = Math.floor((vehicleValueDollars * tier.pct) / 100 + tier.baseDollars);
  return Math.max(0, dollars) * 100;
}
