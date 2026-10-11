import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { inspectFirebaseConfig } from "../src/firebase.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const account = {
  project_id: "proyecto-credencial",
  client_email: "api@proyecto-credencial.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nQUFGRQ==\n-----END PRIVATE KEY-----\n",
};

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const keys = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("sin credenciales el estado es not-configured y no incluye secretos", () => {
  withEnv({
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_SERVICE_ACCOUNT_JSON: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
  }, () => {
    const result = inspectFirebaseConfig();
    assert.deepEqual(result, { ok: false, reason: "not-configured" });
    assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  });
});

test("FIREBASE_SERVICE_ACCOUNT_JSON debe pertenecer a FIREBASE_PROJECT_ID", () => {
  const json = JSON.stringify(account);
  withEnv({
    FIREBASE_PROJECT_ID: "otro-proyecto",
    FIREBASE_SERVICE_ACCOUNT_JSON: json,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
  }, () => {
    assert.deepEqual(inspectFirebaseConfig(), { ok: false, reason: "project-mismatch" });
  });
  withEnv({
    FIREBASE_PROJECT_ID: "proyecto-credencial",
    FIREBASE_SERVICE_ACCOUNT_JSON: json,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
  }, () => {
    const result = inspectFirebaseConfig();
    assert.deepEqual(result, { ok: true, projectId: "proyecto-credencial", source: "json" });
    assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(result).includes("client_email"), false);
  });
  withEnv({
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_SERVICE_ACCOUNT_JSON: json,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
  }, () => {
    assert.deepEqual(inspectFirebaseConfig(), { ok: false, reason: "not-configured" });
  });
  withEnv({
    FIREBASE_PROJECT_ID: "proyecto-credencial",
    FIREBASE_SERVICE_ACCOUNT_JSON: "{no-es-json",
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
  }, () => {
    assert.deepEqual(inspectFirebaseConfig(), { ok: false, reason: "invalid-credentials" });
  });
});

test("GOOGLE_APPLICATION_CREDENTIALS se acepta solo si el archivo es del mismo proyecto", () => {
  const dir = mkdtempSync(join(tmpdir(), "victoria-cred-"));
  const file = join(dir, "service-account.json");
  writeFileSync(file, JSON.stringify(account), "utf8");
  try {
    withEnv({
      FIREBASE_PROJECT_ID: "proyecto-credencial",
      FIREBASE_SERVICE_ACCOUNT_JSON: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: file,
    }, () => {
      assert.deepEqual(inspectFirebaseConfig(), { ok: true, projectId: "proyecto-credencial", source: "file" });
    });
    withEnv({
      FIREBASE_PROJECT_ID: "otro-proyecto",
      FIREBASE_SERVICE_ACCOUNT_JSON: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: file,
    }, () => {
      assert.deepEqual(inspectFirebaseConfig(), { ok: false, reason: "project-mismatch" });
    });
    withEnv({
      FIREBASE_PROJECT_ID: "proyecto-credencial",
      FIREBASE_SERVICE_ACCOUNT_JSON: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: join(dir, "no-existe.json"),
    }, () => {
      assert.deepEqual(inspectFirebaseConfig(), { ok: false, reason: "invalid-credentials" });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health distingue la causa sin exponer credenciales", async () => {
  const app = createApp({
    database: null,
    verifyToken: null,
    allowedOrigins: ["http://localhost:5174"],
    firestoreStatus: "project-mismatch",
  });
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, firestore: false, reason: "project-mismatch" });
    assert.equal(JSON.stringify(body).includes("private_key"), false);
  } finally {
    server.close();
  }
});
