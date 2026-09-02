/**
 * DE L'ARTICLE DU JEU AU DESSIN. Le pont entre `items.name` (ESX) et une cle de `PRODUCT_ART`.
 *
 * POURQUOI CE FICHIER EXISTE. `art.ts` a ete dessine a partir de CATEGORIES generiques (un burger,
 * une pizza, un taco, une brique de lait) sans jamais ouvrir le catalogue du serveur. Le resultat
 * n'etait pas faux, il etait INVERIFIABLE: personne ne pouvait dire si une carte de commerce
 * trouverait un dessin pour ce qu'un patron met vraiment en vente, ni combien de produits reels
 * n'en avaient aucun. Une table de correspondance transforme "je crois qu'on a un dessin pour ca"
 * en un ensemble que le code compte, et que `verify:business` refuse de laisser pourrir.
 *
 * MESURE DU 2026-08-08: 163 articles de bouche sont vendables par un lieu vivant. 82 trouvaient un
 * dessin dans les 96 illustrations d'origine, 81 n'en avaient aucun. 29 dessins ont ete ajoutes a
 * `art.ts` pour combler exactement ces 81, la couverture est donc de 163/163.
 *
 * D'OU VIENT LA LISTE, dans cet ordre de preuve:
 *   1. la table `items` de la base de jeu (630 lignes), qui dit ce qui EXISTE;
 *   2. `gs_jobs/common/recipe.lua` croise avec la config de chaque metier VIVANT, qui dit ce qu'un
 *      lieu FABRIQUE, donc ce qu'il peut vendre;
 *   3. les points de vente qui ne passent pas par une recette: les distributeurs
 *      (`gs_jobs/modules/vendingMachines`), la boutique 24/7 (`gs_base/modules/shops`) et le
 *      registre des consommables (`gs_base/modules/basicneeds`).
 *
 * ⚠ LES 9 METIERS RETIRES NE COMPTENT PAS. `pizza`, `bean`, `taco`, `punknoodles`, `musiclocker`,
 * `splitsides`, `crastenburg`, `pacificbluffs` et `perico` ne vivent plus que dans `[old]/`. Leurs
 * ARTICLES sont toujours dans la table `items` (les douze `cherrycake*`, `donut`, `nachos`,
 * `pizzamedium`, `blueicecream`, `viennoiserie`...), mais plus AUCUNE config vivante ne reference
 * la recette qui les produit, donc plus aucun lieu ne les fabrique. Verifie une par une: les
 * recettes `CherryCake*`, `Donut`, `Nachos`, `Pizza*`, `Milkshake`, `Coffee`, `Expresscoffee`,
 * `Viennoiserie` ne sont citees nulle part hors de `recipe.lua`. Elles ne sont donc pas dans
 * `GAME_FOOD_ITEMS`, et le dessin qui existe pour elles reste dans `art.ts` au titre du generique
 * (voir le bloc ORPHELINS plus bas).
 *
 * ⚠ UN DESSIN POUR PLUSIEURS ARTICLES EST LA BONNE REPONSE, PAS UN RACCOURCI. Les quatre burgers du
 * Cluckin' Bell, les 21 prises de peche au poids, les six futs: a 72px ce sont les memes objets. On
 * dedouble quand la SILHOUETTE change, jamais quand seule l'etiquette change. C'est deja la regle
 * ecrite dans `art.ts`, ce fichier ne fait que l'appliquer a l'echelle du catalogue.
 *
 * ⚠ CE N'EST PAS UNE CONTRAINTE SUR LE CATALOGUE. `lifeinvader_business_items.label` est du texte libre:
 * un bar peut vendre une "Planche de charcuterie" qui n'est adossee a aucun `items.name`. Cette
 * table sert a PROPOSER le bon dessin quand un patron tape un vrai produit, jamais a refuser ce
 * qu'il tape.
 */
import { PRODUCT_ART } from "./art";

