"""CSV ingestion and normalisation of cloud billing data.

Every normalised record keeps ``source_file`` and ``source_line`` so any total
can be traced back to the rows that produced it.
"""
from __future__ import annotations

import csv
import hashlib
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Iterable

REQUIRED_COLUMNS = ("date", "account_id", "service", "cost", "currency")
REQUIRED_TAGS = ("owner",)
GROUP_FIELDS = ("account_id", "project", "service", "region", "environment", "currency")


@dataclass(frozen=True)
class CostRecord:
    record_id: str
    date: date
    account_id: str
    project: str
    service: str
    region: str
    environment: str
    resource_id: str
    cost: Decimal            # in original currency
    currency: str
    cost_base: Decimal       # converted to base currency
    tags: dict = field(default_factory=dict, hash=False, compare=False)
    untagged: bool = False
    source_file: str = ""
    source_line: int = 0


@dataclass
class ImportResult:
    records: list[CostRecord]
    rejected: list[dict]     # {"line": int, "reason": str}
    duplicates: list[dict]   # {"line": int, "duplicate_of": str}
    base_currency: str


def parse_tags(raw: str) -> dict:
    tags = {}
    for part in (raw or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip():
                tags[k.strip().lower()] = v.strip()
    return tags


def _record_id(row: dict) -> str:
    key = "|".join(str(row.get(k, "")).strip() for k in
                   ("date", "account_id", "service", "region", "resource_id", "cost", "currency"))
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def import_csv(path: str, rates: dict[str, Decimal | str | float], base_currency: str = "USD") -> ImportResult:
    """Import a billing CSV. ``rates`` maps currency -> units of base currency.

    Rows with unknown currency, bad dates/amounts or missing columns are
    rejected (never silently dropped). Exact duplicates are reported and skipped.
    """
    fx = {k.upper(): Decimal(str(v)) for k, v in rates.items()}
    fx.setdefault(base_currency.upper(), Decimal(1))
    records: list[CostRecord] = []
    rejected: list[dict] = []
    duplicates: list[dict] = []
    seen: dict[str, int] = {}

    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"CSV missing required columns: {missing}")
        for row in reader:
            line = reader.line_num
            try:
                d = date.fromisoformat((row["date"] or "").strip())
            except ValueError:
                rejected.append({"line": line, "reason": "invalid date"})
                continue
            try:
                cost = Decimal((row["cost"] or "").strip())
                if not cost.is_finite():
                    raise InvalidOperation
            except InvalidOperation:
                rejected.append({"line": line, "reason": "invalid cost"})
                continue
            cur = (row["currency"] or "").strip().upper()
            if cur not in fx:
                rejected.append({"line": line, "reason": f"unknown currency {cur!r}"})
                continue
            if not (row["account_id"] or "").strip() or not (row["service"] or "").strip():
                rejected.append({"line": line, "reason": "missing account_id/service"})
                continue
            rid = _record_id(row)
            if rid in seen:
                duplicates.append({"line": line, "duplicate_of": rid, "first_line": seen[rid]})
                continue
            seen[rid] = line
            tags = parse_tags(row.get("tags", ""))
            records.append(CostRecord(
                record_id=rid, date=d,
                account_id=row["account_id"].strip(),
                project=(row.get("project") or "unassigned").strip() or "unassigned",
                service=row["service"].strip(),
                region=(row.get("region") or "global").strip() or "global",
                environment=(row.get("environment") or tags.get("env", "unknown")).strip() or "unknown",
                resource_id=(row.get("resource_id") or "").strip(),
                cost=cost, currency=cur, cost_base=(cost * fx[cur]).quantize(Decimal("0.0001")),
                tags=tags, untagged=any(t not in tags for t in REQUIRED_TAGS),
                source_file=path, source_line=line,
            ))
    return ImportResult(records, rejected, duplicates, base_currency.upper())


def summarize(records: Iterable[CostRecord], group_by: str = "service") -> dict:
    """Totals per group, each carrying the ids and source lines of its records."""
    if group_by not in GROUP_FIELDS and group_by != "untagged":
        raise ValueError(f"unsupported group_by {group_by!r}")
    groups: dict[str, dict] = {}
    for r in records:
        key = str(r.untagged) if group_by == "untagged" else getattr(r, group_by)
        g = groups.setdefault(key, {"group": key, "total": Decimal(0), "record_ids": [], "source_lines": []})
        g["total"] += r.cost_base
        g["record_ids"].append(r.record_id)
        g["source_lines"].append(r.source_line)
    out = sorted(groups.values(), key=lambda g: g["total"], reverse=True)
    for g in out:
        g["total"] = str(g["total"])
        g["record_count"] = len(g["record_ids"])
    return {"group_by": group_by, "groups": out}


def daily_series(records: Iterable[CostRecord], key: str = "service") -> dict[str, dict[date, Decimal]]:
    series: dict[str, dict[date, Decimal]] = {}
    for r in records:
        s = series.setdefault(getattr(r, key), {})
        s[r.date] = s.get(r.date, Decimal(0)) + r.cost_base
    return series
