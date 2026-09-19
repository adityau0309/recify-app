"""
Parsing layer for custom ledger imports. Deliberately forgiving on input
shape — column name aliases, leading metadata/title rows, mixed date
formats, currency-prefixed amounts — but strict on output: every row
either becomes a clean, typed record or is reported back as a skipped row
with a specific reason. Nothing is ever silently dropped or silently
guessed.

Column resolution is exact alias matching, never fuzzy/similarity-based —
consistent with the rest of this system, a header either matches a known
alias or it doesn't. When it doesn't, ingestion stops and hands back a
structured "needs_mapping" analysis (detected headers, a preview, and
whatever DID auto-match) instead of failing outright; the caller can then
supply an explicit mapping to finish the import.
"""
import csv
import io
import re
import uuid
from datetime import datetime

# All alias entries are matched against normalize()'d headers — lowercase,
# whitespace-collapsed, underscores/hyphens treated as spaces — so
# "Invoice_ID", "invoice id", "Invoice-ID" all resolve the same way.
INVOICE_ALIASES = {
    "invoice_id": ["invoice_id", "id", "invoice_number", "invoice", "tranid",
                    "document number", "invoice #", "inv no", "reference", "ref no"],
    "customer": ["customer", "customer_name", "client", "company", "entity",
                 "entity name", "company name"],
    "amount": ["amount", "invoice_amount", "total", "gross amount", "original amount",
               "amount remaining", "balance"],
    "issue_date": ["issue_date", "issued_date", "invoice_date"],
    "due_date": ["due_date", "due", "date due", "duedate", "payment due date", "terms due date"],
    "status": ["status", "invoice status", "state", "doc status"],
}
PAYMENT_ALIASES = {
    "payment_id": ["payment_id", "id", "tranid", "document number", "payment #", "ref no"],
    "invoice_id": ["invoice_id", "invoice_ref", "invoice_number", "invoice",
                    "document number", "invoice #", "inv no", "reference", "ref no", "applied to"],
    "customer": ["customer", "customer_name", "client", "company", "entity",
                 "entity name", "company name"],
    "amount_paid": ["amount_paid", "amount", "paid_amount", "gross amount", "total",
                     "payment amount", "amount received"],
    "payment_date": ["payment_date", "paid_date", "date", "date applied", "date received"],
    "method": ["method", "payment_method", "payment type"],
    "status": ["status", "payment status", "state", "doc status"],
}

REQUIRED_INVOICE_FIELDS = ["invoice_id", "customer", "amount", "due_date"]
REQUIRED_PAYMENT_FIELDS = ["payment_id", "invoice_id", "customer", "amount_paid", "payment_date"]

INVOICE_FIELD_LABELS = {"invoice_id": "Invoice ID", "customer": "Customer Name",
                         "amount": "Amount (AED)", "due_date": "Due Date"}
PAYMENT_FIELD_LABELS = {"payment_id": "Payment ID", "invoice_id": "Invoice ID / Reference",
                         "customer": "Customer Name", "amount_paid": "Amount Paid (AED)",
                         "payment_date": "Payment Date"}

_DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%m-%d-%Y",
                  "%d-%b-%Y", "%d-%B-%Y", "%d %b %Y", "%b %d, %Y", "%d.%m.%Y"]
_CURRENCY_RE = re.compile(r"[^\d.\-]")
_WS_RE = re.compile(r"\s+")
MAX_METADATA_SCAN = 15  # how many leading lines we'll scan looking for the real header row


class ImportError_(Exception):
    """Raised for a genuinely unrecoverable header-level problem (an empty
    file, or an explicit mapping that still leaves a required field
    unmapped). Row-level problems never raise — they're collected instead."""
    pass


def normalize(s):
    s = str(s or "").strip().lower()
    s = s.replace("_", " ").replace("-", " ")
    return _WS_RE.sub(" ", s)


def _alias_set(aliases):
    s = set()
    for options in aliases.values():
        s.update(normalize(o) for o in options)
    return s


def _build_column_map(fieldnames, aliases):
    """Auto-detects our canonical field names among the file's actual
    headers via exact normalized alias matching."""
    normalized = {normalize(f): f for f in fieldnames}
    resolved = {}
    for canonical, options in aliases.items():
        for opt in options:
            if normalize(opt) in normalized:
                resolved[canonical] = normalized[normalize(opt)]
                break
    return resolved


