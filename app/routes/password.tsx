import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import { Door, DoorButton, DoorError, DoorField, DoorNote, DoorTitle } from "../components/door";
import { changePassword, fetchMe } from "../lib/auth";

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
    setCurrent("");
    setNext("");
    setDone(true);
  };

  if (done) {
    return (
      <Door>
        <DoorTitle>Password changed</DoorTitle>
        <DoorNote>Anywhere else you were signed in has been signed out.</DoorNote>
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
        There is no email reset on this account: a forgotten password is a lost account.
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
