#!/usr/bin/env python3
"""
Sync R2 Parquet data to Cloudflare D1.

Flow: R2 Parquet → DuckDB → SQLite → scryfall_bridge (Scryfall bulk JSON) → SQL dump → D1

Usage:
    python sync_r2_to_d1.py                    # Full sync (downloads default_cards if needed)
    python sync_r2_to_d1.py --skip-download    # Use existing tcg_data.db
    python sync_r2_to_d1.py --skip-import      # Create files only, don't import to D1
    python sync_r2_to_d1.py --skip-scryfall-bridge   # Omit scryfall_bridge table
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import duckdb
from dotenv import load_dotenv

import scryfall_bridge

load_dotenv()

# Configuration
R2_ENDPOINT = os.getenv("R2_ENDPOINT_URL", "").rstrip("/")
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET = os.getenv("R2_BUCKET")
CATEGORY_ID = "1"

SQLITE_FILE = Path("tcg_data.db")
DUMP_DIR = Path(".")  # Directory for dump files
SKU_CHUNK_SIZE = 500_000  # Split SKUs into chunks to avoid D1 reset
# D1 rejects statements over ~100 KB; huge image_url/name rows break .mode insert lines.
# Smaller chunks also reduce remote batch CPU/time failures (wrangler d1 execute --file).
PRODUCTS_CHUNK_SIZE = 12_000

# Character caps for products text columns when exporting (UTF-8 byte size of INSERT still matters).
_PRODUCT_NAME_CAP = 3000
_PRODUCT_CLEAN_CAP = 3000
_PRODUCT_IMAGE_URL_CAP = 8000

LOG_PREFIX = Path(__file__).name


def log(message: str = "", **kwargs) -> None:
    # Centralize logs so every message includes a file origin prefix.
    print(f"{LOG_PREFIX}: {message}", **kwargs)


def check_prerequisites() -> None:
    """Verify required tools and credentials are available."""
    # Check R2 credentials
    missing = []
    if not R2_ENDPOINT:
        missing.append("R2_ENDPOINT_URL")
    if not R2_ACCESS_KEY:
        missing.append("R2_ACCESS_KEY_ID")
    if not R2_SECRET_KEY:
        missing.append("R2_SECRET_ACCESS_KEY")
    if not R2_BUCKET:
        missing.append("R2_BUCKET")

    if missing:
        log(f"Error: Missing environment variables: {', '.join(missing)}")
        log("Add them to .env file")
        sys.exit(1)

    # Check sqlite3 is available
    try:
        subprocess.run(["sqlite3", "--version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        log("Error: sqlite3 command not found")
        sys.exit(1)


def download_parquet_to_sqlite() -> None:
    """Download Parquet files from R2 and create SQLite database."""
    log("\n[1/3] Downloading Parquet from R2 → SQLite")

    if SQLITE_FILE.exists():
        SQLITE_FILE.unlink()

    conn = duckdb.connect()

    # Install extensions
    conn.execute("INSTALL httpfs; LOAD httpfs;")
    conn.execute("INSTALL sqlite; LOAD sqlite;")

    # Configure S3/R2 access
    conn.execute(f"SET s3_endpoint = '{R2_ENDPOINT.replace('https://', '')}';")
    conn.execute(f"SET s3_access_key_id = '{R2_ACCESS_KEY}';")
    conn.execute(f"SET s3_secret_access_key = '{R2_SECRET_KEY}';")
    conn.execute("SET s3_region = 'auto';")
    conn.execute("SET s3_url_style = 'path';")

    # Attach SQLite output
    conn.execute(f"ATTACH '{SQLITE_FILE}' AS db (TYPE SQLITE)")
    conn.execute("USE db")

    # Define table sources
    tables = {
        "groups": f"s3://{R2_BUCKET}/{CATEGORY_ID}/groups.parquet",
        "products": f"s3://{R2_BUCKET}/{CATEGORY_ID}/products.parquet",
        "skus": f"s3://{R2_BUCKET}/{CATEGORY_ID}/skus.parquet",
    }

    # Copy each table
    for name, path in tables.items():
        log(f"  Copying {name}...", end=" ", flush=True)

        if name == "groups":
            # Convert boolean to integer for SQLite
            conn.execute(f"""
                CREATE TABLE {name} AS
                SELECT group_id, name, abbr,
                       CASE WHEN is_current THEN 1 ELSE 0 END AS is_current
                FROM '{path}'
            """)
        else:
            conn.execute(f"CREATE TABLE {name} AS SELECT * FROM '{path}'")

        count = conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        log(f"{count:,} rows")

    # Create indexes
    log("  Creating indexes...", end=" ", flush=True)
    conn.execute("CREATE INDEX idx_groups_abbr ON groups(abbr)")
    conn.execute("CREATE INDEX idx_products_lookup ON products(group_id, collector_number)")
    conn.execute("CREATE INDEX idx_skus_lookup ON skus(product_id, printing_id, condition_id, language_id)")
    log("done")

    conn.close()
    log(f"  Output: {SQLITE_FILE} ({SQLITE_FILE.stat().st_size / 1024 / 1024:.1f} MB)")


def _sqlite_quoted_ident(name: str) -> str:
    """Double-quote a SQLite identifier (handles reserved words and special chars)."""
    return '"' + name.replace('"', '""') + '"'


def _sqlite_table_column_names(db_path: Path, table: str) -> list[str]:
    """Table columns in creation order (matches INSERT column order for .mode insert)."""
    result = subprocess.run(
        ["sqlite3", str(db_path), f"PRAGMA table_info({table});"],
        capture_output=True,
        text=True,
        check=True,
    )
    cols: list[str] = []
    for line in (result.stdout or "").strip().splitlines():
        parts = line.split("|")
        if len(parts) >= 2 and parts[1].strip():
            cols.append(parts[1])
    return cols


def _products_select_fragment(col: str) -> str:
    """One SELECT expression per products column; cap long text fields for D1 statement limits."""
    q = _sqlite_quoted_ident(col)
    if col == "name":
        return f"substr(COALESCE({q}, ''), 1, {_PRODUCT_NAME_CAP})"
    if col == "clean_name":
        return f"substr(COALESCE({q}, ''), 1, {_PRODUCT_CLEAN_CAP})"
    if col == "image_url":
        return (
            f"CASE WHEN {q} IS NULL THEN NULL "
            f"WHEN length({q}) > {_PRODUCT_IMAGE_URL_CAP} "
            f"THEN substr({q}, 1, {_PRODUCT_IMAGE_URL_CAP}) ELSE {q} END"
        )
    return q


def _products_export_sql(columns: list[str], limit: int, offset: int) -> str:
    """Full SELECT: one expression per physical column, same order as PRAGMA table_info."""
    parts = [_products_select_fragment(c) for c in columns]
    return (
        f"SELECT {', '.join(parts)} FROM products "
        f"LIMIT {int(limit)} OFFSET {int(offset)}"
    )


def _log_wrangler_output(text: str, *, label: str) -> None:
    """Log long wrangler output with head/tail (errors are often JSON at the end)."""
    t = (text or "").strip()
    if not t:
        log(f"  {label}: (empty)")
        return
    head, tail = 3500, 3500
    if len(t) <= head + tail + 120:
        log(f"  {label}:\n{t}")
        return
    log(
        f"  {label} ({len(t)} chars, showing head+tail):\n"
        f"{t[:head]}\n... [{len(t) - head - tail} chars omitted] ...\n{t[-tail:]}"
    )


def sqlite_table_exists(db_path: Path, table: str) -> bool:
    """Return True if SQLite db exists and contains the named table."""
    if not db_path.is_file():
        return False
    result = subprocess.run(
        [
            "sqlite3",
            str(db_path),
            f"SELECT 1 FROM sqlite_master WHERE type='table' AND name='{table}' LIMIT 1;",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return bool(result.stdout.strip())


def create_sql_dumps(products_chunk_size: int | None = None) -> list[Path]:
    """Export SQLite to multiple SQL dump files, compatible with D1.

    Returns list of dump files in import order.
    """
    log("\n[2/3] Creating SQL dump files")

    dump_files = []

    # 1. Schema dump (includes indexes) with safe DROP/CREATE for D1 compatibility.
    schema_file = DUMP_DIR / "dump_schema.sql"
    log("  Dumping schema...", end=" ", flush=True)
    schema = subprocess.run(
        ["sqlite3", str(SQLITE_FILE), ".schema"],
        capture_output=True,
        text=True,
        check=True,
    )
    schema_lines = []
    for line in schema.stdout.splitlines():
        # DuckDB may emit "IF NOT EXISTS" which D1 doesn't like; strip it and use DROP first.
        clean_line = line.replace(" IF NOT EXISTS", "")
        if clean_line.startswith("CREATE TABLE "):
            # Extract table name using regex to handle quoted names and no-space-before-paren.
            match = re.search(r'CREATE TABLE\s+"?(\w+)"?\s*\(', clean_line)
            if match:
                table_name = match.group(1)
                schema_lines.append(f"DROP TABLE IF EXISTS {table_name};")
            schema_lines.append(clean_line)
        elif clean_line.startswith("CREATE UNIQUE INDEX "):
            match = re.search(r'CREATE UNIQUE INDEX\s+"?(\w+)"?\s', clean_line)
            if match:
                index_name = match.group(1)
                schema_lines.append(f"DROP INDEX IF EXISTS {index_name};")
            schema_lines.append(clean_line)
        elif clean_line.startswith("CREATE INDEX "):
            match = re.search(r'CREATE INDEX\s+"?(\w+)"?\s', clean_line)
            if match:
                index_name = match.group(1)
                schema_lines.append(f"DROP INDEX IF EXISTS {index_name};")
            schema_lines.append(clean_line)
        else:
            schema_lines.append(clean_line)
    schema_file.write_text("\n".join(schema_lines) + "\n")
    log("done")
    dump_files.append(schema_file)

    def write_full_dump(table_name: str) -> Path:
        # Write a full refresh dump for small tables.
        log(f"  Dumping {table_name}...", end=" ", flush=True)
        result = subprocess.run(
            ["sqlite3", str(SQLITE_FILE), "-cmd", f".mode insert {table_name}", f"SELECT * FROM {table_name};"],
            capture_output=True,
            text=True,
            check=True,
        )
        dump_path = DUMP_DIR / f"dump_{table_name}.sql"
        # D1 remote `wrangler d1 execute --file` can mis-parse multi-statement files that
        # start with `--` comments (workers-sdk#4713); emit statements only.
        body = (result.stdout or "").strip()
        dump_path.write_text(body + "\n" if body else "")
        log("done")
        return dump_path

    # 2. Groups dump (small table)
    dump_files.append(write_full_dump("groups"))

    # 2b. Scryfall bridge (ManaBox Scryfall UUID -> TCGPlayer product_id), optional small table
    if sqlite_table_exists(SQLITE_FILE, "scryfall_bridge"):
        dump_files.append(write_full_dump("scryfall_bridge"))
    else:
        log("  (no scryfall_bridge table — skipped dump)")

    # 3. Products dump - chunked to avoid D1 CPU limit.
    log("  Counting products...", end=" ", flush=True)
    products_count_result = subprocess.run(
        ["sqlite3", str(SQLITE_FILE), "SELECT COUNT(*) FROM products;"],
        capture_output=True,
        text=True,
        check=True,
    )
    products_count = int(products_count_result.stdout.strip())
    log(f"{products_count:,} rows")

    product_columns = _sqlite_table_column_names(SQLITE_FILE, "products")
    if not product_columns:
        log("Error: could not read columns for products (PRAGMA table_info)")
        sys.exit(1)
    log(f"  products table has {len(product_columns)} columns (export preserves all, caps long text)")

    psize = products_chunk_size if products_chunk_size is not None else PRODUCTS_CHUNK_SIZE
    products_chunks = (products_count + psize - 1) // psize
    log(
        f"  Splitting products into {products_chunks} chunks of ~{psize:,} rows "
        f"(text columns capped for D1 statement size limit)"
    )

    for i, offset in enumerate(range(0, products_count, psize)):
        chunk_file = DUMP_DIR / f"dump_products_{i}.sql"
        log(f"  Dumping products chunk {i} (offset {offset:,})...", end=" ", flush=True)
        result = subprocess.run(
            [
                "sqlite3",
                str(SQLITE_FILE),
                "-cmd",
                ".mode insert products",
                _products_export_sql(product_columns, psize, offset),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        chunk_content = (result.stdout or "").strip() + "\n"
        chunk_file.write_text(chunk_content)
        log("done")
        dump_files.append(chunk_file)

    # 4. SKUs dump - split into chunks to avoid D1 reset
    log("  Counting SKUs...", end=" ", flush=True)
    count_result = subprocess.run(
        ["sqlite3", str(SQLITE_FILE), "SELECT COUNT(*) FROM skus;"],
        capture_output=True,
        text=True,
        check=True,
    )
    sku_count = int(count_result.stdout.strip())
    log(f"{sku_count:,} rows")

    num_chunks = (sku_count + SKU_CHUNK_SIZE - 1) // SKU_CHUNK_SIZE
    log(f"  Splitting SKUs into {num_chunks} chunks of ~{SKU_CHUNK_SIZE:,} rows each")

    for i, offset in enumerate(range(0, sku_count, SKU_CHUNK_SIZE)):
        chunk_file = DUMP_DIR / f"dump_skus_{i}.sql"
        log(f"  Dumping skus chunk {i} (offset {offset:,})...", end=" ", flush=True)
        result = subprocess.run(
            [
                "sqlite3", str(SQLITE_FILE),
                "-cmd", ".mode insert skus",
                f"SELECT * FROM skus LIMIT {SKU_CHUNK_SIZE} OFFSET {offset};"
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        chunk_content = (result.stdout or "").strip() + "\n"
        chunk_file.write_text(chunk_content)
        log("done")
        dump_files.append(chunk_file)

    # Print summary
    total_size = sum(f.stat().st_size for f in dump_files) / 1024 / 1024
    log(f"  Output: {len(dump_files)} files totaling {total_size:.1f} MB")
    for f in dump_files:
        log(f"    - {f.name} ({f.stat().st_size / 1024 / 1024:.1f} MB)")

    return dump_files


def _wrangler_cmd() -> list[str]:
    """Prefer global wrangler (CI installs it); fall back to npx with --yes for non-interactive runs."""
    exe = shutil.which("wrangler")
    if exe:
        return [exe]
    return ["npx", "--yes", "wrangler"]


def import_to_d1(database: str, working_dir: Path, dump_files: list[Path]) -> None:
    """Import SQL dump files to Cloudflare D1 sequentially."""
    log(f"\n[3/3] Importing to D1 ({database})")

    for i, dump_file in enumerate(dump_files):
        dump_path = dump_file.resolve()
        log(f"  [{i+1}/{len(dump_files)}] Importing {dump_file.name}...", end=" ", flush=True)

        cmd = [
            *_wrangler_cmd(),
            "d1",
            "execute",
            database,
            "--remote",
            f"--file={dump_path}",
        ]
        result = subprocess.run(
            cmd,
            cwd=working_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            log("FAILED")
            err = (result.stderr or "").strip()
            out = (result.stdout or "").strip()
            log(f"  returncode={result.returncode} cmd={' '.join(cmd[:3])} ... --file=...")
            _log_wrangler_output(err, label="stderr")
            _log_wrangler_output(out, label="stdout")
            sys.exit(1)

        log("done")

    log("  All imports complete!")


def main():
    parser = argparse.ArgumentParser(
        description="Sync R2 Parquet data to Cloudflare D1",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--database", default="tcg-matcher-db", help="D1 database name")
    parser.add_argument("--skip-download", action="store_true", help="Skip Parquet download, use existing SQLite")
    parser.add_argument("--skip-import", action="store_true", help="Skip D1 import, only create local files")
    parser.add_argument("--working-dir", type=Path, default=Path(__file__).parent / "worker")
    parser.add_argument(
        "--skip-scryfall-bridge",
        action="store_true",
        help="Do not download/populate scryfall_bridge (D1 will omit this table on import)",
    )
    parser.add_argument(
        "--scryfall-json",
        type=Path,
        default=None,
        help="Path to Scryfall default_cards JSON (default: ./default-cards.json; downloaded if missing)",
    )
    parser.add_argument(
        "--refresh-scryfall-json",
        action="store_true",
        help="Re-download default_cards bulk file even if --scryfall-json already exists",
    )
    parser.add_argument(
        "--products-chunk-size",
        type=int,
        default=None,
        metavar="N",
        help=(
            f"Rows per products SQL dump file (default {PRODUCTS_CHUNK_SIZE}). "
            "Lower if wrangler fails mid-import (timeouts or statement size)."
        ),
    )
    args = parser.parse_args()

    if args.products_chunk_size is not None and args.products_chunk_size < 1:
        log("Error: --products-chunk-size must be >= 1")
        sys.exit(1)

    log("=" * 60)
    log("TCG Matcher: R2 Parquet → D1 Sync")
    log("=" * 60)

    check_prerequisites()

    # Step 1: Download Parquet to SQLite
    if args.skip_download:
        if not SQLITE_FILE.exists():
            log(f"Error: --skip-download specified but {SQLITE_FILE} not found")
            sys.exit(1)
        log(f"\n[1/3] Skipping download, using existing {SQLITE_FILE}")
    else:
        download_parquet_to_sqlite()

    # Step 1b: Scryfall id → TCGPlayer product bridge (streams bulk JSON; bounded memory)
    if args.skip_scryfall_bridge:
        log("\n[1b/3] Skipping scryfall_bridge (--skip-scryfall-bridge)")
    else:
        log("\n[1b/3] Building scryfall_bridge")
        default_json = Path(__file__).resolve().parent / "default-cards.json"
        json_path = args.scryfall_json or default_json
        scryfall_bridge.ensure_default_cards_json(
            json_path,
            force_download=args.refresh_scryfall_json,
        )
        scryfall_bridge.populate_scryfall_bridge(SQLITE_FILE, json_path)

    # Step 2: Create SQL dump files
    dump_files = create_sql_dumps(products_chunk_size=args.products_chunk_size)

    # Step 3: Import to D1
    if args.skip_import:
        log("\n[3/3] Skipping D1 import (--skip-import)")
        log("  To import manually, run these commands in order:")
        log(f"    cd {args.working_dir}")
        for dump_file in dump_files:
            log(
                f"    wrangler d1 execute {args.database} --remote --file={dump_file.resolve()}"
            )
    else:
        import_to_d1(args.database, args.working_dir, dump_files)

    log("\n" + "=" * 60)
    log("Sync complete!")
    log("=" * 60)


if __name__ == "__main__":
    main()
