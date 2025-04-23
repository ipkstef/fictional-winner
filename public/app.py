import os
import csv
import sqlite3
import traceback
import datetime
import io
from flask import Flask, render_template, request, redirect, url_for, send_file, flash, session
from werkzeug.utils import secure_filename
import tempfile

# Create Flask app
app = Flask(__name__)
app.secret_key = os.urandom(24)  # For flash messages and sessions
app.config['UPLOAD_FOLDER'] = tempfile.gettempdir()
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # Limit upload size to 16MB

# ───────── CONFIG ─────────
DB_FILE = "/app/database/mtg.db"

# Add context processor for templates
@app.context_processor
def inject_current_year():
    """Add current_year to all template contexts for footer"""
    return {'current_year': datetime.datetime.now().year}

# ───────── HELPERS ─────────
def finish_for_sku(finish_raw):
    """
    ManaBox 'Foil' values: 'normal', 'foil', or e.g. 'etched'.
    Treat only 'normal' as NON FOIL; everything else as FOIL.
    """
    return "NON FOIL" if finish_raw.lower() == "normal" else "FOIL"

def map_condition(condition_raw):
    """
    Maps ManaBox condition values to TCGplayer standardized condition values
    
    mint,near_mint,excellent -> NEAR MINT
    good, light_played -> LIGHTLY PLAYED
    played -> MODERATELY PLAYED
    poor -> HEAVILY PLAYED
    """
    # Convert to lowercase and remove underscores for consistent comparison
    condition = condition_raw.lower().replace('_', '')
    
    # Map to TCGPlayer conditions
    if condition in ['mint', 'nearmint', 'excellent']:
        return 'NEAR MINT'
    elif condition in ['good', 'lightplayed']:
        return 'LIGHTLY PLAYED'
    elif condition in ['played']:
        return 'MODERATELY PLAYED'
    elif condition in ['poor']:
        return 'HEAVILY PLAYED'
    else:
        # Return the original value if no mapping is found, just formatted
        return condition_raw.replace('_', ' ').upper()

def process_csv_content(csv_content):
    """
    Process CSV content directly (from pasted text)
    Returns: (csv_output_content, errors, processed_count, skipped_count)
    
    NOTE: For mobile/paste method, we use headers "SKU" and "Quantity"
    """
    errors = []
    processed_count = 0
    skipped_count = 0
    
    # Create StringIO objects for input and output
    csv_input = io.StringIO(csv_content)
    csv_output = io.StringIO()
    
    try:
        # ───────── OPEN DB ─────────
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        
        # ───────── PROCESS ManaBox → OUTPUT CSV ─────────
        reader = csv.DictReader(csv_input)
        
        # Validate required columns
        required_columns = ["Name", "Scryfall ID", "Quantity", "Purchase price", "Condition", "Foil"]
        missing_columns = [col for col in required_columns if col not in reader.fieldnames]
        
        if missing_columns:
            raise ValueError(f"CSV content is missing required columns: {', '.join(missing_columns)}")
        
        # Mobile/paste format uses "SKU" and "Quantity" headers
        writer = csv.DictWriter(csv_output, fieldnames=[
            "SKU",
            "Quantity"
        ])
        writer.writeheader()
        
        for row in reader:
            name = row["Name"]
            scry_id = row["Scryfall ID"].strip()
            qty = row["Quantity"].strip()
            price = row["Purchase price"].strip()
            cond_raw = map_condition(row["Condition"])  # Map to standardized condition
            finish_raw = row["Foil"].strip()  # e.g. "normal", "foil", "etched"
            finish_sku = finish_for_sku(finish_raw)  # "NON FOIL" or "FOIL"
            
            # 1) Lookup in scryfall table
            cur.execute("""
                SELECT tcgplayer_id, tcgplayer_etched_id
                FROM scryfall
                WHERE id = ?
            """, (scry_id,))
            row_scry = cur.fetchone()
            if not row_scry:
                errors.append(f"Skipped {name}: no Scryfall entry for ID {scry_id}")
                skipped_count += 1
                continue
            
            tcg_id, tcg_etched = row_scry
            # 2) Choose productId based on finish
            if finish_raw.lower() not in ("normal", "foil") and tcg_etched:
                prod_id = tcg_etched
            else:
                prod_id = tcg_id
            
            if not prod_id:
                errors.append(f"Skipped {name}: no tcgplayer_id/etched_id in DB")
                skipped_count += 1
                continue
            
            # 3) Find the matching SKU entry
            cur.execute("""
                SELECT skuId
                FROM sku
                WHERE productId = ?
                AND language = 'ENGLISH'
                AND condition = ?
                AND printing = ?
                LIMIT 1
            """, (prod_id, cond_raw, finish_sku))
            sku_row = cur.fetchone()
            if not sku_row:
                errors.append(f"Skipped {name}: no SKU for {cond_raw}/{finish_sku}")
                skipped_count += 1
                continue
            
            sku_id = sku_row[0]
            
            # 4) Write output with mobile format
            writer.writerow({
                "SKU": sku_id,
                "Quantity": qty
            })
            processed_count += 1
        
        conn.close()
        
        # Get the CSV output content
        csv_output_content = csv_output.getvalue()
        
        # Log the successful processing
        print(f"app.py: Successfully processed {processed_count} cards with {skipped_count} skipped from pasted CSV")
        
        return csv_output_content, errors, processed_count, skipped_count
    
    except Exception as e:
        # Log the error
        print(f"app.py: Error processing pasted CSV: {str(e)}")
        if 'conn' in locals() and conn:
            conn.close()
        raise
    finally:
        # Clean up StringIO objects
        csv_input.close()
        csv_output.close()

