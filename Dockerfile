# Supermortgage runtime image — one image, three modes (see src/runtime/main.ts):
#   docker run IMAGE serve | sweep | migrate
# Node 22 runs the TypeScript sources directly (type stripping); psql is present for db/migrate.sh.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY spec/registry ./spec/registry
COPY db ./db
COPY src ./src
RUN chmod +x db/migrate.sh && chown -R node:node /app

USER node
ENV HOST=0.0.0.0 PORT=8080 LOG_FORMAT=json INTEGRATIONS=fake
EXPOSE 8080

ENTRYPOINT ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/runtime/main.ts"]
CMD ["serve"]
