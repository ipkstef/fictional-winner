import { parseCSV, toCSV, toGenericCSV } from './csv';
import {
  InputRow,
  OutputRow,
  GroupRow,
  ProductRow,
  SkuRow,
  NormalizedCard,
  ProductLookupHints,
  CONDITION_MAP,
  LANGUAGE_MAP,
  RARITY_MAP,
  CONDITION_NAMES,
} from './types';
import { normalizeManaBoxRow } from './manabox';

export interface Env {
  DB: D1Database;
  CATEGORY_ID: string;
}

/**
 * Format price from cents to dollars string
 */
function formatPrice(cents: number | null): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

/**
 * Normalize a card name to match TCGPlayer's clean_name format
 * Strips diacritics, hyphens→spaces, removes apostrophes/punctuation
 */
function cleanName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect special/supplemental product types that share collector numbers
 * with regular cards (Theme Cards, Minigames, Helper Cards, Emblems)
 */
function isSpecialProduct(name: string): boolean {
  return name.includes('Theme Card') ||
         name.includes('Magic Minigame:') ||
         name.includes('Helper Card') ||
         name.startsWith('Emblem -') ||
         name.startsWith('Emblem:') ||
         name.includes('(Step-and-Compleat Foil)') ||
         name.includes('(Concept Praetor)') ||
         name.includes('(Surge Foil)') ||
         name.includes('(Serial Numbered)') ||
         name.includes('- Thick Stock');
}

/**
 * Select the preferred product when multiple candidates exist
 * Uses hints about token/foil status to pick the right variant
 */
function selectPreferredProduct(
  existing: ProductRow | undefined,
  candidate: ProductRow,
  hints: ProductLookupHints
): ProductRow {
  if (!existing) return candidate;

  const existingIsSpecial = isSpecialProduct(existing.name);
  const candidateIsSpecial = isSpecialProduct(candidate.name);

  // Always prefer non-special products over special ones (Theme Card, Minigame, etc.)
  if (existingIsSpecial && !candidateIsSpecial) return candidate;
  if (!existingIsSpecial && candidateIsSpecial) return existing;

  const existingIsToken = existing.name.includes('Token');
  const candidateIsToken = candidate.name.includes('Token');
  const existingIsRainbowFoil = existing.name.includes('(Rainbow Foil)');
  const candidateIsRainbowFoil = candidate.name.includes('(Rainbow Foil)');

  // Token preference: prefer token if we want token, non-token otherwise
  if (hints.isToken && candidateIsToken && !existingIsToken) return candidate;
  if (!hints.isToken && !candidateIsToken && existingIsToken) return candidate;

  // Rainbow Foil preference (for SLD etc): prefer rainbow foil if we want foil
  if (hints.isFoil && candidateIsRainbowFoil && !existingIsRainbowFoil) return candidate;
  if (!hints.isFoil && !candidateIsRainbowFoil && existingIsRainbowFoil) return candidate;

  return existing;
}

// D1 limit is 100 bound parameters per query
// Use db.batch() to execute multiple statements in a single round-trip
const CHUNK_SIZE_GROUPS = 100;  // 1 param per item
const CHUNK_SIZE_PRODUCTS = 50; // 2 params per item
const CHUNK_SIZE_SKUS = 25;     // 4 params per item

/**
 * Batch fetch groups by set code abbreviations
 * Uses db.batch() for single round-trip, respects 100 param limit
 */
async function batchFetchGroups(
  db: D1Database,
  setCodes: string[]
): Promise<Map<string, GroupRow>> {
  if (setCodes.length === 0) return new Map();

  // Build all prepared statements
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < setCodes.length; i += CHUNK_SIZE_GROUPS) {
    const chunk = setCodes.slice(i, i + CHUNK_SIZE_GROUPS);
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(
      db.prepare(`SELECT group_id, name, abbr, is_current FROM groups WHERE abbr IN (${placeholders})`)
        .bind(...chunk)
    );
  }

  // Execute all in single round-trip
  const batchResults = await db.batch(statements);

  const results = new Map<string, GroupRow>();
  for (const result of batchResults) {
    for (const g of result.results as GroupRow[]) {
      results.set(g.abbr, g);
    }
  }
  return results;
}

/**
 * Batch fetch products by (group_id, collector_number) pairs
 * Uses db.batch() for single round-trip, respects 100 param limit
 * Applies hints to select preferred product when multiple match
 */
async function batchFetchProducts(
  db: D1Database,
  keys: Array<{ groupId: number; collectorNumber: string; hints: ProductLookupHints }>
): Promise<Map<string, ProductRow>> {
  if (keys.length === 0) return new Map();

  // Build all prepared statements
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE_PRODUCTS) {
    const chunk = keys.slice(i, i + CHUNK_SIZE_PRODUCTS);
    const conditions = chunk.map(() => '(group_id = ? AND collector_number = ?)').join(' OR ');
    const params = chunk.flatMap((k) => [k.groupId, k.collectorNumber]);
    statements.push(
      db.prepare(
        `SELECT product_id, group_id, name, clean_name, image_url, rarity_id, collector_number
         FROM products WHERE ${conditions}`
      ).bind(...params)
    );
  }

  // Execute all in single round-trip
  const batchResults = await db.batch(statements);

  // Build a map of hints by key for product selection
  const hintsMap = new Map<string, ProductLookupHints>();
  for (const k of keys) {
    hintsMap.set(`${k.groupId}:${k.collectorNumber}`, k.hints);
  }

  const results = new Map<string, ProductRow>();
  for (const result of batchResults) {
    for (const p of result.results as ProductRow[]) {
      const baseKey = `${p.group_id}:${p.collector_number}`;
      const isRF = p.name.includes('(Rainbow Foil)');
      const key = isRF ? `${baseKey}:rf` : baseKey;
      const hints = hintsMap.get(baseKey) || { isToken: false, isFoil: false };
      const existing = results.get(key);
      results.set(key, selectPreferredProduct(existing, p, hints));
    }
  }
  return results;
}

