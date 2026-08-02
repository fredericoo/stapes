import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "e2e/**", ".worktrees/**"],
  },
});
