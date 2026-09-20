import { type RouteConfig, index, prefix, route } from "@react-router/dev/routes";

export default [
  /**
   * The game is the front door. There is nothing else a visitor is here for,
   * and a redirect from `/` to somewhere else was a round trip before the first
   * paint that told them nothing.
   */
  index("routes/game.tsx"),
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
  ]),
] satisfies RouteConfig;
