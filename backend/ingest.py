"""
CSV ingestion with alias resolution, date normalization, currency parsing,
and automatic detection of header rows (even with metadata preambles).
"""

import csv
import io
import re
from datetime import datetime

INVOICE_ALIASES = {
    "invoice_id": ["invoice_id", "id", "invoice_number", "invoice", "tranid", "document number", "invoice #", "inv no", "reference", "ref no"],
    "customer": ["customer", "customer_name", "client", "company", "entity", "entity name", "company name"],
    "amount": ["amount", "invoice_amount", "total", "gross amount", "original amount", "amount remaining", "balance"],
    "issue_date": ["issue_date", "issued_date", "invoice_date"],
    "due_date": ["due_date", "due", "date due", "duedate", "payment due date", "terms due date"],
    "status": ["status", "invoice status", "state", "doc status"],
}

PAYMENT_ALIASES = {
    "payment_id": ["payment_id", "id", "tranid", "document number", "payment #", "ref no"],
    "invoice_id": ["invoice_id", "invoice_ref", "invoice_number", "invoice", "document number", "invoice #", "inv no", "reference", "ref no", "applied to"],
    "customer": ["customer", "customer_name", "client", "company", "entity", "entity name", "company name"],
    "amount_paid": ["amount_paid", "amount", "paid_amount", "gross amount", "total", "payment amount", "amount received"],
    "payment_date": ["payment_date", "paid_date", "date", "date applied", "date received"],
    "method": ["method", "payment_method", "payment type"],
    "status": ["status", "payment status", "state", "doc status"],
}

REQUIRED_INVOICE_FIELDS = ["invoice_id", "customer", "amount", "due_date"]
REQUIRED_PAYMENT_FIELDS = ["payment_id", "invoice_id", "customer", "amount_paid", "payment_date"]

INVOICE_FIELD_LABELS = {
    "invoice_id": "Invoice ID",
    "customer": "Customer Name",
    "amount": "Amount (AED)",
    "due_date": "Due Date",
}

PAYMENT_FIELD_LABELS = {
    "payment_id": "Payment ID",
    "invoice_id": "Invoice ID / Reference",
    "customer": "Customer Name",
    "amount_paid": "Amount Paid (AED)",
    "payment_date": "Payment Date",
}

INVOICE_TEMPLATE_CSV = (
    "invoice_id,customer,amount,issue_date,due_date,status\n"
    "INV-2001,Al Noor Contracting LLC,84500,2026-08-01,2026-08-31,open\n"
    "INV-2002,Falcon Gulf Builders,132000,2026-07-15,2026-08-14,open\n"
    "INV-2003,Desert Rose Construction,45750,2026-06-01,2026-07-01,paid\n"
)

PAYMENT_TEMPLATE_CSV = (
    "payment_id,invoice_id,customer,amount_paid,payment_date,status\n"
    "PMT-2001,INV-2003,Desert Rose Construction,45750,2026-06-28,Cleared\n"
    "PMT-2002,INV-2001,Al Noor Contracting LLC,50000,2026-08-20,Cleared\n"
)

PDC_TEMPLATE_CSV = (
    "cheque_no,issuing_bank,drawer_entity,amount,maturity_date,status,invoice_ref\n"
    "CHQ-782190,Emirates NBD,Meridian Gulf Projects,180500,2026-09-24,Due This Week,KIN-5010\n"
    "CHQ-449102,ADCB,Falcon Gulf Builders,139900,2026-09-26,Due This Week,KIN-5020\n"
)

AP_TEMPLATE_CSV = (
    "vendor_name,category,invoice_no,amount_due,due_date,status,discount_terms\n"
    "National Manpower Solutions LLC,Critical Path Labor,AP-9101,285000,2026-09-25,Approved,\n"
    "Daikin Middle East FZE,Long-Lead Materials,AP-8840,390000,2026-10-05,Pending,2/10 Net 30\n"
)


