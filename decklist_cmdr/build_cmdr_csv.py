import csv
import os
import json
import sqlite3
import glob
from pathlib import Path


# URL for cloning the Commander Precons repository
url = "https://github.com/Westly/CommanderPrecons"


# Clone the repository if it doesn't exist
if not os.path.exists("decklist_cmdr/commander_precons"):
    try:
        print("decklist_cmdr/build_cmdr_csv.py: Cloning repository...")
        os.system(f"git clone {url} decklist_cmdr/commander_precons")
    except Exception as e:
        print(f"decklist_cmdr/build_cmdr_csv.py: Error cloning repository: {e}")

# Function to get SKU from database based on tcgplayer_id and finish
def get_sku(conn, tcgplayer_id, is_foil=False):
    cursor = conn.cursor()
    # Match the logic in public/app.py: 'NON FOIL' for non-foil, 'FOIL' for foil
    printing = 'FOIL' if is_foil else 'NON FOIL'
    condition = 'NEAR MINT'
    
    # Query the database to get the SKU for the card with the specified tcgplayer_id and finish
    # First prioritize by language (English), condition exact match, printing exact match
    # Then get consistent results by using a deterministic sort based on additional properties
    cursor.execute("""
        SELECT s.skuId, s.condition, s.printing, s.language 
        FROM sku s
        JOIN scryfall sf ON s.productId = sf.tcgplayer_id
        WHERE sf.tcgplayer_id = ? 
        AND s.printing = ? 
        AND s.condition = ?
        ORDER BY 
            CASE WHEN s.language = 'ENGLISH' THEN 0 ELSE 1 END,
            CASE WHEN s.condition = ? THEN 0 ELSE 1 END,
            CASE WHEN s.printing = ? THEN 0 ELSE 1 END,
            s.skuId
        LIMIT 1
    """, (tcgplayer_id, printing, condition, condition, printing))
    
    result = cursor.fetchone()
    if result:
        # Log the exact SKU being chosen and why
        print(f"decklist_cmdr/build_cmdr_csv.py: Selected SKU {result[0]} for tcgplayer_id {tcgplayer_id} with condition '{result[1]}', printing '{result[2]}', language '{result[3]}'")
        return result[0]
    return None

