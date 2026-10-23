"""Budget model: scoped monthly budgets, threshold events and an explainable status.

Status rules (evaluated on month-to-date actuals plus the explainable forecast):
  exceeded : month-to-date spend already above the budget
  at_risk  : projected month-end (point estimate) above the budget
  watch    : only the upper 95% bound of the projection is above the budget
  ok       : the whole 95% interval is within the budget
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from .forecast import forecast_month_end

SCOPE_TYPES = ("total", "project", "service", "environment")
DEFAULT_THRESHOLDS = (0.5, 0.8, 1.0)


def threshold_events(spent: float, budget: float, thresholds=DEFAULT_THRESHOLDS) -> list[dict]:
    """Return the budget thresholds crossed by ``spent`` (event feed for workflow triggers)."""
    if budget <= 0:
        raise ValueError("budget must be positive")
    pct = spent / budget
    return [{"type": "budget_threshold", "threshold": t, "spent": round(spent, 2),
             "budget": budget, "pct": round(100 * pct, 1)} for t in sorted(thresholds) if pct >= t]


def evaluate(series: dict[date, Decimal | float], amount: float, as_of: date, window: int = 14,
             thresholds=DEFAULT_THRESHOLDS) -> dict:
    """Status of one budget given the daily series that falls in its scope."""
    if amount <= 0:
        raise ValueError("budget amount must be positive")
    f = forecast_month_end(series, as_of, window=window, budget=amount)
    mtd = f["month_to_date"]
    if mtd > amount:
        status = "exceeded"
    elif f["point_estimate"] > amount:
        status = "at_risk"
    elif f["interval_95"][1] > amount:
        status = "watch"
    else:
        status = "ok"
    return {
        "status": status, "as_of": as_of.isoformat(), "month": f["month"], "budget": amount,
        "month_to_date": mtd, "pct_spent": round(100 * mtd / amount, 1),
        "projected": f["point_estimate"], "projected_pct": f["pct_of_budget_projected"],
        "interval_95": f["interval_95"], "events": threshold_events(mtd, amount, thresholds),
        "method": f["method"], "assumptions": f["assumptions"],
    }
