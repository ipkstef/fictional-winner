import { Router } from 'itty-router';
import { error, json, missing } from 'itty-router-extras';

const router = Router();

// HTML template
const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MTG Card Processor</title>
    <script src="https://unpkg.com/papaparse@latest/papaparse.min.js"></script>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background-color: #f5f5f5;
            padding: 20px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        textarea {
            width: 100%;
            height: 200px;
            margin-bottom: 10px;
            font-family: monospace;
        }
        button {
            background-color: #4CAF50;
            color: white;
            padding: 10px 15px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        #errors { color: red; }
    </style>
</head>
<body>
    <div class="container">
        <h1>MTG Card Processor</h1>
        <div>
            <label for="csv_input">Input CSV:</label>
            <textarea id="csv_input"></textarea>
        </div>
        <div>
            <label for="condition">Condition:</label>
            <select id="condition">
                <option value="Near Mint">Near Mint</option>
                <option value="Lightly Played">Lightly Played</option>
            </select>
        </div>
        <button onclick="processCSV()">Process</button>
        <div>
            <label for="output">Output:</label>
            <textarea id="output" readonly></textarea>
        </div>
        <button onclick="copyOutput()">Copy Output</button>
        <div id="errors"></div>
    </div>
    <script>
        async function processCSV() {
            const csvText = document.getElementById('csv_input').value;
            const condition = document.getElementById('condition').value;
            
            try {
                const response = await fetch('/process', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        csv: csvText,
                        condition: condition
                    })
                });
                
                const data = await response.json();
                if (data.error) {
                    document.getElementById('errors').textContent = data.error;
                    document.getElementById('output').value = '';
                } else {
                    document.getElementById('output').value = data.csv;
                    document.getElementById('errors').textContent = '';
                }
            } catch (error) {
                document.getElementById('errors').textContent = error.message;
            }
        }

        function copyOutput() {
            const output = document.getElementById('output');
            output.select();
            document.execCommand('copy');
            alert('Copied to clipboard!');
        }
    </script>
</body>
</html>`;

// Serve the HTML page
router.get('/', () => new Response(html, {
    headers: { 'Content-Type': 'text/html' },
}));

// Process the CSV data
router.post('/process', async (request, env) => {
    try {
        const { csv, condition } = await request.json();
        
        if (!csv) {
            return error(400, 'No CSV data provided');
        }

        // Parse the CSV
        const rows = csv.trim().split('\n').map(row => {
            const [name, setCode, setName, collectorNumber, foil, rarity, quantity, _, scryfall_id, ...rest] = row.split(',');
            return { quantity, foil, scryfall_id };
        });

        // Skip header row
        rows.shift();

        // Process each row
        const results = [];
        for (const row of rows) {
            const card = await env.DB.prepare(`
                SELECT 
                    tcgplayer_id,
                    foil,
                    nonfoil
                FROM mtgjson_data 
                WHERE id = ?
            `).bind(row.scryfall_id).first();

            if (card) {
                let printing = 'Normal';
                if (card.foil && !card.nonfoil) {
                    printing = 'Foil';
                } else if (card.foil && card.nonfoil && row.foil === 'foil') {
                    printing = 'Foil';
                }

                results.push({
                    Quantity: row.quantity,
                    'Product ID': card.tcgplayer_id,
                    Printing: printing,
                    Condition: condition
                });
            }
        }

        // Convert results to CSV
        const outputCSV = [
            'Quantity,Product ID,Printing,Condition',
            ...results.map(r => `${r.Quantity},${r['Product ID']},${r.Printing},${r.Condition}`)
        ].join('\n');

        return json({ csv: outputCSV });
        
    } catch (err) {
        return error(500, err.message);
    }
});

router.all('*', () => missing('Not Found'));

export default {
    fetch: router.handle
};