def process_csv(input_file_path):
    """
    Process ManaBox CSV and generate TCGPlayer compatible CSV
    Returns: (output_file_path, errors)
    
    NOTE: For desktop/file upload method, we use headers "TCGplayer Id", "Add to Quantity", and "TCG Marketplace Price"
    """
    # Create a temporary file for the output
    fd, output_file_path = tempfile.mkstemp(suffix='.csv')
    os.close(fd)
    
    errors = []
    processed_count = 0
    skipped_count = 0
    
    # ───────── OPEN DB ─────────
    try:
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        
        # ───────── PROCESS ManaBox → OUTPUT CSV ─────────
        with open(input_file_path, newline="", encoding="utf-8") as infile, \
             open(output_file_path, "w", newline="", encoding="utf-8") as outfile:
            
            reader = csv.DictReader(infile)
            
            # Validate required columns
            required_columns = ["Name", "Scryfall ID", "Quantity", "Purchase price", "Condition", "Foil"]
            missing_columns = [col for col in required_columns if col not in reader.fieldnames]
            
            if missing_columns:
                raise ValueError(f"CSV file is missing required columns: {', '.join(missing_columns)}")
            
            # Desktop/file upload format uses "TCGplayer Id", "Add to Quantity", and "TCG Marketplace Price" headers
            writer = csv.DictWriter(outfile, fieldnames=[
                "TCGplayer Id",
                "Add to Quantity",
                "TCG Marketplace Price"
            ])
            writer.writeheader()
            
            for row in reader:
                name = row["Name"]
                scry_id = row["Scryfall ID"].strip()
                qty = row["Quantity"].strip()
                price = row["Purchase price"].strip()
                cond_raw = map_condition(row["Condition"])  # Map to standardized condition
                finish_raw = row["Foil"].strip()  # e.g. "normal", "foil", "etched"
                finish_sku = finish_for_sku(finish_raw)  # "NON FOIL" or "FOIL"
                
                # 1) Lookup in scryfall table
                cur.execute("""
                    SELECT tcgplayer_id, tcgplayer_etched_id
                    FROM scryfall
                    WHERE id = ?
                """, (scry_id,))
                row_scry = cur.fetchone()
                if not row_scry:
                    errors.append(f"Skipped {name}: no Scryfall entry for ID {scry_id}")
                    skipped_count += 1
                    continue
                
                tcg_id, tcg_etched = row_scry
                # 2) Choose productId based on finish
                if finish_raw.lower() not in ("normal", "foil") and tcg_etched:
                    prod_id = tcg_etched
                else:
                    prod_id = tcg_id
                
                if not prod_id:
                    errors.append(f"Skipped {name}: no tcgplayer_id/etched_id in DB")
                    skipped_count += 1
                    continue
                
                # 3) Find the matching SKU entry
                cur.execute("""
                    SELECT skuId
                    FROM sku
                    WHERE productId = ?
                    AND language = 'ENGLISH'
                    AND condition = ?
                    AND printing = ?
                    LIMIT 1
                """, (prod_id, cond_raw, finish_sku))
                sku_row = cur.fetchone()
                if not sku_row:
                    errors.append(f"Skipped {name}: no SKU for {cond_raw}/{finish_sku}")
                    skipped_count += 1
                    continue
                
                sku_id = sku_row[0]
                
                # 4) Write output with desktop format
                writer.writerow({
                    "TCGplayer Id": sku_id,
                    "Add to Quantity": qty,
                    "TCG Marketplace Price": price
                })
                processed_count += 1
        
        conn.close()
        
        # Log the successful processing
        print(f"app.py: Successfully processed {processed_count} cards with {skipped_count} skipped")
        
        # Save stats in session
        session['processed_count'] = processed_count
        session['skipped_count'] = skipped_count
        
        return output_file_path, errors
    
    except Exception as e:
        # Log the error
        print(f"app.py: Error processing CSV: {str(e)}")
        if 'conn' in locals() and conn:
            conn.close()
        raise

