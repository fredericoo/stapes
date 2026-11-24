import * as v from "valibot";
import { MAX_WEATHER_AREAS, type WeatherArea } from "../../../lib/weatherAreas";
import type { Component } from "../build";
import type { MapNode } from "../doc";
import type { Layout } from "../layout";

export const WEATHER_TYPE = "weather";

const WeatherSchema = v.object({
  rain: v.optional(v.boolean(), true),
  fog: v.optional(v.boolean(), false),
});

export type WeatherProps = v.InferOutput<typeof WeatherSchema>;

/**
 * Writes nothing to the map. Its frame becomes one of the world's weather
 * areas (`weatherAreasOf`), saying whether rain and fog reach the cells inside
 * it; a later weather node decides over an earlier one where they overlap.
 */
export const weather: Component<WeatherProps> = {
  type: WEATHER_TYPE,
  label: "Weather",
  starter: { frame: { x: 2, y: 2, w: 24, h: 16 } },
  schema: WeatherSchema,
  build: () => ({ ok: true, edits: [] }),
};

/**
 * The weather areas a tree lays out, in tree order. A hidden node and its
 * descendants lay none, and an area is cut to its parents' frames, as
 * everything a node builds is. Past `MAX_WEATHER_AREAS` the last ones are
 * kept, because a later area decides over an earlier one.
 */
export function weatherAreasOf(layout: Layout): WeatherArea[] {
  const areas: WeatherArea[] = [];
  const rootKey = layout.order[0];
  const root = rootKey === undefined ? undefined : layout.placements.get(rootKey)?.node;
  const visit = (node: MapNode) => {
    if (node.hidden) return;
    const placement = layout.placements.get(node.key);
    if (placement?.node !== node) return;
    if (node.type === WEATHER_TYPE) {
      const props = v.safeParse(WeatherSchema, node.props ?? {});
      const { bounds, clip } = placement;
      const x0 = Math.max(bounds.minX, clip.minX);
      const y0 = Math.max(bounds.minY, clip.minY);
      const x1 = Math.min(bounds.maxX, clip.maxX);
      const y1 = Math.min(bounds.maxY, clip.maxY);
      if (props.success && x0 <= x1 && y0 <= y1) {
        areas.push({ x0, y0, x1, y1, rain: props.output.rain, fog: props.output.fog });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  if (root) visit(root);
  return areas.slice(-MAX_WEATHER_AREAS);
}