def _normalize(s):
    return re.sub(r"[\s_-]+", " ", str(s).strip().lower())


def parse_amount(raw):
    if raw is None:
        raise ValueError("amount is empty")
    s = str(raw).strip()
    if not s:
        raise ValueError("amount is empty")
    negative = s.startswith("(") and s.endswith(")")
    s = re.sub(r"[^\d.-]", "", s)
    if not s or s in ("-", "."):
        raise ValueError(f"'{raw}' is not a recognizable amount")
    val = float(s)
    return -abs(val) if negative else val


DATE_FORMATS = [
    "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y",
    "%Y/%m/%d", "%d-%m-%Y", "%d-%b-%Y",
    "%d %b %Y", "%d %B %Y", "%b %d, %Y",
    "%B %d, %Y", "%Y%m%d",
]


def parse_date(raw):
    if not raw:
        raise ValueError("date is empty")
    s = str(raw).strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"'{raw}' doesn't match any recognized date format")


def _build_column_map(headers, aliases):
    normalized = {_normalize(h): h for h in headers}
    resolved = {}
    for canonical, options in aliases.items():
        for opt in options:
            norm_opt = _normalize(opt)
            if norm_opt in normalized:
                resolved[canonical] = normalized[norm_opt]
                break
    return resolved


def _detect_header_row(raw_lines, aliases):
    alias_set = {_normalize(o) for opts in aliases.values() for o in opts}
    best_idx = 0
    best_score = 0
    for idx, line in enumerate(raw_lines[:15]):
        reader = csv.reader([line])
        try:
            cells = next(reader)
        except Exception:
            continue
        score = sum(1 for c in cells if _normalize(c) in alias_set)
        if score > best_score:
            best_score = score
            best_idx = idx
    return best_idx


def analyze_invoices_csv(file_bytes):
    text = file_bytes.decode("utf-8-sig", errors="replace")
    raw_lines = [l for l in text.splitlines() if l.strip()]
    if not raw_lines:
        raise ValueError("The file appears to be empty.")
    header_idx = _detect_header_row(raw_lines, INVOICE_ALIASES)
    reader = csv.reader(raw_lines[header_idx:])
    headers = [h.strip() for h in next(reader)]
    auto_mapping = _build_column_map(headers, INVOICE_ALIASES)
    missing_required = [f for f in REQUIRED_INVOICE_FIELDS if f not in auto_mapping]

    preview_rows = []
    for _ in range(3):
        try:
            row = next(reader)
            preview_rows.append(dict(zip(headers, [c.strip() for c in row])))
        except StopIteration:
            break

    return {
        "headers": headers,
        "auto_mapping": auto_mapping,
        "missing_required": missing_required,
        "field_labels": INVOICE_FIELD_LABELS,
        "preview_rows": preview_rows,
        "header_rows_skipped": header_idx,
    }


def analyze_payments_csv(file_bytes):
    text = file_bytes.decode("utf-8-sig", errors="replace")
    raw_lines = [l for l in text.splitlines() if l.strip()]
    if not raw_lines:
        raise ValueError("The file appears to be empty.")
    header_idx = _detect_header_row(raw_lines, PAYMENT_ALIASES)
    reader = csv.reader(raw_lines[header_idx:])
    headers = [h.strip() for h in next(reader)]
    auto_mapping = _build_column_map(headers, PAYMENT_ALIASES)
    missing_required = [f for f in REQUIRED_PAYMENT_FIELDS if f not in auto_mapping]

    preview_rows = []
    for _ in range(3):
        try:
            row = next(reader)
            preview_rows.append(dict(zip(headers, [c.strip() for c in row])))
        except StopIteration:
            break

    return {
        "headers": headers,
        "auto_mapping": auto_mapping,
        "missing_required": missing_required,
        "field_labels": PAYMENT_FIELD_LABELS,
        "preview_rows": preview_rows,
        "header_rows_skipped": header_idx,
    }