# ───────── ROUTES ─────────
@app.route('/')
def index():
    """
    Main page with file upload form
    """
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    """
    Handle CSV file upload and processing
    """
    # Check if the database exists
    if not os.path.exists(DB_FILE):
        flash('Database not found. Please make sure mtg.db exists in the application directory.', 'error')
        return redirect(url_for('index'))
    
    # Check if file part exists in request
    if 'file' not in request.files:
        flash('No file part', 'error')
        return redirect(url_for('index'))
    
    file = request.files['file']
    
    # Check if user selected a file
    if file.filename == '':
        flash('No selected file', 'error')
        return redirect(url_for('index'))
    
    # Check file extension
    if not file.filename.endswith('.csv'):
        flash('Only CSV files are allowed', 'error')
        return redirect(url_for('index'))
    
    # Save the uploaded file
    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)
    
    # Process the file
    try:
        output_path, errors = process_csv(filepath)
        
        # Store paths and errors in session
        session['input_path'] = filepath
        session['output_path'] = output_path
        session['errors'] = errors
        
        return redirect(url_for('results'))
    except ValueError as e:
        # Handle validation errors
        flash(f'Invalid input: {str(e)}', 'error')
        return redirect(url_for('index'))
    except sqlite3.Error as e:
        # Handle database errors
        error_title = "Database Error"
        error_message = "There was a problem with the database."
        error_details = str(e)
        return render_template('error.html', 
                              error_title=error_title,
                              error_message=error_message, 
                              error_details=error_details), 500
    except Exception as e:
        # Handle unexpected errors
        error_title = "Processing Error"
        error_message = "An error occurred while processing the CSV file."
        error_details = traceback.format_exc() if app.debug else str(e)
        return render_template('error.html', 
                              error_title=error_title,
                              error_message=error_message, 
                              error_details=error_details), 500

