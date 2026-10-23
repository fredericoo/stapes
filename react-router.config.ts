import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
  /**
   * `/`, `/changelog` and `/items` are public pages and are written out as HTML so
   * they are not blank before the bundle runs. Every other route hydrates from `__spa-fallback.html`,
   * which `server/clientBundle.ts` falls back to.
   */
  prerender: ["/", "/changelog", "/items"],
} satisfies Config;
