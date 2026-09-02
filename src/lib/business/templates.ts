/**
 * LES MODÈLES D'ENTREPRISE: bar, garage, commerce... Ce dont hérite un commerce à son activation.
 *
 * EN CODE, et pas en base. Un premier jet leur donnait une table, au motif qu'un nouveau genre de
 * commerce ne devrait pas exiger un déploiement. C'était de l'abstraction pour un problème qui
 * n'existe pas: il y en aura cinq, aucune interface ne les édite, et personne d'autre que nous n'en
 * ajoutera. Une table aurait coûté une requête de plus sur un résolveur qui tourne à chaque rendu et
 * à chaque mutation, en échange d'une souplesse que rien ne réclamait.
 *
 * Le jour où le propriétaire voudra les éditer lui-même, ce fichier devient une table sans douleur:
 * `lifeinvader_businesses.template` porte un NOM et non une clé étrangère, donc rien ne les retient.
 *
 * ⚠ Ne pas confondre avec les MODULES (modules.ts), qui sont aussi en code mais pour une raison
 * différente et plus forte: un module est adossé à une page qui l'implémente, donc en inventer un
 * depuis une interface créerait une case à cocher qui n'allume rien. Un modèle n'est qu'une
 * COMBINAISON de modules déjà écrits: il pourrait vivre en base, il n'en a simplement pas besoin.
 */
import { defaultModules } from "./modules";
import { DEFAULT_COMMISSION, type CommissionPolicy } from "./commission";

/**
 * ⚠ `icon` est une CLE DE `CATEGORY_ICONS` (lib/business/art.ts), PAS un nom d'icone Lucide.
 * Les deux se ressemblent assez pour qu'on se trompe, et l'erreur ne casse rien: une cle inconnue
 * retombe simplement sur `box`, donc chaque rayon de chaque commerce s'affiche avec la meme boite
 * grise et on croit que le portail est comme ca. Verifiee par verify-business.
 */
export type BusinessCategory = { key: string; label: string; tone: number; icon?: string };

/**
 * Une palette = DES VARIABLES CSS, nommees exactement comme la feuille de style les attend
 * (`brand`, `brand-text`, `k1`, `k1t`, `bg`, `surf`, `plate`). Pas de camelCase ni de traduction:
 * une couche de conversion entre le nom stocke et le nom CSS est une couche ou une cle se perd en
 * silence, et une variable absente ne casse rien de visible - elle retombe juste sur la valeur de
 * `:root`, donc toutes les enseignes finissent par se ressembler sans que personne ne comprenne
 * pourquoi. C'est exactement ce que le proprietaire a signale sur la maquette ("its looks the same
 * as vigneron").
 *
 * ⚠ DEUX THEMES, obligatoirement. `k1..k4` sont des REMPLISSAGES et `k1t..k4t` leur version TEXTE:
 * une couleur lisible en aplat est presque toujours illisible en texte sur le meme fond. En theme
 * clair le fond est blanc, donc `kNt = kN` et la paire se confond - mais pas en theme sombre, et
 * c'est la que naissent les blancs sur blanc.
 */
export type Palette = Record<string, string>;
export type ThemedPalette = { dark: Palette; light: Palette };

/**
 * UNE CAISSE EN GRILLE NUMÉROTÉE, où l'EMPLOYÉ saisit le prix, au lieu d'un catalogue d'articles.
 *
 * ⚠⚠ C'EST LA CAISSE, PAS L'ÉCRAN DE LA DIRECTION. Le propriétaire a été explicite: *"à la place de
 * choisir des items, la caisse pour eux doit être comme ça, et l'employé juste rentre le prix de
 * chaque tatouage fait"*. Un salon ne vend pas un article au prix affiché: il négocie une pièce, et
 * le prix est décidé devant le client. Il n'y a donc AUCUN article de catalogue derrière un
 * commerce en grille - ni à créer, ni à tenir à jour.
 *
 * ⚠⚠ ET C'EST LA SEULE SITUATION DU PORTAIL OÙ LE NAVIGATEUR ENVOIE UN MONTANT. `declareSale`
 * refuse par principe un prix venu du client (voir sa protection 1); un salon ne peut pas
 * fonctionner autrement. Le garde-fou qui remplace le prix-en-base est le PLAFOND PAR LIGNE
 * ci-dessous, appliqué côté serveur - il est ce qui empêche que "je tape mon prix" devienne "je
 * tape ma paie", puisque la part employé est un pourcentage de ce que l'employé vient de saisir.
 *
 * ⚠ LE LIBELLÉ D'UNE LIGNE EST FABRIQUÉ PAR LE SERVEUR (`labelPrefix` + numéro), jamais accepté du
 * client: c'est une chaîne qui finit copiée dans l'historique des ventes et affichée à d'autres.
 *
 * ⚠ UN SEUL RAYON. `category` est recopiée sur chaque ligne de vente pour que l'analytique groupe
 * ces prestations ensemble. Le modèle qui déclare une grille n'a qu'un rayon, sinon les autres
 * seraient invisibles: l'écran de caisse ne dessine que les cases.
 */
