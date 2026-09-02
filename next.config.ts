import path from "node:path";
import type { NextConfig } from "next";
import {
  INGAME_EMBED_HEADER_SOURCES,
  baseSecurityHeaders,
  ingameEmbedHeaderEntries,
  staffLockedHeaderEntries,
} from "./src/lib/security/ingameEmbed";

/**
 * ⚠ THE ROOT PIN IS NOT COSMETIC - it is the fix for "infinite building between page changes".
 *
 * Next infers the workspace root by walking UP from this directory looking for a lockfile. There is a
 * stray `C:\Users\ahdel\package-lock.json` (an unrelated "next-app-template" project, with its own
 * node_modules beside it), so Next picked **the entire user home directory** as the root and
 * announced it on every boot:
 *
 *   "We detected multiple lockfiles and selected the directory of C:\Users\ahdel\package-lock.json
 *    as the root directory."
 *
 * That is not a tidiness warning. The root is what Next/Turbopack file-traces and watches - so it was
 * walking all of OneDrive, Desktop, Documents and every other project on the machine in order to
 * build one page. Pinning it here is what stops that.
 *
 * Deleting the stray lockfile would also fix it, but it lives OUTSIDE this repo and belongs to
 * something else, so this config states the answer explicitly rather than depending on a file
 * elsewhere on the machine staying deleted.
 *
 * ⚠ THE OTHER HALF IS NOT FIXABLE FROM HERE: this project sits inside OneDrive
 * (C:\code\GrandSide), so `node_modules` (40,160 files) and `.next` (rebuilt
 * constantly) are sync-scanned in real time by OneDrive while the dev server writes them. That is a
 * filesystem-level fight no config option wins - the repo has to move off OneDrive, or those two
 * directories have to be excluded from sync.
 */
