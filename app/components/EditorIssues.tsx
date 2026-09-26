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
