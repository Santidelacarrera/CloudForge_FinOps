FROM python:3.12-slim
WORKDIR /app
COPY analytics/requirements.txt .
RUN pip install --no-cache-dir fastapi uvicorn
COPY analytics/cloudforge_analytics ./cloudforge_analytics
RUN useradd -r app && chown -R app /app
USER app
EXPOSE 8000
CMD ["uvicorn", "cloudforge_analytics.api:app", "--host", "0.0.0.0", "--port", "8000"]