/**
 * L'INVENTAIRE AUDITE: tout article de bouche atteignable par une chaine de production ou un point
 * de vente VIVANT, au 2026-08-08. C'est le denominateur de la couverture, et la seule raison pour
 * laquelle un chiffre de couverture veut dire quelque chose. Ajouter une recette au jeu sans
 * ajouter l'article ici ne casse rien; l'ajouter ici sans dessin fait baisser la couverture que
 * `verify:business` imprime, ce qui est exactement le signal voulu.
 *
 * Les articles NON comestibles atteints par les memes chaines (mousquets, rateliers, kits de
 * reparation, gants de boxe, canons a confettis, sapins) sont volontairement absents: ils ne sont
 * pas la carte d'un commerce de bouche. Plusieurs ont quand meme leur entree dans `ITEM_ART`
 * ci-dessous, parce qu'un garage ou une supérette en vend.
 */
export const GAME_FOOD_ITEMS: readonly string[] = [
  // Fast-food: Burger Shot, Cluckin' Bell, Up-n-Atom, Bayview.
  "burger", "burgerroyal", "tunaburger", "frite", "soda",
  "cbburger", "cbburgerroyal", "cbfrite", "cbsoda",
  "atomburger", "atomburgerroyal", "atomtunaburger", "atomfrite", "atomsoda",
  "huntingmeatburger", "fishhuntingmeatburger", "huntingmeatsalad", "huntingmeatpotato",
  "bayviewfrite", "sodabayview", "beefjerky",
  // Pearls (poissonnerie) et Dragon d'Or (asiatique).
  "lobstertomato", "barseaweed", "sardinepatato", "salmonfrite", "tunarice", "eelgrape",
  "carprice", "orangeotang",
  "maki", "sushi", "ramenmeat", "ramenfish", "ramenshark", "fortunecookie", "sake", "sodatea",
  // Decoupes de poisson, produites par Pearls et le Dragon d'Or.
  "barpiece", "carppiece", "eelpiece", "lobsterpiece", "salmonpiece", "sardinepiece", "tunapiece",
  // Prises brutes: peche publique (7 especes x 3 tailles) et 6 especes de recif.
  "barheavy", "barmedium", "barsmall",
  "carpheavy", "carpmedium", "carpsmall",
  "eelheavy", "eelmedium", "eelsmall",
  "lobsterheavy", "lobstermedium", "lobstersmall",
  "salmonheavy", "salmonmedium", "salmonsmall",
  "sardineheavy", "sardinemedium", "sardinesmall",
  "tunaheavy", "tunamedium", "tunasmall",
  "marlin", "mahi", "parrotfish", "lionfish", "butterflyfish", "clownfish", "seaweed",
  // Chasse et elevage (gs_animals), viande de cuisine.
  "meat", "meatcook", "huntingmeat", "fishhuntingmeat", "exotichuntingmeat", "largefin", "fin",
  "milk", "egg",
  // Ranch: recoltes et atelier. `cone` est bien un cornet de glace (recette 'Cone', ble x4).
  "tomato", "tomatoslice", "potato", "rice", "orange", "apple", "agave", "coconut", "corn",
  "lettuce", "lettuceleaf", "wheat", "bread", "cheese", "cone",
  // Vigneron: la vigne, ses quatre qualites, ses sous-produits, son point de vente.
  "grape", "grapejuice", "winemarc", "sugar",
  "wine", "grandcru", "vintage", "champagne", "vintageagedbarrel", "wineliquor",
  "wineglass", "grandcruglass", "vintageglass", "champagneglass", "vintageagedbarrelglass",
  "wineliquorglass", "hotwineglass",
  // Spiritueux: chaque alambic appartient a un lieu (Hen House cognac, Tequi-la-la tequila,
  // Yellow Jack whiskey, Bahama rhum, Dragon d'Or sake, Bratva vodka).
  "rum", "cognac", "tequila", "whiskey", "vodka",
  "rumglass", "cognacglass", "tequilaglass", "whiskeyglass", "vodkaglass", "sakeglass",
  // Cocktails, un par maison.
  "bahamacocktail", "hencocktail", "tequilasunrise", "bloodymary",
  // Brasserie Pibwasser: cinq bieres plus la Blarneys, en bouteille et en fut, et la chaine amont.
  "pibwasser", "doublepibwasser", "triplepibwasser", "royalepibwasser", "lostpibwasser", "blarneys",
  "pibwasserkeg", "doublepibwasserkeg", "triplepibwasserkeg", "royalepibwasserkeg",
  "lostpibwasserkeg", "blarneyskeg",
  "malt", "refinedmalt", "hop", "refinedhop", "yeast",
  // Eau, sous ses quatre contenants reels.
  "water", "purifiedwater", "watercan", "watercoolerbottle", "watercup",
  // Distributeurs non geres (toujours servis) et boutique 24/7.
  "ecola", "sprunk", "phatchips", "p&qs", "energydrink", "smallcoffee", "sandwich",
  // Cafes enregistres comme consommables dans `basicneeds` (leur atelier a disparu avec Bean, mais
  // le serveur sait toujours les boire, donc un cafe peut en vendre).
  "coffee", "expresscoffee", "irishcoffee", "milkcoffee", "cafegourmand",
  // Tabac de comptoir.
  "cigar",
];