export type BusinessGrid = {
  /** Combien de cases, toujours affichées. Fixe: `Tatouage 1` à `Tatouage <slots>`. */
  slots: number;
  /** La clé du rayon recopiée sur les lignes. Doit exister dans `categories` du même modèle. */
  category: string;
  /** Le nom d'une case, fabriqué serveur: `Tatouage 7`. */
  labelPrefix: string;
  /**
   * LA VIGNETTE d'une case de la caisse: une cle de `PRODUCT_ART` (lib/business/art.ts), c'est-a-dire
   * un dessin PLEIN de 32x32 rendu a 72px sur la plaque claire, exactement comme un article de la
   * caisse ordinaire. C'est ce que le proprietaire a demande ("like normal caisse item icons").
   *
   * ⚠ NE PAS CONFONDRE AVEC `icon` juste en dessous. `art` est un ARTICLE (aplats, couleur, 72px);
   * `icon` est un RAYON (trait, teinte, 36px attenue) et ne sert que de repli. Se tromper de famille
   * ne casse rien: `visualFor` retombe simplement sur le repli, donc on obtient un trait fin gris a
   * la place d'une vignette produit et on croit que la caisse est comme ca. Verifiee par verify:business.
   */
  art: string;
  /**
   * L'icone du RAYON, repli de la vignette et illustration de la carte de rayon ailleurs dans le
   * portail. Une cle de `CATEGORY_ICONS`, PAS un nom d'icone Lucide.
   */
  icon: string;
  /**
   * LE PLAFOND PAR LIGNE, EN CENTIMES, à l'activation du commerce. Le patron le change ensuite
   * depuis sa page Tarifs (`lifeinvader_businesses.free_line_max_cents`).
   *
   * ⚠ C'est une valeur de DÉPART, pas la règle appliquée: la règle est celle du commerce, résolue
   * côté serveur. Un modèle ne peut pas décider du plafond d'un salon qu'il ne connaît pas.
   */
  maxLineCents: number;
};