/**
 * Batch fetch products for LIST cards by name
 * This is the primary lookup strategy for LIST since collector number prefix is ambiguous
 */
async function batchFetchProductsByName(
  db: D1Database,
  keys: Array<{ groupId: number; name: string; hints: ProductLookupHints }>
): Promise<Map<string, ProductRow>> {
  if (keys.length === 0) return new Map();

  // Build all prepared statements
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE_PRODUCTS) {
    const chunk = keys.slice(i, i + CHUNK_SIZE_PRODUCTS);
    const conditions = chunk.map(() => '(group_id = ? AND clean_name = ?)').join(' OR ');
    const params = chunk.flatMap((k) => [k.groupId, cleanName(k.name)]);
    statements.push(
      db.prepare(
        `SELECT product_id, group_id, name, clean_name, image_url, rarity_id, collector_number
         FROM products WHERE ${conditions}`
      ).bind(...params)
    );
  }

  // Execute all in single round-trip
  const batchResults = await db.batch(statements);

  // Build a map of hints by name for product selection
  const hintsMap = new Map<string, ProductLookupHints>();
  for (const k of keys) {
    hintsMap.set(`${k.groupId}:name:${cleanName(k.name)}`, k.hints);
  }

  const results = new Map<string, ProductRow>();
  for (const result of batchResults) {
    for (const p of result.results as ProductRow[]) {
      const key = `${p.group_id}:name:${p.clean_name}`;
      const hints = hintsMap.get(key) || { isToken: false, isFoil: false };
      const existing = results.get(key);
      results.set(key, selectPreferredProduct(existing, p, hints));
    }
  }
  return results;
}

/**
 * Batch fetch products for LIST cards by collector number prefix
 * ManaBox PLST format: "RNA-253" → TCGPlayer LIST: "253/259"
 * Uses LIKE query to match collector_number starting with the parsed number
 * NOTE: This is a fallback - prefer batchFetchProductsByName for LIST
 */
async function batchFetchProductsByCollectorPrefix(
  db: D1Database,
  keys: Array<{ groupId: number; collectorPrefix: string; hints: ProductLookupHints }>
): Promise<Map<string, ProductRow>> {
  if (keys.length === 0) return new Map();

  // Build all prepared statements
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE_PRODUCTS) {
    const chunk = keys.slice(i, i + CHUNK_SIZE_PRODUCTS);
    const conditions = chunk.map(() => '(group_id = ? AND collector_number LIKE ?)').join(' OR ');
    const params = chunk.flatMap((k) => [k.groupId, `${k.collectorPrefix}/%`]);
    statements.push(
      db.prepare(
        `SELECT product_id, group_id, name, clean_name, image_url, rarity_id, collector_number
         FROM products WHERE ${conditions}`
      ).bind(...params)
    );
  }

  // Execute all in single round-trip
  const batchResults = await db.batch(statements);

  // Build a map of hints by prefix for product selection
  const hintsMap = new Map<string, ProductLookupHints>();
  for (const k of keys) {
    hintsMap.set(`${k.groupId}:prefix:${k.collectorPrefix}`, k.hints);
  }

  const results = new Map<string, ProductRow>();
  for (const result of batchResults) {
    for (const p of result.results as ProductRow[]) {
      // Extract prefix from collector_number (e.g., "253/259" → "253")
      const prefix = p.collector_number?.split('/')[0] || '';
      const key = `${p.group_id}:prefix:${prefix}`;
      const hints = hintsMap.get(key) || { isToken: false, isFoil: false };
      const existing = results.get(key);
      results.set(key, selectPreferredProduct(existing, p, hints));
    }
  }
  return results;
}

/**
 * Batch fetch SKUs by (product_id, printing_id, condition_id, language_id) tuples
 * Uses db.batch() for single round-trip, respects 100 param limit
 */
async function batchFetchSkus(
  db: D1Database,
  keys: Array<{ productId: number; printingId: number; conditionId: number; languageId: number }>
): Promise<Map<string, SkuRow>> {
  if (keys.length === 0) return new Map();

  // Build all prepared statements
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE_SKUS) {
    const chunk = keys.slice(i, i + CHUNK_SIZE_SKUS);
    const conditions = chunk
      .map(() => '(product_id = ? AND printing_id = ? AND condition_id = ? AND language_id = ?)')
      .join(' OR ');
    const params = chunk.flatMap((k) => [k.productId, k.printingId, k.conditionId, k.languageId]);
    statements.push(
      db.prepare(
        `SELECT sku_id, product_id, language_id, printing_id, condition_id,
                low_price_cents, mid_price_cents, high_price_cents, market_price_cents, direct_low_price_cents
         FROM skus WHERE ${conditions}`
      ).bind(...params)
    );
  }

  // Execute all in single round-trip
  const batchResults = await db.batch(statements);

  const results = new Map<string, SkuRow>();
  for (const result of batchResults) {
    for (const s of result.results as SkuRow[]) {
      results.set(`${s.product_id}:${s.printing_id}:${s.condition_id}:${s.language_id}`, s);
    }
  }
  return results;
}

