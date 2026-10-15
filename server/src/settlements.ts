import { HttpError } from "./http-error.js";
import type { AttendanceDoc } from "./types.js";

/** Perú permanece en UTC−5. El lunes empieza a las 00:00 de America/Lima. */
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Una jornada que empezó antes del lunes solo entra en la consulta si su entrada
 * cae dentro de esta ventana. Cubre el cruce de medianoche y el del domingo al lunes.
 * Si la entrada es anterior, no se reparte un tramo inventado.
 */
export const SETTLEMENT_LOOKBACK_MS = 48 * 60 * 60 * 1000;

const MAX_HOURLY_RATE_CENTS = 999_999;

export type WeekBounds = {
  weekStart: Date;
  weekEnd: Date;
  weekStartKey: string;
  weekEndKey: string;
};

export type SettlementShift = {
  attendanceId: string;
  checkInAt: string;
  checkOutAt: string;
  minutes: number;
};

export type SettlementExclusionReason = "open" | "invalid" | "duplicate" | "non-positive";

export type SettlementExclusion = {
  attendanceId: string;
  reason: SettlementExclusionReason;
};

export type SettlementView = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  hourlyRate: number | null;
  amount: number | null;
  currency: "PEN";
  status: "confirmed" | "pending" | "missing-rate";
  yapePhone: string | null;
  shifts: SettlementShift[];
  excluded: SettlementExclusion[];
};

export type WeeklyPaymentDraft = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  hourlyRate: number;
  amount: number;
  currency: "PEN";
  yapePhone: string | null;
  shifts: SettlementShift[];
};

export type EmployeePay = {
  id: string;
  name: string;
  employeeCode: string;
  hourlyRate: number | null;
  yapePhone: string | null;
};

type Classified = {
  included: SettlementShift[];
  excluded: SettlementExclusion[];
  totalMinutes: number;
};

export function settlementDocumentId(employeeId: string, weekStartKey: string): string {
  return `${employeeId}_${weekStartKey}`;
}

export function settlementAttendanceWindow(week: WeekBounds): { from: Date; to: Date } {
  return {
    from: new Date(week.weekStart.getTime() - SETTLEMENT_LOOKBACK_MS),
    to: week.weekEnd,
  };
}

export function limaCivil(date: Date): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(date.getTime() - LIMA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatLimaDate(date: Date): string {
  const parts = limaCivil(date);
  return dateKey(parts.year, parts.month, parts.day);
}

function mondayStart(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0));
}

export function weekContaining(instant: Date): WeekBounds {
  const parts = limaCivil(instant);
  const daysFromMonday = parts.weekday === 0 ? 6 : parts.weekday - 1;
  const weekStart = mondayStart(parts.year, parts.month, parts.day - daysFromMonday);
  return boundsFromMonday(weekStart);
}

export function weekBoundsFromKey(key: string): WeekBounds | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const weekStart = mondayStart(year, month, day);
  const civil = limaCivil(weekStart);
  if (civil.year !== year || civil.month !== month || civil.day !== day || civil.weekday !== 1) return null;
  return boundsFromMonday(weekStart);
}

function boundsFromMonday(weekStart: Date): WeekBounds {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const sunday = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
  return {
    weekStart,
    weekEnd,
    weekStartKey: formatLimaDate(weekStart),
    weekEndKey: formatLimaDate(sunday),
  };
}

/**
 * Cada minuto completo se asigna a la semana en la que empieza.
 * La duración total usa el mismo redondeo hacia abajo que el cierre de jornada,
 * y no se suma además workedMinutes.
 */
export function minutesStartingInWeek(checkIn: Date, checkOut: Date, weekStart: Date, weekEnd: Date): number | null {
  const startMs = checkIn.getTime();
  const endMs = checkOut.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const totalMinutes = Math.floor((endMs - startMs) / 60_000);
  if (totalMinutes <= 0) return 0;
  if (startMs >= weekEnd.getTime()) return 0;
  if (startMs + (totalMinutes - 1) * 60_000 < weekStart.getTime()) return 0;
  let first = 0;
  if (startMs < weekStart.getTime()) {
    first = Math.ceil((weekStart.getTime() - startMs) / 60_000);
  }
  let last = totalMinutes;
  if (startMs + totalMinutes * 60_000 > weekEnd.getTime()) {
    last = Math.min(totalMinutes, Math.ceil((weekEnd.getTime() - startMs) / 60_000));
  }
  if (first < 0) first = 0;
  if (last < first) return 0;
  return last - first;
}

