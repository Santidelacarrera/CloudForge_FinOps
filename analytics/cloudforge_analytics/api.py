"""Stateless FastAPI compute service. Persistence and tenancy live in the NestJS control plane;
this service never sees credentials and stores nothing."""
from __future__ import annotations

import os
import tempfile
from datetime import date
from decimal import Decimal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import anomaly, budget, forecast, ingest, variance

MAX_CSV_BYTES = 20 * 1024 * 1024
app = FastAPI(title="CloudForge Analytics", version="0.1.0")


class IngestRequest(BaseModel):
    csv: str = Field(max_length=MAX_CSV_BYTES)
    rates: dict[str, float] = Field(default_factory=dict)
    base_currency: str = "USD"


class SeriesRequest(BaseModel):
    series: dict[str, dict[date, float]]  # key -> {date: cost}
    window: int = Field(14, ge=3, le=90)
    threshold: float = Field(3.5, gt=0)
    min_abs_delta: float = Field(10.0, ge=0)


class ForecastRequest(BaseModel):
    series: dict[date, float]
    as_of: date
    window: int = Field(14, ge=3, le=90)
    budget: float | None = Field(None, gt=0)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/v1/ingest")
def ingest_csv(req: IngestRequest):
    # The csv module needs a file path in our importer; use a private temp file.
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8", newline="") as fh:
        fh.write(req.csv)
        path = fh.name
    try:
        res = ingest.import_csv(path, req.rates, req.base_currency)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    finally:
        os.unlink(path)
    return {
        "base_currency": res.base_currency,
        "records": [{
            "record_id": r.record_id, "date": r.date.isoformat(), "account_id": r.account_id,
            "project": r.project, "service": r.service, "region": r.region, "environment": r.environment,
            "resource_id": r.resource_id, "cost": str(r.cost), "currency": r.currency,
            "cost_base": str(r.cost_base), "tags": r.tags, "untagged": r.untagged, "source_line": r.source_line,
        } for r in res.records],
        "rejected": res.rejected, "duplicates": res.duplicates,
    }


@app.post("/v1/anomalies")
def anomalies(req: SeriesRequest):
    series = {k: {d: Decimal(str(v)) for d, v in s.items()} for k, s in req.series.items()}
    return anomaly.detect_all(series, window=req.window, threshold=req.threshold, min_abs_delta=req.min_abs_delta)


@app.post("/v1/forecast")
def forecast_endpoint(req: ForecastRequest):
    try:
        return forecast.forecast_month_end({d: Decimal(str(v)) for d, v in req.series.items()},
                                           req.as_of, window=req.window, budget=req.budget)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class BudgetStatusRequest(BaseModel):
    series: dict[date, float]            # daily series already restricted to the budget's scope
    amount: float = Field(gt=0)
    as_of: date
    window: int = Field(14, ge=3, le=90)
    thresholds: list[float] = Field(default_factory=lambda: list(budget.DEFAULT_THRESHOLDS), max_length=10)


@app.post("/v1/budget-status")
def budget_status(req: BudgetStatusRequest):
    if any(t <= 0 or t > 10 for t in req.thresholds):
        raise HTTPException(422, "thresholds must be in (0, 10]")
    try:
        return budget.evaluate({d: Decimal(str(v)) for d, v in req.series.items()}, req.amount, req.as_of,
                               window=req.window, thresholds=tuple(req.thresholds))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class VarianceRequest(BaseModel):
    series: dict[str, dict[date, float]]
    as_of: date


@app.post("/v1/variance")
def variance_endpoint(req: VarianceRequest):
    return variance.mom_variance(req.series, req.as_of)