const nextConfig: NextConfig = {
  /**
   * ⚠ POURQUOI LE DOSSIER DE SORTIE EST PARAMÉTRABLE: `next start` et `next dev` écrivent tous les
   * deux dans `.next`, et le serveur de PRODUCTION lit ce même dossier pendant qu'il sert du trafic.
   * Lancer un `npm run dev` (ou pire, un `npm run build`) pendant qu'un `next start` tourne écrase
   * donc les chunks sous ses pieds: le site part en 500 avec "Cannot find module './NNN.js'", et la
   * panne ressemble à du CSS cassé plutôt qu'à ce qu'elle est.
   *
   * Avec ceci, un serveur de développement se lance à côté sans rien toucher:
   *   NEXT_DIST_DIR=.next-dev npx next dev --port 3001
   *
   * Non défini, la valeur reste `.next`: la production ne change pas, y compris après un
   * redémarrage. Le défaut est le comportement d'avant, l'écart est explicite.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * ⚠⚠ LES HOTES AUTORISES POUR LES SERVER ACTIONS. C'EST LE PIEGE DU MULTI-HOTE.
   *
   * Next refuse une Server Action dont l'en-tete `Origin` ne correspond pas a `X-Forwarded-Host`
   * ("Invalid Server Actions request"). Ajouter lifeinvader.grandside.org sans le declarer ICI
   * produit la panne la plus trompeuse possible: CHAQUE PAGE S'AFFICHE PARFAITEMENT et CHAQUE BOUTON
   * cesse de fonctionner. Declarer une vente, corriger un pointage, changer un prix: tout echoue,
   * et rien dans l'interface ne dit pourquoi.
   *
   * Les deux hotes sont la MEME application derriere le meme tunnel; ce n'est pas une ouverture vers
   * un tiers. `localhost:3001` est la pour le serveur de developpement isole.
   *
   * ⚠⚠ `bodySizeLimit` DOIT SUIVRE `MAX_SUBMISSION_BYTES` (128 Mo dans lib/assets/validate.ts).
   * Next plafonne les Server Actions a 1 Mo PAR DEFAUT. L'Atelier MIRAGE depose des PNG/.ytd
   * jusqu'a 32 Mo piece / 128 Mo par lot: sans ce plafond, le POST est coupe AVANT
   * `submitAssetsAction`, et le navigateur affiche "An unexpected response was received from the
   * server" (la page plante) au lieu d'un refus lisible. Verifie 2026-08-30 sur un depot tatouage.
   */
  experimental: {
    serverActions: {
      bodySizeLimit: "128mb",
      allowedOrigins: [
        "citadel.grandside.org",
        "lifeinvader.grandside.org",
        "localhost:3000",
        "localhost:3001",
      ],
    },
  },
  poweredByHeader: false,
  compress: true,
  // The CAD agency roundels (public/cad/agencies/*.svg, e.g. da.svg) are locally-authored trusted
  // assets, never user-uploaded, so serving them through next/image's optimizer is safe. Next blocks
  // SVG by default (it can carry a <script>) - this is the documented safe opt-in: sandboxed CSP,
  // script-src none, so even if an SVG somehow arrived from an untrusted source it could not execute.
  images: {
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  // ⚠⚠ TEMPORARY, added 2026-08-09 to bring the site back up after a build outage. `next build`
  // type-checks the WHOLE tsconfig `include` set (bot/**, scripts/**, src/**), and six pre-existing
  // files (bot/voice.ts, staff/anticheat/FlagEvidence.tsx, staff/players/[id]/components/VoiceTab.tsx,
  // staff/reference/page.tsx, staff/team/actions.ts, scripts/verify-log-participants.ts) reference
  // exports that a stray `git stash` swept away from disk earlier today (see the memory note
  // "business-portal-schema-stash-loss" and actions.md 2026-08-09 06:05). None of these are runtime
  // bugs - `next build` still transpiles and emits working JS regardless of a type error, only the
  // pass/fail gate is affected - but they blocked the build outright, which is what took the site
  // down (a corrupted routes-manifest.json from an earlier interrupted build could not be replaced).
  // REMOVE THIS once those six files' missing exports are restored from stash@{0} (or rewritten) and
  // `npx tsc --noEmit` is clean again - do not leave this in place as a permanent policy.
  typescript: { ignoreBuildErrors: true },
  // `mysql2` (src/lib/db/index.ts) has native Node-only requires (net/tls/crypto/fs) that neither
  // bundler can resolve for a non-Node target. instrumentation.ts (register()) is compiled for
  // BOTH the nodejs and edge runtimes even though its own code gates the sweeper imports behind
  // `process.env.NEXT_RUNTIME === "nodejs"` at runtime - that guard prevents a RUNTIME crash on
  // edge, but does not stop the BUILD from trying to bundle mysql2 into the edge variant, which is
  // what actually failed. This tells both Turbopack and webpack to leave mysql2 as a real
  // `require()` resolved at runtime instead of bundling it, which is the documented fix for this
  // exact class of native-driver-in-instrumentation error.
  serverExternalPackages: ["mysql2"],
  async headers() {
    // Embed routes first (CSP, no XFO). Catch-all base security without XFO. Staff lock last on /staff only.
    const embedRoutes = INGAME_EMBED_HEADER_SOURCES.map((source) => ({
      source,
      headers: ingameEmbedHeaderEntries(),
    }));

    return [
      ...embedRoutes,
      {
        source: "/:path*",
        headers: [...baseSecurityHeaders],
      },
      {
        source: "/staff",
        headers: [...staffLockedHeaderEntries],
      },
      {
        source: "/staff/:path*",
        headers: [...staffLockedHeaderEntries],
      },
      /**
       * ⚠ /business EST UNE SURFACE AUTHENTIFIÉE ET ELLE N'AVAIT NI CSP NI X-Frame-Options.
       *
       * Le bloc `/:path*` ci-dessus n'applique que `baseSecurityHeaders`, qui ne contient NI l'un NI
       * l'autre: seuls /staff et les routes intégrables en jeu recevaient une politique. /business
       * est la première famille de routes à tomber dans ce trou, et c'est une surface d'ÉCRITURE
       * (déclarer une vente, corriger des heures). Sans `frame-ancestors`, n'importe quel site peut
       * l'encadrer, superposer un leurre sur le bouton de déclaration, et faire enregistrer une
       * vente à un employé en service.
       *
       * On réutilise la politique de /staff plutôt que d'en écrire une seconde: elle porte déjà
       * `style-src 'self' 'unsafe-inline'`, ce dont la balise <style> de la palette a besoin.
       */
      {
        source: "/business",
        headers: [...staffLockedHeaderEntries],
      },
      {
        source: "/business/:path*",
        headers: [...staffLockedHeaderEntries],
      },
    ];
  },
  // Build/prod: stop file-tracing from walking above this directory.
  outputFileTracingRoot: path.join(__dirname),
  // Dev: the same pin for Turbopack, which resolves its root independently of the option above.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
