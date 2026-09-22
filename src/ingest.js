// Recify Ingestion Layer
// Parses custom CSV imports, handles aliases, date and currency normalization, and templates.

export const INVOICE_ALIASES = {
  invoice_id: ["invoice_id", "id", "invoice_number", "invoice", "tranid", "document number", "invoice #", "inv no", "reference", "ref no"],
  customer: ["customer", "customer_name", "client", "company", "entity", "entity name", "company name"],
  amount: ["amount", "invoice_amount", "total", "gross amount", "original amount", "amount remaining", "balance"],
  issue_date: ["issue_date", "issued_date", "invoice_date"],
  due_date: ["due_date", "due", "date due", "duedate", "payment due date", "terms due date"],
  status: ["status", "invoice status", "state", "doc status"]
};

export const PAYMENT_ALIASES = {
  payment_id: ["payment_id", "id", "tranid", "document number", "payment #", "ref no"],
  invoice_id: ["invoice_id", "invoice_ref", "invoice_number", "invoice", "document number", "invoice #", "inv no", "reference", "ref no", "applied to"],
  customer: ["customer", "customer_name", "client", "company", "entity", "entity name", "company name"],
  amount_paid: ["amount_paid", "amount", "paid_amount", "gross amount", "total", "payment amount", "amount received"],
  payment_date: ["payment_date", "paid_date", "date", "date applied", "date received"],
  method: ["method", "payment_method", "payment type"],
  status: ["status", "payment status", "state", "doc status"]
};

export const REQUIRED_INVOICE_FIELDS = ["invoice_id", "customer", "amount", "due_date"];
export const REQUIRED_PAYMENT_FIELDS = ["payment_id", "invoice_id", "customer", "amount_paid", "payment_date"];

export const INVOICE_FIELD_LABELS = {
  invoice_id: "Invoice ID",
  customer: "Customer Name",
  amount: "Amount (AED)",
  due_date: "Due Date"
};

export const PAYMENT_FIELD_LABELS = {
  payment_id: "Payment ID",
  invoice_id: "Invoice ID / Reference",
  customer: "Customer Name",
  amount_paid: "Amount Paid (AED)",
  payment_date: "Payment Date"
};

export const INVOICE_TEMPLATE_CSV =
  "invoice_id,customer,amount,issue_date,due_date,status\n" +
  "INV-2001,Al Noor Contracting LLC,84500,2026-08-01,2026-08-31,open\n" +
  "INV-2002,Falcon Gulf Builders,132000,2026-07-15,2026-08-14,open\n" +
  "INV-2003,Desert Rose Construction,45750,2026-06-01,2026-07-01,paid\n";

export const PAYMENT_TEMPLATE_CSV =
  "payment_id,invoice_id,customer,amount_paid,payment_date,status\n" +
  "PMT-2001,INV-2003,Desert Rose Construction,45750,2026-06-28,Cleared\n" +
  "PMT-2002,INV-2001,Al Noor Contracting LLC,50000,2026-08-20,Cleared\n";

export function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");
}

export function parseAmount(raw) {
  if (raw === null || raw === undefined) throw new Error("amount is empty");
  let s = String(raw).trim();
  if (!s) throw new Error("amount is empty");
  const negative = s.startsWith("(") && s.endsWith(")");
  s = s.replace(/[^\d.-]/g, "");
  if (!s || s === "-" || s === ".") throw new Error(`'${raw}' is not a recognizable amount`);
  const val = parseFloat(s);
  if (isNaN(val)) throw new Error(`'${raw}' is not a recognizable amount`);
  return negative ? -Math.abs(val) : val;
}

export function parseDateString(raw) {
  if (!raw) throw new Error("date is empty");
  const s = String(raw).trim();
  if (!s) throw new Error("date is empty");

  // Format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  // Format: DD/MM/YYYY or MM/DD/YYYY
  const slashParts = s.split("/");
  if (slashParts.length === 3) {
    let day = parseInt(slashParts[0], 10);
    let month = parseInt(slashParts[1], 10);
    const year = parseInt(slashParts[2], 10);
    // If first part > 12, it's definitely DD/MM/YYYY
    if (day > 12) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    // Default assumption DD/MM/YYYY for UAE/Middle East, else fallback
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error(`'${raw}' doesn't match a recognized date format`);
  }
  return d.toISOString().slice(0, 10);
}

