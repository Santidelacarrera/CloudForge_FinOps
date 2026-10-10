import json
import sys
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "analytics"))
from cloudforge_analytics import anomaly, budget, forecast, ingest  # noqa: E402

CSV = ROOT / "datasets" / "sample_billing.csv"
TRUTH = json.loads((ROOT / "datasets" / "ground_truth.json").read_text())
RATES = TRUTH["fx_rates"]


class Ingest(unittest.TestCase):
    def setUp(self):
        self.res = ingest.import_csv(str(CSV), RATES)

    def test_rejects_and_duplicates_reported(self):
        self.assertEqual(len(self.res.rejected), TRUTH["expected_rejected"])
        self.assertEqual(len(self.res.duplicates), TRUTH["expected_duplicates"])
        reasons = {r["reason"] for r in self.res.rejected}
        self.assertIn("invalid cost", reasons)
        self.assertTrue(any("unknown currency" in r for r in reasons))

    def test_mixed_currency_converted(self):
        eur = [r for r in self.res.records if r.currency == "EUR"][0]
        self.assertEqual(eur.cost_base, (eur.cost * Decimal("1.10")).quantize(Decimal("0.0001")))

    def test_total_is_traceable_to_source_rows(self):
        s = ingest.summarize(self.res.records, "service")
        by_id = {r.record_id: r for r in self.res.records}
        for g in s["groups"]:
            recomputed = sum(by_id[i].cost_base for i in g["record_ids"])
            self.assertEqual(str(recomputed), g["total"])
            self.assertEqual(len(g["source_lines"]), g["record_count"])
        grand = sum(Decimal(g["total"]) for g in s["groups"])
        self.assertEqual(grand, sum(r.cost_base for r in self.res.records))

    def test_untagged_resources_flagged(self):
        orphans = [r for r in self.res.records if r.resource_id == TRUTH["orphan_resource"]]
        self.assertTrue(orphans and all(r.untagged for r in orphans))

    def test_missing_columns_raise(self):
        p = ROOT / "analytics" / "tests" / "_bad.csv"
        p.write_text("date,cost\n2026-01-01,1\n")
        try:
            with self.assertRaises(ValueError):
                ingest.import_csv(str(p), RATES)
        finally:
            p.unlink()

    def test_bad_group_by(self):
        with self.assertRaises(ValueError):
            ingest.summarize(self.res.records, "password")


class Anomalies(unittest.TestCase):
    def test_detects_exactly_injected_anomalies(self):
        res = ingest.import_csv(str(CSV), RATES)
        found = anomaly.detect_all(ingest.daily_series(res.records, "service"))
        got = {(a["series"], a["date"]) for a in found}
        want = {(i["series"], i["date"]) for i in TRUTH["injected_anomalies"]}
        self.assertEqual(got, want)
        self.assertEqual(found[0]["method"]["name"], anomaly.METHOD)

    def test_flat_series_no_false_positive(self):
        s = {date(2026, 1, d): Decimal(100) for d in range(1, 29)}
        self.assertEqual(anomaly.detect(s), [])


class Forecast(unittest.TestCase):
    def setUp(self):
        res = ingest.import_csv(str(CSV), RATES)
        self.total = {}
        for r in res.records:
            self.total[r.date] = self.total.get(r.date, 0) + r.cost_base

    def test_forecast_explains_itself(self):
        f = forecast.forecast_month_end(self.total, date(2026, 9, 15), budget=9000)
        lo, hi = f["interval_95"]
        self.assertLess(lo, f["point_estimate"])
        self.assertGreater(hi, f["point_estimate"])
        self.assertTrue(f["assumptions"] and f["method"]["name"] == forecast.METHOD)
        self.assertEqual(f["remaining_days"], 15)

    def test_end_of_month_has_no_uncertainty(self):
        f = forecast.forecast_month_end(self.total, date(2026, 9, 30))
        self.assertEqual(f["interval_95"][0], f["interval_95"][1])
        self.assertEqual(f["point_estimate"], f["month_to_date"])

    def test_insufficient_history(self):
        with self.assertRaises(ValueError):
            forecast.forecast_month_end({date(2026, 9, 1): 1}, date(2026, 9, 1))


class Budget(unittest.TestCase):
    def test_thresholds(self):
        ev = budget.threshold_events(85, 100)
        self.assertEqual([e["threshold"] for e in ev], [0.5, 0.8])


if __name__ == "__main__":
    unittest.main()
