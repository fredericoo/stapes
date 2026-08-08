import { createContext } from "react-router";

/**
 * The Worker's bindings and lifecycle, handed to loaders and actions.
 *
 * React Router 8 dropped `AppLoadContext` in favour of typed context objects,
 * so this is how a route reaches R2 or the game server. Set once per request in
 * `workers/app.ts`; read with `context.get(cloudflareContext)`.
 */
export type CloudflareContext = {
  env: Env;
  ctx: ExecutionContext;
};

export const cloudflareContext = createContext<CloudflareContext>();
