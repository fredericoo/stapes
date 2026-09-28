import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  layout("routes/player.tsx", [
    route("online", "routes/game.tsx"),
    route("sign-in", "routes/signIn.tsx"),
    route("sign-up", "routes/signUp.tsx"),
    route("guest", "routes/guest.tsx"),
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
    route("traits", "routes/admin/traits.tsx"),
    route("play", "routes/admin/play.tsx"),
    route("arena", "routes/admin/arena.tsx"),
    route("voxel", "routes/admin/voxel.tsx"),
    route("townsfolk", "routes/admin/townsfolk.tsx"),
    route("actions", "routes/admin/actions.tsx"),
    route("feedback", "routes/admin/feedback.tsx"),
    route("players", "routes/admin/players.tsx"),
    route("players/:characterId", "routes/admin/player.tsx"),
  ]),
] satisfies RouteConfig;
