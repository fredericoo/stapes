import { IconKey } from "@tabler/icons-react";
import { useState } from "react";
import { Button, Dialog, Input } from "../ui";
import { changePassword } from "../lib/auth";

/**
 * Change the password, from inside the game.
 *
 * **The one piece of account management the UI offers**, and it is here because
 * of how the first administrator arrives: a fresh deployment seeds `admin` with
 * a password that is written down in this repository, and the first thing its
 * operator has to be able to do is change it without opening a database. The
 * seed never writes again, so that change is permanent. @see `server/auth.ts`
 *
 * It is in the same menu the lighting switch and Log out are in — the header on
 * a wide window, the cog beside the d-pad on a phone — because that menu is
 * already the answer to "the thing I want is not on the screen".
 *
 * Both passwords are asked for, and the current one is not a formality: it is
 * what stops a tab somebody left open in a library from becoming a permanent
 * loss of the account. There is no recovery in this game, so that is the whole
 * of the protection.
 */
export function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const close = (nowOpen: boolean) => {
    setOpen(nowOpen);
    if (nowOpen) return;
    // Cleared on the way out rather than on the way in, so a password is not
    // sitting in a closed dialog's state for the rest of the session.
    setCurrent("");
    setNext("");
    setError(null);
    setDone(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await changePassword(current, next);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    setCurrent("");
    setNext("");
    setDone(true);
  };

  return (
    <>
      <Button variant="ghost-inverse" size="sm" onClick={() => close(true)}>
        <IconKey size={16} stroke={2} aria-hidden="true" />
        Password
      </Button>
      <Dialog
        open={open}
        onOpenChange={close}
        title="Change password"
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              {done ? "Close" : "Cancel"}
            </Button>
            {done ? null : (
              <Button
                variant="primary"
                disabled={busy || !current || !next}
                onClick={() => void submit()}
              >
                {busy ? "Changing…" : "Change"}
              </Button>
            )}
          </>
        }
      >
        {done ? (
          <p className="text-sm leading-relaxed">
            Changed. Anywhere else you were signed in has been signed out.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Current password
              <Input
                type="password"
                autoComplete="current-password"
                value={current}
                disabled={busy}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              New password
              <Input
                type="password"
                autoComplete="new-password"
                value={next}
                disabled={busy}
                onChange={(event) => setNext(event.target.value)}
              />
            </label>
            <p className="text-xs leading-relaxed text-muted">
              There is no email on this account and no way to reset a forgotten
              password.
            </p>
            {error ? (
              <p className="text-xs leading-relaxed text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {/* So Enter submits: a form with one button outside it has no
                default action, and the dialog's buttons live in its footer. */}
            <button type="submit" className="hidden" aria-hidden="true" />
          </form>
        )}
      </Dialog>
    </>
  );
}