export type BusinessTemplate = {
  name: string;
  label: string;
  /** Écarts par rapport à `defaultModules()`, pas l'état complet: un modèle décrit ce qui le
   *  distingue, et hérite automatiquement de tout module ajouté au portail plus tard. */
  modules?: Record<string, boolean>;
  palette: ThemedPalette;
  categories: BusinessCategory[];
  /** Absent = catalogue libre (le comportement de tous les modèles jusqu'au salon de tatouage). */
  grid?: BusinessGrid;
  /**
   * La part employé que ce genre de commerce PROPOSE. Le commerce peut la remplacer entièrement
   * depuis sa page Catalogue; tant qu'il ne l'a pas fait, il suit celle-ci. Absent = montant fixe
   * par article à 0, le comportement historique.
   */
  commission?: Partial<CommissionPolicy>;
  /**
   * Ce commerce vend les véhicules de FleetRoster dont `seller` contient son métier.
   * Absent = catalogue d'articles seulement. Voir lib/business/fleet.ts.
   */
  sellsVehicles?: boolean;
  /**
   * CE COMMERCE FACTURE LES MODIFICATIONS DE VEHICULE au bareme du proprietaire.
   *
   * Demande du proprietaire (2026-08-23): l'employe choisit la voiture par recherche et les prix
   * s'affichent seuls, calcules a partir du cout reel des pieces et d'une marge que le commerce ne
   * peut pas changer. Voir lib/business/customMargin.ts.
   *
   * ⚠ PROPRIETE DU MODELE, RESOLUE SERVEUR, JAMAIS UN DRAPEAU RECU DU NAVIGATEUR - meme
   * raisonnement que `sellsVehicles` juste au-dessus, que `grid` et que `clientRecord`. Une caisse
   * capable de declarer "ce commerce facture des customs" ouvrirait ce chemin de prix a n'importe
   * quel commerce en une requete.
   *
   * ⚠ IL SUPPOSE UNE FICHE CLIENT: `clientRecord` doit valoir 'always' ou 'with-vehicle'. Une ligne
   * de custom n'a aucun sens sans la plaque de la voiture sur laquelle le travail a ete fait, et
   * c'est cette plaque qui rend le ticket retrouvable (index `idx_business_sales_plate`). Les deux
   * modes suffisent parce qu'un ticket de customs porte STRUCTURELLEMENT une voiture:
   * `declareCustomSale` appelle `clientRecordRequired(mode, true)`, donc 'with-vehicle' y exige la
   * fiche aussi surement que 'always'. verify:business le prouve pour chaque modele qui pose ce
   * drapeau.
   *
   * ⚠ DEPUIS LE 2026-08-27, CE DRAPEAU NE CHOISIT PLUS UNE CAISSE EXCLUSIVE. Demande du
   * proprietaire: le garage vend AUSSI des articles au comptoir ("to sell kit de reparation juste
   * like a supperette would") et la concession facture AUSSI des customs. La route caisse rend donc
   * DEUX volets (Customs + Boutique) des que ce drapeau est pose sur un modele a catalogue libre;
   * `caisseDefault` ci-dessous decide du volet ouvert a l'arrivee.
   */
  billsCustoms?: boolean;
  /**
   * LE VOLET OUVERT A L'ARRIVEE quand la caisse en a deux (`billsCustoms` + catalogue libre).
   *
   * Absent = 'customs' des que `billsCustoms` est pose: un atelier vit de ses customs. La
   * concession le renverse ('boutique'): elle vit de ses voitures et de sa boutique, les customs
   * sont son a-cote. Resolu par `templateCaisseDefault`. L'onglet n'ouvre aucun droit (chaque
   * action serveur re-verifie son propre chemin); ce champ ne sert qu'a ce que la caisse s'ouvre
   * chaque jour sur le meme visage.
   */
  caisseDefault?: "customs" | "boutique";
  /**
   * CHAQUE TICKET DOIT PORTER UNE FICHE CLIENT: identité du client et plaque du véhicule.
   *
   * Demande du propriétaire (2026-08-21), pour la concession ET le garage: *"they need to insert the
   * firstname lastname birthdate and phone number of the person they sell to"*, *"same with car
   * mechanics"*, *"also for both car dealer and mechanic also the plate of the car"*.
   *
   * ⚠ C'EST UNE PROPRIÉTÉ DU MODÈLE, RÉSOLUE SERVEUR, ET JAMAIS UN DRAPEAU REÇU DU NAVIGATEUR - même
   * raisonnement que `sellsVehicles` juste au-dessus et que la grille de caisse. Une caisse capable
   * de dire "ce commerce n'a pas besoin de fiche" viderait la contrainte de son sens en une requête.
   *
   * ⚠ POURQUOI CES DEUX MODÈLES ET PAS LES AUTRES: un bar sert une tournée à un inconnu et c'est très
   * bien; une concession et un garage remettent un VÉHICULE IDENTIFIABLE à une personne, et c'est la
   * seule paperasse qui permette ensuite de savoir qui roule avec quoi. Ajouter le drapeau à un
   * troisième modèle est une décision du propriétaire, pas un défaut à combler.
   *
   * ⚠⚠ DEUX MODES, ET LA DIFFÉRENCE N'EST PAS COSMÉTIQUE:
   *   `always`        chaque ticket, sans exception. Plus aucun modèle ne le porte depuis le
   *                   2026-08-27 (le garage tient une boutique de comptoir désormais, voir sa
   *                   fiche), mais le mode reste défini: un futur commerce qui ne vendrait QUE du
   *                   travail sur véhicule le voudra.
   *   `with-vehicle`  seulement quand le ticket porte une VOITURE: une vente de véhicule, ou un
   *                   ticket de customs, qui en porte une par construction (`declareCustomSale`
   *                   passe `true` à `clientRecordRequired`). C'est la concession ET le garage,
   *                   qui tiennent tous deux une boutique: exiger une plaque pour un porte-clés ou
   *                   un kit de réparation obligerait l'employé à en inventer une, et une plaque
   *                   inventée dans une fiche est pire qu'une fiche absente - elle se lit comme un
   *                   fait.
   */
  clientRecord?: ClientRecordMode;
};

/** Quand la fiche client est exigée. Voir `clientRecord` ci-dessus. */
export type ClientRecordMode = "always" | "with-vehicle";

/**
 * ⚠ CES VALEURS SONT CELLES DE LA MAQUETTE APPROUVEE, recopiees depuis
 * `design/business-portal-demo.html`. Elles ont ete choisies en les regardant, sur une vingtaine
 * d'allers-retours, dont un explicitement consacre au fait que deux enseignes se ressemblaient
 * trop. Ne pas les "harmoniser".
 */
