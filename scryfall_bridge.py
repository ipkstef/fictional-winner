#!/usr/bin/env python3
"""
Build scryfall_bridge: ManaBox / Scryfall card id (UUID) -> TCGPlayer product_id.

Source: Scryfall bulk-data default_cards JSON. Each object contributes one row
when it has at least one of tcgplayer_id or tcgplayer_etched_id (matches D1 products.product_id).
"""

from __future__ import annotations

import json
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

import ijson

LOG_PREFIX = Path(__file__).name

BULK_DATA_URL = "https://api.scryfall.com/bulk-data"
# Scryfall requires a descriptive User-Agent and an Accept header or returns HTTP 400.
USER_AGENT = "fictional-winner/1.0 (+https://github.com/ipkstef/fictional-winner)"
INSERT_BATCH = 8000


def _scryfall_http_headers() -> dict[str, str]:
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json;q=0.9,*/*;q=0.8",
    }


def log(message: str = "", **kwargs) -> None:
    print(f"{LOG_PREFIX}: {message}", **kwargs)


def fetch_default_cards_download_uri(timeout: int = 60) -> str:
    """Resolve the current default_cards bulk file URL from Scryfall."""
    req = urllib.request.Request(
        BULK_DATA_URL,
        headers=_scryfall_http_headers(),
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        meta = json.loads(resp.read().decode("utf-8"))
    for entry in meta.get("data", []):
        if entry.get("type") == "default_cards":
            uri = entry.get("download_uri")
            if uri:
                return uri
    raise RuntimeError("bulk-data response had no default_cards entry")


def download_to_path(url: str, dest: Path, timeout: int = 600) -> None:
    """Stream a large JSON file to disk (bounded memory)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=_scryfall_http_headers(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            with open(dest, "wb") as out:
                while True:
                    chunk = resp.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} downloading {url}") from e


def ensure_default_cards_json(dest: Path, *, force_download: bool = False) -> Path:
    """Download default_cards bulk JSON if missing or force_download."""
    if dest.exists() and not force_download:
        log(f"Using existing Scryfall bulk file {dest}")
        return dest
    log("Fetching Scryfall bulk-data metadata...")
    uri = fetch_default_cards_download_uri()
    log(f"Downloading default_cards (~large) to {dest} ...")
    download_to_path(uri, dest)
    log("Download complete")
    return dest


def _as_int_or_none(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def populate_scryfall_bridge(sqlite_path: Path, json_path: Path) -> int:
    """
    Replace scryfall_bridge in sqlite_path with rows streamed from json_path.

    Returns number of rows inserted.
    """
    if not json_path.is_file():
        raise FileNotFoundError(f"Scryfall JSON not found: {json_path}")

    conn = sqlite3.connect(str(sqlite_path))
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS scryfall_bridge")
    cur.execute(
        """
        CREATE TABLE scryfall_bridge (
            scryfall_id TEXT PRIMARY KEY NOT NULL,
            product_id INTEGER,
            etched_product_id INTEGER
        )
        """
    )

    insert_sql = """
        INSERT INTO scryfall_bridge (scryfall_id, product_id, etched_product_id)
        VALUES (?, ?, ?)
    """

    batch: list[tuple[str, int | None, int | None]] = []
    total = 0

    with open(json_path, "rb") as f:
        for card in ijson.items(f, "item"):
            if not isinstance(card, dict):
                continue
            sid = card.get("id")
            if not sid or not isinstance(sid, str):
                continue
            pid = _as_int_or_none(card.get("tcgplayer_id"))
            eid = _as_int_or_none(card.get("tcgplayer_etched_id"))
            if pid is None and eid is None:
                continue
            batch.append((sid, pid, eid))
            if len(batch) >= INSERT_BATCH:
                cur.executemany(insert_sql, batch)
                total += len(batch)
                batch.clear()

    if batch:
        cur.executemany(insert_sql, batch)
        total += len(batch)

    cur.execute(
        "CREATE INDEX idx_scryfall_bridge_product_id ON scryfall_bridge(product_id)"
    )
    conn.commit()
    conn.close()
    log(f"scryfall_bridge: inserted {total:,} rows into {sqlite_path}")
    return total


def build_bridge(
    sqlite_path: Path,
    *,
    json_path: Path | None = None,
    force_download: bool = False,
) -> int:
    """
    Ensure bulk JSON exists and populate scryfall_bridge in sqlite_path.

    If json_path is None, uses default-cards.json next to this script.
    """
    default_json = Path(__file__).resolve().parent / "default-cards.json"
    path = json_path or default_json
    ensure_default_cards_json(path, force_download=force_download)
    return populate_scryfall_bridge(sqlite_path, path)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Build scryfall_bridge table in a SQLite DB")
    p.add_argument("sqlite", type=Path, help="Path to tcg_data.db (or any SQLite file)")
    p.add_argument(
        "--json",
        type=Path,
        default=None,
        help="Path to default_cards JSON (default: ./default-cards.json next to script)",
    )
    p.add_argument(
        "--force-download",
        action="store_true",
        help="Re-download default_cards even if local JSON exists",
    )
    args = p.parse_args()
    try:
        n = build_bridge(args.sqlite, json_path=args.json, force_download=args.force_download)
        log(f"Done ({n:,} rows)")
    except Exception as e:
        log(f"Error: {e}")
        sys.exit(1)
