import { redirect } from "react-router";
import { requireAdmin } from "../../lib/auth";

/**
 * `/admin` is the map editor, which is where the work starts more often than
 * not.
 *
 * A `clientLoader` because there is no server rendering: the redirect happens
 * in the tab, on the first navigation, rather than as a 302.
 *
 * The role is asked for here too, though the page that answers this redirect
 * asks again. Without it, somebody signed out who typed `/admin` would be
 * bounced to the map editor and bounced back out of it — a second navigation
 * to reach the same door.
 */
export async function clientLoader() {
  await requireAdmin();
  return redirect("/admin/map");
}

export default function AdminIndex() {
  return null;
}
