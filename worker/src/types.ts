// Input CSV row (from ManaBox or similar)
export interface InputRow {
  'Set code': string;
  'Collector number': string;
  Foil: string;
  Condition: string;
  Language?: string;
  Quantity: string;
  'Purchase price'?: string;
}

// Output CSV row (TCGPlayer format)
export interface OutputRow {
  'TCGplayer Id': string;
  'Product Line': string;
  'Set Name': string;
  'Product Name': string;
  Title: string;
  Number: string;
  Rarity: string;
  Condition: string;
  'TCG Market Price': string;
  'TCG Direct Low': string;
  'TCG Low Price With Shipping': string;
  'TCG Low Price': string;
  'Total Quantity': string;
  'Add to Quantity': string;
  'TCG Marketplace Price': string;
  'Photo URL': string;
}

// R2 Parquet data types
export interface GroupRow {
  group_id: number;
  name: string;
  abbr: string;
  is_current: boolean;
}

export interface ProductRow {
  product_id: number;
  group_id: number;
  name: string;
  clean_name: string;
  image_url: string | null;
  rarity_id: number | null;
  collector_number: string | null;
}

export interface SkuRow {
  sku_id: number;
  product_id: number;
  language_id: number;
  printing_id: number;
  condition_id: number;
  low_price_cents: number | null;
  mid_price_cents: number | null;
  high_price_cents: number | null;
  market_price_cents: number | null;
  direct_low_price_cents: number | null;
}

// Lookup maps
export const CONDITION_MAP: Record<string, number> = {
  mint: 1,
  near_mint: 1,
  excellent: 2,
  good: 3,
  light_played: 2,
  lightly_played: 2,
  played: 4,
  heavily_played: 4,
  poor: 5,
  damaged: 5,
};

export const LANGUAGE_MAP: Record<string, number> = {
  en: 1,
  zhs: 2,
  zht: 3,
  fr: 4,
  de: 5,
  it: 6,
  ja: 7,
  ko: 8,
  pt: 9,
  ru: 10,
  es: 11,
};

export const RARITY_MAP: Record<number, string> = {
  1: 'C',  // Common
  2: 'U',  // Uncommon
  3: 'R',  // Rare
  4: 'M',  // Mythic
  5: 'S',  // Special
  6: 'L',  // Land
  7: 'P',  // Promo
  8: 'T',  // Token
};

export const CONDITION_NAMES: Record<number, string> = {
  1: 'Near Mint',
  2: 'Lightly Played',
  3: 'Moderately Played',
  4: 'Heavily Played',
  5: 'Damaged',
};
