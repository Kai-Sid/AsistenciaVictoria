import { HttpError } from "./http-error.js";
import { collapseName, normalizeName } from "./names.js";
import type { AttendanceChoice, AttendanceDatabase, AttendanceSuccess, EmployeeMatch } from "./types.js";

const NOT_FOUND = "No encontramos un trabajador registrado con ese nombre.";
const CHOOSE = "Hay varios trabajadores con ese nombre. Selecciona el correcto.";
const ALREADY_OPEN = "Ya tienes una jornada abierta. Registra tu salida cuando termines.";
const NO_OPEN = "No hay una jornada abierta. Registra tu entrada primero.";

export type AttendanceAction = "entrada" | "salida";

export function parseAttendanceInput(body: unknown): { name: string; employeeId: string; action: AttendanceAction } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "La solicitud no es válida.");
  }
  const record = body as { name?: unknown; employeeId?: unknown; action?: unknown };
  const name = collapseName(String(record.name ?? ""));
  const employeeId = record.employeeId == null ? "" : String(record.employeeId).trim();
  if (name.length < 2 || name.length > 100) {
    throw new HttpError(400, "Ingresa tu nombre completo.");
  }
  if (employeeId.includes("/") || employeeId.length > 128 || /[\u0000-\u001f]/.test(employeeId)) {
    throw new HttpError(400, "El trabajador seleccionado no es válido.");
  }
  if (record.action !== "entrada" && record.action !== "salida") {
    throw new HttpError(400, "La acción no es válida. Usa entrada o salida.");
  }
  return { name, employeeId, action: record.action };
}

function workedLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export async function recordAttendance(
  db: AttendanceDatabase,
  input: { name: string; employeeId: string; action: AttendanceAction },
  now: Date,
): Promise<AttendanceSuccess | AttendanceChoice> {
  const wanted = normalizeName(input.name);
  const active = await db.listActiveEmployees();
  const matches: EmployeeMatch[] = [];
  for (const employee of active) {
    if (typeof employee.name !== "string" || typeof employee.employeeCode !== "string") continue;
    if (normalizeName(employee.name) !== wanted) continue;
    matches.push({ id: employee.id, name: employee.name, employeeCode: employee.employeeCode });
  }

  if (matches.length === 0) throw new HttpError(404, NOT_FOUND);

  if (matches.length > 1 && !input.employeeId) {
    return {
      ok: false,
      message: CHOOSE,
      employees: matches
        .slice()
        .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
        .map((match) => ({ ...match, active: true })),
    };
  }

  const employee = input.employeeId
    ? matches.find((match) => match.id === input.employeeId)
    : matches[0];
  if (!employee) {
    throw new HttpError(400, "El trabajador seleccionado no coincide con el nombre ingresado.");
  }

  return db.runAttendanceTransaction(async (tx) => {
    const current = await tx.getEmployee(employee.id);
    if (!current || current.active !== true || normalizeName(current.name) !== wanted) {
      throw new HttpError(404, NOT_FOUND);
    }
    const open = await tx.listOpenAttendances(employee.id);
    if (open.length > 1) {
      throw new HttpError(409, "Hay más de una jornada abierta. Contacta al administrador.");
    }

    if (input.action === "entrada") {
      if (open.length > 0) throw new HttpError(409, ALREADY_OPEN);
      tx.createOpenAttendance({
        employeeId: current.id,
        employeeCode: current.employeeCode,
        employeeName: current.name,
        checkInAt: now,
        createdAt: now,
      });
      tx.touchEmployee(current.id, now);
      return {
        ok: true as const,
        action: "entrada" as const,
        employeeName: current.name,
        timestamp: now.toISOString(),
        message: `Entrada registrada. ¡Buen trabajo, ${current.name}!`,
      };
    }

    if (open.length === 0) throw new HttpError(409, NO_OPEN);
    const shift = open[0];
    if (!(shift.checkInAt instanceof Date) || Number.isNaN(shift.checkInAt.getTime())) {
      throw new HttpError(409, "La jornada abierta no tiene una hora de entrada válida. Contacta al administrador.");
    }
    const workedMinutes = Math.max(0, Math.floor((now.getTime() - shift.checkInAt.getTime()) / 60000));
    tx.closeAttendance(shift.id, { checkOutAt: now, workedMinutes, updatedAt: now });
    tx.touchEmployee(current.id, now);
    return {
      ok: true as const,
      action: "salida" as const,
      employeeName: current.name,
      timestamp: now.toISOString(),
      message: `Salida registrada para ${current.name}. Tiempo trabajado: ${workedLabel(workedMinutes)}.`,
    };
  });
}
