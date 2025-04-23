import csv
import sqlite3

# ───────── CONFIG ─────────
MANABOX_CSV   = "manabox.csv"
DB_FILE       = "mtg.db"
OUTPUT_CSV    = "tcgplayer_upload.csv"

# ───────── HELPERS ─────────
def finish_for_sku(finish_raw):
    """
    ManaBox 'Foil' values: 'normal', 'foil', or e.g. 'etched'.
    Treat only 'normal' as NON FOIL; everything else as FOIL.
    """
    return "NON FOIL" if finish_raw.lower() == "normal" else "FOIL"

# ───────── OPEN DB ─────────
conn = sqlite3.connect(DB_FILE)
cur  = conn.cursor()

# ───────── PROCESS ManaBox → OUTPUT CSV ─────────
with open(MANABOX_CSV, newline="", encoding="utf-8") as infile, \
     open(OUTPUT_CSV,  "w",   newline="", encoding="utf-8") as outfile:

    reader = csv.DictReader(infile)
    writer = csv.DictWriter(outfile, fieldnames=[
        "SKU",
        "Quantity",
        # "TCG Marketplace Price"
    ])
    writer.writeheader()

    for row in reader:
        name       = row["Name"]
        scry_id    = row["Scryfall ID"].strip()
        qty        = row["Quantity"].strip()
        price      = row["Purchase price"].strip()
        cond_raw   = row["Condition"].replace("_", " ").upper()   # e.g. "NEAR MINT"
        finish_raw = row["Foil"].strip()                          # e.g. "normal", "foil", "etched"
        finish_sku = finish_for_sku(finish_raw)                   # "NON FOIL" or "FOIL"

        # 1) Lookup in scryfall table
        cur.execute("""
            SELECT tcgplayer_id, tcgplayer_etched_id
              FROM scryfall
             WHERE id = ?
        """, (scry_id,))
        row_scry = cur.fetchone()
        if not row_scry:
            print(f"⚠️  Skipped {name}: no Scryfall entry for ID {scry_id}")
            continue

        tcg_id, tcg_etched = row_scry
        # 2) Choose productId based on finish
        if finish_raw.lower() not in ("normal", "foil") and tcg_etched:
            prod_id = tcg_etched
        else:
            prod_id = tcg_id

        if not prod_id:
            print(f"⚠️  Skipped {name}: no tcgplayer_id/etched_id in DB")
            continue

        # 3) Find the matching SKU entry
        cur.execute("""
            SELECT skuId
              FROM sku
             WHERE productId = ?
               AND language   = 'ENGLISH'
               AND condition  = ?
               AND printing   = ?
             LIMIT 1
        """, (prod_id, cond_raw, finish_sku))
        sku_row = cur.fetchone()
        if not sku_row:
            print(f"⚠️  Skipped {name}: no SKU for {cond_raw}/{finish_sku}")
            continue

        sku_id = sku_row[0]

        # 4) Write output
        writer.writerow({
            "SKU":            sku_id,
            "Quantity":         qty,
            # "TCG Marketplace Price":   price
        })
    
    conn.close()
    print("✅ Done! See", OUTPUT_CSV)
