import { useState, type ReactNode } from "react";
import {
  Door,
  DoorButton,
  DoorError,
  DoorField,
  DoorNote,
  DoorTitle,
} from "./door";
import { signIn, signUp } from "../lib/auth";

/**
 * The front door: a username, a password, and no third field.
 *
 * **There is no email and no recovery.** Nobody has an address to send a reset
 * to, so a forgotten password is a lost account — which is why the only rule
 * the form imposes is a length, and why it says so before anybody has typed
 * anything wrong. Asking for an address the game would never use, to enable a
 * recovery the game does not have, would be collecting a personal detail for
 * the look of the thing.
 *
 * **One screen for both errands.** Signing in and making an account ask for
 * exactly the same two things, and a separate page for the second is a
 * navigation somebody has to find. The toggle underneath swaps which button the
 * form has and nothing else moves.
 *
 * Nothing behind this connects. The socket is opened once there is a character
 * to open it as — see `./CharacterScreen` and `../routes/game` — so a tab left
 * on this screen costs the world nothing: no account looked up, no body on the
 * board, no chunks sent.
 */
export function SignInScreen({
  onSignedIn,
  minPasswordLength,
  allowSignUp = true,
  children,
}: {
  /** Called once the cookie is set, so the page can ask who it now is. */
  onSignedIn: () => void;
  /** Quoted in the form rather than discovered by being refused. */
  minPasswordLength: number;
  /**
   * Whether to offer making one.
   *
   * False on the editors' door — see `../routes/admin/signIn` — where an
   * account made on the spot could not be used for anything: a role is
   * assigned in the database and by nothing else, so the new account would be
   * signed in and refused in the same breath.
   */
  allowSignUp?: boolean;
  /** Anything to say under the form. The editors' door says whose door it is. */
  children?: ReactNode;
}) {
  const [making, setMaking] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = making
      ? await signUp(username, password)
      : await signIn(username, password);
    setBusy(false);
    if (!attempt.ok) {
      setError(attempt.error);
      return;
    }
    // Both errands end signed in — the account route signs a new account in as
    // it makes it — so there is one thing to do next and it is the same thing.
    onSignedIn();
  };

  return (
    <Door>
      <DoorTitle>{making ? "New account" : "Sign in"}</DoorTitle>
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
          // it is looking at is what stops a new account being offered the
          // password of an old one.
          autoComplete="username"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />
        <DoorField
          label="Password"
          type="password"
          autoComplete={making ? "new-password" : "current-password"}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <DoorButton
          type="submit"
          disabled={busy || !username || !password}
          className="mt-1"
        >
          {busy ? "Just a moment…" : making ? "Create account" : "Sign in"}
        </DoorButton>
      </form>
      {error ? <DoorError>{error}</DoorError> : null}
      {children}
      {making ? (
        <DoorNote>
          At least {minPasswordLength} characters. There is no email and no way
          to reset it, so pick one you will remember.
        </DoorNote>
      ) : null}
      {allowSignUp ? (
        <button
          type="button"
          className="text-xs uppercase tracking-widest text-paper/50 underline underline-offset-4 hover:text-paper disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setMaking((was) => !was);
            // The other errand's refusal is not this one's. Somebody who was
            // told "that name is taken" and pressed Sign in is being shown a
            // sentence about a form they are no longer filling in.
            setError(null);
          }}
        >
          {making ? "I already have an account" : "Create an account"}
        </button>
      ) : null}
    </Door>
  );
}
