"use client";

import { useMemo, useState, useTransition } from "react";
import { visualFor } from "@/lib/business/art";
import { formatRate, unitCommissionCents, type CommissionMode } from "@/lib/business/commission";
import { money, toneVars } from "@/lib/business/theme";
import { declareFreeSaleAction, type DeclareState } from "../actions";

/**
 * LA CAISSE D'UN SALON: vingt cases, et l'employé tape le prix de chaque pièce qu'il vient de faire.
 *
 * ⚠⚠ C'EST L'INVERSE DE LA CAISSE ORDINAIRE, ET C'EST VOULU. Ailleurs, le navigateur envoie des
 * IDENTIFIANTS d'article et le serveur va chercher les prix en base (voir `declareSale`, protection
 * 1). Ici il envoie des MONTANTS, parce qu'un tatouage se négocie devant le client et qu'aucun
 * catalogue ne peut décrire à l'avance ce qui a été fait. Le prix vient donc de l'employé, et ce qui
 * remplace le prix-en-base est un PLAFOND PAR LIGNE réglé par la direction et appliqué côté serveur.
 *
 * ⚠ CE TOTAL EST UN AFFICHAGE. Celui qui compte est recalculé serveur, à partir des mêmes montants
 * mais revalidés un par un contre le plafond. Un ticket accepté ici peut être refusé là-bas, et
 * c'est la bonne direction.
 *
 * ⚠ LA PART AFFICHÉE UTILISE LA MÊME FONCTION QUE LE SERVEUR (`unitCommissionCents`), importée et
 * non recopiée: deux implémentations du même arrondi finissent toujours par diverger d'un centime,
 * et l'écart ne se voit qu'à la paie.
 *
 * Le panier ne vit QUE dans cet état local, comme sur la caisse ordinaire: il n'existe aucune notion
 * de ticket "en cours" en base, et la seule chose qui existe est le ticket DÉCLARÉ.
 */
