import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { ToastProvider } from "./ui/Toast";
import { TooltipProvider } from "./ui/Tooltip";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The phone's own furniture — the status bar above the page and the
            browser's toolbar below it. Without this both take their colour from
            the page background, which is the cream paper, so a game that is
            nothing but dark chrome sat inside two bright bands.

            `--color-ink` rather than pure black, because the top band lands
            directly against the header, which is `bg-ink`: any other value and
            the seam between the status bar and our own bar is visible. Kept in
            sync with `--color-ink` in `app.css` by hand — a meta tag cannot read
            a custom property. */}
        <meta name="theme-color" content="#1a1a1a" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ToastProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="p-4">
      <h1 className="text-lg font-bold">{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="mt-4 overflow-x-auto border-2 border-border bg-panel p-3 text-xs shadow-hard">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
