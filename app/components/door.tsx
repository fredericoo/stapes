import type { ComponentProps, ReactNode } from "react";

/**
 * The furniture of the screens that stand in front of the world.
 *
 * Sign in, make an account, pick a character: three screens that are all the
 * same screen, drawn before the app's own faces have downloaded and before
 * there is a canvas to put anything on. They do not use `../ui` — those
 * components are built for the paper surfaces the editor is made of, and every
 * one of them would need overriding to sit on this one.
 *
 * **Set in a font that is already on the machine.** Both of the page's faces
 * are downloads, and this is the first thing anybody sees; a door that reflows
 * when IBM Plex arrives is a door that looked broken for a second.
 * @see ./LoadingScreen, which makes the same choice for the same reason.
 */

export const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** The dark full-screen surface every door is drawn on. */
export function Door({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-ink p-6"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      {children}
    </div>
  );
}

/**
 * The wordmark, over the door.
 *
 * **Drawn at a whole multiple of its own 263x104, never between.** The artwork
 * is pixel art in the same sense the tilesets are — 16 colours, and every pixel
 * either fully opaque or fully clear — so `pixelated` reproduces it exactly and
 * a fractional width would not: scaling a pixel grid by a fraction gives a grid
 * of unequal pixels, which is the artefact `pixelated` exists to avoid.
 *
 * So two sizes rather than a fluid one: 526px is 2x and is the size this is
 * meant to be seen at, and 263px is 1x for the screens 2x does not fit on. The
 * breakpoint is that arithmetic and nothing else — 526 plus `Door`'s 24px of
 * padding on each side is 574.
 *
 * `max-w-full` is a guard rather than a size. 1x fits down to a 320px viewport,
 * narrower than anything still being sold; below that, shrinking beats a page
 * that scrolls sideways.
 *
 * `width` and `height` are the file's own, so the box is reserved before the
 * image arrives — `door.tsx` avoids downloaded faces because of the reflow they
 * cause, and an image with no known ratio moves the form down the page when it
 * lands.
 */
export function DoorLogo() {
  return (
    <img
      src="/logo.png"
      // The artwork is the name drawn out, so the name is what it is worth
      // announcing: without this, a screen reader meets an unlabelled image
      // where the title of the game is.
      alt="The Last Stones"
      width={263}
      height={104}
      className="w-[263px] max-w-full min-[574px]:w-[526px]"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

export function DoorTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-xs uppercase tracking-widest text-paper/60">{children}</h1>;
}

export function DoorField({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className="flex w-full flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-paper/60">{label}</span>
      {/* 16px, because Safari on iOS zooms the page in when it focuses a field
          set smaller and never zooms back out — see `docs/notes.md`, "A field
          the phone focuses has to be 16px". This is the first field in the app
          anybody meets, so it is the one that failure would be noticed on. */}
      <input
        className="border-2 border-paper/40 bg-transparent px-3 py-2 text-base text-paper placeholder:text-paper/30 focus:border-paper focus:outline-none disabled:opacity-50"
        style={{ fontFamily: SYSTEM_MONO }}
        {...props}
      />
    </label>
  );
}

export function DoorButton({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={`border-2 border-paper px-6 py-3 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-paper ${className}`}
      style={{ fontFamily: SYSTEM_MONO }}
      {...props}
    />
  );
}

/**
 * Why the last press did not work.
 *
 * An alert rather than a status: it is the answer to a press, and a press that
 * appeared to do nothing is exactly what this has to explain.
 */
export function DoorError({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-sm text-xs leading-relaxed text-paper/70" role="alert">
      {children}
    </p>
  );
}

/** A quiet line under a form — a rule, or a way to the other screen. */
export function DoorNote({ children }: { children: ReactNode }) {
  return <p className="max-w-sm text-center text-xs leading-relaxed text-paper/40">{children}</p>;
}
