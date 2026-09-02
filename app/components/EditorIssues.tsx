/**
 * What a validator found, as a list the author can act on.
 *
 * One shape for every authored block that has a `validate*`: an error is what
 * would make the block fail to load, a warning is something that parses and is
 * almost certainly not what the author meant. Nothing at all draws nothing —
 * a clean block earns no box saying so.
 */
export type EditorIssue = { severity: "error" | "warn"; message: string };

export function EditorIssues({ issues }: { issues: readonly EditorIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, i) => (
        <li
          key={i}
          className={[
            "border-2 px-2 py-1 text-xs",
            issue.severity === "error"
              ? "border-danger bg-danger/10 text-danger"
              : "border-accent bg-accent/10 text-ink",
          ].join(" ")}
        >
          {issue.severity === "error" ? "✕ " : "! "}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
