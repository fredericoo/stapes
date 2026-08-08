import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext, dataStoreContext } from "../app/context";
import { createDataStore } from "../app/lib/storage.server";

const handleRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    context.set(dataStoreContext, createDataStore(env, request));
    return handleRequest(request, context);
  },
} satisfies ExportedHandler<Env>;
