import { MANABOX_ADAPTER } from "./manabox";
import { CUSTOM_SOURCE_ADAPTER } from "./custom-source";
import { CsvSourceAdapter, SourceRow } from "./types";

const ADAPTERS: CsvSourceAdapter[] = [MANABOX_ADAPTER, CUSTOM_SOURCE_ADAPTER];

function extractHeaders(rows: SourceRow[]): string[] {
  const first = rows[0];
  return first ? Object.keys(first) : [];
}

export function detectSourceAdapter(rows: SourceRow[]): CsvSourceAdapter {
  const headers = extractHeaders(rows);
  for (const adapter of ADAPTERS) {
    if (adapter.canHandle(headers)) return adapter;
  }
  const known = ADAPTERS.map((a) => a.id).join(", ");
  throw new Error(
    `Unsupported CSV schema. Could not match input headers to a known source adapter (${known}).`,
  );
}
