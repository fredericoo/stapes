export type ReleaseSection = { title: string; entries: string[] };
export type Release = { version: string; sections: ReleaseSection[] };

/**
 * Changesets heads each section with the semver bump it caused. Players read these instead;
 * `.github/workflows/release.yml` renames them the same way for Discord.
 */
const SECTION_TITLES: Record<string, string> = {
  "Major Changes": "Big changes",
  "Minor Changes": "New",
  "Patch Changes": "Fixes",
};

const RELEASE_HEADING = /^## (.+)$/;
const SECTION_HEADING = /^### (.+)$/;
const ENTRY = /^- (.*)$/;
const CONTINUATION = /^ {2}(.*)$/;

/**
 * Reads the `CHANGELOG.md` that `changeset version` writes: `## <version>`, then `### <bump>`
 * sections of `- ` entries whose further lines are indented two spaces.
 */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  for (const line of markdown.split("\n")) {
    readLine(releases, line.trimEnd());
  }
  return releases;
}

function readLine(releases: Release[], line: string) {
  const release = releases.at(-1);
  const section = release?.sections.at(-1);

  const version = RELEASE_HEADING.exec(line)?.[1];
  if (version) {
    releases.push({ version, sections: [] });
    return;
  }
  const heading = SECTION_HEADING.exec(line)?.[1];
  if (heading && release) {
    release.sections.push({ title: SECTION_TITLES[heading] ?? heading, entries: [] });
    return;
  }
  const entry = ENTRY.exec(line)?.[1];
  if (entry !== undefined && section) {
    section.entries.push(entry);
    return;
  }
  const continuation = CONTINUATION.exec(line)?.[1];
  if (continuation !== undefined && section && section.entries.length > 0) {
    section.entries[section.entries.length - 1] += `\n${continuation}`;
  }
}
