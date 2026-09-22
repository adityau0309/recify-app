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

CREATE TABLE IF NOT EXISTS ipc_records (
    id TEXT PRIMARY KEY,
    application_ref TEXT NOT NULL,
    project_name TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    claimed_amount_aed REAL NOT NULL,
    certified_amount_aed REAL NOT NULL,
    disallowed_variance_aed REAL NOT NULL,
    certification_date TEXT NOT NULL,
    engineer_name TEXT NOT NULL,
    dispute_status TEXT DEFAULT 'Under Commercial Dispute',
    justification TEXT,
    source TEXT DEFAULT 'enterprise_seed',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS retention_records (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    contract_ref TEXT NOT NULL,
    total_contract_value REAL NOT NULL,
    tranche_type TEXT NOT NULL,
    amount_aed REAL NOT NULL,
    milestone_date TEXT NOT NULL,
    milestone_status TEXT NOT NULL,
    source TEXT DEFAULT 'enterprise_seed',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pdc_records (
    id TEXT PRIMARY KEY,
    cheque_no TEXT NOT NULL,
    issuing_bank TEXT NOT NULL,
    drawer_entity TEXT NOT NULL,
    amount_aed REAL NOT NULL,
    maturity_date TEXT NOT NULL,
    maturity_status TEXT NOT NULL,
    invoice_ref TEXT,
    notes TEXT,
    source TEXT DEFAULT 'enterprise_seed',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ap_liabilities (
    id TEXT PRIMARY KEY,
    vendor_name TEXT NOT NULL,
    category TEXT NOT NULL,
    invoice_no TEXT NOT NULL,
    amount_aed REAL NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT DEFAULT 'Approved',
    prompt_discount_terms TEXT,
    notes TEXT,
    source TEXT DEFAULT 'enterprise_seed',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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


def seed_enterprise_modules():
    with get_conn() as conn:
        # Seed IPC records if empty
        ipc_count = conn.execute("SELECT COUNT(*) FROM ipc_records").fetchone()[0]
        if ipc_count == 0:
            sample_ipcs = [
                ("IPC-001", "IPC-07", "Burj Crown Residences MEP", "Al Barsha Gardens Contracting", 1450000.0, 1180000.0, 270000.0, "2026-08-28", "Khatib & Alami", "Under Commercial Dispute", "Unjustified de-scoping of chiller commissioning & pressure test variations.", "enterprise_seed"),
                ("IPC-002", "IPC-12", "Dubai South Logistics Hub 4", "Falcon Gulf Builders", 890000.0, 680000.0, 210000.0, "2026-08-10", "WSP Middle East", "Under Commercial Dispute", "Arbitrary deduction for unapproved tier-2 labor rate differentials.", "enterprise_seed"),
                ("IPC-003", "IPC-04", "Yas Bay Waterfront Hotel Fitout", "Al Maha Infrastructure", 2100000.0, 1850000.0, 250000.0, "2026-07-06", "Atkins Middle East", "Arbitration Escalation", "Disallowed structural ceiling acoustic baffle variations executed under site instruction.", "enterprise_seed"),
                ("IPC-004", "IPC-09", "Al Maryah Tower Shell & Core", "Crescent Gulf MEP", 620000.0, 620000.0, 0.0, "2026-09-04", "Parsons International", "Accepted", "Full certification granted without disallowance.", "enterprise_seed"),
                ("IPC-005", "IPC-03", "Meydan Horizon District Cooling", "Skyline Gulf Construction", 1320000.0, 1140000.0, 180000.0, "2026-07-25", "Mott MacDonald", "Under Commercial Dispute", "Withholding on pre-insulated pipe hydraulic flush certificates.", "enterprise_seed"),
                ("IPC-006", "IPC-15", "Dubai Hills Commercial Park C3", "Emirates Frame Works", 1780000.0, 1510000.0, 270000.0, "2026-07-21", "AECOM Middle East", "Arbitration Escalation", "Engineer refused time-extension related prolongation overheads.", "enterprise_seed"),
            ]
            conn.executemany(
                """
                INSERT OR REPLACE INTO ipc_records
                (id, application_ref, project_name, customer_name, claimed_amount_aed, certified_amount_aed, disallowed_variance_aed, certification_date, engineer_name, dispute_status, justification, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                sample_ipcs,
            )

        # Seed Retention records if empty
        ret_count = conn.execute("SELECT COUNT(*) FROM retention_records").fetchone()[0]
        if ret_count == 0:
            sample_retentions = [
                ("RET-001", "Palm Gateway Towers", "Al Noor Contracting LLC", "CNT-2024-PG01", 7700000.0, "Tranche A (TOC - 5%)", 385000.0, "2026-06-15", "Overdue Release (Breach of Contract)", "enterprise_seed"),
                ("RET-002", "Dubai Creek Harbour Tower 2", "Marina Bay Contracting", "CNT-2024-DCH02", 4800000.0, "Tranche A (TOC - 5%)", 240000.0, "2026-07-30", "Overdue Release (Breach of Contract)", "enterprise_seed"),
                ("RET-003", "Business Bay Sky Suites", "Desert Rose Construction", "CNT-2023-BB09", 8200000.0, "Tranche B (DLP - 5%)", 410000.0, "2026-09-28", "Due for Release (<30 Days)", "enterprise_seed"),
                ("RET-004", "Yas South Logistics Hub", "Meridian Gulf Projects", "CNT-2023-YSL04", 3900000.0, "Tranche B (DLP - 5%)", 195000.0, "2026-05-10", "Overdue Release (Breach of Contract)", "enterprise_seed"),
                ("RET-005", "Al Furjan Pavilion MEP", "Al Fahad Trading & Contracting", "CNT-2025-AFP03", 3200000.0, "Tranche A (TOC - 5%)", 160000.0, "2026-11-15", "Locked / In Progress", "enterprise_seed"),
                ("RET-006", "Al Reem Residential Tower", "Zenith MEP Contracting", "CNT-2023-ARR01", 5800000.0, "Tranche B (DLP - 5%)", 290000.0, "2026-04-01", "Released / Settled", "enterprise_seed"),
            ]
            conn.executemany(
                """
                INSERT OR REPLACE INTO retention_records
                (id, project_name, customer_name, contract_ref, total_contract_value, tranche_type, amount_aed, milestone_date, milestone_status, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                sample_retentions,
            )

        # Seed PDC records if empty
        pdc_count = conn.execute("SELECT COUNT(*) FROM pdc_records").fetchone()[0]
        if pdc_count == 0:
            sample_pdcs = [
                ("PDC-001", "CHQ-782190", "Emirates NBD", "Meridian Gulf Projects", 180500.0, "2026-09-24", "Due This Week", "KIN-5010", "Awaiting clearance window; presented at Emirates NBD Dubai main branch.", "enterprise_seed"),
                ("PDC-002", "CHQ-449102", "Abu Dhabi Commercial Bank (ADCB)", "Falcon Gulf Builders", 139900.0, "2026-09-26", "Due This Week", "KIN-5020", "Deposited at ADCB Trade Centre branch.", "enterprise_seed"),
                ("PDC-003", "CHQ-552188", "First Abu Dhabi Bank (FAB)", "Al Maha Infrastructure", 192600.0, "2026-09-18", "Dishonored / Bounced", "KIN-5016", "Dishonored: Refer to Drawer (insufficient funds). Formal legal notice dispatched under UAE Federal Decree Law No. 50/2022.", "enterprise_seed"),
                ("PDC-004", "CHQ-331908", "Dubai Islamic Bank (DIB)", "Crescent Gulf MEP", 164500.0, "2026-09-21", "In Transit / Deposited", "KIN-5021", "Under clearing cycle at UAE Central Bank ICCS.", "enterprise_seed"),
                ("PDC-005", "CHQ-992014", "Mashreq Bank", "Skyline Gulf Construction", 107900.0, "2026-10-05", "Held on Request", "KIN-5017", "Customer requested 14-day hold pending client main-contractor milestone settlement.", "enterprise_seed"),
                ("PDC-006", "CHQ-108744", "Commercial Bank of Dubai (CBD)", "Desert Rose Construction", 157100.0, "2026-08-20", "Cleared", "KIN-5034", "Successfully cleared and credited to Emirates NBD corporate operating account.", "enterprise_seed"),
            ]
            conn.executemany(
                """
                INSERT OR REPLACE INTO pdc_records
                (id, cheque_no, issuing_bank, drawer_entity, amount_aed, maturity_date, maturity_status, invoice_ref, notes, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                sample_pdcs,
            )

        # Seed AP liabilities if empty
        ap_count = conn.execute("SELECT COUNT(*) FROM ap_liabilities").fetchone()[0]
        if ap_count == 0:
            sample_aps = [
                ("AP-001", "National Manpower Solutions LLC", "Critical Path Labor", "AP-9101", 285000.0, "2026-09-25", "Approved", None, "Direct MEP labor payroll for Burj Crown & Dubai South sites. Non-negotiable deadline to avoid site strike.", "enterprise_seed"),
                ("AP-002", "Gulf Tech MEP Technicians", "Critical Path Labor", "AP-9102", 142000.0, "2026-09-28", "Approved", None, "Specialist cabling and duct installation team bi-weekly wage disbursement.", "enterprise_seed"),
                ("AP-003", "Daikin Middle East FZE", "Long-Lead Materials", "AP-8840", 390000.0, "2026-10-05", "Pending", "2/10 Net 30 (AED 7,800 prompt discount if paid by Sep 30)", "Chiller compressor delivery release. Prompt discount available.", "enterprise_seed"),
                ("AP-004", "Ducab Cable Systems", "Long-Lead Materials", "AP-8855", 215000.0, "2026-09-30", "Scheduled", None, "Armored XLPE 11kV low-smoke cables for Meydan project.", "enterprise_seed"),
                ("AP-005", "Emirates Ceiling & Drywall", "Standard Subcontractor", "AP-7712", 118000.0, "2026-10-12", "Pending", None, "Eligible for strategic 14-day deferral without impact on critical path.", "enterprise_seed"),
                ("AP-006", "Al Futtaim Scaffolding Rental", "Standard Subcontractor", "AP-7730", 76000.0, "2026-10-18", "Pending", None, "Heavy facade scaffolding rental. Standard 21-day stretch candidate.", "enterprise_seed"),
                ("AP-007", "BDO Corporate Tax & Audit Advisors", "Discretionary / Overhead", "AP-6501", 45000.0, "2026-10-25", "Pending", None, "Quarterly corporate tax and VAT statutory compliance advisory fee.", "enterprise_seed"),
            ]
            conn.executemany(
                """
                INSERT OR REPLACE INTO ap_liabilities
                (id, vendor_name, category, invoice_no, amount_aed, due_date, status, prompt_discount_terms, notes, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                sample_aps,
            )

