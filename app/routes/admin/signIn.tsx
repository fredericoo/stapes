import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import { Door, DoorNote, DoorTitle } from "../../components/door";
import { SignInForm } from "../../components/SignInForm";
import { fetchMe, signOut, type Me } from "../../lib/auth";

export async function clientLoader() {
  const me = await fetchMe();
  if (me.user?.role === "ADMIN") throw redirect("/admin/map");
  return { me };
}

export default function AdminSignIn() {
  const { me: loaded } = useLoaderData<typeof clientLoader>();
  const [me, setMe] = useState<Me>(loaded);
  const signedIn = me.user;

  return (
    <Door>
      <DoorTitle>The editors</DoorTitle>
      <SignInForm
        onSignedIn={() => {
          void fetchMe().then((now) => {
            if (now.user?.role === "ADMIN") window.location.assign("/admin/map");
            else setMe(now);
          });
        }}
      />
      {signedIn ? (
        <DoorNote>
          This browser is signed in as {signedIn.username}, who is not an administrator. Roles are
          set in the database.{" "}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-paper"
            onClick={() => void signOut().then(() => void fetchMe().then(setMe))}
          >
            Sign out
          </button>
        </DoorNote>
      ) : (
        <DoorNote>Administrators only.</DoorNote>
      )}
    </Door>
  );
}
