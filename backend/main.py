"""
Run with:  uvicorn main:app --reload --port 8000
Then open  http://localhost:8000  — the dashboard is served from this same
app and calls the API on the same origin, so there's no CORS setup needed
and nothing else to configure to see it working.
"""
import csv
import io
import json
import uuid
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Form
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import database as db
import engine
import ingest
import netsuite_connector as ns

app = FastAPI(title="Recify")
db.init_db()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
DATA_DIR = Path(__file__).parent.parent / "data"

api = FastAPI(title="Recify API (internal)")

# In-memory risk-engine settings (weights/thresholds), editable from the
# Settings modal. Kept simple on purpose for a one-time-delivery build —
# swap for a DB row if this needs to persist across restarts later.
SETTINGS = dict(engine.DEFAULT_SETTINGS)


# ---------------------------------------------------------------- settings
@api.get("/settings")
def get_settings():
    return {"settings": SETTINGS, "defaults": engine.DEFAULT_SETTINGS}

@api.post("/settings/recalibrate")
def recalibrate(payload: dict):
    """
    Accepts any subset of on_time_weight/late_weight/exposure_weight/
    critical_days/min_probability. Weights must sum to 100 (validated here,
    not just in the UI, so the numbers stay trustworthy no matter what
    calls this endpoint).
    """
    new_settings = dict(SETTINGS)
    for k in ("on_time_weight", "late_weight", "exposure_weight", "critical_days", "min_probability"):
        if k in payload:
            new_settings[k] = payload[k]
    w_sum = new_settings["on_time_weight"] + new_settings["late_weight"] + new_settings["exposure_weight"]
    if abs(w_sum - 100) > 0.01:
        raise HTTPException(400, f"Scoring weights must sum to 100 (got {w_sum}).")
    SETTINGS.update(new_settings)
    return {"settings": SETTINGS}

@api.post("/settings/reset")
def reset_settings():
    SETTINGS.clear()
    SETTINGS.update(engine.DEFAULT_SETTINGS)
    return {"settings": SETTINGS}


# ---------------------------------------------------------------- ingestion
def _persist_invoices(conn, rows, source_label, reset):
    if reset:
        db.reset_invoices_and_customers(conn)
    n = 0
    for row in rows:
        db.upsert_customer(conn, row["customer"], row["customer"], source="csv")
        db.upsert_invoice(
            conn, row["invoice_id"], row["customer"], row["amount"],
            row["issue_date"], row["due_date"], row["status"], source="csv",
        )
        db.log(conn, "invoice", row["invoice_id"], "ingested", f"from {source_label}")
        n += 1
    return n

def _persist_payments(conn, rows, source_label, reset):
    if reset:
        db.reset_payments(conn)
    n = 0
    for row in rows:
        db.insert_payment(
            conn, row["payment_id"], row["customer"], row["invoice_id"], row["amount_paid"],
            row["payment_date"], row["method"], row["status"], source="csv",
        )
        db.log(conn, "payment", row["payment_id"], "ingested", f"from {source_label}")
        n += 1
    return n


@api.post("/ingest/invoices")
async def ingest_invoices(file: UploadFile = File(...), reset: bool = Query(False), mapping: str = Form(None)):
    """
    Two-phase ingestion:
    1. No `mapping` supplied — tries alias auto-detection (see backend/ingest.py)
       against a wide set of common ERP header variants, after automatically
       skipping any leading metadata/title rows. If every required field
       resolves, ingests immediately.
    2. If required fields are still unresolved, nothing is persisted; instead
       returns {"needs_mapping": true, ...} with detected headers, a row
       preview, and whatever DID auto-match, so the UI can show the mapping
       wizard. Re-POST the same file with `mapping` (JSON: canonical field ->
       chosen header) to complete the import using that explicit mapping.
    Pass ?reset=true to replace the existing ledger rather than merge into it
    (only applied once data actually gets persisted).
    """
    content = await file.read()
    explicit_map = json.loads(mapping) if mapping else None

    if explicit_map is None:
        try:
            analysis = ingest.analyze_invoices_csv(content)
        except ingest.ImportError_ as e:
            raise HTTPException(400, str(e))
        if analysis["missing_required"]:
            return {"needs_mapping": True, **analysis}

    try:
        rows, errors = ingest.parse_invoices_csv(content, mapping=explicit_map)
    except ingest.ImportError_ as e:
        raise HTTPException(400, str(e))
    with db.get_conn() as conn:
        n = _persist_invoices(conn, rows, f"CSV upload: {file.filename}", reset)
    return {"needs_mapping": False, "ingested": n, "skipped": len(errors), "errors": errors[:50]}


@api.post("/ingest/payments")
async def ingest_payments(file: UploadFile = File(...), reset: bool = Query(False), mapping: str = Form(None)):
    """Same two-phase flow as /ingest/invoices — see that docstring."""
    content = await file.read()
    explicit_map = json.loads(mapping) if mapping else None

    if explicit_map is None:
        try:
            analysis = ingest.analyze_payments_csv(content)
        except ingest.ImportError_ as e:
            raise HTTPException(400, str(e))
        if analysis["missing_required"]:
            return {"needs_mapping": True, **analysis}

    try:
        rows, errors = ingest.parse_payments_csv(content, mapping=explicit_map)
    except ingest.ImportError_ as e:
        raise HTTPException(400, str(e))
    with db.get_conn() as conn:
        n = _persist_payments(conn, rows, f"CSV upload: {file.filename}", reset)
    return {"needs_mapping": False, "ingested": n, "skipped": len(errors), "errors": errors[:50]}


