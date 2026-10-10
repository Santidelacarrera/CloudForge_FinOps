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


if __name__ == "__main__":
    unittest.main()
