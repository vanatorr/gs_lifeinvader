"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { money } from "@/lib/business/theme";
import type { QuotedGroup, QuotedTier } from "@/lib/business/customMargin";
import type { ClientRecordBounds, ClientRecordDraft } from "@/lib/business/clientRecord";
import {
  declareCustomSaleAction,
  quoteGarageVehicleAction,
  searchGarageVehiclesAction,
  type DeclareState,
} from "../actions";

/**
 * LA CAISSE CUSTOMS: on trouve la voiture, on coche ce qu'on a posé, le prix est deja la.
 *
 * Née caisse du garage; depuis le 2026-08-27 la concession l'a aussi (demande du proprietaire:
 * "also be able to do customs with required customer info"), en second volet derriere CaisseModes.
 * Le bareme est le meme: central, fixe par le Fondateur, hors d'atteinte du commerce.
 *
 * ⚠⚠ TROISIEME CAISSE DU PORTAIL, ET LA SEULE OU L'EMPLOYE NE CHOISIT NI NE TAPE UN PRIX. La caisse
 * ordinaire envoie des identifiants d'article et le serveur lit les prix en base; la grille du salon
 * envoie des montants tapes, plafonnes serveur. Ici le navigateur n'envoie qu'un MODELE et des
 * couples (slot, palier): le prix est CALCULE serveur a partir du cout reel des pieces et d'un
 * bareme que le commerce ne peut pas modifier.
 *
 * ⚠ LA VALEUR DU VEHICULE N'ARRIVE JAMAIS JUSQU'ICI. Demande du proprietaire (2026-08-23). Ce n'est
 * pas cosmetique: c'est l'entree de la formule, donc l'afficher permettrait de retrouver la marge
 * par division. Le cout des pieces suit la meme regle et n'est envoye qu'a qui detient `team.read`.
 *
 * ⚠ CE TOTAL EST UN AFFICHAGE. Celui qui compte est RE-CALCULE au commit par `declareCustomSale`,
 * prestation par prestation: entre l'affichage et la validation, le bareme a pu changer. Un ticket
 * accepte ici peut donc etre chiffre differemment la-bas, et c'est la bonne direction.
 */
type Vehicle = { name: string; model: string; classLabel: string };

const EMPTY_CLIENT: ClientRecordDraft = {
  firstname: "",
  lastname: "",
  dob: "",
  phone: "",
  plate: "",
};

