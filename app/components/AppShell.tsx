import { Popover } from "@base-ui/react/popover";
import { IconMenu2, IconSettings } from "@tabler/icons-react";
import { createContext, useContext, useState } from "react";
import { NavLink } from "react-router";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./actionButton";
import { Tooltip } from "../ui/Tooltip";

/**
 * The header, which on a phone is mostly in the way.
 *
 * The destinations and a lighting switch are worth their room on a desktop and
 * are not on a 375px screen: they wrapped the bar onto a second and third line,
 * and every one of those lines came out of the game underneath. So below the
 * breakpoint the whole set folds into one button.
 *
 * On a page that has somewhere better to put that button, the bar goes entirely,
 * at every width — see {@link menuInPage}. The game is the one page that does:
 * a header holding a wordmark and a row of readings was a row that was neither
 * world nor control, and on a desktop its readings reflowed the bar every time a
 * number changed width, walking the buttons beside them left and right. One
 * menu behind one cog on both devices means one place to learn.
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

export type Destination = { to: string; label: string };

/**
 * Where the authoring tools are, for the pages that are authoring tools.
 *
 * Not a module-wide list any more, because the game is not one of them: a
 * player's screen offers no way into the tile editor, so the shell only draws
 * navigation for a page that hands it some — see {@link AdminShell}, which is
 * what every page under `/admin` uses.
 */
export const ADMIN_DESTINATIONS: Destination[] = [
  { to: "/admin/tiles", label: "Tiles" },
  { to: "/admin/statuses", label: "Statuses" },
  { to: "/admin/map", label: "Map" },
  { to: "/admin/play", label: "Play" },
  { to: "/admin/arena", label: "Arena" },
  { to: "/admin/voxel", label: "Voxel" },
  { to: "/admin/actions", label: "Actions" },
  // The way back out. The game itself offers no way in here, so this is the
  // only link between the two halves, and it points at the front door.
  { to: "/", label: "Game" },
];

