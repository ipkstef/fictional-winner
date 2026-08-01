#!/usr/bin/env python3
"""
Build scryfall_bridge: ManaBox / Scryfall card id (UUID) -> TCGPlayer product_id.

Source: Scryfall bulk-data default_cards JSONL. Each object contributes one row
when it has at least one of tcgplayer_id or tcgplayer_etched_id (matches D1 products.product_id).
"""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

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
            uri = entry.get("jsonl_download_uri")
            if uri:
                return uri
            raise RuntimeError(
                "bulk-data default_cards entry had no jsonl_download_uri"
            )
    raise RuntimeError("bulk-data response had no default_cards entry")


def download_to_path(url: str, dest: Path, timeout: int = 600) -> None:
    """Stream a large file to disk and atomically replace dest when complete."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=_scryfall_http_headers(), method="GET")
    temp_path: Path | None = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=dest.parent,
                prefix=f".{dest.name}.",
                suffix=".tmp",
                delete=False,
            ) as out:
                temp_path = Path(out.name)
                while True:
                    chunk = resp.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
        if temp_path is None:
            raise RuntimeError(f"Download produced no temporary file for {url}")
        os.replace(temp_path, dest)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} downloading {url}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Error downloading {url}: {e.reason}") from e
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()


def ensure_default_cards_file(dest: Path, *, force_download: bool = False) -> Path:
    """Download compressed default_cards JSONL if missing or force_download."""
    if dest.exists() and not force_download:
        log(f"Using existing Scryfall bulk file {dest}")
        return dest
    log("Fetching Scryfall bulk-data metadata...")
    uri = fetch_default_cards_download_uri()
    log(f"Downloading default_cards JSONL (gzip) to {dest} ...")
    download_to_path(uri, dest)
    log("Download complete")
    return dest


def iter_scryfall_cards(path: Path) -> Iterator[dict[str, object]]:
    """Stream card objects from Scryfall's gzip-compressed JSONL."""
    with open(path, "rb") as raw:
        if raw.read(2) != b"\x1f\x8b":
            raise RuntimeError(f"Scryfall bulk data is not gzip-compressed: {path}")

    try:
        with gzip.open(path, "rb") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    card = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    raise RuntimeError(
                        f"Invalid Scryfall JSONL at {path}:{line_number}: {e}"
                    ) from e
                if not isinstance(card, dict):
                    raise RuntimeError(
                        f"Scryfall JSONL contained a non-object at "
                        f"{path}:{line_number}"
                    )
                yield card
    except (gzip.BadGzipFile, EOFError) as e:
        raise RuntimeError(f"Invalid or truncated Scryfall gzip file: {path}") from e


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


def populate_scryfall_bridge(sqlite_path: Path, data_path: Path) -> int:
    """
    Replace scryfall_bridge in sqlite_path with rows streamed from data_path.

    Returns number of rows inserted.
    """
    if not data_path.is_file():
        raise FileNotFoundError(f"Scryfall bulk data not found: {data_path}")

    conn = sqlite3.connect(str(sqlite_path))
    try:
        cur = conn.cursor()
        cur.execute("BEGIN")
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

        for card in iter_scryfall_cards(data_path):
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
            "CREATE INDEX idx_scryfall_bridge_product_id "
            "ON scryfall_bridge(product_id)"
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    log(f"scryfall_bridge: inserted {total:,} rows into {sqlite_path}")
    return total


def build_bridge(
    sqlite_path: Path,
    *,
    jsonl_path: Path | None = None,
    force_download: bool = False,
) -> int:
    """
    Ensure bulk JSONL gzip exists and populate scryfall_bridge in sqlite_path.

    If jsonl_path is None, uses default-cards.jsonl.gz next to this script.
    """
    default_jsonl = Path(__file__).resolve().parent / "default-cards.jsonl.gz"
    path = jsonl_path or default_jsonl
    ensure_default_cards_file(path, force_download=force_download)
    return populate_scryfall_bridge(sqlite_path, path)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Build scryfall_bridge table in a SQLite DB")
    p.add_argument("sqlite", type=Path, help="Path to tcg_data.db (or any SQLite file)")
    p.add_argument(
        "--jsonl",
        type=Path,
        default=None,
        help=(
            "Path to gzip-compressed default_cards JSONL "
            "(default: ./default-cards.jsonl.gz next to script)"
        ),
    )
    p.add_argument(
        "--force-download",
        action="store_true",
        help="Re-download default_cards even if the local JSONL gzip exists",
    )
    args = p.parse_args()
    try:
        n = build_bridge(
            args.sqlite,
            jsonl_path=args.jsonl,
            force_download=args.force_download,
        )
        log(f"Done ({n:,} rows)")
    except Exception as e:
        log(f"Error: {e}")
        sys.exit(1)
