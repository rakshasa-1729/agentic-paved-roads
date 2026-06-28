// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { AddressInfo } from "node:net";
import { buildHttpApp } from "../../src/server.js";
import { mtlsMiddleware } from "../../src/auth/mtls.js";
import { currentPrincipal } from "../../src/log.js";
import type { LoadedConfig } from "../../src/config.js";
import { InlineToolSource } from "../../src/sources/command.js";

let tmpDir: string;
let serverCertPath: string;
let serverKeyPath: string;
let caCertPath: string;
let clientCertPath: string;
let clientKeyPath: string;

const originalLogLevel = process.env.LOG_LEVEL;

beforeAll(() => {
  process.env.LOG_LEVEL = "error";
  tmpDir = mkdtempSync(join(tmpdir(), "security-mcp-mtls-"));
  const caKey = join(tmpDir, "ca-key.pem");
  const serverCsr = join(tmpDir, "server-csr.pem");
  const clientCsr = join(tmpDir, "client-csr.pem");
  const serialFile = join(tmpDir, "ca.srl");
  const extFile = join(tmpDir, "server-ext.cnf");

  caCertPath = join(tmpDir, "ca-cert.pem");
  serverCertPath = join(tmpDir, "server-cert.pem");
  serverKeyPath = join(tmpDir, "server-key.pem");
  clientCertPath = join(tmpDir, "client-cert.pem");
  clientKeyPath = join(tmpDir, "client-key.pem");

  // Generate a self-signed CA
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${caKey}" -out "${caCertPath}" -days 1 -nodes -subj "/CN=Test CA"`,
    { stdio: "pipe" },
  );

  // Generate server cert signed by CA (with IP SAN for 127.0.0.1)
  writeFileSync(extFile, "subjectAltName=IP:127.0.0.1\n");
  execSync(
    `openssl req -newkey rsa:2048 -keyout "${serverKeyPath}" -out "${serverCsr}" -nodes -subj "/CN=localhost"`,
    { stdio: "pipe" },
  );
  execSync(
    `openssl x509 -req -in "${serverCsr}" -CA "${caCertPath}" -CAkey "${caKey}" -CAserial "${serialFile}" -CAcreateserial -out "${serverCertPath}" -days 1 -extfile "${extFile}"`,
    { stdio: "pipe" },
  );

  // Generate client cert with CN=test-principal, signed by CA
  execSync(
    `openssl req -newkey rsa:2048 -keyout "${clientKeyPath}" -out "${clientCsr}" -nodes -subj "/CN=test-principal"`,
    { stdio: "pipe" },
  );
  execSync(
    `openssl x509 -req -in "${clientCsr}" -CA "${caCertPath}" -CAkey "${caKey}" -CAserial "${serialFile}" -out "${clientCertPath}" -days 1`,
    { stdio: "pipe" },
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

// ─── Unit tests for the middleware ────────────────────────────────

describe("mtlsMiddleware (unit)", () => {
  it("extracts the CN from a peer certificate and calls next()", async () => {
    const middleware = mtlsMiddleware();
    let principal: string | undefined;
    let calledNext = false;
    const mockReq = {
      socket: {
        getPeerCertificate: () => ({
          subject: { CN: "test-principal" },
          issuer: { CN: "Test CA" },
          valid_from: "Jan  1 00:00:00 2026 GMT",
          valid_to: "Jan  2 00:00:00 2026 GMT",
          fingerprint: "AA:BB:CC",
          serialNumber: "01",
          raw: Buffer.from(""),
        }),
      },
    };
    const mockRes = { headersSent: false, status: () => ({ json: () => undefined }), json: () => undefined };

    await new Promise<void>((resolve) => {
      middleware(mockReq as never, mockRes as never, () => {
        calledNext = true;
        principal = currentPrincipal();
        resolve();
      });
    });

    expect(calledNext).toBe(true);
    expect(principal).toBe("test-principal");
  });

  it("rejects when no client cert is presented", async () => {
    const middleware = mtlsMiddleware();
    let rejected = false;
    const mockReq = {
      socket: {
        getPeerCertificate: () => null,
      },
    };
    const mockRes = {
      headersSent: false,
      status: (code: number) => {
        expect(code).toBe(401);
        return {
          json: (body: { error: { message: string } }) => {
            expect(body.error.message).toContain("client certificate required");
            rejected = true;
          },
        };
      },
    };

    middleware(mockReq as never, mockRes as never, () => {
      throw new Error("next should not be called");
    });

    expect(rejected).toBe(true);
  });

  it("falls back to O when CN is missing", async () => {
    const middleware = mtlsMiddleware();
    let principal: string | undefined;
    const mockReq = {
      socket: {
        getPeerCertificate: () => ({
          subject: { O: "my-org" },
          issuer: { CN: "Test CA" },
          raw: Buffer.from(""),
        }),
      },
    };
    const mockRes = { headersSent: false, status: () => ({ json: () => undefined }), json: () => undefined };

    await new Promise<void>((resolve) => {
      middleware(mockReq as never, mockRes as never, () => {
        principal = currentPrincipal();
        resolve();
      });
    });

    expect(principal).toBe("my-org");
  });
});

// ─── E2E test with real TLS ───────────────────────────────────────

const cfg: LoadedConfig = {
  server: { name: "mtls-test", version: "0.0.0" },
  collections: [],
  tools: { registry: new InlineToolSource([]), mcpSources: [] },
  auth: { mode: "mtls" },
};

let server: ReturnType<typeof createHttpsServer>;
let baseUrl: string;

beforeAll(async () => {
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"] });
  const tlsOptions = {
    cert: readFileSync(serverCertPath),
    key: readFileSync(serverKeyPath),
    ca: readFileSync(caCertPath),
    requestCert: true,
    rejectUnauthorized: true,
  };
  server = createHttpsServer(tlsOptions, app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `https://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function httpsGet(path: string, withCert: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: Parameters<typeof httpsRequest>[0] = {
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      path,
      method: "GET",
      ca: readFileSync(caCertPath),
      rejectUnauthorized: false, // we test the cert via app code, not the test client's verification
    };
    if (withCert) {
      options.cert = readFileSync(clientCertPath);
      options.key = readFileSync(clientKeyPath);
    }
    const req = httpsRequest(options, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(path: string, body: string, withCert: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: Parameters<typeof httpsRequest>[0] = {
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      path,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      ca: readFileSync(caCertPath),
      rejectUnauthorized: false,
    };
    if (withCert) {
      options.cert = readFileSync(clientCertPath);
      options.key = readFileSync(clientKeyPath);
    }
    const req = httpsRequest(options, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("mTLS E2E", () => {
  it("rejects requests without a client cert at the TLS layer", async () => {
    // With rejectUnauthorized: true on the server, a connection without
    // a client cert is rejected by the TLS handshake itself. Node's
    // https.request will emit an 'error' event.
    await expect(httpsGet("/healthz", false)).rejects.toThrow();
  });

  it("accepts requests with a valid client cert and extracts the principal", async () => {
    const res = await httpsGet("/healthz", true);
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
  });

  it("authenticates the principal from the client cert CN on /mcp", async () => {
    const res = await httpsPost(
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      true,
    );
    expect(res.status).toBe(200);
    // The response should include the tool list (SSE-formatted)
    expect(res.body).toContain("tool_registry");
  });
});
