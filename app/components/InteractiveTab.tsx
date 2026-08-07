import type {
  ClimbAbility,
  PushInteraction,
  SwitchInteraction,
  TileInteractions,
} from "../lib/interactions";
import { DEFAULT_PUSH, DEFAULT_SWITCH } from "../lib/interactions";
import type { TileDef, TilesetDef } from "../lib/types";
import { Segmented, Switch } from "../ui";
import { TileIdMultiSelect } from "./TileIdMultiSelect";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
};

/**
 * Ways the player can interact with this tile in play mode. One section per
 * interaction kind.
 */
export function InteractiveTab({ draft, onChange, tiles, tilesets }: Props) {
  const push = draft.interactions?.push;
  const sw = draft.interactions?.switch;

  const setInteractions = (next: TileInteractions | undefined) => {
    onChange({ ...draft, interactions: next });
  };

  /** Patch one kind without clobbering the others. `null` clears that kind. */
  const patchKind = <K extends keyof TileInteractions>(
    key: K,
    value: TileInteractions[K] | null,
  ) => {
    const merged: TileInteractions = { ...draft.interactions };
    if (value == null) delete merged[key];
    else merged[key] = value;
    setInteractions(
      merged.push || merged.switch ? merged : undefined,
    );
  };

  const setPush = (next: PushInteraction | undefined) => {
    patchKind("push", next ?? null);
  };

  const patchPush = (patch: Partial<PushInteraction>) => {
    if (!push) return;
    setPush({ ...push, ...patch });
  };

  const setSwitch = (next: SwitchInteraction | undefined) => {
    patchKind("switch", next ?? null);
  };

  const patchSwitch = (patch: Partial<SwitchInteraction>) => {
    if (!sw) return;
    setSwitch({ ...sw, ...patch });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(push)}
            onCheckedChange={(on) => setPush(on ? { ...DEFAULT_PUSH } : undefined)}
            ariaLabel="Pushable"
          />
          Push
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Standing next to this object and clicking it shoves it one cell
          straight away from the player. Never diagonally, never further than
          one cell — where it goes is decided by where the player stands.
        </p>

        {push ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">
                Climb height
              </span>
              <Segmented<ClimbAbility>
                value={push.climb}
                onChange={(climb) => patchPush({ climb })}
                options={[
                  { value: "none", label: "None" },
                  { value: "half", label: "Half" },
                  { value: "full", label: "Full" },
                ]}
                size="sm"
              />
              <span className="text-[11px] leading-snug text-muted">
                How far up it can be shoved. When the cell ahead offers both a
                step up and a step down it takes the step down. Going down is
                physics — turn on <strong>Affected by gravity</strong> on the
                Tile tab to let it be pushed off ledges.
              </span>
            </div>

            <TileIdMultiSelect
              tiles={tiles}
              tilesets={tilesets}
              selectedIds={push.moveOnTileIds}
              onChange={(moveOnTileIds) => patchPush({ moveOnTileIds })}
              label="Move on tiles"
              emptyHint="Any surface. Pick tiles to confine this object to them — it can only come to rest on top of one of the chosen tiles."
            />
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(sw)}
            onCheckedChange={(on) =>
              setSwitch(on ? { ...DEFAULT_SWITCH } : undefined)
            }
            ariaLabel="Switchable"
          />
          Switch
        </label>
        <p className="text-[11px] leading-snug text-muted">
          Clicking this object replaces it with another tile. Put switch on
          both tiles to toggle (e.g. door closed ↔ open). The swap is refused
          when the target would not fit in the stack. A tile with both switch
          and push switches — push is the fallback.
        </p>

        {sw ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <TileIdMultiSelect
              tiles={tiles.filter((t) => t.id !== draft.id)}
              tilesets={tilesets}
              selectedIds={sw.targetTileId ? [sw.targetTileId] : []}
              onChange={(ids) =>
                patchSwitch({ targetTileId: ids[0] ?? "" })
              }
              label="Target tile"
              emptyHint="Pick the tile this becomes when switched."
              single
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
