import { afterEach, expect, it } from "bun:test";
import { Refused, takeSeat } from "./account";

const ACCOUNT = { username: "marenbot", password: "long-enough-pw", character: "Maren" };

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

/** A server whose sign-in always fails, and whose sign-up answers `signUp`. */
function serve(signIn: Response, signUp: Response): string {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/auth/sign-in/username") return signIn.clone();
      if (pathname === "/api/account") return signUp.clone();
      return new Response("not found", { status: 404 });
    },
  });
  return `http://localhost:${server.port}`;
}

async function failureOf(base: string): Promise<unknown> {
  return takeSeat(base, base, ACCOUNT).then(
    () => null,
    (error: unknown) => error,
  );
}

it("draws a new name only when the server turns the name down", async () => {
  const base = serve(
    new Response("wrong password", { status: 401 }),
    new Response("Username is already taken", { status: 400 }),
  );

  expect(await failureOf(base)).toBeInstanceOf(Refused);
});

it("keeps the name when a proxy answers for a server that is being deployed", async () => {
  const unavailable = () => new Response("no available server", { status: 503 });
  const base = serve(new Response("wrong password", { status: 401 }), unavailable());

  const failure = await failureOf(base);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(Refused);

  server!.stop(true);
  const down = serve(unavailable(), unavailable());
  expect(await failureOf(down)).not.toBeInstanceOf(Refused);
});