function parseCSVLines(text) {
  const lines = [];
  let currentLine = [];
  let currentField = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (insideQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        insideQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ',') {
        currentLine.push(currentField);
        currentField = "";
      } else if (char === '\r') {
        // ignore or handle with \n
      } else if (char === '\n') {
        currentLine.push(currentField);
        lines.push(currentLine);
        currentLine = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
  }
  if (currentField || currentLine.length > 0) {
    currentLine.push(currentField);
    lines.push(currentLine);
  }
  return lines;
}

function buildColumnMap(headers, aliases) {
  const normalized = new Map();
  for (const h of headers) {
    normalized.set(normalize(h), h);
  }
  const resolved = {};
  for (const [canonical, options] of Object.entries(aliases)) {
    for (const opt of options) {
      const normOpt = normalize(opt);
      if (normalized.has(normOpt)) {
        resolved[canonical] = normalized.get(normOpt);
        break;
      }
    }
  }
  return resolved;
}

function detectHeaderRow(rawLines, aliases) {
  const aliasSet = new Set();
  for (const opts of Object.values(aliases)) {
    for (const o of opts) aliasSet.add(normalize(o));
  }
  let bestIdx = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rawLines.length, 15); i++) {
    const cells = rawLines[i];
    const score = cells.filter(c => aliasSet.has(normalize(c))).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function analyzeInvoicesCSV(csvContent) {
  const rawLines = parseCSVLines(csvContent.replace(/^\uFEFF/, ""));
  if (!rawLines || rawLines.length === 0) {
    throw new Error("The file appears to be empty or not a valid CSV.");
  }
  const headerIdx = detectHeaderRow(rawLines, INVOICE_ALIASES);
  const headers = rawLines[headerIdx].map(h => h.trim());
  const autoMapping = buildColumnMap(headers, INVOICE_ALIASES);
  const missingRequired = REQUIRED_INVOICE_FIELDS.filter(f => !autoMapping[f]);

  const previewRows = [];
  for (let i = headerIdx + 1; i < Math.min(rawLines.length, headerIdx + 4); i++) {
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = rawLines[i][idx] || "";
    });
    previewRows.push(row);
  }

  return {
    headers,
    auto_mapping: autoMapping,
    missing_required: missingRequired,
    field_labels: INVOICE_FIELD_LABELS,
    preview_rows: previewRows,
    header_rows_skipped: headerIdx
  };
}

export function analyzePaymentsCSV(csvContent) {
  const rawLines = parseCSVLines(csvContent.replace(/^\uFEFF/, ""));
  if (!rawLines || rawLines.length === 0) {
    throw new Error("The file appears to be empty or not a valid CSV.");
  }
  const headerIdx = detectHeaderRow(rawLines, PAYMENT_ALIASES);
  const headers = rawLines[headerIdx].map(h => h.trim());
  const autoMapping = buildColumnMap(headers, PAYMENT_ALIASES);
  const missingRequired = REQUIRED_PAYMENT_FIELDS.filter(f => !autoMapping[f]);

  const previewRows = [];
  for (let i = headerIdx + 1; i < Math.min(rawLines.length, headerIdx + 4); i++) {
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = rawLines[i][idx] || "";
    });
    previewRows.push(row);
  }

  return {
    headers,
    auto_mapping: autoMapping,
    missing_required: missingRequired,
    field_labels: PAYMENT_FIELD_LABELS,
    preview_rows: previewRows,
    header_rows_skipped: headerIdx
  };
}

