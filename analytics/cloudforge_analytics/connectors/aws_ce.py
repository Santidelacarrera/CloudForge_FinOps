"""Read-only AWS Cost Explorer connector.

Produces the same CSV the platform already ingests (``POST /api/v1/cost-imports``), so provider data
goes through identical normalisation, de-duplication and traceability. Credentials never enter the
analytics service: run this with the *analysis* role (see infra/terraform) and upload the CSV.

    python -m cloudforge_analytics.connectors.aws_ce --account 111111111111 --start 2026-09-01 --end 2026-10-01 > ce.csv
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
from datetime import date

ALLOWED_METHODS = frozenset({"get_cost_and_usage"})  # the connector can never call anything else


class ReadOnlyClient:
    """Wraps a boto3 client and exposes only allow-listed read operations."""

    def __init__(self, client):
        self._client = client

    def __getattr__(self, name):
        if name not in ALLOWED_METHODS:
            raise PermissionError(f"{name} is not permitted: the connector is read-only")
        return getattr(self._client, name)


def fetch_pages(client, start: date, end: date, metric: str = "UnblendedCost") -> list[dict]:
    """Daily cost grouped by SERVICE, following NextPageToken. ``end`` is exclusive (AWS semantics)."""
    ro = ReadOnlyClient(client)
    pages, token = [], None
    while True:
        kwargs = {
            "TimePeriod": {"Start": start.isoformat(), "End": end.isoformat()},
            "Granularity": "DAILY", "Metrics": [metric], "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
        }
        if token:
            kwargs["NextPageToken"] = token
        page = ro.get_cost_and_usage(**kwargs)
        pages.append(page)
        token = page.get("NextPageToken")
        if not token:
            return pages


def pages_to_csv(pages: list[dict], account_id: str, metric: str = "UnblendedCost", region: str = "global") -> str:
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["date", "account_id", "project", "service", "region", "environment", "resource_id", "cost", "currency", "tags"])
    for page in pages:
        for day in page.get("ResultsByTime", []):
            d = day["TimePeriod"]["Start"]
            for g in day.get("Groups", []):
                m = g["Metrics"][metric]
                # Cost Explorer has no project/environment/tags in this grouping -> unassigned, flagged untagged downstream.
                w.writerow([d, account_id, "unassigned", g["Keys"][0], region, "unknown", "", m["Amount"], m["Unit"], ""])
    return out.getvalue()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", required=True)
    ap.add_argument("--start", required=True, type=date.fromisoformat)
    ap.add_argument("--end", required=True, type=date.fromisoformat)
    args = ap.parse_args(argv)
    try:
        import boto3  # optional dependency, only needed for live use
    except ImportError:
        print("boto3 is required for live use: pip install boto3", file=sys.stderr)
        return 2
    client = boto3.client("ce", region_name="us-east-1")
    sys.stdout.write(pages_to_csv(fetch_pages(client, args.start, args.end), args.account))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
