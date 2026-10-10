# Build context is the repository root (the API depends on ../engine).
FROM node:22-slim AS build
WORKDIR /app
COPY engine ./engine
COPY api ./api
RUN cd engine && npm install --omit=dev && cd ../api && npm install && npm run build
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/engine ./engine
COPY --from=build /app/api ./api
RUN cd api && npm prune --omit=dev && useradd -r app
USER app
WORKDIR /app/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