export const FALLBACK_PALETTE: ThemedPalette = {
  dark: {
    brand: "#a02c48", "brand-text": "#e58ba1",
    k1: "#a02c48", k2: "#a9762a", k3: "#6f7040", k4: "#4f6b74",
    k1t: "#e58ba1", k2t: "#dcaa62", k3t: "#adaf78", k4t: "#93b4be",
    bg: "#1a1416", surf: "#241c1f", plate: "#efebe3",
  },
  light: {
    brand: "#8a2440", "brand-text": "#8a2440",
    k1: "#8a2440", k2: "#8d5f18", k3: "#575831", k4: "#3f5760",
    k1t: "#8a2440", k2t: "#8d5f18", k3t: "#575831", k4t: "#3f5760",
    bg: "#f1eae1", surf: "#ffffff", plate: "#efebe3",
  },
};

const GENERIC_CATEGORIES: BusinessCategory[] = [
  { key: "principal", label: "Principal", tone: 1, icon: "basket" },
  { key: "secondaire", label: "Secondaire", tone: 2, icon: "box" },
  { key: "divers", label: "Divers", tone: 3, icon: "box" },
];

export const BUSINESS_TEMPLATES: BusinessTemplate[] = [
  {
    name: "commerce",
    label: "Commerce",
    // La palette LTD de la maquette: verte, lisible, et distincte des trois autres.
    palette: {
      dark: {
        brand: "#157a43", "brand-text": "#72cd99",
        k1: "#c2601c", k2: "#157a43", k3: "#b32b39", k4: "#3a6494",
        k1t: "#ea9e62", k2t: "#72cd99", k3t: "#ec8894", k4t: "#8fb1da",
        bg: "#131b16", surf: "#1c251f", plate: "#e7f0e9",
      },
      light: {
        brand: "#12703e", "brand-text": "#12703e",
        k1: "#a04d13", k2: "#12703e", k3: "#95212d", k4: "#2d5079",
        k1t: "#a04d13", k2t: "#12703e", k3t: "#95212d", k4t: "#2d5079",
        bg: "#eaf2eb", surf: "#ffffff", plate: "#e7f0e9",
      },
    },
    categories: GENERIC_CATEGORIES,
  },
  {
    name: "bar",
    label: "Bar / Club",
    palette: FALLBACK_PALETTE, // la palette Vigneron
    categories: [
      { key: "bieres", label: "Bières", tone: 1, icon: "beer" },
      { key: "cocktails", label: "Cocktails", tone: 2, icon: "glass" },
      { key: "softs", label: "Sans alcool", tone: 3, icon: "cup" },
      { key: "snacks", label: "Snacks", tone: 4, icon: "fork" },
    ],
  },
  {
    name: "restaurant",
    label: "Restaurant",
    palette: {
      dark: {
        brand: "#c0442e", "brand-text": "#f0937f",
        k1: "#c0442e", k2: "#35793a", k3: "#a8792f", k4: "#2b6f7d",
        k1t: "#f0937f", k2t: "#8ecf92", k3t: "#e0bd7c", k4t: "#84c3ce",
        bg: "#1d1513", surf: "#281c19", plate: "#fbf1e4",
      },
      light: {
        brand: "#a5341f", "brand-text": "#a5341f",
        k1: "#a5341f", k2: "#2c6a31", k3: "#7f5b1c", k4: "#1f5560",
        k1t: "#a5341f", k2t: "#2c6a31", k3t: "#7f5b1c", k4t: "#1f5560",
        bg: "#f6ece3", surf: "#ffffff", plate: "#fbf1e4",
      },
    },
    categories: [
      { key: "plats", label: "Plats", tone: 1, icon: "fork" },
      { key: "menus", label: "Menus", tone: 2, icon: "basket" },
      { key: "boissons", label: "Boissons", tone: 3, icon: "cup" },
      { key: "desserts", label: "Desserts", tone: 4, icon: "cup" },
    ],
  },
  {
    name: "garage",
    label: "Garage / Mécanique",
    // Un garage vend d'abord de la main d'oeuvre: les visuels produits sont eteints par defaut,
    // rallumables par le patron (utile depuis qu'il tient aussi une boutique de comptoir, voir
    // ci-dessous). Palette Benny's de la maquette.
    modules: { visuels: false },
    // ⚠ REVIREMENT PROPRIETAIRE 2026-08-27: c'etait `always` ("un garage travaille TOUJOURS sur
    // une voiture"). Le garage vend desormais AUSSI des articles au comptoir ("to sell kit de
    // reparation juste like a supperette would"), et une supérette n'exige pas de paperasse pour
    // un article. La fiche suit donc la VOITURE, comme a la concession: exigee sur chaque vente de
    // vehicule et sur chaque ticket de customs (qui porte une voiture par construction), jamais
    // sur un ticket de comptoir. Voir `clientRecord` dans BusinessTemplate.
    clientRecord: "with-vehicle",
    // Le garage est le premier commerce a facturer des customs au bareme. Voir `billsCustoms`.
    // Depuis le 2026-08-27 sa caisse a DEUX volets: Customs (defaut, un atelier vit de ses
    // customs) et Boutique (articles du catalogue + vehicules FleetRoster de son metier).
    billsCustoms: true,
    // Un garage peut aussi VENDRE une voiture du FleetRoster, pas seulement en reparer une. Demande
    // du proprietaire (2026-08-24) apres l'ajout du Mesa R chez Luxury: *"same with bennys add it to
    // theirs too"*.
    //
    // ⚠ CE DRAPEAU EST LU EN DIRECT, PAS SEME A L'ACTIVATION, contrairement a `commission` et
    // `categories` juste a cote. `templateSellsVehicles(access.template)` est appele a chaque rendu
    // de la caisse et a chaque `declareSale`, donc l'activer ici change IMMEDIATEMENT les commerces
    // `garage` DEJA actifs (aujourd'hui: Benny's seul, id 142) sans rien remettre en base. C'est ce
    // qui rend l'ajout possible sans toucher une ligne de `lifeinvader_businesses`, et c'est aussi ce
    // qui fait qu'il ne faut PAS le basculer a la legere.
    //
    // ⚠ CE QUI DECIDE DES VOITURES LISTEES RESTE `seller` DANS FleetRoster, pas ce drapeau. Un garage
    // sans aucun modele portant son metier dans `seller` voit une liste vide, pas le catalogue entier:
    // `vehiclesForJob(access.job)` filtre toujours. Benny's (job `mechanic`) ne voit donc que le seul
    // modele qui le nomme.
    //
    // ⚠ AUCUN EFFET EN JEU. `seller` alimente aussi le kiosque de flotte de `gs_jobs`, mais celui-ci
    // n'existe que la ou le metier declare un ActionPoint `VehicleShop`. `jobs/mechanic/config.lua`
    // n'en a aucun (verifie le 2026-08-24), la ou `jobs/luxury/config.lua` en a deux. Nommer
    // `mechanic` dans `seller` ne cree donc pas un concessionnaire en jeu, seulement une entree au
    // portail.
    //
    // La part employe sur une voiture retombe sur DEFAULT_COMMISSION.vehicleProfitBps (10 000 bps),
    // parce que `resolvePolicy` remplit tout champ absent depuis ce defaut: un garage deja actif n'a
    // donc pas de politique vehicule vide a corriger a la main.
    sellsVehicles: true,
    palette: {
      dark: {
        brand: "#e2570b", "brand-text": "#f79457",
        k1: "#e2570b", k2: "#2f7ba8", k3: "#bf9a1f", k4: "#7d868e",
        k1t: "#f79457", k2t: "#79b8e0", k3t: "#e2c76a", k4t: "#b6bfc7",
        bg: "#16181b", surf: "#1f2226", plate: "#eceae6",
      },
      light: {
        brand: "#c44a06", "brand-text": "#a83e04",
        k1: "#c44a06", k2: "#22617f", k3: "#7c6410", k4: "#5f676e",
        k1t: "#a83e04", k2t: "#22617f", k3t: "#7c6410", k4t: "#5f676e",
        bg: "#e9edf2", surf: "#ffffff", plate: "#eceae6",
      },
    },
    // ⚠ `vehicules` ajouté le 2026-08-27: c'est le rayon du chip Véhicules de la caisse Boutique et
    // celui ou `declareSale` range une ligne de vente de voiture (VEHICLE_CATEGORY_KEY). Sans lui,
    // le Mesa R de Benny's (demande du 2026-08-24) n'avait AUCUN chip: la caisse du garage rendait
    // le volet customs seul, donc `sellsVehicles` etait injoignable a la caisse jusqu'au volet
    // Boutique d'aujourd'hui. Les garages deja actifs recoivent ce rayon par la passe de rattrapage
    // de seed-business-dealers.ts, comme les rayons de customs de la concession.
    categories: [
      { key: "reparation", label: "Réparation", tone: 1, icon: "wrench" },
      { key: "performance", label: "Performance", tone: 2, icon: "bolt" },
      { key: "esthetique", label: "Esthétique", tone: 3, icon: "spray" },
      { key: "vehicules", label: "Véhicules", tone: 1, icon: "car" },
      { key: "divers", label: "Divers", tone: 4, icon: "box" },
    ],
  },
  {
    name: "superette",
    label: "Supérette / 24-7",
    palette: {
      dark: {
        brand: "#d92b3d", "brand-text": "#ff9aa4",
        k1: "#d92b3d", k2: "#35793a", k3: "#c23b7a", k4: "#2b7d63",
        k1t: "#ff9aa4", k2t: "#8ecf92", k3t: "#eb92bd", k4t: "#7fc9b2",
        bg: "#241318", surf: "#30191f", plate: "#fbe4ea",
      },
      light: {
        brand: "#b0203a", "brand-text": "#a01c34",
        k1: "#b0203a", k2: "#2c6a31", k3: "#9c2c60", k4: "#22624e",
        k1t: "#a01c34", k2t: "#2c6a31", k3t: "#9c2c60", k4t: "#22624e",
        bg: "#fdf0f3", surf: "#ffffff", plate: "#fbe4ea",
      },
    },
    categories: [
      { key: "boissons", label: "Boissons", tone: 1, icon: "cup" },
      { key: "snacks", label: "Snacks", tone: 2, icon: "basket" },
      { key: "hygiene", label: "Hygiène", tone: 3, icon: "med" },
      { key: "divers", label: "Divers", tone: 4, icon: "basket" },
    ],
  },
  {
    name: "tatouage",
    label: "Salon de tatouage",
    /**
     * LE PREMIER MODÈLE QUI NE VEND PAS DES ARTICLES, et les deux écarts en découlent tous les deux.
     *
     * ⚠ `visuels` N'EST PLUS ÉTEINT ICI, et c'est un revirement assumé. Le premier jet l'éteignait au
     * motif qu'un salon vend une prestation et non un produit en rayon. Le propriétaire a tranché
     * l'inverse en regardant l'écran ("like normal caisse item icons"): chaque case porte la vignette
     * de la machine, comme un article de n'importe quelle autre caisse. Le module reste allumable et
     * éteignable par le patron, et l'éteindre retire les vignettes sans rien casser d'autre.
     *
     * La part employé en POURCENTAGE, à 50 % pour commencer: un tatoueur est rémunéré à la fraction
     * de la pièce, pas au forfait par ligne de catalogue. 50 % est le partage moitié-moitié classique
     * du métier - un point de départ que le patron ajuste artiste par artiste, jamais une règle.
     */
    commission: { mode: "pourcentage", bps: 5000 },
    /**
     * VINGT CASES NUMÉROTÉES À LA CAISSE, et l'employé y tape le prix de chaque tatouage qu'il vient
     * de faire. C'est la seule forme honnête ici: le catalogue de motifs du jeu se compte en
     * milliers, aucun patron ne le saisira à la main, et le prix d'une pièce se négocie de toute
     * façon devant le client. Le plafond de départ est ce qu'une pièce chère peut coûter au salon;
     * le patron l'ajuste.
     */
    grid: {
      slots: 20,
      category: "tatouages",
      labelPrefix: "Tatouage",
      art: "tattooMachine",
      icon: "tattoo",
      maxLineCents: 500_000,
    },
    // Encre et or: aucune des cinq autres enseignes n'est violette, ce qui est exactement le point
    // (voir l'avertissement de FALLBACK_PALETTE: deux enseignes qui se ressemblent est un défaut
    // signalé par le propriétaire, pas un détail).
    palette: {
      dark: {
        brand: "#7b3fa0", "brand-text": "#c79ae0",
        k1: "#7b3fa0", k2: "#2f7d8c", k3: "#b0862a", k4: "#a83f63",
        k1t: "#c79ae0", k2t: "#7cc3cf", k3t: "#e2c477", k4t: "#e394ae",
        bg: "#171320", surf: "#211b2c", plate: "#eae6f0",
      },
      light: {
        brand: "#5f2f85", "brand-text": "#5f2f85",
        k1: "#5f2f85", k2: "#1f6470", k3: "#7d5c14", k4: "#8a2f4e",
        k1t: "#5f2f85", k2t: "#1f6470", k3t: "#7d5c14", k4t: "#8a2f4e",
        bg: "#f1edf5", surf: "#ffffff", plate: "#eae6f0",
      },
    },
    // ⚠ UN SEUL RAYON, ET IL PORTE LA CLÉ QUE `grid.category` DÉSIGNE. En ajouter un second ici
    // créerait un rayon qu'aucun écran ne sait garnir (voir BusinessGrid).
    categories: [{ key: "tatouages", label: "Tatouages", tone: 1, icon: "tattoo" }],
  },
  {
    name: "concession",
    label: "Concessionnaire",
    /**
     * MULTI: voitures (FleetRoster, prix serveur, part = % du profit par GRADE) ET boutique
     * (articles saisis comme n'importe quel commerce). On ne recopie pas les voitures dans le
     * catalogue d'articles: Luxury à elle seule en a 250, PDM 460.
     *
     * La part boutique reste le mode historique (montant par article, ou % si le patron bascule).
     * La part véhicule est une politique SÉPARÉE dans le même JSON (`vehicleProfitBps` + `byGrade`),
     * pour qu'un % tatouage/boutique ne se retrouve jamais appliqué à une supercar.
     */
    sellsVehicles: true,
    // ⚠ AJOUT PROPRIETAIRE 2026-08-27: la concession facture AUSSI des customs au bareme, comme le
    // garage ("and also be able to do customs with required customer info"). Meme bareme central
    // (customMargin.ts), meme caisse Customs, meme fiche client obligatoire sur chaque ticket de
    // customs (le mode `with-vehicle` ci-dessous l'exige des qu'une voiture est en jeu, et un
    // ticket de customs en porte une par construction).
    billsCustoms: true,
    // La concession vit de ses voitures et de sa boutique; les customs sont son a-cote. Le volet
    // Boutique reste donc celui qui s'ouvre a l'arrivee, contrairement au garage.
    caisseDefault: "boutique",
    // La concession tient AUSSI une boutique: la fiche suit la voiture, pas le ticket. Voir
    // `clientRecord` dans BusinessTemplate pour pourquoi ce n'est pas `always`.
    clientRecord: "with-vehicle",
    commission: { mode: "montant", bps: 0, vehicleProfitBps: 10_000, byGrade: {} },
    palette: {
      dark: {
        brand: "#2b6cb0", "brand-text": "#8fb8e8",
        k1: "#2b6cb0", k2: "#c44a06", k3: "#2f7d8c", k4: "#6b5a3a",
        k1t: "#8fb8e8", k2t: "#f79457", k3t: "#7cc3cf", k4t: "#d2c09a",
        bg: "#12161c", surf: "#1a2028", plate: "#e8edf2",
      },
      light: {
        brand: "#1e4e86", "brand-text": "#1e4e86",
        k1: "#1e4e86", k2: "#a83e04", k3: "#1f6470", k4: "#5a4a2e",
        k1t: "#1e4e86", k2t: "#a83e04", k3t: "#1f6470", k4t: "#5a4a2e",
        bg: "#eef2f7", surf: "#ffffff", plate: "#e8edf2",
      },
    },
    // ⚠ `performance` et `esthetique` sont les rayons ou `declareCustomSale` range ses lignes
    // (memes cles qu'au garage, pour que l'analytique compare les deux enseignes). Sans eux, une
    // ligne de custom s'afficherait sous sa cle brute, sans libelle ni teinte. Les concessions
    // DEJA actives ont recu ces rayons par la passe de rattrapage de seed-business-dealers.ts:
    // les rayons sont copies sur la ligne du commerce a l'activation, un modele edite ne les
    // atteint pas tout seul.
    categories: [
      { key: "vehicules", label: "Véhicules", tone: 1, icon: "car" },
      { key: "boutique", label: "Boutique", tone: 2, icon: "basket" },
      { key: "services", label: "Services", tone: 3, icon: "wrench" },
      { key: "performance", label: "Performance", tone: 2, icon: "bolt" },
      { key: "esthetique", label: "Esthétique", tone: 3, icon: "spray" },
      { key: "divers", label: "Divers", tone: 4, icon: "box" },
    ],
  },
];

