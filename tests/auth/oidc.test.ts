// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from "jose";
import { buildHttpApp } from "../../src/server.js";
import type { LoadedConfig } from "../../src/config.js";
import { InlineToolSource } from "../../src/sources/command.js";
import { _clearJwksCache } from "../../src/auth/oidc.js";

// Stand up a stub OIDC issuer: publishes /.well-known/openid-configuration
// + /jwks. Mint tokens locally with the matching private key.

const ISSUER_HOST = "127.0.0.1";
const AUDIENCE = "test-audience";
const originalLogLevel = process.env.LOG_LEVEL;

let issuerServer: Server;
let issuerUrl: string;
let mcpServer: Server;
let mcpBaseUrl: string;
let privateKey: KeyLike;
let publicJwk: JWK;

async function startIssuer(): Promise<void> {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
  privateKey = priv;
  publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-kid";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  issuerServer = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer: issuerUrl, jwks_uri: `${issuerUrl}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, ISSUER_HOST, resolve));
  const addr = issuerServer.address() as AddressInfo;
  issuerUrl = `http://${ISSUER_HOST}:${addr.port}`;
}

async function mintToken(claims: Record<string, unknown> = {}, overrides: { audience?: string | string[]; issuer?: string; expSeconds?: number } = {}): Promise<string> {
  return new SignJWT({ email: "alice@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(overrides.issuer ?? issuerUrl)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${overrides.expSeconds ?? 60}s`)
    .sign(privateKey);
}

async function startMcp(): Promise<void> {
  const cfg: LoadedConfig = {
    server: { name: "test", version: "0.0.0" },
    collections: [],
    tools: { registry: new InlineToolSource([]), mcpSources: [] },
    auth: { mode: "oidc", issuer: issuerUrl, audience: AUDIENCE },
  };
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"] });
  mcpServer = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const addr = mcpServer.address() as AddressInfo;
  mcpBaseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "error";
  _clearJwksCache();
  await startIssuer();
  await startMcp();
}, 15_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => mcpServer.close((err) => (err ? reject(err) : resolve())));
  await new Promise<void>((resolve, reject) => issuerServer.close((err) => (err ? reject(err) : resolve())));
  _clearJwksCache();
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

async function callMcp(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${mcpBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
}

describe("OIDC middleware", () => {
  it("rejects requests with no Authorization header (401)", async () => {
    const res = await callMcp();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toMatch(/missing or malformed/i);
  });

  it("rejects non-Bearer Authorization (401)", async () => {
    const res = await callMcp({ Authorization: "Basic dXNlcjpwYXNz" });
    expect(res.status).toBe(401);
  });

  it("admits a valid token signed by the issuer with the right audience", async () => {
    const token = await mintToken();
    const res = await callMcp({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });

  it("rejects a token with the wrong audience (401)", async () => {
    const token = await mintToken({}, { audience: "other-audience" });
    const res = await callMcp({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("rejects a token with the wrong issuer (401)", async () => {
    const token = await mintToken({}, { issuer: "https://evil.example.com" });
    const res = await callMcp({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token (401)", async () => {
    const token = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(issuerUrl)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    const res = await callMcp({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  it("rejects a token with a tampered signature (401)", async () => {
    const token = await mintToken();
    // Flip the last char of the signature segment.
    const parts = token.split(".");
    const sig = parts[2];
    parts[2] = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const res = await callMcp({ Authorization: `Bearer ${parts.join(".")}` });
    expect(res.status).toBe(401);
  });
});
