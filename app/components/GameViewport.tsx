import { useCallback, useMemo, useState } from "react";
import type { ObjectRef } from "../game/affordances";
import type { Equipment } from "../game/equipment";
import { emptyEquipment } from "../game/equipment";
import type { InteractionOption } from "../game/interactionOptions";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import { itemUseFor } from "../game/itemUse";
import type { ItemInstance } from "../lib/itemInstance";
import type { Direction, TileDef, TilesetDef } from "../lib/types";
import { useMediaQuery } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { ChatBar, ChatButton } from "./ChatBar";
import { ContainerPanel } from "./ContainerPanel";
import { DirectionPad } from "./DirectionPad";
import { EquipmentPanel } from "./EquipmentPanel";
import { DragLayer } from "./DragLayer";
import { InteractionList } from "./InteractionList";
import { AttackToggle, LookToggle, type ModeToggleSize } from "./ModeToggle";
import { BagButton, EquipmentToggle } from "./PanelToggle";
import { useItemDrag } from "./useItemDrag";

/**
 * The game as a fixed square, letterboxed into whatever space it is given.
 *
 * Everyone sees the same amount of world (see `../render/viewport`), so the
 * pane only decides how big it is drawn: on a phone the square sits at the top
 * with the arrows beneath it, on a desktop it grows until it hits the shorter
 * edge and the rest is ink.
 *
 * Chrome added below the square takes its height from the game rather than
 * covering it, and needs no sizing work to do so: the canvas is `100cqmin` of a
 * box that is square by ratio and allowed to shrink, so anything in the flow
 * underneath simply leaves it less to be the smaller edge of. Chrome added
 * *beside* it — the interaction list on a desktop — works the same way round,
 * narrowing the column the square measures itself against. That is the lever to
 * keep pulling as more UI arrives.
 */

/**
 * Room for the interaction list beside the game, on a pointer that has hover.
 *
 * Fixed rather than fluid, and always present even while empty: it comes out of
 * the square's width, so a column that appeared and vanished with its contents
 * would resize the canvas every time the player walked past a crate.
 */
const INTERACTION_PANEL_WIDTH_PX = 224;

const COARSE_POINTER = "(pointer: coarse)";

