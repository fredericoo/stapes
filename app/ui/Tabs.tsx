import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

/**
 * Folder tabs: a row of flaps standing on a rule, with the open one joined to
 * the page below it.
 *
 * Deliberately not the button treatment. A button is raised — hard shadow,
 * pressed-down travel — and a tab that wore the same chrome read as one more
 * button in a row of them, so switching sections looked like triggering
 * actions. Tabs here are flat and attached to the rule, and the open flap
 * erases its own stretch of the rule so it visibly *is* the panel underneath.
 * The join only works over a paper ground, which is the only ground a tab
 * strip sits on in this app.
 */
export function Tabs({
  value,
  onValueChange,
  items,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: Array<{ value: string; label: ReactNode }>;
  children: ReactNode;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={onValueChange}>
      <BaseTabs.List className="flex flex-wrap items-end gap-1 border-b-2 border-border">
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={[
              // Pulled down by the rule's width so the flap overlaps it, and
              // borderless underneath so the rule shows through a closed flap.
              "relative -mb-[2px] border-2 border-b-0 border-border px-3 py-1 text-xs",
              "bg-panel text-muted hover:text-ink",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              // Base UI marks the selected tab with `data-active`, not `data-selected`.
              // The open flap is paper on a paper bottom border, which covers
              // its stretch of the rule, and stands a little taller than the
              // closed ones. The weight is `!important` because app.css resets
              // `button { font: inherit }` outside any layer, and an unlayered
              // rule beats every layered utility whatever its specificity.
              "data-[active]:border-b-2 data-[active]:border-b-paper data-[active]:bg-paper data-[active]:pt-1.5 data-[active]:font-bold! data-[active]:text-ink",
            ].join(" ")}
          >
            {item.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export function TabPanel({
  value,
  children,
  className = "",
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseTabs.Panel value={value} className={["pt-3", className].join(" ")}>
      {children}
    </BaseTabs.Panel>
  );
}
