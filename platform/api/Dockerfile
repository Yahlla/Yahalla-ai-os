# Multi-tenant coordination service. Never runs LLM inference -- see the
# package.json description. Built as a small multi-stage image on purpose:
# a "moderate" Strato VPS has to run this plus postgres/deploy-agent/caddy
# side by side.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]
