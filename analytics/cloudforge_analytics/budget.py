from __future__ import annotations


def threshold_events(spent: float, budget: float, thresholds=(0.5, 0.8, 1.0)) -> list[dict]:
    """Return the budget thresholds crossed by ``spent`` (event feed for workflow triggers)."""
    if budget <= 0:
        raise ValueError("budget must be positive")
    pct = spent / budget
    return [{"type": "budget_threshold", "threshold": t, "spent": round(spent, 2),
             "budget": budget, "pct": round(100 * pct, 1)} for t in thresholds if pct >= t]
