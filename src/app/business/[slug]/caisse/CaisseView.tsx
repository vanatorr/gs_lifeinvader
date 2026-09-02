"use client";

import { useMemo, useState, useTransition } from "react";
import type { ItemRow } from "@/lib/business/catalogue";
import {
  formatRate,
  unitCommissionCents,
  vehicleUnitCommissionCents,
  type CommissionMode,
} from "@/lib/business/commission";
import {
  vehicleClassLabel,
  vehicleMarginCents,
  vehiclePriceCents,
  type FleetVehicle,
} from "@/lib/business/fleet";
import { money, priceParts, toneVars } from "@/lib/business/theme";
import { visualFor } from "@/lib/business/art";
import {
  clientRecordRequired,
  VEHICLE_CATEGORY_KEY,
  type ClientRecordMode,
} from "@/lib/business/templates";
import {
  checkClientRecord,
  clientProblemText,
  CLIENT_FIELD_LABELS,
  EMPTY_CLIENT_DRAFT,
  type ClientRecordBounds,
  type ClientRecordDraft,
  type ClientRecordField,
} from "@/lib/business/clientRecord";
import { declareSaleAction, type DeclareState } from "../actions";

/**
 * LA VIGNETTE D'UN ARTICLE.
 *
 * ⚠ La grille rendait une plaque VIDE de 116px: le balisage posait bien `.tvis`, mais rien n'allait
 * jamais chercher le dessin, et `artKey` comme `categories[].icon` dormaient en base sans lecteur.
 * Une carte sur une plaque vide ne ressemble pas a un produit, et c'est ce qui faisait que la
 * caisse ne ressemblait pas a la maquette.
 *
 * ⚠ `dangerouslySetInnerHTML` est acceptable ICI et nulle part ailleurs dans ce fichier: la chaine
 * rendue ne vient PAS de la base, elle vient d'une table figee du code. La donnee stockee
 * (`artKey`) sert seulement de CLE de recherche, et une cle inconnue retombe sur le repli. C'est
 * exactement la distinction qui manquait a la palette avant le 2026-08-08: index contre contenu.
 */
