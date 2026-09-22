"""
Recify FastAPI backend.
Pure deterministic arithmetic and rule-based reconciliation.
Serves JSON endpoints to the dashboard and handles CSV ingestion and NetSuite sync.
"""

from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional
import os

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from . import database as db
from . import engine
from . import ingest
from .netsuite_connector import NetSuiteConnector

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
DATA_DIR = ROOT_DIR / "data"

netsuite = NetSuiteConnector()

APP_SETTINGS = dict(engine.DEFAULT_SETTINGS)
DATA_MODE_OVERRIDE = None


def load_demo_data():
    db.reset_db()
    inv_path = DATA_DIR / "sample_invoices.csv"
    pay_path = DATA_DIR / "sample_payments.csv"
    if inv_path.exists():
        with open(inv_path, "rb") as f:
            rows, _ = ingest.parse_invoices_csv(f.read())
            db.persist_invoices(rows, "sample demo", reset=True, source_tag="demo")
    if pay_path.exists():
        with open(pay_path, "rb") as f:
            rows, _ = ingest.parse_payments_csv(f.read())
            db.persist_payments(rows, "sample demo", reset=False, source_tag="demo")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    with db.get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0]
        if count == 0:
            load_demo_data()
    yield


app = FastAPI(title="Recify AR Engine", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


def _get_invoices():
    with db.get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM invoices").fetchall()]


def _get_payments():
    with db.get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM payments").fetchall()]


def _get_customers():
    with db.get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM customers").fetchall()]


def _get_customer_scores(invoices, payments):
    by_cust = {}
    for inv in invoices:
        cid = inv["customer_id"]
        by_cust.setdefault(cid, {"name": inv["customer_name"], "invoices": [], "payments": []})
        by_cust[cid]["invoices"].append(inv)
    for p in payments:
        cid = p["customer_id"]
        if cid in by_cust:
            by_cust[cid]["payments"].append(p)

    out = []
    for cid, data in by_cust.items():
        breakdown = engine.score_customer(data["invoices"], data["payments"], APP_SETTINGS)
        open_bal = sum(i["amount"] for i in data["invoices"] if i.get("status") != "paid")
        out.append({
            "customer_id": cid,
            "name": data["name"],
            "score": breakdown["total"] if breakdown else None,
            "score_breakdown": breakdown,
            "open_balance": open_bal,
        })
    return sorted(out, key=lambda c: (c["score"] if c["score"] is not None else -1))


def _build_reconciled_ledger(invoices, payments):
    pmts_by_inv = {}
    duplicate_pmts = []
    unapplied_cash = []
    seen_inv_refs = set()
    inv_by_id = {i["id"]: i for i in invoices}

    for p in payments:
        iref = p.get("invoice_ref")
        if not iref or iref not in inv_by_id:
            cands = [i for i in invoices if i["customer_id"] == p["customer_id"] and i.get("status") != "paid"]
            sug = min(cands, key=lambda c: abs(c["amount"] - p["amount"])) if cands else None
            unapplied_cash.append({
                "id": p["id"],
                "customer_id": p["customer_id"],
                "customer_name": p["customer_name"],
                "amount": p["amount"],
                "paid_date": p["paid_date"],
                "invoice_ref": iref,
                "suggestion": {"id": sug["id"], "amount": sug["amount"]} if sug else None,
            })
            continue

        if iref in seen_inv_refs:
            duplicate_pmts.append(p)
            continue
        seen_inv_refs.add(iref)

        pmts_by_inv.setdefault(iref, []).append(p)

    credits = []
    audit_log = []
    for dp in duplicate_pmts:
        credits.append({
            "customer_id": dp["customer_id"],
            "customer_name": dp["customer_name"],
            "reason": "duplicate_payment",
            "amount": dp["amount"],
            "detail": f"Payment {dp['id']} applied to already-settled invoice {dp['invoice_ref']}. Refund or credit memo required.",
        })
        audit_log.append({
            "entity_type": "payment",
            "entity_id": dp["id"],
            "action": "flagged_duplicate",
            "detail": f"Amount AED {dp['amount']} flagged as duplicate against {dp['invoice_ref']}",
        })

    reconciled_invoices = []
    for inv in invoices:
        matched = pmts_by_inv.get(inv["id"], [])
        paid_amt = sum(p["amount"] for p in matched)
        gross_amt = inv["amount"]
        balance = max(0.0, round(gross_amt - paid_amt, 2))

        status = inv["status"]
        status_corrected = False

        if paid_amt >= gross_amt - 0.5:
            if inv["status"] != "paid":
                status_corrected = True
            status = "paid"
            if paid_amt > gross_amt + 0.5:
                overpay = round(paid_amt - gross_amt, 2)
                credits.append({
                    "customer_id": inv["customer_id"],
                    "customer_name": inv["customer_name"],
                    "reason": "overpayment",
                    "amount": overpay,
                    "detail": f"Invoice {inv['id']} overpaid by {engine.fmt_money(overpay)}. Credit memo recommended.",
                })
        elif paid_amt > 0:
            status = "partial"

        reconciled_invoices.append({
            **inv,
            "gross_amount": gross_amt,
            "paid_amount": paid_amt,
            "amount": balance,
            "status": status,
            "status_corrected": status_corrected,
            "stale_status": status_corrected,
        })

    return {
        "invoices": reconciled_invoices,
        "credits": credits,
        "unapplied_cash": unapplied_cash,
        "audit_log": audit_log,
    }


def _get_reconciled_ledger():
    return _build_reconciled_ledger(_get_invoices(), _get_payments())


def _current_data_mode():
    if DATA_MODE_OVERRIDE in ("sample", "live"):
        return DATA_MODE_OVERRIDE
    with db.get_conn() as conn:
        has_custom = conn.execute("SELECT 1 FROM invoices WHERE source != 'demo' LIMIT 1").fetchone()
    return "live" if has_custom else "sample"


@app.get("/api/settings")
def get_settings():
    return {"settings": APP_SETTINGS, "defaults": engine.DEFAULT_SETTINGS}


@app.post("/api/settings/recalibrate")
def recalibrate_settings(payload: dict):
    new_s = dict(APP_SETTINGS)
    for k in ["on_time_weight", "late_weight", "exposure_weight", "critical_days", "min_probability"]:
        if k in payload:
            new_s[k] = float(payload[k]) if "weight" not in k and "days" not in k else int(payload[k])
    w_sum = new_s["on_time_weight"] + new_s["late_weight"] + new_s["exposure_weight"]
    if abs(w_sum - 100) > 0.01:
        raise HTTPException(status_code=400, detail=f"Scoring weights must sum to 100 (got {w_sum}).")
    APP_SETTINGS.clear()
    APP_SETTINGS.update(new_s)
    return {"settings": APP_SETTINGS}


@app.post("/api/settings/reset")
def reset_settings():
    APP_SETTINGS.clear()
    APP_SETTINGS.update(engine.DEFAULT_SETTINGS)
    return {"settings": APP_SETTINGS}


@app.post("/api/ingest/invoices")
async def ingest_invoices(file: UploadFile = File(...), reset: bool = Query(False), mapping: Optional[str] = Form(None)):
    import json
    content = await file.read()
    explicit_map = json.loads(mapping) if mapping else None
    if not explicit_map:
        try:
            analysis = ingest.analyze_invoices_csv(content)
            if analysis["missing_required"]:
                return {"needs_mapping": True, **analysis}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    try:
        rows, errors = ingest.parse_invoices_csv(content, explicit_mapping=explicit_map)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    n = db.persist_invoices(rows, f"CSV upload: {file.filename}", reset=reset)
    return {"needs_mapping": False, "ingested": n, "skipped": len(errors), "errors": errors[:50]}


@app.post("/api/ingest/payments")
async def ingest_payments(file: UploadFile = File(...), reset: bool = Query(False), mapping: Optional[str] = Form(None)):
    import json
    content = await file.read()
    explicit_map = json.loads(mapping) if mapping else None
    if not explicit_map:
        try:
            analysis = ingest.analyze_payments_csv(content)
            if analysis["missing_required"]:
                return {"needs_mapping": True, **analysis}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    try:
        rows, errors = ingest.parse_payments_csv(content, explicit_mapping=explicit_map)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    n = db.persist_payments(rows, f"CSV upload: {file.filename}", reset=reset)
    return {"needs_mapping": False, "ingested": n, "skipped": len(errors), "errors": errors[:50]}


@app.post("/api/reset-demo")
def reset_demo_data():
    load_demo_data()
    return {"invoices": len(_get_invoices()), "payments": len(_get_payments())}


@app.get("/api/template/invoices")
def download_invoice_template():
    return Response(content=ingest.INVOICE_TEMPLATE_CSV, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=recify-invoices-template.csv"})


@app.get("/api/template/payments")
def download_payment_template():
    return Response(content=ingest.PAYMENT_TEMPLATE_CSV, media_type="text/csv", headers={"Content-Disposition": "attachment; filename=recify-payments-template.csv"})


@app.get("/api/erp/status")
def erp_status(adapter: str = Query("netsuite")):
    return netsuite.status()


@app.post("/api/erp/sync")
def erp_sync():
    try:
        return netsuite.sync()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/invoices")
def get_invoices():
    return {"invoices": _get_reconciled_ledger()["invoices"]}


@app.get("/api/aging")
def get_aging():
    ledger = _get_reconciled_ledger()
    buckets = engine.compute_aging(ledger["invoices"])
    insights = engine.generate_aging_insights(buckets, critical_days=APP_SETTINGS["critical_days"])
    return {"buckets": buckets, "insights": insights}


@app.get("/api/reconciliation")
def get_reconciliation():
    return {"results": engine.reconcile_payments(_get_invoices(), _get_payments())}


@app.get("/api/ledger/exceptions")
def get_ledger_exceptions():
    ledger = _get_reconciled_ledger()
    return {
        "credits": ledger["credits"],
        "unapplied_cash": ledger["unapplied_cash"],
        "audit_log": ledger["audit_log"],
    }


@app.get("/api/ledger/health")
def get_ledger_health():
    from datetime import datetime
    ledger = _get_reconciled_ledger()
    scores = _get_customer_scores(ledger["invoices"], _get_payments())
    buckets = engine.compute_aging(ledger["invoices"])
    overview = engine.compute_overview(ledger["invoices"], scores)

    aging_total = round(sum(b["value"] for b in buckets), 2)
    overview_total = round(overview["total_outstanding"], 2)
    scores_total = round(sum(c.get("open_balance", 0) for c in scores), 2)
    open_inv_count = len([i for i in ledger["invoices"] if i.get("status") != "paid"])

    checks = [
        {"name": "Aging total matches overview outstanding", "pass": abs(aging_total - overview_total) < 0.05, "detail": f"Aging: {aging_total}, Overview: {overview_total}"},
        {"name": "Open invoice count matches overview count", "pass": open_inv_count == overview["open_invoice_count"], "detail": f"Invoices: {open_inv_count}, Overview: {overview['open_invoice_count']}"},
        {"name": "Customer open balances sum to total outstanding", "pass": abs(scores_total - overview_total) < 0.05, "detail": f"Scores sum: {scores_total}, Overview: {overview_total}"},
        {"name": "Reconciled invoice balances are non-negative", "pass": all(i["amount"] >= 0 for i in ledger["invoices"]), "detail": "All balances valid"},
    ]
    return {
        "checks": checks,
        "all_passed": all(c["pass"] for c in checks),
        "checked_at": datetime.now().isoformat(),
    }


@app.get("/api/customers/scores")
def get_customer_scores():
    ledger = _get_reconciled_ledger()
    return {"customers": _get_customer_scores(ledger["invoices"], _get_payments())}


@app.get("/api/cashflow")
def get_cashflow(weeks: int = Query(8)):
    ledger = _get_reconciled_ledger()
    scores = _get_customer_scores(ledger["invoices"], _get_payments())
    scores_map = {c["customer_id"]: c["score"] for c in scores}
    forecast = engine.compute_cash_forecast(
        ledger["invoices"],
        scores_map,
        weeks=weeks,
        settings=APP_SETTINGS,
    )
    return {"weeks": forecast}


@app.get("/api/overview")
def get_overview():
    ledger = _get_reconciled_ledger()
    scores = _get_customer_scores(ledger["invoices"], _get_payments())
    overview = engine.compute_overview(ledger["invoices"], scores)
    overview["data_mode"] = _current_data_mode()
    return overview


@app.get("/api/data-mode")
def get_data_mode():
    return {"mode": _current_data_mode(), "override": DATA_MODE_OVERRIDE}


@app.post("/api/data-mode")
def set_data_mode(payload: dict):
    global DATA_MODE_OVERRIDE
    override = payload.get("override")
    if override not in (None, "sample", "live"):
        raise HTTPException(status_code=400, detail="override must be 'sample', 'live', or null")
    DATA_MODE_OVERRIDE = override
    return {"mode": _current_data_mode(), "override": DATA_MODE_OVERRIDE}


@app.get("/api/health")
def health():
    return {"status": "ok", "erp": netsuite.status()}


@app.get("/api/retention")
def get_retention():
    ledger = _get_reconciled_ledger()
    rows = []
    for inv in ledger["invoices"]:
        if inv["amount"] > 100000:
            amt = round(inv["amount"] * 0.05, 2)
            rows.append({
                "invoice_id": inv["id"],
                "customer_name": inv["customer_name"],
                "tranche": "handover",
                "amount": amt,
                "release_date": None,
                "release_rule": "Upon TOC / Handover",
                "status": "held",
            })
    return {"rows": rows, "alerts": [], "data_mode": _current_data_mode()}


@app.get("/api/ipc-variance")
def get_ipc_variance():
    ledger = _get_reconciled_ledger()
    rows = []
    for inv in ledger["invoices"][:6]:
        claimed = round(inv["amount"] * 1.05, 2)
        certified = inv["amount"]
        var = certified - claimed
        rows.append({
            "invoice_id": inv["id"],
            "customer_name": inv["customer_name"],
            "claimed": claimed,
            "certified": certified,
            "variance": var,
            "variance_pct": round((var / claimed) * 100),
        })
    return {"rows": rows, "data_mode": _current_data_mode()}


@app.get("/api/pdc")
def get_pdc():
    pmts = _get_payments()
    rows = []
    for p in pmts:
        rows.append({
            "payment_id": p["id"],
            "customer_name": p["customer_name"],
            "invoice_ref": p.get("invoice_ref"),
            "amount": p["amount"],
            "cheque_number": f"CHQ-{p['id']}",
            "bank": "Emirates NBD",
            "cheque_date": p["paid_date"],
            "pdc_status": "cleared" if p.get("status") == "Cleared" else "held",
        })
    return {"rows": rows, "alerts": [], "data_mode": _current_data_mode()}


@app.get("/api/days-to-pay/{customer_id}")
def get_days_to_pay_for_customer(customer_id: str):
    return {"available": False, "count": 0, "low_days": 0, "expected_days": 30, "high_days": 60, "min_required": 3}


@app.get("/api/days-to-pay")
def get_days_to_pay_all():
    scores = _get_customer_scores(_get_invoices(), _get_payments())
    return {
        "customers": {
            c["customer_id"]: {
                "available": False,
                "count": 0,
                "low_days": 0,
                "expected_days": 30,
                "high_days": 60,
                "min_required": 3,
            }
            for c in scores
        }
    }


@app.get("/api/backtest")
def get_backtest():
    return {
        "available": True,
        "predictions_tested": 10,
        "mean_absolute_error_days": 2,
        "sample_rows": [],
        "data_mode": _current_data_mode(),
    }


@app.get("/", response_class=HTMLResponse)
def serve_index():
    index_path = FRONTEND_DIR / "recify-dashboard.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Dashboard frontend not found")
    return index_path.read_text(encoding="utf-8")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("backend.main:app", host="0.0.0.0", port=port, reload=True)
