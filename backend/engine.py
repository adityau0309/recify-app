"""
Deterministic arithmetic for Recify AR Engine.
No LLM touches these calculations. Everything here is pure, reproducible arithmetic
derived from invoices, payments, and configured parameters.
"""

from datetime import datetime, date

AGING_BUCKETS = [
    {"key": "current", "label": "Current (not yet due)", "min": None, "max": 0},
    {"key": "d1_30", "label": "1–30 days overdue", "min": 1, "max": 30},
    {"key": "d31_60", "label": "31–60 days overdue", "min": 31, "max": 60},
    {"key": "d61_90", "label": "61–90 days overdue", "min": 61, "max": 90},
    {"key": "d90_plus", "label": "90+ days overdue", "min": 91, "max": None},
]

DEFAULT_SETTINGS = {
    "on_time_weight": 50,
    "late_weight": 30,
    "exposure_weight": 20,
    "critical_days": 60,
    "min_probability": 0.15,
}


def _parse(d):
    return datetime.strptime(d, "%Y-%m-%d").date() if isinstance(d, str) else d


def days_overdue(due_date, as_of=None):
    as_of = as_of or date.today()
    return (as_of - _parse(due_date)).days


def compute_aging(invoices, as_of=None):
    """
    Given a list of invoice dicts, bucket them by overdue status as of `as_of`.
    Returns bucket metadata plus total AED and count per bucket.
    """
    buckets = [
        {"label": b["label"], "min": b["min"], "max": b["max"], "value": 0.0, "count": 0, "items": []}
        for b in AGING_BUCKETS
    ]
    for inv in invoices:
        if inv.get("status") == "paid":
            continue
        d = days_overdue(inv["due_date"], as_of)
        target = buckets[0]
        for b in buckets:
            if b["min"] is None and d <= 0:
                target = b
                break
            if b["min"] is not None and b["max"] is None and d >= b["min"]:
                target = b
                break
            if b["min"] is not None and b["max"] is not None and b["min"] <= d <= b["max"]:
                target = b
                break
        target["value"] = round(target["value"] + inv["amount"], 2)
        target["count"] += 1
        target["items"].append({**inv, "days_overdue": d})
    return buckets


def generate_aging_insights(buckets, critical_days=None):
    """
    Produce plain-English observations directly from bucket arithmetic.
    Every statement cites the numbers that back it up.
    """
    critical_days = critical_days if critical_days is not None else DEFAULT_SETTINGS["critical_days"]
    total = sum(b["value"] for b in buckets)
    insights = []

    all_items = [it for b in buckets for it in b["items"]]
    risk_items = [it for it in all_items if it["days_overdue"] > critical_days]
    risk_total = sum(it["amount"] for it in risk_items)

    if risk_total > 0 and total > 0:
        pct = round((risk_total / total) * 100)
        by_cust = {}
        for it in risk_items:
            by_cust[it["customer_name"]] = by_cust.get(it["customer_name"], 0) + it["amount"]
        top_cust, top_amt = max(by_cust.items(), key=lambda x: x[1])
        top_pct = round((top_amt / risk_total) * 100) if risk_total else 0

        insights.append({
            "level": "risk" if pct > 25 else "warn",
            "tag": "Needs attention" if pct > 25 else "Worth watching",
            "text": (
                f"{fmt_money(risk_total)} ({pct}% of total outstanding) is past the "
                f"{critical_days}-day critical aging threshold. "
                f"{top_cust} alone accounts for {fmt_money(top_amt)} of that — "
                f"{top_pct}% of the at-risk balance. "
                "This is the money most likely to become a write-off if nothing changes."
            ),
        })

    b90 = next((b for b in buckets if b["min"] is not None and b["min"] >= 91), None)
    if b90 and b90["value"] > 0:
        insights.append({
            "level": "risk",
            "tag": "Past 90 days",
            "text": (
                f"{b90['count']} invoice(s) totaling {fmt_money(b90['value'])} have been outstanding "
                "for more than 90 days. Recovery odds drop sharply past this point — "
                "worth a direct collections call or a formal write-off decision this week."
            ),
        })

    current = next((b for b in buckets if b["label"].startswith("Current")), None)
    if current and total > 0:
        healthy_pct = round((current["value"] / total) * 100)
        insights.append({
            "level": "info",
            "tag": "Overall",
            "text": (
                f"{healthy_pct}% of outstanding receivables ({fmt_money(current['value'])}) is still within terms. "
                f"The remaining {fmt_money(total - current['value'])} is overdue and needs active follow-up."
            ),
        })

    return insights


def reconcile_payments(invoices, payments):
    """
    Deterministic rule-based payment matching.
    Matches payment.invoice_ref -> invoice.id.
    Detects:
      - matched: exact match on id and amount
      - partial: payment < invoice amount
      - overpaid: payment > invoice amount
      - duplicate: more than one payment references the same invoice
      - unmatched: payment has an invoice_ref that doesn't exist
    """
    by_id = {inv["id"]: inv for inv in invoices}
    seen = {}
    results = []

    for p in payments:
        inv = by_id.get(p.get("invoice_ref"))
        if not inv:
            candidates = [
                i for i in invoices
                if i["customer_id"] == p["customer_id"] and i.get("status") != "paid"
            ]
            suggestion = None
            if candidates:
                suggestion = min(candidates, key=lambda c: abs(c["amount"] - p["amount"]))
            results.append({
                **p,
                "match_status": "unmatched",
                "invoice": None,
                "diff": None,
                "suggestion": suggestion,
                "stale_status": False,
            })
            continue

        seen[p["invoice_ref"]] = seen.get(p["invoice_ref"], 0) + 1
        if seen[p["invoice_ref"]] > 1:
            results.append({
                **p,
                "match_status": "duplicate",
                "invoice": inv,
                "diff": p["amount"],
                "suggestion": None,
                "stale_status": False,
            })
            continue

        diff = round(p["amount"] - inv["amount"], 2)
        if abs(diff) < 1.0:
            status = "matched"
        elif diff < 0:
            status = "partial"
        else:
            status = "overpaid"

        stale = (status == "matched" and inv.get("status") != "paid")
        results.append({
            **p,
            "match_status": status,
            "invoice": inv,
            "diff": diff,
            "suggestion": None,
            "stale_status": stale,
        })
    return results


