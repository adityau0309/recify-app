import express from "express";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import { store } from "./src/store.js";
import {
  DEFAULT_SETTINGS,
  computeAging,
  generateAgingInsights,
  reconcilePayments,
  buildReconciledLedger,
  scoreCustomer,
  computeCashForecast,
  computeOverview,
  runInvariantChecks,
  computeRetentionView,
  generateRetentionAlerts,
  computeIpcVariance,
  computePdcView,
  generatePdcAlerts,
  computeDaysToPayModel,
  backtestDaysToPay
} from "./src/engine.js";
import {
  analyzeInvoicesCSV,
  analyzePaymentsCSV,
  parseInvoicesCSV,
  parsePaymentsCSV,
  INVOICE_TEMPLATE_CSV,
  PAYMENT_TEMPLATE_CSV
} from "./src/ingest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to compute ledger and customer scores
function getReconciledLedger() {
  const invoices = store.getAllInvoices();
  const payments = store.getAllPayments();
  return buildReconciledLedger(invoices, payments);
}

function getCustomerScores(reconciledInvoices, payments) {
  const byCust = new Map();
  for (const inv of reconciledInvoices) {
    const cid = inv.customer_id || inv.customer_name;
    if (!byCust.has(cid)) {
      byCust.set(cid, { name: inv.customer_name, invoices: [], payments: [] });
    }
    byCust.get(cid).invoices.push(inv);
  }
  for (const p of payments) {
    const cid = p.customer_id || p.customer_name;
    if (byCust.has(cid)) {
      byCust.get(cid).payments.push(p);
    }
  }

  const out = [];
  for (const [cid, d] of byCust.entries()) {
    const breakdown = scoreCustomer(d.invoices, d.payments, store.settings);
    const openBalance = Math.round(d.invoices.filter(i => i.status !== "paid").reduce((s, i) => s + i.amount, 0) * 100) / 100;
    out.push({
      customer_id: cid,
      name: d.name,
      score: breakdown ? breakdown.total : null,
      score_breakdown: breakdown,
      open_balance: openBalance
    });
  }

  return out.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
}

// ---------------------------------------------------------------- Settings
app.get("/api/settings", (req, res) => {
  res.json({ settings: store.settings, defaults: DEFAULT_SETTINGS });
});

app.post("/api/settings/recalibrate", (req, res) => {
  const payload = req.body || {};
  const newSettings = { ...store.settings };
  for (const k of ["on_time_weight", "late_weight", "exposure_weight", "critical_days", "min_probability"]) {
    if (k in payload) {
      newSettings[k] = Number(payload[k]);
    }
  }
  const wSum = newSettings.on_time_weight + newSettings.late_weight + newSettings.exposure_weight;
  if (Math.abs(wSum - 100) > 0.01) {
    return res.status(400).json({ detail: `Scoring weights must sum to 100 (got ${wSum}).` });
  }
  store.settings = newSettings;
  res.json({ settings: store.settings });
});

app.post("/api/settings/reset", (req, res) => {
  store.settings = { ...DEFAULT_SETTINGS };
  res.json({ settings: store.settings });
});

// ---------------------------------------------------------------- Ingestion
app.post("/api/ingest/invoices", upload.single("file"), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ detail: "No file uploaded." });
    }
    const content = req.file.buffer.toString("utf-8");
    const reset = req.query.reset === "true";
    let explicitMap = null;
    if (req.body.mapping) {
      try {
        explicitMap = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
      } catch (e) {
        explicitMap = null;
      }
    }

    if (!explicitMap) {
      const analysis = analyzeInvoicesCSV(content);
      if (analysis.missing_required.length > 0) {
        return res.json({ needs_mapping: true, ...analysis });
      }
    }

    const { rows, errors } = parseInvoicesCSV(content, explicitMap);
    const n = store.persistInvoices(rows, `CSV upload: ${req.file.originalname}`, reset);
    res.json({ needs_mapping: false, ingested: n, skipped: errors.length, errors: errors.slice(0, 50) });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

app.post("/api/ingest/payments", upload.single("file"), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ detail: "No file uploaded." });
    }
    const content = req.file.buffer.toString("utf-8");
    const reset = req.query.reset === "true";
    let explicitMap = null;
    if (req.body.mapping) {
      try {
        explicitMap = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
      } catch (e) {
        explicitMap = null;
      }
    }

    if (!explicitMap) {
      const analysis = analyzePaymentsCSV(content);
      if (analysis.missing_required.length > 0) {
        return res.json({ needs_mapping: true, ...analysis });
      }
    }

    const { rows, errors } = parsePaymentsCSV(content, explicitMap);
    const n = store.persistPayments(rows, `CSV upload: ${req.file.originalname}`, reset);
    res.json({ needs_mapping: false, ingested: n, skipped: errors.length, errors: errors.slice(0, 50) });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

app.post("/api/reset-demo", (req, res) => {
  store.loadSampleDemoData();
  const invoices = store.getAllInvoices();
  const payments = store.getAllPayments();
  res.json({ invoices: invoices.length, payments: payments.length, invoice_errors: [], payment_errors: [] });
});

app.get("/api/template/invoices", (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=recify-invoices-template.csv");
  res.send(INVOICE_TEMPLATE_CSV);
});

app.get("/api/template/payments", (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=recify-payments-template.csv");
  res.send(PAYMENT_TEMPLATE_CSV);
});

