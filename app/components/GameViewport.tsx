import { useCallback, useEffect, useMemo, useState } from "react";
import type { ObjectRef } from "../game/affordances";
import type { Equipment } from "../game/equipment";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import { emptyEquipment } from "../game/equipment";
import type { InteractionOption } from "../game/interactionOptions";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import type { CastSlot, SpellButton } from "../game/casting";
import type { CraftingWindow } from "../game/craft";
import { itemUseFor } from "../game/itemUse";
import type { ItemInstance } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import { NO_VITALS, type Vitals } from "../game/GameSession";
import type { Direction, TileDef, TilesetDef } from "../lib/types";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { AppMenuButton } from "./AppShell";
import { ChatBar, ChatButton } from "./ChatBar";
import { ContainerPanel } from "./ContainerPanel";
import { DirectionPad, PAD_SIZE_PX } from "./DirectionPad";
import { EquipmentPanel } from "./EquipmentPanel";
import { DragLayer } from "./DragLayer";
import { ConversationPanel } from "./ConversationPanel";
import { CraftPanel } from "./CraftPanel";
import { InteractionList } from "./InteractionList";
import type { ActionButtonSize } from "./actionButton";
import { SpellBar } from "./SpellBar";
import { BagButton, EquipmentToggle, StatsToggle } from "./PanelToggle";
import { PvpToggle } from "./PvpToggle";
import { StatsPanel } from "./StatsPanel";
import type { ActiveStatus, StatusDef } from "../lib/status";
import { StatusStrip } from "./StatusStrip";
import { useItemDrag } from "./useItemDrag";
import { useNoZoom } from "./useNoZoom";

const NO_STATUSES: ActiveStatus[] = [];

const NO_STATUS_DEFS: Record<string, StatusDef> = {};

const NO_SPELLS: SpellButton[] = [];

const INTERACTION_PANEL_WIDTH_PX = 224;

const INTERACTION_LIST_MIN_WIDTH_PX = 168;

