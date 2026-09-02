import Link from "next/link";
import { SearchX } from "lucide-react";
import s from "./shell.module.css";

/**
 * LA PAGE "INTROUVABLE" DU PORTAIL.
 *
 * ⚠ SANS CE FICHIER, `notFound()` remonte jusqu'a la page 404 de l'application ENTIERE: rendue hors
 * de la coquille du portail, sans sa palette, sans un seul lien de retour. Le joueur qui suit un
 * lien perime, ou dont le metier a change depuis qu'il a mis la page en favori, tombe donc sur un
 * ecran qui ressemble a un autre produit et qui ne propose rien. C'est le cas le PLUS courant,
 * pas un cas limite: un commerce disparait de la vue des qu'on n'y travaille plus, ce qui est
 * exactement le comportement voulu, et il ne doit pas se traduire par une impasse.
 *
 * ⚠ CE QU'ON NE DIT PAS ICI: si le commerce existe. `getBusinessBySlug` rend la meme reponse pour
 * "cette enseigne n'existe pas" et "vous n'y travaillez pas", et cette page doit garder ce silence.
 * Distinguer les deux confirmerait l'existence d'une entreprise a qui essaie des adresses au hasard.
 * D'ou une formulation qui parle de L'ACCES, jamais de l'existence.
 *
 * ⚠ LE BOUTON DE RETOUR ETAIT INVISIBLE, et pas par negligence de style. `.btn` se peint avec
 * `--brand`, une variable qu'aucune regle ne declare pour `data-biz="none"`: sur cet ecran, fond et
 * bordure devenaient des declarations invalides et il restait du texte blanc sur le fond de la page.
 * La classe `.portal` (voir shell.module.css) donne au portail sa propre palette, donc "un vrai
 * chemin de retour" commence par un bouton qu'on voit.
 */
export default function BusinessNotFound() {
  return (
    <div className={`app ${s.portal}`} data-biz="none">
      <div className="shell">
        <div className={`col ${s.col}`}>
          <main className="main">
            <div className="page">
              <div className={s.masthead}>
                <span className="li" title="It's not technology, it's your life!">
                  <b>Life</b>invader
                </span>
                <h1 className={s.mtitle}>Entreprises</h1>
                <span className={s.mspacer} />
                <span className="ver">v1.0.0 BETA</span>
              </div>

              <div className={s.empty}>
                <span className={s.emptymark}>
                  <SearchX size={22} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <div className={s.emptytitle}>Page introuvable</div>
                <p className={s.emptytext}>
                  Cette page n&apos;existe pas, ou vous n&apos;y avez pas accès. Le portail
                  n&apos;affiche que les entreprises dont vous exercez le métier en jeu: si vous avez
                  changé d&apos;emploi, l&apos;ancienne enseigne disparaît de votre liste.
                </p>
                <div className={s.emptyacts}>
                  <Link className="btn" href="/business">
                    Mes entreprises
                  </Link>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
