import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
  /**
   * `/` is the landing page and is written out as HTML so it is not blank before
   * the bundle runs. Every other route hydrates from `__spa-fallback.html`,
   * which `server/clientBundle.ts` falls back to.
   */
  prerender: ["/"],
} satisfies Config;
