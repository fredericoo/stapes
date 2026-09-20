import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import {
  Door,
  DoorButton,
  DoorError,
  DoorField,
  DoorNote,
  DoorTitle,
} from "../components/door";
import { changePassword, fetchMe } from "../lib/auth";

/**
 * Change the password.
 *
 * **Its own screen, off the character chooser**, because a password belongs to
 * an *account* and the game is where a *character* is. A control that crossed
 * that line would be the one thing teaching people the two vocabularies are
 * interchangeable.
 *
 * **It is also how the first administrator arrives.** A fresh deployment seeds
 * `admin` with a password written down in this repository, and the first thing
 * its operator has to be able to do is change it without opening a database:
 * they sign in at the front door, and this is two presses away. The seed never
 * writes again, so that change is permanent. @see `server/auth.ts`
 *
 * Both passwords are asked for, and the current one is not a formality: it is
 * what stops a tab left open in a library from becoming a permanent loss of the
 * account. There is no reset in this game, so that is the whole of the
 * protection — and the same reason `revokeOtherSessions` is set, since one
 * reason to change a password is thinking it got out.
 */
export async function clientLoader() {
  const me = await fetchMe();
  if (!me.user) throw redirect("/sign-in");
  return null;
}

export default function PasswordPage() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await changePassword(current, next);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    // Cleared the moment it has been sent, rather than left in a form's state
    // for the rest of the session.
    setCurrent("");
    setNext("");
    setDone(true);
  };

  if (done) {
    return (
      <Door>
        <DoorTitle>Password changed</DoorTitle>
        <DoorNote>
          Anywhere else you were signed in has been signed out.
        </DoorNote>
        <DoorButton
          className="w-full max-w-xs"
          autoFocus
          onClick={() => void navigate("/characters")}
        >
          Back to characters
        </DoorButton>
      </Door>
    );
  }

  return (
    <Door>
      <DoorTitle>Change password</DoorTitle>
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
        <DoorButton type="submit" disabled={busy || !current || !next}>
          {busy ? "Changing…" : "Change password"}
        </DoorButton>
      </form>
      {error ? <DoorError>{error}</DoorError> : null}
      <DoorNote>
        There is no email reset on this account: a forgotten password is a lost
        account.
      </DoorNote>
      <button
        type="button"
        className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
        disabled={busy}
        onClick={() => void navigate("/characters")}
      >
        Back
      </button>
    </Door>
  );
}
