// Recify Ingestion Layer — Smarter, Format-Agnostic File & Ledger Ingestion
// Engineered for UAE & GCC Commercial Contracting (Kinetics Group LLC).
// Handles CSV (any delimiter: comma, semicolon, tab, pipe), multi-sheet Excel (.xlsx/.xls),
// split date columns, regional currency/number formats, exact alias matching, and
// low-confidence fuzzy suggestion fallback (without silent guessing).

import * as XLSX from "xlsx";

export const INVOICE_ALIASES = {
  invoice_id: [
    "invoice_id", "id", "invoice_number", "invoice", "tranid", "document number",
    "invoice #", "inv no", "inv no.", "reference", "ref no", "ref no.", "inv_id",
    "inv_num", "inv #", "invoice num", "bill #", "bill no", "bill no.", "bill number",
    "billing document", "doc #", "doc no", "doc no.", "document #", "voucher",
    "voucher no", "voucher #", "voucher number", "faktura", "facture", "factura",
    "numéro facture", "bill_id", "inv_code", "txn id", "transaction id", "transaction number",
    "trans no", "trans_id", "invoice ref", "tax invoice no", "tax invoice #", "vat invoice no",
    "cr no", "certificate no", "ipc no", "ipc number", "interim payment certificate no",
    "claim no", "billing ref", "sales invoice", "inv", "bill id", "doc num", "inv ref"
  ],
  customer: [
    "customer", "customer_name", "client", "company", "entity", "entity name", "company name",
    "client name", "customer / client", "buyer", "account name", "debtor", "counterparty",
    "contractor", "main contractor", "developer", "employer", "purchaser", "billed to",
    "bill to", "sold to", "subcontractor", "partner", "client / customer", "account",
    "customer account", "client name / entity", "client_name", "cust_name", "kunde",
    "cliente", "client / developer", "principal", "party", "party name", "customer / counterparty",
    "client / employer", "client entity", "debtor name"
  ],
  amount: [
    "amount", "invoice_amount", "total", "gross amount", "original amount", "amount remaining",
    "balance", "invoice total", "grand total", "net amount", "gross total", "amount aed",
    "total aed", "val", "value", "net value", "open amount", "outstanding", "outstanding balance",
    "unpaid amount", "remaining balance", "bill amount", "total amount", "amount due",
    "net due", "total (aed)", "amount (aed)", "balance due", "certified amount", "net payable",
    "payable amount", "betrag", "montant", "inv amt", "total amt", "gross amt", "due amt",
    "amt", "invoice val", "contract value", "invoice sum", "invoiced amount"
  ],
  issue_date: [
    "issue_date", "issued_date", "invoice_date", "date", "bill date", "billing date",
    "document date", "posting date", "doc date", "trans date", "transaction date",
    "entry date", "inv date", "date of issue", "created date", "datum", "fecha",
    "inv dt", "bill dt", "trx date", "doc dt"
  ],
  due_date: [
    "due_date", "due", "date due", "duedate", "payment due date", "terms due date",
    "due date", "expiry date", "maturity date", "expected payment date", "payment due",
    "terms date", "due_on", "target date", "pay by", "payment deadline", "deadline",
    "faelligkeitsdatum", "date d'échéance", "fecha de vencimiento", "due dt", "due_dt",
    "due on", "maturity", "expire date", "settlement date", "expected date", "promised date"
  ],
  status: [
    "status", "invoice status", "state", "doc status", "payment status", "approval status",
    "workflow status", "inv status", "condition", "dispute status", "stat"
  ],
  retention: [
    "retention", "retention amount", "retention held", "retention aed", "retention %",
    "retention_amount", "security deposit", "withheld", "retention withheld", "retention deduction"
  ],
  ipc_no: [
    "ipc", "ipc no", "ipc_no", "ipc number", "payment certificate", "interim certificate",
    "ipc ref", "cert no", "ipc #", "certificate #"
  ],
  pdc_ref: [
    "pdc", "pdc ref", "pdc number", "cheque no", "cheque number", "chq no", "post dated cheque",
    "cheque #", "chq #"
  ]
};

