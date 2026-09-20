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
 * The front door: sign in to an account, or make one.
 *
 * **Signing in is a username and a password.** An email is asked for once, when
 * the account is made, and then only stored: nothing sends to it, nothing
 * verifies it, and there is no reset behind it — which is why the form says a
 * forgotten password is a lost account before anybody has typed one. What the
 * address buys is a way to reach somebody about their account at all, which a
 * game with no other contact detail had none of.
 *
 * **One screen for both errands.** They ask for nearly the same things, and a
 * separate page for the second is a navigation somebody has to find. Making an
 * account adds the email field and swaps the button; nothing else moves.
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const attempt = making
      ? await signUp(username, email, password)
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
        {/* Only when making one. Signing in is the username and the password:
            asking for an address you have already given is a field to get
            wrong on the screen people see most often. */}
        {making ? (
          <DoorField
            label="Email"
            type="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="email"
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        ) : null}
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
          disabled={busy || !username || !password || (making && !email)}
          className="mt-1"
        >
          {busy ? "Just a moment…" : making ? "Create account" : "Sign in"}
        </DoorButton>
      </form>
      {error ? <DoorError>{error}</DoorError> : null}
      {children}
      {making ? (
        <DoorNote>
          At least {minPasswordLength} characters. There is no password reset,
          so pick one you will remember.
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
