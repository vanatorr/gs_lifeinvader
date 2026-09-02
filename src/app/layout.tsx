import type { Metadata, Viewport } from "next";
// Typefaces from the imported Claude Design: Hanken Grotesk (UI) + JetBrains Mono (data-shaped),
// self-hosted via @fontsource (not the Google CDN the design prototyped with).
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "CITADEL",
  description: "Plateforme centrale GrandSide",
};

/**
 * Next injects a default `width=device-width, initial-scale=1`, but two things here are NOT default
 * and both are needed for the panel to sit correctly on a phone:
 *
 * - `viewportFit: "cover"` is what makes env(safe-area-inset-*) report real numbers. Without it the
 *   insets are all 0 and the `--safe-*` tokens in globals.css silently do nothing - the notch and
 *   the home indicator then overlap the topbar and the action rail.
 * - `maximumScale`/`userScalable` are deliberately LEFT ALONE. Locking zoom is the usual reflex
 *   here and it is an accessibility failure: it stops a low-vision user pinching into a dense data
 *   table, which is exactly the content this app is made of. The iOS focus-zoom problem is solved
 *   properly in globals.css by making form controls 16px on touch, not by banning zoom.
 */
export const viewport: Viewport = {
  themeColor: "#0e0b0b",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Dark-only ops tool: the class is permanent, not a toggle (globals.css mirrors :root and .dark).
  return (
    <html lang="fr" className="dark" suppressHydrationWarning>
      <body className="font-sans antialiased">
        {children}
        {/* A11 - surfaces useLive.ts's shared-stream "error"/"open" events (Flux interrompu…) and
            any other toast in the app. One instance, app-wide (login/appeal pages included). */}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
