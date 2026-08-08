import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

/**
 * Web-streams server render.
 *
 * React Router's default entry uses `renderToPipeableStream` over `node:stream`,
 * which does not exist in workerd — hence this file. `renderToReadableStream` is
 * the same streaming render against the platform's own stream type.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let status = responseStatusCode;
  let shellRendered = false;

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        status = 500;
        // Errors thrown before the shell flushes are already reported through
        // the rejected promise below; logging them here would double up.
        if (shellRendered) console.error(error);
      },
    },
  );
  shellRendered = true;

  // A crawler gets no benefit from a streamed shell and may sample the page
  // before the content arrives, so hold the whole document for one.
  const userAgent = request.headers.get("user-agent");
  if (userAgent && isbot(userAgent)) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, { headers: responseHeaders, status });
}