def parse_invoices_csv(file_bytes, explicit_mapping=None):
    text = file_bytes.decode("utf-8-sig", errors="replace")
    raw_lines = [l for l in text.splitlines() if l.strip()]
    if not raw_lines:
        raise ValueError("The file appears to be empty.")
    header_idx = _detect_header_row(raw_lines, INVOICE_ALIASES)
    reader = csv.reader(raw_lines[header_idx:])
    headers = [h.strip() for h in next(reader)]

    colmap = explicit_mapping or _build_column_map(headers, INVOICE_ALIASES)
    missing = [f for f in REQUIRED_INVOICE_FIELDS if f not in colmap]
    if missing:
        raise ValueError(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(headers)}."
        )

    rows = []
    errors = []
    for row_num, row_cells in enumerate(reader, start=header_idx + 2):
        if not row_cells or not any(c.strip() for c in row_cells):
            continue
        row = {h: (row_cells[i].strip() if i < len(row_cells) else "") for i, h in enumerate(headers)}
        try:
            inv_id = row.get(colmap.get("invoice_id", ""), "").strip() or f"IMP-{row_num}"
            cust = row.get(colmap.get("customer", ""), "").strip()
            if not cust:
                raise ValueError("customer is empty")
            amount = parse_amount(row.get(colmap.get("amount", ""), ""))
            due = parse_date(row.get(colmap.get("due_date", ""), ""))
            issue_raw = row.get(colmap.get("issue_date", ""), "") if "issue_date" in colmap else ""
            issue = parse_date(issue_raw) if issue_raw else due

            status = "open"
            if "status" in colmap:
                s = row.get(colmap["status"], "").strip().lower()
                if s in ("paid", "open", "disputed", "partial"):
                    status = s

            rows.append({
                "invoice_id": inv_id,
                "customer": cust,
                "amount": amount,
                "issue_date": issue,
                "due_date": due,
                "status": status,
            })
        except Exception as e:
            errors.append({"row": row_num, "reason": str(e)})

    return rows, errors


def parse_payments_csv(file_bytes, explicit_mapping=None):
    text = file_bytes.decode("utf-8-sig", errors="replace")
    raw_lines = [l for l in text.splitlines() if l.strip()]
    if not raw_lines:
        raise ValueError("The file appears to be empty.")
    header_idx = _detect_header_row(raw_lines, PAYMENT_ALIASES)
    reader = csv.reader(raw_lines[header_idx:])
    headers = [h.strip() for h in next(reader)]

    colmap = explicit_mapping or _build_column_map(headers, PAYMENT_ALIASES)
    missing = [f for f in REQUIRED_PAYMENT_FIELDS if f not in colmap]
    if missing:
        raise ValueError(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(headers)}."
        )

    rows = []
    errors = []
    for row_num, row_cells in enumerate(reader, start=header_idx + 2):
        if not row_cells or not any(c.strip() for c in row_cells):
            continue
        row = {h: (row_cells[i].strip() if i < len(row_cells) else "") for i, h in enumerate(headers)}
        try:
            pid = row.get(colmap.get("payment_id", ""), "").strip() or f"PMT-{row_num}"
            inv_ref = row.get(colmap.get("invoice_id", ""), "").strip()
            cust = row.get(colmap.get("customer", ""), "").strip()
            if not cust:
                raise ValueError("customer is empty")
            amount = parse_amount(row.get(colmap.get("amount_paid", ""), ""))
            pdate = parse_date(row.get(colmap.get("payment_date", ""), ""))
            method = row.get(colmap.get("method", ""), "ACH").strip() or "ACH"
            status = row.get(colmap.get("status", ""), "Cleared").strip() or "Cleared"

            rows.append({
                "payment_id": pid,
                "invoice_id": inv_ref,
                "customer": cust,
                "amount_paid": amount,
                "payment_date": pdate,
                "method": method,
                "status": status,
            })
        except Exception as e:
            errors.append({"row": row_num, "reason": str(e)})

    return rows, errors
