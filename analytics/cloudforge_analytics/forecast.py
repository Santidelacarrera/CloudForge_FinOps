"""Explainable month-end spend forecast (no absolute promises: always an interval)."""
from __future__ import annotations

import calendar
import math
from datetime import date
from statistics import mean, pstdev

METHOD = "trailing_mean_normal_interval"


def forecast_month_end(series: dict[date, "Decimal"], as_of: date, window: int = 14,
                       budget: float | None = None) -> dict:
    """Project spend at month end from month-to-date actuals.

    projection = MTD + remaining_days * mean(last ``window`` days)
    80%/95% bands: ± z * sigma * sqrt(remaining_days), sigma = stdev of the same window
    (assumes independent daily noise; wider if the window is short).
    """
    first = as_of.replace(day=1)
    dim = calendar.monthrange(as_of.year, as_of.month)[1]
    mtd = sum(float(v) for d, v in series.items() if first <= d <= as_of)
    recent = [float(series[d]) for d in sorted(series) if d <= as_of][-window:]
    if len(recent) < 3:
        raise ValueError("need at least 3 days of history to forecast")
    remaining = dim - as_of.day
    mu, sigma = mean(recent), pstdev(recent)
    point = mtd + remaining * mu
    spread = sigma * math.sqrt(remaining)
    result = {
        "as_of": as_of.isoformat(), "month": first.strftime("%Y-%m"),
        "month_to_date": round(mtd, 2), "remaining_days": remaining,
        "point_estimate": round(point, 2),
        "interval_80": [round(point - 1.2816 * spread, 2), round(point + 1.2816 * spread, 2)],
        "interval_95": [round(point - 1.96 * spread, 2), round(point + 1.96 * spread, 2)],
        "method": {"name": METHOD, "window_days": len(recent), "daily_mean": round(mu, 2),
                   "daily_stdev": round(sigma, 2)},
        "assumptions": [
            f"daily spend stays near the trailing {len(recent)}-day mean ({mu:.2f}/day)",
            "daily deviations are independent and roughly normal",
            "no planned launches, terminations or pricing changes before month end",
            "estimate is a range, not a guarantee",
        ],
    }
    if budget is not None:
        result["budget"] = budget
        result["pct_of_budget_projected"] = round(100 * point / budget, 1)
        result["budget_exceed_probability_note"] = (
            "upper 95% bound exceeds budget" if result["interval_95"][1] > budget
            else "entire 95% interval is within budget")
    return result
