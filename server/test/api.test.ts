import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryDatabase } from "../src/memory-db.js";
import { PUBLISHED_WEB_ORIGIN, resolveAllowedOrigins } from "../src/origins.js";
import type { TokenVerifier } from "../src/types.js";

const verifyToken: TokenVerifier = async (idToken: string) => {
  if (idToken === "admin-token") return { uid: "admin-1", admin: true };
  if (idToken === "staff-token") return { uid: "staff-1", admin: false };
  throw new Error("token inválido");
};

function hoursBefore(date: Date, hours: number): Date {
  return new Date(date.getTime() - hours * 60 * 60 * 1000);
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
  };
}

test("GET /api/health responde aunque Firestore no esté configurado", async () => {
  const app = createApp({ database: null, verifyToken: null, allowedOrigins: ["http://localhost:5174"] });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, firestore: false, reason: "not-configured" });
  } finally {
    server.close();
  }
});

const fixedNow = new Date("2026-10-11T18:00:00.000Z");

async function postAttendance(base: string, body: unknown) {
  const response = await fetch(`${base}/api/attendance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function attendanceApp(db: MemoryDatabase, now = fixedNow) {
  return createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
    now: () => now,
  });
}

test("rechaza el nombre vacío o compuesto solo por espacios", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true });
  const { server, base } = await listen(attendanceApp(db));
  try {
    for (const name of ["", "   ", " \n\t "]) {
      const result = await postAttendance(base, { name, action: "entrada" });
      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.message, "Ingresa tu nombre completo.");
    }
    assert.equal(db.attendances.length, 0);
  } finally {
    server.close();
  }
});

test("rechaza un trabajador inexistente", async () => {
  const db = new MemoryDatabase();
  const { server, base } = await listen(attendanceApp(db));
  try {
    const result = await postAttendance(base, { name: "Persona Inexistente", action: "entrada" });
    assert.equal(result.status, 404);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.message, "No encontramos un trabajador registrado con ese nombre.");
    assert.equal(db.attendances.length, 0);
  } finally {
    server.close();
  }
});

test("rechaza un trabajador inactivo", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "inactivo", name: "Luis Ramos", employeeCode: "VIC-009", active: false, pinHash: "no-visible" });
  const { server, base } = await listen(attendanceApp(db));
  try {
    const entry = await postAttendance(base, { name: "Luis Ramos", action: "entrada" });
    const exit = await postAttendance(base, { name: "luis ramos", action: "salida" });
    assert.equal(entry.status, 404);
    assert.equal(exit.status, 404);
    assert.equal(entry.body.ok, false);
    assert.equal(JSON.stringify(entry.body).includes("pinHash"), false);
    assert.equal(JSON.stringify(entry.body).includes("no-visible"), false);
    assert.equal(db.attendances.length, 0);
  } finally {
    server.close();
  }
});

test("registra la entrada y rechaza una segunda entrada sin convertirla en salida", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "secreto" });
  const { server, base } = await listen(attendanceApp(db));
  try {
    const entry = await postAttendance(base, { name: "ana   lópez", action: "entrada" });
    assert.equal(entry.status, 200);
    assert.equal(entry.body.ok, true);
    assert.equal(entry.body.action, "entrada");
    assert.equal(entry.body.employeeName, "Ana López");
    assert.match(entry.body.message, /Entrada registrada/);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].status, "open");
    assert.equal(db.attendances[0].employeeId, "ana-1");
    assert.ok(db.attendances[0].checkInAt instanceof Date);
    assert.equal(db.attendances[0].checkOutAt, undefined);
    assert.equal("pinHash" in db.attendances[0], false);

    const duplicate = await postAttendance(base, { name: "Ana López", action: "entrada" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.ok, false);
    assert.match(duplicate.body.message, /jornada abierta/);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].status, "open");
    assert.equal(db.attendances[0].checkOutAt, undefined);
  } finally {
    server.close();
  }
});

test("rechaza la salida sin entrada y cierra la jornada abierta cuando existe", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true });
  const { server, base } = await listen(attendanceApp(db));
  try {
    const missing = await postAttendance(base, { name: "Ana López", action: "salida" });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.ok, false);
    assert.match(missing.body.message, /No hay una jornada abierta/);
    assert.equal(db.attendances.length, 0);

    const entry = await postAttendance(base, { name: "Ana López", action: "entrada" });
    assert.equal(entry.body.action, "entrada");
    db.attendances[0].checkInAt = hoursBefore(fixedNow, 2);

    const exit = await postAttendance(base, { name: "Ana López", action: "salida" });
    assert.equal(exit.status, 200);
    assert.equal(exit.body.ok, true);
    assert.equal(exit.body.action, "salida");
    assert.match(exit.body.message, /Salida registrada para Ana López/);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].status, "closed");
    assert.equal(db.attendances[0].workedMinutes, 120);
    assert.ok(db.attendances[0].checkOutAt instanceof Date);
    assert.ok(db.attendances[0].updatedAt instanceof Date);

    const again = await postAttendance(base, { name: "Ana López", action: "salida" });
    assert.equal(again.status, 409);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].status, "closed");
  } finally {
    server.close();
  }
});

test("dos solicitudes de entrada simultáneas dejan una sola jornada abierta", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "sofia", name: "Sofía Díaz", employeeCode: "VIC-010", active: true });
  const { server, base } = await listen(attendanceApp(db, new Date("2026-10-11T18:30:00.000Z")));
  try {
    const responses = await Promise.all([
      postAttendance(base, { name: "Sofia Diaz", action: "entrada" }),
      postAttendance(base, { name: "Sofia Diaz", action: "entrada" }),
    ]);
    const statuses = responses.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(responses.filter((result) => result.body.ok === true && result.body.action === "entrada").length, 1);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances.filter((row) => row.status === "open").length, 1);
    assert.equal(db.attendances.filter((row) => row.status === "closed").length, 0);
  } finally {
    server.close();
  }
});

test("rechaza una acción desconocida", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true });
  const { server, base } = await listen(attendanceApp(db));
  try {
    for (const action of [undefined, "", "ENTRADA", "toggle", 1]) {
      const result = await postAttendance(base, { name: "Ana López", action });
      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.message, "La acción no es válida. Usa entrada o salida.");
    }
    assert.equal(db.attendances.length, 0);
  } finally {
    server.close();
  }
});

test("los homónimos exigen elegir al trabajador y no marcan a otra persona", async () => {
  const db = new MemoryDatabase();
  db.employees.push(
    { id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "secreto" },
    { id: "ana-2", name: "Ana Lopez", employeeCode: "VIC-002", active: true, pinHash: "otro-secreto" },
    { id: "mario", name: "Mario Quispe", employeeCode: "VIC-003", active: true },
  );
  const { server, base } = await listen(attendanceApp(db));
  try {
    const choice = await postAttendance(base, { name: "ana   lópez", action: "salida" });
    assert.equal(choice.status, 200);
    assert.equal(choice.body.ok, false);
    assert.equal(choice.body.employees.length, 2);
    assert.deepEqual(choice.body.employees.map((person: { id: string }) => person.id).sort(), ["ana-1", "ana-2"]);
    assert.equal(JSON.stringify(choice.body).includes("pinHash"), false);
    assert.equal(JSON.stringify(choice.body).includes("secreto"), false);
    assert.equal(db.attendances.length, 0);

    const wrong = await postAttendance(base, { name: "Ana López", employeeId: "mario", action: "entrada" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.message, /no coincide/);
    assert.equal(db.attendances.length, 0);

    const selected = await postAttendance(base, { name: "Ana López", employeeId: "ana-2", action: "entrada" });
    assert.equal(selected.status, 200);
    assert.equal(selected.body.ok, true);
    assert.equal(selected.body.action, "entrada");
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].employeeId, "ana-2");
    assert.equal(db.attendances[0].employeeCode, "VIC-002");
    assert.equal(db.attendances[0].status, "open");

    const otherExit = await postAttendance(base, { name: "Ana López", employeeId: "ana-1", action: "salida" });
    assert.equal(otherExit.status, 409);
    assert.equal(db.attendances.length, 1);
    assert.equal(db.attendances[0].employeeId, "ana-2");
    assert.equal(db.attendances[0].status, "open");
  } finally {
    server.close();
  }
});

test("los endpoints administrativos exigen el claim admin y no devuelven pinHash", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "hash-privado" });
  const app = createApp({
    database: db,
    verifyToken,
    allowedOrigins: ["http://localhost:5174"],
  });
  const { server, base } = await listen(app);
  try {
    const anonymous = await fetch(`${base}/api/admin/attendances`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).message, "Se requiere permiso de administrador.");

    const staff = await fetch(`${base}/api/admin/employees`, { headers: { authorization: "Bearer staff-token" } });
    assert.equal(staff.status, 403);

    const invalid = await fetch(`${base}/api/admin/employees`, { headers: { authorization: "Bearer falso" } });
    assert.equal(invalid.status, 401);

    const employees = await fetch(`${base}/api/admin/employees`, { headers: { authorization: "Bearer admin-token" } });
    const listed = await employees.json();
    assert.equal(employees.status, 200);
    assert.equal(JSON.stringify(listed).includes("pinHash"), false);
    assert.equal(JSON.stringify(listed).includes("hash-privado"), false);

    const created = await fetch(`${base}/api/admin/employees`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ name: "Mario Quispe", employeeCode: "vic-020", pin: "1234" }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdBody.employeeCode, "VIC-020");
    assert.equal(createdBody.pin, undefined);
    assert.equal(JSON.stringify(createdBody).includes("pinHash"), false);
    assert.equal(db.employees.some((employee) => employee.employeeCode === "VIC-020" && typeof employee.pinHash === "string"), true);

    const disabled = await fetch(`${base}/api/admin/employees/active`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ employeeId: createdBody.id, active: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal(db.employees.find((employee) => employee.id === createdBody.id)?.active, false);
  } finally {
    server.close();
  }
});

test("CORS solo autoriza el origen configurado", async () => {
  const app = createApp({ database: null, verifyToken: null, allowedOrigins: ["http://localhost:5174"] });
  const { server, base } = await listen(app);
  try {
    const allowed = await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5174" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5174");
    const blocked = await fetch(`${base}/api/attendance`, { method: "OPTIONS", headers: { origin: "https://otro.example" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("el frontend publicado queda autorizado aunque ALLOWED_ORIGINS sea solo local", async () => {
  const origins = resolveAllowedOrigins("http://localhost:5174");
  assert.deepEqual(origins, ["http://localhost:5174", PUBLISHED_WEB_ORIGIN]);
  assert.deepEqual(resolveAllowedOrigins(undefined), ["http://localhost:5174", PUBLISHED_WEB_ORIGIN]);
  const app = createApp({ database: null, verifyToken: null, allowedOrigins: origins });
  const { server, base } = await listen(app);
  try {
    const preflight = await fetch(`${base}/api/attendance`, {
      method: "OPTIONS",
      headers: {
        origin: PUBLISHED_WEB_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), PUBLISHED_WEB_ORIGIN);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i);
    const blocked = await fetch(`${base}/api/attendance`, {
      method: "OPTIONS",
      headers: { origin: "https://asistenciavictoria.onrender.com", "access-control-request-method": "POST" },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("una escritura fallida no confirma la marcación", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true });
  db.runAttendanceTransaction = async () => {
    throw new Error("firestore unavailable");
  };
  const app = createApp({ database: db, verifyToken, allowedOrigins: ["http://localhost:5174"] });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/attendance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ana López", action: "entrada" }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.match(body.message, /No se guardó ninguna asistencia/);
    assert.equal(JSON.stringify(body).includes("firestore unavailable"), false);
    assert.equal(db.attendances.length, 0);
  } finally {
    server.close();
  }
});

test("el frontend no escribe asistencias ni llama Cloud Functions", () => {
  const appSource = readFileSync(resolve(process.cwd(), "../src/App.tsx"), "utf8");
  const firebaseSource = readFileSync(resolve(process.cwd(), "../src/firebase.ts"), "utf8");
  const combined = `${appSource}\n${firebaseSource}`;
  for (const forbidden of ["addDoc", "setDoc", "updateDoc", "deleteDoc", "writeBatch", "httpsCallable", "getFirestore", "collection("]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
  assert.equal(appSource.includes("/api/attendance"), true);
  assert.equal(firebaseSource.includes("VITE_API_BASE_URL"), true);
});
