import { Popover } from "@base-ui/react/popover";
import { IconMenu2, IconSettings } from "@tabler/icons-react";
import { createContext, useContext, useState } from "react";
import { NavLink } from "react-router";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./ModeSwitch";
import { Tooltip } from "../ui/Tooltip";

/**
 * The header, which on a phone is mostly in the way.
 *
 * The destinations and a lighting switch are worth their room on a desktop and
 * are not on a 375px screen: they wrapped the bar onto a second and third line,
 * and every one of those lines came out of the game underneath. So below the
 * breakpoint the whole set folds into one button.
 *
 * On a page that has somewhere better to put that button, the bar goes entirely
 * — see {@link menuInPage}. A phone playing the game has one screen of room and
 * every row of it is either the world or a control; a header holding a wordmark,
 * a hamburger and a clock was a row that was neither, and the clock and the menu
 * both had a home nearer the thumb that wanted them.
 *
 * The breakpoint is the window's *width* and not the pointer, unlike the
 * on-screen arrows: a header is a layout problem, and a desktop window dragged
 * narrow has the same problem a phone does. It is stated the narrow way round
 * because the server answers every media query with false — see
 * {@link useMediaQuery} — so a phone briefly renders the wide header and folds
 * it on hydration, rather than a desktop rendering a hamburger it never needed.
 */

/** Tailwind's `md`, below which the nav folds away. */
const NARROW_VIEWPORT = "(max-width: 767px)";

const DESTINATIONS: { to: string; label: string }[] = [
  { to: "/tiles", label: "Tiles" },
  { to: "/statuses", label: "Statuses" },
  { to: "/map", label: "Map" },
  { to: "/play", label: "Play" },
  { to: "/arena", label: "Arena" },
  { to: "/online", label: "Online" },
  { to: "/voxel", label: "Voxel" },
];

function linkClass(isActive: boolean, block: boolean): string {
  return [
    "border-2 px-2 py-1 text-xs font-medium",
    block ? "block w-full" : "",
    isActive
      ? "border-paper bg-paper text-ink"
      : "border-paper/40 text-paper hover:border-paper",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * What the shell would have put in its menu, for a page that is drawing that
 * menu itself.
 *
 * Context rather than a second prop back down through the page, because the
 * alternative is the route handing the same node to two components and hoping
 * they never both render it. Here there is one definition and one drawing of it,
 * wherever it ends up: the header on a wide window, and the game's own row of
 * controls on a narrow one.
 */
const AppMenuExtras = createContext<React.ReactNode>(null);

/**
 * The menu's contents: where you can go, and the switches that ride with the
 * navigation rather than with the view.
 *
 * One definition for both the header's hamburger and the game's settings button,
 * so a destination added here reaches every way in.
 */
function AppMenuPopup({
  extras,
  onNavigate,
}: {
  extras: React.ReactNode;
  onNavigate: () => void;
}) {
  return (
    // Wide enough for the widest thing that folds in here — the time scrubber
    // with its caption and pause box — so the extras keep the one-line shape
    // they have in the header.
    <Popover.Popup className="z-50 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 border-2 border-border bg-ink p-2 text-paper shadow-hard">
      <nav className="flex flex-col gap-1">
        {DESTINATIONS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            // Closed by hand rather than by the route changing: tapping the
            // destination you are already on navigates nowhere, and a menu that
            // stayed open on it would read as the tap having missed.
            onClick={onNavigate}
            className={({ isActive }) => linkClass(isActive, true)}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {extras ? (
        <div className="flex flex-wrap items-center gap-2 border-t-2 border-paper/20 pt-2">
          {extras}
        </div>
      ) : null}
    </Popover.Popup>
  );
}

/**
 * The way into the menu from inside a page, for a shell that has folded its
 * header away.
 *
 * A cog rather than a hamburger, because what it opens has stopped being a
 * navigation drawer: sat in a row of things that change what a tap does, the
 * three lines would read as a fourth mode. The cog says "everything about the
 * page rather than about the world", which is what is actually behind it.
 *
 * Draws nothing at all on a page whose shell still has its header. Two ways into
 * one menu, both on screen at once, is two things to learn for one destination.
 */
export function AppMenuButton({ size = "touch" }: { size?: ActionButtonSize }) {
  const extras = useContext(AppMenuExtras);
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const [open, setOpen] = useState(false);

  if (!narrow) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Menu">
        <Popover.Trigger
          aria-label="Menu"
          className={[
            "flex items-center justify-center border-2 shadow-hard",
            ACTION_BUTTON_SIZE_CLASS[size],
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            // Lit while it is open, on the same terms every other button in the
            // row is lit: something is claiming your taps and the screen says so.
            "border-paper/40 bg-transparent text-paper data-[popup-open]:border-paper data-[popup-open]:bg-paper data-[popup-open]:text-ink",
          ].join(" ")}
        >
          <IconSettings
            size={size === "touch" ? 24 : 18}
            stroke={2}
            aria-hidden="true"
          />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        {/* Opened upwards from a control near the bottom of the screen, which
            `side` alone would not guarantee on a short phone. */}
        <Popover.Positioner sideOffset={8} side="top" align="end">
          <AppMenuPopup extras={extras} onNavigate={() => setOpen(false)} />
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AppShell({
  children,
  trailing,
  menuExtras,
  menuInPage = false,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
  /**
   * Controls that belong with the navigation rather than with the view: they
   * ride in the header on a wide window and fold into the menu on a narrow one.
   *
   * Rendered in exactly one place either way. Drawing them twice and hiding one
   * copy with a breakpoint would be simpler and would leave two switches with
   * the same name in the page, which is a lie to anything reading it aloud.
   */
  menuExtras?: React.ReactNode;
  /**
   * This page draws the menu itself, so on a narrow window the bar goes away
   * entirely rather than folding.
   *
   * Opt-in per page, and deliberately not the default: it costs the page a
   * {@link AppMenuButton} somewhere a thumb can reach, and a route that took the
   * header away without drawing one would leave a phone with no way out of it.
   * The editors keep their hamburger for exactly that reason.
   */
  menuInPage?: boolean;
}) {
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const [menuOpen, setMenuOpen] = useState(false);
  const headerHidden = narrow && menuInPage;

  return (
    <AppMenuExtras.Provider value={menuExtras}>
      <div className="flex h-full flex-col">
        {headerHidden ? null : (
          <header className="flex flex-wrap items-center gap-3 border-b-2 border-border bg-ink px-3 py-2 text-paper">
            <div className="text-sm font-bold tracking-wide uppercase">
              Stapes
            </div>

            {narrow ? (
              <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <Popover.Trigger
                  className="flex items-center gap-1 border-2 border-paper/40 px-2 py-1 text-paper hover:border-paper data-[popup-open]:border-paper data-[popup-open]:bg-paper data-[popup-open]:text-ink"
                  aria-label="Menu"
                >
                  <IconMenu2 size={16} stroke={2} aria-hidden="true" />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner sideOffset={8} align="start">
                    <AppMenuPopup
                      extras={menuExtras}
                      onNavigate={() => setMenuOpen(false)}
                    />
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            ) : (
              <nav className="flex gap-1">
                {DESTINATIONS.map(({ to, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) => linkClass(isActive, false)}
                  >
                    {label}
                  </NavLink>
                ))}
              </nav>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {narrow ? null : menuExtras}
              {trailing}
            </div>
          </header>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </AppMenuExtras.Provider>
  );
}
