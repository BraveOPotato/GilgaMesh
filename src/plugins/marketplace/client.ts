/**
 * src/plugins/marketplace/client.ts — Fetches the plugin marketplace index.
 *
 * Simple LRU-style TTL cache: re-fetches at most once per CACHE_TTL_MS.
 * No external dependencies.
 */

import type { MarketplaceEntry } from '../types.js';

const CACHE_TTL_MS       = 5 * 60 * 1000; // 5 minutes
const MARKETPLACE_INDEX  = 'https://gilgamesh.app/plugins/index.json';

interface CacheEntry {
  readonly data:    readonly MarketplaceEntry[];
  readonly fetchedAt: number;
}

let cache: CacheEntry | null = null;

export async function fetchMarketplace(
  indexUrl = MARKETPLACE_INDEX,
): Promise<readonly MarketplaceEntry[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const res = await fetch(indexUrl);
  if (!res.ok) throw new Error(`Marketplace fetch failed: ${res.status}`);

  const raw = await res.json() as unknown;
  const entries = parseIndex(raw);

  cache = { data: entries, fetchedAt: Date.now() };
  return entries;
}

/** Fetch manifest + source for a single plugin by its base URL. */
export async function fetchPluginPackage(baseUrl: string): Promise<{
  readonly manifest: unknown;
  readonly source:   string;
}> {
  const normalised = baseUrl.replace(/\/$/, '');

  const [manifestRes, srcRes] = await Promise.all([
    fetch(`${normalised}/manifest.json`),
    fetch(`${normalised}/index.js`),
  ]);

  if (!manifestRes.ok) throw new Error(`manifest not found at ${normalised}/manifest.json`);
  if (!srcRes.ok)      throw new Error(`source not found at ${normalised}/index.js`);

  const manifest = await manifestRes.json() as unknown;
  const source   = await srcRes.text();

  return { manifest, source };
}

function parseIndex(raw: unknown): readonly MarketplaceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMarketplaceEntry);
}

function isMarketplaceEntry(v: unknown): v is MarketplaceEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['id']          === 'string' &&
    typeof e['name']        === 'string' &&
    typeof e['description'] === 'string' &&
    typeof e['version']     === 'string' &&
    typeof e['author']      === 'string' &&
    typeof e['baseUrl']     === 'string'
  );
}

export function clearMarketplaceCache(): void { cache = null; }
