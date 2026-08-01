import gzip
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import scryfall_bridge


class ScryfallBridgeTests(unittest.TestCase):
    def test_fetches_default_cards_jsonl_uri(self) -> None:
        metadata = {
            "data": [
                {
                    "type": "default_cards",
                    "jsonl_download_uri": "https://example.test/default-cards.jsonl.gz",
                }
            ]
        }
        response = io.BytesIO(json.dumps(metadata).encode("utf-8"))

        with patch("urllib.request.urlopen", return_value=response):
            uri = scryfall_bridge.fetch_default_cards_download_uri()

        self.assertEqual(uri, "https://example.test/default-cards.jsonl.gz")

    def test_does_not_fall_back_to_retired_json_uri(self) -> None:
        metadata = {
            "data": [
                {
                    "type": "default_cards",
                    "download_uri": "https://example.test/default-cards.json",
                }
            ]
        }
        response = io.BytesIO(json.dumps(metadata).encode("utf-8"))

        with patch("urllib.request.urlopen", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "no jsonl_download_uri"):
                scryfall_bridge.fetch_default_cards_download_uri()

    def test_populates_bridge_from_gzip_jsonl(self) -> None:
        cards = [
            {"id": "card-a", "tcgplayer_id": 101},
            {"id": "card-b", "tcgplayer_etched_id": "202"},
            {"id": "card-c"},
            {"id": "card-d", "tcgplayer_id": True},
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_path = root / "default-cards.jsonl.gz"
            db_path = root / "tcg_data.db"
            with gzip.open(data_path, "wb") as stream:
                for card in cards:
                    stream.write(json.dumps(card).encode("utf-8") + b"\n")

            inserted = scryfall_bridge.populate_scryfall_bridge(db_path, data_path)

            with sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    "SELECT scryfall_id, product_id, etched_product_id "
                    "FROM scryfall_bridge ORDER BY scryfall_id"
                ).fetchall()

        self.assertEqual(inserted, 2)
        self.assertEqual(rows, [("card-a", 101, None), ("card-b", None, 202)])

    def test_rejects_uncompressed_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_path = Path(temp_dir) / "default-cards.jsonl"
            data_path.write_text('{"id":"card-a","tcgplayer_id":101}\n')

            with self.assertRaisesRegex(RuntimeError, "not gzip-compressed"):
                list(scryfall_bridge.iter_scryfall_cards(data_path))

    def test_invalid_jsonl_rolls_back_existing_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_path = root / "default-cards.jsonl.gz"
            db_path = root / "tcg_data.db"
            with gzip.open(data_path, "wb") as stream:
                stream.write(b'{"id":"new","tcgplayer_id":101}\nnot-json\n')

            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "CREATE TABLE scryfall_bridge ("
                    "scryfall_id TEXT PRIMARY KEY NOT NULL, "
                    "product_id INTEGER, etched_product_id INTEGER)"
                )
                conn.execute(
                    "INSERT INTO scryfall_bridge VALUES ('existing', 1, NULL)"
                )

            with self.assertRaisesRegex(RuntimeError, "Invalid Scryfall JSONL"):
                scryfall_bridge.populate_scryfall_bridge(db_path, data_path)

            with sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    "SELECT scryfall_id, product_id FROM scryfall_bridge"
                ).fetchall()

        self.assertEqual(rows, [("existing", 1)])


if __name__ == "__main__":
    unittest.main()
