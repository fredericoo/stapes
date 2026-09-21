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
