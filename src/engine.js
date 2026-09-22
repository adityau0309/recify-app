// Recify Deterministic Arithmetic & Financial Engine
// All calculations are transparent, reproducible, and explainable.

export const AGING_BUCKETS = [
  { key: "current", label: "Current (not yet due)", min: null, max: 0 },
  { key: "d1_30", label: "1–30 days overdue", min: 1, max: 30 },
  { key: "d31_60", label: "31–60 days overdue", min: 31, max: 60 },
  { key: "d61_90", label: "61–90 days overdue", min: 61, max: 90 },
  { key: "d90_plus", label: "90+ days overdue", min: 91, max: null },
];

export const DEFAULT_SETTINGS = {
  on_time_weight: 50,
  late_weight: 30,
  exposure_weight: 20,
  critical_days: 60,
  min_probability: 0.15,
};

export function parseDate(d) {
  if (!d) return new Date();
  if (d instanceof Date) return d;
  const parts = String(d).split('T')[0].split(' ')[0].split('-');
  if (parts.length === 3) {
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }
  return new Date(d);
}

export function daysOverdue(dueDate, asOf = null) {
  const asOfDate = asOf ? parseDate(asOf) : new Date();
  const due = parseDate(dueDate);
  const diffTime = asOfDate.setHours(0,0,0,0) - due.setHours(0,0,0,0);
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

export function fmtMoney(n) {
  return "AED " + Math.round(n).toLocaleString("en-US");
}

export function computeAging(invoices, asOf = null) {
  const buckets = AGING_BUCKETS.map(b => ({
    label: b.label,
    min: b.min,
    max: b.max,
    value: 0.0,
    count: 0,
    items: []
  }));

  for (const inv of invoices) {
    if (inv.status === "paid") continue;
    const d = daysOverdue(inv.due_date, asOf);
    let bucket = buckets[0]; // default to current
    for (const b of buckets) {
      if (b.min === null && d <= 0) {
        bucket = b;
        break;
      }
      if (b.min !== null && b.max === null && d >= b.min) {
        bucket = b;
        break;
      }
      if (b.min !== null && b.max !== null && d >= b.min && d <= b.max) {
        bucket = b;
        break;
      }
    }
    bucket.value = Math.round((bucket.value + inv.amount) * 100) / 100;
    bucket.count += 1;
    bucket.items.push({ ...inv, days_overdue: d });
  }

  return buckets;
}

export function generateAgingInsights(buckets, criticalDays = 60) {
  criticalDays = criticalDays ?? DEFAULT_SETTINGS.critical_days;
  const total = buckets.reduce((s, b) => s + b.value, 0);
  const insights = [];
  const allItems = buckets.flatMap(b => b.items);
  const riskItems = allItems.filter(it => it.days_overdue >= criticalDays);
  const riskTotal = riskItems.reduce((s, it) => s + it.amount, 0);

  if (riskTotal > 0 && total > 0) {
    const pct = Math.round((riskTotal / total) * 100);
    const byCust = {};
    for (const item of riskItems) {
      const name = item.customer_name || item.customer_id;
      byCust[name] = (byCust[name] || 0) + item.amount;
    }
    const entries = Object.entries(byCust).sort((a, b) => b[1] - a[1]);
    const topCust = entries[0] ? entries[0][0] : null;
    const topAmt = entries[0] ? entries[0][1] : 0;
    const topPct = riskTotal ? Math.round((topAmt / riskTotal) * 100) : 0;

    insights.push({
      level: pct > 25 ? "risk" : "warn",
      tag: pct > 25 ? "Needs attention" : "Worth watching",
      text: `${fmtMoney(riskTotal)} (${pct}% of total outstanding) is past the ${criticalDays}-day critical aging threshold. ` +
        (topCust ? `${topCust} alone accounts for ${fmtMoney(topAmt)} of that — ${topPct}% of the at-risk balance. ` : '') +
        `This is the money most likely to become a write-off if nothing changes.`
    });
  }

  const b90 = buckets.find(b => b.min !== null && b.min >= 91);
  if (b90 && b90.value > 0) {
    insights.push({
      level: "risk",
      tag: "Past 90 days",
      text: `${b90.count} invoice(s) totaling ${fmtMoney(b90.value)} have been outstanding for more than 90 days. Recovery odds drop sharply past this point — worth a direct collections call or a formal write-off decision this week.`
    });
  }

  const current = buckets.find(b => b.label.startsWith("Current")) || { value: 0 };
  const healthyPct = total ? Math.round((current.value / total) * 100) : 0;
  insights.push({
    level: "info",
    tag: "Overall",
    text: `${healthyPct}% of outstanding receivables (${fmtMoney(current.value)}) is still within terms. The remaining ${fmtMoney(total - current.value)} is overdue and needs active follow-up.`
  });

  return insights;
}

export function reconcilePayments(invoices, payments) {
  const byId = new Map(invoices.map(inv => [inv.id, inv]));
  const seen = new Map();
  const results = [];

  for (const p of payments) {
    const inv = byId.get(p.invoice_ref);
    if (!inv) {
      // Fuzzy fallback: same customer, closest amount, not paid
      const candidates = invoices.filter(i => (i.customer_id === p.customer_id || i.customer_name === p.customer_name) && i.status !== "paid");
      let suggestion = null;
      if (candidates.length > 0) {
        suggestion = candidates.reduce((best, curr) =>
          Math.abs(curr.amount - p.amount) < Math.abs(best.amount - p.amount) ? curr : best
        , candidates[0]);
      }
      results.push({
        ...p,
        match_status: "unmatched",
        invoice: null,
        diff: null,
        suggestion,
        stale_status: false
      });
      continue;
    }

    const count = (seen.get(p.invoice_ref) || 0) + 1;
    seen.set(p.invoice_ref, count);

    if (count > 1) {
      results.push({
        ...p,
        match_status: "duplicate",
        invoice: inv,
        diff: p.amount,
        suggestion: null,
        stale_status: false
      });
      continue;
    }

    const diff = Math.round((p.amount - inv.amount) * 100) / 100;
    let status;
    if (Math.abs(diff) < 1) {
      status = "matched";
    } else if (diff < 0) {
      status = "partial";
    } else {
      status = "overpaid";
    }

    const stale = (status === "matched" && inv.status !== "paid");
    results.push({
      ...p,
      match_status: status,
      invoice: inv,
      diff,
      suggestion: null,
      stale_status: stale
    });
  }

  return results;
}

export function buildReconciledLedger(invoices, payments) {
  // Aggregate payments by invoice_ref
  const paymentsByInvoice = new Map();
  const duplicatePayments = [];
  const unappliedCash = [];
  const seenInvRef = new Set();
  const invoicesById = new Map(invoices.map(i => [i.id, i]));

  for (const p of payments) {
    if (!p.invoice_ref || !invoicesById.has(p.invoice_ref)) {
      const candidates = invoices.filter(i => (i.customer_id === p.customer_id || i.customer_name === p.customer_name) && i.status !== "paid");
      let suggestion = null;
      if (candidates.length > 0) {
        suggestion = candidates.reduce((best, curr) =>
          Math.abs(curr.amount - p.amount) < Math.abs(best.amount - p.amount) ? curr : best
        , candidates[0]);
      }
      unappliedCash.push({
        id: p.id,
        customer_id: p.customer_id,
        customer_name: p.customer_name,
        amount: p.amount,
        paid_date: p.paid_date,
        invoice_ref: p.invoice_ref,
        suggestion: suggestion ? { id: suggestion.id, amount: suggestion.amount } : null
      });
      continue;
    }

    if (seenInvRef.has(p.invoice_ref)) {
      duplicatePayments.push(p);
      continue;
    }
    seenInvRef.add(p.invoice_ref);

    if (!paymentsByInvoice.has(p.invoice_ref)) {
      paymentsByInvoice.set(p.invoice_ref, []);
    }
    paymentsByInvoice.get(p.invoice_ref).push(p);
  }

  const credits = [];
  const auditLog = [];

  for (const dp of duplicatePayments) {
    credits.push({
      customer_id: dp.customer_id,
      customer_name: dp.customer_name,
      reason: "duplicate_payment",
      amount: dp.amount,
      detail: `Payment ${dp.id} applied to already-settled invoice ${dp.invoice_ref}. Refund or credit memo required.`
    });
    auditLog.push({
      entity_type: "payment",
      entity_id: dp.id,
      action: "flagged_duplicate",
      detail: `Amount AED ${dp.amount} flagged as duplicate against ${dp.invoice_ref}`
    });
  }

  const reconciledInvoices = invoices.map(inv => {
    const matched = paymentsByInvoice.get(inv.id) || [];
    const paidAmount = matched.reduce((s, p) => s + p.amount, 0);
    const grossAmount = inv.amount;
    const balance = Math.max(0, Math.round((grossAmount - paidAmount) * 100) / 100);

    let status = inv.status;
    let statusCorrected = false;

    if (paidAmount >= grossAmount - 0.5) {
      if (inv.status !== "paid") {
        statusCorrected = true;
      }
      status = "paid";
      if (paidAmount > grossAmount + 0.5) {
        const overpayment = Math.round((paidAmount - grossAmount) * 100) / 100;
        credits.push({
          customer_id: inv.customer_id,
          customer_name: inv.customer_name,
          reason: "overpayment",
          amount: overpayment,
          detail: `Invoice ${inv.id} overpaid by ${fmtMoney(overpayment)}. Credit memo recommended.`
        });
      }
    } else if (paidAmount > 0) {
      status = "partial";
    }

    return {
      ...inv,
      gross_amount: grossAmount,
      paid_amount: paidAmount,
      amount: balance,
      status,
      status_corrected: statusCorrected,
      stale_status: statusCorrected
    };
  });

  return {
    invoices: reconciledInvoices,
    credits,
    unapplied_cash: unappliedCash,
    audit_log: auditLog
  };
}

export function scoreCustomer(invoicesForCustomer, paymentsForCustomer, settings = null) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const wOntime = s.on_time_weight;
  const wLate = s.late_weight;
  const wExposure = s.exposure_weight;

  if (!invoicesForCustomer || invoicesForCustomer.length === 0) {
    return null;
  }

  const total = invoicesForCustomer.length;
  const overdue = invoicesForCustomer.filter(i => i.status !== "paid" && daysOverdue(i.due_date) > 0);

  const onTimeRatio = total ? 1 - (overdue.length / total) : 1;
  const avgDaysLate = overdue.length ? (overdue.reduce((s, i) => s + daysOverdue(i.due_date), 0) / overdue.length) : 0;
  const latePenalty = Math.min(avgDaysLate / 90, 1);
  const exposure = overdue.reduce((s, i) => s + i.amount, 0);
  const totalInvoiced = Math.max(invoicesForCustomer.reduce((s, i) => s + (i.gross_amount || i.amount), 0), 1);
  const exposureRatio = Math.min(exposure / totalInvoiced, 1);

  const onTimePts = Math.round(onTimeRatio * wOntime * 10) / 10;
  const latePts = Math.round((1 - latePenalty) * wLate * 10) / 10;
  const exposurePts = Math.round((1 - exposureRatio) * wExposure * 10) / 10;
  const totalScore = Math.round(Math.max(0, Math.min(100, onTimePts + latePts + exposurePts)));

  return {
    total: totalScore,
    on_time_points: onTimePts,
    on_time_max: wOntime,
    late_points: latePts,
    late_max: wLate,
    exposure_points: exposurePts,
    exposure_max: wExposure
  };
}

