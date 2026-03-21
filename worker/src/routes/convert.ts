import { parseCSV, toCSV, toGenericCSV } from "../csv";
import {
  CONDITION_MAP,
  CONDITION_NAMES,
  FailedRow,
  GroupRow,
  LANGUAGE_MAP,
  NormalizedCard,
  OutputRow,
  ProcessingStats,
  ProductRow,
  RARITY_MAP,
  SourceRow,
} from "../types";
import { detectSourceAdapter } from "../sources";
import {
  getErrorHtml,
  getPasteResultsHtml,
  getUploadResultsHtml,
} from "../ui/html";
import {
  batchFetchGroupsByIds,
  batchFetchProductsByProductIds,
  batchFetchScryfallBridge,
  resolveProductFromBridge,
  RowDirectMatch,
} from "../matcher/scryfall";
import { batchFetchSkus, makeSkuKey } from "../matcher/sku";

function formatPrice(cents: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

function isLikelyUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

export async function processCSV(
  csvText: string,
  db: D1Database,
  proAccount = false,
): Promise<{ csv: string; stats: ProcessingStats }> {
  const inputRows = parseCSV(csvText);
  if (inputRows.length === 0) {
    return {
      csv: "",
      stats: {
        inputRows: 0,
        matchedRows: 0,
        aggregatedFrom: 0,
        errors: 0,
        sampleErrors: [],
        failuresCsv: "",
      },
    };
  }

  const sourceAdapter = detectSourceAdapter(inputRows);
  const failedRows: FailedRow[] = [];
  const errors: string[] = [];

  const recordFailure = (row: SourceRow, reason: string) => {
    errors.push(reason);
    failedRows.push({ ...sourceAdapter.toFailureContext(row), "Failure Reason": reason });
  };

  const normalizedCards: NormalizedCard[] = inputRows.map((row) =>
    sourceAdapter.normalizeRow(row),
  );

  const scryfallIds = [
    ...new Set(
      normalizedCards
        .map((c) => c.scryfallId)
        .filter((s): s is string => Boolean(s)),
    ),
  ];
  const bridgeMap = await batchFetchScryfallBridge(db, scryfallIds);

  const bridgeProductIds = new Set<number>();
  for (const sid of scryfallIds) {
    const b = bridgeMap.get(sid);
    if (!b) continue;
    if (b.product_id != null) bridgeProductIds.add(b.product_id);
    if (b.etched_product_id != null) bridgeProductIds.add(b.etched_product_id);
  }

  const productsById = await batchFetchProductsByProductIds(db, [...bridgeProductIds]);

  const rowDirect: Array<RowDirectMatch | null> = normalizedCards.map(() => null);
  for (let i = 0; i < normalizedCards.length; i++) {
    const card = normalizedCards[i];
    if (!card.scryfallId) continue;
    const bridge = bridgeMap.get(card.scryfallId);
    if (!bridge) continue;
    const resolved = resolveProductFromBridge(bridge, card);
    if (!resolved) continue;
    const product = productsById.get(resolved.productId);
    if (!product) continue;
    rowDirect[i] = { product, printingId: resolved.printingId };
  }

  const requiredGroupIds = new Set<number>();
  for (const direct of rowDirect) {
    if (direct) requiredGroupIds.add(direct.product.group_id);
  }
  const groupById: Map<number, GroupRow> = await batchFetchGroupsByIds(db, [
    ...requiredGroupIds,
  ]);

  const skuKeys: Array<{
    productId: number;
    printingId: number;
    conditionId: number;
    languageId: number;
  }> = [];
  const rowSkuKeys: Array<string | null> = [];

  for (let i = 0; i < normalizedCards.length; i++) {
    const card = normalizedCards[i];
    const direct = rowDirect[i];
    if (!direct) {
      rowSkuKeys.push(null);
      continue;
    }

    const conditionId = CONDITION_MAP[card.condition.toLowerCase()] || 1;
    const languageId = LANGUAGE_MAP[card.language.toLowerCase()] || 1;
    const skuKey = makeSkuKey(
      direct.product.product_id,
      direct.printingId,
      conditionId,
      languageId,
    );
    rowSkuKeys.push(skuKey);
    skuKeys.push({
      productId: direct.product.product_id,
      printingId: direct.printingId,
      conditionId,
      languageId,
    });
  }

  const uniqueSkuKeys = Array.from(
    new Map(
      skuKeys.map((k) => [makeSkuKey(k.productId, k.printingId, k.conditionId, k.languageId), k]),
    ).values(),
  );
  const skuMap = await batchFetchSkus(db, uniqueSkuKeys);

  const aggregated = new Map<
    string,
    { output: OutputRow; quantity: number; totalPrice: number; count: number }
  >();

  for (let i = 0; i < inputRows.length; i++) {
    const row = inputRows[i];
    const card = normalizedCards[i];
    const direct = rowDirect[i];
    const rawScryfall = sourceAdapter.toFailureContext(row)["Scryfall ID"] || "";

    if (!direct) {
      if (!rawScryfall.trim()) {
        recordFailure(row, "Missing Scryfall ID");
      } else if (!isLikelyUuid(rawScryfall)) {
        recordFailure(row, `Invalid Scryfall ID '${rawScryfall}'`);
      } else if (!card.scryfallId || !bridgeMap.has(card.scryfallId)) {
        recordFailure(row, `No scryfall_bridge mapping for Scryfall ID '${rawScryfall}'`);
      } else {
        recordFailure(row, `No product found for Scryfall ID '${rawScryfall}'`);
      }
      continue;
    }

    const product: ProductRow = direct.product;
    const group = groupById.get(product.group_id);
    if (!group) {
      recordFailure(row, `No group metadata found for product ${product.product_id}`);
      continue;
    }

    const skuKey = rowSkuKeys[i];
    const conditionId = CONDITION_MAP[card.condition.toLowerCase()] || 1;
    const languageId = LANGUAGE_MAP[card.language.toLowerCase()] || 1;
    if (!skuKey) {
      recordFailure(
        row,
        `No SKU key for ${product.name} (printing=${direct.printingId}, condition=${conditionId}, lang=${languageId})`,
      );
      continue;
    }
    const sku = skuMap.get(skuKey);
    if (!sku) {
      recordFailure(
        row,
        `No SKU for ${product.name} (printing=${direct.printingId}, condition=${conditionId}, lang=${languageId})`,
      );
      continue;
    }

    let conditionStr = CONDITION_NAMES[conditionId] || "Near Mint";
    if (direct.printingId === 2) conditionStr += " Foil";

    const marketPrice = formatPrice(sku.market_price_cents);
    const price = card.purchasePrice || marketPrice;

    const existing = aggregated.get(skuKey);
    if (existing) {
      existing.quantity += card.quantity;
      existing.count += 1;
      existing.totalPrice += (parseFloat(price) || 0) * card.quantity;
      continue;
    }

    const output: OutputRow = {
      "TCGplayer Id": sku.sku_id.toString(),
      "Product Line": "Magic",
      "Set Name": group.name,
      "Product Name": product.name,
      Title: "",
      Number: card.originalCollectorNumber,
      Rarity: RARITY_MAP[product.rarity_id || 0] || "",
      Condition: conditionStr,
      "TCG Market Price": marketPrice,
      "TCG Direct Low": formatPrice(sku.direct_low_price_cents),
      "TCG Low Price With Shipping": formatPrice(sku.mid_price_cents),
      "TCG Low Price": formatPrice(sku.low_price_cents),
      "Total Quantity": card.quantity.toString(),
      "Add to Quantity": card.quantity.toString(),
      "TCG Marketplace Price": price,
      ...(proAccount
        ? { "My Store Reserve Quantity": "0", "My Store Price": marketPrice }
        : {}),
      "Photo URL": product.image_url || "",
    };

    aggregated.set(skuKey, {
      output,
      quantity: card.quantity,
      totalPrice: (parseFloat(price) || 0) * card.quantity,
      count: 1,
    });
  }

  const outputRows: OutputRow[] = [];
  for (const { output, quantity, totalPrice, count } of aggregated.values()) {
    output["Total Quantity"] = quantity.toString();
    output["Add to Quantity"] = quantity.toString();
    if (count > 1 && totalPrice > 0) {
      output["TCG Marketplace Price"] = (totalPrice / quantity).toFixed(2);
    }
    outputRows.push(output);
  }

  const failuresCsv = failedRows.length > 0 ? toGenericCSV(failedRows) : "";
  return {
    csv: toCSV(outputRows, proAccount),
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

export async function handleConvertRoute(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const htmlHeaders: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  };

  try {
    const formData = await request.formData();
    const mode = String(formData.get("mode") || "");
    const proAccount = formData.get("pro_account") === "1";

    let csvText = "";
    if (mode === "upload") {
      const entry = formData.get("file");
      if (entry === null || typeof entry === "string") {
        return new Response(getErrorHtml("No file uploaded"), {
          status: 400,
          headers: htmlHeaders,
        });
      }
      csvText = await (entry as Blob).text();
    } else if (mode === "paste") {
      const raw = formData.get("csv_content");
      csvText = raw != null ? String(raw) : "";
      if (!csvText.trim()) {
        return new Response(getErrorHtml("No CSV content pasted"), {
          status: 400,
          headers: htmlHeaders,
        });
      }
    } else {
      return new Response(getErrorHtml("Invalid form mode"), {
        status: 400,
        headers: htmlHeaders,
      });
    }

    const { csv, stats } = await processCSV(csvText, db, proAccount);
    const body =
      mode === "upload"
        ? getUploadResultsHtml(stats, csv)
        : getPasteResultsHtml(stats, csv);
    return new Response(body, { status: 200, headers: htmlHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(getErrorHtml(msg), {
      status: 500,
      headers: htmlHeaders,
    });
  }
}
