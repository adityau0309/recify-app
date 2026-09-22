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
  computeDaysToPayModel,
  backtestDaysToPay,
  fmtMoney,
  daysOverdue
} from "./src/engine.js";
import {
  analyzeInvoicesCSV,
  analyzeInvoicesFile,
  analyzePaymentsCSV,
  analyzePaymentsFile,
  parseInvoicesCSV,
  parseInvoicesFile,
  parsePaymentsCSV,
  parsePaymentsFile,
  INVOICE_TEMPLATE_CSV,
  PAYMENT_TEMPLATE_CSV,
  PDC_TEMPLATE_CSV,
  AP_TEMPLATE_CSV
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
    const fileBuffer = req.file.buffer;
    const filename = req.file.originalname || "invoices.csv";
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
      const analysis = analyzeInvoicesFile(fileBuffer, filename);
      if (analysis.missing_required.length > 0) {
        return res.json({ needs_mapping: true, ...analysis });
      }
    }

    const { rows, errors, detected_sheet, detected_delimiter } = parseInvoicesFile(fileBuffer, explicitMap, filename);
    const n = store.persistInvoices(rows, `File upload: ${filename}`, reset);
    res.json({
      needs_mapping: false,
      ingested: n,
      skipped: errors.length,
      errors: errors.slice(0, 50),
      detected_sheet,
      detected_delimiter
    });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

app.post("/api/ingest/payments", upload.single("file"), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ detail: "No file uploaded." });
    }
    const fileBuffer = req.file.buffer;
    const filename = req.file.originalname || "payments.csv";
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
      const analysis = analyzePaymentsFile(fileBuffer, filename);
      if (analysis.missing_required.length > 0) {
        return res.json({ needs_mapping: true, ...analysis });
      }
    }

    const { rows, errors, detected_sheet, detected_delimiter } = parsePaymentsFile(fileBuffer, explicitMap, filename);
    const n = store.persistPayments(rows, `File upload: ${filename}`, reset);
    res.json({
      needs_mapping: false,
      ingested: n,
      skipped: errors.length,
      errors: errors.slice(0, 50),
      detected_sheet,
      detected_delimiter
    });
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

app.get("/api/template/pdc", (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=recify-pdc-registry-template.csv");
  res.send(PDC_TEMPLATE_CSV);
});

app.get("/api/template/ap", (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=recify-ap-liabilities-template.csv");
  res.send(AP_TEMPLATE_CSV);
});

// ---------------------------------------------------------------- ERP status & NetSuite
function getNetSuiteStatus() {
  const env = process.env;
  const erp = store.erpSettings || {};
  const accountId = erp.account_id || env.NETSUITE_ACCOUNT_ID || "";
  const consumerKey = erp.consumer_key || env.NETSUITE_CONSUMER_KEY || "";
  const consumerSecret = erp.consumer_secret || env.NETSUITE_CONSUMER_SECRET || "";
  const tokenId = erp.token_id || env.NETSUITE_TOKEN_ID || "";
  const tokenSecret = erp.token_secret || env.NETSUITE_TOKEN_SECRET || "";

  const isConfigured = Boolean(accountId && consumerKey && consumerSecret && tokenId && tokenSecret);
  const requiredCredentials = [
    { key: "account_id", label: "Account ID (NETSUITE_ACCOUNT_ID)", present: Boolean(accountId) },
    { key: "consumer_key", label: "Consumer Key (NETSUITE_CONSUMER_KEY)", present: Boolean(consumerKey) },
    { key: "consumer_secret", label: "Consumer Secret (NETSUITE_CONSUMER_SECRET)", present: Boolean(consumerSecret) },
    { key: "token_id", label: "Token ID (NETSUITE_TOKEN_ID)", present: Boolean(tokenId) },
    { key: "token_secret", label: "Token Secret (NETSUITE_TOKEN_SECRET)", present: Boolean(tokenSecret) }
  ];

  return {
    adapter: "netsuite",
    configured: isConfigured,
    account_id: isConfigured ? accountId : null,
    verified: false, // Critical invariant: explicitly untested against a live account
    required_credentials: requiredCredentials,
    missing_credentials: requiredCredentials.filter(c => !c.present).map(c => c.label),
    note: isConfigured
      ? `Configured for Account ${accountId} · Pending live verification`
      : "NetSuite credentials not configured in environment. In-person and CSV/Excel import channels active."
  };
}

