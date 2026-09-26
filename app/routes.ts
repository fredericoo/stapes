import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  layout("routes/player.tsx", [
    index("routes/game.tsx"),
    route("sign-in", "routes/signIn.tsx"),
    route("sign-up", "routes/signUp.tsx"),
    route("characters", "routes/characters.tsx"),
    route("characters/new", "routes/newCharacter.tsx"),
    route("account/password", "routes/password.tsx"),
  ]),
  ...prefix("admin", [
    index("routes/admin/_index.tsx"),
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