export const PAYMENT_ALIASES = {
  payment_id: [
    "payment_id", "id", "tranid", "document number", "payment #", "ref no", "pmt #",
    "pmt no", "pmt no.", "payment no", "payment number", "receipt no", "receipt #",
    "receipt number", "remittance #", "remittance no", "voucher #", "wire ref",
    "wire reference", "transaction id", "transaction ref", "cheque no", "check no",
    "transfer ref", "advice no", "pmt_id", "pmt id", "payment id", "receipt id",
    "collection id", "deposit ref", "cr ref", "cash receipt no"
  ],
  invoice_id: [
    "invoice_id", "invoice_ref", "invoice_number", "invoice", "document number",
    "invoice #", "inv no", "inv no.", "reference", "ref no", "ref no.", "applied to",
    "applied invoice", "matched invoice", "invoice allocated", "target invoice", "bill ref",
    "inv ref", "invoice applied", "invoice no", "inv_num", "inv #", "bill #", "bill no",
    "applied doc", "invoice reference", "matching invoice"
  ],
  customer: [
    "customer", "customer_name", "client", "company", "entity", "entity name", "company name",
    "client name", "customer / client", "buyer", "account name", "debtor", "counterparty",
    "payer", "remitter", "originator", "from entity", "from company", "paying entity",
    "drawer", "account", "contractor", "main contractor"
  ],
  amount_paid: [
    "amount_paid", "amount", "paid_amount", "gross amount", "total", "payment amount",
    "amount received", "paid", "cleared amount", "settled amount", "net received",
    "remitted amount", "credit amount", "deposit amount", "amount (aed)", "paid (aed)",
    "collected", "total paid", "cash received", "receipt amount", "allocated amount",
    "pmt amount", "amt paid", "sum paid"
  ],
  payment_date: [
    "payment_date", "paid_date", "date", "date applied", "date received", "clearing date",
    "value date", "deposit date", "settlement date", "trans date", "transaction date",
    "bank date", "remittance date", "paid on", "pay date", "effective date", "date cleared",
    "posting date"
  ],
  method: [
    "method", "payment_method", "payment type", "instrument", "type", "mode", "payment mode",
    "clearing channel", "tender", "payment instrument", "channel", "payment way"
  ],
  status: [
    "status", "payment status", "state", "doc status", "clearing status", "settlement status",
    "recon status", "cleared state"
  ]
};

export const REQUIRED_INVOICE_FIELDS = ["invoice_id", "customer", "amount", "due_date"];
export const REQUIRED_PAYMENT_FIELDS = ["payment_id", "invoice_id", "customer", "amount_paid", "payment_date"];

export const INVOICE_FIELD_LABELS = {
  invoice_id: "Invoice ID",
  customer: "Customer Name",
  amount: "Amount (AED)",
  due_date: "Due Date",
  issue_date: "Issue Date",
  status: "Status",
  retention: "Retention Amount",
  ipc_no: "IPC Number",
  pdc_ref: "PDC / Cheque Ref"
};

