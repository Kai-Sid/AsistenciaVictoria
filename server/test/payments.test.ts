import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryDatabase } from "../src/memory-db.js";
import {
  PAYMENT_ALREADY_PAID,
  PAYMENT_PROVIDER_PENDING,
  PAYMENT_RETURN_IGNORED,
  PAYMENT_UNCERTAIN,
  httpsPaymentUrl,
  paymentGatewayFromEnv,
  type PaymentGateway,
  type PaymentSessionResult,
} from "../src/payments.js";
import type { TokenVerifier, VerifiedPayment } from "../src/types.js";

const verifyToken: TokenVerifier = async (idToken: string) => {
  if (idToken === "admin-token") return { uid: "admin-1", admin: true, email: "admin@example.com" };
  if (idToken === "staff-token") return { uid: "staff-1", admin: false, email: "staff@example.com" };
  throw new Error("token inválido");
};

function lima(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

const SECRET = "super-secret-token";
const SESSION_URL = "https://pagos.example/sesion";

type GatewayMode = "ok" | "fail" | "uncertain" | "bad-url" | "throw";

function testGateway(state: { calls: number; mode: GatewayMode }): PaymentGateway {
  return {
    configured: true,
    unavailableMessage: PAYMENT_PROVIDER_PENDING,
    async createSession(input): Promise<PaymentSessionResult> {
      state.calls += 1;
      if (state.mode === "throw") throw new Error(`bearer ${SECRET}`);
      if (state.mode === "uncertain") return { ok: false, outcome: "uncertain", message: "sin resultado" };
      if (state.mode === "fail") return { ok: false, outcome: "failed", message: "El proveedor rechazó la sesión." };
      if (state.mode === "bad-url") {
        return { ok: true, redirectUrl: "http://pagos.example/sesion", provider: "prueba", providerReference: "ref-1" };
      }
      return {
        ok: true,
        redirectUrl: `${SESSION_URL}?op=${encodeURIComponent(input.operationId)}`,
        provider: "prueba",
        providerReference: `ref-${input.attempt}`,
      };
    },
    async verifyNotification(body, headers): Promise<VerifiedPayment | null> {
      if (headers.get("x-test-verify") !== "si") return null;
      if (!body || typeof body !== "object") return null;
      const record = body as { operationId?: unknown; providerReference?: unknown; status?: unknown; amount?: unknown };
      if (typeof record.operationId !== "string" || typeof record.providerReference !== "string" || typeof record.amount !== "number") return null;
      if (record.status !== "paid" && record.status !== "failed" && record.status !== "processing") return null;
      return {
        operationId: record.operationId,
        providerReference: record.providerReference,
        status: record.status,
        amount: record.amount,
        currency: "PEN",
      };
    },
  };
}

function adminHeaders(body = false) {
  return {
    authorization: "Bearer admin-token",
    ...(body ? { "content-type": "application/json" } : {}),
  };
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function readyDatabase() {
  const db = new MemoryDatabase();
  db.employees.push({
    id: "ana-1",
    name: "Ana López",
    employeeCode: "VIC-001",
    active: true,
    pinHash: "hash-privado",
    hourlyRate: 10,
    yapePhone: "987654321",
  });
  db.attendances.push({
    id: "att-1",
    employeeId: "ana-1",
    employeeCode: "VIC-001",
    employeeName: "Ana López",
    status: "closed",
    checkInAt: lima(2026, 10, 13, 8),
    checkOutAt: lima(2026, 10, 13, 9),
    workedMinutes: 60,
    createdAt: lima(2026, 10, 13, 8),
  });
  return db;
}

async function confirm(base: string) {
  const response = await fetch(`${base}/api/admin/settlements`, {
    method: "POST",
    headers: adminHeaders(true),
    body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 0.01, hourlyRate: 1 }),
  });
  assert.equal(response.status, 201);
}

