import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryDatabase } from "../src/memory-db.js";
import {
  amountCents,
  amountFromMinutes,
  classifyShifts,
  minutesStartingInWeek,
  previewWeek,
  SETTLEMENT_LOOKBACK_MS,
  weekBoundsFromKey,
  weekContaining,
  type EmployeePay,
} from "../src/settlements.js";
import type { AttendanceDoc, TokenVerifier } from "../src/types.js";

const verifyToken: TokenVerifier = async (idToken: string) => {
  if (idToken === "admin-token") return { uid: "admin-1", admin: true, email: "admin@example.com" };
  if (idToken === "staff-token") return { uid: "staff-1", admin: false, email: "staff@example.com" };
  throw new Error("token inválido");
};

function lima(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

const week = weekBoundsFromKey("2026-10-12");
if (!week) throw new Error("La semana de prueba no es un lunes.");

const ana: EmployeePay = {
  id: "ana-1",
  name: "Ana López",
  employeeCode: "VIC-001",
  hourlyRate: 10,
  yapePhone: "987654321",
};

function shift(overrides: Partial<AttendanceDoc> = {}): AttendanceDoc {
  return {
    id: "att-1",
    employeeId: "ana-1",
    employeeCode: "VIC-001",
    employeeName: "Ana López",
    status: "closed",
    checkInAt: lima(2026, 10, 13, 8),
    checkOutAt: lima(2026, 10, 13, 9),
    workedMinutes: 9999,
    createdAt: lima(2026, 10, 13, 8),
    ...overrides,
  };
}

function preview(attendances: AttendanceDoc[], employee: EmployeePay = ana, bounds = week) {
  if (!bounds) throw new Error("semana");
  return previewWeek({ employees: [employee], attendances, confirmed: [], week: bounds });
}

test("una jornada cerrada de una hora suma 60 minutos", () => {
  const [row] = preview([shift()]);
  assert.equal(row.totalMinutes, 60);
  assert.equal(row.shifts.length, 1);
  assert.equal(row.amount, 10);
  assert.equal(row.shifts[0].minutes, 60);
});

test("una jornada cerrada de ocho horas suma 480 minutos", () => {
  const [row] = preview([shift({ checkOutAt: lima(2026, 10, 13, 16) })]);
  assert.equal(row.totalMinutes, 480);
  assert.equal(row.amount, 80);
});

test("una jornada que cruza la medianoche conserva su duración", () => {
  const checkInAt = lima(2026, 10, 13, 23);
  const checkOutAt = lima(2026, 10, 14, 1);
  assert.equal(minutesStartingInWeek(checkInAt, checkOutAt, week.weekStart, week.weekEnd), 120);
  const [row] = preview([shift({ checkInAt, checkOutAt })]);
  assert.equal(row.totalMinutes, 120);
  assert.equal(row.amount, 20);
});

test("una jornada que cruza el lunes se reparte entre las dos semanas", () => {
  const checkInAt = lima(2026, 10, 18, 22);
  const checkOutAt = lima(2026, 10, 19, 2);
  const next = weekBoundsFromKey("2026-10-19");
  assert.ok(next);
  assert.equal(minutesStartingInWeek(checkInAt, checkOutAt, week.weekStart, week.weekEnd), 120);
  assert.equal(minutesStartingInWeek(checkInAt, checkOutAt, next.weekStart, next.weekEnd), 120);
  const [currentWeek] = preview([shift({ checkInAt, checkOutAt })]);
  const [followingWeek] = preview([shift({ checkInAt, checkOutAt })], ana, next);
  assert.equal(currentWeek.totalMinutes, 120);
  assert.equal(followingWeek.totalMinutes, 120);
  assert.equal(currentWeek.totalMinutes + followingWeek.totalMinutes, 240);
});

test("una jornada abierta no se incluye en los minutos por pagar", () => {
  const [row] = preview([shift({ status: "open", checkOutAt: undefined, workedMinutes: 480 })]);
  assert.equal(row.totalMinutes, 0);
  assert.equal(row.amount, 0);
  assert.deepEqual(row.excluded.map((item) => item.reason), ["open"]);
});

test("una jornada cerrada sí se incluye y no suma workedMinutes encima", () => {
  const classified = classifyShifts([shift({ workedMinutes: 1 })], week.weekStart, week.weekEnd);
  assert.equal(classified.totalMinutes, 60);
  assert.equal(classified.excluded.length, 0);
});

test("una jornada con fechas inválidas no inventa horas", () => {
  const inverted = shift({ id: "invertida", checkInAt: lima(2026, 10, 13, 10), checkOutAt: lima(2026, 10, 13, 9) });
  const missing = shift({ id: "sin-fecha", checkInAt: new Date(Number.NaN), checkOutAt: undefined });
  const rows = preview([inverted, missing]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalMinutes, 0);
  assert.equal(rows[0].amount, 0);
  assert.deepEqual(rows[0].excluded.map((item) => item.reason).sort(), ["invalid", "non-positive"]);
});

test("una jornada duplicada se cuenta una sola vez", () => {
  const first = shift({ id: "att-1" });
  const sameId = shift({ id: "att-1" });
  const sameInterval = shift({ id: "att-2" });
  const [row] = preview([first, sameId, sameInterval]);
  assert.equal(row.totalMinutes, 60);
  assert.equal(row.shifts.length, 1);
  assert.deepEqual(row.excluded.map((item) => item.reason), ["duplicate", "duplicate"]);
});

test("un trabajador sin tarifa no recibe un importe inventado", () => {
  const [row] = preview([shift()], { ...ana, hourlyRate: null, yapePhone: null });
  assert.equal(row.totalMinutes, 60);
  assert.equal(row.hourlyRate, null);
  assert.equal(row.amount, null);
  assert.equal(row.status, "missing-rate");
});

test("una fracción de hora no se redondea antes de calcular el importe", () => {
  const [row] = preview([shift({ checkOutAt: lima(2026, 10, 13, 9, 30) })]);
  assert.equal(row.totalMinutes, 90);
  assert.equal(row.amount, 15);
  assert.equal(amountFromMinutes(2670, 10), 445);
});

test("el importe se redondea a dos decimales", () => {
  assert.equal(amountCents(1, 10), 17);
  assert.equal(amountFromMinutes(1, 10), 0.17);
  assert.equal(amountCents(2670, 10), 44500);
  assert.equal(amountFromMinutes(20, 1), 0.33);
});

async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function adminHeaders(body = false) {
  return {
    authorization: "Bearer admin-token",
    ...(body ? { "content-type": "application/json" } : {}),
  };
}

test("cambiar la tarifa no altera una liquidación confirmada", async () => {
  const db = new MemoryDatabase();
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "hash-privado", createdAt, hourlyRate: 10 });
  const checkInAt = lima(2026, 10, 12, 8);
  db.attendances.push(shift({ checkInAt, checkOutAt: new Date(checkInAt.getTime() + 2670 * 60_000), workedMinutes: 1 }));
  const { server, base } = await listen(createApp({ database: db, verifyToken, allowedOrigins: ["http://localhost:5174"], now: () => new Date("2026-10-14T15:00:00.000Z") }));
  try {
    const previewResponse = await fetch(`${base}/api/admin/settlements?week=2026-10-12`, { headers: adminHeaders() });
    const previewBody = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(previewBody.settlements[0].amount, 445);
    assert.equal(db.weeklyPayments.length, 0);

    const confirmed = await fetch(`${base}/api/admin/settlements`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 1, hourlyRate: 1 }),
    });
    const confirmedBody = await confirmed.json();
    assert.equal(confirmed.status, 201);
    assert.equal(confirmedBody.created, true);
    assert.equal(confirmedBody.settlement.amount, 445);
    assert.equal(confirmedBody.settlement.hourlyRate, 10);
    assert.equal(confirmedBody.settlement.status, "confirmed");
    assert.equal(JSON.stringify(confirmedBody).includes("hash-privado"), false);

    await db.updateEmployeePay("ana-1", { hourlyRate: 25, yapePhone: "987654321" });
    const again = await fetch(`${base}/api/admin/settlements`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", amount: 999 }),
    });
    const againBody = await again.json();
    assert.equal(again.status, 200);
    assert.equal(againBody.created, false);
    assert.equal(againBody.settlement.amount, 445);
    assert.equal(againBody.settlement.hourlyRate, 10);
    assert.equal(db.weeklyPayments.length, 1);
    assert.equal(db.employees[0].hourlyRate, 25);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].workedMinutes, 1);
  } finally {
    server.close();
  }
});

