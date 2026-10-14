import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryAuthDirectory, MemoryAccountStore, type MemoryAccount } from "../src/memory-accounts.js";
import { MemoryDatabase } from "../src/memory-db.js";
import { PUBLISHED_WEB_ORIGIN, resolveAllowedOrigins } from "../src/origins.js";
import type { TokenVerifier } from "../src/types.js";

const verifyToken: TokenVerifier = async (idToken: string) => {
  if (idToken === "admin-token") return { uid: "admin-1", admin: true, email: "admin@example.com" };
  if (idToken === "staff-token") return { uid: "staff-1", admin: false, email: "staff@example.com" };
  if (idToken === "account-token") return { uid: "account-2", admin: false, email: "cuenta@example.com" };
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

    const listedAgain = await fetch(`${base}/api/admin/employees`, { headers: { authorization: "Bearer admin-token" } });
    const listedAgainBody = await listedAgain.json();
    const createdEmployee = listedAgainBody.employees.find((employee: { employeeCode?: string }) => employee.employeeCode === "VIC-020");
    assert.equal(listedAgain.status, 200);
    assert.equal(typeof createdEmployee.createdAt, "string");
    assert.equal(JSON.stringify(listedAgainBody).includes("pinHash"), false);
    assert.equal(JSON.stringify(listedAgainBody).includes("1234"), false);

    const duplicate = await fetch(`${base}/api/admin/employees`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ name: "Mario Quispe", employeeCode: "VIC-020", pin: "5678" }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).message, "Ese código de trabajador ya existe.");
    assert.equal(db.employees.filter((employee) => employee.employeeCode === "VIC-020").length, 1);
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
  const files = ["../src/App.tsx", "../src/firebase.ts", "../src/AdminDashboard.tsx", "../src/AccountsPanel.tsx", "../src/StaffPanel.tsx"];
  const combined = files.map((file) => readFileSync(resolve(process.cwd(), file), "utf8")).join("\n");
  for (const forbidden of ["addDoc", "setDoc", "updateDoc", "deleteDoc", "writeBatch", "httpsCallable", "getFirestore", "collection("]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
  const appSource = readFileSync(resolve(process.cwd(), "../src/App.tsx"), "utf8");
  const firebaseSource = readFileSync(resolve(process.cwd(), "../src/firebase.ts"), "utf8");
  assert.equal(appSource.includes("/api/attendance"), true);
  assert.equal(appSource.includes("/api/admin/session"), true);
  assert.equal(firebaseSource.includes("VITE_API_BASE_URL"), true);
});

const accountNow = new Date("2026-10-11T18:00:00.000Z");
const accountPassword = "clave-secreta-99";

function sampleAccount(uid: string, name: string, email: string, active = true, role = "admin"): MemoryAccount {
  return { uid, name, email, role, active, createdAt: accountNow, updatedAt: accountNow };
}

function accountsApp(db: MemoryDatabase, store: MemoryAccountStore, directory: MemoryAuthDirectory | null = null) {
  return createApp({
    database: db,
    verifyToken,
    accounts: store,
    authDirectory: directory,
    allowedOrigins: ["http://localhost:5174"],
    now: () => accountNow,
  });
}

test("accounts autoriza por documento o, si no existe, por el claim", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "hash-privado" });
  const store = new MemoryAccountStore();
  const { server, base } = await listen(accountsApp(db, store));
  try {
    const anonymous = await fetch(`${base}/api/admin/session`);
    assert.equal(anonymous.status, 401);

    const legacy = await fetch(`${base}/api/admin/session`, { headers: { authorization: "Bearer admin-token" } });
    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), {
      uid: "admin-1",
      name: null,
      email: "admin@example.com",
      role: "admin",
      active: true,
      source: "claim",
    });

    store.accounts.push(sampleAccount("account-2", "Cuenta Nueva", "cuenta@example.com"));
    const byAccount = await fetch(`${base}/api/admin/employees`, { headers: { authorization: "Bearer account-token" } });
    assert.equal(byAccount.status, 200);

    store.accounts.push(sampleAccount("admin-1", "Admin Actual", "admin@example.com", false));
    const inactive = await fetch(`${base}/api/admin/attendances`, { headers: { authorization: "Bearer admin-token" } });
    assert.equal(inactive.status, 403);

    store.accounts[1].active = true;
    store.accounts[1].role = "employee";
    const wrongRole = await fetch(`${base}/api/admin/employees`, { headers: { authorization: "Bearer admin-token" } });
    assert.equal(wrongRole.status, 403);

    const marked = await postAttendance(base, { name: "Ana López", action: "entrada" });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.action, "entrada");
    assert.equal(db.attendances.length, 1);
    assert.equal(db.employees[0].pinHash, "hash-privado");
  } finally {
    server.close();
  }
});