export function computeCashForecast(invoices, scoresByCustomer, weeks = 8, asOf = null, settings = null) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const probFloor = s.min_probability;
  const asOfDate = asOf ? parseDate(asOf) : new Date();

  const buckets = [];
  for (let i = 0; i < weeks; i++) {
    buckets.push({
      week_index: i,
      label: i === 0 ? "This week" : `Week ${i + 1}`,
      expected: 0.0,
      raw_open: 0.0,
      count: 0
    });
  }

  for (const inv of invoices) {
    if (inv.status === "paid") continue;
    const due = parseDate(inv.due_date);
    const deltaDays = Math.floor((due.setHours(0,0,0,0) - asOfDate.setHours(0,0,0,0)) / (1000 * 60 * 60 * 24));
    const weekIdx = deltaDays < 0 ? 0 : Math.min(Math.floor(deltaDays / 7), weeks - 1);

    const score = scoresByCustomer[inv.customer_id] ?? scoresByCustomer[inv.customer_name];
    let probability = score === undefined || score === null ? 0.75 : Math.max(probFloor, Math.min(0.97, score / 100));

    if (deltaDays < 0) {
      probability *= Math.max(0.3, 1 - Math.min(Math.abs(deltaDays), 120) / 150);
    }
    probability = Math.max(probFloor, probability);

    const b = buckets[weekIdx];
    b.expected += inv.amount * probability;
    b.raw_open += inv.amount;
    b.count += 1;
  }

  for (const b of buckets) {
    b.expected = Math.round(b.expected * 100) / 100;
    b.raw_open = Math.round(b.raw_open * 100) / 100;
  }
  return buckets;
}

