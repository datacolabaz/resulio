import { AI_PRICE_FALLBACK_MODEL } from "../../shared/aiUsage";
import { aiModelPrices } from "../../drizzle/schema";
import { requireDb } from "../db";

export type ModelPrice = { inputUsdPerMillion: number; outputUsdPerMillion: number };
export type PriceTable = Map<string, ModelPrice>;

const CACHE_MS = 60_000;
let cache: { at: number; prices: PriceTable } | null = null;

/** The model's own row, else a row for its base name ("models/gemini-x" → "gemini-x"), else "*"; null = unpriced. */
export function priceFor(prices: PriceTable, model: string): ModelPrice | null {
  const name = model.trim().toLowerCase();
  return prices.get(name) ?? prices.get(name.replace(/^models\//, "")) ?? prices.get(AI_PRICE_FALLBACK_MODEL) ?? null;
}

/** Prices for cost at log time; cached for a minute so logging adds no query per call. */
export async function loadPrices(now = Date.now()): Promise<PriceTable> {
  if (cache && now - cache.at < CACHE_MS) return cache.prices;
  const rows = await requireDb().select().from(aiModelPrices);
  const prices: PriceTable = new Map(rows.map((r) => [r.model.trim().toLowerCase(), { inputUsdPerMillion: r.inputUsdPerMillion, outputUsdPerMillion: r.outputUsdPerMillion }]));
  cache = { at: now, prices };
  return prices;
}

export function clearPriceCache() {
  cache = null;
}