test("la alta de cuentas no guarda contraseñas ni toca employees o attendances", async () => {
  const db = new MemoryDatabase();
  db.employees.push({ id: "ana-1", name: "Ana López", employeeCode: "VIC-001", active: true, pinHash: "hash-privado" });
  db.attendances.push({
    id: "att-1",
    employeeId: "ana-1",
    employeeCode: "VIC-001",
    employeeName: "Ana López",
    status: "open",
    checkInAt: accountNow,
    createdAt: accountNow,
  });
  const employeesBefore = structuredClone(db.employees);
  const attendancesBefore = structuredClone(db.attendances);
  const store = new MemoryAccountStore();
  const directory = new MemoryAuthDirectory();
  directory.users.push({ uid: "previo", email: "previo@example.com", password: "otra-clave", claims: { locale: "es" } });
  await directory.setAdminClaim("previo");
  const { server, base } = await listen(accountsApp(db, store, directory));
  const headers = { "content-type": "application/json", authorization: "Bearer admin-token" };
  try {
    const denied = await fetch(`${base}/api/admin/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer staff-token" },
      body: JSON.stringify({ name: "Otra Persona", email: "otra@example.com", password: accountPassword, role: "admin" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(store.accounts.length, 0);
    assert.equal(directory.users.length, 1);

    const created = await fetch(`${base}/api/admin/accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "  Nueva   Admin ",
        email: "Nueva@Example.com",
        password: accountPassword,
        role: "employee",
        active: false,
      }),
    });
    const body = await created.json();
    assert.equal(created.status, 201);
    assert.equal(body.role, "admin");
    assert.equal(body.active, true);
    assert.equal(body.email, "nueva@example.com");
    assert.equal(body.name, "Nueva Admin");
    assert.equal(JSON.stringify(body).includes(accountPassword), false);
    assert.equal(JSON.stringify(store.accounts).includes(accountPassword), false);
    assert.deepEqual(Object.keys(store.accounts[0]).sort(), ["active", "createdAt", "email", "name", "role", "uid", "updatedAt"]);
    const createdUser = directory.users.find((user) => user.email === "nueva@example.com");
    assert.equal(createdUser?.password, accountPassword);
    assert.equal(createdUser?.claims.admin, true);
    assert.deepEqual(directory.users[0].claims, { locale: "es", admin: true });

    const duplicate = await fetch(`${base}/api/admin/accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Repetida", email: "nueva@example.com", password: accountPassword }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(directory.users.filter((user) => user.email === "nueva@example.com").length, 1);

    store.failCreateMessage = "fallo interno de prueba";
    const rolledBack = await fetch(`${base}/api/admin/accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Rollback Admin", email: "rollback@example.com", password: accountPassword }),
    });
    const rolledBody = await rolledBack.json();
    assert.equal(rolledBack.status, 503);
    assert.equal(JSON.stringify(rolledBody).includes("fallo interno"), false);
    assert.equal(JSON.stringify(rolledBody).includes(accountPassword), false);
    assert.equal(directory.users.some((user) => user.email === "rollback@example.com"), false);
    assert.equal(store.accounts.some((account) => account.email === "rollback@example.com"), false);

    assert.deepEqual(db.employees, employeesBefore);
    assert.deepEqual(db.attendances, attendancesBefore);
  } finally {
    server.close();
  }
});

test("no se puede desactivar al último administrador activo", async () => {
  const db = new MemoryDatabase();
  const store = new MemoryAccountStore();
  store.accounts.push(
    sampleAccount("admin-a", "Ana Admin", "ana.admin@example.com"),
    sampleAccount("admin-b", "Beto Admin", "beto.admin@example.com"),
  );
  const directory = new MemoryAuthDirectory();
  const { server, base } = await listen(accountsApp(db, store, directory));
  const headers = { "content-type": "application/json", authorization: "Bearer admin-token" };
  try {
    const responses = await Promise.all([
      fetch(`${base}/api/admin/accounts/active`, { method: "POST", headers, body: JSON.stringify({ uid: "admin-a", active: false, role: "employee" }) }),
      fetch(`${base}/api/admin/accounts/active`, { method: "POST", headers, body: JSON.stringify({ uid: "admin-b", active: false }) }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(store.accounts.filter((account) => account.active).length, 1);
    assert.equal(store.accounts.every((account) => account.role === "admin"), true);

    const remaining = store.accounts.find((account) => account.active);
    assert.ok(remaining);
    const blocked = await fetch(`${base}/api/admin/accounts/active`, {
      method: "POST",
      headers,
      body: JSON.stringify({ uid: remaining.uid, active: false }),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).message, "Debe quedar al menos un administrador activo.");
    assert.equal(store.accounts.find((account) => account.uid === remaining.uid)?.active, true);
    assert.equal(db.employees.length, 0);
    assert.equal(db.attendances.length, 0);
  } finally {
    server.close();
  }
});

test("el almacén de cuentas no referencia employees ni attendances", () => {
  const source = readFileSync(resolve(process.cwd(), "src/accounts.ts"), "utf8");
  assert.equal(source.includes("employees"), false);
  assert.equal(source.includes("attendances"), false);
  assert.equal(source.includes('collection("accounts")'), true);
});