test("dos confirmaciones simultáneas no crean liquidaciones duplicadas", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, hourlyRate: 10 });
  db.attendances.push(shift());
  const { server, base } = await listen(createApp({ database: db, verifyToken, allowedOrigins: ["http://localhost:5174"] }));
  try {
    const request = () => fetch(`${base}/api/admin/settlements`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12" }),
    });
    const [first, second] = await Promise.all([request(), request()]);
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(db.weeklyPayments.length, 1);
    assert.equal(firstBody.settlement.amount, 10);
    assert.equal(secondBody.settlement.amount, 10);
    assert.equal(firstBody.settlement.hourlyRate, secondBody.settlement.hourlyRate);
    assert.equal([firstBody.created, secondBody.created].filter(Boolean).length, 1);
    assert.deepEqual(new Set(db.weeklyPayments.map((payment) => payment.id)), new Set(["ana-1_2026-10-12"]));
  } finally {
    server.close();
  }
});

test("usuarios sin permiso de administrador no consultan ni confirman liquidaciones", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, hourlyRate: 10, pinHash: "hash-privado" });
  const { server, base } = await listen(createApp({ database: db, verifyToken, allowedOrigins: ["http://localhost:5174"] }));
  try {
    const paths = ["/api/admin/settlements?week=2026-10-12", "/api/admin/settlements", "/api/admin/employees/pay"];
    for (const path of paths) {
      const anonymous = await fetch(`${base}${path}`, { method: path.includes("settlements?") ? "GET" : "POST" });
      assert.equal(anonymous.status, 401);
      const staff = await fetch(`${base}${path}`, {
        method: path.includes("settlements?") ? "GET" : "POST",
        headers: { authorization: "Bearer staff-token", "content-type": "application/json" },
        body: path.includes("settlements?") ? undefined : JSON.stringify({ employeeId: "ana-1", weekStart: "2026-10-12", hourlyRate: 10 }),
      });
      assert.equal(staff.status, 403);
    }
    assert.equal(db.weeklyPayments.length, 0);
    assert.equal(db.employees[0].hourlyRate, 10);
    assert.equal(db.employees[0].pinHash, "hash-privado");
  } finally {
    server.close();
  }
});

