"""
Database layer — SQLite for a one-time-delivery build (no server/DBA needed
to run this). Swap DB_PATH / the connection function for Postgres later if
Kinetics' IT team wants to scale it up; the schema and queries stay the same.
"""
import sqlite3
from pathlib import Path
from contextlib import contextmanager

DB_PATH = Path(__file__).parent / "recify.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
    id              TEXT PRIMARY KEY,      -- NetSuite internal ID, or generated for CSV imports
    name            TEXT NOT NULL,
    payment_terms   INTEGER DEFAULT 30,    -- net terms in days
    credit_limit    REAL,
    source          TEXT DEFAULT 'manual'  -- 'netsuite' | 'csv' | 'manual'
);

CREATE TABLE IF NOT EXISTS invoices (
    id              TEXT PRIMARY KEY,      -- NetSuite tranid / internal id, or generated
    customer_id     TEXT NOT NULL,
    amount          REAL NOT NULL,
    issued_date     TEXT NOT NULL,         -- ISO date
    due_date        TEXT NOT NULL,         -- ISO date
    status          TEXT DEFAULT 'open',   -- open | paid | disputed | partial
    source          TEXT DEFAULT 'manual',
    ingested_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS payments (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT,
    invoice_ref     TEXT,                  -- the invoice ID as WRITTEN on the payment record —
                                            -- may not exist / may be wrong, that's the point
    amount          REAL NOT NULL,
    paid_date       TEXT NOT NULL,
    method          TEXT,
    status          TEXT,                  -- optional, as supplied by the source file (e.g. "Cleared")
                                            -- informational only — match_status is computed by the engine
    source          TEXT DEFAULT 'manual',
    ingested_at     TEXT DEFAULT (datetime('now'))
);

-- every automatic decision the engine makes gets logged here, so nothing
-- is a black box — Kinetics' team can audit exactly why a score or flag
-- came out the way it did.
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type     TEXT NOT NULL,         -- 'invoice' | 'payment' | 'customer'
    entity_id       TEXT NOT NULL,
    action          TEXT NOT NULL,         -- 'matched' | 'flagged_partial' | 'scored' | etc
    detail          TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);
"""

def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)

def _migrate(conn):
    """
    Lightweight, additive migrations for databases created by earlier
    versions of this schema. CREATE TABLE IF NOT EXISTS never alters an
    existing table, so new columns have to be added explicitly here.
    Safe to run on every startup — each ALTER is guarded by a column check.
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(payments)")}
    if "status" not in cols:
        conn.execute("ALTER TABLE payments ADD COLUMN status TEXT")

@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def upsert_customer(conn, id, name, payment_terms=30, credit_limit=None, source="manual"):
    conn.execute(
        """INSERT INTO customers (id, name, payment_terms, credit_limit, source)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name,
               payment_terms=excluded.payment_terms, credit_limit=excluded.credit_limit""",
        (id, name, payment_terms, credit_limit, source),
    )

def upsert_invoice(conn, id, customer_id, amount, issued_date, due_date, status="open", source="manual"):
    conn.execute(
        """INSERT INTO invoices (id, customer_id, amount, issued_date, due_date, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, status=excluded.status,
               due_date=excluded.due_date, issued_date=excluded.issued_date""",
        (id, customer_id, amount, issued_date, due_date, status, source),
    )

def insert_payment(conn, id, customer_id, invoice_ref, amount, paid_date, method=None, status=None, source="manual"):
    conn.execute(
        """INSERT INTO payments (id, customer_id, invoice_ref, amount, paid_date, method, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, paid_date=excluded.paid_date, status=excluded.status""",
        (id, customer_id, invoice_ref, amount, paid_date, method, status, source),
    )

def log(conn, entity_type, entity_id, action, detail=""):
    conn.execute(
        "INSERT INTO audit_log (entity_type, entity_id, action, detail) VALUES (?, ?, ?, ?)",
        (entity_type, entity_id, action, detail),
    )

def reset_invoices_and_customers(conn):
    """Wipes invoices + customers (and the audit log) ahead of a fresh invoice import.
    Payments are left alone here — reset_payments() clears those separately,
    so a two-file import (invoices then payments) doesn't wipe itself mid-flow."""
    conn.execute("DELETE FROM invoices")
    conn.execute("DELETE FROM customers")
    conn.execute("DELETE FROM audit_log")

def reset_payments(conn):
    conn.execute("DELETE FROM payments")
