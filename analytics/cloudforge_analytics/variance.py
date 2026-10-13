"""Month-over-month variance on a like-for-like period (days 1..N of each month)."""
from __future__ import annotations

import calendar
from datetime import date
from decimal import Decimal


def _prev_month(d: date) -> date:
    return date(d.year - 1, 12, 1) if d.month == 1 else date(d.year, d.month - 1, 1)


def mom_variance(series_by_key: dict[str, dict[date, Decimal | float]], as_of: date) -> dict:
    """Compare spend over days 1..N of the month of ``as_of`` with days 1..N of the previous month.

    Using the same elapsed days avoids reporting a partial month as a "drop". When the previous
    month is shorter than N, its whole month is used and the row is flagged ``prior_truncated``.
    """
    n = as_of.day
    prev_first = _prev_month(as_of)
    prev_days = calendar.monthrange(prev_first.year, prev_first.month)[1]
    prev_n = min(n, prev_days)
    cur_first = as_of.replace(day=1)
    rows = []
    for key, series in series_by_key.items():
        cur = sum(float(v) for d, v in series.items() if cur_first <= d <= as_of)
        prior = sum(float(v) for d, v in series.items() if prev_first <= d <= prev_first.replace(day=prev_n))
        delta = cur - prior
        pct = None if prior == 0 else round(100 * delta / prior, 1)
        explanation = (f"{key}: {cur:.2f} over days 1-{n} of {cur_first:%Y-%m} "
                       f"vs {prior:.2f} over days 1-{prev_n} of {prev_first:%Y-%m}")
        rows.append({"series": key, "current": round(cur, 2), "prior": round(prior, 2), "delta": round(delta, 2),
                     "pct": pct, "prior_truncated": prev_n < n, "explanation": explanation})
    rows.sort(key=lambda r: abs(r["delta"]), reverse=True)
    return {"as_of": as_of.isoformat(), "period_days": n, "current_month": f"{cur_first:%Y-%m}",
            "prior_month": f"{prev_first:%Y-%m}", "rows": rows,
            "method": {"name": "like_for_like_mom", "note": "same elapsed days in both months"}}
