"""Robust, explainable anomaly detection (rolling median / MAD)."""
from __future__ import annotations

from datetime import date, timedelta
from statistics import median

METHOD = "rolling_median_mad"
MAD_SCALE = 1.4826  # makes MAD comparable to a standard deviation for normal data


def detect(series: dict[date, "Decimal"], window: int = 14, threshold: float = 3.5,
           min_abs_delta: float = 10.0, min_history: int = 7) -> list[dict]:
    """Flag days whose cost deviates from the median of the previous ``window`` days.

    A point is anomalous when the robust z-score exceeds ``threshold`` AND the
    absolute deviation exceeds ``min_abs_delta`` (avoids noise on tiny series).
    Flagged days are excluded from later baselines so a multi-day incident does
    not hide itself.
    """
    days = sorted(series)
    clean: dict[date, float] = {}
    found = []
    for d in days:
        value = float(series[d])
        hist = [clean[d - timedelta(days=i)] for i in range(1, window + 1)
                if (d - timedelta(days=i)) in clean]
        if len(hist) < min_history:
            clean[d] = value
            continue
        base = median(hist)
        mad = median(abs(h - base) for h in hist) * MAD_SCALE
        mad = max(mad, 0.05 * abs(base), 1e-9)  # floor: avoid division by ~0 on flat series
        z = (value - base) / mad
        delta = value - base
        if abs(z) >= threshold and abs(delta) >= min_abs_delta:
            found.append({
                "date": d.isoformat(), "observed": round(value, 2), "expected": round(base, 2),
                "delta": round(delta, 2), "robust_z": round(z, 2),
                "direction": "spike" if delta > 0 else "drop",
                "explanation": (f"cost {value:.2f} vs median {base:.2f} of previous {len(hist)} days "
                                f"(robust z={z:.1f}, threshold {threshold})"),
                "method": {"name": METHOD, "window_days": window, "threshold": threshold,
                           "min_abs_delta": min_abs_delta, "baseline_points": len(hist)},
            })
        else:
            clean[d] = value
    return found


def detect_all(series_by_key: dict[str, dict], **kw) -> list[dict]:
    out = []
    for key, s in series_by_key.items():
        for a in detect(s, **kw):
            a["series"] = key
            out.append(a)
    return sorted(out, key=lambda a: (a["date"], a["series"]))