export default function CaisseCustomsView({
  slug,
  name,
  canDeclare,
  gateReason,
  showCommission,
  clientBounds,
}: {
  slug: string;
  name: string;
  canDeclare: boolean;
  /** Pourquoi la declaration est fermee. Un bouton grise sans motif se lit comme une panne. */
  gateReason: string | null;
  showCommission: boolean;
  clientBounds: ClientRecordBounds;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Vehicle[]>([]);
  const [vehicle, setVehicle] = useState<{ model: string; name: string } | null>(null);
  const [groups, setGroups] = useState<QuotedGroup[]>([]);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [client, setClient] = useState<ClientRecordDraft>(EMPTY_CLIENT);
  const [note, setNote] = useState("");
  const [state, setState] = useState<DeclareState>({ status: "idle" });
  const [pending, startTransition] = useTransition();

  /**
   * La cle d'identite d'une prestation dans le panier.
   *
   * ⚠ ELLE PORTE LE PALIER, PAS SEULEMENT LE SLOT. Sans le niveau, cocher "moteur niveau 4" apres
   * "moteur niveau 1" remplacerait silencieusement l'un par l'autre au lieu de refuser, et le
   * serveur (qui refuse le meme slot deux fois) renverrait une erreur que l'ecran n'aurait pas
   * annoncee.
   */
  const keyOf = (t: QuotedTier) => `${t.slotKey}#${t.level}`;

  /* -- Recherche ------------------------------------------------------------------------------ */

  // Anti-rebond: on ne bombarde pas le serveur a chaque frappe, et la derniere reponse gagne.
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchGarageVehiclesAction(slug, q).then((rows) => {
        // ⚠ Une reponse en retard ne doit jamais ecraser une plus recente.
        if (seq.current === mine) setResults(rows);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [query, slug]);

  const choose = useCallback(
    (v: Vehicle) => {
      setResults([]);
      setQuery(v.name);
      setPicked(new Set());
      setQuoteError(null);
      startTransition(async () => {
        const res = await quoteGarageVehicleAction(slug, v.model);
        if (res.status === "ok") {
          setVehicle({ model: res.model, name: res.vehicleName });
          setGroups(res.groups);
        } else {
          setVehicle(null);
          setGroups([]);
          setQuoteError(res.status === "error" ? res.message : null);
        }
      });
    },
    [slug],
  );

  /* -- Panier --------------------------------------------------------------------------------- */

  const allTiers = useMemo(() => groups.flatMap((g) => g.tiers), [groups]);
  const chosen = useMemo(() => allTiers.filter((t) => picked.has(keyOf(t))), [allTiers, picked]);
  const totalCents = useMemo(() => chosen.reduce((n, t) => n + t.priceCents, 0), [chosen]);
  /** Le cout n'existe que pour qui detient `team.read`; sinon la marge n'est simplement pas affichee. */
  const costCents = useMemo(
    () => (chosen.every((t) => t.costCents !== null) ? chosen.reduce((n, t) => n + (t.costCents ?? 0), 0) : null),
    [chosen],
  );

  const toggle = (t: QuotedTier) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const k = keyOf(t);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  /* -- Declaration ---------------------------------------------------------------------------- */

  const submit = () => {
    if (!vehicle || chosen.length === 0 || pending) return;
    /**
     * ⚠ LA CLE D'IDEMPOTENCE EST PRODUITE ICI, AVANT L'ENVOI, et elle est stable pour CE geste.
     * Un double-clic ou un renvoi apres coupure reseau porte la meme cle, donc l'index unique
     * transforme le doublon en "deja enregistree" au lieu d'un second ticket. Voir `client_ref`.
     */
    const clientRef = `${vehicle.model}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    startTransition(async () => {
      const res = await declareCustomSaleAction(slug, {
        model: vehicle.model,
        customs: chosen.map((t) => ({ slotKey: t.slotKey, level: t.level })),
        client,
        note: note.trim() || null,
        clientRef,
      });
      setState(res);
      if (res.status === "ok") {
        setPicked(new Set());
        setNote("");
        setClient(EMPTY_CLIENT);
      }
    });
  };

  const field = (k: keyof ClientRecordDraft, label: string, placeholder: string) => (
    <label className="lc-field" key={k}>
      <span>{label}</span>
      <input
        value={client[k] ?? ""}
        placeholder={placeholder}
        onChange={(e) => setClient((c) => ({ ...c, [k]: e.target.value }))}
      />
    </label>
  );

  return (
    <div className="lc-caisse">
      <header className="lc-head">
        <h1>{name}</h1>
        <p className="lc-sub">
          Trouvez le vehicule, cochez ce qui a ete pose. Le prix est calcule automatiquement.
        </p>
      </header>

      {/* -- 1. Le vehicule -- */}
      <section className="lc-panel">
        <h2>1. Vehicule</h2>
        <input
          className="lc-search"
          value={query}
          placeholder="Nom du modele ou code (ex: primo, sultan, zentorno)"
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        {results.length > 0 && (
          <ul className="lc-results">
            {results.map((v) => (
              <li key={v.model}>
                <button type="button" onClick={() => choose(v)}>
                  <strong>{v.name}</strong>
                  <span className="lc-mono">{v.model}</span>
                  <span className="lc-dim">{v.classLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {vehicle && <p className="lc-picked">Vehicule retenu: <strong>{vehicle.name}</strong></p>}
        {quoteError && <p className="lc-error">{quoteError}</p>}
      </section>

      {/* -- 2. Les prestations -- */}
      {vehicle && groups.length > 0 && (
        <section className="lc-panel">
          <h2>2. Prestations</h2>
          {groups.map((g) => (
            <div key={g.key} className="lc-group">
              <h3>{g.label}</h3>
              <ul className="lc-tiers">
                {g.tiers.map((t) => {
                  const k = keyOf(t);
                  const on = picked.has(k);
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        className={on ? "lc-tier lc-on" : "lc-tier"}
                        onClick={() => toggle(t)}
                        aria-pressed={on}
                      >
                        <span className="lc-tier-label">{t.label}</span>
                        <span className="lc-tier-price">{money(t.priceCents)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}

      {/* -- 3. La fiche client, obligatoire sur tout ticket de customs -- */}
      {vehicle && (
        <section className="lc-panel">
          <h2>3. Client</h2>
          <p className="lc-sub">
            Obligatoire: un ticket de customs porte toujours sur une voiture et sur quelqu&apos;un.
          </p>
          <div className="lc-fields">
            {field("firstname", "Prenom", "Jean")}
            {field("lastname", "Nom", "Dupont")}
            {field("dob", "Naissance", `JJ/MM/${clientBounds.lowestYear}-${clientBounds.highestYear}`)}
            {field("phone", "Telephone", "0123456789")}
            {field("plate", "Plaque", "ABC 123")}
          </div>
          <label className="lc-field">
            <span>Note (facultatif)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </label>
        </section>
      )}

      {/* -- 4. Le total -- */}
      {vehicle && (
        <section className="lc-panel lc-total">
          <div>
            <span className="lc-dim">{chosen.length} prestation{chosen.length > 1 ? "s" : ""}</span>
            <strong>{money(totalCents)}</strong>
            {/* La marge n'apparait que pour qui peut deja voir les chiffres du commerce. */}
            {costCents !== null && chosen.length > 0 && (
              <span className="lc-dim">
                pieces {money(costCents)} · marge {money(totalCents - costCents)}
              </span>
            )}
          </div>
          <button type="button" onClick={submit} disabled={!canDeclare || pending || chosen.length === 0}>
            {pending ? "Enregistrement..." : "Declarer"}
          </button>
        </section>
      )}

      {!canDeclare && gateReason && <p className="lc-error">{gateReason}</p>}

      {state.status === "error" && <p className="lc-error">{state.message}</p>}
      {state.status === "ok" && (
        <p className="lc-ok">
          {state.duplicate ? "Deja enregistree" : "Vente declaree"} · {state.publicRef} ·{" "}
          {money(state.totalCents)}
          {showCommission && state.commissionCents > 0 && <> · votre part {money(state.commissionCents)}</>}
          <br />
          <span className="lc-dim">
            Le portail enregistre la declaration. Etablissez la facture en jeu pour ce montant exact.
          </span>
        </p>
      )}
    </div>
  );
}
