# MTG CSV Processor (Cloudflare Worker)

Convert card inventory CSVs (currently ManaBox) into TCGPlayer bulk CSV format using a Scryfall-ID-first matching pipeline on Cloudflare D1.

## Current matching model

The Worker now uses a single primary path:

1. Parse source CSV using an adapter.
2. Normalize rows to a source-agnostic shape.
3. Resolve `Scryfall ID` through `scryfall_bridge`.
4. Resolve TCG product in `products`.
5. Resolve SKU in `skus` by:
   - `product_id`
   - `printing_id` (normal / foil / etched behavior)
   - `condition_id`
   - `language_id`

Legacy set/collector/name fallback matching has been removed from the core processing path.

## Features

- Browser upload + paste modes
- Scryfall-ID-first matching for higher accuracy
- Condition/language/finish-aware SKU selection
- Failure CSV with explicit reasons (missing/invalid/unmapped Scryfall ID, SKU miss)
- Adapter-based CSV ingestion for future source formats

## Repository layout

- `worker/` - Cloudflare Worker app
  - `src/main.ts` - HTTP entrypoint and route wiring
  - `src/routes/convert.ts` - CSV conversion orchestration
  - `src/matcher/scryfall.ts` - bridge/product resolution helpers
  - `src/matcher/sku.ts` - SKU batch query helpers
  - `src/ui/html.ts` - HTML rendering
  - `src/manabox.ts` - ManaBox adapter
  - `src/custom-source.ts` - scaffold for next CSV source
  - `src/sources.ts` - adapter registry + auto-detection
- `sync_r2_to_d1.py` - R2 Parquet -> SQLite -> SQL dumps -> D1 sync
- `scryfall_bridge.py` - builds `scryfall_bridge` from Scryfall bulk data

## D1 tables used by the Worker

- `groups`
- `products`
- `skus`
- `scryfall_bridge` (`scryfall_id`, `product_id`, `etched_product_id`)

## Local development

### Worker setup

```bash
cd worker
npm install
npx wrangler whoami
```

### Typecheck

```bash
cd worker
npx tsc -p tsconfig.json --noEmit
```

### Dev server

```bash
cd worker
npx wrangler dev
```

If Wrangler asks for preview bindings, configure preview resources in `worker/wrangler.toml`.

## Data sync and bridge build

### Full sync (R2 -> D1)

```bash
python sync_r2_to_d1.py
```

Useful flags:

- `--skip-download` - reuse existing `tcg_data.db`
- `--skip-import` - only build local SQL dumps
- `--skip-scryfall-bridge` - skip bridge table population
- `--products-chunk-size N` - tune D1 import chunking

### Bridge-only build

```bash
python scryfall_bridge.py /path/to/tcg_data.db
```

Downloads `default_cards` from Scryfall (if missing) and populates `scryfall_bridge`.

## CSV source adapters

Source handling is adapter-driven via `CsvSourceAdapter`.

Current adapters:

- `manabox` (active)
- `custom-source` (scaffold, intentionally non-matching until configured)

To onboard a new source quickly, edit only:

- `worker/src/custom-source.ts`

Steps:

1. Set `id`
2. Replace `requiredHeaders`
3. Map fields in:
   - `normalizeRow()`
   - `toFailureContext()`

No core matcher changes are required.

## Expected columns for ManaBox

Minimum columns used:

- `Scryfall ID`
- `Foil`
- `Condition`
- `Language` (defaults to `en` if empty)
- `Quantity`
- `Collector number` (for output metadata)
- `Purchase price` (optional)

## Validation files

- `full test.csv` - one card across multiple finishes/conditions
- `fin .csv` - broader real-world sample

## License

MIT