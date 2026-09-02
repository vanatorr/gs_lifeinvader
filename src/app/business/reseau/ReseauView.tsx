"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Network, Plus, Store } from "lucide-react";
import type { CandidateJob, PortalRow } from "@/lib/business/network";
// ⚠ `slug` et non `network`: ce dernier est `server-only`, l'importer ici casserait la compilation
// du composant client. La règle d'adresse est partagée par les deux, jamais recopiée.
import { slugifyPortal } from "@/lib/business/slug";
import { money } from "@/lib/business/theme";
import { createPortalAction, resetPortalLookAction, updatePortalAction } from "./actions";
import s from "../shell.module.css";
import r from "./reseau.module.css";

/**
 * LA CONSOLE RÉSEAU, côté écran.
 *
 * ⚠ ELLE NE DÉCIDE RIEN. Chaque bouton appelle une action qui re-résout l'accès et re-valide la
 * saisie côté serveur; cacher ou montrer une commande ici ne retire ni n'accorde aucun droit. C'est
 * la même règle que `ShellNav`, et elle est la raison pour laquelle on peut se permettre de tout
 * afficher plutôt que de deviner.
 *
 * ⚠ AUCUNE DONNÉE INVENTÉE. Chaque chiffre affiché est mesuré: `items` compte les lignes de
 * catalogue, `employees` compte les personnes portant le métier dans l'un des deux emplacements ESX.
 * Rien n'estime une activité, une recette ou une fréquentation - le portail n'a pas ces chiffres, et
 * un nombre plausible serait pire qu'une colonne absente.
 */

type Props = {
  portals: PortalRow[];
  candidates: CandidateJob[];
  templates: { name: string; label: string }[];
  via: string;
};

type Feedback = { kind: "ok" | "err"; text: string } | null;

