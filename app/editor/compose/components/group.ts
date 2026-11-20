import * as v from "valibot";
import type { Component } from "../build";

const GroupSchema = v.object({});

/**
 * Builds nothing itself. Without a frame it is a folder: its children fill
 * and measure from its parent exactly as they would without it. With a frame
 * its children are placed in that frame, so moving the group moves them all.
 * Either way it builds where it stands in the list, so its children draw over
 * the layers before it.
 */
export const group: Component<Record<string, never>> = {
  type: "group",
  label: "Group",
  starter: {},
  schema: GroupSchema as never,
  build: () => ({ ok: true, edits: [] }),
};