export const PAYMENT_FIELD_LABELS = {
  payment_id: "Payment ID",
  invoice_id: "Invoice ID / Reference",
  customer: "Customer Name",
  amount_paid: "Amount Paid (AED)",
  payment_date: "Payment Date",
  method: "Payment Method",
  status: "Status"
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

export const PDC_TEMPLATE_CSV =
  "cheque_no,drawer_entity,issuing_bank,amount_aed,maturity_date,maturity_status,invoice_ref,notes\n" +
  "CHQ-782190,Meridian Gulf Projects,Emirates NBD,180500,2026-09-24,Due This Week,KIN-5010,Awaiting clearing cycle\n" +
  "CHQ-552188,Al Maha Infrastructure,First Abu Dhabi Bank (FAB),192600,2026-09-18,Dishonored / Bounced,KIN-5016,Refer to Drawer\n";

export const AP_TEMPLATE_CSV =
  "vendor_name,category,invoice_no,amount_aed,due_date,status,prompt_discount_terms,notes\n" +
  "National Manpower Solutions LLC,Critical Path Labor,AP-9101,285000,2026-09-25,Approved,,Burj Crown site payroll\n" +
  "Daikin Middle East FZE,Long-Lead Materials,AP-8840,390000,2026-10-05,Pending,2/10 Net 30,Chiller compressor delivery release\n";

// ---------------------------------------------------------------- String & Text Utilities
export function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\uFEFF]/g, "")
    .replace(/[_\-./#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokenize string into meaningful character/word tokens for similarity
function tokenize(s) {
  return normalize(s).split(" ").filter(Boolean);
}

// Levenshtein distance between two normalized strings
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function stringSimilarity(s1, s2) {
  const n1 = normalize(s1);
  const n2 = normalize(s2);
  if (n1 === n2) return 1.0;
  if (!n1 || !n2) return 0.0;

  // Direct containment bonus
  if (n1.includes(n2) || n2.includes(n1)) {
    const minLen = Math.min(n1.length, n2.length);
    const maxLen = Math.max(n1.length, n2.length);
    return Math.max(0.75, minLen / maxLen);
  }

  // Token overlap (Jaccard)
  const t1 = new Set(tokenize(s1));
  const t2 = new Set(tokenize(s2));
  let intersection = 0;
  for (const t of t1) {
    if (t2.has(t)) intersection++;
  }
  const union = new Set([...t1, ...t2]).size;
  const tokenJaccard = union > 0 ? intersection / union : 0;

  // Levenshtein distance ratio
  const maxLen = Math.max(n1.length, n2.length);
  const dist = levenshtein(n1, n2);
  const levRatio = (maxLen - dist) / maxLen;

  return Math.max(tokenJaccard * 0.8 + levRatio * 0.2, levRatio);
}

// ---------------------------------------------------------------- Regional Currency & Amount Parsing
export function parseAmount(raw) {
  if (raw === null || raw === undefined) throw new Error("amount is empty");
  let s = String(raw).trim();
  if (!s) throw new Error("amount is empty");

  // Check for accounting parentheses or trailing minus/CR/DR
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  } else if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1).trim();
  } else if (/[-−]/.test(s.charAt(0))) {
    negative = true;
    s = s.slice(1).trim();
  } else if (/\s*CR$/i.test(s)) {
    // Credit is negative for an invoice/debit ledger or balance
    negative = true;
    s = s.replace(/\s*CR$/i, "").trim();
  } else if (/\s*DR$/i.test(s)) {
    s = s.replace(/\s*DR$/i, "").trim();
  }

  // Remove currency words and symbols: AED, Dhs, USD, EUR, $, etc.
  s = s.replace(/(AED|DHS|DH|USD|EUR|GBP|SAR|QAR|CAD|AUD|\$|€|£|¥)/gi, "").trim();

  // If format is European (e.g. "1.234.567,89" or "1234,56") vs standard ("1,234,567.89")
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  const hasSpace = /\s/.test(s);

  if (hasSpace) {
    s = s.replace(/\s+/g, "");
  }

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // European format: 1.234.567,89
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // Standard format: 1,234,567.89
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      // e.g. "1234,50" -> decimal comma
      s = parts[0] + "." + parts[1];
    } else {
      // e.g. "1,234" or "1,234,567" -> thousand separator
      s = s.replace(/,/g, "");
    }
  }

  // Strip anything left that is not digit, dot, or minus
  s = s.replace(/[^\d.-]/g, "");
  if (!s || s === "-" || s === ".") throw new Error(`'${raw}' is not a recognizable amount`);

  const val = parseFloat(s);
  if (isNaN(val)) throw new Error(`'${raw}' is not a recognizable amount`);
  return negative ? -Math.abs(val) : val;
}

