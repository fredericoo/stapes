import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import { DoorNote } from "../../components/door";
import { SignInScreen } from "../../components/SignInScreen";
import { MIN_PASSWORD_LENGTH } from "../../lib/account";
import { fetchMe, signOut, type Me } from "../../lib/auth";

/**
 * The editors' door.
 *
 * Every page under `/admin` sends somebody here who is not an administrator —
 * see `requireAdmin` — and this is the only route under that prefix that does
 * not. It has to be reachable signed out, or there would be nowhere to sign in.
 *
 * **It does not offer to make an account.** A role is assigned in the database
 * and by nothing else, so an account made here would be signed in and refused
 * in the same breath. Somebody who wants to play makes their account at the
 * game's own door.
 *
 * The other case it has to answer is the awkward one: a player who typed
 * `/admin` while signed in as themselves. A sign-in form at somebody who is
 * already signed in explains nothing, so they are told whose account this
 * browser is holding and offered the way out of it.
 */
export async function clientLoader() {
  const me = await fetchMe();
  // Already an administrator: there is nothing to ask, and a door that stands
  // in front of somebody who has the key is just a step. The map editor is
  // where `/admin` goes anyway. @see ./_index
  if (me.user?.role === "ADMIN") throw redirect("/admin/map");
  return { me };
}

export default function AdminSignIn() {
  const { me: loaded } = useLoaderData<typeof clientLoader>();
  const [me, setMe] = useState<Me>(loaded);

  const signedIn = me.user;

  return (
    <SignInScreen
      allowSignUp={false}
      minPasswordLength={MIN_PASSWORD_LENGTH}
      onSignedIn={() => {
        // A full navigation rather than a state change: what is behind this is
        // the editor, and the editor's loaders have already run and failed.
        // Reloading is the cheapest way to make them run again as somebody
        // else, and it happens once per sign-in.
        void fetchMe().then((now) => {
          if (now.user?.role === "ADMIN") window.location.assign("/admin/map");
          else setMe(now);
        });
      }}
    >
      {signedIn ? (
        <DoorNote>
          This browser is signed in as {signedIn.username}, who is not an
          administrator. Roles are set in the database.{" "}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-paper"
            onClick={() => void signOut().then(() => void fetchMe().then(setMe))}
          >
            Sign out
          </button>
        </DoorNote>
      ) : (
        <DoorNote>The editors. Administrators only.</DoorNote>
      )}
    </SignInScreen>
  );
}
