import { redirect } from "react-router";

/**
 * `/admin` is the map editor, which is where the work starts more often than
 * not.
 *
 * A `clientLoader` because there is no server rendering: the redirect happens
 * in the tab, on the first navigation, rather than as a 302.
 */
export function clientLoader() {
  return redirect("/admin/map");
}

export default function AdminIndex() {
  return null;
}