export default function CaisseGrilleView({
  slug,
  name,
  slots,
  labelPrefix,
  canDeclare,
  gateReason,
  showCommission,
  commission,
  lineMaxCents,
  art,
  icon,
  showVisuals,
}: {
  slug: string;
  name: string;
  slots: number;
  labelPrefix: string;
  canDeclare: boolean;
  /** Pourquoi la déclaration est fermée. Un bouton grisé sans motif se lit comme une panne. */
  gateReason: string | null;
  showCommission: boolean;
  commission: { mode: CommissionMode; bps: number };
  /** Le plafond par ligne, en centimes. `null` = la direction ne l'a pas encore réglé. */
  lineMaxCents: number | null;
  /** Une clé de `PRODUCT_ART` (la vignette pleine), déclarée par le modèle. */
  art: string;
  /** Une clé de `CATEGORY_ICONS`, le repli en trait si `art` est inconnue. */
  icon: string;
  /** Le module "Visuels produits". Éteint, les cases n'ont pas de plaque - comme la caisse ordinaire. */
  showVisuals: boolean;
}) {
  /**
   * LA VIGNETTE, résolue UNE FOIS pour les vingt cases.
   *
   * ⚠ `kind` DÉCIDE DE LA TAILLE, et le choisir mal ne casse rien de visible: `.tvis.art` dessine à
   * 72px en couleur, `.tvis.icon` à 36px en trait atténué. Prendre l'un pour l'autre donne une
   * illustration minuscule ou une icône géante - c'est pour ça que `visualFor` rend les deux
   * ensemble plutôt que le seul SVG.
   *
   * ⚠ Et une fois, pas une par case: les vingt portent le même dessin, donc appeler `visualFor` dans
   * la boucle referait vingt recherches à chaque frappe de clavier - la grille se redessine à chaque
   * caractère tapé dans un prix.
   */
  const visual = visualFor(art, icon);

  /**
   * Les variables de teinte du rayon, posées une fois pour les vingt cases.
   *
   * `tone: 1` en dur et non lu du rayon: un commerce en grille n'a qu'UN rayon (voir `BusinessGrid`),
   * donc il n'y a pas de second ton à choisir, et faire descendre la liste des rayons jusqu'ici
   * pour en tirer toujours la même valeur serait une dépendance sans contrepartie.
   */
  const toneStyle = toneVars(1) as React.CSSProperties;
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [state, setState] = useState<DeclareState>({ status: "idle" });
  const [pending, start] = useTransition();

  /**
   * ⚠ LA CLÉ D'IDEMPOTENCE EST TIRÉE UNE FOIS PAR TICKET, pas à chaque envoi: c'est ce qui fait
   * qu'un double-clic retombe sur la MÊME clé et se fait reconnaître comme un doublon. La régénérer
   * à chaque appel rendrait l'index unique décoratif.
   */
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());

  const ceilingDollars = lineMaxCents === null ? null : Math.round(lineMaxCents / 100);

  const lines = useMemo(() => {
    const out: { slot: number; dollars: number; cents: number; over: boolean }[] = [];
    for (let i = 0; i < slots; i++) {
      const raw = (prices[i] ?? "").trim();
      if (raw === "") continue;
      const dollars = Math.round(Number(raw));
      if (!Number.isFinite(dollars) || dollars <= 0) continue;
      const cents = dollars * 100;
      out.push({ slot: i, dollars, cents, over: lineMaxCents !== null && cents > lineMaxCents });
    }
    return out;
  }, [prices, slots, lineMaxCents]);

  const totals = useMemo(() => {
    let total = 0;
    let share = 0;
    for (const l of lines) {
      total += l.cents;
      share +=
        commission.mode === "pourcentage" ? unitCommissionCents(l.cents, commission.bps) : 0;
    }
    return { total, share: showCommission ? share : 0 };
  }, [lines, commission, showCommission]);

  const overCount = lines.filter((l) => l.over).length;
  const issued = state.status === "ok" ? state : null;
  const blocked = !canDeclare || Boolean(issued) || lineMaxCents === null;

  function submit() {
    if (!lines.length || pending || blocked || overCount > 0) return;
    start(async () => {
      const res = await declareFreeSaleAction(slug, {
        lines: lines.map((l) => ({ slot: l.slot, priceDollars: l.dollars })),
        clientRef,
      });
      setState(res);
    });
  }

  function newTicket() {
    setPrices({});
    setState({ status: "idle" });
    setClientRef(crypto.randomUUID()); // un nouveau ticket est un nouveau geste, donc une nouvelle clé
  }

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
              <span className="text-xs leading-relaxed text-muted-foreground">
                Inscrivez le prix de chaque tatouage que vous venez de faire. Laissez vide ce que
                vous n&apos;avez pas fait.
                {ceilingDollars !== null ? (
                  <>
                    {" "}
                    Maximum <strong className="font-semibold text-foreground">
                      {money(lineMaxCents!)}
                    </strong>{" "}
                    par tatouage.
                  </>
                ) : null}
              </span>
            </div>

            {lineMaxCents === null ? (
              // ⚠ Fail-closed, et on DIT pourquoi. Sans plafond le serveur refuse de toute façon
              // (voir `declareFreeSale`), donc laisser saisir vingt prix pour finir sur un refus
              // serait cruel et incompréhensible.
              <div className="note">
                La direction n&apos;a pas encore fixé le prix maximum d&apos;un tatouage. Tant
                qu&apos;il manque, aucune vente ne peut être déclarée ici: demandez-le au patron, qui
                le règle depuis sa page Tarifs.
              </div>
            ) : null}

            <div className="pgrid">
              {Array.from({ length: slots }, (_, i) => {
                const raw = prices[i] ?? "";
                const line = lines.find((l) => l.slot === i);
                const filled = Boolean(line);
                return (
                  <article
                    key={i}
                    className={`tile ttile ${filled ? "picked" : ""}`}
                    /* ⚠ SANS `toneVars`, `--k` ET `--kt` N'EXISTENT PAS SUR CETTE CARTE, et rien ne
                       casse: la plaque se dessine simplement sans couleur. C'est ce qui est arrivé au
                       premier jet, où le dessin était invisible. La caisse ordinaire les pose par
                       article depuis son rayon; ici les vingt cases sont le même rayon, donc le même
                       ton, résolu une seule fois plus haut. */
                    style={toneStyle}
                  >
                    {showVisuals ? (
                      /* ⚠ `dangerouslySetInnerHTML` est acceptable ICI pour la même unique raison que
                         sur la vignette de la caisse ordinaire: la chaîne rendue ne vient PAS de la
                         base, elle vient d'une table FIGÉE du code (`PRODUCT_ART`). La donnée stockée
                         ne sert que de CLÉ de recherche, et une clé inconnue retombe sur le repli. Ne
                         jamais y faire passer quoi que ce soit venu de la base. */
                      <div
                        className={`tvis ${visual.kind}`}
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: visual.svg }}
                      />
                    ) : null}
                    <div className="tbody">
                      <div className="tcat">{`${labelPrefix} ${i + 1}`}</div>
                      <label className="tprice">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={raw}
                          disabled={blocked}
                          placeholder="—"
                          onChange={(e) => setPrices((p) => ({ ...p, [i]: e.target.value }))}
                          aria-label={`Prix du ${labelPrefix.toLowerCase()} ${i + 1}`}
                          className={line?.over ? "over" : undefined}
                        />
                        <span className="cur">$</span>
                      </label>
                      {line?.over ? (
                        <div className="tmeta bad">Au-dessus du plafond</div>
                      ) : filled ? (
                        <div className="tmeta">
                          {money(line!.cents)}
                          {showCommission && commission.mode === "pourcentage"
                            ? ` · ta part ${money(unitCommissionCents(line!.cents, commission.bps))}`
                            : ""}
                        </div>
                      ) : (
                        // Une ligne vide de même hauteur que les deux autres: sans elle, une case qui
                        // se remplit grandit et pousse toute sa rangée, donc la grille bouge sous les
                        // doigts pendant la saisie.
                        <div className="tmeta">&nbsp;</div>
                      )}
                    </div>
                  </article>
                );
              })}
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
                <p className="rnote">
                  <strong>Établissez la facture en jeu</strong> pour ce montant exact.
                </p>
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
                  {lines.length ? (
                    lines.map((l) => (
                      <div className="rl" key={l.slot}>
                        <span className="q">1&times;</span>
                        <span className="n">{`${labelPrefix} ${l.slot + 1}`}</span>
                        <span className="a">{money(l.cents)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="rz">Inscrivez un prix pour commencer</div>
                  )}
                </div>
                <div className="rs">
                  <div className="rt">
                    <span className="l">Total</span>
                    <span className="v">{money(totals.total)}</span>
                  </div>
                </div>
                {lines.length ? (
                  <p className="rnote">Le portail calcule. La facture se fait en jeu.</p>
                ) : null}
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
                    ? `${formatRate(commission.bps)} de la facture, versés par l'employeur en fin de semaine`
                    : "versée par l'employeur en fin de semaine"}
                </em>
              </span>
              <span className="v">+{money(issued ? issued.commissionCents : totals.share)}</span>
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
                  disabled={!lines.length || blocked || overCount > 0 || pending}
                >
                  {pending ? "Enregistrement…" : `Facturer ${totals.total ? money(totals.total) : ""}`}
                </button>
                {overCount > 0 ? (
                  <span className="gate">
                    {overCount} prix au-dessus du plafond de {money(lineMaxCents!)}.
                  </span>
                ) : !canDeclare && gateReason ? (
                  <span className="gate">{gateReason}</span>
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
