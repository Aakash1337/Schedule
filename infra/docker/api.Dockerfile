FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @schedule/api deploy --prod --legacy /runtime

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 schedule \
  && useradd --system --uid 10001 --gid schedule --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin schedule
COPY --from=build /runtime /app
USER 10001:10001
EXPOSE 4000
CMD ["node", "dist/server.js"]
