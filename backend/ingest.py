"""
Format-agnostic CSV/Excel ingestion pipeline for Recify (Kinetics Group LLC).
Handles:
- Format auto-detection: Native CSV (any delimiter: comma, semicolon, tab, pipe)
  and Excel (.xlsx) workbooks via Python stdlib zipfile/xml.etree.
- Multi-sheet scoring and extraction for Excel workbooks.
- Flexible header matching across common enterprise ERPs (Oracle NetSuite, QuickBooks, SAP, Dynamics, Tally).
- Exact alias matches auto-map with 100% confidence.
- Fuzzy suggestions (Levenshtein distance) are generated for the mapping wizard without silent guessing.
- Leading metadata preambles / title rows are skipped automatically.
- Regional UAE/GCC date and currency formats (AED, Dhs, DD/MM/YYYY, thousands separators, Excel serial numbers).
"""

import csv
import io
import re
import math
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

INVOICE_ALIASES = {
    "invoice_id": [
        "invoice_id", "id", "invoice_number", "invoice", "tranid", "document number",
        "doc number", "doc no", "invoice #", "inv no", "inv #", "reference", "ref no",
        "bill no", "bill number", "tax invoice no", "ipc no", "certificate no", "voucher no"
    ],
    "customer": [
        "customer", "customer_name", "client", "client_name", "company", "company_name",
        "entity", "entity name", "account", "account name", "debtor", "subcontractor to",
        "employer", "main contractor", "payer", "buyer"
    ],
    "amount": [
        "amount", "invoice_amount", "total", "gross amount", "original amount",
        "amount remaining", "balance", "balance due", "open balance", "net amount",
        "certified amount", "gross value", "total aed", "amount aed", "subtotal", "val aed"
    ],
    "issue_date": [
        "issue_date", "issued_date", "invoice_date", "date issued", "bill date",
        "doc date", "document date", "posting date", "entry date", "cert date"
    ],
    "due_date": [
        "due_date", "due", "date due", "duedate", "payment due date", "terms due date",
        "maturity date", "expiration date", "expected pay date"
    ],
    "status": [
        "status", "invoice status", "state", "doc status", "payment status",
        "approval status", "clearance state"
    ]
}

PAYMENT_ALIASES = {
    "payment_id": [
        "payment_id", "id", "tranid", "document number", "payment #", "pmt no",
        "pmt #", "ref no", "receipt no", "receipt number", "voucher no",
        "transaction id", "wire ref", "cheque no", "check no"
    ],
    "invoice_id": [
        "invoice_id", "invoice_ref", "invoice_number", "invoice", "document number",
        "invoice #", "inv no", "reference", "ref no", "applied to", "applied to invoice",
        "bill ref", "cert ref"
    ],
    "customer": [
        "customer", "customer_name", "client", "client_name", "company",
        "company_name", "entity", "entity name", "account", "payer", "from"
    ],
    "amount_paid": [
        "amount_paid", "amount", "paid_amount", "gross amount", "total",
        "payment amount", "amount received", "credit", "cleared amount",
        "received aed", "amount aed"
    ],
    "payment_date": [
        "payment_date", "paid_date", "date", "date applied", "date received",
        "clearing date", "value date", "deposit date", "settlement date"
    ],
    "method": [
        "method", "payment_method", "payment type", "instrument", "channel",
        "wire / cheque", "settlement type"
    ],
    "status": [
        "status", "payment status", "state", "doc status", "clearing status"
    ]
}

REQUIRED_INVOICE_FIELDS = ["invoice_id", "customer", "amount", "due_date"]
REQUIRED_PAYMENT_FIELDS = ["payment_id", "invoice_id", "customer", "amount_paid", "payment_date"]

INVOICE_FIELD_LABELS = {
    "invoice_id": "Invoice ID / Reference",
    "customer": "Customer / Client Name",
    "amount": "Invoice Amount (AED)",
    "due_date": "Payment Due Date",
}

PAYMENT_FIELD_LABELS = {
    "payment_id": "Payment Reference / ID",
    "invoice_id": "Invoice Reference",
    "customer": "Customer / Entity Name",
    "amount_paid": "Amount Paid (AED)",
    "payment_date": "Settlement Date",
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
    if s is None:
        return ""
    clean = re.sub(r"[^\w\s]", " ", str(s).strip().lower())
    return re.sub(r"\s+", " ", clean).strip()


def levenshtein_distance(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    dp = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, len(b) + 1):
            temp = dp[j]
            cost = 0 if a[i - 1] == b[j - 1] else 1
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + cost)
            prev = temp
    return dp[len(b)]