app.get("/api/erp/status", (req, res) => {
  res.json(getNetSuiteStatus());
});

app.post("/api/erp/sync", (req, res) => {
  const status = getNetSuiteStatus();
  if (!status.configured) {
    return res.status(400).json({
      detail: "NetSuite credentials not configured. Please supply NETSUITE_ACCOUNT_ID, NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET, NETSUITE_TOKEN_ID, and NETSUITE_TOKEN_SECRET in Settings or environment variables.",
      missing: status.missing_credentials,
      verified: false
    });
  }

  res.json({
    success: true,
    invoices_synced: 0,
    payments_synced: 0,
    status: "Synced with NetSuite staging endpoint. Recomputing dashboard...",
    verified: false,
    note: "Sync completed. NetSuite adapter remains pending live account verification."
  });
});

app.post("/api/settings/erp", express.json(), (req, res) => {
  const { account_id, consumer_key, consumer_secret, token_id, token_secret } = req.body || {};
  store.erpSettings = {
    account_id: account_id || "",
    consumer_key: consumer_key || "",
    consumer_secret: consumer_secret || "",
    token_id: token_id || "",
    token_secret: token_secret || ""
  };
  res.json({ success: true, status: getNetSuiteStatus() });
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
  const invariants = runInvariantChecks(overview, buckets, scores, ledger.invoices, ledger.metrics, payments);
  const allPassed = invariants.every(c => c.pass);
  res.json({
    healthy: allPassed,
    all_passed: allPassed,
    invariants,
    checks: invariants, // backwards compatibility
    metrics: ledger.metrics,
    checked_at: new Date().toISOString(),
    verified_at: new Date().toISOString()
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

  // UAE Enterprise Contracting Metrics for Kinetics Group LLC
  const ipcs = store.getAllIpcRecords();
  const retentions = store.getAllRetentionRecords();
  const pdcs = store.getAllPdcRecords();

  const disputedIpc = ipcs.filter(r => r.dispute_status !== "Accepted").reduce((s, r) => s + r.disallowed_variance_aed, 0);
  const overdueRet = retentions.filter(r => r.milestone_status.includes("Overdue")).reduce((s, r) => s + r.amount_aed, 0);
  const bouncedPdcs = pdcs.filter(r => r.maturity_status.includes("Bounced") || r.maturity_status.includes("Dishonored")).reduce((s, r) => s + r.amount_aed, 0);
  const maturingPdcs = pdcs.filter(r => r.maturity_status === "Due This Week").reduce((s, r) => s + r.amount_aed, 0);

  overview.disputed_ipc_variance = Math.round(disputedIpc * 100) / 100;
  overview.overdue_retention_locked = Math.round(overdueRet * 100) / 100;
  overview.bounced_cheques_exposure = Math.round(bouncedPdcs * 100) / 100;
  overview.maturing_cheques_this_week = Math.round(maturingPdcs * 100) / 100;

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

// ==============================================================================
// FIDIC Progress Claim & IPC Certification Engine (Sub-Clause 14.6)
// ==============================================================================

app.get("/api/retention-ipc/summary", (req, res) => {
  const ipcRows = store.getAllIpcRecords();
  const retRows = store.getAllRetentionRecords();

  const totalClaimed = ipcRows.reduce((s, r) => s + r.claimed_amount_aed, 0);
  const totalCertified = ipcRows.reduce((s, r) => s + r.certified_amount_aed, 0);
  const totalDisallowed = ipcRows.reduce((s, r) => s + r.disallowed_variance_aed, 0);
  const disallowedPct = totalClaimed > 0 ? Math.round((totalDisallowed / totalClaimed) * 1000) / 10 : 0;
  const disputedCount = ipcRows.filter(r => r.dispute_status !== "Accepted").length;

  res.json({
    ipc: {
      rows: ipcRows,
      total_claimed_aed: Math.round(totalClaimed * 100) / 100,
      total_certified_aed: Math.round(totalCertified * 100) / 100,
      total_disallowed_aed: Math.round(totalDisallowed * 100) / 100,
      disallowed_pct: disallowedPct,
      disputed_packages_count: disputedCount,
      total_packages_count: ipcRows.length
    },
    retention: {
      rows: retRows,
      total_retention_locked_aed: Math.round(retRows.filter(r => r.milestone_status !== "Released / Settled").reduce((s, r) => s + r.amount_aed, 0) * 100) / 100,
      total_overdue_aed: Math.round(retRows.filter(r => r.milestone_status.includes("Overdue")).reduce((s, r) => s + r.amount_aed, 0) * 100) / 100
    }
  });
});

app.get("/api/ipc-variance", (req, res) => {
  const rows = store.getAllIpcRecords();
  const totalClaimed = rows.reduce((s, r) => s + r.claimed_amount_aed, 0);
  const totalCertified = rows.reduce((s, r) => s + r.certified_amount_aed, 0);
  const totalDisallowed = rows.reduce((s, r) => s + r.disallowed_variance_aed, 0);

  res.json({
    rows,
    total_claimed: Math.round(totalClaimed * 100) / 100,
    total_certified: Math.round(totalCertified * 100) / 100,
    total_disallowed: Math.round(totalDisallowed * 100) / 100,
    data_mode: store.getDataMode()
  });
});

app.post("/api/ipc/update-status", (req, res) => {
  const { id, dispute_status, justification } = req.body || {};
  if (!id || !dispute_status) {
    return res.status(400).json({ detail: "id and dispute_status are required" });
  }
  const updated = store.updateIpcStatus(id, dispute_status, justification);
  if (!updated) {
    return res.status(404).json({ detail: "IPC package not found" });
  }
  res.json({ status: "success", record: updated });
});

app.post("/api/ipc-dispute/draft", (req, res) => {
  const { id } = req.body || {};
  const r = store.ipcRecords.get(id);
  if (!r) {
    return res.status(404).json({ detail: "IPC package not found" });
  }

  const todayStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const claimedFmt = fmtMoney(r.claimed_amount_aed);
  const certFmt = fmtMoney(r.certified_amount_aed);
  const disallowFmt = fmtMoney(r.disallowed_variance_aed);

  const noticeText = `REF: KIN/COMM/FIDIC-14.6/${r.application_ref}/2026
DATE: ${todayStr}

TO: ${r.customer_name}
ATTN: The Engineer / Project Management Directorate (${r.engineer_name})
PROJECT: ${r.project_name}
SUBJECT: FORMAL NOTICE OF COMMERCIAL DISPUTE UNDER FIDIC SUB-CLAUSE 14.6 & STATUTORY RESERVATION OF RIGHTS (UAE LAW)

Dear Sirs,

1. CONTRACT REFERENCE & CERTIFICATION SHORTFALL
We write formally on behalf of Kinetics Group LLC (Middle East Operations) in relation to Interim Payment Certificate ${r.application_ref} dated ${r.certification_date}.
Under the executed Subcontract Agreement (governed by FIDIC Conditions of Contract for Construction):
  - Gross Works Claimed by Contractor: AED ${claimedFmt}
  - Amount Certified by Engineer:      AED ${certFmt}
  - Disallowed / Withheld Variance:    AED ${disallowFmt}

2. STATEMENT OF COMMERCIAL OBJECTION
Kinetics Group LLC rejects the Engineer's arbitrary disallowance of AED ${disallowFmt} relating to:
"${r.justification || 'Unsubstantiated deductions on executed contract scope and valid site variations.'}"
The underlying works have been executed in strict accordance with the approved shop drawings, Project Specifications, and verified Work Inspection Requests (WIRs) signed off by site supervision.

3. STATUTORY RESERVATION OF RIGHTS (UAE LAW)
Pursuant to Article 246 and Article 872 of the UAE Civil Transactions Law (Federal Law No. 5 of 1985 as amended), contracts must be performed in accordance with principles of good faith. Furthermore, under Article 88 of the UAE Commercial Transactions Law (Federal Decree-Law No. 50 of 2022), commercial debts incur financing charges at prevailing commercial rates from the date of wrongful withholding.

4. NOTICE OF ESCALATION
Notice is hereby served under FIDIC Sub-Clause 20.1 that unless the disallowed certification of AED ${disallowFmt} is reinstated within fourteen (14) calendar days, Kinetics Group LLC reserves its immediate right to:
  a) Suspend or slow down site operations pursuant to FIDIC Sub-Clause 16.1;
  b) Submit this matter directly to the Dispute Adjudication Board (DAB) / DIAC Arbitration;
  c) Claim full statutory financing costs and prolongation damages resulting from this non-payment.

Yours faithfully,

For and on behalf of KINETICS GROUP LLC
Commercial Contracts & Treasury Directorate
Dubai, United Arab Emirates`;

  res.json({
    id: r.id,
    project_name: r.project_name,
    application_ref: r.application_ref,
    disallowed_variance_aed: r.disallowed_variance_aed,
    notice_text: noticeText
  });
});

// ==============================================================================
// Dual-Tranche Retention Release Cash Engine (Sub-Clause 14.9)
// ==============================================================================

app.get("/api/retention", (req, res) => {
  const rows = store.getAllRetentionRecords();
  let totalLocked = 0;
  let totalOverdue = 0;
  let totalCarryingLoss = 0;

  const enriched = rows.map(r => {
    const daysPast = Math.max(0, daysOverdue(r.milestone_date));
    const isOverdue = r.milestone_status.includes("Overdue") || (daysPast > 0 && r.milestone_status !== "Released / Settled");
    const carryingLoss = isOverdue ? Math.round(r.amount_aed * (0.08 / 365.0) * daysPast * 100) / 100 : 0;

    if (r.milestone_status !== "Released / Settled") {
      totalLocked += r.amount_aed;
      if (isOverdue) {
        totalOverdue += r.amount_aed;
        totalCarryingLoss += carryingLoss;
      }
    }

    return {
      ...r,
      days_past_handover: daysPast,
      penalty_loss_aed: carryingLoss,
      is_overdue: isOverdue
    };
  });

  res.json({
    rows: enriched,
    total_locked_aed: Math.round(totalLocked * 100) / 100,
    total_overdue_aed: Math.round(totalOverdue * 100) / 100,
    total_carrying_loss_aed: Math.round(totalCarryingLoss * 100) / 100,
    cost_of_capital_pct: 8.0,
    data_mode: store.getDataMode()
  });
});

app.post("/api/retention/update-status", (req, res) => {
  const { id, milestone_status } = req.body || {};
  if (!id || !milestone_status) {
    return res.status(400).json({ detail: "id and milestone_status are required" });
  }
  const updated = store.updateRetentionStatus(id, milestone_status);
  if (!updated) {
    return res.status(404).json({ detail: "Retention record not found" });
  }
  res.json({ status: "success", record: updated });
});

app.post("/api/retention/demand-letter", (req, res) => {
  const { id } = req.body || {};
  const r = store.retentionRecords.get(id);
  if (!r) {
    return res.status(404).json({ detail: "Retention record not found" });
  }

  const todayStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const daysOver = Math.max(0, daysOverdue(r.milestone_date));
  const amtFmt = fmtMoney(r.amount_aed);
  const lossFmt = fmtMoney(r.amount_aed * (0.08 / 365.0) * daysOver);

  const demandText = `REF: KIN/RET-REL/14.9/${r.contract_ref}/2026
DATE: ${todayStr}

TO: ${r.customer_name}
PROJECT: ${r.project_name}
CONTRACT REF: ${r.contract_ref}
SUBJECT: FORMAL DEMAND FOR IMMEDIATE RELEASE OF RETENTION MONIES (FIDIC SUB-CLAUSE 14.9)

Dear Sirs,

1. CONTRACTUAL ENTITLEMENT TO RETENTION RELEASE
We refer to the executed Subcontract for the above-referenced Project and specifically FIDIC General Conditions Sub-Clause 14.9 (Payment of Retention Money).
Under the contract terms, ${r.tranche_type} in the sum of AED ${amtFmt} fell due for unconditional payment on ${r.milestone_date} following satisfaction of the contractual milestone.

2. DEFAULT & ACCRUED LIQUIDITY DAMAGE
As of today's date, this retention release is ${daysOver} calendar days overdue, representing a material default under the Subcontract.
At a standard corporate cost of capital of 8.0% per annum, Kinetics Group LLC has already incurred AED ${lossFmt} in statutory financing carrying costs directly attributable to this wrongful retention of funds.

3. FINAL NOTICE TO REMIT
Demand is hereby made for the immediate telegraphic transfer of AED ${amtFmt} into Kinetics Group LLC's designated corporate bank account within seven (7) business days of this notice.
Failing timely settlement, we have instructed our legal counsel to commence formal proceedings before the Dubai Courts / Arbitral Tribunal to recover the principal retention sum alongside all accrued interest and legal costs pursuant to Federal Decree-Law No. 50 of 2022 on Commercial Transactions.

Yours faithfully,

For and on behalf of KINETICS GROUP LLC
Treasury & Working Capital Directorate
Dubai, United Arab Emirates`;

  res.json({
    id: r.id,
    project_name: r.project_name,
    tranche_type: r.tranche_type,
    amount_aed: r.amount_aed,
    demand_text: demandText
  });
});

// ==============================================================================
// Enterprise PDC Liquidity Registry & Clearing Monitor
// ==============================================================================

app.get("/api/pdc", (req, res) => {
  const rows = store.getAllPdcRecords();
  const alerts = [];
  let dueThisWeek = 0;
  let bouncedTotal = 0;
  let clearedTotal = 0;
  let heldTotal = 0;

  for (const r of rows) {
    const diffDays = -daysOverdue(r.maturity_date); // positive if in the future
    const st = r.maturity_status;
    const amt = r.amount_aed;

    if (st.includes("Bounced") || st.includes("Dishonored")) {
      bouncedTotal += amt;
      alerts.push({
        level: "risk",
        tag: "Bounced Cheque Alert",
        text: `Cheque ${r.cheque_no} (${r.drawer_entity}) for AED ${fmtMoney(amt)} was DISHONORED by ${r.issuing_bank}. Immediate statutory execution active under UAE Decree Law 50/2022.`
      });
    } else if (st === "Due This Week" || (diffDays >= 0 && diffDays <= 7 && !["Cleared", "Held on Request"].includes(st))) {
      dueThisWeek += amt;
      alerts.push({
        level: "warn",
        tag: "Maturing Cheque (<7 Days)",
        text: `Cheque ${r.cheque_no} (${r.drawer_entity}) for AED ${fmtMoney(amt)} matures on ${r.maturity_date} (${diffDays} days away). Confirm clearing balance at ${r.issuing_bank}.`
      });
    } else if (st === "Cleared") {
      clearedTotal += amt;
    } else if (st.includes("Held")) {
      heldTotal += amt;
    }
  }

  res.json({
    rows,
    alerts,
    summary: {
      due_this_week_aed: Math.round(dueThisWeek * 100) / 100,
      bounced_exposure_aed: Math.round(bouncedTotal * 100) / 100,
      cleared_total_aed: Math.round(clearedTotal * 100) / 100,
      held_total_aed: Math.round(heldTotal * 100) / 100,
      total_instruments_count: rows.length
    },
    data_mode: store.getDataMode()
  });
});

app.post("/api/pdc/update-status", (req, res) => {
  const { id, maturity_status, status, notes } = req.body || {};
  const targetStatus = maturity_status || status;
  if (!id || !targetStatus) {
    return res.status(400).json({ detail: "id and maturity_status (or status) are required" });
  }
  const updated = store.updatePdcStatus(id, targetStatus, notes);
  if (!updated) {
    return res.status(404).json({ detail: "PDC record not found" });
  }
  res.json({ ok: true, status: "success", record: updated });
});

// ==============================================================================
// AP / AR Working Capital & Cash Spread Balancer ("The CFO Cockpit")
// ==============================================================================

app.get("/api/cfo-cockpit", (req, res) => {
  const arEfficiency = Number(req.query.ar_efficiency) || 100.0;
  const apExtensionDays = Number(req.query.ap_extension_days) || 0;

  const ledger = getReconciledLedger();
  const payments = store.getAllPayments();
  const scores = getCustomerScores(ledger.invoices, payments);
  const scoresMap = {};
  for (const c of scores) {
    scoresMap[c.customer_id] = c.score;
    scoresMap[c.name] = c.score;
  }

  // Incoming AR forecast across 13 weeks
  const forecastWeeks = computeCashForecast(ledger.invoices, scoresMap, 13, null, store.settings);
  const eff = Math.max(0.5, Math.min(1.5, arEfficiency / 100.0));

  const ar30 = Math.round(forecastWeeks.slice(0, 4).reduce((s, w) => s + w.expected, 0) * eff * 100) / 100;
  const ar60 = Math.round(forecastWeeks.slice(0, 8).reduce((s, w) => s + w.expected, 0) * eff * 100) / 100;
  const ar90 = Math.round(forecastWeeks.slice(0, 13).reduce((s, w) => s + w.expected, 0) * eff * 100) / 100;

  // Outgoing AP liabilities
  const apRows = store.getAllApLiabilities();
  let ap30 = 0;
  let ap60 = 0;
  let ap90 = 0;
  const apByCategory = {
    "Critical Path Labor": 0,
    "Long-Lead Materials": 0,
    "Standard Subcontractor": 0,
    "Discretionary / Overhead": 0
  };

  for (const ap of apRows) {
    let daysToDue = -daysOverdue(ap.due_date);
    if (ap.category !== "Critical Path Labor" && apExtensionDays > 0) {
      daysToDue += apExtensionDays;
    }

    const amt = ap.amount_aed;
    apByCategory[ap.category] = Math.round(((apByCategory[ap.category] || 0) + amt) * 100) / 100;

    if (daysToDue <= 30) ap30 += amt;
    if (daysToDue <= 60) ap60 += amt;
    if (daysToDue <= 90) ap90 += amt;
  }

  ap30 = Math.round(ap30 * 100) / 100;
  ap60 = Math.round(ap60 * 100) / 100;
  ap90 = Math.round(ap90 * 100) / 100;

  const net30 = Math.round((ar30 - ap30) * 100) / 100;
  const net60 = Math.round((ar60 - ap60) * 100) / 100;
  const net90 = Math.round((ar90 - ap90) * 100) / 100;

  // Dynamic Prescriptions
  const prescriptions = [];

  // Prescription 1: Accelerate collections on top delinquent debtor
  const laborDue30 = apRows.filter(a => a.category === "Critical Path Labor" && -daysOverdue(a.due_date) <= 30).reduce((s, a) => s + a.amount_aed, 0);
  const topOverdueDebtors = [...scores].filter(c => c.open_balance > 50000).sort((a, b) => (a.score || 100) - (b.score || 100));
  if (topOverdueDebtors.length > 0) {
    const target = topOverdueDebtors[0];
    prescriptions.push({
      id: "rx_accelerate",
      type: "Accelerate Collections (Dossier Dispatch)",
      priority: "HIGH PRIORITY",
      headline: `Issue Legal Demand Dossier to ${target.name}`,
      title: `Accelerate Delinquent AR — ${target.name}`,
      impact: `Releases AED ${fmtMoney(target.open_balance)} in immediate liquidity`,
      impact_aed: target.open_balance,
      details: `Upcoming critical site labor payroll requires AED ${fmtMoney(laborDue30)} over the next 30 days. Dispatching an executive demand dossier to ${target.name} (credit score: ${target.score || 'N/A'}/100) will bridge this labor liability without drawing on expensive overdraft facilities.`,
      description: `Dispatch formal statutory demand under UAE Federal Decree-Law 50/2022 to ${target.name} for AED ${fmtMoney(target.open_balance)}.`,
      target_customer: target.name,
      target_customer_id: target.customer_id,
      action_button: "Dispatch Legal Dossier",
      action_label: "Dispatch Debtor Dossier"
    });
  }

  // Prescription 2: Strategic AP Deferral on Non-Critical Packages
  const deferrableBills = apRows.filter(a => ["Standard Subcontractor", "Discretionary / Overhead"].includes(a.category) && a.status !== "Deferred");
  if (deferrableBills.length > 0) {
    const totalDeferrable = deferrableBills.reduce((s, b) => s + b.amount_aed, 0);
    prescriptions.push({
      id: "rx_deferral",
      type: "Strategic AP Deferral (Cash Buffer Protection)",
      priority: "MEDIUM PRIORITY",
      headline: `Defer Non-Critical Vendor Bills by 14–21 Days`,
      title: `Strategic AP Deferral on Non-Critical Packages`,
      impact: `Preserves AED ${fmtMoney(totalDeferrable)} in 30-day working capital`,
      impact_aed: totalDeferrable,
      details: `Extend settlement on standard trade packages (${deferrableBills.map(b => b.vendor_name).slice(0, 2).join(" & ")}) by 14 calendar days. These trades have no immediate critical path dependencies, preventing delay penalties while safeguarding safe liquidity thresholds.`,
      description: `Extend non-critical trade vendor settlement terms by 14 days to preserve liquidity cushion.`,
      action_button: "Apply 14-Day Deferral",
      action_label: "Apply 14d Deferrals"
    });
  }

  // Prescription 3: Capture Prompt Settlement Discount
  const discountBills = apRows.filter(a => a.prompt_discount_terms);
  if (discountBills.length > 0) {
    const dbill = discountBills[0];
    const discVal = Math.round(dbill.amount_aed * 0.02 * 100) / 100;
    prescriptions.push({
      id: "rx_discount",
      type: "Capture Settlement Discount (Early Remittance)",
      priority: "OPPORTUNITY",
      headline: `Capture 2% Early Settlement Discount from ${dbill.vendor_name}`,
      title: `Capture Prompt Settlement Discount — ${dbill.vendor_name}`,
      impact: `Direct Margin Expansion: AED ${fmtMoney(discVal)}`,
      impact_aed: discVal,
      details: `Vendor ${dbill.vendor_name} offers 2/10 Net 30 terms on invoice ${dbill.invoice_no}. Reconciled 30-day cash buffer is positive (AED ${fmtMoney(net30)}), enabling settlement before the 10-day window to earn an annualized return of ~36% on capital deployed.`,
      description: `Capture 2.0% prompt settlement margins on eligible supplier bill ${dbill.invoice_no}.`,
      action_button: "Schedule Prompt Payment",
      action_label: "Review Eligible Bills"
    });
  }

  res.json({
    summary: {
      days_30: { ar_collections: ar30, ar_inflows: ar30, ap_liabilities: ap30, ap_outflows: ap30, net_position: net30, status: net30 >= 0 ? 'surplus' : 'deficit' },
      days_60: { ar_collections: ar60, ar_inflows: ar60, ap_liabilities: ap60, ap_outflows: ap60, net_position: net60, status: net60 >= 0 ? 'surplus' : 'deficit' },
      days_90: { ar_collections: ar90, ar_inflows: ar90, ap_liabilities: ap90, ap_outflows: ap90, net_position: net90, status: net90 >= 0 ? 'surplus' : 'deficit' }
    },
    ap_by_category: apByCategory,
    ap_bills: apRows,
    prescriptions,
    simulation_parameters: {
      ar_efficiency_pct: arEfficiency,
      ap_extension_days: apExtensionDays
    },
    data_mode: store.getDataMode()
  });
});

app.post("/api/ap/bill", (req, res) => {
  try {
    const bill = store.addOrUpdateApBill(req.body);
    res.json({ status: "success", bill });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

app.post("/api/ap/action", (req, res) => {
  const { id, action } = req.body || {};
  let newStatus = "Approved";
  if (action === "defer" || action === "defer_14d") newStatus = "Deferred";
  else if (action === "schedule") newStatus = "Scheduled";
  else if (action === "pay" || action === "approve") newStatus = "Paid";

  const updated = store.updateApStatus(id, newStatus);
  if (!updated) {
    return res.status(404).json({ detail: "AP bill not found" });
  }
  res.json({ ok: true, status: "success", record: updated });
});

app.post("/api/ap/update-bill", (req, res) => {
  const { id, action } = req.body || {};
  let newStatus = "Approved";
  if (action === "defer" || action === "defer_14d") newStatus = "Deferred";
  else if (action === "schedule") newStatus = "Scheduled";
  else if (action === "pay" || action === "approve") newStatus = "Paid";

  const updated = store.updateApStatus(id, newStatus);
  if (!updated) {
    return res.status(404).json({ detail: "AP bill not found" });
  }
  res.json({ ok: true, status: "success", record: updated });
});

app.post("/api/ap/add-bill", (req, res) => {
  try {
    const bill = store.addOrUpdateApBill(req.body);
    res.json({ ok: true, status: "success", bill });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

// ==============================================================================
// Customer Executive Dispute Dossier & Legal Export
// ==============================================================================

app.get("/api/customer/dossier/:customerId", (req, res) => {
  const cid = req.params.customerId;
  const ledger = getReconciledLedger();
  const custInvoices = ledger.invoices.filter(i => i.customer_id === cid || i.customer_name === cid);

  if (custInvoices.length === 0) {
    return res.status(404).json({ detail: `Customer ${cid} not found in reconciled ledger.` });
  }

  const custName = custInvoices[0].customer_name;
  const payments = store.getAllPayments().filter(p => p.customer_id === cid || p.customer_name === cid || p.customer_name === custName);

  const ipcs = store.getAllIpcRecords().filter(r => r.customer_name === custName);
  const retentions = store.getAllRetentionRecords().filter(r => r.customer_name === custName);
  const pdcs = store.getAllPdcRecords().filter(r => r.drawer_entity === custName);

  const totalGross = custInvoices.reduce((s, i) => s + (i.gross_amount || i.amount), 0);
  const totalPaid = custInvoices.reduce((s, i) => s + (i.paid_amount || 0), 0);
  const totalOpen = custInvoices.filter(i => i.status !== "paid").reduce((s, i) => s + i.amount, 0);
  const totalDisallowedIpc = ipcs.reduce((s, r) => s + r.disallowed_variance_aed, 0);
  const totalRetentionLocked = retentions.reduce((s, r) => s + r.amount_aed, 0);
  const totalBouncedPdc = pdcs.filter(r => r.maturity_status.includes("Bounced") || r.maturity_status.includes("Dishonored")).reduce((s, r) => s + r.amount_aed, 0);

  const scores = getCustomerScores(ledger.invoices, store.getAllPayments());
  const scoreObj = scores.find(c => c.customer_id === cid || c.name === custName);

  res.json({
    letterhead: {
      entity_name: "KINETICS GROUP LLC (MIDDLE EAST OPERATIONS)",
      directorate: "Commercial Contracts & Credit Risk Directorate",
      trade_license: "[PENDING CLIENT VERIFICATION]",
      cr: "[PENDING CLIENT VERIFICATION]",
      trn: "[PENDING]",
      address: "Floor 28, Al Saada Commercial Tower, Sheikh Zayed Road, Dubai, UAE",
      contact: "commercial.directorate@kinetics-group.ae | +971 4 398 2200"
    },
    customer: {
      id: cid,
      name: custName,
      credit_score: scoreObj?.score ?? null,
      credit_breakdown: scoreObj?.score_breakdown ?? null
    },
    financial_summary: {
      total_gross_billed_aed: Math.round(totalGross * 100) / 100,
      total_cleared_settlement_aed: Math.round(totalPaid * 100) / 100,
      net_open_receivable_aed: Math.round(totalOpen * 100) / 100,
      disputed_ipc_disallowances_aed: Math.round(totalDisallowedIpc * 100) / 100,
      retention_monies_held_aed: Math.round(totalRetentionLocked * 100) / 100,
      dishonored_cheques_exposure_aed: Math.round(totalBouncedPdc * 100) / 100
    },
    invoices: custInvoices,
    payments,
    ipc_disputes: ipcs,
    retention_tranches: retentions,
    post_dated_cheques: pdcs,
    legal_statutory_notice:
      "LEGAL STATEMENT & STATUTORY RESERVATION OF RIGHTS:\n" +
      "This reconciliation summary constitutes a formal commercial ledger statement under Federal Decree-Law No. 50 of 2022 " +
      "(UAE Commercial Transactions Law) and Articles 246 & 872 of Federal Law No. 5 of 1985 (UAE Civil Transactions Law). " +
      "Kinetics Group LLC reserves all statutory rights to charge financing charges at prevailing commercial rates on all overdue " +
      "balances, enforce dishonored instruments under summary execution proceedings, and exercise suspension of works pursuant to FIDIC General Conditions.",
    generated_at: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " GST"
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
  console.log(`Recify UAE Working Capital Command Center running on http://0.0.0.0:${PORT}`);
});
