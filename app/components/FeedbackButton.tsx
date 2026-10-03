import { IconFeedback } from "./pixelIcons";
import { useState } from "react";
import { sendFeedback } from "../lib/auth";
import { browserContext } from "../lib/browserContext";
import { rememberedCharacterId } from "../lib/playing";
import { MAX_FEEDBACK_LENGTH } from "../../server/feedback";
import { Button, Dialog, Textarea } from "../ui";

export function FeedbackButton({ gameContext }: { gameContext: () => Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const show = () => {
    setSent(false);
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await sendFeedback(message, rememberedCharacterId(), {
      ...browserContext(),
      game: gameContext(),
    });
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    setMessage("");
    setSent(true);
  };

  return (
    <>
      <Button variant="ghost-inverse" size="sm" onClick={show}>
        <IconFeedback size={16} aria-hidden="true" />
        Send feedback
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => !busy && setOpen(next)}
        title="Send feedback"
        footer={
          sent ? (
            <Button variant="primary" onClick={() => setOpen(false)}>
              Back to the game
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="send-feedback"
                disabled={busy || !message.trim()}
              >
                {busy ? "Sending…" : "Send feedback"}
              </Button>
            </>
          )
        }
      >
        {sent ? (
          <p role="status" className="text-sm leading-relaxed">
            Thanks. Your feedback was sent.
          </p>
        ) : (
          <form
            id="send-feedback"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-sm leading-relaxed">
                What broke, what confused you, or what you liked. Your position in the world and
                details about your browser and device are sent with it.
              </span>
              <Textarea
                className="min-h-32 pointer-coarse:text-base"
                autoFocus
                maxLength={MAX_FEEDBACK_LENGTH}
                value={message}
                disabled={busy}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </Dialog>
    </>
  );
}