/**
 * Is the primary input a finger?
 *
 * Drives whether the on-screen arrows are there at all. Deliberately about the
 * input device and not the window's shape — a desktop window dragged narrow is
 * still played with a keyboard, and growing a d-pad nobody will tap would just
 * take space away from the game.
 *
 * Server-rendered as false: the server cannot know, and a keyboard layout that
 * gains a pad on hydration is a smaller lie than a pad that vanishes.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER);
}

export function GameViewport({
  canvasRef,
  labelRef,
  onDirectionPress,
  onDirectionRelease,
  onSay,
  onTypingChange,
  looking = false,
  onLookingChange,
  attacking = false,
  onAttackingChange,
  interactions = [],
  onInteract,
  onHoverInteraction,
  equipment = emptyEquipment(),
  openedContainer = null,
  onOpenContainer,
  canMoveItem = () => false,
  onMoveItem,
  onDragOverWorld,
  onDropOnWorld,
  tiles = [],
  tilesets = [],
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /**
   * Where in-world text is drawn — names and speech, over the canvas but not in
   * it. See `../render/textLabels` for why that text is DOM rather than pixels
   * in the drawing buffer.
   */
  labelRef?: React.RefObject<HTMLDivElement | null>;
  onDirectionPress: (direction: Direction) => void;
  onDirectionRelease: (direction: Direction) => void;
  /** Given only by a route with somebody to talk to; the bar is absent without it. */
  onSay?: (text: string) => void;
  onTypingChange?: (typing: boolean) => void;
  /**
   * Look mode. Shift is still the fastest way to do this with a keyboard, but
   * the button is drawn on every device now: a modifier is only discoverable to
   * somebody who already knows about it, so the mode was effectively invisible
   * on the machines that had the better way of reaching it.
   */
  looking?: boolean;
  onLookingChange?: (looking: boolean) => void;
  /**
   * Attack mode: whether the thing you are pointing at is somebody you are
   * fighting. Same shape as look mode, and drawn beside it, because they are the
   * same kind of thing — what a tap on the world means — and they can both be on.
   */
  attacking?: boolean;
  onAttackingChange?: (attacking: boolean) => void;
  /**
   * What is within reach right now, worked out by whoever owns the session —
   * see `../game/interactionOptions`. Empty by default so a route that has not
   * wired it up shows the panel saying so rather than crashing.
   */
  interactions?: InteractionOption[];
  onInteract?: (option: InteractionOption) => void;
  /**
   * The row being pointed at, so the world can outline its subject. Wired only
   * where there is a pointer that hovers — see the call site.
   */
  onHoverInteraction?: (optionId: string | null) => void;
  /**
   * What the viewer is carrying — theirs alone; see `GameSnapshot.equipment`.
   * Defaulted so a route that has not wired it up draws empty slots rather than
   * crashing, exactly as `interactions` does.
   */
  equipment?: Equipment;
  /**
   * The container on the floor currently being looked into, resolved off the
   * live board by whoever owns the renderer.
   *
   * The instance rather than a reference, and read fresh rather than remembered,
   * because a chest's contents ride on its placement: anything holding a copy
   * would go stale the moment somebody took something out of it. Null also means
   * "no longer open" — walked away from, emptied, or picked up out from under
   * the panel — so closing needs no separate rule.
   */
  openedContainer?: OpenedContainer | null;
  /** Look into a container on the floor, or stop. */
  onOpenContainer?: (ref: ObjectRef | null) => void;
  /**
   * Whether a move would be honoured, asked of whoever owns the session.
   *
   * Answered from the same rules the server validates with, which is what lets
   * a slot light up before anything has been sent — see `../game/itemMoves`.
   * Defaults to refusing everything, so a route that has not wired it up simply
   * has no drop targets rather than offering moves nothing will carry out.
   */
  canMoveItem?: (from: SlotRef, to: SlotRef) => boolean;
  /** Move a carried thing from one slot to another. */
  onMoveItem?: (from: SlotRef, to: SlotRef) => void;
  /**
   * A drag is out over the world, carrying this — or null, for no longer.
   *
   * Only the pointer position travels, because which *cell* that is depends on
   * the camera and this component has no view of it. Whoever owns the renderer
   * resolves it, and draws the ghost.
   */
  onDragOverWorld?: (
    drag: { from: SlotRef; tileId: string; x: number; y: number } | null,
  ) => void;
  /** A drag was let go over the world at this point. */
  onDropOnWorld?: (from: SlotRef, point: { x: number; y: number }) => void;
  /** Catalogue behind the list's sprites. */
  tiles?: TileDef[];
  tilesets?: TilesetDef[];
}) {
  const coarse = useCoarsePointer();
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  /**
   * The one move in progress, page-wide.
   *
   * Here rather than in either panel because a move has two ends and they are in
   * different panels: taking a sword out of a chest and putting it in your bag
   * is one gesture crossing a boundary neither component can see across.
   */
  const move = useCallback(
    (from: SlotRef, to: SlotRef) => onMoveItem?.(from, to),
    [onMoveItem],
  );
  const world = useMemo(
    () => ({
      over: (
        over: { held: { instance: ItemInstance; from: SlotRef }; point: { x: number; y: number } } | null,
      ) =>
        onDragOverWorld?.(
          over
            ? {
                from: over.held.from,
                tileId: over.held.instance.tileId,
                x: over.point.x,
                y: over.point.y,
              }
            : null,
        ),
      drop: (
        held: { instance: ItemInstance; from: SlotRef },
        point: { x: number; y: number },
      ) => onDropOnWorld?.(held.from, point),
    }),
    [onDragOverWorld, onDropOnWorld],
  );
  /**
   * Whether each panel is open, or null while nobody has said.
   *
   * Null rather than a boolean seeded from the device, because the device is not
   * known on the server: {@link useCoarsePointer} answers false until hydration,
   * so a phone seeded at construction would come up with both panels open and
   * stay that way. Left null, the default *follows* the pointer until the player
   * expresses a preference, and from then on it is theirs.
   *
   * Open by default with a mouse, closed with a thumb: a desktop has room beside
   * the game and a phone does not, where an open panel costs the arrows.
   */
  const [equipmentOpen, setEquipmentOpen] = useState<boolean | null>(null);
  const [bagOpen, setBagOpen] = useState<boolean | null>(null);
  const showEquipment = equipmentOpen ?? !coarse;
  const showBag = bagOpen ?? !coarse;

  /**
   * On a phone the two panels want the same space, so opening one closes the
   * other. With a mouse they stack in the column beside the game and are
   * genuinely independent.
   */
  const openEquipment = (open: boolean) => {
    setEquipmentOpen(open);
    if (open && coarse) setBagOpen(false);
  };
  const openBag = (open: boolean) => {
    setBagOpen(open);
    if (open && coarse) setEquipmentOpen(false);
  };

  /**
   * A tap on a slot, which uses what is in it.
   *
   * Here rather than in a panel because the two things a use can be land in two
   * different places: opening a bag is this component's own state, and wielding
   * a sword is a move that goes all the way to the server. What each item is
   * *for* is neither of those — it is `../game/itemUse`, asked once, so a tap and
   * the label describing that tap cannot come to disagree.
   */
  const runItemUse = (slot: SlotRef, instance: ItemInstance) => {
    const use = itemUseFor(instance, slot, tilesById);
    if (!use) return;
    // Shut it if it is open: the same press, both ways, because a bag is
    // somewhere you look into rather than something you switch on.
    if (use.type === "open") openBag(!showBag);
    // Refused moves simply do nothing — your hand is full, or your bag is — and
    // the rules that refuse them are the ones the drag asks. There is no second
    // opinion here to drift from them.
    else move(slot, use.to);
  };

  const drag = useItemDrag({
    canMove: canMoveItem,
    onMove: move,
    onUse: runItemUse,
    world,
  });

  /** A panel is covering the arrows and the list. Only ever true on a phone. */
  const panelCoversMain =
    coarse && (showEquipment || showBag || openedContainer != null);
  const press = useCallback(onDirectionPress, [onDirectionPress]);
  const release = useCallback(onDirectionRelease, [onDirectionRelease]);
  const noteTyping = useCallback(
    (typing: boolean) => onTypingChange?.(typing),
    [onTypingChange],
  );

  const list = (
    <InteractionList
      options={interactions}
      tiles={tiles}
      tilesets={tilesets}
      attacking={attacking}
      onAct={(option) => {
        // Opening is the one row that never reaches the session: a container's
        // contents are already here, riding on its placement, so looking inside
        // is a panel and not a request. Everything else is the board's business.
        //
        // One row, both ways: it says "Close" and reads as lit while that box is
        // the open one, so pressing it again is what shuts it.
        if (option.action === "open") {
          onOpenContainer?.(option.active ? null : option.ref);
          return;
        }
        onInteract?.(option);
      }}
      // Not on a finger. A touch browser synthesises a mouse-enter on tap and
      // never sends the matching leave, so the outline it lit would stay lit
      // over whatever the player did next.
      onHover={coarse ? undefined : onHoverInteraction}
      className="min-h-0 w-full flex-1"
    />
  );

  /**
   * The modes, in whichever size the hand reaching for them wants.
   *
   * One row on both devices and in the same order, so the thing you learned on
   * a phone is where you left it on a desktop. What differs is only where the
   * row sits: above the list on a desktop, and up under the game beside the
   * talk button on a phone, where a thumb can reach it without crossing the
   * arrows.
   */
  const hasModes = Boolean(onLookingChange || onAttackingChange);
  const modes = (size: ModeToggleSize) => (
    <>
      {onLookingChange ? (
        <LookToggle looking={looking} onChange={onLookingChange} size={size} />
      ) : null}
      {onAttackingChange ? (
        <AttackToggle
          attacking={attacking}
          onChange={onAttackingChange}
          size={size}
        />
      ) : null}
      {/* Ruled off from the modes beside them, because they are a different
          kind of button: the two on the left change what a tap on the world
          means, and these two only open something. */}
      <span className="h-8 w-px shrink-0 bg-paper/20" aria-hidden="true" />
      <EquipmentToggle
        open={showEquipment}
        onChange={openEquipment}
        size={size}
      />
      <BagButton
        bag={equipment.bag}
        open={showBag}
        onChange={openBag}
        tilesById={tilesById}
        drag={drag}
        size={size}
      />
    </>
  );

  /**
   * The panels, stacked in whatever space the device gives them.
   *
   * One definition for both layouts: on a desktop this sits in the column beside
   * the game, on a phone it takes the main area over. Drawing them twice and
   * hiding one copy would put two "Bag" headings in the page, which is a lie to
   * anything reading it aloud.
   */
  const panels = (
    <>
      {showEquipment ? (
        <EquipmentPanel
          equipment={equipment}
          bagOpen={showBag}
          tiles={tiles}
          tilesets={tilesets}
          drag={drag}
        />
      ) : null}
      {showBag ? (
        <ContainerPanel
          container={equipment.bag}
          location={{ kind: "bag" }}
          tiles={tiles}
          tilesets={tilesets}
          title="Bag"
          onClose={() => openBag(false)}
          drag={drag}
        />
      ) : null}
      {/* Whatever is on the floor, under whatever is on your back, so the two
          read in the order you would move things between them. Titled by the
          tile rather than "Container", because "Chest" and "Basic Bag" is the
          only thing on screen saying which one you opened. */}
      {openedContainer ? (
        <ContainerPanel
          container={openedContainer.instance}
          location={{ kind: "ground", ref: openedContainer.ref }}
          tiles={tiles}
          tilesets={tilesets}
          title={
            tilesById[openedContainer.instance.tileId]?.name ?? "Container"
          }
          onClose={() => onOpenContainer?.(null)}
          drag={drag}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex h-full w-full bg-ink">
      <DragLayer drag={drag} tilesById={tilesById} tilesets={tilesets} />
      <div
        className="flex h-full min-w-0 flex-1 touch-manipulation flex-col items-center select-none"
        style={{
          // A double-tap on a control is a double-tap-to-select gesture as far as
          // the browser is concerned, and dragging from it extends the selection.
          // With nothing selectable under the finger it reaches for the nearest
          // text that is — the chrome above — so the whole surface has to opt out,
          // not just the buttons: the gaps between them are where a fast thumb
          // actually lands. `touch-manipulation` drops the double-tap zoom that
          // rides along with it, while leaving pinch zoom alone.
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <div
          // Square by ratio and allowed to shrink, rather than taking every
          // pixel of free height. Both halves are what hands the leftover to
          // the controls underneath: on a phone the game is bound by the *width*
          // and everything below the square used to be dead space inside this
          // box, which is precisely the room the interaction list wants. Shrink
          // is what keeps a rotated phone honest — the box gives height back
          // when there is not enough to be square in, and `100cqmin` letterboxes
          // the game inside whatever is left.
          className="flex w-full min-h-0 shrink aspect-square items-center justify-center overflow-hidden"
          // Sized container so the square below can be stated in terms of the
          // box's shorter edge. The ratio alone cannot do this: it is the box
          // that is square, and a shrunk box is not.
          style={{ containerType: "size" }}
        >
          <div
            className="relative"
            style={{ width: "100cqmin", height: "100cqmin" }}
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none"
              style={{ imageRendering: "pixelated" }}
            />
            {/* Sized and positioned by app.css; the render loop writes into it. */}
            <div ref={labelRef} className="world-label-layer" />
          </div>
        </div>

        {coarse && (onSay || hasModes) ? (
          // Everything a tap can mean, in one row directly under the world it
          // applies to: say something, look at something, fight something. The
          // field itself hides behind the button — it was a permanent row for
          // something used in bursts, and on a phone that row is the game's.
          <div className="flex w-full shrink-0 items-center gap-2 px-3 py-2">
            {onSay ? (
              <ChatButton onSay={onSay} onTypingChange={noteTyping} />
            ) : null}
            {modes("touch")}
          </div>
        ) : onSay ? (
          <ChatBar onSay={onSay} onTypingChange={noteTyping} />
        ) : null}

        {coarse && panelCoversMain ? (
          // A panel takes the whole main area — the arrows and the list both go.
          // The button row above it stays, which is the point: the thing that
          // opened this is still under the thumb that opened it, so getting back
          // to walking is one tap and never a hunt.
          <div className="flex w-full min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 pb-3">
            {panels}
          </div>
        ) : coarse ? (
          // Reading hand on the left, walking thumb on the right. The arrows go
          // to the side most thumbs are, and the list of what is in reach — the
          // thing you *read* before acting — sits on the other, out from under
          // the hand that is steering.
          <div className="flex w-full min-h-0 flex-1 items-stretch gap-3 px-3 pb-3">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col items-start gap-2">
              {list}
            </div>
            <div className="flex shrink-0 items-center">
              <DirectionPad onPress={press} onRelease={release} />
            </div>
          </div>
        ) : null}
      </div>

      {coarse ? null : (
        <aside
          className="flex h-full shrink-0 flex-col gap-2 border-l-2 border-paper/20 p-2"
          style={{ width: INTERACTION_PANEL_WIDTH_PX }}
        >
          {/* Modes above the list and ruled off from it, because they are a
              different kind of thing: the rows below say what you could do to
              one particular object, and these say what doing anything means. */}
          {hasModes ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b-2 border-paper/20 pb-2">
              {modes("compact")}
            </div>
          ) : null}
          {/* Under the buttons that open them and above the list, so the column
              reads top to bottom as: what a tap means, what you have, what is
              in reach. `shrink-0` because the list below is the thing that
              should give up room when the window is short — a panel that
              squashed would lose slots off the bottom with nothing saying so. */}
          {showEquipment || showBag ? (
            <div className="flex shrink-0 flex-col gap-2 border-b-2 border-paper/20 pb-2">
              {panels}
            </div>
          ) : null}
          {list}
        </aside>
      )}
    </div>
  );
}
