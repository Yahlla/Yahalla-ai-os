# Stock caddy:2-alpine has no rate-limit module built in, so this builds a
# custom binary with github.com/mholt/caddy-ratelimit via xcaddy -- the
# per-IP rate limiting the load-protection plan calls for, cheap abuse
# protection before requests even reach platform-api.

FROM caddy:2-builder-alpine AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
