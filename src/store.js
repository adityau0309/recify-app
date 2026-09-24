// Recify In-Memory Ledger Data Store
// Stores customers, invoices, payments, audit logs, settings, and UAE contracting enterprise entities.
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

    // Enterprise UAE Contracting Modules
    this.ipcRecords = new Map();
    this.retentionRecords = new Map();
    this.pdcRecords = new Map();
    this.apLiabilities = new Map();
    this.erpSettings = {
      account_id: process.env.NETSUITE_ACCOUNT_ID || "",
      consumer_key: process.env.NETSUITE_CONSUMER_KEY || "",
      consumer_secret: process.env.NETSUITE_CONSUMER_SECRET || "",
      token_id: process.env.NETSUITE_TOKEN_ID || "",
      token_secret: process.env.NETSUITE_TOKEN_SECRET || ""
    };
  }

  reset() {
    this.customers.clear();
    this.invoices.clear();
    this.payments.clear();
    this.auditLog = [];
    this.hasCustomImport = false;
    this.ipcRecords.clear();
    this.retentionRecords.clear();
    this.pdcRecords.clear();
    this.apLiabilities.clear();
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

      this.seedEnterpriseModules();
    } catch (err) {
      console.error("Failed to load sample demo data:", err);
    }
  }

  seedEnterpriseModules() {
    // 1. FIDIC IPC records
    const sampleIpcs = [
      { id: "IPC-001", application_ref: "IPC-07", project_name: "Burj Crown Residences MEP", customer_name: "Al Barsha Gardens Contracting", claimed_amount_aed: 1450000.0, certified_amount_aed: 1180000.0, disallowed_variance_aed: 270000.0, certification_date: "2026-08-28", engineer_name: "Khatib & Alami", dispute_status: "Under Commercial Dispute", justification: "Unjustified de-scoping of chiller commissioning & pressure test variations.", source: "enterprise_seed" },
      { id: "IPC-002", application_ref: "IPC-12", project_name: "Dubai South Logistics Hub 4", customer_name: "Falcon Gulf Builders", claimed_amount_aed: 890000.0, certified_amount_aed: 680000.0, disallowed_variance_aed: 210000.0, certification_date: "2026-08-10", engineer_name: "WSP Middle East", dispute_status: "Under Commercial Dispute", justification: "Arbitrary deduction for unapproved tier-2 labor rate differentials.", source: "enterprise_seed" },
      { id: "IPC-003", application_ref: "IPC-04", project_name: "Yas Bay Waterfront Hotel Fitout", customer_name: "Al Maha Infrastructure", claimed_amount_aed: 2100000.0, certified_amount_aed: 1850000.0, disallowed_variance_aed: 250000.0, certification_date: "2026-07-06", engineer_name: "Atkins Middle East", dispute_status: "Arbitration Escalation", justification: "Disallowed structural ceiling acoustic baffle variations executed under site instruction.", source: "enterprise_seed" },
      { id: "IPC-004", application_ref: "IPC-09", project_name: "Al Maryah Tower Shell & Core", customer_name: "Crescent Gulf MEP", claimed_amount_aed: 620000.0, certified_amount_aed: 620000.0, disallowed_variance_aed: 0.0, certification_date: "2026-09-04", engineer_name: "Parsons International", dispute_status: "Accepted", justification: "Full certification granted without disallowance.", source: "enterprise_seed" },
      { id: "IPC-005", application_ref: "IPC-03", project_name: "Meydan Horizon District Cooling", customer_name: "Skyline Gulf Construction", claimed_amount_aed: 1320000.0, certified_amount_aed: 1140000.0, disallowed_variance_aed: 180000.0, certification_date: "2026-07-25", engineer_name: "Mott MacDonald", dispute_status: "Under Commercial Dispute", justification: "Withholding on pre-insulated pipe hydraulic flush certificates.", source: "enterprise_seed" },
      { id: "IPC-006", application_ref: "IPC-15", project_name: "Dubai Hills Commercial Park C3", customer_name: "Emirates Frame Works", claimed_amount_aed: 1780000.0, certified_amount_aed: 1510000.0, disallowed_variance_aed: 270000.0, certification_date: "2026-07-21", engineer_name: "AECOM Middle East", dispute_status: "Arbitration Escalation", justification: "Engineer refused time-extension related prolongation overheads.", source: "enterprise_seed" },
    ];
    for (const ipc of sampleIpcs) {
      this.ipcRecords.set(ipc.id, ipc);
    }

    // 2. Dual-Tranche Retention records
    const sampleRetentions = [
      { id: "RET-001", project_name: "Palm Gateway Towers", customer_name: "Al Noor Contracting LLC", contract_ref: "CNT-2024-PG01", total_contract_value: 7700000.0, tranche_type: "Tranche A (TOC - 5%)", amount_aed: 385000.0, milestone_date: "2026-06-15", milestone_status: "Overdue Release (Breach of Contract)", source: "enterprise_seed" },
      { id: "RET-002", project_name: "Dubai Creek Harbour Tower 2", customer_name: "Marina Bay Contracting", contract_ref: "CNT-2024-DCH02", total_contract_value: 4800000.0, tranche_type: "Tranche A (TOC - 5%)", amount_aed: 240000.0, milestone_date: "2026-07-30", milestone_status: "Overdue Release (Breach of Contract)", source: "enterprise_seed" },
      { id: "RET-003", project_name: "Business Bay Sky Suites", customer_name: "Desert Rose Construction", contract_ref: "CNT-2023-BB09", total_contract_value: 8200000.0, tranche_type: "Tranche B (DLP - 5%)", amount_aed: 410000.0, milestone_date: "2026-09-28", milestone_status: "Due for Release (<30 Days)", source: "enterprise_seed" },
      { id: "RET-004", project_name: "Yas South Logistics Hub", customer_name: "Meridian Gulf Projects", contract_ref: "CNT-2023-YSL04", total_contract_value: 3900000.0, tranche_type: "Tranche B (DLP - 5%)", amount_aed: 195000.0, milestone_date: "2026-05-10", milestone_status: "Overdue Release (Breach of Contract)", source: "enterprise_seed" },
      { id: "RET-005", project_name: "Al Furjan Pavilion MEP", customer_name: "Al Fahad Trading & Contracting", contract_ref: "CNT-2025-AFP03", total_contract_value: 3200000.0, tranche_type: "Tranche A (TOC - 5%)", amount_aed: 160000.0, milestone_date: "2026-11-15", milestone_status: "Locked / In Progress", source: "enterprise_seed" },
      { id: "RET-006", project_name: "Al Reem Residential Tower", customer_name: "Zenith MEP Contracting", contract_ref: "CNT-2023-ARR01", total_contract_value: 5800000.0, tranche_type: "Tranche B (DLP - 5%)", amount_aed: 290000.0, milestone_date: "2026-04-01", milestone_status: "Released / Settled", source: "enterprise_seed" },
    ];
    for (const ret of sampleRetentions) {
      this.retentionRecords.set(ret.id, ret);
    }

    // 3. PDC Registry records
    const samplePdcs = [
      { id: "PDC-001", cheque_no: "CHQ-782190", issuing_bank: "Emirates NBD", drawer_entity: "Meridian Gulf Projects", amount_aed: 180500.0, maturity_date: "2026-09-24", maturity_status: "Due This Week", invoice_ref: "KIN-5010", notes: "Awaiting clearance window; presented at Emirates NBD Dubai main branch.", source: "enterprise_seed" },
      { id: "PDC-002", cheque_no: "CHQ-449102", issuing_bank: "Abu Dhabi Commercial Bank (ADCB)", drawer_entity: "Falcon Gulf Builders", amount_aed: 139900.0, maturity_date: "2026-09-26", maturity_status: "Due This Week", invoice_ref: "KIN-5020", notes: "Deposited at ADCB Trade Centre branch.", source: "enterprise_seed" },
      { id: "PDC-003", cheque_no: "CHQ-552188", issuing_bank: "First Abu Dhabi Bank (FAB)", drawer_entity: "Al Maha Infrastructure", amount_aed: 192600.0, maturity_date: "2026-09-18", maturity_status: "Dishonored / Bounced", invoice_ref: "KIN-5016", notes: "Dishonored: Refer to Drawer (insufficient funds). Formal legal notice dispatched under UAE Federal Decree Law No. 50/2022.", source: "enterprise_seed" },
      { id: "PDC-004", cheque_no: "CHQ-331908", issuing_bank: "Dubai Islamic Bank (DIB)", drawer_entity: "Crescent Gulf MEP", amount_aed: 164500.0, maturity_date: "2026-09-21", maturity_status: "In Transit / Deposited", invoice_ref: "KIN-5021", notes: "Under clearing cycle at UAE Central Bank ICCS.", source: "enterprise_seed" },
      { id: "PDC-005", cheque_no: "CHQ-992014", issuing_bank: "Mashreq Bank", drawer_entity: "Skyline Gulf Construction", amount_aed: 107900.0, maturity_date: "2026-10-05", maturity_status: "Held on Request", invoice_ref: "KIN-5017", notes: "Customer requested 14-day hold pending client main-contractor milestone settlement.", source: "enterprise_seed" },
      { id: "PDC-006", cheque_no: "CHQ-108744", issuing_bank: "Commercial Bank of Dubai (CBD)", drawer_entity: "Desert Rose Construction", amount_aed: 157100.0, maturity_date: "2026-08-20", maturity_status: "Cleared", invoice_ref: "KIN-5034", notes: "Successfully cleared and credited to Emirates NBD corporate operating account.", source: "enterprise_seed" },
    ];
    for (const pdc of samplePdcs) {
      this.pdcRecords.set(pdc.id, pdc);
    }

    // 4. AP Liabilities records
    const sampleAps = [
      { id: "AP-001", vendor_name: "National Manpower Solutions LLC", category: "Critical Path Labor", invoice_no: "AP-9101", amount_aed: 285000.0, due_date: "2026-09-25", status: "Approved", prompt_discount_terms: null, notes: "Direct MEP labor payroll for Burj Crown & Dubai South sites. Non-negotiable deadline to avoid site stoppage.", source: "enterprise_seed" },
      { id: "AP-002", vendor_name: "Gulf Tech MEP Technicians", category: "Critical Path Labor", invoice_no: "AP-9102", amount_aed: 142000.0, due_date: "2026-09-28", status: "Approved", prompt_discount_terms: null, notes: "Specialist cabling and duct installation team bi-weekly wage disbursement.", source: "enterprise_seed" },
      { id: "AP-003", vendor_name: "Daikin Middle East FZE", category: "Long-Lead Materials", invoice_no: "AP-8840", amount_aed: 390000.0, due_date: "2026-10-05", status: "Pending", prompt_discount_terms: "2/10 Net 30 (AED 7,800 prompt discount if paid by Sep 30)", notes: "Chiller compressor delivery release. Prompt discount available.", source: "enterprise_seed" },
      { id: "AP-004", vendor_name: "Ducab Cable Systems", category: "Long-Lead Materials", invoice_no: "AP-8855", amount_aed: 215000.0, due_date: "2026-09-30", status: "Scheduled", prompt_discount_terms: null, notes: "Armored XLPE 11kV low-smoke cables for Meydan project.", source: "enterprise_seed" },
      { id: "AP-005", vendor_name: "Emirates Ceiling & Drywall", category: "Standard Subcontractor", invoice_no: "AP-7712", amount_aed: 118000.0, due_date: "2026-10-12", status: "Pending", prompt_discount_terms: null, notes: "Eligible for strategic 14-day deferral without impact on critical path.", source: "enterprise_seed" },
      { id: "AP-006", vendor_name: "Al Futtaim Scaffolding Rental", category: "Standard Subcontractor", invoice_no: "AP-7730", amount_aed: 76000.0, due_date: "2026-10-18", status: "Pending", prompt_discount_terms: null, notes: "Heavy facade scaffolding rental. Standard 21-day stretch candidate.", source: "enterprise_seed" },
      { id: "AP-007", vendor_name: "BDO Corporate Tax & Audit Advisors", category: "Discretionary / Overhead", invoice_no: "AP-6501", amount_aed: 45000.0, due_date: "2026-10-25", status: "Pending", prompt_discount_terms: null, notes: "Quarterly corporate tax and VAT statutory compliance advisory fee.", source: "enterprise_seed" },
    ];
    for (const ap of sampleAps) {
      this.apLiabilities.set(ap.id, ap);
    }
  }

  persistInvoices(rows, sourceLabel, reset = false, sourceTag = "csv") {
    if (reset || !this.hasCustomImport) {
      this.invoices.clear();
      this.customers.clear();
      this.payments.clear();
      this.auditLog = [];
    }
    if (sourceTag !== "demo") {
      this.hasCustomImport = true;
    }

    let count = 0;
    for (const row of rows) {
      const invId = row.invoice_id || row.id;
      if (!invId) continue;

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

      this.invoices.set(invId, {
        id: invId,
        invoice_id: invId,
        customer_id: custId,
        customer_name: custName,
        amount: row.amount,
        issued_date: row.issue_date || row.issued_date,
        due_date: row.due_date,
        status: (row.status || "open").toLowerCase(),
        source: sourceTag,
        ingested_at: new Date().toISOString()
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
    if (reset || !this.hasCustomImport) {
      this.payments.clear();
      this.auditLog = this.auditLog.filter(a => a.entity_type !== "payment");
    }
    if (sourceTag !== "demo") {
      this.hasCustomImport = true;
    }

    let count = 0;
    for (const row of rows) {
      const pmtId = row.payment_id || row.id;
      if (!pmtId) continue;

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

  getAllIpcRecords() {
    return Array.from(this.ipcRecords.values());
  }

  getAllRetentionRecords() {
    return Array.from(this.retentionRecords.values());
  }

  getAllPdcRecords() {
    return Array.from(this.pdcRecords.values());
  }

  getAllApLiabilities() {
    return Array.from(this.apLiabilities.values());
  }

  updateIpcStatus(id, disputeStatus, justification) {
    const r = this.ipcRecords.get(id);
    if (r) {
      r.dispute_status = disputeStatus;
      if (justification) r.justification = justification;
      r.updated_at = new Date().toISOString();
      return r;
    }
    return null;
  }

  updateRetentionStatus(id, milestoneStatus) {
    const r = this.retentionRecords.get(id);
    if (r) {
      r.milestone_status = milestoneStatus;
      r.updated_at = new Date().toISOString();
      return r;
    }
    return null;
  }

  updatePdcStatus(id, maturityStatus, notes) {
    const r = this.pdcRecords.get(id);
    if (r) {
      r.maturity_status = maturityStatus;
      if (notes) r.notes = notes;
      r.updated_at = new Date().toISOString();

      // If marked cleared, link to payment if present and set payment to Cleared
      if (maturityStatus === "Cleared" && r.invoice_ref) {
        for (const p of this.payments.values()) {
          if (p.invoice_ref === r.invoice_ref && (p.method === "Cheque" || p.method === "PDC")) {
            p.status = "Cleared";
          }
        }
      }
      return r;
    }
    return null;
  }

  updateApStatus(id, status) {
    const r = this.apLiabilities.get(id);
    if (r) {
      r.status = status;
      r.updated_at = new Date().toISOString();
      return r;
    }
    return null;
  }

  addOrUpdateApBill(bill) {
    const id = bill.id || `AP-${Date.now()}`;
    const entry = {
      id,
      vendor_name: bill.vendor_name,
      category: bill.category || "Standard Subcontractor",
      invoice_no: bill.invoice_no,
      amount_aed: Number(bill.amount_aed) || 0,
      due_date: bill.due_date,
      status: bill.status || "Approved",
      prompt_discount_terms: bill.prompt_discount_terms || null,
      notes: bill.notes || null,
      source: "manual",
      updated_at: new Date().toISOString()
    };
    this.apLiabilities.set(id, entry);
    return entry;
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
