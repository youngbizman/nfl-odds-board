import fs from 'node:fs';
import { BoardStore } from '../src/store.js';
import { Metrics } from '../src/metrics.js';

export const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
export const quiet = () => {};
export function fresh() { return { store: new BoardStore(), metrics: new Metrics() }; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it returns truthy or the time runs out. */
export async function waitFor(fn, ms = 3000, step = 20) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`waitFor timed out after ${ms} ms`); await sleep(step); }
}
export const quotesOf = (store, book) => [...store.quotes.values()].filter((q) => q.book === book);
