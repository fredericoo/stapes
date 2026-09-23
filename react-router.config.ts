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
  /**
   * The pages that are written out as HTML at build time.
   *
   * `/home` is the landing page, and a landing page that is blank until the
   * bundle has run is one a link preview, a search engine and a slow phone all
   * see as empty. It has no loader, so rendering it at build time needs nothing
   * the build does not already have.
   *
   * **`/` must stay off this list.** With `/` unrendered, `index.html` is the
   * SPA fallback that every other route hydrates from, and
   * `server/clientBundle.ts` serves it for any path that is not a file.
   * Prerendering `/` would move the fallback to `__spa-fallback.html` and every
   * route but these would get the game's shell with the wrong route inside it.
   */
  prerender: ["/home"],
} satisfies Config;
