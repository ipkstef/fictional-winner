import { SkuRow } from "../types";

const CHUNK_SIZE_SKUS = 25; // 4 params per item (D1 limit is 100)

export function makeSkuKey(
  productId: number,
  printingId: number,
  conditionId: number,
  languageId: number,
): string {
  return `${productId}:${printingId}:${conditionId}:${languageId}`;
}

/**
 * Batch fetch SKUs by (product_id, printing_id, condition_id, language_id) tuples.
 */
export async function batchFetchSkus(
  db: D1Database,
  keys: Array<{
    productId: number;
    printingId: number;
    conditionId: number;
    languageId: number;
  }>,
): Promise<Map<string, SkuRow>> {
  if (keys.length === 0) return new Map();

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE_SKUS) {
    const chunk = keys.slice(i, i + CHUNK_SIZE_SKUS);
    const conditions = chunk
      .map(
        () =>
          "(product_id = ? AND printing_id = ? AND condition_id = ? AND language_id = ?)",
      )
      .join(" OR ");
    const params = chunk.flatMap((k) => [
      k.productId,
      k.printingId,
      k.conditionId,
      k.languageId,
    ]);
    statements.push(
      db
        .prepare(
          `SELECT sku_id, product_id, language_id, printing_id, condition_id,
                low_price_cents, mid_price_cents, high_price_cents, market_price_cents, direct_low_price_cents
         FROM skus WHERE ${conditions}`,
        )
        .bind(...params),
    );
  }

  const batchResults = await db.batch(statements);
  const results = new Map<string, SkuRow>();
  for (const result of batchResults) {
    for (const s of result.results as SkuRow[]) {
      results.set(
        makeSkuKey(s.product_id, s.printing_id, s.condition_id, s.language_id),
        s,
      );
    }
  }
  return results;
}
