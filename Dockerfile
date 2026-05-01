# syntax=docker/dockerfile:1.7
#
# Generic security MCP server, packaged as a stdio container.
#
# Designed to be launched by an MCP client like:
#   docker run -i --rm \
#     -v /path/to/acme-security-repo:/data/security:ro \
#     security-mcp:latest
#
# stdin/stdout carry the MCP JSON-RPC framing. No ports exposed.

FROM node:20-slim AS deps
WORKDIR /build
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev


FROM node:20-slim AS build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY src ./src
RUN npx tsc


FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    SECURITY_MCP_CONFIG=/etc/security-mcp/config.yaml

# conftest — bundled so tool_registry(invoke, name=conftest, …) works
# without needing it on the host. Users who don't need conftest can pass a
# different config and ignore it.
ARG CONFTEST_VERSION=0.56.0
RUN apt-get update \
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

# stdio MCP — no EXPOSE, no HEALTHCHECK, no entrypoint shell.
CMD ["node", "dist/index.js"]