/**
 * LA TABLE. `items.name` -> cle de `PRODUCT_ART`.
 *
 * Elle deborde volontairement de `GAME_FOOD_ITEMS`: un garage, une supérette ou une pharmacie sont
 * des commerces comme les autres, et `art.ts` avait deja leurs dessins. La couverture n'est calculee
 * que sur la bouche, mais le selecteur, lui, profite de tout.
 */
export const ITEM_ART: Readonly<Record<string, string>> = {
  /* ---- Hamburgers. `burger` pour la version simple, `cheeseburger` pour la Royal (bacon et
   * fromage): deux etages differents, deux dessins. Les versions au thon et au gibier reprennent
   * `burger`, la garniture ne se voit pas a 72px. ---- */
  burger: "burger",
  cbburger: "burger",
  atomburger: "burger",
  tunaburger: "burger",
  atomtunaburger: "burger",
  huntingmeatburger: "burger",
  fishhuntingmeatburger: "burger",
  burgerroyal: "cheeseburger",
  cbburgerroyal: "cheeseburger",
  atomburgerroyal: "cheeseburger",

  /* ---- Frites: quatre marques, une seule barquette. ---- */
  frite: "fries",
  cbfrite: "fries",
  atomfrite: "fries",
  bayviewfrite: "fries",

  /* ---- Sodas de fontaine. Le gobelet a couvercle et paille, pas la canette: les quatre fast-foods
   * servent au gobelet, et l'Orang-O-Tang de Pearls est le meme objet. ---- */
  soda: "sodaCup",
  cbsoda: "sodaCup",
  atomsoda: "sodaCup",
  sodabayview: "sodaCup",
  orangeotang: "sodaCup",
  sodacup: "sodaCup",

  /* ---- Assiettes. Le plat de Bayview au gibier passe par l'assiette de viande, sa salade par le
   * saladier, ses poissons par l'assiette de poisson. ---- */
  huntingmeatpotato: "steakPlate",
  meatcook: "steakPlate",
  huntingmeatsalad: "saladBowl",
  salmonfrite: "fishPlate",
  sardinepatato: "fishPlate",
  eelgrape: "fishPlate",
  barseaweed: "fishPlate",
  lobstertomato: "lobster",
  tunarice: "riceBowl",
  carprice: "riceBowl",
  ramenmeat: "noodleBowl",
  ramenfish: "noodleBowl",
  ramenshark: "noodleBowl",
  maki: "sushiRoll",
  sushi: "sushiSet",
  fortunecookie: "fortuneCookie",
  sodatea: "teaGreen",
  beefjerky: "jerky",

  /* ---- Peche. Les 21 prises au poids et les 6 especes de recif sont le meme poisson de profil;
   * les 7 decoupes sont le meme filet. Le homard garde sa silhouette (entier, morceau ou grille). ---- */
  barheavy: "fishRaw", barmedium: "fishRaw", barsmall: "fishRaw",
  carpheavy: "fishRaw", carpmedium: "fishRaw", carpsmall: "fishRaw",
  eelheavy: "fishRaw", eelmedium: "fishRaw", eelsmall: "fishRaw",
  salmonheavy: "fishRaw", salmonmedium: "fishRaw", salmonsmall: "fishRaw",
  sardineheavy: "fishRaw", sardinemedium: "fishRaw", sardinesmall: "fishRaw",
  tunaheavy: "fishRaw", tunamedium: "fishRaw", tunasmall: "fishRaw",
  marlin: "fishRaw", mahi: "fishRaw", parrotfish: "fishRaw",
  lionfish: "fishRaw", butterflyfish: "fishRaw", clownfish: "fishRaw",
  lobsterheavy: "lobster", lobstermedium: "lobster", lobstersmall: "lobster",
  lobsterpiece: "lobster",
  barpiece: "fishFillet", carppiece: "fishFillet", eelpiece: "fishFillet",
  salmonpiece: "fishFillet", sardinepiece: "fishFillet", tunapiece: "fishFillet",
  fishhuntingmeat: "fishFillet",
  fin: "fishFillet",
  largefin: "fishFillet",
  seaweed: "seaweed",

  /* ---- Viande et elevage. ---- */
  meat: "rawMeat",
  huntingmeat: "rawMeat",
  exotichuntingmeat: "rawMeat",
  milk: "milkCarton",
  egg: "eggBox",
  cheese: "cheesePlate",
  bread: "breadLoaf",
  cone: "iceCreamCone",

  /* ---- Recoltes du Ranch. La tranche de tomate et la feuille de salade renvoient au legume
   * entier: ce sont des etapes de cuisine, pas des produits de carte. ---- */
  tomato: "tomato",
  tomatoslice: "tomato",
  potato: "potato",
  lettuce: "lettuce",
  lettuceleaf: "lettuce",
  orange: "orangeFruit",
  apple: "apple",
  corn: "corn",
  coconut: "coconut",
  agave: "agave",
  wheat: "wheatSheaf",
  rice: "riceSack",
  sugar: "sugarSachet",

  /* ---- Vigneron. Les quatre qualites sortent de la MEME action de mise en bouteille et se
   * distinguent par le prix, jamais par la forme du flacon: une bouteille suffit. Les verres
   * partagent `wineRed` pour la meme raison. ---- */
  grape: "grapes",
  winemarc: "grapes",
  grapejuice: "juiceBottle",
  wine: "bottleWine",
  grandcru: "bottleWine",
  vintage: "bottleWine",
  vintageagedbarrel: "bottleWine",
  champagne: "champagneBottle",
  wineglass: "wineRed",
  grandcruglass: "wineRed",
  vintageglass: "wineRed",
  vintageagedbarrelglass: "wineRed",
  champagneglass: "champagneFlute",
  hotwineglass: "mulledWine",
  // Le jeu sert la liqueur de vin dans `prop_drink_whisky`: on suit le prop, pas le nom.
  wineliquor: "whiskyBottle",
  wineliquorglass: "whiskyTumbler",

  /* ---- Spiritueux et leurs verres. Le shot pour ce que le jeu sert en `prop_cs_shot_glass`
   * (vodka, tequila, sake), le tumbler pour ce qu'il sert en `prop_drink_whisky`. ---- */
  whiskey: "whiskyBottle",
  whiskeyglass: "whiskyTumbler",
  rum: "rumBottle",
  rumglass: "whiskyTumbler",
  vodka: "vodkaBottle",
  vodkaglass: "shotGlass",
  tequila: "tequilaBottle",
  tequilaglass: "shotGlass",
  sake: "sakeBottle",
  sakeglass: "shotGlass",
  cognac: "cognacBottle",
  cognacglass: "snifterGlass",

  /* ---- Cocktails: quatre recettes, un seul verre. ---- */
  bahamacocktail: "cocktailGlass",
  hencocktail: "cocktailGlass",
  tequilasunrise: "cocktailGlass",
  bloodymary: "cocktailGlass",

  /* ---- Brasserie. Bouteille pour ce qui se boit au verre, fut pour ce qui se vend au comptoir. ---- */
  pibwasser: "beerBottle",
  doublepibwasser: "beerBottle",
  triplepibwasser: "beerBottle",
  royalepibwasser: "beerBottle",
  lostpibwasser: "beerBottle",
  blarneys: "beerBottle",
  beer: "beerBottle",
  pibwasserkeg: "beerKeg",
  doublepibwasserkeg: "beerKeg",
  triplepibwasserkeg: "beerKeg",
  royalepibwasserkeg: "beerKeg",
  lostpibwasserkeg: "beerKeg",
  blarneyskeg: "beerKeg",
  // Le malt et le ble sont la meme cereale a cette taille; le houblon a sa propre forme.
  malt: "wheatSheaf",
  refinedmalt: "wheatSheaf",
  hop: "hopFlower",
  refinedhop: "hopFlower",
  yeast: "sugarSachet",

  /* ---- Eau. ---- */
  water: "waterBottle",
  purifiedwater: "waterBottle",
  watercan: "waterJug",
  watercoolerbottle: "waterJug",
  watercup: "paperCup",
  papercup: "paperCup",

  /* ---- Rayon supérette: distributeurs non geres et boutique 24/7. ---- */
  ecola: "sodaCan",
  sprunk: "sodaCan",
  energydrink: "energyDrink",
  phatchips: "chipsBag",
  "p&qs": "chipsBag",
  sandwich: "sandwichPack",

  /* ---- Cafes. Deux formes existent, la tasse et le gobelet a emporter; les cinq boissons du
   * registre des consommables se repartissent dessus. ---- */
  smallcoffee: "coffeeCup",
  expresscoffee: "coffeeCup",
  irishcoffee: "coffeeCup",
  cafegourmand: "coffeeCup",
  coffee: "coffeeToGo",
  milkcoffee: "coffeeToGo",

  /* ---- Tabac. ---- */
  cigar: "cigar",
  cigarette: "cigarette",
  packet: "cigPack",

  /* ---- Hors bouche, mais ce sont des commerces aussi. Ces articles existent tous dans `items` et
   * `art.ts` avait deja leur dessin: les laisser hors table priverait un garage, une pharmacie ou
   * une supérette du selecteur pour rien. ---- */
  fishingrod: "fishingRod",
  aluminumhook: "hookAlu",
  steelhook: "hookSteel",
  titaniumhook: "hookTitane",
  cobalthook: "hookCobalt",
  bag: "backpack",
  phone: "phone",
  sim_card: "simCard",
  digiscanner: "scanner",
  periscanner: "scanner",
  ghostscanner: "scanner",
  spraypaint: "sprayPaint",
  // ⚠ Les deux kits vehicule ont LEUR dessin depuis le 2026-08-13. Ils pointaient tous les deux sur
  // `wrenchTool`, comme `weapon_repairkit`: trois articles distincts, une seule cle plate, et une
  // carte qui ne disait plus lequel on achetait. `weapon_repairkit` GARDE la cle generique, c'est
  // un kit d'ARMURERIE et non de garage - la caisse a outils dirait le contraire.
  vehfixkit: "repairKit",
  vehcleankit: "cleanKit",
  weapon_repairkit: "wrenchTool",
  radio: "radio",
  oil: "oilCan",
  refinedoil: "oilCan",
  nitrokit: "pistonPart",
  bandage: "bandageItem",
  firstaid: "firstAid",
  medikit: "firstAid",
  animalmedikit: "firstAid",
  painkiller: "painkillerBox",
  sicknesspills: "painkillerBox",
  antisepticcream: "painkillerBox",
  antisepticproduct: "painkillerBox",
  morphine: "painkillerBox",
  blainecountybankcard: "prepaidCard",
  pacificcard: "prepaidCard",
  casinocard: "prepaidCard",
  carwincard: "prepaidCard",
  creditcard: "prepaidCard",
};

