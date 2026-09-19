"""
The actual product. Every function here is deterministic arithmetic on real
rows from the database — nothing is generated or guessed by an LLM. That's
deliberate: a risk score or an aging bucket has to be exactly reproducible
and explainable to a customer, and it has to still work the day Recify's
subscription to any AI vendor lapses.
"""
from datetime import date, datetime
from collections import defaultdict

AGING_BUCKETS = [
    ("current", "Current (not yet due)", None, 0),
    ("d1_30",   "1–30 days overdue", 1, 30),
    ("d31_60",  "31–60 days overdue", 31, 60),
    ("d61_90",  "61–90 days overdue", 61, 90),
    ("d90_plus","90+ days overdue", 91, None),
]

def _parse(d):
    return datetime.fromisoformat(d).date() if isinstance(d, str) else d

def days_overdue(due_date, as_of=None):
    as_of = as_of or date.today()
    return (as_of - _parse(due_date)).days


def compute_aging(invoices, as_of=None):
    """
    invoices: list of dicts with id, customer_id (or customer name), amount, due_date, status
    Returns bucketed totals + the invoices in each bucket, for open (unpaid) invoices only.
    """
    buckets = {key: {"label": label, "min": lo, "max": hi, "value": 0.0, "count": 0, "items": []}
               for key, label, lo, hi in AGING_BUCKETS}

    for inv in invoices:
        if inv["status"] == "paid":
            continue
        d = days_overdue(inv["due_date"], as_of)
        for key, label, lo, hi in AGING_BUCKETS:
            if lo is None and d <= 0:
                bucket_key = key; break
            if lo is not None and hi is None and d >= lo:
                bucket_key = key; break
            if lo is not None and hi is not None and lo <= d <= hi:
                bucket_key = key; break
        else:
            bucket_key = "current" if d <= 0 else "d90_plus"
        b = buckets[bucket_key]
        b["value"] += inv["amount"]
        b["count"] += 1
        b["items"].append({**inv, "days_overdue": d})

    return list(buckets.values())


def generate_aging_insights(buckets, critical_days=None):
    """Templates filled with real computed numbers — see docstring above."""
    critical_days = DEFAULT_SETTINGS["critical_days"] if critical_days is None else critical_days
    total = sum(b["value"] for b in buckets)
    insights = []
    all_items = [it for b in buckets for it in b["items"]]
    risk_items = [it for it in all_items if it["days_overdue"] >= critical_days]
    risk_total = sum(it["amount"] for it in risk_items)

    if risk_total > 0 and total > 0:
        pct = round(risk_total / total * 100)
        by_cust = defaultdict(float)
        for item in risk_items:
            by_cust[item.get("customer_name", item.get("customer_id"))] += item["amount"]
        top_cust, top_amt = max(by_cust.items(), key=lambda kv: kv[1]) if by_cust else (None, 0)
        top_pct = round(top_amt / risk_total * 100) if risk_total else 0
        insights.append({
            "level": "risk" if pct > 25 else "warn",
            "tag": "Needs attention" if pct > 25 else "Worth watching",
            "text": (f"{fmt_money(risk_total)} ({pct}% of total outstanding) is past the {critical_days}-day "
                     "critical aging threshold. "
                     + (f"{top_cust} alone accounts for {fmt_money(top_amt)} of that — {top_pct}% of the at-risk balance. "
                        if top_cust else "")
                     + "This is the money most likely to become a write-off if nothing changes.")
        })

    b90 = next((b for b in buckets if b["min"] and b["min"] >= 91), None)
    if b90 and b90["value"] > 0:
        insights.append({
            "level": "risk", "tag": "Past 90 days",
            "text": (f"{b90['count']} invoice(s) totaling {fmt_money(b90['value'])} have been outstanding "
                     "for more than 90 days. Recovery odds drop sharply past this point — worth a direct "
                     "collections call or a formal write-off decision this week.")
        })

    current = next(b for b in buckets if b["label"].startswith("Current"))
    healthy_pct = round(current["value"] / total * 100) if total else 0
    insights.append({
        "level": "info", "tag": "Overall",
        "text": (f"{healthy_pct}% of outstanding receivables ({fmt_money(current['value'])}) is still within "
                 f"terms. The remaining {fmt_money(total - current['value'])} is overdue and needs active follow-up.")
    })
    return insights


def reconcile_payments(invoices, payments):
    """
    invoices: list of dicts {id, amount, status, customer_id}
    payments: list of dicts {id, invoice_ref, amount, customer_id}
    Deterministic matching — same rules as the dashboard prototype:
    Matched / Partial / Overpaid / Duplicate / Unmatched.
    """
    by_id = {inv["id"]: inv for inv in invoices}
    seen = defaultdict(int)
    results = []

    for p in payments:
        inv = by_id.get(p["invoice_ref"])
        if inv is None:
            # fuzzy fallback: same customer, closest amount, not yet paid
            candidates = [i for i in invoices if i["customer_id"] == p["customer_id"] and i["status"] != "paid"]
            suggestion = min(candidates, key=lambda c: abs(c["amount"] - p["amount"])) if candidates else None
            results.append({**p, "match_status": "unmatched", "invoice": None,
                             "diff": None, "suggestion": suggestion, "stale_status": False})
            continue

        seen[p["invoice_ref"]] += 1
        if seen[p["invoice_ref"]] > 1:
            results.append({**p, "match_status": "duplicate", "invoice": inv,
                             "diff": p["amount"], "suggestion": None, "stale_status": False})
            continue

        diff = round(p["amount"] - inv["amount"], 2)
        if abs(diff) < 1:
            status = "matched"
        elif diff < 0:
            status = "partial"
        else:
            status = "overpaid"
        stale = status == "matched" and inv["status"] != "paid"
        results.append({**p, "match_status": status, "invoice": inv,
                         "diff": diff, "suggestion": None, "stale_status": stale})

    return results