test("sin proveedor configurado no hay redirección ni operación de pago", async () => {
  const gateway = paymentGatewayFromEnv({ YAPE_TOKEN: SECRET, MERCADOPAGO_ACCESS_TOKEN: SECRET });
  assert.equal(gateway.configured, false);
  assert.equal(gateway.unavailableMessage.includes(SECRET), false);
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    payments: gateway,
  }));
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(base)) {
      outbound += 1;
      throw new Error("outbound");
    }
    return originalFetch(input, init);
  };
  try {
    await confirm(base);
    const snapshot = JSON.stringify(db.weeklyPayments);
    const response = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 0.01, secret: SECRET, redirectUrl: "https://pagos.example/falso" }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.message, PAYMENT_PROVIDER_PENDING);
    assert.equal("redirectUrl" in body, false);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.equal(db.paymentOperations.length, 0);
    assert.equal(JSON.stringify(db.weeklyPayments), snapshot);
    assert.equal(db.weeklyPayments[0].status, "confirmed");
    assert.equal(db.attendances[0].status, "closed");
    assert.equal(outbound, 0);

    const anonymous = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    assert.equal(anonymous.status, 401);
    const staff = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: { authorization: "Bearer staff-token", "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    assert.equal(staff.status, 403);
    const notification = await fetch(`${base}/api/payments/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-verify": "si" },
      body: JSON.stringify({ operationId: "ana-1_2026-10-12", providerReference: "ref-1", status: "paid", amount: 10 }),
    });
    assert.equal(notification.status, 503);
    assert.equal(db.paymentOperations.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});

test("la sesión usa el importe del servidor y no se duplica", async () => {
  const state = { calls: 0, mode: "ok" as GatewayMode };
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    payments: testGateway(state),
  }));
  try {
    await confirm(base);
    assert.equal(db.paymentOperations.length, 0);
    const listed = await fetch(`${base}/api/admin/settlements?week=2026-10-12`, { headers: adminHeaders() });
    const listedBody = await listed.json();
    assert.equal(listedBody.settlements[0].status, "confirmed");
    assert.equal(listedBody.settlements[0].paymentStatus, null);
    assert.equal(listedBody.settlements[0].amount, 10);

    const missing = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "nadie", weekStart: "2026-10-12" }),
    });
    assert.equal(missing.status, 404);

    const started = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 0.01, secret: SECRET }),
    });
    const startedBody = await started.json();
    assert.equal(started.status, 200);
    assert.equal(startedBody.ok, true);
    assert.equal(startedBody.paymentStatus, "processing");
    assert.equal(startedBody.amount, 10);
    assert.equal(startedBody.currency, "PEN");
    assert.equal(startedBody.resumed, false);
    assert.equal(startedBody.redirectUrl.startsWith(SESSION_URL), true);
    assert.equal(JSON.stringify(startedBody).includes(SECRET), false);
    assert.equal(state.calls, 1);
    assert.equal(db.paymentOperations.length, 1);
    assert.equal(db.paymentOperations[0].amount, 10);
    assert.equal(db.paymentOperations[0].status, "processing");
    assert.equal(db.paymentOperations[0].providerReference, "ref-1");
    assert.equal(JSON.stringify(db.paymentOperations).includes(SECRET), false);
    assert.equal(db.weeklyPayments[0].status, "confirmed");
    assert.equal(db.weeklyPayments[0].amount, 10);

    const again = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const againBody = await again.json();
    assert.equal(again.status, 200);
    assert.equal(againBody.resumed, true);
    assert.equal(againBody.redirectUrl, startedBody.redirectUrl);
    assert.equal(state.calls, 1);

    const returned = await fetch(`${base}/api/admin/payments/return?employeeId=ana-1&weekStart=2026-10-12&status=approved&collection_status=approved`, {
      headers: adminHeaders(),
    });
    const returnedBody = await returned.json();
    assert.equal(returned.status, 200);
    assert.equal(returnedBody.confirmsPayment, false);
    assert.equal(returnedBody.paymentStatus, "processing");
    assert.equal(returnedBody.settlementStatus, "confirmed");
    assert.equal(returnedBody.message, PAYMENT_RETURN_IGNORED);
    assert.equal(db.paymentOperations[0].status, "processing");
    assert.equal(db.weeklyPayments[0].status, "confirmed");

    const forged = await fetch(`${base}/api/payments/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "ana-1_2026-10-12", providerReference: "ref-1", status: "paid", amount: 10 }),
    });
    assert.equal(forged.status, 401);
    assert.equal(db.paymentOperations[0].status, "processing");

    const wrongAmount = await fetch(`${base}/api/payments/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-verify": "si" },
      body: JSON.stringify({ operationId: "ana-1_2026-10-12", providerReference: "ref-1", status: "paid", amount: 1 }),
    });
    const wrongBody = await wrongAmount.json();
    assert.equal(wrongAmount.status, 200);
    assert.equal(wrongBody.applied, false);
    assert.equal(db.paymentOperations[0].status, "processing");

    const verified = await fetch(`${base}/api/payments/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-verify": "si" },
      body: JSON.stringify({ operationId: "ana-1_2026-10-12", providerReference: "ref-1", status: "paid", amount: 10 }),
    });
    const verifiedBody = await verified.json();
    assert.equal(verified.status, 200);
    assert.equal(verifiedBody.applied, true);
    assert.equal(db.paymentOperations[0].status, "paid");
    assert.equal(db.weeklyPayments[0].status, "confirmed");

    const blocked = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 409);
    assert.equal(blockedBody.message, PAYMENT_ALREADY_PAID);
    assert.equal(state.calls, 1);
    assert.equal(db.paymentOperations.length, 1);

    const after = await fetch(`${base}/api/admin/settlements?week=2026-10-12`, { headers: adminHeaders() });
    const afterBody = await after.json();
    assert.equal(afterBody.settlements[0].status, "confirmed");
    assert.equal(afterBody.settlements[0].paymentStatus, "paid");
    assert.equal(db.attendances.length, 1);
    assert.equal(db.employees[0].pinHash, "hash-privado");
  } finally {
    server.close();
  }
});

