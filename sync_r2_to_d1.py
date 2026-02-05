#!/usr/bin/env python3
"""
Sync R2 Parquet data to Cloudflare D1.

Flow: R2 Parquet → DuckDB → SQLite → SQL dump → D1

Usage:
    python sync_r2_to_d1.py                    # Full sync
    python sync_r2_to_d1.py --skip-download    # Use existing tcg_data.db
    python sync_r2_to_d1.py --skip-import      # Create files only, don't import to D1
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import duckdb
from dotenv import load_dotenv

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
PRODUCTS_CHUNK_SIZE = 50_000  # Split products into chunks to avoid D1 CPU limits

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


def create_sql_dumps() -> list[Path]:
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
        dump_path.write_text("\n".join([f"-- Full refresh for {table_name}", result.stdout.strip(), ""]))
        log("done")
        return dump_path

    # 2. Groups dump (small table)
    dump_files.append(write_full_dump("groups"))

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

    products_chunks = (products_count + PRODUCTS_CHUNK_SIZE - 1) // PRODUCTS_CHUNK_SIZE
    log(f"  Splitting products into {products_chunks} chunks of ~{PRODUCTS_CHUNK_SIZE:,} rows each")

    for i, offset in enumerate(range(0, products_count, PRODUCTS_CHUNK_SIZE)):
        chunk_file = DUMP_DIR / f"dump_products_{i}.sql"
        log(f"  Dumping products chunk {i} (offset {offset:,})...", end=" ", flush=True)
        result = subprocess.run(
            [
                "sqlite3", str(SQLITE_FILE),
                "-cmd", ".mode insert products",
                f"SELECT * FROM products LIMIT {PRODUCTS_CHUNK_SIZE} OFFSET {offset};"
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        chunk_content = "\n".join(
            [
                f"-- Insert products chunk {i}",
                result.stdout.strip(),
                "",
            ]
        )
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
        chunk_content = "\n".join(
            [
                f"-- Insert SKU chunk {i}",
                result.stdout.strip(),
                "",
            ]
        )
        chunk_file.write_text(chunk_content)
        log("done")
        dump_files.append(chunk_file)

    # Print summary
    total_size = sum(f.stat().st_size for f in dump_files) / 1024 / 1024
    log(f"  Output: {len(dump_files)} files totaling {total_size:.1f} MB")
    for f in dump_files:
        log(f"    - {f.name} ({f.stat().st_size / 1024 / 1024:.1f} MB)")

    return dump_files


def import_to_d1(database: str, working_dir: Path, dump_files: list[Path]) -> None:
    """Import SQL dump files to Cloudflare D1 sequentially."""
    log(f"\n[3/3] Importing to D1 ({database})")

    for i, dump_file in enumerate(dump_files):
        dump_path = dump_file.resolve()
        log(f"  [{i+1}/{len(dump_files)}] Importing {dump_file.name}...", end=" ", flush=True)

        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", database, "--remote", f"--file={dump_path}"],
            cwd=working_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            log("FAILED")
            log(f"  Error: {result.stderr}")
            log(f"  Stdout: {result.stdout}")
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
    args = parser.parse_args()

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

    # Step 2: Create SQL dump files
    dump_files = create_sql_dumps()

    # Step 3: Import to D1
    if args.skip_import:
        log("\n[3/3] Skipping D1 import (--skip-import)")
        log("  To import manually, run these commands in order:")
        log(f"    cd {args.working_dir}")
        for dump_file in dump_files:
            log(f"    npx wrangler d1 execute {args.database} --remote --file={dump_file.resolve()}")
    else:
        import_to_d1(args.database, args.working_dir, dump_files)

    log("\n" + "=" * 60)
    log("Sync complete!")
    log("=" * 60)


if __name__ == "__main__":
    main()
