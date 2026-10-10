"""Optional FastAPI wrapper (``pip install fastapi uvicorn``); the core has no dependencies."""
from __future__ import annotations

from datetime import date

from . import anomaly, forecast, ingest

try:
    from fastapi import FastAPI, HTTPException
except ImportError:  # pragma: no cover
    FastAPI = None


def create_app(csv_path: str, rates: dict):
    if FastAPI is None:
        raise RuntimeError("fastapi is not installed")
    app = FastAPI(title="CloudForge Analytics")
    result = ingest.import_csv(csv_path, rates)

    @app.get("/api/v1/costs/summary")
    def summary(group_by: str = "service"):
        try:
            return ingest.summarize(result.records, group_by)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/v1/anomalies")
    def anomalies(key: str = "service"):
        return anomaly.detect_all(ingest.daily_series(result.records, key))

    @app.get("/api/v1/forecasts")
    def forecasts(as_of: date, budget: float | None = None):
        total: dict = {}
        for r in result.records:
            total[r.date] = total.get(r.date, 0) + r.cost_base
        try:
            return forecast.forecast_month_end(total, as_of, budget=budget)
        except ValueError as e:
            raise HTTPException(400, str(e))

    return app
