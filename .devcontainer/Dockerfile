# syntax=docker/dockerfile:1.7
# Dev container for security-mcp.
#
# Bakes conftest into the image so it's ready on first attach (the
# `tool_registry(invoke, name=conftest, …)` happy path works without a
# postCreateCommand wait).
FROM mcr.microsoft.com/devcontainers/typescript-node:20

COPY .conftest-version .conftest-version
RUN set -eux; \
    CONFTEST_VERSION="$(cat .conftest-version)"; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) conftest_arch=arm64 ;; \
      amd64) conftest_arch=x86_64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/conftest.tgz \
      "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_${conftest_arch}.tar.gz"; \
    tar -xzf /tmp/conftest.tgz -C /usr/local/bin conftest; \
    chmod +x /usr/local/bin/conftest; \
    rm /tmp/conftest.tgz
