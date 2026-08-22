import { Popover } from "@base-ui/react/popover";
import { IconMenu2 } from "@tabler/icons-react";
import { useState } from "react";
import { NavLink } from "react-router";
import { useMediaQuery } from "../lib/useMediaQuery";

/**
 * The header, which on a phone is mostly in the way.
 *
 * The destinations and a lighting switch are worth their room on a desktop and
 * are not on a 375px screen: they wrapped the bar onto a second and third line,
 * and every one of those lines came out of the game underneath. So below the
 * breakpoint the whole set folds into one button, and the bar keeps a single
 * row for the things that are actually about what you are looking at — the
 * clock, the headcount, the frame counter.
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

export function AppShell({
  children,
  trailing,
  menuExtras,
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
}) {
  const narrow = useMediaQuery(NARROW_VIEWPORT);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b-2 border-border bg-ink px-3 py-2 text-paper">
        <div className="text-sm font-bold tracking-wide uppercase">Stapes</div>

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
                {/* Wide enough for the widest thing that folds in here — the
                    time scrubber with its caption and pause box — so the extras
                    keep the one-line shape they have in the header. */}
                <Popover.Popup className="z-50 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 border-2 border-border bg-ink p-2 text-paper shadow-hard">
                  <nav className="flex flex-col gap-1">
                    {DESTINATIONS.map(({ to, label }) => (
                      <NavLink
                        key={to}
                        to={to}
                        // Closed by hand rather than by the route changing:
                        // tapping the destination you are already on navigates
                        // nowhere, and a menu that stayed open on it would read
                        // as the tap having missed.
                        onClick={() => setMenuOpen(false)}
                        className={({ isActive }) => linkClass(isActive, true)}
                      >
                        {label}
                      </NavLink>
                    ))}
                  </nav>
                  {menuExtras ? (
                    <div className="flex flex-wrap items-center gap-2 border-t-2 border-paper/20 pt-2">
                      {menuExtras}
                    </div>
                  ) : null}
                </Popover.Popup>
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
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
