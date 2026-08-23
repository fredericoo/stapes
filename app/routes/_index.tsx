import { redirect } from "react-router";

/**
 * The front door, which is `/online`.
 *
 * A `clientLoader` because there is no server rendering: the redirect happens in
 * the tab, on the first navigation, rather than as a 302.
 */
export function clientLoader() {
  return redirect("/online");
}

export default function Index() {
  return null;
}