// ---------------------------------------------------------------- Regional Date Parsing
export function parseDateString(raw) {
  if (raw === null || raw === undefined) throw new Error("date is empty");
  let s = String(raw).trim();
  if (!s) throw new Error("date is empty");

  // Excel serial number (e.g. 45000 to 55000 represents 2023 to 2050)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 30000 && serial < 70000) {
      // Excel epoch begins Dec 30 1899 due to 1900 leap year bug
      const utcDays = Math.floor(serial - 25569);
      const date = new Date(utcDays * 86400 * 1000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().slice(0, 10);
      }
    }
  }

  // Format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  // Format: YYYY/MM/DD
  if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(s)) {
    const parts = s.split("/");
    const y = parts[0];
    const m = String(parseInt(parts[1], 10)).padStart(2, "0");
    const d = String(parseInt(parts[2], 10)).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Format with Dots: DD.MM.YYYY (German / European / Swiss)
  if (/^\d{1,2}\.\d{1,2}\.\d{4}/.test(s)) {
    const parts = s.split(".");
    const d = String(parseInt(parts[0], 10)).padStart(2, "0");
    const m = String(parseInt(parts[1], 10)).padStart(2, "0");
    const y = parts[2].slice(0, 4);
    return `${y}-${m}-${d}`;
  }

  // Format with Slashes: DD/MM/YYYY or MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) {
    const parts = s.split("/");
    let p1 = parseInt(parts[0], 10);
    let p2 = parseInt(parts[1], 10);
    let y = parseInt(parts[2], 10);
    if (y < 100) y += 2000;

    // In UAE / GCC, DD/MM/YYYY is standard.
    // If p1 > 12, it is unambiguously DD/MM/YYYY.
    // If p2 > 12, it is MM/DD/YYYY.
    let day = p1, month = p2;
    if (p1 <= 12 && p2 > 12) {
      month = p1;
      day = p2;
    }
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // Format with Month Names: e.g. "24-Sep-2026", "24 September 2026", "Sep 24, 2026"
  const monthMap = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", sept: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12"
  };

  const textMatch = s.match(/(\d{1,2})[-/\s]+([A-Za-z]+)[-/\s]+(\d{2,4})/);
  if (textMatch) {
    const day = String(parseInt(textMatch[1], 10)).padStart(2, "0");
    const mon = monthMap[textMatch[2].toLowerCase()];
    let year = parseInt(textMatch[3], 10);
    if (year < 100) year += 2000;
    if (mon) {
      return `${year}-${mon}-${day}`;
    }
  }

  const textMatchReverse = s.match(/([A-Za-z]+)[-/\s]+(\d{1,2}),?[-/\s]+(\d{2,4})/);
  if (textMatchReverse) {
    const mon = monthMap[textMatchReverse[1].toLowerCase()];
    const day = String(parseInt(textMatchReverse[2], 10)).padStart(2, "0");
    let year = parseInt(textMatchReverse[3], 10);
    if (year < 100) year += 2000;
    if (mon) {
      return `${year}-${mon}-${day}`;
    }
  }

  // Standard JS Date fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  throw new Error(`'${raw}' doesn't match a recognized date format`);
}

// ---------------------------------------------------------------- Delimiter Auto-Detection & CSV Parser
export function detectDelimiter(text) {
  if (!text) return ",";
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0).slice(0, 25);
  if (!lines.length) return ",";

  const candidates = [",", ";", "\t", "|"];
  let bestDelim = ",";
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = lines.map(line => {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuotes = !inQuotes;
        else if (!inQuotes && line[i] === delim) count++;
      }
      return count;
    });

    const nonZero = counts.filter(c => c > 0);
    if (nonZero.length === 0) continue;

    // Calculate mean and variance
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (avg < 1) continue;

    const variance = counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length;
    // Lower variance across lines indicates consistent tabular column splitting
    const consistencyScore = 100 / (1 + variance);
    const totalScore = avg * consistencyScore;

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestDelim = delim;
    }
  }

  return bestDelim;
}