const BY_NAME = new Map(BUSINESS_TEMPLATES.map((t) => [t.name, t]));

/**
 * Le modèle par son nom.
 *
 * Renvoie `null` pour un nom inconnu plutôt que de retomber en silence sur "commerce": un commerce
 * dont le modèle a disparu doit garder ses propres réglages (palette et rayons vivent sur SA ligne),
 * pas hériter de ceux d'un modèle qu'il n'a jamais choisi.
 */
export function getTemplate(name: string): BusinessTemplate | null {
  return BY_NAME.get(name) ?? null;
}

/** Ce qu'un commerce reçoit à son activation sous ce modèle. Copié sur sa ligne, puis lui appartient. */
export function templateSeed(name: string): {
  modules: Record<string, boolean>;
  palette: ThemedPalette;
  categories: BusinessCategory[];
} {
  const tpl = getTemplate(name);
  return {
    modules: { ...defaultModules(), ...(tpl?.modules ?? {}) },
    palette: tpl?.palette ?? FALLBACK_PALETTE,
    categories: tpl?.categories ?? GENERIC_CATEGORIES,
  };
}

/**
 * LA GRILLE DE CE MODÈLE, ou null si son catalogue est libre.
 *
 * ⚠ ON NE REND UNE GRILLE QUE SI SON RAYON EXISTE DANS LE MODÈLE. Une grille qui désigne un rayon
 * absent produirait des cases enregistrées sous un rayon que `validateItem` refuse, donc un écran
 * entier où chaque enregistrement échoue avec "ce rayon n'existe pas dans ce commerce" - un refus
 * incompréhensible, puisque la personne n'a jamais choisi de rayon. On préfère retomber sur le
 * catalogue libre, qui marche, plutôt que d'offrir une grille qui ne peut rien écrire.
 */
