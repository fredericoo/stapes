import type { TextareaHTMLAttributes } from "react";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
};

export function Textarea({ className = "", ...props }: Props) {
  return (
    <textarea
      className={[
        "border-2 border-border bg-paper px-2 py-1 text-sm text-ink shadow-hard",
        "placeholder:text-muted",
        "focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent",
        "disabled:opacity-50",
        className,
      ].join(" ")}
      {...props}
    />
  );
}
