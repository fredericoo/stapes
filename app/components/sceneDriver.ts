import type { Scene } from "../lib/scene";

/** What `/admin/scene` puts on the window for `bun run scene` to drive. */
export type SceneDriver = {
  /** Draws the scene and resolves once its light has baked and a frame shows it. */
  render(scene: Scene, options?: { timeoutMs?: number }): Promise<void>;
};

declare global {
  interface Window {
    __scene?: SceneDriver;
  }
}