export function templateGrid(name: string): BusinessGrid | null {
  const tpl = getTemplate(name);
  if (!tpl?.grid) return null;
  return tpl.categories.some((c) => c.key === tpl.grid!.category) ? tpl.grid : null;
}

/** La part employé que ce modèle propose, ou le défaut (montant fixe à 0). */
export function templateCommission(name: string): Partial<CommissionPolicy> {
  return getTemplate(name)?.commission ?? DEFAULT_COMMISSION;
}

export const VEHICLE_CATEGORY_KEY = "vehicules";

/** Ce modèle vend des voitures FleetRoster (caisse mixte), ou non. */
export function templateSellsVehicles(name: string): boolean {
  return Boolean(getTemplate(name)?.sellsVehicles);
}

/**
 * QUAND ce modèle exige une fiche client (identité + plaque), ou null s'il n'en demande jamais.
 *
 * ⚠ UN MODÈLE INCONNU REND `null`, comme partout ailleurs dans ce fichier. Le repli permissif est le
 * bon ici: un commerce dont le modèle a disparu doit continuer de pouvoir déclarer ses ventes, pas se
 * retrouver à exiger une paperasse que son écran ne sait pas afficher.
 */
/** Ce modele facture-t-il les customs au bareme? Voir `billsCustoms` sur BusinessTemplate. */
export function templateBillsCustoms(name: string): boolean {
  return Boolean(getTemplate(name)?.billsCustoms);
}

