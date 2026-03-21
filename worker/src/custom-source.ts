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

function normalizeScryfallId(raw: string): string | undefined {
  const s = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
  ) {
    return undefined;
  }
  return s;
}

/**
 * Scaffold for a second CSV source adapter.
 * To onboard a new source, edit only this file:
 * - set `id`
 * - define `requiredHeaders`
 * - map row fields in `normalizeRow()` and `toFailureContext()`
 *
 * Safety: default required header is intentionally impossible so this adapter
 * never auto-matches until configured.
 */
export const CUSTOM_SOURCE_ADAPTER: CsvSourceAdapter = {
  id: "custom-source",
  requiredHeaders: ["__configure_custom_source_headers__"],
  canHandle(headers: string[]): boolean {
    const set = new Set(headers);
    return this.requiredHeaders.every((h) => set.has(h));
  },
  normalizeRow(row: SourceRow): NormalizedCard {
    // TODO: remap these keys to your source CSV schema.
    const foilValue = getCell(row, "Foil").toLowerCase();
    const isEtched = foilValue === "etched";
    const isFoil = foilValue === "foil" || foilValue === "etched";
    const scryfallId = normalizeScryfallId(getCell(row, "Scryfall ID"));

    return {
      isEtched,
      isFoil,
      condition: getCell(row, "Condition") || "near_mint",
      language: getCell(row, "Language") || "en",
      quantity: parseInt(getCell(row, "Quantity") || "1", 10),
      purchasePrice: getCell(row, "Purchase price") || undefined,
      scryfallId,
      originalCollectorNumber: getCell(row, "Collector number"),
    };
  },
  toFailureContext(row: SourceRow): FailureRowContext {
    // TODO: remap these keys to your source CSV schema.
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
  },
};