test("configurar la tarifa conserva los demás campos del trabajador", async () => {
  const db = new MemoryDatabase();
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "hash-privado", createdAt });
  db.attendances.push(shift());
  const { server, base } = await listen(createApp({ database: db, verifyToken, allowedOrigins: ["http://localhost:5174"] }));
  try {
    const invalidPhone = await fetch(`${base}/api/admin/employees/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", hourlyRate: 10, yapePhone: "12345" }),
    });
    assert.equal(invalidPhone.status, 400);
    const invalidRate = await fetch(`${base}/api/admin/employees/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", hourlyRate: 10.555, yapePhone: "987654321" }),
    });
    assert.equal(invalidRate.status, 400);
    assert.equal(db.employees[0].hourlyRate, undefined);
    assert.equal(db.employees[0].pinHash, "hash-privado");

    const saved = await fetch(`${base}/api/admin/employees/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", hourlyRate: 12.5, yapePhone: "+51 987 654 321" }),
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(savedBody.hourlyRate, 12.5);
    assert.equal(savedBody.yapePhone, "987654321");
    assert.equal(JSON.stringify(savedBody).includes("pinHash"), false);
    assert.equal(db.employees[0].name, "Ana López");
    assert.equal(db.employees[0].employeeCode, "VIC-001");
    assert.equal(db.employees[0].active, true);
    assert.equal(db.employees[0].pinHash, "hash-privado");
    assert.equal(db.employees[0].createdAt?.toISOString(), createdAt.toISOString());
    assert.equal(db.attendances.length, 1);

    await db.setEmployeeActive("ana-1", false);
    assert.equal(db.employees[0].hourlyRate, 12.5);
    assert.equal(db.employees[0].yapePhone, "987654321");
    assert.equal(db.employees[0].pinHash, "hash-privado");

    const cleared = await fetch(`${base}/api/admin/employees/pay`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ employeeId: "ana-1", hourlyRate: 12.5, yapePhone: "" }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(db.employees[0].yapePhone, undefined);
    assert.equal(db.employees[0].hourlyRate, 12.5);
    assert.equal(db.employees[0].name, "Ana López");
  } finally {
    server.close();
  }
});

test("la marcación de entrada y salida sigue igual", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "secreto", hourlyRate: 10 });
  let clock = new Date("2026-10-13T15:00:00.000Z");
  const { server, base } = await listen(createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    now: () => clock,
  }));
  try {
    const entry = await fetch(`${base}/api/attendance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ana López", action: "entrada" }),
    });
    const entryBody = await entry.json();
    assert.equal(entry.status, 200);
    assert.equal(entryBody.action, "entrada");
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].status, "open");
    assert.equal(db.attendances[0].checkOutAt, undefined);

    const repeated = await fetch(`${base}/api/attendance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ana López", action: "entrada" }),
    });
    assert.equal(repeated.status, 409);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].status, "open");

    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    const exit = await fetch(`${base}/api/attendance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ana López", action: "salida" }),
    });
    const exitBody = await exit.json();
    assert.equal(exit.status, 200);
    assert.equal(exitBody.action, "salida");
    assert.match(exitBody.message, /Tiempo trabajado: 1h 0m/);
    assert.equal(db.attendances[0].status, "closed");
    assert.equal(db.attendances[0].workedMinutes, 60);
    assert.equal(db.employees[0].pinHash, "secreto");
    assert.equal(db.employees[0].hourlyRate, 10);
    assert.equal(db.employees[0].name, "Ana López");
    assert.equal(db.weeklyPayments.length, 0);
  } finally {
    server.close();
  }
});

test("la consulta semanal usa el lunes de Perú y la ventana de entradas", () => {
  const sundayNight = lima(2026, 10, 18, 23);
  const mondayStart = lima(2026, 10, 19, 0);
  assert.equal(weekContaining(sundayNight).weekStartKey, "2026-10-12");
  assert.equal(weekContaining(mondayStart).weekStartKey, "2026-10-19");
  assert.equal(weekBoundsFromKey("2026-10-14"), null);

  const db = new MemoryDatabase();
  const inside = shift({ id: "dentro", checkInAt: new Date(week.weekStart.getTime() - 2 * 60 * 60 * 1000) });
  const outside = shift({ id: "fuera", checkInAt: new Date(week.weekStart.getTime() - SETTLEMENT_LOOKBACK_MS - 1) });
  db.attendances.push(inside, outside);
  return db.listSettlementAttendances(new Date(week.weekStart.getTime() - SETTLEMENT_LOOKBACK_MS), week.weekEnd).then((rows) => {
    assert.deepEqual(rows.map((row) => row.id), ["dentro"]);
  });
});
