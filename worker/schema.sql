PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "groups"(group_id BIGINT, "name" VARCHAR, abbr VARCHAR, is_current BIGINT);
CREATE TABLE products(product_id BIGINT, group_id BIGINT, "name" VARCHAR, clean_name VARCHAR, image_url VARCHAR, url VARCHAR, is_sealed BIGINT, upc VARCHAR, rarity_id BIGINT, collector_number VARCHAR, subtype VARCHAR, oracle_text_raw VARCHAR, oracle_text_plain VARCHAR, presale_is_presale BIGINT, presale_released_on VARCHAR, extended_data VARCHAR, modified_on VARCHAR);
CREATE TABLE skus(sku_id BIGINT, product_id BIGINT, language_id BIGINT, printing_id BIGINT, condition_id BIGINT, low_price_cents BIGINT, mid_price_cents BIGINT, high_price_cents BIGINT, market_price_cents BIGINT, direct_low_price_cents BIGINT);
CREATE TABLE scryfall_bridge (
            scryfall_id TEXT PRIMARY KEY NOT NULL,
            product_id INTEGER,
            etched_product_id INTEGER
        );
CREATE INDEX idx_groups_abbr ON "groups"(abbr);
CREATE INDEX idx_products_lookup ON products(group_id, collector_number);
CREATE INDEX idx_skus_lookup ON skus(product_id, printing_id, condition_id, language_id);
CREATE INDEX idx_scryfall_bridge_product_id ON scryfall_bridge(product_id);
