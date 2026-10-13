import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "analytics"))
from fastapi.testclient import TestClient  # noqa: E402
from cloudforge_analytics.api import app  # noqa: E402

CSV = (ROOT / "datasets" / "sample_billing.csv").read_text()
TRUTH = json.loads((ROOT / "datasets" / "ground_truth.json").read_text())
client = TestClient(app)


class Api(unittest.TestCase):
    def test_ingest_matches_ground_truth(self):
        r = client.post("/v1/ingest", json={"csv": CSV, "rates": TRUTH["fx_rates"]})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(len(body["rejected"]), TRUTH["expected_rejected"])
        self.assertEqual(len(body["duplicates"]), TRUTH["expected_duplicates"])
        self.assertTrue(all("source_line" in x for x in body["records"]))

    def test_ingest_bad_csv_422(self):
        r = client.post("/v1/ingest", json={"csv": "a,b\n1,2\n", "rates": {}})
        self.assertEqual(r.status_code, 422)

    def test_anomalies_roundtrip(self):
        recs = client.post("/v1/ingest", json={"csv": CSV, "rates": TRUTH["fx_rates"]}).json()["records"]
        series = {}
        for x in recs:
            series.setdefault(x["service"], {}).setdefault(x["date"], 0)
            series[x["service"]][x["date"]] += float(x["cost_base"])
        found = client.post("/v1/anomalies", json={"series": series}).json()
        self.assertEqual({(a["series"], a["date"]) for a in found},
                         {(i["series"], i["date"]) for i in TRUTH["injected_anomalies"]})

    def test_forecast_validation(self):
        r = client.post("/v1/forecast", json={"series": {"2026-09-01": 10}, "as_of": "2026-09-01"})
        self.assertEqual(r.status_code, 422)
        r = client.post("/v1/forecast", json={"series": {"2026-09-01": 10}, "as_of": "2026-09-01", "budget": -5})
        self.assertEqual(r.status_code, 422)

    def test_budget_status_and_validation(self):
        series = {f"2026-09-{d:02d}": 80.0 for d in range(1, 16)}
        r = client.post("/v1/budget-status", json={"series": series, "amount": 2000, "as_of": "2026-09-15"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "at_risk")
        for bad in ({"amount": 0}, {"amount": -1}, {"thresholds": [0]}, {"thresholds": [11]}):
            body = {"series": series, "amount": 2000, "as_of": "2026-09-15", **bad}
            self.assertEqual(client.post("/v1/budget-status", json=body).status_code, 422, bad)

    def test_variance_endpoint(self):
        body = {"series": {"x": {"2026-08-01": 1.0, "2026-09-01": 3.0}}, "as_of": "2026-09-10"}
        r = client.post("/v1/variance", json=body)
        self.assertEqual(r.json()["rows"][0]["delta"], 2.0)


if __name__ == "__main__":
    unittest.main()
