import * as v from "valibot";
import changelogMarkdown from "../../CHANGELOG.md?raw";
import { parseChangelog, type Release } from "../lib/changelog";

export type DatedRelease = Release & { releasedOn: string | null };

const releaseDatesSchema = v.record(v.string(), v.pipe(v.string(), v.isoDate()));

/** `vite.config.ts` reads these from the release tags; a build without tags has none. */
function readReleaseDates(): Record<string, string> {
  try {
    const parsed = v.safeParse(
      releaseDatesSchema,
      JSON.parse(import.meta.env.RELEASE_DATES ?? "{}"),
    );
    return parsed.success ? parsed.output : {};
  } catch {
    return {};
  }
}

const RELEASE_DATES = readReleaseDates();

export const RELEASES: DatedRelease[] = parseChangelog(changelogMarkdown).map((release) => ({
  ...release,
  releasedOn: RELEASE_DATES[release.version] ?? null,
}));

export const LATEST_VERSION: string | null = RELEASES[0]?.version ?? null;

/** An ISO date parses as UTC midnight, so formatting it in the viewer's zone could show the day before. */
const RELEASE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatReleaseDate(isoDate: string): string {
  return RELEASE_DATE_FORMAT.format(new Date(isoDate));
}
