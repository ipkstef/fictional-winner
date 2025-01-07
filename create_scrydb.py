import json
import sqlite3
import sys
from typing import Any, Dict, List
import requests

# download scryfall json and save it to a file
def download_scryfall_json():
    url = 'https://api.scryfall.com/bulk-data'
    response = requests.get(url)
    data = response.json()
    download_uri = data['data'][2]['download_uri']
    response = requests.get(download_uri)
    with open('scryfall.json', 'w') as f:
        json.dump(response.json(), f)
        

def detect_column_types(data: List[Dict[str, Any]]) -> Dict[str, str]:
    """Detect SQL column types based on JSON data types."""
    column_types = {}
    
    for item in data:
        for key, value in item.items():
            if key not in column_types:
                if isinstance(value, bool):
                    column_types[key] = 'BOOLEAN'
                elif isinstance(value, int):
                    column_types[key] = 'INTEGER'
                elif isinstance(value, float):
                    column_types[key] = 'REAL'
                elif isinstance(value, (dict, list)):
                    column_types[key] = 'TEXT'  # Store complex objects as JSON text
                else:
                    column_types[key] = 'TEXT'
                    
    return column_types

def create_table(cursor: sqlite3.Cursor, table_name: str, data: List[Dict[str, Any]]) -> None:
    """Create SQLite table based on JSON structure."""
    if not data:
        print("No data to process")
        return
        
    # Detect column types from data
    column_types = detect_column_types(data)
    
    # Create columns string for SQL query
    columns = ', '.join([f'"{col}" {dtype}' for col, dtype in column_types.items()])
    
    # Create table
    cursor.execute(f'CREATE TABLE IF NOT EXISTS "{table_name}" ({columns})')

def insert_data(cursor: sqlite3.Cursor, table_name: str, data: List[Dict[str, Any]]) -> None:
    """Insert JSON data into SQLite table."""
    if not data:
        return
        
    # Get column names from first item
    columns = list(data[0].keys())
    placeholders = ','.join(['?' for _ in columns])
    columns_str = ','.join([f'"{col}"' for col in columns])
    
    # Prepare and execute insert statement
    insert_query = f'INSERT INTO "{table_name}" ({columns_str}) VALUES ({placeholders})'
    
    for item in data:
        # Convert any complex objects (dict/list) to JSON string
        values = []
        for col in columns:
            val = item.get(col)
            if isinstance(val, (dict, list)):
                values.append(json.dumps(val))
            else:
                values.append(val)
        cursor.execute(insert_query, values)

def json_to_sqlite(json_file: str, db_file: str, table_name: str) -> None:
    """Convert JSON file to SQLite database."""
    try:
        # Read JSON file
        with open(json_file, 'r') as f:
            data = json.load(f)
        
        # Ensure data is a list of dictionaries
        if isinstance(data, dict):
            data = [data]
        elif not isinstance(data, list):
            raise ValueError("JSON must contain an object or array of objects")
            
        # Connect to SQLite database
        conn = sqlite3.connect(db_file)
        cursor = conn.cursor()
        
        # Create table and insert data
        create_table(cursor, table_name, data)
        insert_data(cursor, table_name, data)
        
        # Commit changes and close connection
        conn.commit()
        conn.close()
        
        print(f"Successfully converted {json_file} to SQLite database {db_file}")
        
    except Exception as e:
        print(f"Error: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python script.py <json_file> <db_file> <table_name>")
        sys.exit(1)
        
    json_to_sqlite(sys.argv[1], sys.argv[2], sys.argv[3])

    # download_scryfall_json()



    