function TileVisual({ item, icon }: { item: ItemRow; icon?: string }) {
  const v = visualFor(item.artKey, icon);
  return (
    <div className={`tvis ${v.kind}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: v.svg }} />
  );
}

type Category = { key: string; label: string; tone: number; icon?: string };

/**
 * UN CHAMP DE LA FICHE CLIENT.
 *
 * ⚠ LE MESSAGE N'APPARAÎT QU'APRÈS QUE LE CHAMP A ÉTÉ QUITTÉ (`touched`). Valider à la frappe
 * affiche "ce champ est obligatoire" sur la première lettre d'un prénom, donc un écran rouge en
 * permanence pendant qu'on remplit correctement, et on cesse de le lire. Le refus arrive quand la
 * saisie est finie, ou quand l'envoi a échoué.
 */
function Field({
  id,
  field,
  value,
  onChange,
  onBlur,
  problem,
  hint,
  placeholder,
  disabled,
  maxLength,
  inputMode,
}: {
  id: string;
  field: ClientRecordField;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  problem: string | null;
  hint?: string;
  placeholder?: string;
  disabled: boolean;
  maxLength: number;
  inputMode?: "text" | "numeric" | "tel";
}) {
  return (
    <label className="fld" htmlFor={id}>
      <span>
        {CLIENT_FIELD_LABELS[field]}
        {hint ? <em>{hint}</em> : null}
      </span>
      <input
        id={id}
        className={`fin ${problem ? "bad" : ""}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        inputMode={inputMode}
        autoComplete="off"
        // Le navigateur ne doit pas proposer le nom du joueur precedent: ce champ nomme un CLIENT,
        // et une suggestion d'autocompletion est exactement le genre de chose qu'on valide sans lire.
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-err` : undefined}
      />
      {problem ? (
        <span className="ferr" id={`${id}-err`}>
          {problem}
        </span>
      ) : null}
    </label>
  );
}

/**
 * LA CAISSE, côté navigateur.
 *
 * Le panier ne vit QUE dans cet état local: il n'existe aucune notion de ticket "en cours" en base,
 * et c'est voulu. Un panier persistant devrait être nettoyé, expiré, réconcilié entre deux onglets,
 * pour un objet dont la durée de vie utile est trente secondes. La seule chose qui existe est le
 * ticket DÉCLARÉ.
 */
export default function CaisseView({
  slug,
  name,
  items,
  vehicles = [],
  categories,
  canDeclare,
  showCommission,
  commission,
  showVisuals,
  clientRecordMode = null,
  clientBounds,
}: {
  slug: string;
  name: string;
  items: ItemRow[];
  vehicles?: FleetVehicle[];
  categories: Category[];
  canDeclare: boolean;
  showCommission: boolean;
  /** Quand ce commerce exige une fiche client. Vient du MODÈLE, résolu serveur (voir page.tsx). */
  clientRecordMode?: ClientRecordMode | null;
  /** Les bornes d'une identité, lues dans les fichiers du jeu. Voir clientRecordRules.ts. */
  clientBounds: ClientRecordBounds;
  /** Le mode du commerce et le taux DE CETTE PERSONNE. Voir caisse/page.tsx. */
  commission: {
    mode: CommissionMode;
    bps: number;
    vehicleBps: number;
  };
  showVisuals: boolean;
}) {
  const [cart, setCart] = useState<Record<number, number>>({});
  const [vCart, setVCart] = useState<Record<string, number>>({});
  const [cat, setCat] = useState<string>("*");
  const [q, setQ] = useState("");
  const [state, setState] = useState<DeclareState>({ status: "idle" });
  const [pending, start] = useTransition();

  /**
   * LA FICHE CLIENT. Vit à côté du panier, dans le même état local et pour la même raison: elle
   * n'existe qu'entre le moment où on la tape et celui où le ticket part.
   */
  const [client, setClient] = useState<ClientRecordDraft>(EMPTY_CLIENT_DRAFT);
  const [touched, setTouched] = useState<Partial<Record<ClientRecordField, true>>>({});

  /**
   * ⚠ LA CLÉ D'IDEMPOTENCE EST TIRÉE UNE FOIS PAR TICKET, pas à chaque envoi. C'est exactement ce qui
   * fait qu'un double-clic ou un renvoi réseau retombe sur la MÊME clé et se fait reconnaître comme
   * un doublon. La régénérer à chaque appel rendrait l'index unique décoratif.
   */
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());

  const toneOf = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c.tone]));
    return (key: string) => m.get(key) ?? 1;
  }, [categories]);

  const labelOf = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c.label]));
    return (key: string) => m.get(key) ?? key;
  }, [categories]);

  /** L'icone declaree par le rayon, qui sert de repli quand l'article n'a pas d'illustration. */
  const iconOf = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c.icon]));
    return (key: string) => m.get(key);
  }, [categories]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (it) =>
        (cat === "*" || it.category === cat) &&
        cat !== VEHICLE_CATEGORY_KEY &&
        (!needle || it.label.toLowerCase().includes(needle)),
    );
  }, [items, cat, q]);

  const shownVehicles = useMemo(() => {
    if (vehicles.length === 0) return [];
    const needle = q.trim().toLowerCase();
    if (cat !== VEHICLE_CATEGORY_KEY && !(cat === "*" && needle)) return [];
    return vehicles.filter(
      (v) =>
        !needle ||
        v.name.toLowerCase().includes(needle) ||
        v.model.toLowerCase().includes(needle) ||
        vehicleClassLabel(v.category).toLowerCase().includes(needle),
    );
  }, [vehicles, cat, q]);

  /**
   * LE TOTAL EST LA SOMME DES LIGNES, POINT. Ni sous-total, ni pourboire, ni remise: aucun des trois
   * n'existe dans ce commerce, et une ligne qui répète le total n'apprend rien.
   *
   * ⚠ LA PART EMPLOYÉ EST CALCULÉE À PART ET N'ENTRE JAMAIS DANS LE TOTAL. Le client paie le prix
   * affiché; c'est l'EMPLOYEUR qui verse la part en fin de semaine. La soustraire du total en ferait
   * une remise, ce qui est exactement l'inverse - l'argent sortirait de la poche du client au lieu
   * de celle de l'entreprise.
   *
   * Ce total est un AFFICHAGE. Celui qui compte est recalculé côté serveur à partir de la base:
   * le navigateur n'envoie que des identifiants d'article et des quantités.
   */
  const totals = useMemo(() => {
    let total = 0;
    let share = 0;
    // Le bénéfice cumulé des seules lignes véhicule, pour l'afficher à côté du total. Les articles
    // de boutique n'ont pas de coût de revient enregistré, donc les y mêler produirait une marge
    // globale fausse: voir `unitCostCents` dans sales.ts, `undefined` et `0` n'y sont pas la même
    // chose pour exactement cette raison.
    let vMargin = 0;
    const lines: { item: ItemRow; qty: number }[] = [];
    for (const it of items) {
      const qty = cart[it.id] ?? 0;
      if (qty <= 0) continue;
      lines.push({ item: it, qty });
      total += it.priceCents * qty;
      share +=
        (commission.mode === "pourcentage"
          ? unitCommissionCents(it.priceCents, commission.bps)
          : it.commissionCents) * qty;
    }
    const vLines: { vehicle: FleetVehicle; qty: number }[] = [];
    for (const v of vehicles) {
      const qty = vCart[v.model] ?? 0;
      if (qty <= 0) continue;
      vLines.push({ vehicle: v, qty });
      const price = vehiclePriceCents(v);
      total += price * qty;
      /**
       * ⚠ LA PART VÉHICULE SE CALCULE SUR LE BÉNÉFICE, PAS SUR LE PRIX (corrigé le 2026-08-27).
       * `vehicleMarginCents` vaut `prix client - prix concession`, les deux lus dans le catalogue du
       * jeu. Un modèle sans `dealerPrice` renvoie 0: la ligne s'affiche, se facture normalement, et
       * ne verse simplement aucune part. Cet aperçu doit rester l'exact miroir de `declareSale`,
       * sinon l'employé lit un chiffre au moment de vendre et en touche un autre à la paie.
       */
      const margin = vehicleMarginCents(v);
      vMargin += margin * qty;
      share += vehicleUnitCommissionCents(margin, commission.vehicleBps) * qty;
    }
    return { lines, vLines, total, vMargin, share: showCommission ? share : 0 };
  }, [items, vehicles, cart, vCart, showCommission, commission]);

  const bump = (id: number, by: number) =>
    setCart((c) => {
      const next = Math.max(0, (c[id] ?? 0) + by);
      const out = { ...c };
      if (next === 0) delete out[id];
      else out[id] = next;
      return out;
    });

  const bumpV = (model: string, by: number) =>
    setVCart((c) => {
      const next = Math.max(0, (c[model] ?? 0) + by);
      const out = { ...c };
      if (next === 0) delete out[model];
      else out[model] = next;
      return out;
    });

  const issued = state.status === "ok" ? state : null;
  const ticketEmpty = totals.lines.length + totals.vLines.length === 0;

  /**
   * ⚠ LA MÊME FONCTION QUE LE SERVEUR, PAS UNE COPIE DE SA RÈGLE. `clientRecordRequired` vit dans
   * `templates.ts` et `declareSale` l'appelle avec exactement ces deux arguments. Réécrire ici "si
   * garage, ou si concession avec voiture" ferait un second exemplaire de la règle, et le jour où le
   * propriétaire ajoute un troisième modèle, l'un des deux serait mis à jour et pas l'autre.
   */
  const vehicleUnits = totals.vLines.reduce((a, l) => a + l.qty, 0);
  const clientRequired = clientRecordRequired(clientRecordMode, vehicleUnits > 0);
  // Le panneau reste visible même quand la fiche n'est pas encore exigée: sur une concession, la
  // faire apparaître d'un coup en ajoutant une voiture au panier déplacerait tout l'écran sous la
  // souris de quelqu'un en train de cliquer.
  const showClientPanel = clientRecordMode !== null;

  // Un ticket à moitié rempli est toujours une erreur, exigé ou non: on valide dès qu'un champ est
  // renseigné. Vide et non exigé = rien à dire.
  const clientTouched = (Object.keys(EMPTY_CLIENT_DRAFT) as ClientRecordField[]).some(
    (k) => client[k].trim() !== "",
  );
  const clientCheck = useMemo(
    () => (clientTouched ? checkClientRecord(client, clientBounds) : null),
    [client, clientTouched, clientBounds],
  );

  /** Le refus du champ en cours, affiché seulement une fois le champ quitté. Voir `Field`. */
  const problemFor = (f: ClientRecordField): string | null => {
    if (!touched[f]) return null;
    if (clientCheck && !clientCheck.ok && clientCheck.field === f) {
      return clientProblemText(f, clientCheck.problem, clientBounds);
    }
    if (clientRequired && client[f].trim() === "") return "Ce champ est obligatoire.";
    return null;
  };

  const clientBlocked =
    (clientRequired && (!clientTouched || !clientCheck?.ok)) ||
    (clientTouched && clientCheck?.ok === false);
  // ⚠ La fiche ne porte qu'UNE plaque: deux voitures sur un ticket produiraient un document faux.
  // Le serveur refuse aussi, cette ligne évite seulement d'envoyer pour rien.
  const tooManyVehicles = clientRequired && vehicleUnits > 1;

  function submit() {
    if (ticketEmpty || pending || clientBlocked || tooManyVehicles) return;
    // Tout marquer comme quitté: si l'envoi est bloqué, l'employé doit voir OÙ, pas un bouton inerte.
    setTouched({ firstname: true, lastname: true, dob: true, phone: true, plate: true });
    start(async () => {
      const res = await declareSaleAction(slug, {
        lines: totals.lines.map((l) => ({ itemId: l.item.id, qty: l.qty })),
        vehicles: totals.vLines.map((l) => ({ model: l.vehicle.model, qty: l.qty })),
        // ⚠ On envoie le BROUILLON, pas la version normalisée: le serveur renormalise de toute
        // façon, et lui envoyer un objet déjà "propre" laisserait croire un jour qu'il peut s'en
        // contenter. Le navigateur ne décide de rien de ce qui est écrit en base.
        client: clientTouched ? client : null,
        clientRef,
      });
      setState(res);
    });
  }

  function newTicket() {
    setCart({});
    setVCart({});
    setState({ status: "idle" });
    setClient(EMPTY_CLIENT_DRAFT);
    setTouched({});
    setClientRef(crypto.randomUUID());
  }

  const setField = (f: ClientRecordField) => (v: string) =>
    setClient((c) => ({ ...c, [f]: v }));
  const blurField = (f: ClientRecordField) => () => setTouched((t) => ({ ...t, [f]: true }));

  return (
    <>
      <div className="head">
        <h1>Caisse</h1>
        <span className="sub">{name}</span>
      </div>

      <div className="caisse">
        <section>
          <div className="board">
            <div className="tools">
              <div className="cats">
                <button className="chip" data-cat="*" aria-pressed={cat === "*"} onClick={() => setCat("*")}>
                  Tout
                </button>
                {categories.map((c) => (
                  <button
                    key={c.key}
                    className="chip"
                    style={toneVars(c.tone) as React.CSSProperties}
                    aria-pressed={cat === c.key}
                    onClick={() => setCat(c.key)}
                  >
                    <i />
                    {c.label}
                  </button>
                ))}
              </div>
              <input
                className="search"
                placeholder={vehicles.length ? "Rechercher un véhicule ou un article" : "Rechercher"}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>

            {/* `pgrid`, pas `grid`: renommee dans business.css le 2026-08-09 parce que `.grid`
                entrait en collision avec l'utilitaire Tailwind du meme nom et ecrasait en silence
                la mise en page de tout composant shadcn du portail. Aucun changement visuel ici,
                la regle est la meme, seul son nom change. */}
            <div className="pgrid">
              {shownVehicles.length > 0 ? (
                <div className="vlist">
                  {shownVehicles.map((v) => {
                    const n = vCart[v.model] ?? 0;
                    const p = priceParts(vehiclePriceCents(v));
                    return (
                      <article
                        key={v.model}
                        className={`vrow ${n ? "picked" : ""}`}
                        style={toneVars(toneOf(VEHICLE_CATEGORY_KEY)) as React.CSSProperties}
                      >
                        {showVisuals ? (
                          <div
                            className={`tvis art`}
                            aria-hidden="true"
                            dangerouslySetInnerHTML={{ __html: visualFor("sedanCar", "car").svg }}
                          />
                        ) : null}
                        <div className="tbody">
                          <div className="tcat">{vehicleClassLabel(v.category)}</div>
                          <div className="tnm">{v.name}</div>
                          <div className="tpr">
                            {p.amount}
                            <sup>{p.symbol}</sup>
                          </div>
                        </div>
                        <div className="step">
                          <button onClick={() => bumpV(v.model, -1)} disabled={!n} aria-label="Retirer">
                            &minus;
                          </button>
                          <span className={`q ${n ? "" : "zero"}`}>
                            <span>{n}</span>
                          </span>
                          <button
                            className="plus"
                            onClick={() => bumpV(v.model, 1)}
                            disabled={!canDeclare || Boolean(issued)}
                            aria-label="Ajouter"
                          >
                            +
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : null}
              {shown.length === 0 && shownVehicles.length === 0 ? (
                <div className="note">
                  {items.length === 0 && vehicles.length === 0
                    ? "Le catalogue est vide. La direction doit y ajouter des articles."
                    : "Aucun article ne correspond."}
                </div>
              ) : (
                shown.map((it) => {
                  const n = cart[it.id] ?? 0;
                  const p = priceParts(it.priceCents);
                  return (
                    <article
                      key={it.id}
                      className={`tile ${n ? "picked" : ""}`}
                      style={toneVars(toneOf(it.category)) as React.CSSProperties}
                    >
                      {showVisuals ? <TileVisual item={it} icon={iconOf(it.category)} /> : null}
                      <div className="tbody">
                        <div className="tcat">{labelOf(it.category)}</div>
                        <div className="tnm">{it.label}</div>
                        <div className="tpr">
                          {p.amount}
                          <sup>{p.symbol}</sup>
                        </div>
                      </div>
                      <div className="step">
                        <button onClick={() => bump(it.id, -1)} disabled={!n} aria-label="Retirer">
                          &minus;
                        </button>
                        <span className={`q ${n ? "" : "zero"}`}>
                          <span>{n}</span>
                        </span>
                        <button
                          className="plus"
                          onClick={() => bump(it.id, 1)}
                          disabled={!canDeclare || Boolean(issued)}
                          aria-label="Ajouter"
                        >
                          +
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <aside className="receipt">
          {issued ? (
            <>
              <div className="paper rc">
                <div className="rh">
                  <b>{name}</b>
                  <span>Ticket {issued.publicRef}</span>
                </div>
                <div className="stamp">À facturer</div>
                <div className="rbig">{money(issued.totalCents)}</div>
                {/* Sans cette phrase, un montant en gros ressemble à un encaissement. Le portail
                    ne déplace pas d'argent: c'est l'employé qui établit la facture en jeu. */}
                {/* ⚠ La seconde phrase de la maquette ("Le versement société sera rapproché tout
                    seul") a été retirée: AUCUN rapprochement n'existe. La maquette pouvait la dire,
                    elle avait un module `ecarts`; `BUSINESS_MODULES` n'en a pas, et `sales.ts` décrit
                    l'écart comme quelque chose à SIGNALER au gérant, pas à rapprocher tout seul.
                    Promettre une vérification qui n'a pas lieu est pire que ne rien promettre: on
                    déclare moins soigneusement quand on croit qu'une machine repasse derrière. */}
                <p className="rnote">
                  <strong>Établissez la facture en jeu</strong> pour ce montant exact.
                </p>
                {/* ⚠ LA FICHE EST RAPPELÉE SUR LE TICKET ÉMIS, et surtout le RÉSULTAT de la plaque.
                    C'est le seul moment où une plaque mal tapée peut encore être repérée: le ticket
                    sort identique qu'elle désigne une vraie voiture ou rien du tout, et sans cette
                    ligne l'erreur ne se découvre que des semaines plus tard, côté patron. */}
                {clientTouched && clientCheck?.ok ? (
                  <div className="rfiche">
                    <div className="rfl">
                      <span>Client</span>
                      <b>
                        {clientCheck.value.firstname} {clientCheck.value.lastname}
                      </b>
                    </div>
                    <div className="rfl">
                      <span>Plaque</span>
                      <b className="mono">{clientCheck.value.plate}</b>
                    </div>
                    {issued.vehicle ? (
                      issued.vehicle.record === "found" ? (
                        <div className="rfl">
                          <span>Véhicule</span>
                          <b>
                            {issued.vehicle.modelLabel ?? "Modèle inconnu"}
                            {issued.vehicle.modsTotal ? ` · ${issued.vehicle.modsTotal} mod.` : ""}
                          </b>
                        </div>
                      ) : (
                        /* ⚠ ON DIT "INTROUVABLE", JAMAIS "AUCUNE OPTION". Les deux se ressemblent à
                           l'oeil et ne disent pas du tout la même chose: la vente est enregistrée
                           dans les deux cas, mais l'une demande de vérifier la plaque. */
                        <div className="rfl warn">
                          <span>Véhicule</span>
                          <b>
                            {issued.vehicle.record === "absent"
                              ? "Plaque introuvable"
                              : "Véhicule illisible"}
                          </b>
                        </div>
                      )
                    ) : null}
                  </div>
                ) : null}
                {issued.duplicate ? (
                  <p className="rnote">Cette vente était déjà enregistrée. Aucun doublon créé.</p>
                ) : null}
              </div>
              <div className="perf" />
            </>
          ) : (
            <>
              <div className="paper">
                <div className="rh">
                  <b>{name}</b>
                  <span>Ticket en cours</span>
                </div>
                <div className="rlines">
                  {ticketEmpty ? (
                    <div className="rz">Touchez un article pour commencer</div>
                  ) : (
                    <>
                      {totals.vLines.map(({ vehicle, qty }) => (
                        <div className="rl" key={`v-${vehicle.model}`}>
                          <span className="q">{qty}&times;</span>
                          <span className="n">{vehicle.name}</span>
                          <span className="a">{money(vehiclePriceCents(vehicle) * qty)}</span>
                        </div>
                      ))}
                      {totals.lines.map(({ item, qty }) => (
                        <div className="rl" key={item.id}>
                          <span className="q">{qty}&times;</span>
                          <span className="n">{item.label}</span>
                          <span className="a">{money(item.priceCents * qty)}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                <div className="rs">
                  <div className="rt">
                    <span className="l">Total</span>
                    <span className="v">{money(totals.total)}</span>
                  </div>
                </div>
                {/*
                  LE BENEFICE DE L'ENTREPRISE SUR LES VOITURES DU TICKET.
                  Affiche parce que c'est la BASE de la part, et qu'un vendeur qui ne voit que le
                  prix ne peut pas comprendre pourquoi sa part vaut ce qu'elle vaut. Un zero se lit
                  alors comme ce qu'il est - le catalogue ne donne pas de prix concession pour ce
                  modele - au lieu de ressembler a une panne de la caisse.
                  ⚠ Volontairement HORS du bloc `rs` du total: ce n'est pas une ligne de facture, le
                  client ne paie pas ca et ne doit jamais le lire comme une remise.
                */}
                {totals.vLines.length > 0 ? (
                  <p className="rnote">
                    Bénéfice estimé&nbsp;: {money(totals.vMargin)}
                    {totals.vMargin === 0
                      ? " (aucun prix concession au catalogue pour ce modèle, donc aucune part)"
                      : ""}
                    {/*
                      ⚠ "ESTIME", ET LE MOT EST OBLIGATOIRE. Cet apercu ne connait que le catalogue;
                      le serveur, lui, cherche d'abord ce que l'entreprise a REELLEMENT paye pour la
                      plaque saisie dans la fiche (`job_vehicle_purchases`, voir fleetCost.ts), qu'il
                      ne peut pas resoudre ici sans un aller-retour a chaque frappe. Les deux
                      coincident presque toujours (139 achats sur 144 mesures au prix catalogue), et
                      "presque" est exactement ce qu'un chiffre affiche sans reserve ne doit pas
                      etre: un employe qui lit un montant ferme et en touche un autre cesse de croire
                      l'ecran.
                    */}
                  </p>
                ) : null}
                {/* ⚠ La phrase qui empêche de lire cet écran comme un paiement n'existait QU'APRÈS
                    la déclaration, donc elle arrivait après le malentendu. Avant de valider, on voit
                    une grille de prix, un total qui monte et un bouton: tout ce qu'il faut pour
                    croire qu'on encaisse. La correction doit être là où la lecture se fait. */}
                {ticketEmpty ? null : (
                  <p className="rnote">Le portail calcule. La facture se fait en jeu.</p>
                )}
              </div>
              <div className="perf" />
            </>
          )}

          {showCommission && (issued ? issued.commissionCents : totals.share) > 0 ? (
            <div className="share">
              <span className="l">
                Ta part
                <em>
                  {commission.mode === "pourcentage"
                    ? `${formatRate(commission.bps)} de la boutique, versés par l'employeur en fin de semaine`
                    : vehicles.length
                      ? "véhicules: % du bénéfice selon le grade, boutique selon le catalogue, versés par l'employeur"
                      : "versée par l'employeur en fin de semaine"}
                </em>
              </span>
              <span className="v">+{money(issued ? issued.commissionCents : totals.share)}</span>
            </div>
          ) : null}

          {/* ── LA FICHE CLIENT ────────────────────────────────────────────────────────────────
              À qui, et sur quelle voiture. Demandée par le propriétaire (2026-08-21) pour la
              concession et le garage.

              ⚠ SOUS LA PERFORATION, HORS DU PAPIER, comme la part employé et pour une raison
              voisine: ce n'est pas la facture du client, c'est la paperasse du commerce. La mettre
              sur le papier laisserait croire que le client repart avec son adresse imprimée dessus.

              ⚠ ELLE DISPARAÎT UNE FOIS LE TICKET ÉMIS: le récapitulatif prend sa place plus haut.
              Laisser cinq champs modifiables à côté d'un ticket déjà enregistré ferait croire qu'on
              peut encore le corriger, ce qui est faux - un ticket ne se réécrit pas. */}
          {showClientPanel && !issued ? (
            <div className="fiche">
              <div className="fhead">
                <span className="cap">Fiche client</span>
                {clientRequired ? (
                  <span className="freq">Obligatoire</span>
                ) : (
                  /* Sur une concession, la fiche ne devient obligatoire qu'avec une voiture au
                     panier. Le dire évite de laisser croire à un formulaire qu'on peut ignorer
                     partout, puis de le voir bloquer l'envoi sans prévenir. */
                  <span className="fopt">Requise dès qu&apos;un véhicule est au ticket</span>
                )}
              </div>
              <div className="fbody">
                <div className="fldrow">
                  <Field
                    id="cli-fn"
                    field="firstname"
                    value={client.firstname}
                    onChange={setField("firstname")}
                    onBlur={blurField("firstname")}
                    problem={problemFor("firstname")}
                    disabled={!canDeclare || pending}
                    maxLength={clientBounds.maxNameLength}
                  />
                  <Field
                    id="cli-ln"
                    field="lastname"
                    value={client.lastname}
                    onChange={setField("lastname")}
                    onBlur={blurField("lastname")}
                    problem={problemFor("lastname")}
                    disabled={!canDeclare || pending}
                    maxLength={clientBounds.maxNameLength}
                  />
                </div>
                <div className="fldrow">
                  <Field
                    id="cli-dob"
                    field="dob"
                    value={client.dob}
                    onChange={setField("dob")}
                    onBlur={blurField("dob")}
                    problem={problemFor("dob")}
                    placeholder="JJ/MM/AAAA"
                    disabled={!canDeclare || pending}
                    maxLength={10}
                    inputMode="numeric"
                  />
                  <Field
                    id="cli-tel"
                    field="phone"
                    value={client.phone}
                    onChange={setField("phone")}
                    onBlur={blurField("phone")}
                    problem={problemFor("phone")}
                    disabled={!canDeclare || pending}
                    maxLength={20}
                    inputMode="tel"
                  />
                </div>
                <Field
                  id="cli-plate"
                  field="plate"
                  value={client.plate}
                  onChange={setField("plate")}
                  onBlur={blurField("plate")}
                  problem={problemFor("plate")}
                  /* ⚠ L'INDICATION COMPTE. La recherche ignore la casse et les espaces de FIN, mais
                     pas un espace INTERNE: `11 ABC12` ne se retrouve pas en tapant `11ABC12`, et
                     sans cette phrase l'employé ne peut pas deviner pourquoi sa plaque est
                     "introuvable". Voir lookupSaleVehicle. */
                  hint="Telle qu'elle est écrite sur le véhicule, espaces compris"
                  disabled={!canDeclare || pending}
                  maxLength={8}
                />
                {/* Ce que le portail va chercher tout seul, dit une fois: sinon on croit qu'il
                    manque un champ "options" à remplir à la main. */}
                <p className="fnote">
                  Le modèle et les modifications du véhicule sont relevés automatiquement à partir de
                  la plaque.
                </p>
              </div>
            </div>
          ) : null}

          <div className="acts">
            {issued ? (
              <button className="btn ghost" onClick={newTicket}>
                Nouveau ticket
              </button>
            ) : (
              <>
                <button
                  className="btn"
                  onClick={submit}
                  disabled={
                    ticketEmpty || !canDeclare || pending || clientBlocked || tooManyVehicles
                  }
                >
                  {pending ? "Enregistrement…" : `Facturer ${totals.total ? money(totals.total) : ""}`}
                </button>
                {/* Un bouton désactivé sans motif se lit comme une panne. Chaque cause a sa phrase,
                    et l'ordre suit ce qu'on peut corriger le plus vite. */}
                {!canDeclare ? <span className="gate">Prise de service requise</span> : null}
                {canDeclare && tooManyVehicles ? (
                  <span className="gate">
                    Un seul véhicule par ticket: la fiche ne porte qu&apos;une plaque.
                  </span>
                ) : null}
                {canDeclare && !tooManyVehicles && clientBlocked && !ticketEmpty ? (
                  <span className="gate">Complétez la fiche client.</span>
                ) : null}
              </>
            )}
            {state.status === "error" ? <span className="gate">{state.message}</span> : null}
          </div>
        </aside>
      </div>
    </>
  );
}