def fmt_money(n):
    return f"AED {n:,.0f}"


def score_customer(invoices_for_customer, payments_for_customer, settings=None):
    """
    Deterministic credit scoring, 0–100, fully transparent.
    Weights are pulled from settings (defaults sum to 100):
      - on_time_weight (default 50): proportion of customer's invoices paid on time
      - late_weight (default 30): penalty for average days overdue across late invoices
      - exposure_weight (default 20): overdue balance as a fraction of total invoiced
    Returns a score plus a full breakdown so the UI can explain every point.
    """
    s = settings or DEFAULT_SETTINGS
    w_ontime = s["on_time_weight"]
    w_late = s["late_weight"]
    w_exposure = s["exposure_weight"]

    if not invoices_for_customer:
        return None

    total = len(invoices_for_customer)
    overdue = [i for i in invoices_for_customer if i.get("status") != "paid" and days_overdue(i["due_date"]) > 0]

    on_time_ratio = (total - len(overdue)) / total if total else 1.0
    avg_days_late = sum(days_overdue(i["due_date"]) for i in overdue) / len(overdue) if overdue else 0
    late_penalty = min(avg_days_late / 90.0, 1.0)
    exposure = sum(i["amount"] for i in overdue)
    total_invoiced = sum(i.get("gross_amount", i["amount"]) for i in invoices_for_customer) or 1.0
    exposure_ratio = min(exposure / total_invoiced, 1.0)

    on_time_pts = round(on_time_ratio * w_ontime, 1)
    late_pts = round((1.0 - late_penalty) * w_late, 1)
    exposure_pts = round((1.0 - exposure_ratio) * w_exposure, 1)
    total_score = int(round(max(0, min(100, on_time_pts + late_pts + exposure_pts))))

    return {
        "total": total_score,
        "on_time_points": on_time_pts,
        "on_time_max": w_ontime,
        "late_points": late_pts,
        "late_max": w_late,
        "exposure_points": exposure_pts,
        "exposure_max": w_exposure,
    }


def compute_cash_forecast(invoices, scores_by_customer, weeks=8, as_of=None, settings=None):
    """
    Probability-weighted cash flow forecast.
    Open invoices are grouped into calendar weeks from `as_of`.
    Each invoice's probability of paying on time is derived from the customer's score:
      prob = clamp(score / 100, min_probability, 0.97)
    If the invoice is already overdue, probability degrades further based on how late it is.
    """
    prob_floor = (settings or DEFAULT_SETTINGS)["min_probability"]
    as_of = as_of or date.today()
    buckets = [
        {"week_index": i, "label": "This week" if i == 0 else f"Week {i + 1}", "expected": 0.0, "raw_open": 0.0, "count": 0}
        for i in range(weeks)
    ]

    for inv in invoices:
        if inv.get("status") == "paid":
            continue
        due = _parse(inv["due_date"])
        delta_days = (due - as_of).days
        week_idx = 0 if delta_days < 0 else min(delta_days // 7, weeks - 1)

        score = scores_by_customer.get(inv["customer_id"], 75)
        prob = max(prob_floor, min(0.97, score / 100.0))

        if delta_days < 0:
            prob *= max(0.3, 1.0 - (min(abs(delta_days), 120) / 150.0))
        prob = max(prob_floor, prob)

        b = buckets[week_idx]
        b["expected"] += inv["amount"] * prob
        b["raw_open"] += inv["amount"]
        b["count"] += 1

    for b in buckets:
        b["expected"] = round(b["expected"], 2)
        b["raw_open"] = round(b["raw_open"], 2)
    return buckets


def compute_overview(invoices, scores_by_customer_full):
    open_invoices = [i for i in invoices if i.get("status") != "paid"]
    total_outstanding = round(sum(i["amount"] for i in open_invoices), 2)
    overdue = [i for i in open_invoices if days_overdue(i["due_date"]) > 0]
    total_overdue = round(sum(i["amount"] for i in overdue), 2)

    by_cust = {}
    for i in open_invoices:
        by_cust[i["customer_name"]] = by_cust.get(i["customer_name"], 0) + i["amount"]
    top_exposure = sorted(
        [{"name": k, "amount": round(v, 2)} for k, v in by_cust.items()],
        key=lambda x: x["amount"],
        reverse=True,
    )[:3]

    at_risk = [c for c in scores_by_customer_full if (c.get("score") or 0) < 50 and c.get("open_balance", 0) > 0]

    return {
        "total_outstanding": total_outstanding,
        "total_overdue": total_overdue,
        "overdue_pct": round((total_overdue / total_outstanding) * 100) if total_outstanding else 0,
        "open_invoice_count": len(open_invoices),
        "top_exposure": top_exposure,
        "at_risk_customers": at_risk,
    }
