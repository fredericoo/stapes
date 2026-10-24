import { IconStar } from "./pixelIcons";

const DEFAULT_STAR_SIZE_PX = 12;

export function Rating({
  value,
  size = DEFAULT_STAR_SIZE_PX,
  className,
}: {
  value: number;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={["inline-flex items-center gap-0.5 tabular-nums", className]
        .filter(Boolean)
        .join(" ")}
    >
      <IconStar size={size} aria-hidden="true" className="shrink-0" />
      <span className="sr-only">Rating </span>
      {value}
    </span>
  );
}