/**
 * LES ORPHELINS, traites explicitement plutot que laisses en suspens.
 *
 * Ce sont les cles de `PRODUCT_ART` qu'aucun `items.name` ne reclame. Toutes sont CONSERVEES, et la
 * raison est la meme pour les deux familles ci-dessous: `lifeinvader_business_items.label` est du texte
 * libre, donc un patron ecrit ce qu'il veut sur sa carte. Supprimer un dessin ne supprimerait pas le
 * produit, cela retirerait juste au patron le moyen de l'illustrer, et casserait le selecteur pour
 * les lignes deja en base qui s'en servent (le Bar du Vigneron en utilise 8 aujourd'hui).
 *
 *   31 SONT DU RP PUR, aucun article ESX derriere, et il n'y en aura pas: `wineWhite`,
 *   `bottleWineWhite`, `beerPint`, `beerPitcher`, `ciderBottle`, `martiniGlass`, `punchBowl`,
 *   `olivesBowl`, `boardMeat`, `croque`, `hotDog`, `roastChicken`, `soupBowl`, `pancakes`,
 *   `breakfastEggs`, `cerealBox`, `gumPack`, `toothpaste`, `soapBar`, `shampooBottle`,
 *   `toiletPaper`, `batteryPack`, `newspaper`, `condomPack`, `matchBox`, `lighter`, `sunglasses`,
 *   `umbrella`, `tireWheel`, `towTruck`, `breadBasket`.
 *   Un bar sert un verre de blanc, une supérette vend du dentifrice, un garage vend un pneu: ces
 *   lignes de carte sont legitimes meme sans article ESX en face.
 *
 *   10 ONT UN ARTICLE MAIS PLUS D'ATELIER: `pizzaSlice`, `pizzaWhole`, `taco`, `burrito`,
 *   `pastaPlate`, `cakeSlice`, `donut`, `milkshake`, `chocolateBar`, `candyBag`. Les articles
 *   correspondants (`pizzamedium`, `taco`, `burrito`, `pastafish`, les douze `cherrycake*`,
 *   `donut`, `milkshake`, `chocolateegg`, `candycane`) sont bien dans `items`, mais plus aucune
 *   chaine vivante ne les produit: metier retire pour les uns, contenu saisonnier sans atelier pour
 *   les autres. Ils ne comptent pas dans la couverture, et le dessin reste: le jour ou un de ces
 *   metiers revient, ou simplement ou un restaurant met une pizza a sa carte en RP, il est la.
 *   Aucun n'est mappe dans `ITEM_ART`, precisement pour ne pas laisser croire qu'un lieu les
 *   produit.
 *
 * ⚠ AVANT DE SUPPRIMER UNE CLE UN JOUR: elle peut etre stockee dans `lifeinvader_business_items.art_key`.
 * Une cle supprimee ne leve rien, elle retombe sur l'icone du rayon, donc la carte se degrade en
 * silence. Verifier la base d'abord.
 */