def string_similarity(a, b):
    norm_a = _normalize(a)
    norm_b = _normalize(b)
    if not norm_a or not norm_b:
        return 0.0
    if norm_a == norm_b:
        return 1.0
    if norm_a in norm_b or norm_b in norm_a:
        shorter = min(len(norm_a), len(norm_b))
        longer = max(len(norm_a), len(norm_b))
        return max(0.75, shorter / longer)
    max_len = max(len(norm_a), len(norm_b))
    dist = levenshtein_distance(norm_a, norm_b)
    return max(0.0, 1.0 - (dist / max_len))


def parse_amount(raw):
    if raw is None:
        raise ValueError("amount is empty")
    s = str(raw).strip()
    if not s:
        raise ValueError("amount is empty")
    negative = (s.startswith("(") and s.endswith(")")) or s.endswith("-")
    clean = re.sub(r"(?i)\b(aed|dhs|dirhams|usd|eur|sar)\b", "", s)
    clean = re.sub(r"[^\d.,\-()+\s]", "", clean).strip()
    if clean.startswith("(") and clean.endswith(")"):
        clean = clean[1:-1].strip()
    if clean.endswith("-"):
        clean = clean[:-1].strip()

    if "." in clean and "," in clean:
        if clean.rfind(",") > clean.rfind("."):
            clean = clean.replace(".", "").replace(",", ".")
        else:
            clean = clean.replace(",", "")
    elif "," in clean:
        parts = clean.split(",")
        if len(parts) == 2 and len(parts[1]) in (1, 2):
            clean = parts[0] + "." + parts[1]
        else:
            clean = clean.replace(",", "")
    elif " " in clean:
        clean = clean.replace(" ", "")

    if not clean or clean in ("-", "."):
        raise ValueError(f"'{raw}' is not a recognizable amount")
    try:
        val = float(clean)
    except ValueError:
        raise ValueError(f"'{raw}' could not be converted to a numeric amount")
    return -abs(val) if negative else val


DATE_FORMATS = [
    "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y",
    "%Y/%m/%d", "%d-%m-%Y", "%d-%b-%Y",
    "%d %b %Y", "%d %B %Y", "%b %d, %Y",
    "%B %d, %Y", "%Y%m%d", "%d.%m.%Y", "%m.%d.%Y"
]


def parse_date(raw):
    if raw is None:
        raise ValueError("date is empty")
    if isinstance(raw, datetime):
        return raw.date().isoformat()

    # Excel numeric serial date support
    if isinstance(raw, (int, float)) or (isinstance(raw, str) and raw.isdigit() and len(raw) <= 5):
        num = float(raw)
        if 20000 <= num <= 70000:
            epoch = datetime(1899, 12, 30)
            return (epoch + timedelta(days=num)).date().isoformat()

    s = str(raw).strip()
    if not s:
        raise ValueError("date is empty")

    iso_match = re.match(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", s)
    if iso_match:
        y, m, d = int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3))
        return f"{y:04d}-{m:02d}-{d:02d}"

    slash_match = re.match(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if slash_match:
        p1, p2, yr = int(slash_match.group(1)), int(slash_match.group(2)), int(slash_match.group(3))
        day, month = (p1, p2) if p1 > 12 else (p1, p2)
        return f"{yr:04d}-{month:02d}-{day:02d}"

    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"'{raw}' doesn't match any recognized date format")


def detect_delimiter(text):
    first_lines = [l for l in text.splitlines() if l.strip()][:10]
    if not first_lines:
        return ","
    sample = "\n".join(first_lines)
    counts = {
        ",": sample.count(","),
        ";": sample.count(";"),
        "\t": sample.count("\t"),
        "|": sample.count("|"),
    }
    best_delim = max(counts, key=counts.get)
    return best_delim if counts[best_delim] > 0 else ","


