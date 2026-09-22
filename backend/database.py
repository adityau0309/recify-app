"""
Lightweight SQLite store for Recify.
Default state is populated from sample CSVs in /data so the demo works out of the box.
User-uploaded CSVs overwrite this state.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "recify.db"
SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    payment_terms INTEGER DEFAULT 30,
    source TEXT DEFAULT 'csv'
);

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    amount REAL NOT NULL,
    issued_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT DEFAULT 'csv',
    ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    invoice_ref TEXT,
    amount REAL NOT NULL,
    paid_date TEXT NOT NULL,
    method TEXT DEFAULT 'ACH',
    status TEXT DEFAULT 'Cleared',
    source TEXT DEFAULT 'csv',
    ingested_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)


def reset_db():
    if DB_PATH.exists():
        DB_PATH.unlink()
    init_db()


def persist_invoices(rows, source_label, reset=False, source_tag="csv"):
    with get_conn() as conn:
        if reset:
            conn.execute("DELETE FROM invoices")
            conn.execute("DELETE FROM customers")
            conn.execute("DELETE FROM audit_log WHERE entity_type='invoice'")
        for r in rows:
            conn.execute(
                "INSERT OR IGNORE INTO customers (id, name, source) VALUES (?, ?, ?)",
                (r["customer"], r["customer"], source_tag),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO invoices
                (id, customer_id, customer_name, amount, issued_date, due_date, status, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    r["invoice_id"],
                    r["customer"],
                    r["customer"],
                    r["amount"],
                    r["issue_date"],
                    r["due_date"],
                    r["status"],
                    source_tag,
                ),
            )
            conn.execute(
                "INSERT INTO audit_log (entity_type, entity_id, action, detail) VALUES (?, ?, ?, ?)",
                ("invoice", r["invoice_id"], "ingested", f"from {source_label}"),
            )
    return len(rows)


def persist_payments(rows, source_label, reset=False, source_tag="csv"):
    with get_conn() as conn:
        if reset:
            conn.execute("DELETE FROM payments")
            conn.execute("DELETE FROM audit_log WHERE entity_type='payment'")
        for r in rows:
            conn.execute(
                """
                INSERT OR REPLACE INTO payments
                (id, customer_id, customer_name, invoice_ref, amount, paid_date, method, status, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    r["payment_id"],
                    r["customer"],
                    r["customer"],
                    r["invoice_id"],
                    r["amount_paid"],
                    r["payment_date"],
                    r.get("method", "ACH"),
                    r.get("status", "Cleared"),
                    source_tag,
                ),
            )
            conn.execute(
                "INSERT INTO audit_log (entity_type, entity_id, action, detail) VALUES (?, ?, ?, ?)",
                ("payment", r["payment_id"], "ingested", f"from {source_label}"),
            )
    return len(rows)
