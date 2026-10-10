# Build context: repository root (the ledger is read from datasets/).
FROM node:22-slim
WORKDIR /app
COPY providers/localcloud ./providers/localcloud
COPY datasets/sample_billing.csv ./datasets/sample_billing.csv
RUN useradd -r app
USER app
EXPOSE 4010
CMD ["node", "providers/localcloud/server.mjs"]