// ---------------------------------------------------------------- ERP status
app.get("/api/erp/status", (req, res) => {
  res.json({
    adapter: req.query.adapter || "netsuite",
    configured: false,
    verified: false,
    note: "NetSuite credentials not configured in environment. In-person and CSV import channels active."
  });
});

app.post("/api/erp/sync", (req, res) => {
  res.status(400).json({
    detail: "NetSuite credentials not configured. Please supply NETSUITE_ACCOUNT_ID and OAuth keys."
  });
});

// ---------------------------------------------------------------- Core Data & Computed Endpoints
app.get("/api/invoices", (req, res) => {
  const ledger = getReconciledLedger();
  res.json({ invoices: ledger.invoices });
});

app.get("/api/aging", (req, res) => {
  const ledger = getReconciledLedger();
  const buckets = computeAging(ledger.invoices);
  const insights = generateAgingInsights(buckets, store.settings.critical_days);
  res.json({ buckets, insights });
});

app.get("/api/reconciliation", (req, res) => {
  const invs = store.getAllInvoices();
  const pays = store.getAllPayments();
  res.json({ results: reconcilePayments(invs, pays) });
});

app.get("/api/ledger/exceptions", (req, res) => {
  const ledger = getReconciledLedger();
  res.json({
    credits: ledger.credits,
    unapplied_cash: ledger.unapplied_cash,
    audit_log: ledger.audit_log
  });
});

app.get("/api/ledger/health", (req, res) => {
  const ledger = getReconciledLedger();
  const payments = store.getAllPayments();
  const scores = getCustomerScores(ledger.invoices, payments);
  const buckets = computeAging(ledger.invoices);
  const overview = computeOverview(ledger.invoices, scores);
  const checks = runInvariantChecks(overview, buckets, scores, ledger.invoices);
  res.json({
    checks,
    all_passed: checks.every(c => c.pass),
    checked_at: new Date().toISOString()
  });
});

app.get("/api/customers/scores", (req, res) => {
  const ledger = getReconciledLedger();
  const payments = store.getAllPayments();
  res.json({ customers: getCustomerScores(ledger.invoices, payments) });
});

app.get("/api/cashflow", (req, res) => {
  const weeks = parseInt(req.query.weeks) || 8;
  const ledger = getReconciledLedger();
  const payments = store.getAllPayments();
  const scores = getCustomerScores(ledger.invoices, payments);
  const scoresMap = {};
  for (const c of scores) {
    scoresMap[c.customer_id] = c.score;
    scoresMap[c.name] = c.score;
  }
  const forecast = computeCashForecast(ledger.invoices, scoresMap, weeks, null, store.settings);
  res.json({ weeks: forecast });
});

app.get("/api/overview", (req, res) => {
  const ledger = getReconciledLedger();
  const payments = store.getAllPayments();
  const scores = getCustomerScores(ledger.invoices, payments);
  const overview = computeOverview(ledger.invoices, scores);
  overview.data_mode = store.getDataMode();
  res.json(overview);
});

app.get("/api/data-mode", (req, res) => {
  res.json({ mode: store.getDataMode(), override: store.dataModeOverride });
});

app.post("/api/data-mode", (req, res) => {
  const override = req.body?.override;
  if (override !== null && override !== undefined && override !== "sample" && override !== "live") {
    return res.status(400).json({ detail: "override must be 'sample', 'live', or null" });
  }
  store.dataModeOverride = override || null;
  res.json({ mode: store.getDataMode(), override: store.dataModeOverride });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", erp: null });
});

app.get("/api/retention", (req, res) => {
  const ledger = getReconciledLedger();
  const rows = computeRetentionView(ledger.invoices);
  res.json({
    rows,
    alerts: generateRetentionAlerts(rows),
    data_mode: store.getDataMode()
  });
});

app.get("/api/ipc-variance", (req, res) => {
  const ledger = getReconciledLedger();
  res.json({
    rows: computeIpcVariance(ledger.invoices),
    data_mode: store.getDataMode()
  });
});

app.get("/api/pdc", (req, res) => {
  const payments = store.getAllPayments();
  const rows = computePdcView(payments);
  res.json({
    rows,
    alerts: generatePdcAlerts(rows),
    data_mode: store.getDataMode()
  });
});

app.get("/api/days-to-pay/:customerId", (req, res) => {
  const ledger = getReconciledLedger();
  res.json(computeDaysToPayModel(req.params.customerId, ledger.invoices));
});

app.get("/api/days-to-pay", (req, res) => {
  const ledger = getReconciledLedger();
  const payments = store.getAllPayments();
  const scores = getCustomerScores(ledger.invoices, payments);
  const results = {};
  for (const c of scores) {
    results[c.customer_id] = computeDaysToPayModel(c.customer_id, ledger.invoices);
  }
  res.json({ customers: results });
});

app.get("/api/backtest", (req, res) => {
  const ledger = getReconciledLedger();
  const result = backtestDaysToPay(ledger.invoices);
  result.data_mode = store.getDataMode();
  res.json(result);
});

// ---------------------------------------------------------------- Frontend Serving
app.use("/static", express.static(path.join(__dirname, "frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "recify-dashboard.html"));
});

// Fallback for direct dashboard route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "recify-dashboard.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Recify server running on http://0.0.0.0:${PORT}`);
});
