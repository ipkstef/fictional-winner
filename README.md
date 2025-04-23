# MTG CSV Processor

A web application to convert ManaBox CSV exports to TCGPlayer-compatible format.

## Features

- Upload ManaBox CSV exports
- Match cards with TCGPlayer SKUs using a local SQLite database
- Generate TCGPlayer-compatible CSV for bulk imports
- View processing results and errors
- Download processed CSV files

## Prerequisites

- Python 3.7+
- SQLite database file (`mtg.db`) with Scryfall and SKU data

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/mtg-csv-processor.git
   cd mtg-csv-processor
   ```

2. Create a virtual environment:
   ```
   python -m venv venv
   
   # On Windows
   venv\Scripts\activate
   
   # On macOS/Linux
   source venv/bin/activate
   ```

3. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

4. Ensure you have the `mtg.db` database file in the project directory.
   - This SQLite database should contain the necessary Scryfall data and TCGPlayer SKUs.
   - If you don't have the database, you can run the `create_scrydb.py` script to generate it.

## Usage

1. Start the Flask application:
   ```
   python app.py
   ```

2. Open your web browser and navigate to:
   ```
   http://localhost:5000
   ```

3. Upload your ManaBox CSV export file.

4. After processing, you'll be redirected to the results page where you can:
   - View processing statistics
   - See any errors or skipped cards
   - Download the TCGPlayer-compatible CSV

5. Import the downloaded CSV to TCGPlayer.

## ManaBox CSV Format

The application expects the ManaBox CSV to have the following columns:
- Name
- Scryfall ID
- Quantity
- Purchase price
- Condition
- Foil

## Development

### Project Structure

- `app.py`: Main Flask application
- `templates/`: HTML templates
- `mtg.db`: SQLite database with Scryfall and TCGPlayer data
- `requirements.txt`: Python dependencies

### Database Schema

The application expects two tables in the SQLite database:

1. `scryfall`: Contains card data with at least these columns:
   - `id`: Scryfall ID
   - `tcgplayer_id`: TCGPlayer product ID
   - `tcgplayer_etched_id`: TCGPlayer product ID for etched versions

2. `sku`: Contains TCGPlayer SKU data with at least these columns:
   - `skuId`: TCGPlayer SKU ID
   - `productId`: TCGPlayer product ID
   - `language`: Card language
   - `condition`: Card condition
   - `printing`: Printing type ("FOIL" or "NON FOIL")

## License

MIT

## Contributors

- Your Name 