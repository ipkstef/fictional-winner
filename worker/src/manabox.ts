import { InputRow, NormalizedCard } from './types';

/**
 * Parse ManaBox PLST collector number format
 * Example: "RNA-253" → "253"
 * Returns null if format doesn't match
 */
export function parsePLSTCollector(collector: string): string | null {
  const match = collector.match(/^[A-Z0-9]+-(\d+)$/i);
  return match ? match[1] : null;
}

/**
 * Detect if ManaBox set code is a token set
 * Token sets are 4 characters starting with 'T'
 * Example: "TOTJ" → true, "OTJ" → false
 */
export function isTokenSetCode(setCode: string): boolean {
  return setCode.length === 4 && setCode.startsWith('T');
}

/**
 * Normalize a ManaBox CSV row to a NormalizedCard
 * Handles set code transformations, collector number parsing, and token detection
 */
export function normalizeManaBoxRow(row: InputRow): NormalizedCard {
  const rawSetCode = row['Set code']?.toUpperCase() || '';
  const isToken = isTokenSetCode(rawSetCode);
  const isPLST = rawSetCode === 'PLST';

  // Normalize set code
  let setCode = rawSetCode;
  if (isPLST) {
    setCode = 'LIST';
  } else if (isToken) {
    // Strip 'T' prefix from token sets: TOTJ → OTJ
    setCode = rawSetCode.slice(1);
  }

  // Normalize collector number for PLST
  let collectorNumber = row['Collector number'] || '';
  if (isPLST) {
    const parsed = parsePLSTCollector(collectorNumber);
    if (parsed) {
      collectorNumber = parsed;
    }
  }

  // Strip trailing letter from UNF-style collector numbers: "221a" → "221"
  // TCGPlayer uses base number with variant in product name, e.g., "Memory Test (3-6)"
  if (/^\d+[a-z]$/i.test(collectorNumber)) {
    collectorNumber = collectorNumber.slice(0, -1);
  }

  // ManaBox-specific set code overrides
  if (setCode === 'SUNF') {
    setCode = 'UNF';
  } else if (setCode === 'JTLA') {
    setCode = 'TLA';
  }

  // MB2 playtest cards (collector number >= 500) are in the MB2PC group
  if (setCode === 'MB2' && parseInt(collectorNumber, 10) >= 500) {
    setCode = 'MB2PC';
  }

  // Detect foil variants
  const foilValue = row['Foil']?.toLowerCase() || '';
  const isFoil = foilValue === 'foil' || foilValue === 'etched';

  return {
    name: row['Name'] || '',
    setCode,
    collectorNumber,
    isToken,
    isFoil,
    condition: row['Condition'] || 'near_mint',
    language: row['Language'] || 'en',
    quantity: parseInt(row['Quantity'] || '1', 10),
    purchasePrice: row['Purchase price'],
    // Keep original values for reference
    originalSetCode: rawSetCode,
    originalCollectorNumber: row['Collector number'] || '',
  };
}
