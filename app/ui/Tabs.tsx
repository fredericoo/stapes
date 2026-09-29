import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

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
              "relative -mb-[2px] border-2 border-b-0 border-border px-3 py-1 text-xs",
              "bg-panel text-muted hover:text-ink",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
