// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_VERSION = readFileSync(join(ROOT, ".conftest-version"), "utf8").trim();

function readRoot(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

describe("conftest version pin — single source of truth", () => {
  it("the YAML configs define CONFTEST_VERSION matching .conftest-version", () => {
    for (const f of ["presets/security.yaml", "security.config.yaml", "docker/security.config.yaml"]) {
      const text = readRoot(f);
      expect(text, f).toContain(`CONFTEST_VERSION=${CANONICAL_VERSION}`);
      expect(text, `${f} should not have a hardcoded version in the curl URL`).not.toMatch(
        /releases\/download\/v\d+\.\d+\.\d+\/conftest_\d+\.\d+\.\d+_/,
      );
    }
  });

  it("the Dockerfiles read the version from .conftest-version, not a hardcoded ARG", () => {
    for (const f of ["Dockerfile", ".devcontainer/Dockerfile"]) {
      const text = readRoot(f);
      expect(text, f).toContain("cat .conftest-version");
      expect(text, `${f} should not have a hardcoded ARG CONFTEST_VERSION`).not.toMatch(
        /ARG\s+CONFTEST_VERSION\s*=\s*\d+\.\d+\.\d+/,
      );
    }
  });

  it("the .devcontainer comment mentions the right version", () => {
    const text = readRoot(".devcontainer/devcontainer.json");
    expect(text).toContain(CANONICAL_VERSION);
  });
});
