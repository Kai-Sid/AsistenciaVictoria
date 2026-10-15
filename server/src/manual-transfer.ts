import { HttpError } from "./http-error.js";
import { amountCents, settlementDocumentId, weekBoundsFromKey } from "./settlements.js";
import type { AdminDatabase, WeeklyPaymentRecord, YapeDeclarationRecord } from "./types.js";

export const TRANSFER_DECLARED_MESSAGE = "Quedó registrada la declaración del administrador. AsistenciaVictoria no comprobó el ingreso en Yape.";
export const TRANSFER_ALREADY_DECLARED = "Esta liquidación ya tiene una transferencia declarada por el administrador.";
export const TRANSFER_ALREADY_VERIFIED = "Esta liquidación ya tiene un pago verificado. No se registra otra transferencia.";

export type TransferActor = {
  uid: string;
  name: string;
};

function moneyCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6 || cents <= 0) return null;
  return cents;
}

function confirmedAmount(payment: WeeklyPaymentRecord): number {
  if (!Number.isInteger(payment.totalMinutes) || payment.totalMinutes <= 0) {
    throw new HttpError(409, "La liquidación no tiene minutos válidos.");
  }
  const expected = amountCents(payment.totalMinutes, payment.hourlyRate);
  const stored = moneyCents(payment.amount);
  if (stored == null || stored !== expected) {
    throw new HttpError(409, "El importe guardado no coincide con el cálculo del servidor.");
  }
  return expected / 100;
}

function sameMoney(left: number, right: number): boolean {
  return moneyCents(left) === moneyCents(right);
}

function actorName(value: string): string {
  const clean = value.replace(/[\u0000-\u001f]/g, "").trim();
  if (clean.length < 2 || clean.length > 120) return "Administrador";
  return clean;
}

export function optionalDeclaredAmount(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const amount = (body as { amount?: unknown }).amount;
  if (amount == null) return null;
  if (typeof amount !== "number") throw new HttpError(400, "El importe no es válido.");
  const cents = moneyCents(amount);
  if (cents == null) throw new HttpError(400, "El importe no es válido.");
  return cents / 100;
}

export async function declareManualTransfer(
  database: AdminDatabase,
  input: { employeeId: string; weekStart: string },
  actor: TransferActor,
  clientAmount: number | null,
  now: Date,
): Promise<{ declaration: YapeDeclarationRecord; created: boolean }> {
  if (!actor.uid || actor.uid.includes("/") || actor.uid.length > 128) {
    throw new HttpError(401, "Se requiere permiso de administrador.");
  }
  const week = weekBoundsFromKey(input.weekStart);
  if (!week) throw new HttpError(400, "La semana no es válida. Indica el lunes de inicio.");
  const settlement = (await database.listWeeklyPayments(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
  if (!settlement || settlement.status !== "confirmed") {
    throw new HttpError(404, "No hay una liquidación confirmada para esa semana.");
  }
  const amount = confirmedAmount(settlement);
  if (clientAmount != null && !sameMoney(clientAmount, amount)) {
    throw new HttpError(409, "El importe confirmado no coincide con la liquidación.");
  }
  const operation = (await database.listPaymentOperations(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
  if (operation?.status === "paid") throw new HttpError(409, TRANSFER_ALREADY_VERIFIED);
  if (operation?.status === "pending" || operation?.status === "processing") {
    throw new HttpError(409, "Hay una operación de pago sin resultado confirmado. Se mantiene esa operación para no repetir la transferencia.");
  }
  const existing = (await database.listYapeDeclarations(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
  if (existing) throw new HttpError(409, TRANSFER_ALREADY_DECLARED);
  const saved = await database.saveYapeDeclaration({
    id: settlementDocumentId(settlement.employeeId, settlement.weekStart),
    employeeId: settlement.employeeId,
    weekStart: settlement.weekStart,
    weekEnd: settlement.weekEnd,
    amount,
    currency: "PEN",
    status: "reported_paid",
    declaredAt: now.toISOString(),
    declaredByUid: actor.uid,
    declaredByName: actorName(actor.name),
  });
  if (!saved.created || saved.declaration.status !== "reported_paid" || !sameMoney(saved.declaration.amount, amount)) {
    throw new HttpError(409, TRANSFER_ALREADY_DECLARED);
  }
  return saved;
}