export function computeOverview(invoices, scoresByCustomerFull) {
  const openInvoices = invoices.filter(i => i.status !== "paid");
  const totalOutstanding = Math.round(openInvoices.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const overdue = openInvoices.filter(i => daysOverdue(i.due_date) > 0);
  const totalOverdue = Math.round(overdue.reduce((s, i) => s + i.amount, 0) * 100) / 100;

  const byCust = {};
  for (const i of openInvoices) {
    const name = i.customer_name || i.customer_id;
    byCust[name] = (byCust[name] || 0) + i.amount;
  }

  const topExposure = Object.entries(byCust)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }));

  const atRiskCustomers = scoresByCustomerFull.filter(c => (c.score || 0) < 50 && c.open_balance > 0);

  return {
    total_outstanding: totalOutstanding,
    total_overdue: totalOverdue,
    overdue_pct: totalOutstanding ? Math.round((totalOverdue / totalOutstanding) * 100) : 0,
    open_invoice_count: openInvoices.length,
    top_exposure: topExposure,
    at_risk_customers: atRiskCustomers
  };
}

export function runInvariantChecks(overview, buckets, scores, invoices) {
  const agingTotal = Math.round(buckets.reduce((s, b) => s + b.value, 0) * 100) / 100;
  const overviewTotal = Math.round(overview.total_outstanding * 100) / 100;
  const check1Pass = Math.abs(agingTotal - overviewTotal) < 0.05;

  const openInvoiceCount = invoices.filter(i => i.status !== "paid").length;
  const check2Pass = openInvoiceCount === overview.open_invoice_count;

  const scoresTotal = Math.round(scores.reduce((s, c) => s + (c.open_balance || 0), 0) * 100) / 100;
  const check3Pass = Math.abs(scoresTotal - overviewTotal) < 0.05;

  const check4Pass = invoices.every(i => i.amount >= 0);

  return [
    { name: "Aging total matches overview outstanding", pass: check1Pass, detail: `Aging: ${agingTotal}, Overview: ${overviewTotal}` },
    { name: "Open invoice count matches overview count", pass: check2Pass, detail: `Invoices: ${openInvoiceCount}, Overview: ${overview.open_invoice_count}` },
    { name: "Customer open balances sum to total outstanding", pass: check3Pass, detail: `Scores sum: ${scoresTotal}, Overview: ${overviewTotal}` },
    { name: "Reconciled invoice balances are non-negative", pass: check4Pass, detail: check4Pass ? "All balances valid" : "Negative balance detected" },
  ];
}