export function amountCents(totalMinutes: number, hourlyRate: number): number {
  const rateCents = Math.round(hourlyRate * 100);
  return Math.round((totalMinutes * rateCents) / 60);
}

export function amountFromMinutes(totalMinutes: number, hourlyRate: number): number {
  return amountCents(totalMinutes, hourlyRate) / 100;
}

export function parseHourlyRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "La tarifa por hora debe ser un número mayor que cero.");
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw new HttpError(400, "La tarifa por hora admite como máximo dos decimales.");
  }
  if (cents <= 0 || cents > MAX_HOURLY_RATE_CENTS) {
    throw new HttpError(400, "La tarifa por hora debe ser mayor que cero y no superar S/ 9999.99.");
  }
  return cents / 100;
}

export function parseYapePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "").replace(/^00/, "");
  const national = digits.startsWith("51") && digits.length === 11 ? digits.slice(2) : digits;
  if (!/^9\d{8}$/.test(national)) {
    throw new HttpError(400, "El celular debe ser un número móvil de Perú de 9 dígitos.");
  }
  return national;
}

export function parsePayUpdate(body: unknown): { employeeId: string; hourlyRate: number; yapePhone: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Datos no válidos.");
  const record = body as { employeeId?: unknown; hourlyRate?: unknown; yapePhone?: unknown };
  const employeeId = String(record.employeeId ?? "").trim();
  if (!employeeId || employeeId.includes("/") || employeeId.length > 128) throw new HttpError(400, "Datos no válidos.");
  const hourlyRate = parseHourlyRate(record.hourlyRate);
  if (record.yapePhone == null || record.yapePhone === "") return { employeeId, hourlyRate, yapePhone: null };
  return { employeeId, hourlyRate, yapePhone: parseYapePhone(record.yapePhone) };
}

export function parseSettlementConfirm(body: unknown): { employeeId: string; weekStart: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Datos no válidos.");
  const record = body as { employeeId?: unknown; weekStart?: unknown };
  const employeeId = String(record.employeeId ?? "").trim();
  const weekStart = String(record.weekStart ?? "").trim();
  if (!employeeId || employeeId.includes("/") || employeeId.length > 128 || !weekBoundsFromKey(weekStart)) {
    throw new HttpError(400, "Datos no válidos.");
  }
  return { employeeId, weekStart };
}