def _resolve_columns(fieldnames, aliases, explicit_mapping):
    """explicit_mapping (if given): canonical field -> exact header name the
    user picked in the mapping wizard. Falls back to alias auto-detection
    when no explicit mapping is supplied."""
    if explicit_mapping:
        fieldset = set(fieldnames)
        return {canonical: header for canonical, header in explicit_mapping.items()
                if header and header in fieldset}
    return _build_column_map(fieldnames, aliases)


def _detect_header_row(lines, aliases):
    """
    Real ERP/report exports often carry a title, a generated-on timestamp,
    or a blank line before the actual column header row. Scans the first
    MAX_METADATA_SCAN lines and picks whichever one has the most cells that
    exactly match a known alias — that's almost always the true header row.
    Falls back to line 0 if nothing scores above zero (keeps old behavior
    for already-clean files).
    """
    alias_set = _alias_set(aliases)
    best_idx, best_score = 0, 0
    for i, line in enumerate(lines[:MAX_METADATA_SCAN]):
        try:
            cells = next(csv.reader([line]))
        except StopIteration:
            continue
        score = sum(1 for c in cells if normalize(c) in alias_set)
        if score > best_score:
            best_score, best_idx = score, i
    return best_idx


def _read_csv(content_bytes, aliases):
    """Decodes, strips any leading metadata rows, and returns
    (DictReader-ready text, header_rows_skipped)."""
    text = content_bytes.decode("utf-8-sig")
    lines = text.splitlines()
    header_idx = _detect_header_row(lines, aliases)
    return "\n".join(lines[header_idx:]), header_idx


def parse_amount(raw):
    """Strips currency prefixes (AED, $, etc.), thousands separators, and
    whitespace, then converts to float. Accounting-style parentheses mean
    negative, e.g. '(500.00)' -> -500.0. Raises ValueError with a clear
    message on anything that still isn't a number."""
    if raw is None:
        raise ValueError("amount is empty")
    s = str(raw).strip()
    if not s:
        raise ValueError("amount is empty")
    negative = s.startswith("(") and s.endswith(")")
    s = _CURRENCY_RE.sub("", s)
    if not s or s in ("-", "."):
        raise ValueError(f"'{raw}' is not a recognizable amount")
    try:
        val = float(s)
    except ValueError:
        raise ValueError(f"'{raw}' is not a recognizable amount")
    return -abs(val) if negative else val


def parse_date(raw):
    """Accepts YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD-MMM-YYYY and a
    handful of common variants; returns a normalized ISO (YYYY-MM-DD)
    string. Raises ValueError with a clear message if nothing matches."""
    if raw is None:
        raise ValueError("date is empty")
    s = str(raw).strip()
    if not s:
        raise ValueError("date is empty")
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s.split("T")[0].split(" ")[0]).date().isoformat()
    except ValueError:
        raise ValueError(f"'{raw}' doesn't match a recognized date format "
                          "(expected YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, or DD-MMM-YYYY)")


def _preview(reader_fieldnames, text, n=3):
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for i, row in enumerate(reader):
        if i >= n:
            break
        rows.append({h: (row.get(h) or "") for h in reader_fieldnames})
    return rows


def analyze_invoices_csv(content_bytes):
    """Read-only reconnaissance pass: does NOT persist anything. Returns
    what we detected so the caller can decide whether to proceed
    automatically or show the mapping wizard."""
    text, skipped = _read_csv(content_bytes, INVOICE_ALIASES)
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    if not headers:
        raise ImportError_("The file appears to be empty or not a valid CSV.")
    auto_mapping = _build_column_map(headers, INVOICE_ALIASES)
    missing = [f for f in REQUIRED_INVOICE_FIELDS if f not in auto_mapping]
    return {
        "headers": headers, "auto_mapping": auto_mapping, "missing_required": missing,
        "field_labels": INVOICE_FIELD_LABELS, "preview_rows": _preview(headers, text),
        "header_rows_skipped": skipped,
    }