/**
 * LE VOLET OUVERT A L'ARRIVEE d'une caisse a deux volets. Voir `caisseDefault` sur
 * BusinessTemplate. Sans reglage explicite, un modele qui facture des customs s'ouvre dessus
 * (le garage), les autres sur la boutique.
 */
export function templateCaisseDefault(name: string): "customs" | "boutique" {
  const tpl = getTemplate(name);
  return tpl?.caisseDefault ?? (tpl?.billsCustoms ? "customs" : "boutique");
}

/**
 * CE COMMERCE CONNAIT-IL SON COUT DE REVIENT, donc son benefice.
 *
 * ⚠ C'EST CE QUI DECIDE SI ON AFFICHE LE BENEFICE, ET IL NE FAUT PAS AFFICHER SANS. Une concession
 * connait le prix concession de chaque voiture, un garage connait le cout des pieces au bareme. Un
 * bar, une superette, un salon de tatouage n'ont AUCUN cout de revient enregistre: leurs lignes
 * laissent `unit_cost_cents` a NULL, donc leur `margin_cents` vaut 0 pour toujours. Montrer
 * "Benefice 0 $" a un patron de bar affirmerait qu'il vend a prix coutant, ce qui est faux et
 * inquietant, alors que la verite est que personne n'a jamais saisi ce que sa biere lui coute.
 *
 * ⚠ DERIVE DES DEUX DRAPEAUX EXISTANTS, jamais une troisieme liste a tenir a jour. Un modele qui
 * gagne `sellsVehicles` ou `billsCustoms` demain gagne le benefice sans autre edition.
 */
export function templateMeasuresCost(name: string): boolean {
  return templateSellsVehicles(name) || templateBillsCustoms(name);
}

export function templateClientRecord(name: string): ClientRecordMode | null {
  return getTemplate(name)?.clientRecord ?? null;
}

/**
 * LA FICHE EST-ELLE EXIGÉE POUR CE TICKET-CI.
 *
 * ⚠ UNE SEULE DÉFINITION, PARTAGÉE PAR L'ÉCRAN ET PAR LE SERVEUR. La caisse s'en sert pour allumer
 * l'astérisque et bloquer le bouton, `declareSale` pour refuser; deux lectures écrites séparément
 * finiraient par ne plus dire la même chose, et ce jour-là l'écran laisse valider ce que le serveur
 * refuse - ou pire, l'inverse.
 */
export function clientRecordRequired(
  mode: ClientRecordMode | null,
  ticketHasVehicle: boolean,
): boolean {
  if (mode === "always") return true;
  if (mode === "with-vehicle") return ticketHasVehicle;
  return false;
}