/**
 * Process input CSV and return matched output CSV
 * Uses batch queries for optimal performance (~3-10 queries instead of 800+)
 * Queries are chunked to stay within SQLite's 999 parameter limit
 */
async function processCSV(csvText: string, env: Env): Promise<{ csv: string; stats: ProcessingStats }> {
  const inputRows = parseCSV(csvText);
  const errors: string[] = [];
  const failedRows: FailedRow[] = [];

  // Helper to record a failure
  const recordFailure = (row: InputRow, reason: string) => {
    errors.push(reason);
    failedRows.push({
      Name: row['Name'] || '',
      'Set code': row['Set code'] || '',
      'Collector number': row['Collector number'] || '',
      Quantity: row['Quantity'] || '1',
      Condition: row['Condition'] || '',
      Foil: row['Foil'] || '',
      Language: row['Language'] || '',
      'Failure Reason': reason,
    });
  };

  // Step 1: Normalize all input rows to NormalizedCard format
  const normalizedCards: NormalizedCard[] = inputRows.map((row: InputRow) => normalizeManaBoxRow(row));

  // Step 2: Extract unique set codes and batch fetch all groups
  const setCodes = [...new Set(normalizedCards.map((c) => c.setCode).filter((s): s is string => Boolean(s)))];
  const groupMap = await batchFetchGroups(env.DB, setCodes);

  // Step 3: Build product lookup keys and batch fetch products
  // LIST cards use name-based lookup (primary) + collector prefix (fallback)
  // Other sets use exact collector number lookup
  const productKeys: Array<{ groupId: number; collectorNumber: string; hints: ProductLookupHints }> = [];
  const listNameKeys: Array<{ groupId: number; name: string; hints: ProductLookupHints }> = [];
  const listPrefixKeys: Array<{ groupId: number; collectorPrefix: string; hints: ProductLookupHints }> = [];
  const rowProductKeys: Array<{ primary: string | null; fallback: string | null; nameFallback?: string | null }> = [];

  for (const card of normalizedCards) {
    if (!card.setCode) {
      rowProductKeys.push({ primary: null, fallback: null });
      continue;
    }

    const group = groupMap.get(card.setCode);
    if (!group) {
      rowProductKeys.push({ primary: null, fallback: null });
      continue;
    }

    const hints: ProductLookupHints = { isToken: card.isToken, isFoil: card.isFoil };

    // Sets requiring name-based product lookup
    const useNameLookup = card.setCode === 'LIST' ||
                          card.setCode === 'MB2PC' ||
                          card.originalSetCode === 'SUNF';

    if (useNameLookup) {
      const nameKey = card.name ? `${group.group_id}:name:${cleanName(card.name)}` : null;

      if (card.name) {
        listNameKeys.push({ groupId: group.group_id, name: card.name, hints });
      }

      if (card.setCode === 'LIST') {
        // LIST: prefix fallback (existing behavior unchanged)
        const prefixKey = card.collectorNumber
          ? `${group.group_id}:prefix:${card.collectorNumber}` : null;
        if (card.collectorNumber) {
          listPrefixKeys.push({
            groupId: group.group_id, collectorPrefix: card.collectorNumber, hints
          });
        }
        rowProductKeys.push({ primary: nameKey, fallback: prefixKey });
      } else {
        // MB2PC/SUNF: name only, no fallback
        rowProductKeys.push({ primary: nameKey, fallback: null });
      }
    } else {
      // All other sets: use exact collector number lookup
      if (!card.collectorNumber) {
        rowProductKeys.push({ primary: null, fallback: null });
        continue;
      }
      const baseKey = `${group.group_id}:${card.collectorNumber}`;
      const rfKey = `${baseKey}:rf`;
      // Foil cards prefer Rainbow Foil product; non-foil cards prefer regular product
      if (card.isFoil) {
        rowProductKeys.push({ primary: rfKey, fallback: baseKey });
      } else {
        rowProductKeys.push({ primary: baseKey, fallback: rfKey });
      }
      productKeys.push({ groupId: group.group_id, collectorNumber: card.collectorNumber, hints });
    }
  }

  // Deduplicate and fetch products by collector number
  const uniqueProductKeys = Array.from(
    new Map(productKeys.map((k) => [`${k.groupId}:${k.collectorNumber}`, k])).values()
  );
  const productMap = await batchFetchProducts(env.DB, uniqueProductKeys);

  // Deduplicate and fetch products by name (for LIST - primary strategy)
  const uniqueNameKeys = Array.from(
    new Map(listNameKeys.map((k) => [`${k.groupId}:name:${k.name}`, k])).values()
  );
  const productNameMap = await batchFetchProductsByName(env.DB, uniqueNameKeys);

  // Deduplicate and fetch products by collector prefix (for LIST - fallback)
  const uniquePrefixKeys = Array.from(
    new Map(listPrefixKeys.map((k) => [`${k.groupId}:prefix:${k.collectorPrefix}`, k])).values()
  );
  const productPrefixMap = await batchFetchProductsByCollectorPrefix(env.DB, uniquePrefixKeys);

  // Merge all maps into productMap
  for (const [key, value] of productNameMap) {
    productMap.set(key, value);
  }
  for (const [key, value] of productPrefixMap) {
    productMap.set(key, value);
  }

  // Name-based fallback for rows where collector number lookup found nothing
  // Handles sets like Ice Age where TCGPlayer products have NULL collector numbers
  const nameFallbackKeys: Array<{ groupId: number; name: string; hints: ProductLookupHints }> = [];
  for (let i = 0; i < normalizedCards.length; i++) {
    const card = normalizedCards[i];
    const keys = rowProductKeys[i];

    // Skip if we already have a product match
    if (keys.primary && productMap.has(keys.primary)) continue;
    if (keys.fallback && productMap.has(keys.fallback)) continue;

    // Skip rows without a valid group or name
    if (!card.setCode || !card.name) continue;
    const group = groupMap.get(card.setCode);
    if (!group) continue;

    // Skip sets that already use name-based lookup
    const usesNameLookup = card.setCode === 'LIST' || card.setCode === 'MB2PC' || card.originalSetCode === 'SUNF';
    if (usesNameLookup) continue;

    const nameKey = `${group.group_id}:name:${cleanName(card.name)}`;
    nameFallbackKeys.push({ groupId: group.group_id, name: card.name, hints: { isToken: card.isToken, isFoil: card.isFoil } });
    rowProductKeys[i] = { primary: keys.primary, fallback: keys.fallback, nameFallback: nameKey };
  }

  if (nameFallbackKeys.length > 0) {
    const uniqueFallbackKeys = Array.from(
      new Map(nameFallbackKeys.map((k) => [`${k.groupId}:name:${k.name}`, k])).values()
    );
    const nameFallbackMap = await batchFetchProductsByName(env.DB, uniqueFallbackKeys);
    for (const [key, value] of nameFallbackMap) {
      productMap.set(key, value);
    }
  }

  // Helper to resolve product key (try primary, then fallback, then name fallback)
  const resolveProductKey = (keys: { primary: string | null; fallback: string | null; nameFallback?: string | null }): string | null => {
    if (keys.primary && productMap.has(keys.primary)) return keys.primary;
    if (keys.fallback && productMap.has(keys.fallback)) return keys.fallback;
    if (keys.nameFallback && productMap.has(keys.nameFallback)) return keys.nameFallback;
    return keys.primary || keys.fallback; // Return for error messages
  };

  // Step 4: Build SKU lookup keys and batch fetch SKUs
  const skuKeys: Array<{ productId: number; printingId: number; conditionId: number; languageId: number }> = [];
  const rowSkuKeys: Array<string | null> = []; // Track which SKU key each row maps to

  for (let i = 0; i < normalizedCards.length; i++) {
    const card = normalizedCards[i];
    const productKeyInfo = rowProductKeys[i];
    const productKey = resolveProductKey(productKeyInfo);

    if (!productKey) {
      rowSkuKeys.push(null);
      continue;
    }

    const product = productMap.get(productKey);
    if (!product) {
      rowSkuKeys.push(null);
      continue;
    }

    const printingId = card.isFoil ? 2 : 1;
    const conditionId = CONDITION_MAP[card.condition.toLowerCase()] || 1;
    const languageId = LANGUAGE_MAP[card.language.toLowerCase()] || 1;

    const key = `${product.product_id}:${printingId}:${conditionId}:${languageId}`;
    rowSkuKeys.push(key);
    skuKeys.push({ productId: product.product_id, printingId, conditionId, languageId });
  }

  // Deduplicate SKU keys
  const uniqueSkuKeys = Array.from(
    new Map(
      skuKeys.map((k) => [`${k.productId}:${k.printingId}:${k.conditionId}:${k.languageId}`, k])
    ).values()
  );
  const skuMap = await batchFetchSkus(env.DB, uniqueSkuKeys);

  // Step 5: Build output rows with aggregation
  const aggregated = new Map<
    string,
    { output: OutputRow; quantity: number; totalPrice: number; count: number }
  >();

  for (let i = 0; i < inputRows.length; i++) {
    const row = inputRows[i];
    const card = normalizedCards[i];

    // Validate required fields
    if (!card.setCode) {
      recordFailure(row, 'Missing set code');
      continue;
    }

    // Check group
    const group = groupMap.get(card.setCode);
    if (!group) {
      recordFailure(row, `No group found for set code '${card.setCode}'`);
      continue;
    }

    // Check product
    const productKeyInfo = rowProductKeys[i];
    const productKey = resolveProductKey(productKeyInfo);
    if (!productKey) {
      const identifier = card.name || `#${card.collectorNumber}`;
      recordFailure(row, `No product key for ${card.setCode} ${identifier}`);
      continue;
    }
    const product = productMap.get(productKey);
    if (!product) {
      const identifier = card.name || `#${card.collectorNumber}`;
      recordFailure(row, `No product found for ${card.setCode} ${identifier}`);
      continue;
    }

    // Check SKU
    const skuKey = rowSkuKeys[i];
    if (!skuKey) {
      const printingId = card.isFoil ? 2 : 1;
      const conditionId = CONDITION_MAP[card.condition.toLowerCase()] || 1;
      const languageId = LANGUAGE_MAP[card.language.toLowerCase()] || 1;
      recordFailure(row, `No SKU for ${product.name} (printing=${printingId}, condition=${conditionId}, lang=${languageId})`);
      continue;
    }
    const sku = skuMap.get(skuKey);
    if (!sku) {
      const printingId = card.isFoil ? 2 : 1;
      const conditionId = CONDITION_MAP[card.condition.toLowerCase()] || 1;
      const languageId = LANGUAGE_MAP[card.language.toLowerCase()] || 1;
      recordFailure(row, `No SKU for ${product.name} (printing=${printingId}, condition=${conditionId}, lang=${languageId})`);
      continue;
    }

    // Build condition string (e.g., "Near Mint Foil")
    const printingId = card.isFoil ? 2 : 1;
    const conditionId = CONDITION_MAP[card.condition.toLowerCase()] || 1;

    let conditionStr = CONDITION_NAMES[conditionId] || 'Near Mint';
    if (printingId === 2) {
      conditionStr += ' Foil';
    }

    // Use input price or fallback to market price
    const marketPrice = formatPrice(sku.market_price_cents);
    const price = card.purchasePrice || marketPrice;

    // Aggregate by SKU key
    const existing = aggregated.get(skuKey);
    if (existing) {
      existing.quantity += card.quantity;
      existing.count += 1;
      const priceNum = parseFloat(price) || 0;
      existing.totalPrice += priceNum * card.quantity;
    } else {
      const output: OutputRow = {
        'TCGplayer Id': sku.sku_id.toString(),
        'Product Line': 'Magic',
        'Set Name': group.name,
        'Product Name': product.name,
        Title: '',
        Number: card.originalCollectorNumber,
        Rarity: RARITY_MAP[product.rarity_id || 0] || '',
        Condition: conditionStr,
        'TCG Market Price': marketPrice,
        'TCG Direct Low': formatPrice(sku.direct_low_price_cents),
        'TCG Low Price With Shipping': formatPrice(sku.mid_price_cents),
        'TCG Low Price': formatPrice(sku.low_price_cents),
        'Total Quantity': card.quantity.toString(),
        'Add to Quantity': card.quantity.toString(),
        'TCG Marketplace Price': price,
        'Photo URL': product.image_url || '',
      };

      aggregated.set(skuKey, {
        output,
        quantity: card.quantity,
        totalPrice: (parseFloat(price) || 0) * card.quantity,
        count: 1,
      });
    }
  }

  // Build final output rows
  const outputRows: OutputRow[] = [];
  for (const { output, quantity, totalPrice, count } of aggregated.values()) {
    output['Total Quantity'] = quantity.toString();
    output['Add to Quantity'] = quantity.toString();
    // Average price per unit if aggregated
    if (count > 1 && totalPrice > 0) {
      output['TCG Marketplace Price'] = (totalPrice / quantity).toFixed(2);
    }
    outputRows.push(output);
  }

  // Build failures CSV
  const failuresCsv = failedRows.length > 0 ? toGenericCSV(failedRows) : '';

  return {
    csv: toCSV(outputRows),
    stats: {
      inputRows: inputRows.length,
      matchedRows: outputRows.length,
      aggregatedFrom: Array.from(aggregated.values()).reduce((sum, v) => sum + v.count, 0),
      errors: errors.length,
      sampleErrors: errors.slice(0, 5),
      failuresCsv,
    },
  };
}

