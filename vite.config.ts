import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // The Cloudflare plugin runs server code in workerd during dev, so a loader
  // reaching for a Node API fails here rather than on deploy.
  plugins: [tailwindcss(), cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
});