test("una operación incierta no se reinicia y un fallo confirmado sí admite otro intento", async () => {
  const state = { calls: 0, mode: "uncertain" as GatewayMode };
  const gateway = testGateway(state);
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    payments: gateway,
  }));
  try {
    await confirm(base);
    const first = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 409);
    assert.equal(firstBody.message, PAYMENT_UNCERTAIN);
    assert.equal(db.paymentOperations[0].status, "pending");
    assert.equal(db.paymentOperations[0].redirectUrl, null);

    const second = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    assert.equal(second.status, 409);
    assert.equal(state.calls, 1);
    assert.equal(db.paymentOperations.length, 1);

    db.paymentOperations.length = 0;
    state.calls = 0;
    state.mode = "fail";
    const failed = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const failedBody = await failed.json();
    assert.equal(failed.status, 502);
    assert.equal(failedBody.message, "El proveedor rechazó la sesión.");
    assert.equal(db.paymentOperations[0].status, "failed");
    assert.equal(db.paymentOperations[0].redirectUrl, null);

    state.mode = "ok";
    const retried = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const retriedBody = await retried.json();
    assert.equal(retried.status, 200);
    assert.equal(retriedBody.paymentStatus, "processing");
    assert.equal(state.calls, 2);
    assert.equal(db.paymentOperations.length, 1);
    assert.equal(db.paymentOperations[0].attempt, 2);
    assert.equal(db.paymentOperations[0].providerReference, "ref-2");
  } finally {
    server.close();
  }
});