export function parseCSVLines(text, delimiter = null) {
  if (!text) return [];
  const clean = text.replace(/^\uFEFF/, "");
  const delim = delimiter || detectDelimiter(clean);

  const lines = [];
  let currentLine = [];
  let currentField = "";
  let insideQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const nextChar = clean[i + 1];

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
      } else if (char === delim) {
        currentLine.push(currentField);
        currentField = "";
      } else if (char === "\r") {
        // Skip CR
      } else if (char === "\n") {
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
  return lines.filter(row => row.some(cell => String(cell).trim().length > 0));
}

// ---------------------------------------------------------------- Multi-Sheet Excel Parser
export function isExcelFile(fileBufferOrContent, filename = "") {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm")) return true;
  if (Buffer.isBuffer(fileBufferOrContent)) {
    // ZIP magic bytes PK\x03\x04 (standard for .xlsx) or OLE compound file \xD0\xCF\x11\xE0 (standard for .xls)
    if (fileBufferOrContent.length >= 4) {
      const b0 = fileBufferOrContent[0], b1 = fileBufferOrContent[1], b2 = fileBufferOrContent[2], b3 = fileBufferOrContent[3];
      if (b0 === 0x50 && b1 === 0x4B && b2 === 0x03 && b3 === 0x04) return true;
      if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return true;
    }
  }
  return false;
}

export function extractExcelWorkbook(buffer, aliases) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
  } catch (err) {
    throw new Error(`Failed to parse Excel file: ${err.message}`);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error("Excel workbook contains no sheets.");
  }

  // Evaluate each sheet to detect which sheet actually contains the tabular data
  let bestSheetName = workbook.SheetNames[0];
  let bestScore = -1;
  let bestRows = [];

  const aliasSet = new Set();
  for (const opts of Object.values(aliases)) {
    for (const o of opts) aliasSet.add(normalize(o));
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    const rows = rawRows
      .map(r => (Array.isArray(r) ? r.map(c => String(c ?? "").trim()) : []))
      .filter(r => r.some(c => c.length > 0));

    if (rows.length < 2) continue;

    // Check header match count in top 20 rows
    let maxMatch = 0;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const matchCount = rows[i].filter(cell => aliasSet.has(normalize(cell))).length;
      if (matchCount > maxMatch) maxMatch = matchCount;
    }

    // Heuristic score: alias matches * 50 + data row count
    const score = maxMatch * 50 + Math.min(rows.length, 100);
    if (score > bestScore) {
      bestScore = score;
      bestSheetName = sheetName;
      bestRows = rows;
    }
  }

  return {
    sheetName: bestSheetName,
    allSheets: workbook.SheetNames,
    rows: bestRows.length > 0 ? bestRows : XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "", raw: false })
  };
}