def extract_excel_workbook(file_bytes):
    """
    Extracts sheets from an .xlsx file using Python stdlib zipfile and XML parser.
    Returns: dict of sheet_name -> list of row lists.
    """
    wb_data = {}
    with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
        # 1. Read shared strings
        shared_strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            tree = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in tree.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
                t = si.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
                if t is not None and t.text:
                    shared_strings.append(t.text)
                else:
                    text_parts = [part.text for part in si.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t") if part.text]
                    shared_strings.append("".join(text_parts))

        # 2. Read workbook.xml to get sheet names and r:ids
        sheet_map = []
        if "xl/workbook.xml" in z.namelist():
            tree = ET.fromstring(z.read("xl/workbook.xml"))
            for sheet in tree.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet"):
                name = sheet.attrib.get("name", "Sheet1")
                sheet_map.append(name)

        if not sheet_map:
            sheet_map = ["Sheet1"]

        # 3. Read sheet XMLs
        sheet_idx = 1
        for name in sheet_map:
            sheet_path = f"xl/worksheets/sheet{sheet_idx}.xml"
            if sheet_path in z.namelist():
                tree = ET.fromstring(z.read(sheet_path))
                rows = []
                for row_el in tree.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
                    row = []
                    for c in row_el.findall("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                        val = ""
                        t_attr = c.attrib.get("t")
                        v_el = c.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
                        if v_el is not None and v_el.text is not None:
                            v_text = v_el.text
                            if t_attr == "s":
                                s_idx = int(v_text)
                                val = shared_strings[s_idx] if s_idx < len(shared_strings) else ""
                            else:
                                val = v_text
                        elif t_attr == "inlineStr":
                            is_el = c.find(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
                            if is_el is not None and is_el.text:
                                val = is_el.text
                        row.append(str(val))
                    if any(cell.strip() for cell in row):
                        rows.append(row)
                wb_data[name] = rows
            sheet_idx += 1

    return wb_data


def select_best_sheet(wb_data, aliases):
    alias_set = {_normalize(o) for opts in aliases.values() for o in opts}
    best_name = None
    best_score = -1
    for name, rows in wb_data.items():
        score = 0
        for r in rows[:15]:
            for c in r:
                if _normalize(c) in alias_set:
                    score += 2
        if score > best_score:
            best_score = score
            best_name = name
    return best_name or (list(wb_data.keys())[0] if wb_data else None)


def build_column_map(headers, aliases):
    normalized = {_normalize(h): h for h in headers if h}
    resolved = {}
    for canonical, options in aliases.items():
        for opt in options:
            norm_opt = _normalize(opt)
            if norm_opt in normalized:
                resolved[canonical] = normalized[norm_opt]
                break
    return resolved


def find_fuzzy_suggestions(headers, aliases, auto_mapping, threshold=0.55):
    suggestions = {}
    used_headers = set(auto_mapping.values())
    for canonical, options in aliases.items():
        if canonical in auto_mapping:
            continue
        best_header = None
        best_score = 0.0
        for h in headers:
            if not h or h in used_headers:
                continue
            for opt in options:
                score = string_similarity(h, opt)
                if score > best_score:
                    best_score = score
                    best_header = h
        if best_header and best_score >= threshold:
            suggestions[canonical] = {
                "header": best_header,
                "confidence": int(round(best_score * 100))
            }
    return suggestions


def detect_header_row_from_grid(grid, aliases):
    alias_set = {_normalize(o) for opts in aliases.values() for o in opts}
    best_idx = 0
    best_score = 0
    for idx, row in enumerate(grid[:20]):
        score = sum(1 for c in row if _normalize(c) in alias_set)
        if score > best_score:
            best_score = score
            best_idx = idx
    return best_idx


def extract_grid_from_file(file_bytes, filename="", aliases=None):
    aliases = aliases or INVOICE_ALIASES
    is_excel = (
        (isinstance(file_bytes, bytes) and file_bytes[:4] == b"PK\x03\x04") or
        filename.lower().endswith(".xlsx")
    )
    detected_sheet = None
    detected_delim = None

    if is_excel:
        try:
            wb = extract_excel_workbook(file_bytes)
            detected_sheet = select_best_sheet(wb, aliases)
            grid = wb.get(detected_sheet, [])
            detected_delim = "excel"
            return grid, detected_sheet, detected_delim
        except Exception:
            pass  # Fall back to text csv parsing

    text = file_bytes.decode("utf-8-sig", errors="replace") if isinstance(file_bytes, bytes) else str(file_bytes)
    detected_delim = detect_delimiter(text)
    grid = []
    reader = csv.reader(io.StringIO(text), delimiter=detected_delim)
    for row in reader:
        grid.append(row)
    return grid, detected_sheet, detected_delim


def analyze_invoices_file(file_bytes, filename=""):
    grid, detected_sheet, detected_delim = extract_grid_from_file(file_bytes, filename, INVOICE_ALIASES)
    if not grid:
        raise ValueError("The uploaded file appears to be empty.")

    header_idx = detect_header_row_from_grid(grid, INVOICE_ALIASES)
    headers = [str(h).strip() for h in grid[header_idx] if str(h).strip()]
    auto_mapping = build_column_map(headers, INVOICE_ALIASES)
    missing_required = [f for f in REQUIRED_INVOICE_FIELDS if f not in auto_mapping]
    fuzzy_suggestions = find_fuzzy_suggestions(headers, INVOICE_ALIASES, auto_mapping)

    preview_rows = []
    for r in grid[header_idx + 1: header_idx + 4]:
        row_dict = {}
        for i, h in enumerate(headers):
            row_dict[h] = str(r[i]).strip() if i < len(r) else ""
        preview_rows.append(row_dict)

    return {
        "headers": headers,
        "auto_mapping": auto_mapping,
        "fuzzy_suggestions": fuzzy_suggestions,
        "missing_required": missing_required,
        "field_labels": INVOICE_FIELD_LABELS,
        "preview_rows": preview_rows,
        "header_rows_skipped": header_idx,
        "detected_sheet": detected_sheet,
        "detected_delimiter": detected_delim
    }


def analyze_payments_file(file_bytes, filename=""):
    grid, detected_sheet, detected_delim = extract_grid_from_file(file_bytes, filename, PAYMENT_ALIASES)
    if not grid:
        raise ValueError("The uploaded file appears to be empty.")

    header_idx = detect_header_row_from_grid(grid, PAYMENT_ALIASES)
    headers = [str(h).strip() for h in grid[header_idx] if str(h).strip()]
    auto_mapping = build_column_map(headers, PAYMENT_ALIASES)
    missing_required = [f for f in REQUIRED_PAYMENT_FIELDS if f not in auto_mapping]
    fuzzy_suggestions = find_fuzzy_suggestions(headers, PAYMENT_ALIASES, auto_mapping)

    preview_rows = []
    for r in grid[header_idx + 1: header_idx + 4]:
        row_dict = {}
        for i, h in enumerate(headers):
            row_dict[h] = str(r[i]).strip() if i < len(r) else ""
        preview_rows.append(row_dict)

    return {
        "headers": headers,
        "auto_mapping": auto_mapping,
        "fuzzy_suggestions": fuzzy_suggestions,
        "missing_required": missing_required,
        "field_labels": PAYMENT_FIELD_LABELS,
        "preview_rows": preview_rows,
        "header_rows_skipped": header_idx,
        "detected_sheet": detected_sheet,
        "detected_delimiter": detected_delim
    }


def parse_invoices_file(file_bytes, explicit_mapping=None, filename=""):
    grid, detected_sheet, detected_delim = extract_grid_from_file(file_bytes, filename, INVOICE_ALIASES)
    if not grid:
        raise ValueError("The uploaded file appears to be empty.")

    header_idx = detect_header_row_from_grid(grid, INVOICE_ALIASES)
    headers = [str(h).strip() for h in grid[header_idx] if str(h).strip()]
    colmap = explicit_mapping or build_column_map(headers, INVOICE_ALIASES)
    missing = [f for f in REQUIRED_INVOICE_FIELDS if f not in colmap]
    if missing:
        raise ValueError(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(headers)}."
        )

    rows = []
    errors = []
    for row_num, row_cells in enumerate(grid[header_idx + 1:], start=header_idx + 2):
        if not row_cells or not any(str(c).strip() for c in row_cells):
            continue
        row = {h: (str(row_cells[i]).strip() if i < len(row_cells) else "") for i, h in enumerate(headers)}
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

    return rows, errors, detected_sheet, detected_delim


def parse_payments_file(file_bytes, explicit_mapping=None, filename=""):
    grid, detected_sheet, detected_delim = extract_grid_from_file(file_bytes, filename, PAYMENT_ALIASES)
    if not grid:
        raise ValueError("The uploaded file appears to be empty.")

    header_idx = detect_header_row_from_grid(grid, PAYMENT_ALIASES)
    headers = [str(h).strip() for h in grid[header_idx] if str(h).strip()]
    colmap = explicit_mapping or build_column_map(headers, PAYMENT_ALIASES)
    missing = [f for f in REQUIRED_PAYMENT_FIELDS if f not in colmap]
    if missing:
        raise ValueError(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(headers)}."
        )

    rows = []
    errors = []
    for row_num, row_cells in enumerate(grid[header_idx + 1:], start=header_idx + 2):
        if not row_cells or not any(str(c).strip() for c in row_cells):
            continue
        row = {h: (str(row_cells[i]).strip() if i < len(row_cells) else "") for i, h in enumerate(headers)}
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

    return rows, errors, detected_sheet, detected_delim


# Backwards compatibility wrappers
analyze_invoices_csv = analyze_invoices_file
analyze_payments_csv = analyze_payments_file
parse_invoices_csv = lambda fb, em=None: parse_invoices_file(fb, em)[:2]
parse_payments_csv = lambda fb, em=None: parse_payments_file(fb, em)[:2]