# Function to process a deck JSON file and create a CSV file
def process_deck(deck_path, output_dir, conn):
    print(f"decklist_cmdr/build_cmdr_csv.py: Processing {deck_path}")
    
    # Load the deck JSON file
    with open(deck_path, 'r', encoding='utf-8') as f:
        deck_data = json.load(f)
    
    # Check for exactly 99 cards in mainboard
    mainboard_count = deck_data.get('mainboardCount', 0)
    if mainboard_count != 99:
        print(f"decklist_cmdr/build_cmdr_csv.py: Skipping {deck_path} - mainboardCount is {mainboard_count}, not 99.")
        return None

    # Extract the deck name
    deck_name = deck_data.get('name', 'Unknown_Deck')
    deck_name = deck_name.replace('/', '_').replace('\\', '_')
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Create output CSV file
    output_path = os.path.join(output_dir, f"{deck_name}.csv")
    
    with open(output_path, 'w', newline='', encoding='utf-8') as outfile:
        # Create CSV writer with TCGPlayer required fields
        writer = csv.DictWriter(outfile, fieldnames=[
            "TCGplayer Id",
            "Name",
            "Add to Quantity",
            "TCG Marketplace Price"
        ])
        writer.writeheader()
        
        # Process commander cards using 'commanders' key and their printingData
        commanders = deck_data.get('commanders', {})
        main_card = deck_data.get('main', {})
        for cmdr_name, cmdr_data in commanders.items():
            card_info = cmdr_data.get('card', {})
            printing_data_list = cmdr_data.get('printingData', [])
            # Validate commander matches main field
            if card_info.get('name') != main_card.get('name'):
                print(f"decklist_cmdr/build_cmdr_csv.py: Warning: Commander '{card_info.get('name')}' does not match 'main' card '{main_card.get('name')}'.")
            
            # Edge case: No printingData available
            if not printing_data_list:
                print(f"decklist_cmdr/build_cmdr_csv.py: Commander {cmdr_name} has no printingData, using direct finish attribute")
                tcgplayer_id = card_info.get('tcgplayer_id')
                # Fall back to direct finish attribute from commander data
                is_foil = cmdr_data.get('finish', '').lower() == 'foil' or cmdr_data.get('isFoil', False)
                # Use price from JSON if available
                price = None
                if card_info.get('prices'):
                    if is_foil and card_info['prices'].get('usd_foil'):
                        price = card_info['prices']['usd_foil']
                    elif card_info['prices'].get('usd'):
                        price = card_info['prices']['usd']
                if price is None:
                    price = "500"
                if tcgplayer_id:
                    sku = get_sku(conn, tcgplayer_id, is_foil=is_foil)
                    if sku:
                        writer.writerow({
                            "TCGplayer Id": sku,
                            "Name": card_info.get('name', cmdr_name),
                            "Add to Quantity": cmdr_data.get('quantity', 1),
                            "TCG Marketplace Price": price
                        })
                        print(f"decklist_cmdr/build_cmdr_csv.py: Added commander {cmdr_name} with SKU {sku} (using direct finish)")
                continue  # Skip normal printingData processing
                
            # Use printingData for finish/foil
            for printing_data in printing_data_list:
                tcgplayer_id = card_info.get('tcgplayer_id')
                is_foil = printing_data.get('finish', '').lower() == 'foil' or printing_data.get('isFoil', False)
                # Use price from JSON if available
                price = None
                if card_info.get('prices'):
                    if is_foil and card_info['prices'].get('usd_foil'):
                        price = card_info['prices']['usd_foil']
                    elif card_info['prices'].get('usd'):
                        price = card_info['prices']['usd']
                if price is None:
                    price = "500"
                if tcgplayer_id:
                    sku = get_sku(conn, tcgplayer_id, is_foil=is_foil)
                    if sku:
                        writer.writerow({
                            "TCGplayer Id": sku,
                            "Name": card_info.get('name', cmdr_name),
                            "Add to Quantity": printing_data.get('quantity', 1),
                            "TCG Marketplace Price": price
                        })
                        print(f"decklist_cmdr/build_cmdr_csv.py: Added commander {cmdr_name} with SKU {sku}")

        # Process mainboard cards (excluding commanders if present)
        mainboard = deck_data.get('mainboard', {})
        for card_name, card_data in mainboard.items():
            card_info = card_data.get('card', {})
            tcgplayer_id = card_info.get('tcgplayer_id')
            quantity = card_data.get('quantity', 1)
            # If printingData exists and is a list, use it to generate rows for each finish
            if 'printingData' in card_data and isinstance(card_data['printingData'], list):
                for printing_data in card_data['printingData']:
                    is_foil = printing_data.get('finish', '').lower() == 'foil' or printing_data.get('isFoil', False)
                    # Use price from JSON if available
                    price = None
                    if card_info.get('prices'):
                        if is_foil and card_info['prices'].get('usd_foil'):
                            price = card_info['prices']['usd_foil']
                        elif card_info['prices'].get('usd'):
                            price = card_info['prices']['usd']
                    if price is None:
                        price = "50"
                    # Skip if this card is the commander (already processed)
                    if card_info.get('name') == main_card.get('name'):
                        continue
                    if tcgplayer_id:
                        sku = get_sku(conn, tcgplayer_id, is_foil=is_foil)
                        if sku:
                            writer.writerow({
                                "TCGplayer Id": sku,
                                "Name": card_info.get('name', card_name),
                                "Add to Quantity": printing_data.get('quantity', quantity),
                                "TCG Marketplace Price": price
                            })
                            print(f"decklist_cmdr/build_cmdr_csv.py: Added {printing_data.get('quantity', quantity)}x {card_name} with SKU {sku} (printingData)")
            else:
                is_foil = card_data.get('finish', '').lower() == 'foil' or card_data.get('isFoil', False)
                # Use price from JSON if available
                price = None
                if card_info.get('prices'):
                    if is_foil and card_info['prices'].get('usd_foil'):
                        price = card_info['prices']['usd_foil']
                    elif card_info['prices'].get('usd'):
                        price = card_info['prices']['usd']
                if price is None:
                    price = "50"
                # Skip if this card is the commander (already processed)
                if card_info.get('name') == main_card.get('name'):
                    continue
                if tcgplayer_id:
                    sku = get_sku(conn, tcgplayer_id, is_foil=is_foil)
                    if sku:
                        writer.writerow({
                            "TCGplayer Id": sku,
                            "Name": card_info.get('name', card_name),
                            "Add to Quantity": quantity,
                            "TCG Marketplace Price": price
                        })
                        print(f"decklist_cmdr/build_cmdr_csv.py: Added {quantity}x {card_name} with SKU {sku}")
    
    print(f"decklist_cmdr/build_cmdr_csv.py: Created CSV file: {output_path}")
    return output_path