// ---------------------------------------------------------------- Header Detection & Column Resolution
export function detectHeaderRow(rawLines, aliases) {
  const aliasSet = new Set();
  for (const opts of Object.values(aliases)) {
    for (const o of opts) aliasSet.add(normalize(o));
  }
  let bestIdx = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rawLines.length, 25); i++) {
    const cells = rawLines[i];
    const score = cells.filter(c => aliasSet.has(normalize(c))).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Exact alias matching pass
export function buildColumnMap(headers, aliases) {
  const normalized = new Map();
  for (const h of headers) {
    const norm = normalize(h);
    if (!normalized.has(norm)) {
      normalized.set(norm, h);
    }
  }

  const resolved = {};
  const usedHeaders = new Set();

  for (const [canonical, options] of Object.entries(aliases)) {
    for (const opt of options) {
      const normOpt = normalize(opt);
      if (normalized.has(normOpt)) {
        const actualHeader = normalized.get(normOpt);
        if (!usedHeaders.has(actualHeader)) {
          resolved[canonical] = actualHeader;
          usedHeaders.add(actualHeader);
          break;
        }
      }
    }
  }

  // Also check if stripping currency tokens (e.g. "AED Total" -> "total") matches an exact alias
  for (const [canonical, options] of Object.entries(aliases)) {
    if (resolved[canonical]) continue;
    for (const opt of options) {
      const normOpt = normalize(opt);
      for (const [normH, actualHeader] of normalized.entries()) {
        if (usedHeaders.has(actualHeader)) continue;
        const strippedH = normH.replace(/\b(aed|dhs|dirhams|usd|eur|sar)\b/g, "").replace(/\s+/g, " ").trim();
        if (strippedH === normOpt) {
          resolved[canonical] = actualHeader;
          usedHeaders.add(actualHeader);
          break;
        }
      }
      if (resolved[canonical]) break;
    }
  }

  return resolved;
}

// Second-pass fuzzy similarity suggestion
// CRITICAL: Fuzzy matches are NEVER silently applied to auto_mapping.
// They are flagged as low-confidence suggestions for user confirmation in the mapping wizard.
export function findFuzzySuggestions(headers, aliases, alreadyMapped = {}) {
  const suggestions = {};
  const mappedHeaders = new Set(Object.values(alreadyMapped));

  for (const [canonical, options] of Object.entries(aliases)) {
    if (alreadyMapped[canonical]) continue;

    let bestHeader = null;
    let bestScore = 0;
    let bestMatchedAlias = "";

    for (const h of headers) {
      if (mappedHeaders.has(h)) continue;

      for (const opt of options) {
        const score = stringSimilarity(h, opt);
        if (score > bestScore) {
          bestScore = score;
          bestHeader = h;
          bestMatchedAlias = opt;
        }
      }
    }

    // Threshold for suggesting a fuzzy match: score >= 0.70
    if (bestScore >= 0.70 && bestHeader) {
      suggestions[canonical] = {
        header: bestHeader,
        confidence: Math.round(bestScore * 100),
        reason: `Matched alias '${bestMatchedAlias}' via fuzzy similarity (${Math.round(bestScore * 100)}%)`
      };
    }
  }

  return suggestions;
}

// Detect split date columns (e.g. Day, Month, Year columns)
export function detectSplitDateColumns(headers) {
  let dayCol = null, monthCol = null, yearCol = null;
  for (const h of headers) {
    const n = normalize(h);
    if (["day", "due day", "invoice day", "bill day", "dd"].includes(n)) dayCol = h;
    else if (["month", "due month", "invoice month", "bill month", "mm"].includes(n)) monthCol = h;
    else if (["year", "due year", "invoice year", "bill year", "yyyy"].includes(n)) yearCol = h;
  }
  if (dayCol && monthCol && yearCol) {
    return { dayCol, monthCol, yearCol };
  }
  return null;
}

// ---------------------------------------------------------------- Unified Extraction & Analysis
export function extractFileRows(fileBufferOrContent, filename = "", aliases = INVOICE_ALIASES) {
  if (isExcelFile(fileBufferOrContent, filename)) {
    const buf = Buffer.isBuffer(fileBufferOrContent) ? fileBufferOrContent : Buffer.from(fileBufferOrContent);
    const { sheetName, rows } = extractExcelWorkbook(buf, aliases);
    if (!rows || rows.length === 0) {
      throw new Error("Excel sheet contains no readable rows.");
    }
    return {
      rows,
      detected_sheet: sheetName,
      detected_delimiter: "excel",
      is_excel: true
    };
  }

  const text = Buffer.isBuffer(fileBufferOrContent)
    ? fileBufferOrContent.toString("utf-8")
    : String(fileBufferOrContent);

  const delim = detectDelimiter(text);
  const rows = parseCSVLines(text, delim);
  if (!rows || rows.length === 0) {
    throw new Error("The file appears to be empty or contains no tabular rows.");
  }
  return {
    rows,
    detected_sheet: null,
    detected_delimiter: delim,
    is_excel: false
  };
}

export function analyzeInvoicesFile(fileBufferOrContent, filename = "") {
  const { rows, detected_sheet, detected_delimiter } = extractFileRows(fileBufferOrContent, filename, INVOICE_ALIASES);
  const headerIdx = detectHeaderRow(rows, INVOICE_ALIASES);
  const headers = rows[headerIdx].map(h => String(h).trim());

  // Pass 1: Exact alias resolution
  const autoMapping = buildColumnMap(headers, INVOICE_ALIASES);

  // Check split date combination
  const splitDate = detectSplitDateColumns(headers);
  if (splitDate && !autoMapping.due_date) {
    // Note split date detected
    autoMapping._split_date = splitDate;
  }

  // Pass 2: Fuzzy fallback suggestions (flagged for user confirmation)
  const fuzzySuggestions = findFuzzySuggestions(headers, INVOICE_ALIASES, autoMapping);

  // Only EXACT alias matches count toward auto-resolving required fields
  const missingRequired = REQUIRED_INVOICE_FIELDS.filter(f => !autoMapping[f]);

  const previewRows = [];
  for (let i = headerIdx + 1; i < Math.min(rows.length, headerIdx + 4); i++) {
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = rows[i][idx] || "";
    });
    previewRows.push(row);
  }

  return {
    headers,
    auto_mapping: autoMapping,
    fuzzy_suggestions: fuzzySuggestions,
    missing_required: missingRequired,
    field_labels: INVOICE_FIELD_LABELS,
    preview_rows: previewRows,
    header_rows_skipped: headerIdx,
    detected_sheet,
    detected_delimiter
  };
}

