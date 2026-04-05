import { GroupRow, NormalizedCard, ProductRow } from "../types";

const CHUNK_SIZE_IN = 100; // D1 bind-parameter safe for IN (...) lists

interface ScryfallBridgeRow {
  scryfall_id: string;
  product_id: number | null;
  etched_product_id: number | null;
}

export interface RowDirectMatch {
  product: ProductRow;
  printingId: number;
}

export async function batchFetchScryfallBridge(
  db: D1Database,
  scryfallIds: string[],
): Promise<Map<string, ScryfallBridgeRow>> {
  if (scryfallIds.length === 0) return new Map();
  const unique = [...new Set(scryfallIds)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE_IN) {
    const chunk = unique.slice(i, i + CHUNK_SIZE_IN);
    const placeholders = chunk.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `SELECT scryfall_id, product_id, etched_product_id FROM scryfall_bridge WHERE scryfall_id IN (${placeholders})`,
        )
        .bind(...chunk),
    );
  }
  const batchResults = await db.batch(statements);
  const out = new Map<string, ScryfallBridgeRow>();
  for (const result of batchResults) {
    for (const row of result.results as unknown as ScryfallBridgeRow[]) {
      out.set(row.scryfall_id, row);
    }
  }
  return out;
}

export async function batchFetchProductsByProductIds(
  db: D1Database,
  productIds: number[],
): Promise<Map<number, ProductRow>> {
  if (productIds.length === 0) return new Map();
  const unique = [...new Set(productIds)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE_IN) {
    const chunk = unique.slice(i, i + CHUNK_SIZE_IN);
    const placeholders = chunk.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `SELECT product_id, group_id, name, clean_name, image_url, rarity_id, collector_number
         FROM products WHERE product_id IN (${placeholders})`,
        )
        .bind(...chunk),
    );
  }
  const batchResults = await db.batch(statements);
  const out = new Map<number, ProductRow>();
  for (const result of batchResults) {
    for (const p of result.results as unknown as ProductRow[]) {
      out.set(p.product_id, p);
    }
  }
  return out;
}

export async function batchFetchGroupsByIds(
  db: D1Database,
  groupIds: number[],
): Promise<Map<number, GroupRow>> {
  if (groupIds.length === 0) return new Map();
  const unique = [...new Set(groupIds)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE_IN) {
    const chunk = unique.slice(i, i + CHUNK_SIZE_IN);
    const placeholders = chunk.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `SELECT group_id, name, abbr, is_current FROM groups WHERE group_id IN (${placeholders})`,
        )
        .bind(...chunk),
    );
  }
  const batchResults = await db.batch(statements);
  const out = new Map<number, GroupRow>();
  for (const result of batchResults) {
    for (const g of result.results as unknown as GroupRow[]) {
      out.set(g.group_id, g);
    }
  }
  return out;
}

export function resolveProductFromBridge(
  br: ScryfallBridgeRow,
  card: NormalizedCard,
): { productId: number; printingId: number } | null {
  if (card.isEtched && br.etched_product_id != null) {
    // MTGJSON SKUs model foil etched as printing_id=2.
    return { productId: br.etched_product_id, printingId: 2 };
  }
  if (card.isEtched && br.product_id != null) {
    return { productId: br.product_id, printingId: 2 };
  }
  if (card.isFoil && !card.isEtched && br.product_id != null) {
    return { productId: br.product_id, printingId: 2 };
  }
  if (!card.isFoil && br.product_id != null) {
    return { productId: br.product_id, printingId: 1 };
  }
  return null;
}
