import { useEffect, useState } from "react";
import { tilesetUrl } from "./api";
import type { TilesetDef } from "./types";

const WORLD_LABEL_FONT_FAMILY = "NF Pixels";

const FONT_PROBE = `20px "${WORLD_LABEL_FONT_FAMILY}"`;

const ASSET_TIMEOUT_MS = 10_000;

const settled = new WeakSet<TilesetDef[]>();

export function useGameAssets(tilesets: TilesetDef[]): boolean {
  const [ready, setReady] = useState(() => settled.has(tilesets));

  useEffect(() => {
    if (settled.has(tilesets)) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void loadGameAssets(tilesets).then(() => {
      settled.add(tilesets);
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [tilesets]);

  return ready;
}

async function loadGameAssets(tilesets: TilesetDef[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ASSET_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.all([
        settle(loadLabelFont()),
        ...tilesets.map((tileset) => settle(loadTileset(tileset))),
      ]),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadLabelFont(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await document.fonts.load(FONT_PROBE);
}

async function loadTileset(tileset: TilesetDef): Promise<void> {
  const image = new Image();
  image.src = tilesetUrl(tileset.file);
  await image.decode();
}

async function settle(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (err) {
    console.warn("asset failed to load", err);
  }
}
