import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as bcrypt from "bcryptjs";

initializeApp();
const db = getFirestore();

function requireAdmin(request: { auth?: { uid: string; token: Record<string, unknown> } | null }) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Se requiere permiso de administrador.");
  }
}

function normalizeName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

type EmployeeMatch = { id: string; name: string; employeeCode: string };

export const recordAttendance = onCall({ region: "southamerica-east1", maxInstances: 10 }, async (request) => {
  const name = String(request.data?.name ?? "").trim().replace(/\s+/g, " ");
  const employeeId = String(request.data?.employeeId ?? "").trim();
  if (name.length < 2 || name.length > 100) {
    throw new HttpsError("invalid-argument", "Ingresa tu nombre completo.");
  }
  if (employeeId.includes("/") || employeeId.length > 128) {
    throw new HttpsError("invalid-argument", "El trabajador seleccionado no es válido.");
  }

  const snap = await db.collection("employees").where("active", "==", true).select("name", "employeeCode").get();
  const wanted = normalizeName(name);
  const matches: EmployeeMatch[] = [];
  for (const doc of snap.docs) {
    const employeeName = doc.get("name");
    const employeeCode = doc.get("employeeCode");
    if (typeof employeeName !== "string" || typeof employeeCode !== "string") continue;
    if (normalizeName(employeeName) !== wanted) continue;
    matches.push({ id: doc.id, name: employeeName, employeeCode });
  }

  if (matches.length === 0) {
    throw new HttpsError("not-found", "No encontramos un trabajador registrado con ese nombre.");
  }

  let employee: EmployeeMatch;
  if (matches.length > 1 && !employeeId) {
    return {
      ok: false,
      message: "Hay varios trabajadores con ese nombre. Selecciona el correcto.",
      employees: matches.map((match) => ({
        id: match.id,
        name: match.name,
        employeeCode: match.employeeCode,
        active: true,
      })),
    };
  }
  if (employeeId) {
    const selected = matches.find((match) => match.id === employeeId);
    if (!selected) {
      throw new HttpsError("invalid-argument", "El trabajador seleccionado no coincide con el nombre ingresado.");
    }
    employee = selected;
  } else {
    employee = matches[0];
  }

  const openSnap = await db.collection("attendances")
    .where("employeeId", "==", employee.id)
    .where("status", "==", "open")
    .limit(2)
    .get();
  const now = Timestamp.now();

  if (openSnap.empty) {
    const ref = db.collection("attendances").doc();
    await ref.create({
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      employeeName: employee.name,
      status: "open",
      checkInAt: now,
      createdAt: now,
    });
    return {
      ok: true,
      action: "entrada",
      employeeName: employee.name,
      timestamp: now.toDate().toISOString(),
      message: `Entrada registrada. ¡Buen trabajo, ${employee.name}!`,
    };
  }

  if (openSnap.size > 1) {
    throw new HttpsError("failed-precondition", "Hay más de una jornada abierta. Contacta al administrador.");
  }

  const openDoc = openSnap.docs[0];
  const checkIn = openDoc.get("checkInAt");
  if (!(checkIn instanceof Timestamp)) {
    throw new HttpsError("failed-precondition", "La jornada abierta no tiene una hora de entrada válida. Contacta al administrador.");
  }
  const workedMinutes = Math.max(0, Math.floor((now.toMillis() - checkIn.toMillis()) / 60000));
  await openDoc.ref.update({ status: "closed", checkOutAt: now, workedMinutes, updatedAt: now });
  return {
    ok: true,
    action: "salida",
    employeeName: employee.name,
    timestamp: now.toDate().toISOString(),
    message: `Salida registrada para ${employee.name}. Tiempo trabajado: ${Math.floor(workedMinutes / 60)}h ${workedMinutes % 60}m.`,
  };
});

export const createEmployee = onCall({ region: "southamerica-east1", maxInstances: 5 }, async (request) => {
  requireAdmin(request);
  const name = String(request.data?.name ?? "").trim();
  const employeeCode = String(request.data?.employeeCode ?? "").trim().toUpperCase();
  const pin = String(request.data?.pin ?? "");
  if (name.length < 2 || name.length > 100 || !/^[A-Z0-9-]{3,20}$/.test(employeeCode) || !/^\d{4,8}$/.test(pin)) {
    throw new HttpsError("invalid-argument", "Nombre, código o PIN no válidos. El PIN debe tener de 4 a 8 dígitos.");
  }
  const existing = await db.collection("employees").where("employeeCode","==",employeeCode).limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists","Ese código de trabajador ya existe.");
  const pinHash = await bcrypt.hash(pin, 12);
  const ref = await db.collection("employees").add({ name, employeeCode, pinHash, active: true, createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id, name, employeeCode, active: true };
});

export const listEmployees = onCall({ region: "southamerica-east1", maxInstances: 5 }, async (request) => {
  requireAdmin(request);
  const snap = await db.collection("employees").orderBy("name").get();
  return { employees: snap.docs.map(d => ({ id:d.id, name:d.get("name"), employeeCode:d.get("employeeCode"), active:d.get("active") })) };
});

export const listAttendances = onCall({ region: "southamerica-east1", maxInstances: 5 }, async (request) => {
  requireAdmin(request);
  const snap = await db.collection("attendances").orderBy("createdAt","desc").limit(500).get();
  return { attendances: snap.docs.map(d => {
    const x = d.data();
    return { id:d.id, employeeName:x.employeeName, employeeCode:x.employeeCode, status:x.status, checkInAt:x.checkInAt?.toDate().toISOString() ?? null, checkOutAt:x.checkOutAt?.toDate().toISOString() ?? null, workedMinutes:x.workedMinutes ?? null };
  }) };
});

export const setEmployeeActive = onCall({ region: "southamerica-east1", maxInstances: 5 }, async (request) => {
  requireAdmin(request);
  const id = String(request.data?.employeeId ?? "");
  const active = request.data?.active;
  if (!id || typeof active !== "boolean") throw new HttpsError("invalid-argument","Datos no válidos.");
  const ref = db.collection("employees").doc(id);
  await ref.update({ active, updatedAt: FieldValue.serverTimestamp() });
  return { ok:true };
});