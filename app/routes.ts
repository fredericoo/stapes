import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("tiles", "routes/tiles.tsx"),
  route("statuses", "routes/statuses.tsx"),
  route("map", "routes/map.tsx"),
  route("play", "routes/play.tsx"),
  route("reset", "routes/reset.ts"),
  route("online", "routes/online.tsx"),
  route("voxel", "routes/voxel.tsx"),
  route("tilesets/:file", "routes/tilesets.$file.ts"),
] satisfies RouteConfig;
