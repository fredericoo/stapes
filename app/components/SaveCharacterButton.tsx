import { IconSave } from "./pixelIcons";
import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "../lib/account";
import { claimAccount } from "../lib/auth";
import { Button, Dialog, Input } from "../ui";
import { AttentionDot } from "./AttentionDot";

export function SaveCharacterButton({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await claimAccount(username, email, password);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    setOpen(false);
    onSaved();
  };

  return (
    <>
      <Button variant="ghost-inverse" size="sm" onClick={() => setOpen(true)}>
        <IconSave size={16} aria-hidden="true" />
        Save your character
        <AttentionDot />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => !busy && setOpen(next)}
        title="Save your character"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="save-character"
              disabled={busy || !username || !email || !password}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form
          id="save-character"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm leading-relaxed">
            A guest cannot sign back in. Choose a username and password to keep this character and
            play it again later. You keep playing while you do.
          </p>
          <Field label="Username">
            <Input
              className={FINGER_SIZED}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              value={username}
              disabled={busy}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="Email">
            <Input
              className={FINGER_SIZED}
              type="email"
              autoComplete="email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label={`Password, at least ${MIN_PASSWORD_LENGTH} characters`}>
            <Input
              className={FINGER_SIZED}
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}

/** Safari on iOS zooms in on a focused field under 16px and does not zoom back out. */
const FINGER_SIZED = "pointer-coarse:text-base";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold uppercase text-muted">{label}</span>
      {children}
    </label>
  );
}