function linkClass(isActive: boolean, block: boolean): string {
  return [
    "border-2 px-2 py-1 text-xs font-medium",
    block ? "block w-full" : "",
    isActive ? "border-paper bg-paper text-ink" : "border-paper/40 text-paper hover:border-paper",
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
 * wherever it ends up: an editor's header, or the game's own row of controls.
 */
const AppMenuContents = createContext<{
  destinations: Destination[];
  extras: React.ReactNode;
  /** Whether the shell has handed its menu to the page, rather than drawing a header. */
  inPage: boolean;
}>({ destinations: [], extras: null, inPage: false });

/**
 * One line of the menu: what it is on the left, the reading or the control on
 * the right.
 *
 * Every entry takes a whole row so the menu reads as a list rather than a
 * paragraph of chips. The row layout used to be `flex-wrap`, which put
 * whatever fitted beside whatever came before it — so a reading that grew by a
 * digit could move the lighting switch onto the next line under the pointer.
 */
export function MenuRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <span className="text-xs uppercase text-paper/70">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * The menu's contents: where you can go, and the switches that ride with the
 * navigation rather than with the view.
 *
 * One definition for both the header's hamburger and the game's settings button,
 * so a destination added here reaches every way in.
 */
function AppMenuPopup({
  destinations,
  extras,
  onNavigate,
}: {
  destinations: Destination[];
  extras: React.ReactNode;
  onNavigate: () => void;
}) {
  return (
    // Wide enough for the widest thing that folds in here — the time scrubber
    // with its caption and pause box — so the extras keep the one-line shape
    // they have in the header.
    <Popover.Popup className="z-50 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 border-2 border-border bg-ink p-2 text-paper shadow-hard">
      {destinations.length === 0 ? null : (
        <nav className="flex flex-col gap-1">
          {destinations.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              // `/` is a prefix of every other path, so without this the game
              // reads as the page you are on from inside the tile editor.
              end={to === "/"}
              // Closed by hand rather than by the route changing: tapping the
              // destination you are already on navigates nowhere, and a menu
              // that stayed open on it would read as the tap having missed.
              onClick={onNavigate}
              className={({ isActive }) => linkClass(isActive, true)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      )}
      {extras ? (
        // The rule separates the switches from the destinations above them, so
        // a menu that is only switches — the game's — does not open with one.
        // A column rather than a wrapping row: each entry is its own line, and
        // is ruled off from the next — see {@link MenuRow}.
        <div
          className={[
            "flex flex-col divide-y-2 divide-paper/10",
            destinations.length === 0 ? "" : "border-t-2 border-paper/20 pt-2",
          ]
            .filter(Boolean)
            .join(" ")}
        >
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
  const { destinations, extras, inPage } = useContext(AppMenuContents);
  const [open, setOpen] = useState(false);

  if (!inPage) return null;
  // A button that opens an empty popup is a button that lies about having
  // something behind it.
  if (destinations.length === 0 && !extras) return null;

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
          <IconSettings size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        {/* Upwards from the touch row, which sits at the bottom of a phone;
            downwards from the desktop column, where the button is near the top
            of the screen and there is no room above it. */}
        <Popover.Positioner sideOffset={8} side={size === "touch" ? "top" : "bottom"} align="end">
          <AppMenuPopup
            destinations={destinations}
            extras={extras}
            onNavigate={() => setOpen(false)}
          />
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AppShell({
  children,
  destinations = [],
  trailing,
  menuExtras,
  menuInPage = false,
}: {
  children: React.ReactNode;
  /**
   * Where this page's menu can take you.
   *
   * Empty by default, which is what the game gets: the world is the whole
   * screen and the tile editor is not somewhere a player is offered. The
   * authoring pages pass {@link ADMIN_DESTINATIONS} — see {@link AdminShell},
   * which is the only thing that does.
   */
  destinations?: Destination[];
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
   * This page draws the menu itself, so the bar goes away entirely, at every
   * width.
   *
   * Opt-in per page, and deliberately not the default: it costs the page a
   * {@link AppMenuButton} somewhere a hand can reach, and a route that took the
   * header away without drawing one would leave it with no way out. The editors
   * keep their header for exactly that reason.
   */
  menuInPage?: boolean;
}) {
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const [menuOpen, setMenuOpen] = useState(false);
  const headerHidden = menuInPage;

  return (
    <AppMenuContents.Provider value={{ destinations, extras: menuExtras, inPage: headerHidden }}>
      <div
        className="flex h-full flex-col"
        style={{
          // **A page that has taken the header away has taken the whole screen
          // with it, top and bottom.** `viewport-fit=cover` in `../root.tsx`
          // hands us the pixels behind the status bar and the toolbar, and this
          // is the half that decides who may sit in them. For a page of chrome
          // the answer is nobody: a row of navigation under the notch is a row
          // nobody can read. For the game it is the world — the top of the map
          // passes under the clock and the dynamic island, which costs a strip
          // of scenery and buys the whole height of the screen, and the
          // controls below it hold themselves off the toolbar individually.
          // See `GameViewport`.
          paddingTop: headerHidden ? undefined : "env(safe-area-inset-top)",
          paddingBottom: headerHidden ? undefined : "env(safe-area-inset-bottom)",
          // Landscape, where the notch is on one side and the home indicator on
          // the other, and kept even for the game: a d-pad or a list of verbs
          // behind the notch is not scenery, it is a control you cannot reach.
          // Zero in portrait, and zero everywhere that has neither.
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        {headerHidden ? null : (
          <header className="flex flex-wrap items-center gap-3 border-b-2 border-border bg-ink px-3 py-2 text-paper">
            <div className="text-sm font-bold tracking-wide uppercase">The Last Stones</div>

            {narrow ? (
              destinations.length === 0 && !menuExtras ? null : (
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
                        destinations={destinations}
                        extras={menuExtras}
                        onNavigate={() => setMenuOpen(false)}
                      />
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
              )
            ) : (
              <nav className="flex gap-1">
                {destinations.map(({ to, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    // @see the menu's copy of this link, which explains `end`.
                    end={to === "/"}
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
    </AppMenuContents.Provider>
  );
}

/**
 * The shell every page under `/admin` uses: {@link AppShell} with the tools in
 * its menu.
 *
 * A component rather than a `destinations` prop repeated on six pages, so the
 * list cannot drift page to page — and so no player-facing screen can grow a
 * link to the tile editor by copying a shell call.
 */
export function AdminShell(props: Omit<React.ComponentProps<typeof AppShell>, "destinations">) {
  return <AppShell {...props} destinations={ADMIN_DESTINATIONS} />;
}
