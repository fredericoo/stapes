type Comment = { type: "Line" | "Block" | "Shebang"; value: string; start: number; end: number };

type Context = {
  sourceCode: { getAllComments(): Comment[] };
  report(descriptor: { node: Comment; message: string }): void;
};

const DIRECTIVE = /^\s*(oxlint-(disable|enable)|@ts-expect-error\s*$)|^\/\s*<reference /;

const noComments = {
  meta: {
    type: "suggestion",
    docs: { description: "Forbid comments other than doc blocks and lint and type directives" },
  },
  create(context: Context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang" || DIRECTIVE.test(comment.value)) continue;
          if (comment.type === "Block" && comment.value.startsWith("*")) continue;
          context.report({
            node: comment,
            message:
              "Remove this comment. Explain code that cannot be read without help in a /** */ block, and constraints in docs/<subject>.md.",
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "stapes" },
  rules: { "no-comments": noComments },
};
