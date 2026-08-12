# The only container on the VPS allowed to run "git" and "docker compose"
# against the live stack (see src/deploy.ts). It needs those two CLIs
# installed, plus the host's Docker socket and the actual repo checkout
# bind-mounted in at runtime (wired in platform/docker-compose.yml) so
# "docker compose up" here really redeploys the host stack, not some
# throwaway nested Docker-in-Docker environment.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/src/index.js"]
