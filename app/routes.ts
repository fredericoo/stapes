import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  /**
   * The landing page. Outside the player layout, because that layout's loader
   * fetches the catalogues and the account, and this page needs neither — it is
   * prerendered at build time, where there is no server to ask. See
   * `react-router.config.ts`.
   */
  route("home", "routes/home.tsx"),
  /**
   * Everything a player sees, under one layout.
   *
   * **Several small routes rather than one that does all of it.** Each screen
   * here answers exactly one question — who are you, which body, what is this
   * one called, what is the new password, and then the world itself — so each
   * is a file you can read in a sitting, with its own loader saying what it
   * needs and its own redirect when that is missing.
   *
   * `routes/player.tsx` is what makes that affordable. A layout's loader runs
   * once and its component stays mounted across every navigation between its
   * children, so the catalogues are fetched once per tab and the tilesets
   * decoded once per tab — while somebody is still typing a username, rather
   * than after they have pressed a character. Splitting the screens up costs
   * nothing on the way in as a result.
   *
   * `/` is still the game: a visitor who is signed in with a character chosen
   * lands on the world, and the loader redirects only when a precondition is
   * actually missing.
   */
  layout("routes/player.tsx", [
    index("routes/game.tsx"),
    route("sign-in", "routes/signIn.tsx"),
    route("sign-up", "routes/signUp.tsx"),
    route("characters", "routes/characters.tsx"),
    route("characters/new", "routes/newCharacter.tsx"),
    route("account/password", "routes/password.tsx"),
  ]),
  /**
   * The authoring tools, all of them, behind one path segment — and now behind
   * a role as well.
   *
   * **Every page here but the door asks for an `ADMIN` account.** The ask is in
   * each route's own `clientLoader` rather than in a layout above them, because
   * React Router runs a layout's loader alongside its child's rather than
   * before it: a gate up there would still let the map editor fire the fetch it
   * is about to be refused, and the page would land on an error boundary
   * instead of a sign-in form.
   *
   * It is a courtesy rather than the control. These pages are static files in a
   * bundle anybody can fetch, so what actually stops somebody authoring the
   * world is `server/api.ts` refusing to write it — see `requireAdmin`, which
   * says the same thing from the other side.
   */
  ...prefix("admin", [
    index("routes/admin/_index.tsx"),
    // Reachable signed out, and the only route here that is: there would
    // otherwise be nowhere to sign in.
    route("sign-in", "routes/admin/signIn.tsx"),
    route("map", "routes/admin/map.tsx"),
    route("tiles", "routes/admin/tiles.tsx"),
    route("statuses", "routes/admin/statuses.tsx"),
    route("play", "routes/admin/play.tsx"),
    route("arena", "routes/admin/arena.tsx"),
    route("voxel", "routes/admin/voxel.tsx"),
    route("actions", "routes/admin/actions.tsx"),
  ]),
] satisfies RouteConfig;
