import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { SYSTEM_MONO } from "../components/door";
import { CANONICAL_ORIGIN } from "../components/home/content";
import { NAV_HEIGHT_PX, NavBar } from "../components/home/NavBar";
import { ItemCard } from "../components/ItemCard";
import { ItemSourcesList, type ItemSourcesContext } from "../components/ItemSourcesList";
import { KeyHint } from "../components/KeyHint";
import { PLAYER_TILE_ID } from "../game/constants";
import { isTypingTarget } from "../game/heldDirections";
import { fetchBootstrap } from "../lib/api";
import { ELEMENTS } from "../lib/element";
import {
  catalogueEntries,
  EMPTY_QUERY,
  ITEM_CATEGORIES,
  ITEM_ORIGINS,
  type CatalogueQuery,
  type ItemCategory,
  type ItemElement,
  type ItemOrigin,
  matchesQuery,
} from "../lib/itemCatalogue";
import { statusesById } from "../lib/status";
import { Button, Input, Segmented, Select } from "../ui";
import type { Route } from "./+types/items";
import "./home.css";

const TITLE = "Items · The Last Stones";
const DESCRIPTION =
  "Every weapon, armour, stone and potion in The Last Stones: what it does and where to get it.";

const PAGE_STYLE: CSSProperties = { fontFamily: SYSTEM_MONO, "--home-nav-h": `${NAV_HEIGHT_PX}px` };

const SEARCH_KEY = "/";

const ELEMENT_OPTIONS: { value: ItemElement; label: string }[] = [
  { value: "any", label: "Any" },
  ...ELEMENTS.map((element) => ({
    value: element,
    label: element.charAt(0).toUpperCase() + element.slice(1),
  })),
];

export function meta(): Route.MetaDescriptors {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { tagName: "link", rel: "canonical", href: `${CANONICAL_ORIGIN}/items` },
  ];
}

export async function clientLoader() {
  return await fetchBootstrap();
}

export function shouldRevalidate() {
  return false;
}

export function HydrateFallback() {
  return (
    <ItemsFrame>
      <p className="home-items-lede">Loading items…</p>
    </ItemsFrame>
  );
}

function ItemsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="home" style={PAGE_STYLE}>
      <NavBar shown nameHref="/" />
      <main className="home-items">
        <h1 className="home-pixel home-section-title home-outline">Items</h1>
        {children}
      </main>
    </div>
  );
}

function pick<T extends string>(raw: string | null, options: { value: T }[], fallback: T): T {
  return options.find((option) => option.value === raw)?.value ?? fallback;
}

function queryFrom(params: URLSearchParams): CatalogueQuery {
  return {
    text: params.get("q") ?? "",
    category: pick<ItemCategory>(params.get("type"), ITEM_CATEGORIES, "all"),
    element: pick<ItemElement>(params.get("element"), ELEMENT_OPTIONS, "any"),
    origin: pick<ItemOrigin>(params.get("from"), ITEM_ORIGINS, "any"),
  };
}

function paramsFrom(query: CatalogueQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.text) params.set("q", query.text);
  if (query.category !== EMPTY_QUERY.category) params.set("type", query.category);
  if (query.element !== EMPTY_QUERY.element) params.set("element", query.element);
  if (query.origin !== EMPTY_QUERY.origin) params.set("from", query.origin);
  return params;
}