export function parseInvoicesCSV(csvContent, explicitMapping = null) {
  const rawLines = parseCSVLines(csvContent.replace(/^\uFEFF/, ""));
  if (!rawLines || rawLines.length === 0) {
    throw new Error("The file appears to be empty or not a valid CSV.");
  }
  const headerIdx = detectHeaderRow(rawLines, INVOICE_ALIASES);
  const headers = rawLines[headerIdx].map(h => h.trim());
  const colmap = explicitMapping || buildColumnMap(headers, INVOICE_ALIASES);
  const missing = REQUIRED_INVOICE_FIELDS.filter(f => !colmap[f]);

  if (missing.length > 0) {
    throw new Error(`Missing required column(s): ${missing.join(", ")}. Found columns: ${headers.join(", ")}.`);
  }

  const headerPositions = {};
  headers.forEach((h, idx) => {
    headerPositions[h] = idx;
  });

  const rows = [];
  const errors = [];

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || line.length === 0 || (line.length === 1 && !line[0].trim())) continue;

    try {
      const getVal = (canonical) => {
        const h = colmap[canonical];
        if (!h) return "";
        const idx = headerPositions[h];
        return (idx !== undefined && line[idx] !== undefined) ? line[idx].trim() : "";
      };

      const invoiceId = getVal("invoice_id") || `IMP-${Math.random().toString(16).slice(2, 10)}`;
      const customer = getVal("customer");
      if (!customer) throw new Error("customer is empty");

      const amount = parseAmount(getVal("amount"));
      const dueDate = parseDateString(getVal("due_date"));
      const issueDateRaw = getVal("issue_date");
      const issueDate = issueDateRaw ? parseDateString(issueDateRaw) : dueDate;

      let status = "open";
      const statusRaw = getVal("status").toLowerCase();
      if (["paid", "open", "disputed", "partial"].includes(statusRaw)) {
        status = statusRaw;
      }

      rows.push({
        invoice_id: invoiceId,
        customer,
        customer_name: customer,
        amount,
        issue_date: issueDate,
        issued_date: issueDate,
        due_date: dueDate,
        status
      });
    } catch (err) {
      errors.push({ row: i + 1, reason: err.message });
    }
  }

  return { rows, errors };
}

export function parsePaymentsCSV(csvContent, explicitMapping = null) {
  const rawLines = parseCSVLines(csvContent.replace(/^\uFEFF/, ""));
  if (!rawLines || rawLines.length === 0) {
    throw new Error("The file appears to be empty or not a valid CSV.");
  }
  const headerIdx = detectHeaderRow(rawLines, PAYMENT_ALIASES);
  const headers = rawLines[headerIdx].map(h => h.trim());
  const colmap = explicitMapping || buildColumnMap(headers, PAYMENT_ALIASES);
  const missing = REQUIRED_PAYMENT_FIELDS.filter(f => !colmap[f]);

  if (missing.length > 0) {
    throw new Error(`Missing required column(s): ${missing.join(", ")}. Found columns: ${headers.join(", ")}.`);
  }

  const headerPositions = {};
  headers.forEach((h, idx) => {
    headerPositions[h] = idx;
  });

  const rows = [];
  const errors = [];

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || line.length === 0 || (line.length === 1 && !line[0].trim())) continue;

    try {
      const getVal = (canonical) => {
        const h = colmap[canonical];
        if (!h) return "";
        const idx = headerPositions[h];
        return (idx !== undefined && line[idx] !== undefined) ? line[idx].trim() : "";
      };

      const paymentId = getVal("payment_id") || `PMT-${Math.random().toString(16).slice(2, 10)}`;
      const invoiceRef = getVal("invoice_id");
      const customer = getVal("customer");
      if (!customer) throw new Error("customer is empty");

      const amountPaid = parseAmount(getVal("amount_paid"));
      const paymentDate = parseDateString(getVal("payment_date"));
      const method = getVal("method") || "ACH";
      const status = getVal("status") || "Cleared";

      rows.push({
        payment_id: paymentId,
        id: paymentId,
        invoice_id: invoiceRef,
        invoice_ref: invoiceRef,
        customer,
        customer_name: customer,
        customer_id: customer,
        amount_paid: amountPaid,
        amount: amountPaid,
        payment_date: paymentDate,
        paid_date: paymentDate,
        method,
        status
      });
    } catch (err) {
      errors.push({ row: i + 1, reason: err.message });
    }
  }

  return { rows, errors };
}
