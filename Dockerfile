# syntax=docker/dockerfile:1.7
#
# Generic security MCP server. Speaks two transports:
#
#   stdio (default) — launched by an MCP client over stdin/stdout:
#     docker run -i --rm \
#       -v /path/to/security-repo:/data/security:ro \
#       security-mcp:latest
#
#   http (opt-in)   — Streamable HTTP on :8080 for shared deploys:
#     docker run --rm -p 8080:8080 \
#       -e MCP_TRANSPORT=http \
#       security-mcp:latest

FROM node:25-slim AS deps
WORKDIR /build
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev


FROM node:25-slim AS build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY src ./src
RUN npx tsc


FROM node:25-slim AS runtime

ENV NODE_ENV=production \
    SECURITY_MCP_CONFIG=/etc/security-mcp/config.yaml

# conftest — bundled so tool_registry(invoke, name=conftest, …) works
# without needing it on the host. Users who don't need conftest can pass a
# different config and ignore it. Version is read from .conftest-version
# (single source of truth for the whole repo).
COPY .conftest-version .conftest-version
RUN CONFTEST_VERSION="$(cat .conftest-version)" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && case "$(dpkg --print-architecture)" in \
      arm64) CONFTEST_ARCH=arm64 ;; \
      amd64) CONFTEST_ARCH=x86_64 ;; \
      *) echo "unsupported arch" && exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/conftest.tgz \
      "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_${CONFTEST_ARCH}.tar.gz" \
 && tar -xzf /tmp/conftest.tgz -C /usr/local/bin conftest \
 && chmod +x /usr/local/bin/conftest \
 && rm /tmp/conftest.tgz \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/security-mcp

COPY --from=deps  /build/node_modules ./node_modules
COPY --from=build /build/dist         ./dist
COPY package.json ./

# Container-default config. Expects the security repo at /data/security.
COPY docker/security.config.yaml /etc/security-mcp/config.yaml

# Non-root.
RUN groupadd -g 10001 mcp \
 && useradd -u 10001 -g mcp -s /usr/sbin/nologin -M mcp
USER 10001:10001

# Documented for the http transport; harmless when running stdio
# (the server doesn't bind a port unless MCP_TRANSPORT=http).
EXPOSE 8080

CMD ["node", "dist/index.js"]
