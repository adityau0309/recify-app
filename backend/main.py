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
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Form
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import database as db
import engine
import ingest
import erp_connector

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
def _persist_invoices(conn, rows, source_label, reset, source_tag="csv"):
    if reset:
        db.reset_invoices_and_customers(conn)
    n = 0
    for row in rows:
        db.upsert_customer(conn, row["customer"], row["customer"], source=source_tag)
        db.upsert_invoice(
            conn, row["invoice_id"], row["customer"], row["amount"],
            row["issue_date"], row["due_date"], row["status"], source=source_tag,
            completion_date=row.get("completion_date"),
            claimed_milestone_value=row.get("claimed_milestone_value"),
            certified_ipc_amount=row.get("certified_ipc_amount"),
            retention_pct_handover=row.get("retention_pct_handover"),
            retention_pct_dlp=row.get("retention_pct_dlp"),
            retention_amount_handover=row.get("retention_amount_handover"),
            retention_amount_dlp=row.get("retention_amount_dlp"),
            retention_release_handover_date=row.get("retention_release_handover_date"),
            retention_release_dlp_date=row.get("retention_release_dlp_date"),
            retention_release_handover_rule=row.get("retention_release_handover_rule"),
            retention_release_dlp_rule=row.get("retention_release_dlp_rule"),
        )
        db.log(conn, "invoice", row["invoice_id"], "ingested", f"from {source_label}")
        n += 1
    return n

