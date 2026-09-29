import { IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { flushSync } from "react-dom";
import type { Shot } from "./content";
import { usePlayback } from "./playback";

const MORPH_NAME = "home-lightbox-picture";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const ICON_PX = 20;

/** A horizontal drag at least this long, and longer than it is tall, turns the page. */
const SWIPE_MIN_PX = 48;

/**
 * Runs `change` inside a view transition in which `thumb` and the lightbox's
 * picture are the same element, so one grows out of the other. `thumb` wears
 * the shared name on whichever side of the change it is visible: before it
 * when opening, after it when closing.
 */
export function morphThumbnail(
  thumb: HTMLElement | null,
  direction: "open" | "close",
  change: () => void,
) {
  const still = window.matchMedia(REDUCED_MOTION).matches;
  if (!thumb || still || !document.startViewTransition || !inView(thumb)) {
    change();
    return;
  }
  const opening = direction === "open";
  if (opening) thumb.style.viewTransitionName = MORPH_NAME;
  const transition = document.startViewTransition(() => {
    thumb.style.viewTransitionName = opening ? "" : MORPH_NAME;
    flushSync(change);
  });
  const clear = () => {
    thumb.style.viewTransitionName = "";
  };
  void transition.finished.then(clear, clear);
}

function inView(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}

export function Lightbox({
  shots,
  index,
  onStep,
  onClose,
}: {
  shots: Shot[];
  index: number | null;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  const { playing } = usePlayback();
  const shot = index === null ? null : shots[index];

  /**
   * A layout effect, not a passive one: `morphThumbnail` opens and closes this inside a
   * view transition's update callback, which has to leave the dialog in its
   * new state by the time it returns.
   */
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (shot && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    }
    if (!shot && dialog.open) dialog.close();
  }, [shot]);

  /**
   * Paging replaces the picture, and a video that had the focus takes it away
   * with it, which would leave the arrow keys talking to the page behind.
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open || dialog.contains(document.activeElement)) return;
    closeRef.current?.focus();
  }, [shot]);

  /** A focused video's own controls seek with the arrow keys, so they are left to it. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLMediaElement) return;
    if (event.key === "ArrowLeft") onStep(-1);
    if (event.key === "ArrowRight") onStep(1);
  };

  /**
   * A second finger makes it a pinch, and a drag while zoomed in is looking
   * around the picture, so neither turns the page.
   */
  const onPointerDown = (event: PointerEvent) => {
    swipeFrom.current = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
  };

  const onPointerUp = (event: PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    const zoomedIn = (window.visualViewport?.scale ?? 1) > 1;
    if (!from || !event.isPrimary || zoomedIn) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
    onStep(dx > 0 ? -1 : 1);
  };

  return (
    <dialog
      ref={dialogRef}
      className="home-lightbox"
      aria-label="Pictures"
      aria-describedby={shot ? captionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      {shot && index !== null ? (
        <figure
          className="home-lightbox-figure"
          style={{ "--picture-width": `${shot.width}px` }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            swipeFrom.current = null;
          }}
        >
          <LightboxMedia key={shot.id} shot={shot} autoPlay={playing} />
          <figcaption
            id={captionId}
            className="home-lightbox-caption"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>{shot.caption}</span>
            <span className="home-lightbox-count">
              <span className="sr-only">Picture </span>
              {index + 1}
              <span aria-hidden="true"> / </span>
              <span className="sr-only"> of </span>
              {shots.length}
            </span>
          </figcaption>
        </figure>
      ) : null}
      <button
        ref={closeRef}
        type="button"
        className="home-lightbox-button home-lightbox-close"
        onClick={onClose}
        aria-label="Close"
      >
        <IconX size={ICON_PX} stroke={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="home-lightbox-button home-lightbox-prev"
        onClick={() => onStep(-1)}
        aria-label="Previous picture"
      >
        <IconChevronLeft size={ICON_PX} stroke={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="home-lightbox-button home-lightbox-next"
        onClick={() => onStep(1)}
        aria-label="Next picture"
      >
        <IconChevronRight size={ICON_PX} stroke={2} aria-hidden="true" />
      </button>
    </dialog>
  );
}

function LightboxMedia({ shot, autoPlay }: { shot: Shot; autoPlay: boolean }) {
  const pixelated = shot.pixelated ? "pixelated" : "";
  const shared = { viewTransitionName: MORPH_NAME };
  if (shot.video) {
    return (
      <video
        className={`home-lightbox-media ${pixelated}`}
        style={shared}
        src={shot.video}
        poster={shot.src}
        width={shot.width}
        height={shot.height}
        autoPlay={autoPlay}
        controls
        muted
        loop
        playsInline
        aria-label={shot.alt}
      />
    );
  }
  return (
    <img
      className={`home-lightbox-media ${pixelated}`}
      style={shared}
      src={shot.src}
      alt={shot.alt}
      width={shot.width}
      height={shot.height}
      decoding="async"
    />
  );
}
