import Papa from 'papaparse';
import type { InputRow, OutputRow } from './types';

/**
 * Parse CSV string into array of objects using Papa Parse
 */
export function parseCSV(csvText: string): InputRow[] {
  // Normalize line endings (handle \r\r\n, \r\n, \r -> \n)
  const normalized = csvText.replace(/\r\r\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const result = Papa.parse<InputRow>(normalized, {
    header: true,
    skipEmptyLines: true,
  });
  return result.data;
}

/**
 * Convert output rows to CSV string using Papa Parse
 */
export function toCSV(rows: OutputRow[]): string {
  if (rows.length === 0) return '';

  const headers: (keyof OutputRow)[] = [
    'TCGplayer Id',
    'Product Line',
    'Set Name',
    'Product Name',
    'Title',
    'Number',
    'Rarity',
    'Condition',
    'TCG Market Price',
    'TCG Direct Low',
    'TCG Low Price With Shipping',
    'TCG Low Price',
    'Total Quantity',
    'Add to Quantity',
    'TCG Marketplace Price',
    'Photo URL',
  ];

  return Papa.unparse(rows, {
    columns: headers,
    quotes: true,
  });
}

/**
 * Convert any array of objects to CSV string using Papa Parse
 */
export function toGenericCSV<T extends object>(rows: T[]): string {
  if (rows.length === 0) return '';
  return Papa.unparse(rows, { quotes: true });
}