function validDate(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function classifyShifts(attendances: AttendanceDoc[], weekStart: Date, weekEnd: Date): Classified {
  const included: SettlementShift[] = [];
  const excluded: SettlementExclusion[] = [];
  const seenIds = new Set<string>();
  const seenIntervals = new Set<string>();

  for (const attendance of attendances) {
    if (seenIds.has(attendance.id)) {
      excluded.push({ attendanceId: attendance.id, reason: "duplicate" });
      continue;
    }
    seenIds.add(attendance.id);

    if (attendance.status !== "closed") {
      if (!validDate(attendance.checkInAt) || attendance.checkInAt.getTime() >= weekEnd.getTime()) continue;
      excluded.push({ attendanceId: attendance.id, reason: "open" });
      continue;
    }

    if (!validDate(attendance.checkInAt) || !validDate(attendance.checkOutAt)) {
      excluded.push({ attendanceId: attendance.id, reason: "invalid" });
      continue;
    }

    const overlaps = attendance.checkOutAt.getTime() > weekStart.getTime() && attendance.checkInAt.getTime() < weekEnd.getTime();
    const minutes = minutesStartingInWeek(attendance.checkInAt, attendance.checkOutAt, weekStart, weekEnd);
    if (minutes == null || minutes <= 0) {
      if (overlaps) excluded.push({ attendanceId: attendance.id, reason: "non-positive" });
      continue;
    }

    const intervalKey = `${attendance.employeeId}|${attendance.checkInAt.getTime()}|${attendance.checkOutAt.getTime()}`;
    if (seenIntervals.has(intervalKey)) {
      excluded.push({ attendanceId: attendance.id, reason: "duplicate" });
      continue;
    }
    seenIntervals.add(intervalKey);
    included.push({
      attendanceId: attendance.id,
      checkInAt: attendance.checkInAt.toISOString(),
      checkOutAt: attendance.checkOutAt.toISOString(),
      minutes,
    });
  }

  const totalMinutes = included.reduce((sum, shift) => sum + shift.minutes, 0);
  return { included, excluded, totalMinutes };
}

function viewFromCalculation(
  employee: EmployeePay,
  attendanceName: { employeeName: string; employeeCode: string } | undefined,
  classified: Classified,
  week: WeekBounds,
): SettlementView {
  const hourlyRate = employee.hourlyRate;
  return {
    employeeId: employee.id,
    employeeCode: employee.employeeCode || attendanceName?.employeeCode || "",
    employeeName: employee.name || attendanceName?.employeeName || "",
    weekStart: week.weekStartKey,
    weekEnd: week.weekEndKey,
    totalMinutes: classified.totalMinutes,
    hourlyRate,
    amount: hourlyRate == null ? null : amountFromMinutes(classified.totalMinutes, hourlyRate),
    currency: "PEN",
    status: hourlyRate == null ? "missing-rate" : "pending",
    yapePhone: employee.yapePhone,
    shifts: classified.included,
    excluded: classified.excluded,
  };
}

export function settlementFromPayment(payment: {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  hourlyRate: number;
  amount: number;
  yapePhone: string | null;
  shifts: SettlementShift[];
}): SettlementView {
  return {
    employeeId: payment.employeeId,
    employeeCode: payment.employeeCode,
    employeeName: payment.employeeName,
    weekStart: payment.weekStart,
    weekEnd: payment.weekEnd,
    totalMinutes: payment.totalMinutes,
    hourlyRate: payment.hourlyRate,
    amount: payment.amount,
    currency: "PEN",
    status: "confirmed",
    yapePhone: payment.yapePhone,
    shifts: payment.shifts,
    excluded: [],
  };
}

export function previewWeek(input: {
  employees: EmployeePay[];
  attendances: AttendanceDoc[];
  confirmed: SettlementView[];
  week: WeekBounds;
}): SettlementView[] {
  const grouped = new Map<string, AttendanceDoc[]>();
  for (const attendance of input.attendances) {
    const current = grouped.get(attendance.employeeId) ?? [];
    current.push(attendance);
    grouped.set(attendance.employeeId, current);
  }
  const confirmed = new Map(input.confirmed.map((payment) => [payment.employeeId, payment]));
  const employees = new Map(input.employees.map((employee) => [employee.id, employee]));
  const ids = new Set<string>([...grouped.keys(), ...confirmed.keys()]);
  const rows: SettlementView[] = [];

  for (const employeeId of ids) {
    const stored = confirmed.get(employeeId);
    if (stored) {
      rows.push(stored);
      continue;
    }
    const attendances = grouped.get(employeeId) ?? [];
    const classified = classifyShifts(attendances, input.week.weekStart, input.week.weekEnd);
    if (classified.included.length === 0 && classified.excluded.length === 0) continue;
    const employee = employees.get(employeeId) ?? {
      id: employeeId,
      name: attendances[0]?.employeeName ?? "",
      employeeCode: attendances[0]?.employeeCode ?? "",
      hourlyRate: null,
      yapePhone: null,
    };
    rows.push(viewFromCalculation(employee, attendances[0], classified, input.week));
  }

  return rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName, "es") || a.employeeCode.localeCompare(b.employeeCode, "es"));
}

export function draftFromView(view: SettlementView): WeeklyPaymentDraft {
  if (view.hourlyRate == null || view.amount == null || view.totalMinutes <= 0) {
    throw new HttpError(400, view.hourlyRate == null
      ? "Falta configurar la tarifa por hora."
      : "No hay jornadas cerradas para liquidar en esa semana.");
  }
  return {
    employeeId: view.employeeId,
    employeeCode: view.employeeCode,
    employeeName: view.employeeName,
    weekStart: view.weekStart,
    weekEnd: view.weekEnd,
    totalMinutes: view.totalMinutes,
    hourlyRate: view.hourlyRate,
    amount: view.amount,
    currency: "PEN",
    yapePhone: view.yapePhone,
    shifts: view.shifts,
  };
}
