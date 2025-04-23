import sqlite3
import json
import sys
import requests
import bz2
import ijson
import io

def download_scryfall_json():
    url = "https://api.scryfall.com/bulk-data"

    response = requests.get(url)
    if response.status_code != 200:
        raise Exception(f"Failed to download Scryfall JSON: {response.status_code}")
    else:
        metadata = response.json()
    try:
        for entry in metadata['data']:
            if entry['type'] == 'default_cards':
                uri = entry['download_uri']
                response = requests.get(uri)
                if response.status_code != 200:
                    raise Exception(f"Failed to download Scryfall JSON: {response.status_code}")
                with open('default-cards.json', 'w', encoding='utf-8') as f:
                    json.dump(response.json(), f, indent=2, ensure_ascii=False)
                    print("✅ Scryfall JSON downloaded")
                break
    except Exception as e:
        print(f"Error: {str(e)}")
        sys.exit(1)

def download_mtgjsonsku_json():
    url = "https://mtgjson.com/api/v5/TcgplayerSkus.json.bz2"
    try:
        # download the bz2 file
        response = requests.get(url)
        if response.status_code != 200:
            raise Exception(f"Failed to download MTGJSON Sku JSON: {response.status_code}")
        with open('TcgplayerSkus.json.bz2', 'wb') as f:
            f.write(response.content)

        print("✅ MTGJSON Sku JSON downloaded")
    except Exception as e:
        print(f"Error: {str(e)}")
        sys.exit(1)
    

def create_db(db_path: str) -> sqlite3.Connection:
    """r
    Creates a SQLite database with two tables and indexes for fast lookups:
      - scryfall: holds minimal Scryfall info (only IDs needed)
      - sku: holds TCGplayer SKU entries
    """
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    # Create minimal scryfall table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS scryfall (
      id TEXT PRIMARY KEY,
      tcgplayer_id INTEGER,
      tcgplayer_etched_id INTEGER
    );
    """)
    # Create sku table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS sku (
      uuid TEXT,
      productId INTEGER,
      skuId INTEGER,
      condition TEXT,
      language TEXT,
      printing TEXT,
      FOREIGN KEY(uuid) REFERENCES scryfall(id)
    );
    """)
    # Indexes
    cur.execute("CREATE INDEX IF NOT EXISTS idx_scry_tcg ON scryfall(tcgplayer_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sku_uuid ON sku(uuid);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sku_prod ON sku(productId);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sku_full ON sku(productId,condition,language,printing);")
    conn.commit()
    return conn

def load_scryfall(conn: sqlite3.Connection, scryfall_json: str):
    """
    Loads only relevant fields from Scryfall bulk JSON into the scryfall table.
    """
    cur = conn.cursor()
    with open(scryfall_json, 'r', encoding='utf-8') as f:
        cards = json.load(f)
    for card in cards:
        cur.execute("""
            INSERT OR REPLACE INTO scryfall(id, tcgplayer_id, tcgplayer_etched_id)
            VALUES (?, ?, ?);
        """, (
            card["id"],
            card.get("tcgplayer_id"),
            card.get("tcgplayer_etched_id")
        ))
    conn.commit()



def load_skus_streaming(conn, skus_bz2_path):
    cur = conn.cursor()
    # Open the .bz2 in binary, then wrap to handle decoding errors
    with bz2.open(skus_bz2_path, "rb") as bin_f:
        text_f = io.TextIOWrapper(bin_f, encoding="utf-8", errors="replace")
        # Stream over each key/value under the top-level "data" object
        for uuid, entries in ijson.kvitems(text_f, "data"):
            for e in entries:
                cur.execute("""
                    INSERT INTO sku(uuid, productId, skuId, condition, language, printing)
                    VALUES (?, ?, ?, ?, ?, ?);
                """, (
                    uuid,
                    e["productId"],
                    e["skuId"],
                    e["condition"],
                    e["language"],
                    e["printing"]
                ))
    conn.commit()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Build SQLite DB from minimal Scryfall & SKU JSON")
    parser.add_argument("--db", default="mtg.db", help="SQLite DB file to create")
    parser.add_argument("--scry", default="default-cards.json", help="Scryfall bulk JSON file")
    parser.add_argument("--skus", default="TcgplayerSkus.json.bz2", help="TCGplayer SKU JSON file")
    parser.add_argument("--download", default=False, help="Download Scryfall & TCGplayer JSON files", type=bool)
    args = parser.parse_args()

    conn = create_db(args.db)
    if args.download:
        try:    
            download_scryfall_json()
            download_mtgjsonsku_json()
            sys.exit(0)
        except Exception as e:
            print(f"Error: {str(e)}")
            sys.exit(1)
    elif not args.scry or not args.skus:
        print("Error: --scry and --skus are required")
        sys.exit(1)
    try:
        load_scryfall(conn, args.scry)
        load_skus_streaming(conn, args.skus)
        conn.close()
        print(f"✅ SQLite DB created at {args.db}")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {str(e)}")
        sys.exit(1)
