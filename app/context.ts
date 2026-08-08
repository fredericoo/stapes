import { createContext, type RouterContextProvider } from "react-router";
import type { DataStore } from "./lib/storage.server";

/**
 * The Worker's bindings and lifecycle, handed to loaders and actions.
 *
 * React Router 8 dropped `AppLoadContext` in favour of typed context objects,
 * so this is how a route reaches a binding. Set once per request in
 * `workers/app.ts`.
 */
export type CloudflareContext = {
  env: Env;
  ctx: ExecutionContext;
};

export const cloudflareContext = createContext<CloudflareContext>();

/**
 * Authored content for this request.
 *
 * Chosen at the composition root rather than here, because which backend it is
 * depends on the request's own origin in dev — see `createDataStore`. Routes
 * only ever see the one interface.
 */
export const dataStoreContext = createContext<DataStore>();

/**
 * `Readonly` because that is what loaders and actions are handed — they may
 * read the request's contexts but not set new ones.
 */
export function dataStore(context: Readonly<RouterContextProvider>): DataStore {
  return context.get(dataStoreContext);
}