/** Retire accents, casse et ponctuation: la meme forme normalisee des deux cotes de la comparaison. */
function normalize(s: string): string {
  // NFD separe la lettre de son accent ("é" devient "e" plus un diacritique combinant), et le
  // filtre final ne garde que [a-z0-9], ce qui emporte le diacritique au passage. Il n'y a donc
  // AUCUNE ligne dediee au strip des accents: une plage de combinants ecrite en caracteres bruts
  // dans la source est exactement le genre de chose qu'un outil de recodage avale sans rien dire,
  // et la fonction se mettrait alors a laisser passer les accents en silence.
  return s.normalize("NFD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Index normalise de `ITEM_ART`, construit une fois. */
const NORMALIZED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ITEM_ART).map(([name, art]) => [normalize(name), art]),
);

/**
 * Regles de repli sur le LIBELLE francais, appliquees dans l'ordre et seulement si le nom d'article
 * n'a rien donne. Elles servent le cas reel du selecteur: le patron tape "Verre de rouge" ou
 * "Pinte", pas `wineglass`.
 *
 * ⚠ L'ORDRE COMPTE, et il va du plus specifique au plus vague. "verre de vin chaud" doit gagner
 * avant "verre de vin", "eau gazeuse" avant "eau". Inverser deux lignes ne casse rien de visible,
 * cela propose juste le mauvais dessin, ce qui est le genre d'erreur que personne ne signale.
 */
