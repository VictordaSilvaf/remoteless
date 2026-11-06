FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/local-api/package.json ./apps/local-api/package.json
COPY apps/group-runner/package.json ./apps/group-runner/package.json
COPY apps/session-lab/package.json ./apps/session-lab/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
COPY packages/database/package.json ./packages/database/package.json
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/desktop/package.json ./apps/desktop/package.json
COPY --from=build /app/apps/local-api/package.json ./apps/local-api/package.json
COPY --from=build /app/apps/group-runner/package.json ./apps/group-runner/package.json
COPY --from=build /app/apps/session-lab/package.json ./apps/session-lab/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/crypto/package.json ./packages/crypto/package.json
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /proxy /run/msm/lab /state /artifacts && chown node:node /proxy /run/msm/lab /state /artifacts
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/scripts/dist ./scripts/dist
COPY --from=build /app/infra/docker ./infra/docker
USER node
ENTRYPOINT ["node"]
CMD ["apps/local-api/dist/index.js"]

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS runner
WORKDIR /app
COPY --from=runtime /app /app
RUN mkdir -p /proxy /run/msm/lab /state /artifacts && chown 1000:1000 /proxy /run/msm/lab /state /artifacts
USER 1000:1000
ENTRYPOINT ["node"]
CMD ["apps/group-runner/dist/index.js"]

FROM dependencies AS electron-download
RUN node node_modules/electron/install.js

FROM runner AS desktop-check
COPY --link --from=electron-download /app/node_modules/electron/dist /opt/electron
ENTRYPOINT ["xvfb-run", "-a", "node"]
CMD ["apps/session-lab/dist/electron-verify.js"]
