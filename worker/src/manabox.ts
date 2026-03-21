import {
  CsvSourceAdapter,
  FailureRowContext,
  NormalizedCard,
  SourceRow,
} from "./types";

function getCell(row: SourceRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

/**
 * Normalize ManaBox "Scryfall ID" column to lowercase UUID for scryfall_bridge lookup.
 */
export function normalizeScryfallIdFromRow(row: SourceRow): string | undefined {
  const raw = getCell(row, "Scryfall ID");
  if (!raw) return undefined;
  const s = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
  ) {
    return undefined;
  }
  return s;
}

/**
 * Normalize a ManaBox CSV row to a NormalizedCard
 * Keeps only fields required by Scryfall-ID matching and output rendering.
 */
export function normalizeManaBoxRow(row: SourceRow): NormalizedCard {
  // Detect foil variants (etched uses separate TCGPlayer product via scryfall_bridge when possible)
  const foilValue = getCell(row, "Foil").toLowerCase();
  const isEtched = foilValue === "etched";
  const isFoil = foilValue === "foil" || foilValue === "etched";

  const scryfallId = normalizeScryfallIdFromRow(row);

  return {
    isEtched,
    isFoil,
    condition: getCell(row, "Condition") || "near_mint",
    language: getCell(row, "Language") || "en",
    quantity: parseInt(getCell(row, "Quantity") || "1", 10),
    purchasePrice: getCell(row, "Purchase price") || undefined,
    scryfallId,
    // Keep original collector number for CSV output "Number" field.
    originalCollectorNumber: getCell(row, "Collector number"),
  };
}

function manaboxFailureContext(row: SourceRow): FailureRowContext {
  return {
    Name: getCell(row, "Name"),
    "Set code": getCell(row, "Set code"),
    "Collector number": getCell(row, "Collector number"),
    "Scryfall ID": getCell(row, "Scryfall ID"),
    Quantity: getCell(row, "Quantity") || "1",
    Condition: getCell(row, "Condition"),
    Foil: getCell(row, "Foil"),
    Language: getCell(row, "Language"),
  };
}

export const MANABOX_ADAPTER: CsvSourceAdapter = {
  id: "manabox",
  requiredHeaders: ["Set code", "Collector number", "Foil", "Condition", "Quantity"],
  canHandle(headers: string[]): boolean {
    const set = new Set(headers);
    return this.requiredHeaders.every((h) => set.has(h));
  },
  normalizeRow: normalizeManaBoxRow,
  toFailureContext: manaboxFailureContext,
};
