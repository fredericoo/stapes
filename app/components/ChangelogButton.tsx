import { useState } from "react";
import { formatReleaseDate, type DatedRelease, RELEASES } from "./releaseNotes";
import { Button, Dialog } from "../ui";
import { AttentionDot } from "./AttentionDot";
import { IconChangelog } from "./pixelIcons";

export function ChangelogButton({ unseen, onView }: { unseen: boolean; onView: () => void }) {
  const [open, setOpen] = useState(false);

  if (RELEASES.length === 0) return null;

  const show = () => {
    setOpen(true);
    onView();
  };

  return (
    <>
      <Button variant="ghost-inverse" size="sm" onClick={show}>
        <IconChangelog size={16} aria-hidden="true" />
        What changed
        {unseen ? (
          <>
            <AttentionDot />
            <span className="sr-only">, new</span>
          </>
        ) : null}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="What changed"
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            Back to the game
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          {RELEASES.map((release) => (
            <ReleaseNotes key={release.version} release={release} />
          ))}
        </div>
      </Dialog>
    </>
  );
}

function ReleaseNotes({ release }: { release: DatedRelease }) {
  const headingId = `release-${release.version}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3
        id={headingId}
        className="flex items-baseline justify-between gap-3 border-b-2 border-border pb-1"
      >
        {release.releasedOn ? (
          <time dateTime={release.releasedOn} className="text-sm font-bold">
            {formatReleaseDate(release.releasedOn)}
          </time>
        ) : null}
        <span className="text-xs text-ink/60">v{release.version}</span>
      </h3>
      {release.sections.map((section, sectionIndex) => (
        <div key={sectionIndex}>
          <h4 className="text-xs uppercase text-ink/60">{section.title}</h4>
          <ul className="mt-1 flex list-[square] flex-col gap-1.5 pl-5 text-sm leading-relaxed">
            {section.entries.map((entry, entryIndex) => (
              <li key={entryIndex} className="whitespace-pre-line">
                {entry}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
