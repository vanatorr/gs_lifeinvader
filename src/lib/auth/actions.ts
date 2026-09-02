"use server";

import { signOut } from "./config";

/**
 * Sign the current staff member out and send them to the login door.
 *
 * The mirror of the login page's inline `signIn("discord", { redirectTo: "/staff" })` server action.
 * It lives in its own "use server" module rather than inline because the caller (SidebarViewer) is a
 * Client Component, and a client component cannot declare an inline server action - it has to import
 * one. `signOut` clears the DATABASE session row (the app uses database sessions precisely so a sign
 * out, or an admin revoke, takes effect immediately rather than waiting out a JWT), then redirects.
 */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