test("dos solicitudes simultáneas crean una sola operación", async () => {
  const state = { calls: 0, mode: "ok" as GatewayMode };
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    payments: testGateway(state),
  }));
  try {
    await confirm(base);
    const request = () => fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(state.calls, 1);
    assert.equal(db.paymentOperations.length, 1);
    assert.equal(db.paymentOperations[0].status, "processing");
    assert.equal([first.status, second.status].includes(200), true);
    const bodies = [await first.json(), await second.json()];
    assert.equal(bodies.some((body) => body.redirectUrl?.startsWith(SESSION_URL)), true);
  } finally {
    server.close();
  }
});

test("un importe alterado, una URL inválida o la falta de celular no inician el pago", async () => {
  const state = { calls: 0, mode: "bad-url" as GatewayMode };
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    payments: testGateway(state),
  }));
  try {
    await confirm(base);
    db.weeklyPayments[0].amount = 1;
    const mismatch = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 1 }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal(db.paymentOperations.length, 0);
    assert.equal(state.calls, 0);
    db.weeklyPayments[0].amount = 10;

    db.weeklyPayments[0].yapePhone = null;
    const missingPhone = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    assert.equal(missingPhone.status, 400);
    assert.equal(db.paymentOperations.length, 0);
    db.weeklyPayments[0].yapePhone = "987654321";

    const invalidUrl = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const invalidBody = await invalidUrl.json();
    assert.equal(invalidUrl.status, 409);
    assert.equal(invalidBody.message, PAYMENT_UNCERTAIN);
    assert.equal("redirectUrl" in invalidBody, false);
    assert.equal(db.paymentOperations[0].status, "pending");
    assert.equal(state.calls, 1);

    state.mode = "ok";
    const stuck = await fetch(`${base}/api/admin/settlements/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    assert.equal(stuck.status, 409);
    assert.equal(state.calls, 1);
  } finally {
    server.close();
  }
});

test("la pantalla muestra el QR registrado y no llama a un proveedor", () => {
  assert.equal(httpsPaymentUrl("http://pagos.example/sesion"), null);
  assert.equal(httpsPaymentUrl("https://usuario:clave@pagos.example/sesion"), null);
  assert.equal(httpsPaymentUrl("https://pagos.example/sesion")?.startsWith("https://pagos.example/"), true);
  const panel = readFileSync(resolve(process.cwd(), "../src/SettlementsPanel.tsx"), "utf8");
  assert.equal(panel.includes("Pagar con Yape"), true);
  assert.equal(panel.includes("/api/admin/settlements/transfer"), true);
  assert.equal(panel.includes("/api/admin/employees/yape-qr"), true);
  assert.equal(panel.includes("Falta registrar el QR del trabajador."), true);
  assert.equal(panel.includes("Registrar transferencia realizada"), true);
  assert.equal(panel.includes("canOfferYapePayment"), true);
  assert.equal(panel.includes("reported_paid"), true);
  assert.equal(panel.includes('row.transfer?.status !== "reported_paid"'), true);
  assert.equal(panel.includes('row.paymentStatus !== "paid"'), true);
  assert.equal(panel.includes("Pendiente de pago"), true);
  assert.equal(panel.includes("Declarada por el administrador"), true);
  assert.equal(panel.includes("Pago verificado"), true);
  assert.equal(panel.includes("Operación fallida"), true);
  assert.equal(panel.includes('badges.push({ label: "Pago verificado"') && panel.includes('row.transfer?.status === "reported_paid"') && panel.includes('badges.push({ label: "Declarada por el administrador"'), true);
  assert.equal(panel.includes('if (row.transfer?.status === "reported_paid") badges.push({ label: "Pago verificado"'), false);
  assert.equal(panel.includes("/api/admin/settlements/pay"), false);
  assert.equal(panel.includes("window.location.assign"), false);
  assert.equal(panel.includes("mercadopago.com"), false);
  assert.equal(panel.includes("yape.com.pe"), false);
  assert.equal(panel.includes("init_point"), false);
  assert.equal(panel.includes("qrcode"), false);
  assert.equal(/data:image|chart\.googleapis|api\.qrserver/i.test(panel), false);
  assert.equal(panel.includes(SECRET), false);
});
