/**
 * The changelog is read by players, so a line is the changeset's summary alone. The default
 * generator prefixes each one with a commit hash.
 *
 * @type {import("@changesets/types").ChangelogFunctions}
 */
export default {
  getReleaseLine: async (changeset) => {
    const [firstLine, ...rest] = changeset.summary.split("\n").map((line) => line.trimEnd());
    return [`- ${firstLine}`, ...rest.map((line) => `  ${line}`)].join("\n");
  },
  getDependencyReleaseLine: async () => "",
};