export function GameViewport({
  canvasRef,
  labelRef,
  onDirectionPress,
  onDirectionRelease,
  onSay,
  onPvp,
  onTypingChange,
  readouts,
  interactions = [],
  onInteract,
  conversation = null,
  onTalk,
  crafting = null,
  onCraft,
  onCloseCrafting,
  onHoverInteraction,
  equipment = emptyEquipment(),
  masteryXp = {},
  vitals = NO_VITALS,
  statuses = NO_STATUSES,
  statusDefs = NO_STATUS_DEFS,
  openedContainer = null,
  onOpenContainer,
  canMoveItem = () => false,
  onMoveItem,
  onConsumeItem,
  onDragOverWorld,
  onDropOnWorld,
  spells = NO_SPELLS,
  onCast,
  onStopCast,
  tiles = [],
  tilesets = [],
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  labelRef?: React.RefObject<HTMLDivElement | null>;
  onDirectionPress: (direction: Direction) => void;
  onDirectionRelease: (direction: Direction) => void;
  onSay?: (text: string) => void;
  onPvp?: (on: boolean) => void;
  onTypingChange?: (typing: boolean) => void;
  readouts?: React.ReactNode;
  interactions?: InteractionOption[];
  onInteract?: (option: InteractionOption) => void;
  conversation?: Conversation | null;
  onTalk?: (action: TalkAction) => void;
  crafting?: CraftingWindow | null;
  onCraft?: (ref: ObjectRef, recipeIndex: number) => void;
  onCloseCrafting?: () => void;
  onHoverInteraction?: (optionId: string | null) => void;
  equipment?: Equipment;
  masteryXp?: MasteryXp;
  vitals?: Vitals;
  statuses?: ActiveStatus[];
  statusDefs?: Record<string, StatusDef>;
  openedContainer?: OpenedContainer | null;
  onOpenContainer?: (ref: ObjectRef | null) => void;
  canMoveItem?: (from: SlotRef, to: SlotRef) => boolean;
  onMoveItem?: (from: SlotRef, to: SlotRef) => void;
  onConsumeItem?: (slot: SlotRef) => void;
  onDragOverWorld?: (drag: { from: SlotRef; tileId: string; x: number; y: number } | null) => void;
  onDropOnWorld?: (from: SlotRef, point: { x: number; y: number }) => void;
  spells?: SpellButton[];
  onCast?: (slot: CastSlot) => void;
  onStopCast?: () => void;
  tiles?: TileDef[];
  tilesets?: TilesetDef[];
}) {
  const coarse = useCoarsePointer();
  useNoZoom(coarse);
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  const move = useCallback((from: SlotRef, to: SlotRef) => onMoveItem?.(from, to), [onMoveItem]);
  const cast = useCallback((slot: CastSlot) => onCast?.(slot), [onCast]);
  const stopCast = useCallback(() => onStopCast?.(), [onStopCast]);
  const world = useMemo(
    () => ({
      over: (
        over: {
          held: { instance: ItemInstance; from: SlotRef };
          point: { x: number; y: number };
        } | null,
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
      drop: (held: { instance: ItemInstance; from: SlotRef }, point: { x: number; y: number }) =>
        onDropOnWorld?.(held.from, point),
    }),
    [onDragOverWorld, onDropOnWorld],
  );
  /**
   * Null rather than a boolean seeded from the device, because the device is
   * not known on the server: `useCoarsePointer` answers false until hydration,
   * so a phone seeded at construction would come up with both panels open and
   * stay that way. Left null, the default follows the pointer until the player
   * expresses a preference.
   */
  const [equipmentOpen, setEquipmentOpen] = useState<boolean | null>(null);
  const [bagOpen, setBagOpen] = useState<boolean | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [openHand, setOpenHand] = useState<"weapon" | "offhand" | null>(null);
  const showEquipment = equipmentOpen ?? !coarse;
  const showBag = bagOpen ?? !coarse;
  const showStats = statsOpen;
  const heldContainer = openHand ? (equipment[openHand] ?? null) : null;

  const panelsHidden = coarse && (conversation != null || crafting != null);
  const shutWhatHidesPanels = () => {
    if (conversation) onTalk?.({ kind: "close" });
    if (crafting) onCloseCrafting?.();
  };

  const openEquipment = (pressed: boolean) => {
    const open = pressed || panelsHidden;
    setEquipmentOpen(open);
    if (open && coarse) {
      setBagOpen(false);
      setStatsOpen(false);
      shutWhatHidesPanels();
    }
  };
  const openBag = (pressed: boolean) => {
    const open = pressed || panelsHidden;
    setBagOpen(open);
    if (open && coarse) {
      setEquipmentOpen(false);
      setStatsOpen(false);
      shutWhatHidesPanels();
    }
  };
  const openStats = (pressed: boolean) => {
    const open = pressed || panelsHidden;
    setStatsOpen(open);
    if (open && coarse) {
      setEquipmentOpen(false);
      setBagOpen(false);
      shutWhatHidesPanels();
    }
  };

  const runItemUse = (slot: SlotRef, instance: ItemInstance) => {
    const use = itemUseFor(instance, slot, tilesById, equipment);
    if (!use) return;
    if (use.type === "open") {
      if (slot.kind === "bag") openBag(!showBag);
      else if (slot.kind === "weapon" || slot.kind === "offhand") {
        setOpenHand(openHand === slot.kind ? null : slot.kind);
      }
    } else if (use.type === "consume") onConsumeItem?.(slot);
    else move(slot, use.to);
  };

  const drag = useItemDrag({
    canMove: canMoveItem,
    onMove: move,
    onUse: runItemUse,
    world,
  });

  useEffect(() => {
    if (openHand && !equipment[openHand]) setOpenHand(null);
  }, [openHand, equipment]);

  const panelCoversList =
    coarse &&
    (showEquipment || showBag || showStats || heldContainer != null || openedContainer != null);
  const press = useCallback(onDirectionPress, [onDirectionPress]);
  const release = useCallback(onDirectionRelease, [onDirectionRelease]);
  const noteTyping = useCallback((typing: boolean) => onTypingChange?.(typing), [onTypingChange]);

  const talkPanel = conversation ? (
    <ConversationPanel
      conversation={conversation}
      tiles={tiles}
      tilesets={tilesets}
      equipment={equipment}
      masteryXp={masteryXp}
      statusDefs={statusDefs}
      onTalk={(action) => onTalk?.(action)}
      hotkeys
      className="scrolls-past-toolbar min-h-0 w-full flex-1"
    />
  ) : null;

  const craftPanel = crafting ? (
    <CraftPanel
      crafting={crafting}
      tiles={tiles}
      tilesets={tilesets}
      onCraft={(recipeIndex) => onCraft?.(crafting.ref, recipeIndex)}
      onClose={() => onCloseCrafting?.()}
      hotkeys
      className="scrolls-past-toolbar min-h-0 w-full flex-1"
    />
  ) : null;
  const replacesList = talkPanel ?? craftPanel;

  const list = (
    <InteractionList
      options={interactions}
      tiles={tiles}
      tilesets={tilesets}
      onAct={(option) => {
        if (option.action === "open") {
          onOpenContainer?.(option.active ? null : option.ref);
          return;
        }
        onInteract?.(option);
      }}
      onHover={coarse ? undefined : onHoverInteraction}
      hotkeys
      className="scrolls-past-toolbar min-h-0 w-full flex-1"
    />
  );

  const panelButtons = (size: ActionButtonSize) => (
    <>
      {onPvp ? (
        <>
          <PvpToggle
            on={vitals.pvp.on}
            changeable={vitals.pvp.changeable}
            onChange={onPvp}
            size={size}
          />
          <span className="h-8 w-px shrink-0 bg-paper/20" aria-hidden="true" />
        </>
      ) : null}
      <StatsToggle open={showStats} onChange={openStats} size={size} />
      <EquipmentToggle
        open={showEquipment}
        onChange={openEquipment}
        equipment={equipment}
        tilesById={tilesById}
        drag={drag}
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
      <AppMenuButton size={size} />
    </>
  );

  const panels = (
    <>
      {showStats ? (
        <StatsPanel
          vitals={vitals}
          masteryXp={masteryXp}
          statuses={statuses}
          tilesets={tilesets}
          scrolls={!coarse}
        />
      ) : null}
      {showEquipment ? (
        <EquipmentPanel
          equipment={equipment}
          masteryXp={masteryXp}
          statusDefs={statusDefs}
          bagOpen={showBag}
          handOpen={heldContainer ? openHand : null}
          tiles={tiles}
          tilesets={tilesets}
          drag={drag}
        />
      ) : null}
      {showBag && equipment.bag ? (
        <ContainerPanel
          container={equipment.bag}
          location={{ kind: "bag" }}
          equipment={equipment}
          tiles={tiles}
          tilesets={tilesets}
          title="Bag"
          onClose={() => openBag(false)}
          drag={drag}
          masteryXp={masteryXp}
          statusDefs={statusDefs}
        />
      ) : null}
      {heldContainer && openHand ? (
        <ContainerPanel
          container={heldContainer}
          location={{ kind: "hand", hand: openHand }}
          equipment={equipment}
          tiles={tiles}
          tilesets={tilesets}
          title={tilesById[heldContainer.tileId]?.name ?? "Container"}
          onClose={() => setOpenHand(null)}
          drag={drag}
          masteryXp={masteryXp}
          statusDefs={statusDefs}
        />
      ) : null}
      {openedContainer ? (
        <ContainerPanel
          container={openedContainer.instance}
          location={{ kind: "ground", ref: openedContainer.ref }}
          equipment={equipment}
          tiles={tiles}
          tilesets={tilesets}
          title={tilesById[openedContainer.instance.tileId]?.name ?? "Container"}
          onClose={() => onOpenContainer?.(null)}
          drag={drag}
          masteryXp={masteryXp}
          statusDefs={statusDefs}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex h-full w-full bg-ink">
      <DragLayer drag={drag} tilesById={tilesById} tilesets={tilesets} />
      <div
        className="flex h-full min-w-0 flex-1 touch-pan-y flex-col items-center select-none"
        style={{
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <div
          className="flex w-full min-h-0 shrink aspect-square items-center justify-center overflow-hidden"
          style={{ containerType: "size" }}
        >
          <div className="relative" style={{ width: "100cqmin", height: "100cqmin" }}>
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none"
              style={{ imageRendering: "pixelated" }}
            />
            <div ref={labelRef} className="world-label-layer" />
          </div>
        </div>

        {coarse ? (
          <div className="flex w-full shrink-0 items-center gap-2 px-3 py-2">
            {onSay ? (
              <>
                <ChatButton onSay={onSay} onTypingChange={noteTyping} />
                <span className="h-8 w-px shrink-0 bg-paper/20" aria-hidden="true" />
              </>
            ) : null}
            {panelButtons("touch")}
          </div>
        ) : onSay ? (
          <ChatBar onSay={onSay} onTypingChange={noteTyping} />
        ) : null}

        {coarse ? (
          <div className="flex w-full min-h-0 flex-1 items-stretch gap-3 px-3">
            <div
              className="flex min-h-0 flex-1 flex-col items-start gap-2"
              style={{ minWidth: INTERACTION_LIST_MIN_WIDTH_PX }}
            >
              {replacesList ??
                (panelCoversList ? (
                  <div className="scrolls-past-toolbar flex w-full min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
                    {panels}
                  </div>
                ) : (
                  list
                ))}
            </div>
            <div
              className="flex min-w-0 shrink flex-col items-center pb-3"
              style={{
                flexBasis: PAD_SIZE_PX,
                marginBottom: "max(env(safe-area-inset-bottom), calc(100lvh - 100dvh))",
              }}
            >
              <StatusStrip statuses={statuses} interactive={false} tilesets={tilesets} />
              <div className="flex w-full min-h-0 flex-1 flex-col gap-2">
                <SpellBar
                  spells={spells}
                  onCast={cast}
                  onStopCast={stopCast}
                  tilesById={tilesById}
                  tilesets={tilesets}
                  className="justify-center"
                />
                <div className="mt-auto flex w-full justify-center">
                  <DirectionPad onPress={press} onRelease={release} />
                </div>
              </div>
              {readouts ? (
                <div className="flex w-full shrink-0 items-center justify-end gap-2 pt-1">
                  {readouts}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {coarse ? null : (
        <aside
          className="flex h-full shrink-0 flex-col gap-2 border-l-2 border-paper/20 p-2"
          style={{ width: INTERACTION_PANEL_WIDTH_PX }}
        >
          <div className="flex shrink-0 flex-col gap-2 border-b-2 border-paper/20 pb-2">
            {readouts ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2">{readouts}</div>
            ) : null}
            <StatusStrip statuses={statuses} interactive tilesets={tilesets} />
          </div>
          <div className="flex shrink-0 items-center gap-1 border-b-2 border-paper/20 pb-2">
            {panelButtons("compact")}
          </div>
          {spells.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1 border-b-2 border-paper/20 pb-2">
              <SpellBar
                spells={spells}
                onCast={cast}
                onStopCast={stopCast}
                tilesById={tilesById}
                tilesets={tilesets}
                className="max-w-40"
              />
            </div>
          ) : null}
          {showEquipment || showBag ? (
            <div className="flex shrink-0 flex-col gap-2 border-b-2 border-paper/20 pb-2">
              {panels}
            </div>
          ) : null}
          {replacesList ?? list}
        </aside>
      )}
    </div>
  );
}
