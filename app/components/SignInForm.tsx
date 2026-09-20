import { useState } from "react";
import { DoorButton, DoorError, DoorField } from "./door";
import { signIn } from "../lib/auth";

/**
 * A username, a password, and the press that signs you in.
 *
 * A component rather than a route's own markup because there are two doors that
 * want it: the game's at `/sign-in`, and the editors' at `/admin/sign-in`. They
 * differ in what they say around the form and where they go afterwards, which
 * is exactly the part they each keep.
 *
 * **It does not ask for the email.** That is given once, when the account is
 * made, and then only stored — see `server/auth.ts`. A second identifier on the
 * screen people see most often is a field to get wrong.
 */
export function SignInForm({
  onSignedIn,
  submitLabel = "Sign in",
}: {
  /** Called once the cookie is set. Each door decides where that leads. */
  onSignedIn: () => void;
  submitLabel?: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = await signIn(username, password);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    onSignedIn();
  };

  return (
    <>
      <form
        className="flex w-full max-w-xs flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DoorField
          label="Username"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          // The browser fills both fields together, and telling it which pair
          // it is looking at is what stops one form being offered the other's.
          autoComplete="username"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />
        <DoorField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <DoorButton
          type="submit"
          disabled={busy || !username || !password}
          className="mt-1"
        >
          {busy ? "Just a moment…" : submitLabel}
        </DoorButton>
      </form>
      {error ? <DoorError>{error}</DoorError> : null}
    </>
  );
}