const LABEL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/vinchaud/, "mulledWine"],
  [/champagne|coupe/, "champagneFlute"],
  [/verredevin|verrederouge|verredeblanc|grandcru|millesime/, "wineRed"],
  [/bouteilledevin|^vin$/, "bottleWine"],
  [/cocktail|mojito|punch/, "cocktailGlass"],
  [/shot|tequila/, "shotGlass"],
  [/whisk|rhum|rum|cognac|liqueur/, "whiskyTumbler"],
  [/vodka/, "vodkaBottle"],
  [/fut|keg/, "beerKeg"],
  [/biere|beer|pinte|pibwasser|blarneys/, "beerBottle"],
  [/cafe|expresso|espresso|latte/, "coffeeCup"],
  [/the|infusion/, "teaGreen"],
  [/soda|cola|sprunk|limonade/, "sodaCan"],
  [/jus/, "juiceBottle"],
  [/eau/, "waterBottle"],
  [/burger|hamburger/, "burger"],
  [/frite/, "fries"],
  [/pizza/, "pizzaSlice"],
  [/sushi|maki/, "sushiSet"],
  [/ramen|nouille|noodle/, "noodleBowl"],
  [/riz/, "riceBowl"],
  [/poisson|saumon|thon|carpe|anguille|sardine/, "fishRaw"],
  [/homard/, "lobster"],
  [/salade/, "saladBowl"],
  [/viande|steak|gibier/, "steakPlate"],
  [/fromage/, "cheesePlate"],
  [/pain/, "breadLoaf"],
  [/gateau|cake|dessert/, "cakeSlice"],
  [/glace|cornet/, "iceCreamCone"],
  [/chips/, "chipsBag"],
  [/sandwich/, "sandwichPack"],
  [/cigar/, "cigar"],
  // Hors bouche, et places EN DERNIER a dessein: ces mots-la sont rares dans un libelle de carte,
  // alors que "the" ou "eau" apparaissent partout. Une regle vague en tete de liste vole les
  // libelles des regles precises qui la suivent, ce que l'en-tete de ce tableau explique deja.
  // "kit de reparation" avant "reparation" seule ne changerait rien: les deux tombent sur le meme
  // dessin, et c'est le NETTOYAGE qui doit gagner en premier puisqu'un "kit de nettoyage" contient
  // aussi le mot "kit".
  [/nettoyage|lavage/, "cleanKit"],
  [/reparation|depannage|outil/, "repairKit"],
  [/radio|talkie/, "radio"],
];

