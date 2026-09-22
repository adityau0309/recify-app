// Recify In-Memory Ledger Data Store
// Stores customers, invoices, payments, audit logs, and settings.
import fs from "fs";
import path from "path";
import { parseInvoicesCSV, parsePaymentsCSV } from "./ingest.js";
import { DEFAULT_SETTINGS } from "./engine.js";

class LedgerStore {
  constructor() {
    this.customers = new Map();
    this.invoices = new Map();
    this.payments = new Map();
    this.auditLog = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.dataModeOverride = null;
    this.hasCustomImport = false;
  }

  reset() {
    this.customers.clear();
    this.invoices.clear();
    this.payments.clear();
    this.auditLog = [];
    this.hasCustomImport = false;
  }

  loadSampleDemoData() {
    this.reset();
    try {
      const dataDir = path.join(process.cwd(), "data");
      const invPath = path.join(dataDir, "sample_invoices.csv");
      const payPath = path.join(dataDir, "sample_payments.csv");

      if (fs.existsSync(invPath)) {
        const invCsv = fs.readFileSync(invPath, "utf-8");
        const { rows } = parseInvoicesCSV(invCsv);
        this.persistInvoices(rows, "sample demo", true, "demo");
      }

      if (fs.existsSync(payPath)) {
        const payCsv = fs.readFileSync(payPath, "utf-8");
        const { rows } = parsePaymentsCSV(payCsv);
        this.persistPayments(rows, "sample demo", false, "demo");
      }
    } catch (err) {
      console.error("Failed to load sample demo data:", err);
    }
  }

  persistInvoices(rows, sourceLabel, reset = false, sourceTag = "csv") {
    if (reset) {
      this.invoices.clear();
      this.customers.clear();
      this.auditLog = [];
    }
    if (sourceTag !== "demo") {
      this.hasCustomImport = true;
    }

    let count = 0;
    for (const row of rows) {
      const custId = row.customer || row.customer_name;
      const custName = row.customer || row.customer_name;

      if (!this.customers.has(custId)) {
        this.customers.set(custId, {
          id: custId,
          name: custName,
          payment_terms: 30,
          source: sourceTag
        });
      }

      const invId = row.invoice_id || row.id;
      this.invoices.set(invId, {
        id: invId,
        customer_id: custId,
        customer_name: custName,
        amount: row.amount,
        gross_amount: row.amount,
        issued_date: row.issued_date || row.issue_date,
        due_date: row.due_date,
        status: row.status || "open",
        source: sourceTag,
        ingested_at: new Date().toISOString(),
        // Construction / UAE specific fields
        completion_date: row.completion_date || null,
        claimed_milestone_value: row.claimed_milestone_value !== undefined ? row.claimed_milestone_value : (row.amount * 1.05),
        certified_ipc_amount: row.certified_ipc_amount !== undefined ? row.certified_ipc_amount : (row.amount),
        retention_amount_handover: row.retention_amount_handover !== undefined ? row.retention_amount_handover : (row.amount > 100000 ? Math.round(row.amount * 0.05) : 0),
        retention_amount_dlp: row.retention_amount_dlp !== undefined ? row.retention_amount_dlp : (row.amount > 100000 ? Math.round(row.amount * 0.05) : 0),
        retention_release_handover_date: row.retention_release_handover_date || null,
        retention_release_dlp_date: row.retention_release_dlp_date || null
      });

      this.auditLog.push({
        id: this.auditLog.length + 1,
        entity_type: "invoice",
        entity_id: invId,
        action: "ingested",
        detail: `from ${sourceLabel}`,
        created_at: new Date().toISOString()
      });
      count++;
    }
    return count;
  }

  persistPayments(rows, sourceLabel, reset = false, sourceTag = "csv") {
    if (reset) {
      this.payments.clear();
    }
    if (sourceTag !== "demo") {
      this.hasCustomImport = true;
    }

    let count = 0;
    for (const row of rows) {
      const pmtId = row.payment_id || row.id;
      const custId = row.customer || row.customer_id || row.customer_name;
      const custName = row.customer || row.customer_name;

      if (custId && !this.customers.has(custId)) {
        this.customers.set(custId, {
          id: custId,
          name: custName,
          payment_terms: 30,
          source: sourceTag
        });
      }

      this.payments.set(pmtId, {
        id: pmtId,
        payment_id: pmtId,
        customer_id: custId,
        customer_name: custName,
        invoice_id: row.invoice_id || row.invoice_ref,
        invoice_ref: row.invoice_id || row.invoice_ref,
        amount: row.amount_paid || row.amount,
        amount_paid: row.amount_paid || row.amount,
        paid_date: row.payment_date || row.paid_date,
        method: row.method || "ACH",
        status: row.status || "Cleared",
        source: sourceTag,
        cheque_number: row.cheque_number || (row.method === "Cheque" ? `CHQ-${pmtId}` : null),
        bank: row.bank || (row.method === "Cheque" ? "Emirates NBD" : null),
        cheque_date: row.cheque_date || row.payment_date || row.paid_date,
        pdc_status: row.pdc_status || (row.method === "Cheque" ? "cleared" : null),
        ingested_at: new Date().toISOString()
      });

      this.auditLog.push({
        id: this.auditLog.length + 1,
        entity_type: "payment",
        entity_id: pmtId,
        action: "ingested",
        detail: `from ${sourceLabel}`,
        created_at: new Date().toISOString()
      });
      count++;
    }
    return count;
  }

  getAllInvoices() {
    return Array.from(this.invoices.values());
  }

  getAllPayments() {
    return Array.from(this.payments.values());
  }

  getAllCustomers() {
    return Array.from(this.customers.values());
  }

  getDataMode() {
    if (this.dataModeOverride === "sample" || this.dataModeOverride === "live") {
      return this.dataModeOverride;
    }
    return this.hasCustomImport ? "live" : "sample";
  }
}

export const store = new LedgerStore();
store.loadSampleDemoData();