def test_first():
    """Process only the first JSON file for testing purposes"""
    try:
        print("decklist_cmdr/build_cmdr_csv.py: TESTING - Processing only the first JSON file")
        conn = sqlite3.connect("../mtg.db")
        
        # Get list of JSON files in the precon_json directory
        json_files = glob.glob("decklist_cmdr/commander_precons/precon_json/*.json")
        
        if not json_files:
            print("decklist_cmdr/build_cmdr_csv.py: No JSON files found!")
            return
        
        # Sort files to ensure consistent "first" file
        json_files.sort()
        
        # Take only the first file
        first_file = json_files[0]
        print(f"decklist_cmdr/build_cmdr_csv.py: Testing with file: {os.path.basename(first_file)}")
        
        # Create output directory for CSV files
        output_dir = "decklist_cmdr/tcgplayer_cmdr_csv"
        
        # Process just the first deck
        try:
            output_path = process_deck(first_file, output_dir, conn)
            print(f"decklist_cmdr/build_cmdr_csv.py: Successfully processed {os.path.basename(first_file)}")
            print(f"decklist_cmdr/build_cmdr_csv.py: Output file: {output_path}")
        except Exception as e:
            print(f"decklist_cmdr/build_cmdr_csv.py: Error processing {os.path.basename(first_file)}: {e}")
        
    except Exception as e:
        print(f"decklist_cmdr/build_cmdr_csv.py: Error: {e}")
    finally:
        if 'conn' in locals():
            conn.close()

def main():
    # Connect to the SQLite database
    try:
        print("decklist_cmdr/build_cmdr_csv.py: Connecting to database...")
        conn = sqlite3.connect("mtg.db")
        
        # Get list of JSON files in the precon_json directory
        json_files = glob.glob("decklist_cmdr/commander_precons/precon_json/*.json")
        
        if not json_files:
            print("decklist_cmdr/build_cmdr_csv.py: No JSON files found!")
            return
        
        # Create output directory for CSV files
        output_dir = "decklist_cmdr/tcgplayer_cmdr_csv"
        
        # Process each deck
        for json_file in json_files:
            try:
                output_path = process_deck(json_file, output_dir, conn)
                print(f"decklist_cmdr/build_cmdr_csv.py: Successfully processed {os.path.basename(json_file)}")
            except Exception as e:
                print(f"decklist_cmdr/build_cmdr_csv.py: Error processing {os.path.basename(json_file)}: {e}")
        
        print("decklist_cmdr/build_cmdr_csv.py: All decks processed successfully!")
        
    except Exception as e:
        print(f"decklist_cmdr/build_cmdr_csv.py: Error: {e}")
    finally:
        if 'conn' in locals():
            conn.close()

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--test-first":
        test_first()
    else:
        main()
