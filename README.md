# Recify AR Engine — Kinetics build

A real, running system: real database, real ingestion, a deterministic
scoring/aging/reconciliation/forecast engine, and a dashboard that fetches
live from it — not a mockup with hardcoded numbers.

## Run it (one command)
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --port 8000
```
Open **http://localhost:8000** — that's it. The dashboard is served by the
same app and calls its own API, so there's nothing else to configure.

It opens empty the first time. Load the included realistic sample data
(modeled on a UAE engineering/contracting business — 18 customers, 41
invoices, 16 payments with deliberately messy real-world cases: partial
payments, overpayments, a duplicate, an unmatched reference, and invoices
whose status was never updated even though they were paid):
```bash
curl -F "file=@../data/sample_invoices.csv" http://localhost:8000/api/ingest/invoices
curl -F "file=@../data/sample_payments.csv" http://localhost:8000/api/ingest/payments
```
Refresh the browser — every page (Executive Summary, Cash Flow, Aging
Report, Reconciliation, Customers, Invoices) now shows real numbers
computed from that data. This exact sequence was run end-to-end (including
a real headless-browser click-through of every nav tab against the running
server) before delivery — it works.

To use Kinetics' real numbers instead: export their invoices/payments to
the same CSV columns (see below) and upload those files instead. Nothing
else changes.

## What's real vs. what's a placeholder

## Importing a custom ledger from the dashboard
Click **Import Data** in the sidebar (next to Settings) to upload your own invoices/payments CSVs directly from the browser — no terminal needed. It validates columns, parses mixed date formats (`YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`) and currency-prefixed amounts (`AED 12,000`, `$450.50`), skips and reports any row it can't parse instead of guessing, and on success replaces the ledger and recalculates every page live. "Reset to Kinetics Representative Demo Data" reloads the bundled sample dataset at any time. Template CSVs are downloadable from the same modal.

**Real, computed, live:**
- Aging buckets + written insights (Aging Report)
- Payment reconciliation with match/partial/overpaid/duplicate/unmatched/
  stale-status detection (Reconciliation)
- Credit score per customer — transparent formula, not a black box (Customers)
- Cash flow forecast — each open invoice weighted by that customer's own
  score, bucketed by due week (Cash Flow Prediction)
- Executive Summary KPIs, top exposure, at-risk customers (Overview)
- Full invoice list (Invoices)

**Honest placeholder — needs a data source Kinetics hasn't given us yet:**
- Follow-Ups and Disputes pages say plainly they're not connected, instead
  of showing invented activity. Wiring these up means connecting an email
  system or CRM — a separate, scoped piece of work.

## CSV formats
`invoices.csv`: `invoice_id,customer_name,amount,issued_date,due_date,status`
(status optional, defaults to `open`; use `paid`/`disputed` as needed)

`payments.csv`: `payment_id,customer_name,invoice_ref,amount,paid_date,method`
(`invoice_ref` is whatever invoice number is written on the payment — it's
fine if it's wrong or missing, that's exactly what reconciliation is for)

## Connecting NetSuite instead of CSV
1. Copy `backend/.env.example` to `backend/.env`.
2. Follow the 5 setup steps at the top of `backend/netsuite_connector.py`
   (needs Kinetics' NetSuite admin — "Manage Integrations" access).
3. Fill in the 5 values in `.env`.
4. `POST /api/sync/netsuite` pulls invoices, payments, and customers
   straight into the same database the dashboard already reads from.

**Honest caveat, unchanged from before:** this connector is built correctly
against NetSuite's public SuiteQL/REST docs, but hasn't been tested against
a live account — no Kinetics credentials to test with. Budget time to
validate against their sandbox before this goes live. Everything else in
this system (CSV path, engine, dashboard) has been tested and works today.

## Files
- `backend/database.py` — SQLite schema (customers, invoices, payments, audit log)
- `backend/engine.py` — aging, insights, reconciliation, scoring, cash forecast — all deterministic
- `backend/netsuite_connector.py` — NetSuite SuiteQL connector (untested against live account)
- `backend/main.py` — API + serves the dashboard
- `data/sample_invoices.csv`, `data/sample_payments.csv` — realistic sample dataset
- `frontend/recify-dashboard.html` — the dashboard, fetches live from the API
