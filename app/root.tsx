import { LoadingScreen } from "./components/LoadingScreen";
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

/**
 * What the tab is called, everywhere.
 *
 * The root route's, because no other route sets one: with `ssr: false` there is
 * no server-rendered document to carry a title, so without this the tab shows
 * the URL until the bundle has run — and on a game that is mostly one route,
 * shows it for the whole session.
 */
export function meta(): Route.MetaDescriptors {
  return [{ title: "The Last Stones" }];
}

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
        {/* `viewport-fit=cover` because the page has to own the whole screen,
            and without it iOS lays the page out inside the safe area and fills
            the bands it kept back — the strip behind the status bar and the one
            under the home indicator — with the page's own background. That was
            the cream, so a game made entirely of dark chrome sat between two
            bright bars whatever `theme-color` said.

            It hands us the notch and the toolbar along with the pixels, which is
            what `env(safe-area-inset-*)` is then for: see `AppShell`, which
            insets the chrome, and `GameViewport`, which deliberately does not
            inset the bottom and scrolls its list clear of the toolbar instead. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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

/**
 * What the tab shows before the first route's data has arrived.
 *
 * SPA mode allows this only on the root route, and it needs one: with no server
 * rendering, the very first paint happens while `clientLoader` is still asking
 * the server what the world looks like, and without this that moment is a blank
 * white page.
 */
export function HydrateFallback() {
  return <LoadingScreen />;
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
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
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
