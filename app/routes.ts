import { type RouteConfig, index, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("online", "routes/online.tsx"),
  /**
   * The authoring tools, all of them, behind one path segment.
   *
   * Unguarded on purpose: there is no login yet, so `/admin` is a place rather
   * than a permission. What it buys today is that nothing in the game links to
   * it — a tester who never types the path never sees a tile editor — and that
   * when there is an account system there is one segment to put it in front of.
   */
  ...prefix("admin", [
    index("routes/admin/_index.tsx"),
    route("map", "routes/admin/map.tsx"),
    route("tiles", "routes/admin/tiles.tsx"),
    route("statuses", "routes/admin/statuses.tsx"),
    route("play", "routes/admin/play.tsx"),
    route("arena", "routes/admin/arena.tsx"),
    route("voxel", "routes/admin/voxel.tsx"),
  ]),
] satisfies RouteConfig;