export function analyzePaymentsFile(fileBufferOrContent, filename = "") {
  const { rows, detected_sheet, detected_delimiter } = extractFileRows(fileBufferOrContent, filename, PAYMENT_ALIASES);
  const headerIdx = detectHeaderRow(rows, PAYMENT_ALIASES);
  const headers = rows[headerIdx].map(h => String(h).trim());

  // Pass 1: Exact alias resolution
  const autoMapping = buildColumnMap(headers, PAYMENT_ALIASES);

  // Pass 2: Fuzzy fallback suggestions
  const fuzzySuggestions = findFuzzySuggestions(headers, PAYMENT_ALIASES, autoMapping);

  const missingRequired = REQUIRED_PAYMENT_FIELDS.filter(f => !autoMapping[f]);

  const previewRows = [];
  for (let i = headerIdx + 1; i < Math.min(rows.length, headerIdx + 4); i++) {
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = rows[i][idx] || "";
    });
    previewRows.push(row);
  }

  return {
    headers,
    auto_mapping: autoMapping,
    fuzzy_suggestions: fuzzySuggestions,
    missing_required: missingRequired,
    field_labels: PAYMENT_FIELD_LABELS,
    preview_rows: previewRows,
    header_rows_skipped: headerIdx,
    detected_sheet,
    detected_delimiter
  };
}