def analyze_payments_csv(content_bytes):
    text, skipped = _read_csv(content_bytes, PAYMENT_ALIASES)
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    if not headers:
        raise ImportError_("The file appears to be empty or not a valid CSV.")
    auto_mapping = _build_column_map(headers, PAYMENT_ALIASES)
    missing = [f for f in REQUIRED_PAYMENT_FIELDS if f not in auto_mapping]
    return {
        "headers": headers, "auto_mapping": auto_mapping, "missing_required": missing,
        "field_labels": PAYMENT_FIELD_LABELS, "preview_rows": _preview(headers, text),
        "header_rows_skipped": skipped,
    }


def parse_invoices_csv(content_bytes, mapping=None):
    """
    Returns (rows, errors). rows: list of dicts {invoice_id, customer,
    amount, issue_date, due_date, status}. errors: list of {row, reason}.
    mapping (optional): explicit canonical->header dict from the mapping
    wizard — when given, alias auto-detection is skipped entirely for the
    required fields (issue_date/status still fall back to defaults if
    absent from the mapping).
    Raises ImportError_ only if required fields are still unresolved.
    """
    text, _ = _read_csv(content_bytes, INVOICE_ALIASES)
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ImportError_("The file appears to be empty or not a valid CSV.")
    colmap = _resolve_columns(reader.fieldnames, INVOICE_ALIASES, mapping)
    missing = [f for f in REQUIRED_INVOICE_FIELDS if f not in colmap]
    if missing:
        raise ImportError_(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(reader.fieldnames)}."
        )

    rows, errors = [], []
    for i, raw_row in enumerate(reader, start=2):
        try:
            invoice_id = (raw_row.get(colmap["invoice_id"]) or "").strip() or f"IMP-{uuid.uuid4().hex[:8]}"
            customer = (raw_row.get(colmap["customer"]) or "").strip()
            if not customer:
                raise ValueError("customer is empty")
            amount = parse_amount(raw_row.get(colmap["amount"]))
            due_date = parse_date(raw_row.get(colmap["due_date"]))
            if "issue_date" in colmap and (raw_row.get(colmap["issue_date"]) or "").strip():
                issue_date = parse_date(raw_row.get(colmap["issue_date"]))
            else:
                issue_date = due_date  # sane fallback when not supplied/mapped
            status = "open"
            if "status" in colmap:
                s = (raw_row.get(colmap["status"]) or "").strip().lower()
                if s in ("paid", "open", "disputed", "partial"):
                    status = s
                elif s:
                    status = "open"  # unrecognized status text — treat as open rather than guess
            rows.append({
                "invoice_id": invoice_id, "customer": customer, "amount": amount,
                "issue_date": issue_date, "due_date": due_date, "status": status,
            })
        except ValueError as e:
            errors.append({"row": i, "reason": str(e)})
    return rows, errors


def parse_payments_csv(content_bytes, mapping=None):
    """Returns (rows, errors). rows: list of dicts {payment_id, invoice_id,
    customer, amount_paid, payment_date, method, status}."""
    text, _ = _read_csv(content_bytes, PAYMENT_ALIASES)
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ImportError_("The file appears to be empty or not a valid CSV.")
    colmap = _resolve_columns(reader.fieldnames, PAYMENT_ALIASES, mapping)
    missing = [f for f in REQUIRED_PAYMENT_FIELDS if f not in colmap]
    if missing:
        raise ImportError_(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(reader.fieldnames)}."
        )

    rows, errors = [], []
    for i, raw_row in enumerate(reader, start=2):
        try:
            payment_id = (raw_row.get(colmap["payment_id"]) or "").strip() or f"PMT-{uuid.uuid4().hex[:8]}"
            invoice_ref = (raw_row.get(colmap["invoice_id"]) or "").strip()
            customer = (raw_row.get(colmap["customer"]) or "").strip()
            if not customer:
                raise ValueError("customer is empty")
            amount_paid = parse_amount(raw_row.get(colmap["amount_paid"]))
            payment_date = parse_date(raw_row.get(colmap["payment_date"]))
            method = None
            if "method" in colmap:
                method = (raw_row.get(colmap["method"]) or "").strip() or None
            status = None
            if "status" in colmap:
                status = (raw_row.get(colmap["status"]) or "").strip() or None
            rows.append({
                "payment_id": payment_id, "invoice_id": invoice_ref, "customer": customer,
                "amount_paid": amount_paid, "payment_date": payment_date, "method": method, "status": status,
            })
        except ValueError as e:
            errors.append({"row": i, "reason": str(e)})
    return rows, errors


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
