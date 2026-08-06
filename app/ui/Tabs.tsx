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
      <BaseTabs.List className="flex flex-wrap gap-1 border-b-2 border-border pb-2">
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={[
              "border-2 border-border bg-panel px-2 py-1 text-xs font-medium shadow-hard",
              // Base UI marks the selected tab with `data-active`, not `data-selected`.
              "data-[active]:translate-x-[2px] data-[active]:translate-y-[2px] data-[active]:bg-ink data-[active]:text-paper data-[active]:shadow-none",
              "hover:bg-paper",
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