/**
 * Le dessin a PRE-SELECTIONNER pour un article, ou `null` quand on ne sait pas.
 *
 * ⚠ `null` EST UNE REPONSE, pas un echec a masquer. Le selecteur de la page Catalogue doit alors
 * laisser le patron choisir lui-meme; deviner un dessin plausible mettrait une biere sur une ligne
 * de pizza, ce qui est pire qu'une case vide parce que personne ne la corrigera.
 *
 * On essaie, dans l'ordre: le nom d'article exact, sa forme normalisee, puis le libelle francais via
 * `LABEL_RULES`. Le resultat est toujours une cle qui existe dans `PRODUCT_ART`, verifie ici meme:
 * une regle qui pointerait vers un dessin supprime rendrait `null` plutot qu'une cle morte.
 */
export function suggestArtKey(itemName?: string | null, label?: string | null): string | null {
  const direct = itemName ? ITEM_ART[itemName] : undefined;
  if (direct && PRODUCT_ART[direct]) return direct;

  if (itemName) {
    const byNorm = NORMALIZED[normalize(itemName)];
    if (byNorm && PRODUCT_ART[byNorm]) return byNorm;
  }

  const haystack = normalize(`${itemName ?? ""} ${label ?? ""}`);
  if (!haystack) return null;
  for (const [re, art] of LABEL_RULES) {
    if (re.test(haystack) && PRODUCT_ART[art]) return art;
  }
  return null;
}

/**
 * Combien d'articles de bouche du jeu ont un dessin, et lesquels n'en ont pas. Utilise par
 * `verify:business` pour imprimer une ligne de COUVERTURE: un chiffre qui recule se voit.
 */
export function artCoverage(): { total: number; covered: number; missing: string[] } {
  const missing = GAME_FOOD_ITEMS.filter((name) => {
    const art = ITEM_ART[name];
    return !art || !PRODUCT_ART[art];
  });
  return { total: GAME_FOOD_ITEMS.length, covered: GAME_FOOD_ITEMS.length - missing.length, missing };
}
