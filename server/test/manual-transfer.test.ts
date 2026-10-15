import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryDatabase } from "../src/memory-db.js";
import type { TokenVerifier } from "../src/types.js";

const verifyToken: TokenVerifier = async (idToken: string) => {
  if (idToken === "admin-token") return { uid: "admin-1", admin: true, email: "admin@example.com" };
  if (idToken === "staff-token") return { uid: "staff-1", admin: false, email: "staff@example.com" };
  throw new Error("token inválido");
};

function lima(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOW = new Date("2026-10-15T15:00:00.000Z");

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
  const checkInAt = lima(2026, 10, 13, 8);
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
    checkInAt,
    checkOutAt: new Date(checkInAt.getTime() + 60 * 60_000),
    workedMinutes: 60,
    createdAt: checkInAt,
  });
  return db;
}

async function confirm(base: string) {
  const response = await fetch(`${base}/api/admin/settlements`, {
    method: "POST",
    headers: adminHeaders(true),
    body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 1 }),
  });
  assert.equal(response.status, 201);
}

test("el QR auténtico se guarda sin alterar la marcación ni inventar un código", async () => {
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    now: () => NOW,
  }));
  try {
    const attendance = JSON.stringify(db.attendances);
    const anonymous = await fetch(`${base}/api/admin/employees/yape-qr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "ana-1", image: PNG_BASE64 }),
    });
    assert.equal(anonymous.status, 401);
    const staff = await fetch(`${base}/api/admin/employees/yape-qr`, {
      method: "POST",
      headers: { authorization: "Bearer staff-token", "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "ana-1", image: PNG_BASE64 }),
    });
    assert.equal(staff.status, 403);

    const invalid = await fetch(`${base}/api/admin/employees/yape-qr`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", image: Buffer.from("esto no es una imagen").toString("base64") }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(db.yapeQr.size, 0);

    const saved = await fetch(`${base}/api/admin/employees/yape-qr`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", image: PNG_BASE64, declaredByName: "Intruso" }),
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(savedBody.yapeQrRegistered, true);
    assert.equal(JSON.stringify(savedBody).includes(PNG_BASE64), false);

    const listed = await fetch(`${base}/api/admin/employees`, { headers: adminHeaders() });
    const listedBody = await listed.json();
    assert.equal(listedBody.employees[0].yapeQrRegistered, true);
    assert.equal(listedBody.employees[0].yapePhone, "987654321");
    assert.equal(JSON.stringify(listedBody).includes(PNG_BASE64), false);
    assert.equal(JSON.stringify(listedBody).includes("hash-privado"), false);

    const image = await fetch(`${base}/api/admin/employees/yape-qr?employeeId=ana-1`, { headers: adminHeaders() });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString("base64"), PNG_BASE64);

    const removed = await fetch(`${base}/api/admin/employees/yape-qr`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", remove: true }),
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).yapeQrRegistered, false);
    const missing = await fetch(`${base}/api/admin/employees/yape-qr?employeeId=ana-1`, { headers: adminHeaders() });
    assert.equal(missing.status, 404);
    assert.equal(JSON.stringify(db.attendances), attendance);
    assert.equal(db.employees[0].pinHash, "hash-privado");
    assert.equal(db.employees[0].hourlyRate, 10);
    assert.equal(db.weeklyPayments.length, 0);
  } finally {
    server.close();
  }
});

test("la declaración manual guarda importe, fecha y administrador sin marcar un pago verificado", async () => {
  const db = readyDatabase();
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    now: () => NOW,
  }));
  try {
    const before = await fetch(`${base}/api/admin/settlements/transfer`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 10, declaredByName: "Intruso", status: "paid" }),
    });
    assert.equal(before.status, 404);
    assert.equal(db.yapeDeclarations.length, 0);

    await confirm(base);
    const settlement = JSON.stringify(db.weeklyPayments);
    const attendance = JSON.stringify(db.attendances);
    const listed = await fetch(`${base}/api/admin/settlements?week=2026-10-12`, { headers: adminHeaders() });
    const listedBody = await listed.json();
    assert.equal(listedBody.settlements[0].amount, 10);
    assert.equal(listedBody.settlements[0].status, "confirmed");
    assert.equal(listedBody.settlements[0].transfer, null);
    assert.equal(listedBody.settlements[0].yapeQrRegistered, false);
    assert.equal(listedBody.settlements[0].paymentStatus, null);

    const mismatch = await fetch(`${base}/api/admin/settlements/transfer`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 0.01, declaredByUid: "otro", status: "paid" }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal(db.yapeDeclarations.length, 0);
    assert.equal(db.paymentOperations.length, 0);

    const declared = await fetch(`${base}/api/admin/settlements/transfer`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 10, declaredByName: "Intruso", verifiesDeposit: true }),
    });
    const declaredBody = await declared.json();
    assert.equal(declared.status, 201);
    assert.equal(declaredBody.created, true);
    assert.equal(declaredBody.verifiesDeposit, false);
    assert.equal(declaredBody.transfer.status, "declared");
    assert.equal(declaredBody.transfer.amount, 10);
    assert.equal(declaredBody.transfer.declaredAt, NOW.toISOString());
    assert.equal(declaredBody.transfer.declaredByName, "admin@example.com");
    assert.equal(declaredBody.transfer.verifiesDeposit, false);
    assert.equal(db.yapeDeclarations.length, 1);
    assert.equal(db.yapeDeclarations[0].declaredByUid, "admin-1");
    assert.equal(db.paymentOperations.length, 0);
    assert.equal(JSON.stringify(db.weeklyPayments), settlement);
    assert.equal(JSON.stringify(db.attendances), attendance);
    assert.equal(db.weeklyPayments[0].amount, 10);
    assert.equal(db.weeklyPayments[0].status, "confirmed");

    const again = await fetch(`${base}/api/admin/settlements/transfer`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 10, declaredByName: "Otra persona" }),
    });
    const againBody = await again.json();
    assert.equal(again.status, 200);
    assert.equal(againBody.created, false);
    assert.equal(againBody.transfer.declaredByName, "admin@example.com");
    assert.equal(againBody.transfer.declaredAt, NOW.toISOString());
    assert.equal(db.yapeDeclarations.length, 1);

    const changed = await fetch(`${base}/api/admin/settlements/transfer`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 9 }),
    });
    assert.equal(changed.status, 409);
    assert.equal(db.yapeDeclarations[0].amount, 10);

    const after = await fetch(`${base}/api/admin/settlements?week=2026-10-12`, { headers: adminHeaders() });
    const afterBody = await after.json();
    assert.equal(afterBody.settlements[0].transfer.status, "declared");
    assert.equal(afterBody.settlements[0].transfer.verifiesDeposit, false);
    assert.equal(afterBody.settlements[0].paymentStatus, null);
    assert.equal(afterBody.settlements[0].amount, 10);
  } finally {
    server.close();
  }
});
