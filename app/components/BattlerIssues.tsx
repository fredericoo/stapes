/**
 * Why this body's battler block would not load, when it would not.
 *
 * Shown at the top of Battle and Spells, which are the two tabs that write the
 * block. Both tabs draw from the raw draft rather than from a parse, so without
 * this they look fine while the world reads the creature as having no hit
 * points and no spells — see `../lib/battler`'s `battlerIssues`.
 */
export function BattlerIssues({ issues }: { issues: readonly string[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-2 border-danger p-2 text-[11px] text-danger">
      <p>
        Something here is not valid, and a battler block that does not parse is dropped whole — the
        body would have no hit points and no spells. Saving is off until it is.
      </p>
      <ul className="flex flex-col gap-0.5 font-mono">
        {issues.map((issue, index) => (
          <li key={index}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}