// ---------------------------------------------------------------- Parse Invoices & Payments
export function parseInvoicesFile(fileBufferOrContent, explicitMapping = null, filename = "") {
  const { rows: rawLines, detected_sheet, detected_delimiter } = extractFileRows(fileBufferOrContent, filename, INVOICE_ALIASES);
  const headerIdx = detectHeaderRow(rawLines, INVOICE_ALIASES);
  const headers = rawLines[headerIdx].map(h => String(h).trim());

  const autoMap = buildColumnMap(headers, INVOICE_ALIASES);
  const colmap = explicitMapping
    ? { ...autoMap, ...Object.fromEntries(Object.entries(explicitMapping).filter(([_, v]) => v)) }
    : autoMap;
  const splitDate = detectSplitDateColumns(headers);

  const missing = REQUIRED_INVOICE_FIELDS.filter(f => !colmap[f] && !(f === "due_date" && splitDate));
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
    if (!line || line.length === 0 || (line.length === 1 && !String(line[0]).trim())) continue;

    try {
      const getVal = (canonical) => {
        const h = colmap[canonical];
        if (!h) return "";
        const idx = headerPositions[h];
        return idx !== undefined && line[idx] !== undefined ? String(line[idx]).trim() : "";
      };

      const invoiceId = getVal("invoice_id") || `IMP-${Math.random().toString(16).slice(2, 10)}`;
      const customer = getVal("customer");
      if (!customer) throw new Error("customer is empty");

      const amount = parseAmount(getVal("amount"));

      // Resolve due_date
      let dueDateRaw = getVal("due_date");
      if (!dueDateRaw && splitDate) {
        const d = String(line[headerPositions[splitDate.dayCol]] || "").trim();
        const m = String(line[headerPositions[splitDate.monthCol]] || "").trim();
        const y = String(line[headerPositions[splitDate.yearCol]] || "").trim();
        if (d && m && y) {
          dueDateRaw = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        }
      }
      const dueDate = parseDateString(dueDateRaw);

      // Resolve issue_date
      const issueDateRaw = getVal("issue_date");
      const issueDate = issueDateRaw ? parseDateString(issueDateRaw) : dueDate;

      // Status resolution
      let status = "open";
      const statusRaw = getVal("status").toLowerCase();
      if (["paid", "open", "disputed", "partial"].includes(statusRaw)) {
        status = statusRaw;
      }

      // Optional Construction Fields
      let retentionAmount = 0;
      if (colmap.retention) {
        try { retentionAmount = parseAmount(getVal("retention")); } catch (e) { retentionAmount = 0; }
      }
      const ipcNo = colmap.ipc_no ? getVal("ipc_no") : "";
      const pdcRef = colmap.pdc_ref ? getVal("pdc_ref") : "";

      rows.push({
        invoice_id: invoiceId,
        id: invoiceId,
        customer,
        customer_name: customer,
        amount,
        issue_date: issueDate,
        issued_date: issueDate,
        due_date: dueDate,
        status,
        retention_amount: retentionAmount,
        ipc_no: ipcNo,
        pdc_ref: pdcRef
      });
    } catch (err) {
      errors.push({ row: i + 1, reason: err.message });
    }
  }

  return { rows, errors, detected_sheet, detected_delimiter };
}

export function parsePaymentsFile(fileBufferOrContent, explicitMapping = null, filename = "") {
  const { rows: rawLines, detected_sheet, detected_delimiter } = extractFileRows(fileBufferOrContent, filename, PAYMENT_ALIASES);
  const headerIdx = detectHeaderRow(rawLines, PAYMENT_ALIASES);
  const headers = rawLines[headerIdx].map(h => String(h).trim());

  const autoMap = buildColumnMap(headers, PAYMENT_ALIASES);
  const colmap = explicitMapping
    ? { ...autoMap, ...Object.fromEntries(Object.entries(explicitMapping).filter(([_, v]) => v)) }
    : autoMap;
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
    if (!line || line.length === 0 || (line.length === 1 && !String(line[0]).trim())) continue;

    try {
      const getVal = (canonical) => {
        const h = colmap[canonical];
        if (!h) return "";
        const idx = headerPositions[h];
        return idx !== undefined && line[idx] !== undefined ? String(line[idx]).trim() : "";
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

  return { rows, errors, detected_sheet, detected_delimiter };
}

// ---------------------------------------------------------------- Backwards Compatibility Wrappers
export const analyzeInvoicesCSV = (content, filename = "") => analyzeInvoicesFile(content, filename);
export const analyzePaymentsCSV = (content, filename = "") => analyzePaymentsFile(content, filename);
export const parseInvoicesCSV = (content, explicitMapping = null, filename = "") => parseInvoicesFile(content, explicitMapping, filename);
export const parsePaymentsCSV = (content, explicitMapping = null, filename = "") => parsePaymentsFile(content, explicitMapping, filename);