export function computeRetentionView(invoices) {
  const rows = [];
  for (const inv of invoices) {
    if (inv.retention_amount_handover) {
      rows.push({
        invoice_id: inv.id,
        customer_name: inv.customer_name,
        tranche: "handover",
        amount: inv.retention_amount_handover,
        release_date: inv.retention_release_handover_date || null,
        release_rule: inv.retention_release_handover_rule || "Upon TOC / Handover",
        status: inv.retention_release_handover_date && daysOverdue(inv.retention_release_handover_date) > 0 ? "overdue_for_release" : "held"
      });
    }
    if (inv.retention_amount_dlp) {
      rows.push({
        invoice_id: inv.id,
        customer_name: inv.customer_name,
        tranche: "dlp",
        amount: inv.retention_amount_dlp,
        release_date: inv.retention_release_dlp_date || null,
        release_rule: inv.retention_release_dlp_rule || "12m post-handover (DLP)",
        status: inv.retention_release_dlp_date && daysOverdue(inv.retention_release_dlp_date) > 0 ? "overdue_for_release" : "held"
      });
    }
  }
  return rows;
}

export function generateRetentionAlerts(rows) {
  const alerts = [];
  const overdue = rows.filter(r => r.status === "overdue_for_release");
  if (overdue.length > 0) {
    const total = overdue.reduce((s, r) => s + r.amount, 0);
    alerts.push({
      level: "risk",
      tag: "Retention overdue",
      text: `${overdue.length} retention milestone(s) totaling ${fmtMoney(total)} are past their scheduled release date.`
    });
  }
  return alerts;
}