@app.route('/process-pasted-csv', methods=['POST'])
def process_pasted_csv():
    """
    Handle pasted CSV content and processing
    """
    # Check if the database exists
    if not os.path.exists(DB_FILE):
        flash('Database not found. Please make sure mtg.db exists in the application directory.', 'error')
        return redirect(url_for('index'))
    
    # Get CSV content from form
    csv_content = request.form.get('csv_content', '').strip()
    
    # Validate CSV content
    if not csv_content:
        flash('No CSV content provided', 'error')
        return redirect(url_for('index'))
    
    # Process the content
    try:
        csv_output, errors, processed_count, skipped_count = process_csv_content(csv_content)
        
        # Store data in session for potential reuse
        session['errors'] = errors
        session['processed_count'] = processed_count
        session['skipped_count'] = skipped_count
        
        # Render the text results page
        return render_template(
            'text_results.html',
            csv_content=csv_output,
            processed_count=processed_count,
            skipped_count=skipped_count,
            errors=errors[:100],  # Limit to 100 errors
            total_errors=len(errors)
        )
    except ValueError as e:
        # Handle validation errors
        flash(f'Invalid input: {str(e)}', 'error')
        return redirect(url_for('index'))
    except sqlite3.Error as e:
        # Handle database errors
        error_title = "Database Error"
        error_message = "There was a problem with the database."
        error_details = str(e)
        return render_template('error.html', 
                              error_title=error_title,
                              error_message=error_message, 
                              error_details=error_details), 500
    except Exception as e:
        # Handle unexpected errors
        error_title = "Processing Error"
        error_message = "An error occurred while processing the CSV content."
        error_details = traceback.format_exc() if app.debug else str(e)
        return render_template('error.html', 
                              error_title=error_title,
                              error_message=error_message, 
                              error_details=error_details), 500

@app.route('/results')
def results():
    """
    Show processing results and errors
    """
    # Check if output_path exists in session
    if 'output_path' not in session:
        flash('No processed file available. Please upload a file first.', 'error')
        return redirect(url_for('index'))
    
    # Get data from session
    processed_count = session.get('processed_count', 0)
    skipped_count = session.get('skipped_count', 0)
    errors = session.get('errors', [])
    
    return render_template(
        'results.html',
        processed_count=processed_count,
        skipped_count=skipped_count,
        errors=errors[:100],  # Limit to 100 errors
        total_errors=len(errors)
    )

@app.route('/download')
def download():
    """
    Download the processed CSV file
    """
    output_path = session.get('output_path')
    if not output_path or not os.path.exists(output_path):
        flash('No processed file available', 'error')
        return redirect(url_for('index'))
    
    try:
        return send_file(
            output_path,
            as_attachment=True,
            download_name='tcgplayer_upload.csv',
            mimetype='text/csv'
        )
    except Exception as e:
        flash(f'Error downloading file: {str(e)}', 'error')
        return redirect(url_for('results'))

# Clean up temporary files
@app.route('/cleanup', methods=['POST'])
def cleanup():
    """
    Clean up temporary files after download
    """
    # Remove input file
    input_path = session.get('input_path')
    if input_path and os.path.exists(input_path):
        try:
            os.remove(input_path)
        except Exception as e:
            print(f"app.py: Error removing input file: {str(e)}")
    
    # Remove output file
    output_path = session.get('output_path')
    if output_path and os.path.exists(output_path):
        try:
            os.remove(output_path)
        except Exception as e:
            print(f"app.py: Error removing output file: {str(e)}")
    
    # Clear session
    session.pop('input_path', None)
    session.pop('output_path', None)
    session.pop('errors', None)
    session.pop('processed_count', None)
    session.pop('skipped_count', None)
    
    flash('Files cleaned up successfully', 'success')
    return redirect(url_for('index'))

# ───────── ERROR HANDLERS ─────────
@app.errorhandler(404)
def page_not_found(e):
    """Handle 404 errors"""
    print(f"app.py: 404 error: {request.path}")
    return render_template('error.html', 
                          error_title="Page Not Found",
                          error_message="The page you requested does not exist."), 404

@app.errorhandler(500)
def server_error(e):
    """Handle 500 errors"""
    print(f"app.py: 500 error: {str(e)}")
    return render_template('error.html', 
                          error_title="Server Error",
                          error_message="An internal server error occurred."), 500

# Run the application
if __name__ == '__main__':
    # Create templates directory if it doesn't exist
    if not os.path.exists('templates'):
        os.makedirs('templates')
    
    # Check if database exists
    if not os.path.exists(DB_FILE):
        print(f"app.py: Warning: Database file {DB_FILE} not found.")
    
    app.run(debug=True, host='0.0.0.0', port=5000)
