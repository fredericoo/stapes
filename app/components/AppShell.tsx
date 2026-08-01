import { NavLink } from "react-router";

export function AppShell({
  children,
  trailing,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b-2 border-border bg-ink px-3 py-2 text-paper">
        <div className="text-sm font-bold tracking-wide uppercase">Stapes</div>
        <nav className="flex gap-1">
          <NavLink
            to="/tiles"
            className={({ isActive }) =>
              [
                "border-2 px-2 py-1 text-xs font-medium",
                isActive
                  ? "border-paper bg-paper text-ink"
                  : "border-paper/40 text-paper hover:border-paper",
              ].join(" ")
            }
          >
            Tiles
          </NavLink>
          <NavLink
            to="/map"
            className={({ isActive }) =>
              [
                "border-2 px-2 py-1 text-xs font-medium",
                isActive
                  ? "border-paper bg-paper text-ink"
                  : "border-paper/40 text-paper hover:border-paper",
              ].join(" ")
            }
          >
            Map
          </NavLink>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