def _persist_payments(conn, rows, source_label, reset, source_tag="csv"):
    if reset:
        db.reset_payments(conn)
    n = 0
    for row in rows:
        db.insert_payment(
            conn, row["payment_id"], row["customer"], row["invoice_id"], row["amount_paid"],
            row["payment_date"], row["method"], row["status"], source=source_tag,
            cheque_number=row.get("cheque_number"), bank=row.get("bank"),
            cheque_date=row.get("cheque_date"), pdc_status=row.get("pdc_status"),
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
        n_inv = _persist_invoices(conn, inv_rows, "demo reset", reset=True, source_tag="demo")
        n_pay = _persist_payments(conn, pay_rows, "demo reset", reset=True, source_tag="demo")
    return {"invoices": n_inv, "payments": n_pay, "invoice_errors": inv_errors, "payment_errors": pay_errors}


@api.get("/template/invoices")
def template_invoices():
    return PlainTextResponse(ingest.INVOICE_TEMPLATE_CSV, media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=recify-invoices-template.csv"})

@api.get("/template/payments")
def template_payments():
    return PlainTextResponse(ingest.PAYMENT_TEMPLATE_CSV, media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=recify-payments-template.csv"})


@api.get("/erp/status")
def erp_status(adapter: str = "netsuite"):
    a = erp_connector.get_adapter(adapter)
    if a is None:
        raise HTTPException(404, f"No adapter registered for '{adapter}'.")
    return a.status()

@api.post("/erp/sync")
def erp_sync(adapter: str = "netsuite"):
    a = erp_connector.get_adapter(adapter)
    if a is None:
        raise HTTPException(404, f"No adapter registered for '{adapter}'.")
    if not a.is_configured():
        raise HTTPException(400, f"{a.name} credentials not configured. See erp_connector.py for setup steps.")
    with db.get_conn() as conn:
        for c in a.fetch_customers():
            db.upsert_customer(conn, str(c["id"]), c["name"], source=a.name)
        n_inv = 0
        for inv in a.fetch_open_invoices():
            db.upsert_invoice(conn, str(inv["id"]), str(inv["customer_id"]),
                               float(inv["amount"]), inv["issued_date"], inv["due_date"],
                               "open", source=a.name)
            n_inv += 1
        n_pay = 0
        for p in a.fetch_payments():
            db.insert_payment(conn, str(p["id"]), str(p["customer_id"]), None,
                               float(p["amount"]), p["paid_date"], source=a.name)
            n_pay += 1
    # NOTE: reaching this point means the HTTP calls succeeded — it does NOT
    # mean `a.verified` should be flipped. That's a manual, deliberate step
    # taken only after someone has reviewed the synced data against the
    # client's real books, not something this endpoint decides on its own.
    return {"invoices_synced": n_inv, "payments_synced": n_pay, "verified": a.verified}


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

def _ledger(conn):
    """The one source of truth. Every computed endpoint below builds from
    this, and only this — never from raw _load_invoices() directly."""
    return engine.build_reconciled_ledger(_load_invoices(conn), _load_payments(conn))

def _scores_from_ledger(reconciled_invoices, payments):
    by_cust = {}
    for inv in reconciled_invoices:
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

def _data_mode(conn):
    """'sample' if every record currently loaded came from the bundled demo
    reset, 'live' the moment anything real (a custom CSV import or a
    NetSuite sync) is present. A manual override in Settings can force
    either label — e.g. for a live demo using the sample set."""
    if SETTINGS.get("data_mode_override") in ("sample", "live"):
        return SETTINGS["data_mode_override"]
    sources = {r["source"] for r in conn.execute("SELECT DISTINCT source FROM invoices")}
    if not sources:
        return "sample"
    return "sample" if sources <= {"demo"} else "live"


# ---------------------------------------------------------------- computed endpoints
@api.get("/invoices")
def invoices():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
    return {"invoices": ledger["invoices"]}

@api.get("/aging")
def aging():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
    buckets = engine.compute_aging(ledger["invoices"])
    return {"buckets": buckets, "insights": engine.generate_aging_insights(buckets, critical_days=SETTINGS["critical_days"])}

@api.get("/reconciliation")
def reconciliation():
    """Payment-level diagnostics — classifies each payment against the
    ORIGINAL invoice amount (this is the audit trail that build_reconciled_ledger
    itself is derived from), distinct from the corrected ledger everything
    else reads."""
    with db.get_conn() as conn:
        invs = _load_invoices(conn)
        pays = _load_payments(conn)
    return {"results": engine.reconcile_payments(invs, pays)}

@api.get("/ledger/exceptions")
def ledger_exceptions():
    """Credits/refunds due and unapplied cash — the two buckets the
    reconciled ledger pulls out of the normal balance calculation rather
    than silently folding in anywhere."""
    with db.get_conn() as conn:
        ledger = _ledger(conn)
    return {"credits": ledger["credits"], "unapplied_cash": ledger["unapplied_cash"], "audit_log": ledger["audit_log"]}

@api.get("/ledger/health")
def ledger_health():
    """The four cross-page invariants, checked independently every time
    this is called — never cached, never assumed. Powers the small
    'Reconciled' indicator in the UI."""
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        payments = _load_payments(conn)
        scores = _scores_from_ledger(ledger["invoices"], payments)
        buckets = engine.compute_aging(ledger["invoices"])
        overview = engine.compute_overview(ledger["invoices"], scores)
    checks = engine.run_invariant_checks(overview, buckets, scores, ledger["invoices"])
    return {"checks": checks, "all_passed": all(c["pass"] for c in checks),
            "checked_at": datetime.utcnow().isoformat() + "Z"}

@api.get("/customers/scores")
def customer_scores():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        payments = _load_payments(conn)
    return {"customers": _scores_from_ledger(ledger["invoices"], payments)}

@api.get("/cashflow")
def cashflow(weeks: int = 8):
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        payments = _load_payments(conn)
        scores = {c["customer_id"]: c["score"] for c in _scores_from_ledger(ledger["invoices"], payments)}
    return {"weeks": engine.compute_cash_forecast(ledger["invoices"], scores, weeks=weeks, settings=SETTINGS)}

@api.get("/overview")
def overview():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        payments = _load_payments(conn)
        scores = _scores_from_ledger(ledger["invoices"], payments)
        mode = _data_mode(conn)
    result = engine.compute_overview(ledger["invoices"], scores)
    result["data_mode"] = mode
    return result

@api.get("/data-mode")
def data_mode():
    with db.get_conn() as conn:
        return {"mode": _data_mode(conn), "override": SETTINGS.get("data_mode_override")}

@api.post("/data-mode")
def set_data_mode(payload: dict):
    override = payload.get("override")
    if override not in (None, "sample", "live"):
        raise HTTPException(400, "override must be 'sample', 'live', or null")
    SETTINGS["data_mode_override"] = override
    with db.get_conn() as conn:
        return {"mode": _data_mode(conn), "override": SETTINGS.get("data_mode_override")}

@api.get("/health")
def health():
    a = erp_connector.get_adapter("netsuite")
    return {"status": "ok", "erp": a.status() if a else None}

@api.get("/retention")
def retention():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        mode = _data_mode(conn)
    rows = engine.compute_retention_view(ledger["invoices"])
    return {"rows": rows, "alerts": engine.generate_retention_alerts(rows), "data_mode": mode}

@api.get("/ipc-variance")
def ipc_variance():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        mode = _data_mode(conn)
    return {"rows": engine.compute_ipc_variance(ledger["invoices"]), "data_mode": mode}

@api.get("/pdc")
def pdc():
    with db.get_conn() as conn:
        payments = _load_payments(conn)
        mode = _data_mode(conn)
    rows = engine.compute_pdc_view(payments)
    return {"rows": rows, "alerts": engine.generate_pdc_alerts(rows), "data_mode": mode}

@api.get("/days-to-pay/{customer_id}")
def days_to_pay(customer_id: str):
    with db.get_conn() as conn:
        ledger = _ledger(conn)
    return engine.compute_days_to_pay_model(customer_id, ledger["invoices"])

@api.get("/days-to-pay")
def days_to_pay_all():
    """Bulk version — one model per customer that has enough history, plus
    a count of how many don't yet, so the UI can render the whole page in
    one request instead of one per customer."""
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        payments = _load_payments(conn)
        scores = _scores_from_ledger(ledger["invoices"], payments)
    results = {}
    for c in scores:
        results[c["customer_id"]] = engine.compute_days_to_pay_model(c["customer_id"], ledger["invoices"])
    return {"customers": results}

@api.get("/backtest")
def backtest():
    with db.get_conn() as conn:
        ledger = _ledger(conn)
        mode = _data_mode(conn)
    result = engine.backtest_days_to_pay(ledger["invoices"])
    result["data_mode"] = mode
    return result


app.mount("/api", api)

# ---------------------------------------------------------------- frontend
@app.get("/")
def serve_dashboard():
    return FileResponse(FRONTEND_DIR / "recify-dashboard.html")

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
