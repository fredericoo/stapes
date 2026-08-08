import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Tests that run inside workerd, with real Durable Object storage and real
 * bindings.
 *
 * Separate from `vitest.config.ts` because the two need different pools: `app/`
 * is plain logic and runs far faster in node, while `workers/` is only
 * meaningful against the runtime it deploys to. Both shipped bugs in
 * `GameServer` lived in the load/restore path and were invisible to a node
 * test — the object has to actually be constructed, checkpointed and
 * reconstructed for them to show up.
 */
export default defineWorkersConfig({
  test: {
    include: ["workers/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Bindings come from the real config, so a test cannot pass against a
        // binding set the deploy does not have.
        wrangler: { configPath: "./wrangler.jsonc" },
        // Each test file gets its own storage, undone between tests: a world
        // left running by one case must not be the starting state of the next.
        isolatedStorage: true,
      },
    },
  },
});
