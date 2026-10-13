"""Cost model tests on the synthetic dataset. Expectations are re-derived from raw CSV rows,
not from the functions under test."""
import csv
import json
import sys
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "analytics"))
from cloudforge_analytics import budget, ingest, variance  # noqa: E402

CSV = ROOT / "datasets" / "sample_billing.csv"
TRUTH = json.loads((ROOT / "datasets" / "ground_truth.json").read_text())
BUDGETS = json.loads((ROOT / "datasets" / "budgets.json").read_text())["budgets"]
RATES = {k: Decimal(str(v)) for k, v in TRUTH["fx_rates"].items()}


def raw_daily(service=None):
    """Independent aggregation straight from the CSV (skips rejected/duplicate rows by construction)."""
    seen, out = set(), {}
    with open(CSV, newline="") as fh:
        for row in csv.DictReader(fh):
            key = tuple(row.values())
            if key in seen:
                continue
            seen.add(key)
            try:
                d = date.fromisoformat(row["date"])
                cost = Decimal(row["cost"])
            except (ValueError, ArithmeticError):  # rejected rows (bad date/amount) are skipped on purpose
                continue
            if row["currency"] not in RATES or (service and row["service"] != service):
                continue
            out[d] = out.get(d, Decimal(0)) + cost * RATES[row["currency"]]
    return out


class BudgetModel(unittest.TestCase):
    def setUp(self):
        res = ingest.import_csv(str(CSV), TRUTH["fx_rates"])
        self.records = res.records

    def series(self, service):
        return ingest.daily_series([r for r in self.records if r.service == service], "service")[service]

    def test_threshold_events_are_cumulative_and_validated(self):
        self.assertEqual([e["threshold"] for e in budget.threshold_events(49, 100)], [])
        self.assertEqual([e["threshold"] for e in budget.threshold_events(80, 100)], [0.5, 0.8])
        self.assertEqual([e["threshold"] for e in budget.threshold_events(130, 100)], [0.5, 0.8, 1.0])
        with self.assertRaises(ValueError):
            budget.threshold_events(1, 0)

    def test_mtd_matches_independent_sum(self):
        s = self.series("Database")
        res = budget.evaluate(s, 2000, date(2026, 9, 15))
        expected = sum(v for d, v in raw_daily("Database").items() if date(2026, 9, 1) <= d <= date(2026, 9, 15))
        self.assertAlmostEqual(res["month_to_date"], float(expected), places=1)

    def test_status_by_scope_mid_month(self):
        as_of = date(2026, 9, 15)
        got = {b["scope_value"] or "total": budget.evaluate(
            self.series(b["scope_value"]) if b["scope_type"] == "service" else
            {d: v for d, v in raw_daily().items()}, b["amount"], as_of)["status"] for b in BUDGETS}
        # Database spends ~80/day = ~2400/month against 2000 -> projected overrun while not yet exceeded
        self.assertEqual(got["Database"], "at_risk")
        # Compute includes a 3x spike on day 12 and still projects above 3500
        self.assertEqual(got["Compute"], "at_risk")
        self.assertEqual(got["ObjectStorage"], "ok")
        self.assertEqual(got["Functions"], "ok")
        self.assertEqual(got["total"], "ok")

    def test_exceeded_at_month_end_and_events(self):
        res = budget.evaluate(self.series("Database"), 2000, date(2026, 9, 30))
        self.assertEqual(res["status"], "exceeded")
        self.assertEqual([e["threshold"] for e in res["events"]], [0.5, 0.8, 1.0])
        self.assertGreater(res["pct_spent"], 100)

    def test_output_explains_itself(self):
        res = budget.evaluate(self.series("Functions"), 600, date(2026, 9, 15))
        self.assertTrue(res["assumptions"])
        self.assertEqual(res["method"]["name"], "trailing_mean_normal_interval")
        self.assertEqual(len(res["interval_95"]), 2)

    def test_invalid_amount(self):
        with self.assertRaises(ValueError):
            budget.evaluate(self.series("Functions"), 0, date(2026, 9, 15))


class Variance(unittest.TestCase):
    def setUp(self):
        res = ingest.import_csv(str(CSV), TRUTH["fx_rates"])
        self.by_service = ingest.daily_series(res.records, "service")

    def test_like_for_like_against_independent_sums(self):
        v = variance.mom_variance(self.by_service, date(2026, 9, 25))
        self.assertEqual((v["current_month"], v["prior_month"], v["period_days"]), ("2026-09", "2026-08", 25))
        row = next(r for r in v["rows"] if r["series"] == "ObjectStorage")
        raw = raw_daily("ObjectStorage")
        cur = sum(x for d, x in raw.items() if date(2026, 9, 1) <= d <= date(2026, 9, 25))
        prior = sum(x for d, x in raw.items() if date(2026, 8, 1) <= d <= date(2026, 8, 25))
        self.assertAlmostEqual(row["current"], float(cur), places=1)
        self.assertAlmostEqual(row["prior"], float(prior), places=1)
        self.assertEqual(row["prior_truncated"], False)
        # the injected spike on 2026-09-20 makes ObjectStorage the clearest riser in percentage terms
        self.assertGreater(row["pct"], 5)

    def test_sorted_by_absolute_change_and_zero_prior(self):
        series = {"new": {date(2026, 9, 3): 10.0}, "flat": {date(2026, 8, 3): 5.0, date(2026, 9, 3): 5.0}}
        v = variance.mom_variance(series, date(2026, 9, 10))
        self.assertEqual(v["rows"][0]["series"], "new")
        self.assertIsNone(v["rows"][0]["pct"])

    def test_prior_month_shorter_is_flagged(self):
        v = variance.mom_variance({"a": {date(2026, 2, 28): 1.0, date(2026, 3, 31): 2.0}}, date(2026, 3, 31))
        self.assertTrue(v["rows"][0]["prior_truncated"])

    def test_january_uses_previous_december(self):
        v = variance.mom_variance({"a": {date(2025, 12, 1): 4.0, date(2026, 1, 1): 6.0}}, date(2026, 1, 5))
        self.assertEqual(v["prior_month"], "2025-12")
        self.assertEqual(v["rows"][0]["delta"], 2.0)


if __name__ == "__main__":
    unittest.main()
