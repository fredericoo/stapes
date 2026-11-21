import { useEffect, useState } from "react";
import { Button, Dialog, Textarea } from "../../ui";
import { parseMapDoc, type MapDoc } from "./doc";

/**
 * The whole tree as the JSON it is saved as, to copy out or to paste a tree
 * in. Apply refuses text that is not a map tree and says why, and leaves the
 * tree as it was.
 */
export function JsonDialog({
  open,
  onOpenChange,
  doc,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: MapDoc;
  onApply: (doc: MapDoc) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(JSON.stringify(doc, null, 2));
    setError(null);
  }, [open, doc]);

  const apply = () => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This is not JSON");
      return;
    }
    const parsed = parseMapDoc(raw);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    onApply(parsed.doc);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Map tree JSON"
      wide
      footer={
        <div className="flex w-full items-center gap-2">
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button className="ml-auto" onClick={() => void navigator.clipboard?.writeText(text)}>
            Copy
          </Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </div>
      }
    >
      <Textarea
        aria-label="Map tree JSON"
        className="h-full min-h-[50vh] w-full font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Dialog>
  );
}
