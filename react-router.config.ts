import type { Config } from "@react-router/dev/config";

export default {
  /**
   * No server rendering.
   *
   * The client is a bundle of static files now, pushed to a bucket and served
   * by the game server — so deploying it is a push and a pointer flip rather
   * than a restart, and nobody playing is disconnected by a change to the UI.
   *
   * The cost is React Router's typed loader data, since a `clientLoader` returns
   * whatever it fetched. `app/lib/api.ts` pays that back through Eden Treaty,
   * which infers the types from the server's own route definitions.
   */
  ssr: false,
} satisfies Config;
