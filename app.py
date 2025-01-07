from flask import Flask, render_template, request, jsonify
import pandas as pd
import sqlite3
from io import StringIO

app = Flask(__name__)

def process_mtg_cards(csv_text, database_path, condition):
    """
    Process MTG card data from CSV text, match with Scryfall database.
    """
    try:
        # Read CSV from string
        df = pd.read_csv(StringIO(csv_text))
        
        # Connect to SQLite database
        conn = sqlite3.connect(database_path)
        
        # Create an index on the id column if it doesn't exist
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mtgjson_id ON mtgjson_data(id)")
        
        # Construct the SQL query
        sql_query = """
        SELECT 
            ? as Quantity,
            m.tcgplayer_id as "Product ID",
            CASE 
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
        
        # Process each row and collect results
        results = []
        errors = []
        
        for idx, row in df.iterrows():
            try:
                params = (row['Quantity'], row['Foil'], row['Scryfall ID'])
                cursor = conn.execute(sql_query, params)
                result = cursor.fetchone()
                if result:
                    results.append(result)
                else:
                    errors.append(f"No match found for row {idx + 1}: {row['Scryfall ID']}")
            except Exception as e:
                errors.append(f"Error processing row {idx + 1}: {str(e)}")
        
        # Create output DataFrame
        output_df = pd.DataFrame(results, columns=[
            'Quantity', 'Product ID', 'Printing'
        ])
        output_df['Condition'] = condition
        
        # Convert back to CSV
        output_csv = output_df.to_csv(index=False)
        
        return output_csv, errors
        
    except Exception as e:
        return None, [f"Error processing CSV: {str(e)}"]
    finally:
        if 'conn' in locals():
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
    app.run(debug=False)