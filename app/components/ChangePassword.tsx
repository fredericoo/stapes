import { useState } from "react";
import { DoorButton, DoorError, DoorField, DoorNote, SYSTEM_MONO } from "./door";
import { changePassword } from "../lib/auth";

/**
 * Change the password, on the screen the account lives on.
 *
 * **On the character chooser and not in the game**, because a password belongs
 * to an *account* and the game is where a *character* is. That split is the
 * whole vocabulary of these screens — you sign in and out of an account; a
 * character enters and leaves the world — and a control that crossed it would
 * be the one thing teaching people the words are interchangeable.
 *
 * **It is also how the first administrator arrives.** A fresh deployment seeds
 * `admin` with a password written down in this repository, and the first thing
 * its operator has to be able to do is change it without opening a database.
 * They sign in at the front door, land here with no characters, and this is on
 * the screen. The seed never writes again, so that change is permanent.
 * @see `server/auth.ts`
 *
 * **Collapsed until asked for.** The chooser's job is to get somebody into the
 * world; a password form open by default would put account paperwork in
 * front of the button they came for.
 *
 * Both passwords are asked for, and the current one is not a formality: it is
 * what stops a tab left open in a library from becoming a permanent loss of the
 * account. There is no reset in this game, so that is the whole of the
 * protection.
 */
export function ChangePassword({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const close = () => {
    setOpen(false);
    // Cleared on the way out rather than on the way in, so a password is not
    // sitting in a closed form's state for the rest of the session.
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

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
        style={{ fontFamily: SYSTEM_MONO }}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Change password
      </button>
    );
  }

  if (done) {
    return (
      <div className="flex w-full max-w-xs flex-col items-center gap-3">
        <DoorNote>
          Changed. Anywhere else you were signed in has been signed out.
        </DoorNote>
        <DoorButton className="w-full" onClick={close}>
          Done
        </DoorButton>
      </div>
    );
  }

  return (
    <form
      className="flex w-full max-w-xs flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DoorField
        label="Current password"
        type="password"
        autoFocus
        autoComplete="current-password"
        value={current}
        disabled={busy}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <DoorField
        label="New password"
        type="password"
        autoComplete="new-password"
        value={next}
        disabled={busy}
        onChange={(event) => setNext(event.target.value)}
      />
      <div className="flex gap-2">
        <DoorButton
          type="submit"
          className="flex-1"
          disabled={busy || !current || !next}
        >
          {busy ? "Changing…" : "Change"}
        </DoorButton>
        <DoorButton className="flex-1" disabled={busy} onClick={close}>
          Cancel
        </DoorButton>
      </div>
      {error ? <DoorError>{error}</DoorError> : null}
    </form>
  );
}
