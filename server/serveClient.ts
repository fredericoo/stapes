import { Elysia } from "elysia";
import type { ClientBundle } from "./clientBundle";

/**
 * Every path the API and the socket do not claim is a file of the client or
 * the page that boots it. A `Range` header is passed on for a GET only: HTTP
 * has every other method ignore it.
 */
export function serveClient(bundle: ClientBundle) {
  return new Elysia().get("/*", ({ request, status }) => {
    const rangeHeader = request.method === "GET" ? request.headers.get("range") : null;
    return (
      bundle.respond(new URL(request.url).pathname, rangeHeader) ?? status(404, "No client bundle")
    );
  });
}
