/// <reference types="@cloudflare/vitest-pool-workers" />

/**
 * `cloudflare:test` hands tests the same bindings the Worker gets, so the
 * `env` a test reads is typed by the same `Env` that `wrangler types`
 * generates from wrangler.jsonc. A binding added there is immediately visible
 * here, and a test cannot pass against one the deploy does not have.
 */
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