interface FailedRow {
  Name: string;
  'Set code': string;
  'Collector number': string;
  Quantity: string;
  Condition: string;
  Foil: string;
  Language: string;
  'Failure Reason': string;
}

interface ProcessingStats {
  inputRows: number;
  matchedRows: number;
  aggregatedFrom: number;
  errors: number;
  sampleErrors: string[];
  failuresCsv: string;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate the base layout HTML
 */
function getLayoutHtml(title: string, content: string, additionalStyles: string = '', scripts: string = ''): string {
  const currentYear = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
    <style>
        body {
            background-color: #f8f9fa;
            padding-top: 2rem;
            padding-bottom: 2rem;
        }
        .card {
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            margin-bottom: 1.5rem;
        }
        .card-header {
            background-color: #563d7c;
            color: white;
            border-radius: 10px 10px 0 0 !important;
        }
        .btn-primary {
            background-color: #563d7c;
            border-color: #563d7c;
        }
        .btn-primary:hover {
            background-color: #452d6b;
            border-color: #452d6b;
        }
        .header-icon {
            font-size: 1.5rem;
            margin-right: 0.5rem;
        }
        .footer {
            font-size: 0.8rem;
            color: #6c757d;
            text-align: center;
            margin-top: 2rem;
        }
        ${additionalStyles}
    </style>
</head>
<body>
    <div class="container">
        <div class="row justify-content-center">
            <div class="col-md-8">
                ${content}

                <div class="footer">
                    <p>MTG CSV Processor &copy; | YourFriendsHouseCo ${currentYear}</p>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    ${scripts}
</body>
</html>`;
}

/**
 * Generate the main index page HTML
 */
function getIndexHtml(): string {
  const additionalStyles = `
.nav-tabs .nav-link {
    border-radius: 10px 10px 0 0;
    font-weight: 500;
}
.nav-tabs .nav-link.active {
    background-color: #563d7c;
    color: white;
    border-color: #563d7c;
}
.paste-area {
    min-height: 150px;
    font-family: monospace;
    white-space: pre;
}
.form-label .device-icon {
    margin-right: 6px;
}
@media (max-width: 768px) {
    .mobile-preferred {
        order: -1;
    }
}
.format-note {
    background-color: #f8f9fa;
    border-left: 4px solid #563d7c;
    padding: 0.75rem;
    margin: 1rem 0;
    font-size: 0.85rem;
}`;

  const content = `
<div class="card mb-4">
    <div class="card-header">
        <span class="header-icon">&#129497;</span> MTG CSV Processor
    </div>
    <div class="card-body">
        <h5 class="card-title">ManaBox to TCGPlayer Converter</h5>
        <p class="card-text">
            Convert your ManaBox CSV export to TCGPlayer format.
            The application will process your data and generate a CSV ready for TCGPlayer upload.
        </p>

        <div class="format-note">
            <strong>Tip:</strong> Use file upload on desktop for auto-download, or paste CSV on mobile to copy the result.
        </div>

        <!-- Input Method Tabs -->
        <ul class="nav nav-tabs mb-3" id="inputMethodTabs" role="tablist">
            <li class="nav-item" role="presentation">
                <button class="nav-link active" id="upload-tab" data-bs-toggle="tab" data-bs-target="#upload-tab-pane" type="button" role="tab" aria-controls="upload-tab-pane" aria-selected="true">
                    <i class="bi bi-upload"></i> Upload File
                </button>
            </li>
            <li class="nav-item mobile-preferred" role="presentation">
                <button class="nav-link" id="paste-tab" data-bs-toggle="tab" data-bs-target="#paste-tab-pane" type="button" role="tab" aria-controls="paste-tab-pane" aria-selected="false">
                    <i class="bi bi-clipboard"></i> Paste CSV
                </button>
            </li>
        </ul>

        <!-- Tab Content -->
        <div class="tab-content" id="inputMethodTabsContent">
            <!-- Upload File Tab -->
            <div class="tab-pane fade show active" id="upload-tab-pane" role="tabpanel" aria-labelledby="upload-tab" tabindex="0">
                <form action="/convert" method="post" enctype="multipart/form-data" class="mt-4">
                    <input type="hidden" name="mode" value="upload">
                    <div class="mb-3">
                        <label for="file" class="form-label">
                            <i class="bi bi-laptop device-icon"></i>Select ManaBox CSV file:
                        </label>
                        <input class="form-control" type="file" id="file" name="file" accept=".csv">
                        <div class="form-text">Only CSV files are supported.</div>
                    </div>
                    <button type="submit" class="btn btn-primary">
                        <i class="bi bi-upload"></i> Upload and Process
                    </button>
                </form>
            </div>

            <!-- Paste CSV Tab -->
            <div class="tab-pane fade" id="paste-tab-pane" role="tabpanel" aria-labelledby="paste-tab" tabindex="0">
                <form action="/convert" method="post" class="mt-4">
                    <input type="hidden" name="mode" value="paste">
                    <div class="mb-3">
                        <label for="csv_content" class="form-label">
                            <i class="bi bi-phone device-icon"></i>Paste ManaBox CSV content:
                        </label>
                        <textarea class="form-control paste-area" id="csv_content" name="csv_content" rows="10" placeholder="Paste your CSV content here..."></textarea>
                        <div class="form-text">First row should contain headers (Name,Scryfall ID,Quantity,etc.)</div>
                    </div>
                    <button type="submit" class="btn btn-primary">
                        <i class="bi bi-clipboard-check"></i> Process CSV
                    </button>
                </form>
            </div>
        </div>

    </div>
</div>

<div class="card">
    <div class="card-header">
        <span class="header-icon">&#8505;&#65039;</span> Instructions
    </div>
    <div class="card-body">
        <div class="row">
            <div class="col-md-6">
                <h6><i class="bi bi-laptop"></i> Desktop Users</h6>
                <ol class="list-group list-group-numbered mb-3">
                    <li class="list-group-item">Export your collection from ManaBox as CSV</li>
                    <li class="list-group-item">Select "Upload File" tab</li>
                    <li class="list-group-item">Choose your CSV file and upload</li>
                    <li class="list-group-item">CSV auto-downloads when ready</li>
                </ol>
            </div>
            <div class="col-md-6">
                <h6><i class="bi bi-phone"></i> Mobile Users</h6>
                <ol class="list-group list-group-numbered mb-0">
                    <li class="list-group-item">Export your collection from ManaBox as CSV</li>
                    <li class="list-group-item">Open the CSV and copy all content</li>
                    <li class="list-group-item">Select "Paste CSV" tab and paste</li>
                    <li class="list-group-item">Copy the processed CSV output</li>
                </ol>
            </div>
        </div>
    </div>
</div>

<!-- Status badge -->
<div class="text-center mt-4">
    <a href="https://github.com/ipkstef/fictional-winner">
        <img src="https://github.com/ipkstef/fictional-winner/actions/workflows/sync-r2-to-d1.yml/badge.svg" alt="Sync R2 to D1">
    </a>
</div>
<!-- Ko-fi support link -->
<div class="text-center mt-3">
    <a href="https://ko-fi.com/mtgsold" target="_blank" rel="noopener noreferrer">
        <img src="https://storage.ko-fi.com/cdn/logomarkLogo.png" alt="Support on Ko-fi" style="width:80px; height:auto;">
    </a>
</div>`;

  const scripts = `
<script>
    // Auto-select the appropriate tab based on device
    document.addEventListener('DOMContentLoaded', function() {
        const isMobile = window.innerWidth < 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (isMobile) {
            const pasteTab = document.getElementById('paste-tab');
            if (pasteTab) {
                const tabTrigger = new bootstrap.Tab(pasteTab);
                tabTrigger.show();
            }
        }
    });
</script>`;

  return getLayoutHtml('MTG CSV Processor', content, additionalStyles, scripts);
}

/**
 * Generate the file upload results page HTML (with auto-download)
 */
function getUploadResultsHtml(stats: ProcessingStats, csvContent: string): string {
  const additionalStyles = `
.error-list {
    max-height: 300px;
    overflow-y: auto;
}
.stats-card {
    text-align: center;
}
.stats-number {
    font-size: 2.5rem;
    font-weight: bold;
    color: #563d7c;
}
.stats-label {
    font-size: 0.9rem;
    color: #6c757d;
    text-transform: uppercase;
}
.btn-success {
    background-color: #28a745;
    border-color: #28a745;
}
.btn-success:hover {
    background-color: #218838;
    border-color: #1e7e34;
}
.format-note {
    background-color: #f8f9fa;
    border-left: 4px solid #6c757d;
    padding: 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
}`;

  const failuresButtonHtml = stats.failuresCsv ? `
            <button id="downloadFailuresBtn" class="btn btn-outline-danger">
                <i class="bi bi-exclamation-triangle"></i> Download Failures CSV (${stats.errors})
            </button>` : '';

  const failuresDataHtml = stats.failuresCsv ? `
<textarea id="failuresCsvData" style="display:none;">${escapeHtml(stats.failuresCsv)}</textarea>` : '';

  const content = `
<div class="card">
    <div class="card-header">
        <span class="header-icon">&#9989;</span> Processing Complete
    </div>
    <div class="card-body">
        <div class="row mb-4">
            <div class="col-md-6">
                <div class="card stats-card">
                    <div class="card-body">
                        <div class="stats-number text-success">${stats.matchedRows}</div>
                        <div class="stats-label">Cards Processed</div>
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="card stats-card">
                    <div class="card-body">
                        <div class="stats-number text-danger">${stats.errors}</div>
                        <div class="stats-label">Cards Skipped</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="d-grid gap-2">
            <button id="downloadBtn" class="btn btn-success btn-lg">
                <i class="bi bi-download"></i> Download TCGPlayer CSV
            </button>
${failuresButtonHtml}
            <a href="/" class="btn btn-outline-secondary">
                <i class="bi bi-arrow-left"></i> Process Another File
            </a>
        </div>
    </div>
</div>

<textarea id="csvData" style="display:none;">${escapeHtml(csvContent)}</textarea>
${failuresDataHtml}`;

  const scripts = `
<script>
    function downloadCsv(elementId, filename) {
        const csvData = document.getElementById(elementId).value;
        const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    const filename_uuid = crypto.randomUUID();
    // Auto-download the success CSV file
    document.addEventListener('DOMContentLoaded', function() {
        downloadCsv('csvData', 'tcgplayer_output_' + filename_uuid + '.csv');
    });

    // Manual download buttons
    document.getElementById('downloadBtn').addEventListener('click', function() {
        downloadCsv('csvData', 'tcgplayer_output_' + filename_uuid + '.csv');
    });

    // Failures download button (if exists)
    const failuresBtn = document.getElementById('downloadFailuresBtn');
    if (failuresBtn) {
        failuresBtn.addEventListener('click', function() {
            downloadCsv('failuresCsvData', 'tcgplayer_failures_' + filename_uuid + '.csv');
        });
    }
</script>`;

  return getLayoutHtml('Processing Results - MTG CSV Processor', content, additionalStyles, scripts);
}

/**
 * Generate the paste results page HTML (with copy button)
 */
function getPasteResultsHtml(stats: ProcessingStats, csvContent: string): string {
  const additionalStyles = `
.error-list {
    max-height: 300px;
    overflow-y: auto;
}
.stats-card {
    text-align: center;
}
.stats-number {
    font-size: 2.5rem;
    font-weight: bold;
    color: #563d7c;
}
.stats-label {
    font-size: 0.9rem;
    color: #6c757d;
    text-transform: uppercase;
}
.copy-area {
    min-height: 150px;
    font-family: monospace;
    white-space: pre;
    font-size: 0.9rem;
}
.copy-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 10;
}
.output-container {
    position: relative;
}
.format-note {
    background-color: #f8f9fa;
    border-left: 4px solid #6c757d;
    padding: 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
}`;

  const failuresOutputHtml = stats.failuresCsv ? `
        <div class="output-container mb-3">
            <h5 class="mb-2 text-danger">Failures CSV (${stats.errors} cards)</h5>
            <button id="copyFailuresButton" class="btn btn-sm btn-outline-danger copy-btn">
                <i class="bi bi-clipboard"></i> Copy
            </button>
            <textarea id="failuresOutput" class="form-control copy-area" rows="6" readonly>${escapeHtml(stats.failuresCsv)}</textarea>
        </div>` : '';

  const content = `
<div class="card">
    <div class="card-header">
        <span class="header-icon">&#9989;</span> Processing Complete
    </div>
    <div class="card-body">
        <div class="row mb-4">
            <div class="col-md-6">
                <div class="card stats-card">
                    <div class="card-body">
                        <div class="stats-number text-success">${stats.matchedRows}</div>
                        <div class="stats-label">Cards Processed</div>
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="card stats-card">
                    <div class="card-body">
                        <div class="stats-number text-danger">${stats.errors}</div>
                        <div class="stats-label">Cards Skipped</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="output-container mb-3">
            <h5 class="mb-2">TCGPlayer CSV Output</h5>
            <button id="copyButton" class="btn btn-sm btn-outline-primary copy-btn">
                <i class="bi bi-clipboard"></i> Copy
            </button>
            <textarea id="csvOutput" class="form-control copy-area" rows="10" readonly>${escapeHtml(csvContent)}</textarea>
        </div>

${failuresOutputHtml}

        <div class="d-grid gap-2">
            <a href="/" class="btn btn-outline-secondary">
                <i class="bi bi-arrow-left"></i> Process Another File
            </a>
        </div>
    </div>
</div>`;

  const scripts = `
<script>
    function setupCopyButton(buttonId, textareaId, primaryClass) {
        const btn = document.getElementById(buttonId);
        const textarea = document.getElementById(textareaId);
        if (!btn || !textarea) return;

        btn.addEventListener('click', function() {
            textarea.select();
            textarea.setSelectionRange(0, 99999);

            navigator.clipboard.writeText(textarea.value)
                .then(() => {
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '<i class="bi bi-check"></i> Copied!';
                    btn.classList.remove(primaryClass);
                    btn.classList.add('btn-success');

                    setTimeout(() => {
                        btn.innerHTML = originalText;
                        btn.classList.remove('btn-success');
                        btn.classList.add(primaryClass);
                    }, 2000);
                })
                .catch(err => {
                    console.error('Error copying text: ', err);
                    alert('Failed to copy text. Please select and copy manually.');
                });
        });
    }

    document.addEventListener('DOMContentLoaded', function() {
        setupCopyButton('copyButton', 'csvOutput', 'btn-outline-primary');
        setupCopyButton('copyFailuresButton', 'failuresOutput', 'btn-outline-danger');
    });
</script>`;

  return getLayoutHtml('Text Results - MTG CSV Processor', content, additionalStyles, scripts);
}

/**
 * Generate error page HTML
 */
function getErrorHtml(message: string): string {
  const content = `
<div class="card">
    <div class="card-header bg-danger">
        <span class="header-icon">&#10060;</span> Error
    </div>
    <div class="card-body">
        <div class="alert alert-danger" role="alert">
            ${escapeHtml(message)}
        </div>
        <div class="d-grid">
            <a href="/" class="btn btn-outline-secondary">
                <i class="bi bi-arrow-left"></i> Try Again
            </a>
        </div>
    </div>
</div>`;

  return getLayoutHtml('Error - MTG CSV Processor', content);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for API access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Main processing endpoint
    if (url.pathname === '/convert' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let csvText: string;
        let mode: 'upload' | 'paste' = 'upload';

        if (contentType.includes('multipart/form-data')) {
          const formData = await request.formData();
          mode = (formData.get('mode') as string) === 'paste' ? 'paste' : 'upload';

          if (mode === 'paste') {
            const csvContent = formData.get('csv_content');
            if (!csvContent || typeof csvContent !== 'string' || !csvContent.trim()) {
              return new Response(getErrorHtml('No CSV content provided'), {
                status: 400,
                headers: { 'Content-Type': 'text/html' },
              });
            }
            csvText = csvContent;
          } else {
            const fileEntry = formData.get('file');
            if (!fileEntry || typeof fileEntry === 'string') {
              return new Response(getErrorHtml('No file provided'), {
                status: 400,
                headers: { 'Content-Type': 'text/html' },
              });
            }
            csvText = await (fileEntry as Blob).text();
          }
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          const formData = await request.formData();
          mode = (formData.get('mode') as string) === 'paste' ? 'paste' : 'upload';
          const csvContent = formData.get('csv_content');
          if (!csvContent || typeof csvContent !== 'string' || !csvContent.trim()) {
            return new Response(getErrorHtml('No CSV content provided'), {
              status: 400,
              headers: { 'Content-Type': 'text/html' },
            });
          }
          csvText = csvContent;
        } else {
          // Raw CSV text (API mode)
          csvText = await request.text();

          // Check if JSON format requested
          const returnJson = url.searchParams.get('format') === 'json';
          if (returnJson) {
            const { csv, stats } = await processCSV(csvText, env);
            return new Response(JSON.stringify({ csv, stats }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        const { csv, stats } = await processCSV(csvText, env);

        // Return appropriate HTML based on mode
        const html = mode === 'paste'
          ? getPasteResultsHtml(stats, csv)
          : getUploadResultsHtml(stats, csv);

        return new Response(html, {
          headers: { 'Content-Type': 'text/html' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Processing error:', error);

        // Check if JSON format was requested
        if (url.searchParams.get('format') === 'json') {
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(getErrorHtml(message), {
          status: 500,
          headers: { 'Content-Type': 'text/html' },
        });
      }
    }

    // Main page
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(getIndexHtml(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
