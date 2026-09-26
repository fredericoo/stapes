import { Popover } from "@base-ui/react/popover";
import { IconMenu2, IconSettings } from "@tabler/icons-react";
import { createContext, useContext, useState } from "react";
import { NavLink } from "react-router";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./actionButton";
import { Tooltip } from "../ui/Tooltip";

const NARROW_VIEWPORT = "(max-width: 767px)";

export type Destination = { to: string; label: string };

export const ADMIN_DESTINATIONS: Destination[] = [
  { to: "/admin/tiles", label: "Tiles" },
  { to: "/admin/statuses", label: "Statuses" },
  { to: "/admin/map", label: "Map" },
  { to: "/admin/play", label: "Play" },
  { to: "/admin/arena", label: "Arena" },
  { to: "/admin/voxel", label: "Voxel" },
  { to: "/admin/actions", label: "Actions" },
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

const AppMenuContents = createContext<{
  destinations: Destination[];
  extras: React.ReactNode;
  inPage: boolean;
}>({ destinations: [], extras: null, inPage: false });

export function MenuRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <span className="text-xs uppercase text-paper/70">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

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
    <Popover.Popup className="z-50 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 border-2 border-border bg-ink p-2 text-paper shadow-hard">
      {destinations.length === 0 ? null : (
        <nav className="flex flex-col gap-1">
          {destinations.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={onNavigate}
              className={({ isActive }) => linkClass(isActive, true)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      )}
      {extras ? (
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

export function AppMenuButton({ size = "touch" }: { size?: ActionButtonSize }) {
  const { destinations, extras, inPage } = useContext(AppMenuContents);
  const [open, setOpen] = useState(false);

  if (!inPage) return null;
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
            "border-paper/40 bg-transparent text-paper data-[popup-open]:border-paper data-[popup-open]:bg-paper data-[popup-open]:text-ink",
          ].join(" ")}
        >
          <IconSettings size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
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
  destinations?: Destination[];
  trailing?: React.ReactNode;
  menuExtras?: React.ReactNode;
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
          paddingTop: headerHidden ? undefined : "env(safe-area-inset-top)",
          paddingBottom: headerHidden ? undefined : "env(safe-area-inset-bottom)",
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

export function AdminShell(props: Omit<React.ComponentProps<typeof AppShell>, "destinations">) {
  return <AppShell {...props} destinations={ADMIN_DESTINATIONS} />;
}
