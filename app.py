from flask import Flask, render_template, request, send_file
import pandas as pd
import sqlite3
from pathlib import Path
import io
import os

app = Flask(__name__)

def process_mtg_cards(file, database_path, condition):
    """
    Process MTG card data from uploaded CSV, match with Scryfall database, and create output CSV.
    """
    try:
        # Read input CSV from uploaded file
        df = pd.read_csv(file)
        
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
        
        for _, row in df.iterrows():
            try:
                params = (row['Quantity'], row['Foil'], row['Scryfall ID'])
                cursor = conn.execute(sql_query, params)
                result = cursor.fetchone()
                if result:
                    results.append(result)
            except Exception:
                continue
        
        # Create output DataFrame
        output_df = pd.DataFrame(results, columns=[
            'Quantity', 'Product ID', 'Printing'
        ])
        output_df['Condition'] = condition
        
        # Create CSV in memory
        output = io.StringIO()
        output_df.to_csv(output, index=False)
        output.seek(0)
        return output
        
    except Exception as e:
        raise e
    finally:
        if 'conn' in locals():
            conn.close()

@app.route('/', methods=['GET'])
def index():
    conditions = ["Near Mint", "Lightly Played"]
    return render_template('index.html', conditions=conditions)

@app.route('/process', methods=['POST'])
def process():
    if 'file' not in request.files:
        return 'No file uploaded', 400
    
    file = request.files['file']
    condition = request.form.get('condition', 'Lightly Played')
    
    if file.filename == '':
        return 'No file selected', 400
        
    try:
        # Use the database path from the container
        db_path = '/app/scryfall.db'
        
        # Process the file
        output = process_mtg_cards(file, db_path, condition)
        
        # Send the file back to the user
        return send_file(
            io.BytesIO(output.getvalue().encode('utf-8')),
            mimetype='text/csv',
            as_attachment=True,
            download_name='processed_cards.csv'
        )
        
    except Exception as e:
        return str(e), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', debug=True)