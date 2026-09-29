import { IconPlayerPlayFilled } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SHOTS, type Shot, type ShotSpan } from "./content";
import { Lightbox, morphThumbnail } from "./Lightbox";

const SIZES: Record<ShotSpan, string> = {
  big: "(min-width: 1024px) 50vw, 100vw",
  wide: "(min-width: 1024px) 50vw, 100vw",
  one: "(min-width: 1024px) 25vw, 50vw",
};

const PLAY_BADGE_PX = 16;

export function Gallery() {
  const [open, setOpen] = useState<number | null>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const returnFocusTo = useRef<number | null>(null);

  const openAt = useCallback((index: number) => {
    const thumb = thumbs.current[index]?.querySelector("img") ?? null;
    morphThumbnail(thumb, "open", () => setOpen(index));
  }, []);

  const close = useCallback(() => {
    if (open === null) return;
    returnFocusTo.current = open;
    const thumb = thumbs.current[open]?.querySelector("img") ?? null;
    morphThumbnail(thumb, "close", () => setOpen(null));
  }, [open]);

  const step = useCallback((delta: number) => {
    setOpen((index) => (index === null ? null : (index + delta + SHOTS.length) % SHOTS.length));
  }, []);

  /**
   * The dialog hands focus back to the thumbnail that opened it. After paging
   * through, the one worth landing on is the thumbnail of the picture that was
   * showing, so the visitor carries on through the grid from there.
   */
  useEffect(() => {
    if (open !== null || returnFocusTo.current === null) return;
    thumbs.current[returnFocusTo.current]?.focus();
    returnFocusTo.current = null;
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    for (const neighbour of [open - 1, open + 1]) {
      const shot = SHOTS[(neighbour + SHOTS.length) % SHOTS.length];
      if (shot && !shot.video) new Image().src = shot.src;
    }
  }, [open]);

  return (
    <section id="pictures" className="home-gallery" aria-labelledby="pictures-title">
      <h2 id="pictures-title" className="home-pixel home-section-title">
        Pictures
      </h2>
      <ul className="home-gallery-grid" role="list">
        {SHOTS.map((shot, index) => (
          <li key={shot.id} className="home-shot" data-span={shot.span}>
            <button
              ref={(element) => {
                thumbs.current[index] = element;
              }}
              type="button"
              className="home-shot-button"
              onClick={() => openAt(index)}
              aria-haspopup="dialog"
            >
              <Thumbnail shot={shot} />
              <span className="home-shot-caption">
                {shot.video ? <span className="sr-only">Video: </span> : null}
                {shot.caption}
              </span>
              {shot.video ? (
                <span className="home-shot-play" aria-hidden="true">
                  <IconPlayerPlayFilled size={PLAY_BADGE_PX} />
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <Lightbox shots={SHOTS} index={open} onStep={step} onClose={close} />
    </section>
  );
}

function Thumbnail({ shot }: { shot: Shot }) {
  const srcSet = shot.half
    ? `${shot.half} ${shot.width / 2}w, ${shot.src} ${shot.width}w`
    : undefined;
  return (
    <img
      src={shot.half ?? shot.src}
      srcSet={srcSet}
      sizes={SIZES[shot.span]}
      alt=""
      width={shot.width}
      height={shot.height}
      loading="lazy"
      decoding="async"
      className={`home-shot-image ${shot.pixelated ? "pixelated" : ""}`}
    />
  );
}
