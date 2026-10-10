import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloudforge_analytics import ingest  # noqa: E402
from cloudforge_analytics.connectors import aws_ce  # noqa: E402


class FakeCE:
    """Mimics boto3's Cost Explorer client, including pagination."""
    def __init__(self):
        self.calls = []
        self.deleted = False

    def get_cost_and_usage(self, **kw):
        self.calls.append(kw)
        day = lambda d, rows: {"TimePeriod": {"Start": d, "End": d}, "Groups": [  # noqa: E731
            {"Keys": [s], "Metrics": {"UnblendedCost": {"Amount": a, "Unit": u}}} for s, a, u in rows]}
        if "NextPageToken" not in kw:
            return {"ResultsByTime": [day("2026-09-01", [("Amazon EC2", "120.50", "USD"), ("Amazon S3", "27.30", "EUR")])], "NextPageToken": "p2"}
        return {"ResultsByTime": [day("2026-09-02", [("Amazon EC2", "118.00", "USD")])]}

    def delete_volume(self, **kw):  # a write operation the connector must never reach
        self.deleted = True


class Connector(unittest.TestCase):
    def test_paginates_and_normalises_through_the_standard_importer(self):
        fake = FakeCE()
        pages = aws_ce.fetch_pages(fake, date(2026, 9, 1), date(2026, 9, 3))
        self.assertEqual(len(pages), 2)
        self.assertEqual(fake.calls[1]["NextPageToken"], "p2")
        csv_text = aws_ce.pages_to_csv(pages, "111111111111")
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as fh:
            fh.write(csv_text)
        res = ingest.import_csv(fh.name, {"EUR": 1.10})
        Path(fh.name).unlink()
        self.assertEqual(len(res.records), 3)
        self.assertEqual(res.rejected, [])
        s3 = next(r for r in res.records if r.service == "Amazon S3")
        self.assertEqual(str(s3.cost_base), "30.0300")      # 27.30 EUR * 1.10
        self.assertTrue(all(r.untagged for r in res.records))  # no tags in Cost Explorer grouping

    def test_client_is_read_only(self):
        fake = FakeCE()
        with self.assertRaises(PermissionError):
            aws_ce.ReadOnlyClient(fake).delete_volume(VolumeId="vol-1")
        self.assertFalse(fake.deleted)

    def test_reimport_is_deduplicated(self):
        pages = aws_ce.fetch_pages(FakeCE(), date(2026, 9, 1), date(2026, 9, 3))
        text = aws_ce.pages_to_csv(pages, "1") + "\n".join(aws_ce.pages_to_csv(pages, "1").splitlines()[1:]) + "\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as fh:
            fh.write(text)
        res = ingest.import_csv(fh.name, {"EUR": 1.10})
        Path(fh.name).unlink()
        self.assertEqual(len(res.records), 3)
        self.assertEqual(len(res.duplicates), 3)


if __name__ == "__main__":
    unittest.main()