DEFAULT_SETTINGS = {
    "on_time_weight": 50,
    "late_weight": 30,
    "exposure_weight": 20,
    "critical_days": 60,     # aging cutoff used to flag "at risk" buckets/insights
    "min_probability": 0.15, # floor for cash-forecast collection probability
}

def fmt_money(n):
    return f"AED {n:,.0f}"

def score_customer(invoices_for_customer, payments_for_customer, settings=None):
    """
    Transparent, auditable credit score (0-100) — a real weighted formula,
    not a model output. Weights are configurable (see DEFAULT_SETTINGS /
    the Settings modal) and NOT hidden from Kinetics, on purpose, because
    "why did this customer get flagged" has to be a one-sentence answer,
    not a black box. Returns the full arithmetic breakdown alongside the
    total so the UI can show exactly how the number was built.
    """
    s = {**DEFAULT_SETTINGS, **(settings or {})}
    w_ontime, w_late, w_exposure = s["on_time_weight"], s["late_weight"], s["exposure_weight"]

    if not invoices_for_customer:
        return None

    total = len(invoices_for_customer)
    overdue = [i for i in invoices_for_customer if i["status"] != "paid" and days_overdue(i["due_date"]) > 0]

    on_time_ratio = 1 - (len(overdue) / total) if total else 1
    avg_days_late = (sum(days_overdue(i["due_date"]) for i in overdue) / len(overdue)) if overdue else 0
    late_penalty = min(avg_days_late / 90, 1)  # caps out at 90+ days late
    exposure = sum(i["amount"] for i in overdue)
    exposure_ratio = min(exposure / max(sum(i["amount"] for i in invoices_for_customer), 1), 1)

    on_time_pts = round(on_time_ratio * w_ontime, 1)
    late_pts = round((1 - late_penalty) * w_late, 1)
    exposure_pts = round((1 - exposure_ratio) * w_exposure, 1)
    total_score = round(max(0, min(100, on_time_pts + late_pts + exposure_pts)))

    return {
        "total": total_score,
        "on_time_points": on_time_pts, "on_time_max": w_ontime,
        "late_points": late_pts, "late_max": w_late,
        "exposure_points": exposure_pts, "exposure_max": w_exposure,
    }


def compute_cash_forecast(invoices, scores_by_customer, weeks=8, as_of=None, settings=None):
    """
    Probability-weighted cash flow forecast — no ML model, just a real,
    explainable rule: each open invoice's amount is weighted by a collection
    probability derived from that customer's own credit score (or a neutral
    default if we don't have one yet), then bucketed into the week it's due.
    Overdue invoices land in "This week" at a discounted probability, since
    they're still expected to be collected, just less reliably.
    """
    s = {**DEFAULT_SETTINGS, **(settings or {})}
    prob_floor = s["min_probability"]
    as_of = as_of or date.today()
    buckets = []
    for i in range(weeks):
        buckets.append({"week_index": i, "label": "This week" if i == 0 else f"Week {i+1}",
                         "expected": 0.0, "raw_open": 0.0, "count": 0})

    for inv in invoices:
        if inv["status"] == "paid":
            continue
        due = _parse(inv["due_date"])
        delta_days = (due - as_of).days
        week_idx = 0 if delta_days < 0 else min(delta_days // 7, weeks - 1)

        score = scores_by_customer.get(inv["customer_id"])
        if score is None:
            probability = 0.75  # neutral default for a customer with no history yet
        else:
            probability = max(prob_floor, min(0.97, score / 100))
        if delta_days < 0:
            # overdue invoices are discounted further the longer they've been late
            probability *= max(0.3, 1 - min(abs(delta_days), 120) / 150)
        probability = max(prob_floor, probability)

        b = buckets[week_idx]
        b["expected"] += inv["amount"] * probability
        b["raw_open"] += inv["amount"]
        b["count"] += 1

    for b in buckets:
        b["expected"] = round(b["expected"], 2)
        b["raw_open"] = round(b["raw_open"], 2)
    return buckets


def compute_overview(invoices, scores_by_customer_full):
    """KPIs for the executive summary — all direct aggregation, nothing modeled."""
    open_invoices = [i for i in invoices if i["status"] != "paid"]
    total_outstanding = sum(i["amount"] for i in open_invoices)
    overdue = [i for i in open_invoices if days_overdue(i["due_date"]) > 0]
    total_overdue = sum(i["amount"] for i in overdue)

    by_cust = defaultdict(float)
    for i in open_invoices:
        by_cust[i.get("customer_name", i["customer_id"])] += i["amount"]
    top_exposure = sorted(by_cust.items(), key=lambda kv: kv[1], reverse=True)[:3]

    at_risk_customers = [c for c in scores_by_customer_full if (c["score"] or 0) < 50 and c["open_balance"] > 0]

    return {
        "total_outstanding": round(total_outstanding, 2),
        "total_overdue": round(total_overdue, 2),
        "overdue_pct": round(total_overdue / total_outstanding * 100) if total_outstanding else 0,
        "open_invoice_count": len(open_invoices),
        "top_exposure": [{"name": n, "amount": round(a, 2)} for n, a in top_exposure],
        "at_risk_customers": at_risk_customers,
    }
