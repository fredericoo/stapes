import { availableStates } from "./interactions";
import { validateParticleEmitter } from "./particleVfx";
import {
  type Frame,
  type OverrideSpriteState,
  type StateSprites,
  type TileDef,
  type TileSprite,
  facingKeysFor,
  isDirectional,
} from "./types";

export const TILE_ID_PATTERN = /^[a-z0-9-]+$/;

export function tileIdentityError(draft: TileDef): string | null {
  if (!draft.id.trim()) return "Id is required";
  if (!TILE_ID_PATTERN.test(draft.id)) return "Id must be lowercase letters, numbers, and hyphens";
  if (!draft.name.trim()) return "Name is required";
  return null;
}

export function idleSprites(draft: TileDef): StateSprites {
  if (draft.type === "simple") return { sprite: draft.sprite };
  if (isDirectional(draft)) return { sprites: draft.sprites };
  if (draft.type === "scatter") return { scatter: draft.scatter };
  if (draft.type === "variant") return { variants: draft.variants };
  return { slices: draft.slices };
}

function stateSpriteList(draft: TileDef, from: StateSprites): TileSprite[] {
  if (draft.type === "simple") return from.sprite ? [from.sprite] : [];
  if (isDirectional(draft)) {
    return facingKeysFor(draft)
      .map((d) => from.sprites?.[d])
      .filter((s): s is TileSprite => s != null);
  }
  if (draft.type === "scatter") {
    return (from.scatter ?? []).filter((s): s is TileSprite => s != null);
  }
  if (draft.type === "variant") {
    return Object.values(from.variants ?? {}).filter((s): s is TileSprite => s != null);
  }
  return Object.values(from.slices ?? {}).filter((s): s is TileSprite => s != null);
}

function footprintOf(sprite: TileSprite | undefined): string | null {
  const first = sprite?.frames[0];
  if (!first) return null;
  const { rect, base } = first.sprite;
  return `${rect.w}x${rect.h}@${base.x},${base.y}`;
}

function footprintMismatch(
  draft: TileDef,
  state: OverrideSpriteState,
  override: StateSprites,
): string | null {
  const idle = idleSprites(draft);
  const check = (label: string, a: TileSprite | undefined, b: TileSprite | undefined) => {
    const want = footprintOf(a);
    const got = footprintOf(b);
    if (want == null || got == null || want === got) return null;
    return `${state} ${label}: sprite is ${got} but idle is ${want} — a state must draw at idle's size and base`;
  };

  if (draft.type === "simple") return check("sprite", idle.sprite, override.sprite);
  if (isDirectional(draft)) {
    for (const d of facingKeysFor(draft)) {
      const err = check(d.toUpperCase(), idle.sprites?.[d], override.sprites?.[d]);
      if (err) return err;
    }
    return null;
  }
  if (draft.type === "scatter") {
    for (let i = 0; i < (override.scatter?.length ?? 0); i++) {
      const err = check(`face ${i + 1}`, idle.scatter?.[i], override.scatter?.[i]);
      if (err) return err;
    }
    return null;
  }
  if (draft.type === "variant") {
    for (const key of Object.keys(override.variants ?? {})) {
      const err = check(key, idle.variants?.[key], override.variants?.[key]);
      if (err) return err;
    }
    return null;
  }
  for (const key of Object.keys(override.slices ?? {})) {
    const i = Number(key);
    const err = check(`slice ${i}`, idle.slices?.[i], override.slices?.[i]);
    if (err) return err;
  }
  return null;
}

export function statesForSave(draft: TileDef): TileDef["states"] {
  const allowed = new Set(availableStates(draft));
  const idle = JSON.stringify(idleSprites(draft));
  const out: NonNullable<TileDef["states"]> = {};
  let any = false;

  for (const [key, sprites] of Object.entries(draft.states ?? {})) {
    const state = key as OverrideSpriteState;
    if (!sprites || !allowed.has(state)) continue;
    if (JSON.stringify(sprites) === idle) continue;
    out[state] = sprites;
    any = true;
  }
  return any ? out : undefined;
}

function validateFrameLights(frames: Frame[]): string | null {
  for (let i = 0; i < frames.length; i++) {
    const light = frames[i]?.light;
    if (!light) continue;
    if (!(light.radius > 0) || !Number.isFinite(light.radius)) {
      return `Frame ${i + 1}: light radius must be a positive number`;
    }
    if (!(light.intensity >= 0) || !(light.intensity <= 1) || !Number.isFinite(light.intensity)) {
      return `Frame ${i + 1}: light intensity must be between 0 and 1`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(light.color)) {
      return `Frame ${i + 1}: light colour must be a hex like #ffcc88`;
    }
  }
  return null;
}

export function tileArtError(draft: TileDef): string | null {
  const emitters = [
    draft.particles,
    draft.transitions?.appear?.particles,
    draft.transitions?.disappear?.particles,
    draft.interactions?.projectile?.hit?.particles,
    draft.interactions?.extract?.pulled?.particles,
    draft.interactions?.craft?.succeeded?.particles,
    draft.interactions?.craft?.failed?.particles,
  ];
  for (const emitter of emitters) {
    const err = emitter ? validateParticleEmitter(emitter) : null;
    if (err) return `Particles: ${err}`;
  }

  if (draft.type === "simple") {
    if (!draft.sprite?.frames.length) return "At least one frame is required";
    const err = validateFrameLights(draft.sprite.frames);
    if (err) return err;
  } else if (isDirectional(draft)) {
    for (const d of facingKeysFor(draft)) {
      if (!draft.sprites?.[d]?.frames.length) {
        return `Missing frames for direction ${d.toUpperCase()}`;
      }
      const err = validateFrameLights(draft.sprites[d]!.frames);
      if (err) return `${d.toUpperCase()}: ${err}`;
    }
  } else if (draft.type === "scatter") {
    const faces = draft.scatter ?? [];
    if (!faces.length) return "Add at least one scatter face";
    for (let i = 0; i < faces.length; i++) {
      if (!faces[i]?.frames.length) return `Face ${i + 1}: at least one frame is required`;
      const err = validateFrameLights(faces[i]!.frames);
      if (err) return `Face ${i + 1}: ${err}`;
    }
  } else if (draft.type === "variant") {
    const entries = Object.entries(draft.variants ?? {});
    if (!entries.length) return "Add at least one variant face";
    for (const [key, sprite] of entries) {
      if (!sprite?.frames.length) return `${key}: at least one frame is required`;
      const err = validateFrameLights(sprite.frames);
      if (err) return `${key}: ${err}`;
    }
  } else {
    const defined = Object.values(draft.slices ?? {}).filter(Boolean);
    if (!defined.length) return "Define at least one autotile slice";
    for (const [k, s] of Object.entries(draft.slices ?? {})) {
      if (!s?.frames.length) continue;
      const err = validateFrameLights(s.frames);
      if (err) return `Slice ${k}: ${err}`;
    }
  }

  for (const [key, sprites] of Object.entries(statesForSave(draft) ?? {})) {
    if (!sprites) continue;
    const mismatch = footprintMismatch(draft, key as OverrideSpriteState, sprites);
    if (mismatch) return mismatch;
    for (const s of stateSpriteList(draft, sprites)) {
      const err = validateFrameLights(s.frames);
      if (err) return `${key}: ${err}`;
    }
  }

  return null;
}
