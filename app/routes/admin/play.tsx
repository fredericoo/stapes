import { redirect } from "react-router";

/**
 * Where the world in the tab used to be, before it stopped needing an account.
 *
 * Kept as a redirect so bookmarks and older notes that name `/admin/play`
 * still open the game. @see ../play
 */
export function clientLoader() {
  const { search } = new URL(window.location.href);
  // `?debug=1` is the usual reason to have this URL saved, so it goes along.
  throw redirect(`/play${search}`);
}

export default function AdminPlayRedirect() {
  return null;
}