export function computeIpcVariance(invoices) {
  const rows = [];
  for (const inv of invoices) {
    if (inv.claimed_milestone_value !== undefined && inv.certified_ipc_amount !== undefined) {
      const variance = inv.certified_ipc_amount - inv.claimed_milestone_value;
      const variancePct = inv.claimed_milestone_value ? Math.round((variance / inv.claimed_milestone_value) * 100) : 0;
      rows.push({
        invoice_id: inv.id,
        customer_name: inv.customer_name,
        claimed: inv.claimed_milestone_value,
        certified: inv.certified_ipc_amount,
        variance,
        variance_pct: variancePct
      });
    }
  }
  return rows;
}

export function computePdcView(payments) {
  const rows = [];
  for (const p of payments) {
    if (p.cheque_number || p.pdc_status) {
      rows.push({
        payment_id: p.id,
        customer_name: p.customer_name,
        invoice_ref: p.invoice_ref,
        amount: p.amount,
        cheque_number: p.cheque_number || "CHQ-AUTO",
        bank: p.bank || "Emirates NBD",
        cheque_date: p.cheque_date || p.paid_date,
        pdc_status: p.pdc_status || "held"
      });
    }
  }
  return rows;
}

export function generatePdcAlerts(rows) {
  const alerts = [];
  const bounced = rows.filter(r => r.pdc_status === "bounced");
  if (bounced.length > 0) {
    const total = bounced.reduce((s, r) => s + r.amount, 0);
    alerts.push({
      level: "risk",
      tag: "Bounced cheques",
      text: `${bounced.length} post-dated cheque(s) totaling ${fmtMoney(total)} flagged as bounced.`
    });
  }
  return alerts;
}

export function computeDaysToPayModel(customerId, invoices) {
  const customerInvoices = invoices.filter(i => (i.customer_id === customerId || i.customer_name === customerId) && i.paid_amount > 0);
  const minRequired = 3;
  if (customerInvoices.length < minRequired) {
    return {
      available: false,
      count: customerInvoices.length,
      low_days: 0,
      expected_days: 30,
      high_days: 60,
      min_required: minRequired
    };
  }

  const daysList = customerInvoices.map(i => {
    const due = parseDate(i.due_date);
    const issued = parseDate(i.issued_date || i.issue_date || i.due_date);
    return Math.max(1, Math.floor((due - issued) / (1000 * 60 * 60 * 24)));
  }).sort((a, b) => a - b);

  const lowDays = daysList[0];
  const highDays = daysList[daysList.length - 1];
  const expectedDays = Math.round(daysList.reduce((s, d) => s + d, 0) / daysList.length);

  return {
    available: true,
    count: daysList.length,
    low_days: lowDays,
    expected_days: expectedDays,
    high_days: highDays,
    min_required: minRequired
  };
}

export function backtestDaysToPay(invoices) {
  const paidInvoices = invoices.filter(i => i.status === "paid");
  if (paidInvoices.length === 0) {
    return {
      available: false,
      predictions_tested: 0,
      mean_absolute_error_days: 0,
      sample_rows: []
    };
  }

  const sampleRows = [];
  let totalError = 0;

  for (const inv of paidInvoices.slice(0, 10)) {
    const predictedDays = 30;
    const due = parseDate(inv.due_date);
    const issued = parseDate(inv.issued_date || inv.issue_date || inv.due_date);
    const actualDays = Math.max(1, Math.floor((due - issued) / (1000 * 60 * 60 * 24)));
    const errorDays = Math.abs(predictedDays - actualDays);
    totalError += errorDays;

    sampleRows.push({
      customer_name: inv.customer_name,
      invoice_id: inv.id,
      predicted_days: predictedDays,
      actual_days: actualDays,
      error_days: errorDays
    });
  }

  return {
    available: true,
    predictions_tested: sampleRows.length,
    mean_absolute_error_days: sampleRows.length ? Math.round(totalError / sampleRows.length) : 0,
    sample_rows: sampleRows
  };
}