export default function ItemsPage() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  const [searchParams] = useSearchParams();
  const [query, setQueryState] = useState(() => queryFrom(searchParams));
  const searchRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const entries = useMemo(
    () => catalogueEntries(tiles, statusesById(statuses), PLAYER_TILE_ID),
    [tiles, statuses],
  );
  const tilesById = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles]);
  const visible = entries.filter((entry) => matchesQuery(entry, query));

  const setQuery = (next: Partial<CatalogueQuery>) => {
    setQueryState((current) => ({ ...current, ...next }));
  };

  /**
   * Written past the router so that the `#item` a card was reached by stays on
   * the URL, and so that typing does not queue a navigation per keystroke.
   */
  useEffect(() => {
    const search = paramsFrom(query).toString();
    const { pathname, hash } = window.location;
    history.replaceState(history.state, "", `${pathname}${search ? `?${search}` : ""}${hash}`);
  }, [query]);

  const context: Omit<ItemSourcesContext, "itemId"> = {
    tiles: tilesById,
    tilesets,
    onPick: (tileId) => {
      if (!visible.some((entry) => entry.tile.id === tileId)) setQuery(EMPTY_QUERY);
      setPicked(tileId);
    },
  };

  useEffect(() => {
    const id = picked ?? decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
    setHighlighted(id);
    setPicked(null);
  }, [picked]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== SEARCH_KEY || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = visible.length !== entries.length;

  return (
    <ItemsFrame>
      <p className="home-items-lede">
        Every item in the world, what it does, and where to get it. Figures are for somebody who has
        just met the item's requirements.
      </p>

      <div
        role="search"
        className="home-items-toolbar flex flex-col gap-2 border-2 border-border bg-panel p-3 text-ink shadow-hard"
      >
        <div className="relative">
          <Input
            ref={searchRef}
            type="search"
            value={query.text}
            onChange={(event) => setQuery({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (query.text) setQuery({ text: "" });
              else event.currentTarget.blur();
            }}
            placeholder="Search items, shops, creatures"
            aria-label="Search items"
            autoComplete="off"
            className="w-full pr-7"
          />
          {query.text === "" ? (
            <span className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2">
              <KeyHint label={SEARCH_KEY} />
            </span>
          ) : null}
        </div>

        <div role="group" aria-label="Type" className="flex flex-wrap gap-1.5">
          {ITEM_CATEGORIES.map((option) => {
            const active = option.value === query.category;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setQuery({ category: option.value })}
                className={[
                  "border-2 border-border px-2 py-1 text-xs font-medium",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  active ? "bg-ink text-paper" : "bg-paper text-ink hover:bg-panel",
                ].join(" ")}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2 text-xs">
            <span className="text-muted">Element</span>
            <Segmented
              value={query.element}
              options={ELEMENT_OPTIONS}
              onChange={(element) => setQuery({ element })}
              size="sm"
              ariaLabel="Element"
            />
          </span>
          <span className="flex items-center gap-2 text-xs">
            <span className="text-muted">Comes from</span>
            <Select
              value={query.origin}
              onValueChange={(origin) =>
                setQuery({ origin: pick<ItemOrigin>(origin, ITEM_ORIGINS, "any") })
              }
              options={ITEM_ORIGINS}
              ariaLabel="Comes from"
              className="min-w-[8rem]"
            />
          </span>
          <span role="status" className="text-xs text-muted sm:ml-auto">
            {filtered ? `${visible.length} of ${entries.length} items` : `${entries.length} items`}
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="mt-6 flex flex-col items-start gap-3 border-2 border-border bg-panel p-6 text-sm text-ink shadow-hard">
          <span>No item matches all of that.</span>
          <Button
            size="sm"
            onClick={() => {
              setQuery(EMPTY_QUERY);
              searchRef.current?.focus();
            }}
          >
            Clear search and filters
          </Button>
        </div>
      ) : (
        <ul className="home-items-grid">
          {visible.map((entry) => (
            <li key={entry.tile.id}>
              <article
                id={entry.tile.id}
                tabIndex={-1}
                aria-label={entry.card.name}
                data-picked={entry.tile.id === highlighted}
                className="home-items-card flex h-full flex-col gap-2 border-2 border-border bg-paper p-3 text-ink shadow-hard"
              >
                <p className="sr-only">{entry.card.speech}</p>
                <ItemCard
                  card={entry.card}
                  tile={entry.tile}
                  tilesets={tilesets}
                  className="w-full"
                />
                <ItemSourcesList
                  sources={entry.sources}
                  context={{ ...context, itemId: entry.tile.id }}
                />
              </article>
            </li>
          ))}
        </ul>
      )}
    </ItemsFrame>
  );
}