export default function ReseauView({ portals, candidates, templates, via }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);

  /* ── Ouvrir un portail ─────────────────────────────────────────────────────────────────────── */
  const [openForm, setOpenForm] = useState(false);
  const [job, setJob] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [template, setTemplate] = useState(templates[0]?.name ?? "commerce");

  // L'adresse SUIT l'enseigne tant que personne ne l'a écrite à la main. Une fois touchée, elle
  // s'arrête de suivre: sinon on efface sous les doigts de quelqu'un qui vient de la corriger.
  const effectiveSlug = slugTouched ? slug : slugifyPortal(name);

  const jobLabel = useMemo(
    () => candidates.find((c) => c.name === job)?.label ?? null,
    [candidates, job],
  );

  const run = (fn: () => Promise<{ status: "ok" } | { status: "error"; message: string }>, okText: string) => {
    setFeedback(null);
    start(async () => {
      const res = await fn();
      if (res.status === "error") setFeedback({ kind: "err", text: res.message });
      else {
        setFeedback({ kind: "ok", text: okText });
        router.refresh();
      }
    });
  };

  const submitCreate = () => {
    run(
      () => createPortalAction({ job, name, slug: effectiveSlug, template }),
      `Portail ouvert pour ${jobLabel ?? job}.`,
    );
    setOpenForm(false);
    setJob("");
    setName("");
    setSlug("");
    setSlugTouched(false);
  };

  return (
    <div className="app" data-biz="none">
      <div className="shell">
        <div className={`col ${s.col}`}>
          <main className="main">
            <div className="page">
              <div className={s.masthead}>
                <span className="li" title="It's not technology, it's your life!">
                  <b>Life</b>invader
                </span>
                <h1 className={s.mtitle}>Réseau</h1>
                <span className={s.mspacer} />
                <Link href="/business" className={r.back}>
                  Mes entreprises
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                </Link>
              </div>

              <div className="note">
                <strong>Console MIRAGE.</strong> Vous décidez quels métiers ont un portail LifeInvader,
                et vous entrez dans n&apos;importe lequel avec les droits du patron. Accès par : {via}.
              </div>

              {feedback ? (
                <div className={`note ${feedback.kind === "err" ? "hot" : ""}`} role="status">
                  {feedback.text}
                </div>
              ) : null}

              <div className="figs">
                <div className="fig">
                  <div className="k">Portails ouverts</div>
                  <div className="v lead">{portals.filter((p) => p.active).length}</div>
                  <div className="m">sur {portals.length} enregistrés</div>
                </div>
                <div className="fig">
                  <div className="k">Métiers sans portail</div>
                  <div className="v">{candidates.length}</div>
                  <div className="m">éligibles, hors sans-emploi</div>
                </div>
                <div className="fig">
                  <div className="k">Articles au catalogue</div>
                  <div className="v">{portals.reduce((n, p) => n + p.items, 0)}</div>
                  <div className="m">tous portails confondus</div>
                </div>
                {/* Le total du reseau, pas une moyenne: on additionne des declarations reelles. */}
                <div className="fig">
                  <div className="k">Déclaré aujourd&apos;hui</div>
                  <div className="v">{money(portals.reduce((n, p) => n + p.declaredTodayCents, 0))}</div>
                  <div className="m">
                    {portals.reduce((n, p) => n + p.ticketsToday, 0)} ticket
                    {portals.reduce((n, p) => n + p.ticketsToday, 0) > 1 ? "s" : ""}
                  </div>
                </div>
                <div className="fig">
                  <div className="k">Déclaré cette semaine</div>
                  <div className="v">{money(portals.reduce((n, p) => n + p.declaredWeekCents, 0))}</div>
                  <div className="m">depuis lundi</div>
                </div>
              </div>

              {/* ── Ouvrir un portail ───────────────────────────────────────────────────────── */}
              <div className="panel" style={{ marginBottom: 14 }}>
                <div className="ph">
                  <span>Ouvrir un portail</span>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ width: "auto" }}
                    onClick={() => setOpenForm((v) => !v)}
                    aria-expanded={openForm}
                  >
                    <Plus size={14} strokeWidth={2} aria-hidden="true" />
                    {openForm ? "Annuler" : "Nouveau"}
                  </button>
                </div>

                {openForm ? (
                  <div className={r.form}>
                    <label className={r.field}>
                      <span className={r.lbl}>Métier</span>
                      <select
                        className={r.inp}
                        value={job}
                        onChange={(e) => {
                          setJob(e.target.value);
                          // L'enseigne se pré-remplit avec le libellé du métier, qui est presque
                          // toujours le bon nom. On ne l'impose pas: `jobs.label` est une donnée de
                          // jeu, l'enseigne est une décision commerciale (24/7 Strawberry, pas 247).
                          const lbl = candidates.find((c) => c.name === e.target.value)?.label;
                          if (lbl && !name) setName(lbl);
                        }}
                      >
                        <option value="">Choisir un métier…</option>
                        {candidates.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.label} — {c.name} ({c.employees} employé{c.employees > 1 ? "s" : ""})
                          </option>
                        ))}
                      </select>
                      <span className={r.hint}>
                        Seuls les métiers sans portail apparaissent. Sans-emploi est exclu : tout le
                        monde y est rangé par défaut.
                      </span>
                    </label>

                    <label className={r.field}>
                      <span className={r.lbl}>Enseigne</span>
                      <input
                        className={r.inp}
                        value={name}
                        maxLength={120}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="24/7 Strawberry"
                      />
                      <span className={r.hint}>Le nom affiché aux employés. Il peut différer du métier.</span>
                    </label>

                    <label className={r.field}>
                      <span className={r.lbl}>Adresse</span>
                      <input
                        className={r.inp}
                        value={effectiveSlug}
                        maxLength={80}
                        onChange={(e) => {
                          setSlugTouched(true);
                          setSlug(e.target.value);
                        }}
                        placeholder="strawberry"
                      />
                      <span className={r.hint}>/business/{effectiveSlug || "…"}/caisse</span>
                    </label>

                    <label className={r.field}>
                      <span className={r.lbl}>Modèle</span>
                      <select className={r.inp} value={template} onChange={(e) => setTemplate(e.target.value)}>
                        {templates.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <span className={r.hint}>
                        Porte la palette et les rayons de départ. Le commerce peut tout changer ensuite.
                      </span>
                    </label>

                    <div className={r.formActs}>
                      <button
                        type="button"
                        className="btn"
                        style={{ width: "auto" }}
                        disabled={pending || !job || !name.trim() || !effectiveSlug}
                        onClick={submitCreate}
                      >
                        Ouvrir le portail
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* ── Les portails existants ──────────────────────────────────────────────────── */}
              <div className="panel">
                <div className="ph">
                  <span>Portails</span>
                  <span>{portals.length}</span>
                </div>
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th className="grow">Enseigne</th>
                        <th>Métier</th>
                        <th>Adresse</th>
                        <th>Modèle</th>
                        <th className="r">Articles</th>
                        <th className="r">Équipe</th>
                        {/* "Déclaré" et non "Chiffre d'affaires": la vente se joue en RP, le portail
                            enregistre ce qu'un employé DIT avoir encaissé. L'en-tête doit porter ce
                            que la donnée est, sinon la colonne se lit comme une mesure. */}
                        <th className="r">Déclaré aujourd&apos;hui</th>
                        <th className="r">Déclaré cette semaine</th>
                        <th>État</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {portals.length === 0 ? (
                        <tr>
                          <td colSpan={10} className={r.none}>
                            <Store size={16} strokeWidth={1.75} aria-hidden="true" /> Aucun portail
                            ouvert. Commencez par en ouvrir un ci-dessus.
                          </td>
                        </tr>
                      ) : (
                        portals.map((p) => (
                          <PortalLine
                            key={p.id}
                            portal={p}
                            templates={templates}
                            pending={pending}
                            onSave={(patch) =>
                              run(() => updatePortalAction(p.id, patch), `${p.name} mis à jour.`)
                            }
                            onResetLook={() =>
                              run(() => resetPortalLookAction(p.id), `Apparence de ${p.name} réinitialisée.`)
                            }
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className={r.foot}>
                <Network size={13} strokeWidth={1.75} aria-hidden="true" />
                Les montants sont ce que les employés ont <strong>déclaré</strong> avoir encaissé,
                pas une mesure : la vente se joue en RP et le serveur ne voit pas la scène. La part
                employé n&apos;en est pas déduite, c&apos;est la société qui la verse. La semaine
                court du lundi, comme sur la page Équipe de chaque commerce. — Fermer un portail le
                retire à ses employés sans rien effacer : catalogue, ventes déclarées et pointages
                restent en place et reviennent à la réouverture. Le métier d&apos;un portail ne se
                change pas : il décide qui a accès à tout son historique.
              </p>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

/**
 * Un montant déclaré, son volume, et la part employé qu'il engage.
 *
 * ⚠ TROIS CHIFFRES QUI NE DISENT PAS LA MÊME CHOSE, empilés plutôt que fondus en un seul. Le
 * montant est ce que les clients ont payé (déclaré), le nombre de tickets est ce qui le rend
 * lisible (1 000 $ en un ticket ou en vingt ne racontent pas la même journée), et la part employé
 * est une CHARGE que la société devra verser - jamais une déduction de la ligne du dessus. Les
 * additionner en un "net" inventerait une comptabilité que ce module ne tient pas.
 *
 * Un zéro s'affiche en gris et sans détail: une enseigne sans vente aujourd'hui n'a pas besoin
 * d'une ligne "0 ticket, 0 $ de part" sous son zéro.
 */
function MoneyCell({ cents, tickets, commission }: { cents: number; tickets: number; commission: number }) {
  if (cents === 0 && tickets === 0) {
    return (
      <td className={`r ${r.moneyCell}`}>
        <span className={r.zero}>—</span>
      </td>
    );
  }
  return (
    <td className={`r ${r.moneyCell}`}>
      <span className={r.amount}>{money(cents)}</span>
      <span className={r.sub}>
        {tickets} ticket{tickets > 1 ? "s" : ""}
        {commission > 0 ? ` · ${money(commission)} de part` : ""}
      </span>
    </td>
  );
}

/** Une ligne de portail, éditable sur place. */
function PortalLine({
  portal,
  templates,
  pending,
  onSave,
  onResetLook,
}: {
  portal: PortalRow;
  templates: { name: string; label: string }[];
  pending: boolean;
  onSave: (patch: { name?: string; slug?: string; template?: string; active?: boolean }) => void;
  onResetLook: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(portal.name);
  const [slug, setSlug] = useState(portal.slug);
  const [template, setTemplate] = useState(portal.template);

  const dirty = name !== portal.name || slug !== portal.slug || template !== portal.template;

  return (
    <>
      <tr>
        <td className="grow">
          <b>{portal.name}</b>
        </td>
        <td>
          {portal.jobLabel ?? "—"} <span className={r.mono}>{portal.job}</span>
        </td>
        <td className={r.mono}>{portal.slug}</td>
        <td>{templates.find((t) => t.name === portal.template)?.label ?? portal.template}</td>
        <td className="r">{portal.items}</td>
        <td className="r">{portal.employees}</td>
        <MoneyCell
          cents={portal.declaredTodayCents}
          tickets={portal.ticketsToday}
          commission={portal.commissionTodayCents}
        />
        <MoneyCell
          cents={portal.declaredWeekCents}
          tickets={portal.ticketsWeek}
          commission={portal.commissionWeekCents}
        />
        <td>
          <span className={`tag ${portal.active ? "on" : "off"}`}>
            <i />
            {portal.active ? "Ouvert" : "Fermé"}
          </span>
        </td>
        <td>
          <div className={r.rowActs}>
            {/* Entrer dans le commerce: c'est l'accès réseau, et il donne les droits du patron. */}
            <Link href={`/business/${portal.slug}/caisse`} className={r.link}>
              Entrer
            </Link>
            <button type="button" className={r.link} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "Fermer" : "Modifier"}
            </button>
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={10} className={r.editCell}>
            <div className={r.editGrid}>
              <label className={r.field}>
                <span className={r.lbl}>Enseigne</span>
                <input className={r.inp} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className={r.field}>
                <span className={r.lbl}>Adresse</span>
                <input className={r.inp} value={slug} maxLength={80} onChange={(e) => setSlug(e.target.value)} />
                <span className={r.hint}>Changer l&apos;adresse casse les liens déjà partagés.</span>
              </label>
              <label className={r.field}>
                <span className={r.lbl}>Modèle</span>
                <select className={r.inp} value={template} onChange={(e) => setTemplate(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span className={r.hint}>
                  Change les modules par défaut. La palette et les rayons du commerce ne bougent pas.
                </span>
              </label>
            </div>
            <div className={r.editActs}>
              <button
                type="button"
                className="btn"
                style={{ width: "auto" }}
                disabled={pending || !dirty}
                onClick={() => onSave({ name, slug, template })}
              >
                Enregistrer
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ width: "auto" }}
                disabled={pending}
                onClick={onResetLook}
              >
                Reprendre l&apos;apparence du modèle
              </button>
              <span className={r.spacer} />
              <button
                type="button"
                className="btn ghost"
                style={{ width: "auto" }}
                disabled={pending}
                onClick={() => onSave({ active: !portal.active })}
              >
                {portal.active ? "Fermer le portail" : "Rouvrir le portail"}
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