@api.post("/reset-demo")
def reset_demo():
    """Wipes whatever custom ledger is loaded and reloads the bundled UAE
    sample dataset (data/sample_invoices.csv, data/sample_payments.csv)."""
    inv_path = DATA_DIR / "sample_invoices.csv"
    pay_path = DATA_DIR / "sample_payments.csv"
    if not inv_path.exists() or not pay_path.exists():
        raise HTTPException(500, "Bundled demo CSVs are missing from the data/ folder.")
    # the bundled sample files use the original invoice_id,customer_name,amount,issued_date,due_date,status
    # header, which the flexible parser's aliasing already understands natively.
    inv_rows, inv_errors = ingest.parse_invoices_csv(inv_path.read_bytes())
    pay_rows, pay_errors = ingest.parse_payments_csv(pay_path.read_bytes())
    with db.get_conn() as conn:
        n_inv = _persist_invoices(conn, inv_rows, "demo reset", reset=True)
        n_pay = _persist_payments(conn, pay_rows, "demo reset", reset=True)
    return {"invoices": n_inv, "payments": n_pay, "invoice_errors": inv_errors, "payment_errors": pay_errors}


@api.get("/template/invoices")
def template_invoices():
    return PlainTextResponse(ingest.INVOICE_TEMPLATE_CSV, media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=recify-invoices-template.csv"})

@api.get("/template/payments")
def template_payments():
    return PlainTextResponse(ingest.PAYMENT_TEMPLATE_CSV, media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=recify-payments-template.csv"})


@api.post("/sync/netsuite")
def sync_netsuite():
    if not ns.is_configured():
        raise HTTPException(400, "NetSuite credentials not configured — see netsuite_connector.py")
    with db.get_conn() as conn:
        for c in ns.fetch_customers():
            db.upsert_customer(conn, str(c["id"]), c["name"], source="netsuite")
        n_inv = 0
        for inv in ns.fetch_open_invoices():
            db.upsert_invoice(conn, str(inv["id"]), str(inv["customer_id"]),
                               float(inv["amount"]), inv["issued_date"], inv["due_date"],
                               "open", source="netsuite")
            n_inv += 1
        n_pay = 0
        for p in ns.fetch_payments():
            db.insert_payment(conn, str(p["id"]), str(p["customer_id"]), None,
                               float(p["amount"]), p["paid_date"], source="netsuite")
            n_pay += 1
    return {"invoices_synced": n_inv, "payments_synced": n_pay}


# ---------------------------------------------------------------- read models
def _load_invoices(conn):
    rows = conn.execute(
        """SELECT invoices.*, customers.name AS customer_name
           FROM invoices JOIN customers ON invoices.customer_id = customers.id"""
    ).fetchall()
    return [dict(r) for r in rows]

def _load_payments(conn):
    rows = conn.execute(
        """SELECT payments.*, customers.name AS customer_name
           FROM payments LEFT JOIN customers ON payments.customer_id = customers.id"""
    ).fetchall()
    return [dict(r) for r in rows]

def _scores(conn):
    invoices = _load_invoices(conn)
    payments = _load_payments(conn)
    by_cust = {}
    for inv in invoices:
        by_cust.setdefault(inv["customer_id"], {"name": inv["customer_name"], "invoices": [], "payments": []})
        by_cust[inv["customer_id"]]["invoices"].append(inv)
    for p in payments:
        if p["customer_id"] in by_cust:
            by_cust[p["customer_id"]]["payments"].append(p)
    out = []
    for cid, d in by_cust.items():
        breakdown = engine.score_customer(d["invoices"], d["payments"], settings=SETTINGS)
        out.append({
            "customer_id": cid, "name": d["name"],
            "score": breakdown["total"] if breakdown else None,
            "score_breakdown": breakdown,
            "open_balance": round(sum(i["amount"] for i in d["invoices"] if i["status"] != "paid"), 2),
        })
    return sorted(out, key=lambda c: c["score"] if c["score"] is not None else 0)


# ---------------------------------------------------------------- computed endpoints
@api.get("/invoices")
def invoices():
    with db.get_conn() as conn:
        return {"invoices": _load_invoices(conn)}

@api.get("/aging")
def aging():
    with db.get_conn() as conn:
        invs = _load_invoices(conn)
    buckets = engine.compute_aging(invs)
    return {"buckets": buckets, "insights": engine.generate_aging_insights(buckets, critical_days=SETTINGS["critical_days"])}

@api.get("/reconciliation")
def reconciliation():
    with db.get_conn() as conn:
        invs = _load_invoices(conn)
        pays = _load_payments(conn)
    return {"results": engine.reconcile_payments(invs, pays)}

@api.get("/customers/scores")
def customer_scores():
    with db.get_conn() as conn:
        return {"customers": _scores(conn)}

@api.get("/cashflow")
def cashflow(weeks: int = 8):
    with db.get_conn() as conn:
        invs = _load_invoices(conn)
        scores = {c["customer_id"]: c["score"] for c in _scores(conn)}
    return {"weeks": engine.compute_cash_forecast(invs, scores, weeks=weeks, settings=SETTINGS)}

@api.get("/overview")
def overview():
    with db.get_conn() as conn:
        invs = _load_invoices(conn)
        scores = _scores(conn)
    return engine.compute_overview(invs, scores)

@api.get("/health")
def health():
    return {"status": "ok", "netsuite_configured": ns.is_configured()}


app.mount("/api", api)

# ---------------------------------------------------------------- frontend
@app.get("/")
def serve_dashboard():
    return FileResponse(FRONTEND_DIR / "recify-dashboard.html")

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
