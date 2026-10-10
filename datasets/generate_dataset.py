#!/usr/bin/env python3
"""Deterministic synthetic billing dataset with controlled anomalies.

Writes sample_billing.csv and ground_truth.json (the anomalies that were injected).
"""
import csv
import json
import random
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).parent
START, DAYS = date(2026, 8, 1), 61  # Aug 1 .. Sep 30
random.seed(42)

SERVICES = {  # service: (base daily USD, project, env, region)
    "Compute": (120, "checkout", "prod", "region-a"),
    "Database": (80, "checkout", "prod", "region-a"),
    "ObjectStorage": (30, "data-lake", "prod", "region-b"),
    "Functions": (15, "notifications", "dev", "region-a"),
    "Monitoring": (12, "platform", "prod", "region-a"),
}
INJECTED = [
    {"series": "Compute", "date": "2026-09-12", "kind": "spike", "factor": 3.0,
     "note": "autoscaling runaway"},
    {"series": "ObjectStorage", "date": "2026-09-20", "kind": "spike", "factor": 4.0,
     "note": "unexpected cross-region replication"},
]
EUR_SERVICE = "ObjectStorage"  # billed in EUR (rate 1.10 USD/EUR)


def main():
    rows = []
    for i in range(DAYS):
        d = START + timedelta(days=i)
        for svc, (base, proj, env, region) in SERVICES.items():
            cost = base * random.uniform(0.92, 1.08)
            for inj in INJECTED:
                if inj["series"] == svc and inj["date"] == d.isoformat():
                    cost = base * inj["factor"]
            cur = "EUR" if svc == EUR_SERVICE else "USD"
            if cur == "EUR":
                cost /= 1.10
            owner = "" if svc == "Functions" else "owner=team-" + proj  # Functions is untagged
            rows.append([d.isoformat(), "111111111111", proj, svc, region, env,
                         f"{svc.lower()}-main", f"{cost:.2f}", cur, owner])
        # orphaned volumes: small, steady, untagged
        rows.append([d.isoformat(), "111111111111", "unassigned", "BlockStorage", "region-a", "unknown",
                     "vol-0orphan01", "4.80", "USD", ""])
    rows.append(rows[40][:])  # exact duplicate
    rows.append(["2026-09-05", "111111111111", "x", "Compute", "region-a", "prod", "i-x", "abc", "USD", ""])  # bad cost
    rows.append(["2026-09-05", "111111111111", "x", "Compute", "region-a", "prod", "i-y", "9.00", "JPY", ""])  # unknown cur
    with open(OUT / "sample_billing.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "account_id", "project", "service", "region", "environment",
                    "resource_id", "cost", "currency", "tags"])
        w.writerows(rows)
    (OUT / "ground_truth.json").write_text(json.dumps({
        "injected_anomalies": INJECTED, "expected_duplicates": 1, "expected_rejected": 2,
        "fx_rates": {"EUR": 1.10, "USD": 1.0}, "orphan_resource": "vol-0orphan01"}, indent=2) + "\n")
    print(f"wrote {len(rows)} rows")


if __name__ == "__main__":
    main()
