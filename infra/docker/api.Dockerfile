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
COPY --from=build /runtime /app
EXPOSE 4000
CMD ["node", "dist/server.js"]
