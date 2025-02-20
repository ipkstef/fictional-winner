from flask import Flask, render_template, request, jsonify
import pandas as pd
import sqlite3
from io import StringIO
import csv

app = Flask(__name__)

def process_mtg_cards(csv_text, database_path, condition):
    conn = None
    try:
        csv_file = StringIO(csv_text)
        csv_reader = csv.reader(csv_file, 
                                quotechar='"', 
                                delimiter=',', 
                                quoting=csv.QUOTE_MINIMAL)
        
        headers = next(csv_reader)
        rows = [row for row in csv_reader]  # Store original CSV rows
        df = pd.DataFrame(rows, columns=headers)
        
        conn = sqlite3.connect(database_path)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mtgjson_id ON mtgjson_data(id)")
        
        sql_query = """
        SELECT 
            ? as Quantity,
            CASE 
            WHEN CAST(m.tcgplayer_etched_id AS INTEGER) IS NOT NULL THEN m.tcgplayer_etched_id
            ELSE CAST(m.tcgplayer_id AS INTEGER)
            END as "Product ID",
            CASE 
            WHEN CAST(m.tcgplayer_etched_id AS INTEGER) IS NOT NULL THEN 'Etched'
            WHEN m.foil AND NOT m.nonfoil THEN 'Foil'
            WHEN NOT m.foil AND m.nonfoil THEN 'Normal'
            WHEN m.foil AND m.nonfoil THEN
                CASE 
                WHEN ? = 'foil' THEN 'Foil'
                ELSE 'Normal'
                END
            END as Printing
        FROM mtgjson_data m
        WHERE m.id = ?
        """
        
        results = []
        errors = []
        
        for idx in range(len(df)):
            row = df.iloc[idx]
            original_csv_row = rows[idx]
            try:
                if pd.isna(row['Scryfall ID']) or pd.isna(row['Purchase price']):
                    raw_line = ','.join(original_csv_row)
                    errors.append(f"Skipped row {idx + 1}: Missing Scryfall ID or Purchase price. Raw input: {raw_line}")
                    continue

                params = (row['Quantity'], row['Foil'], row['Scryfall ID'])
                cursor = conn.execute(sql_query, params)
                result = cursor.fetchone()
                if result:
                    product_id = result[1]
                    if product_id is None:
                        raw_line = ','.join(original_csv_row)
                        errors.append(f"Skipped row {idx + 1}: No Product ID found. Raw input: {raw_line}")
                        continue
                    results.append(result)
                else:
                    raw_line = ','.join(original_csv_row)
                    errors.append(f"No match found for row {idx + 1}. Raw input: {raw_line}")
            except Exception as e:
                raw_line = ','.join(original_csv_row)
                errors.append(f"Error processing row {idx + 1}: {str(e)}. Raw input: {raw_line}")
        
        output_df = pd.DataFrame(results, columns=['Quantity', 'Product ID', 'Printing'])
        if not output_df.empty:
            output_df['Product ID'] = output_df['Product ID'].astype(int)
        output_df['Condition'] = condition
        
        output_csv = output_df.to_csv(index=False)
        return output_csv, errors
    
    except Exception as e:
        return None, [f"Error processing CSV: {str(e)}"]
    
    finally:
        if conn:
            conn.close()

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
        db_path = '/app/scryfall.db'
        output_csv, errors = process_mtg_cards(csv_text, db_path, condition)
        
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
    #your skills are going away