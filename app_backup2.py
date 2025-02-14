from flask import Flask, render_template, request, jsonify
import pandas as pd
import requests
from io import StringIO
import csv
import sqlite3
import json
import logging
import threading
import time
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

app = Flask(__name__)

# Setup logging: errors and processed card info will be logged to "api_errors.log"
logging.basicConfig(
    filename='api_errors.log',
    level=logging.INFO,
    format='%(asctime)s %(levelname)s: %(message)s'
)

# Cache database filename
CACHE_DB = 'scryfall_cache.db'

# Global variables for rate limiting
api_lock = threading.Lock()
last_api_call_time = 0

def wait_for_rate_limit():
    """
    Wait 50–100 milliseconds between API calls.
    This function uses a lock to ensure that calls are spaced out
    by a random delay between 0.05 and 0.1 seconds.
    """
    global last_api_call_time
    with api_lock:
        now = time.time()
        delay = random.uniform(0.05, 0.1)
        elapsed = now - last_api_call_time
        if elapsed < delay:
            time.sleep(delay - elapsed)
        last_api_call_time = time.time()

def init_cache_db():
    """Initialize the cache database if it doesn't already exist."""
    conn = sqlite3.connect(CACHE_DB)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS card_cache (
            scryfall_id TEXT PRIMARY KEY,
            card_data TEXT
        )
    ''')
    conn.commit()
    conn.close()

def get_cached_card(scryfall_id):
    """Return cached card data for a given Scryfall ID, or None if not found."""
    try:
        conn = sqlite3.connect(CACHE_DB)
        cursor = conn.cursor()
        cursor.execute("SELECT card_data FROM card_cache WHERE scryfall_id = ?", (scryfall_id,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return json.loads(row[0])
    except Exception as e:
        logging.error(f"Error reading cache for {scryfall_id}: {str(e)}")
    return None

def cache_card_data(scryfall_id, card_data):
    """Cache the card data in the local cache database."""
    try:
        conn = sqlite3.connect(CACHE_DB)
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO card_cache (scryfall_id, card_data) VALUES (?, ?)",
                       (scryfall_id, json.dumps(card_data)))
        conn.commit()
        conn.close()
    except Exception as e:
        logging.error(f"Error caching data for {scryfall_id}: {str(e)}")

def fetch_card_data(scryfall_id):
    """
    Fetch card data from the cache first.
    If not present, wait for the rate limiter, then call the Scryfall API and cache the result.
    Returns a tuple (card_data, from_cache).
    """
    # Check cache first.
    cached = get_cached_card(scryfall_id)
    if cached is not None:
        return cached, True  # Data was retrieved from cache.
    
    # Wait to ensure we don't exceed the rate limit.
    wait_for_rate_limit()
    
    url = f"https://api.scryfall.com/cards/{scryfall_id}"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code != 200:
            logging.error(f"Error fetching {scryfall_id}: HTTP {response.status_code}")
            return None, False
        card_data = response.json()
        cache_card_data(scryfall_id, card_data)
        return card_data, False
    except Exception as e:
        logging.error(f"Exception fetching {scryfall_id}: {str(e)}")
        return None, False

def process_card_row(row, condition):
    """
    Process one CSV row:
      - Retrieve the card data (via cache or API)
      - Compute the printing (Foil/Normal)
      - Return a list of fields: [Quantity, Product ID, Printing, Condition].
    Raises an exception if any step fails.
    """
    scryfall_id = row.get('Scryfall ID')
    quantity = row.get('Quantity')
    foil_input = str(row.get('Foil', '')).strip().lower()  # Expected "foil" or "normal"
    
    if not scryfall_id:
        raise ValueError("Missing Scryfall ID")
    
    card_data, cached = fetch_card_data(scryfall_id)
    if not card_data:
        raise ValueError(f"Failed to fetch card data for {scryfall_id}")
    
    # Determine printing:
    if card_data.get('foil') and not card_data.get('nonfoil'):
        printing = 'Foil'
    elif not card_data.get('foil') and card_data.get('nonfoil'):
        printing = 'Normal'
    elif card_data.get('foil') and card_data.get('nonfoil'):
        printing = 'Foil' if foil_input == 'foil' else 'Normal'
    else:
        printing = 'Normal'
    
    product_id = card_data.get('tcgplayer_id', '')
    
    # Log processed card info with both Scryfall ID and TCGplayer ID.
    logging.info(f"Processed card: Scryfall ID: {scryfall_id}, TCGplayer ID: {product_id}")
    
    return [quantity, product_id, printing, condition]

def process_mtg_cards(csv_text, condition):
    try:
        # Read CSV input into a list of dictionaries.
        csv_file = StringIO(csv_text)
        csv_reader = csv.DictReader(csv_file)
        rows = [row for row in csv_reader if row]
        results = []
        errors = []
        
        # Initialize cache database.
        init_cache_db()
        
        # Use a ThreadPoolExecutor to process rows concurrently.
        with ThreadPoolExecutor(max_workers=10) as executor:
            future_to_row = {executor.submit(process_card_row, row, condition): row for row in rows}
            for future in as_completed(future_to_row):
                row = future_to_row[future]
                try:
                    result_row = future.result()
                    results.append(result_row)
                except Exception as exc:
                    scryfall_id = row.get('Scryfall ID', 'Unknown')
                    error_msg = f"Error processing card {scryfall_id}: {str(exc)}"
                    errors.append(error_msg)
                    logging.error(error_msg)
        
        # Define output CSV columns (only the four we need)
        columns = ['Quantity', 'Product ID', 'Printing', 'Condition']
        output_df = pd.DataFrame(results, columns=columns)
        output_csv = output_df.to_csv(index=False)
        return output_csv, errors
    
    except Exception as e:
        return None, [f"Error processing CSV: {str(e)}"]

@app.route('/', methods=['GET'])
def index():
    conditions = ["Near Mint", "Lightly Played"]
    return render_template('index.html', conditions=conditions)

@app.route('/process', methods=['POST'])
def process():
    csv_text = request.form.get('csv_text', '')
    condition = request.form.get('condition', 'Lightly Played')
    
    if not csv_text.strip():
        return jsonify({'error': 'No CSV data provided'}), 400
    
    try:
        output_csv, errors = process_mtg_cards(csv_text, condition)
        if output_csv is None:
            return jsonify({'error': errors[0]}), 400
        
        return jsonify({
            'csv': output_csv,
            'errors': errors
        })
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host="0.0.0.0", debug=True)
