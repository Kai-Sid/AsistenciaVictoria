import { HttpError } from "./http-error.js";
import { amountCents, weekBoundsFromKey } from "./settlements.js";
import type {
  AdminDatabase,
  PaymentOperationRecord,
  PaymentStatus,
  VerifiedPayment,
  WeeklyPaymentRecord,
} from "./types.js";

export const PAYMENT_PROVIDER_PENDING = "La integración de pago con Yape está pendiente. Falta configurar en el servidor un proveedor compatible; esta acción no abre una plataforma de pago ni marca la liquidación como pagada.";
export const PAYMENT_UNCERTAIN = "Hay una operación de pago sin resultado confirmado. Se mantiene esa operación para no repetir la transferencia.";
export const PAYMENT_ALREADY_PAID = "Esta liquidación ya tiene un pago completado.";
export const PAYMENT_RETURN_IGNORED = "Volver a AsistenciaVictoria deja el pago como está. Solo una verificación del proveedor en el servidor puede marcarlo como pagado.";

/**
 * `failed` significa que el proveedor confirmó que no creó un cobro.
 * `uncertain` significa que el resultado no se conoce: no se reintenta.
 */
export type PaymentSessionResult =
  | { ok: true; redirectUrl: string; provider: string; providerReference: string }
  | { ok: false; outcome: "failed" | "uncertain"; message: string };

export type PaymentGateway = {
  readonly configured: boolean;
  readonly unavailableMessage: string;
  createSession(input: {
    operationId: string;
    attempt: number;
    amount: number;
    currency: "PEN";
    yapePhone: string;
    employeeName: string;
    weekStart: string;
    weekEnd: string;
  }): Promise<PaymentSessionResult>;
  verifyNotification(
    body: unknown,
    headers: { get(name: string): string | undefined },
  ): Promise<VerifiedPayment | null>;
};

export type StartedPayment = {
  status: 200;
  body: {
    ok: true;
    paymentStatus: "processing";
    redirectUrl: string;
    amount: number;
    currency: "PEN";
    resumed: boolean;
  };
};

/**
 * Yape no publica una API para crear una sesión y redirigir al administrador
 * a pagar el celular de un trabajador. Culqi, Niubiz, Izipay y Mercado Pago
 * documentan cobros hacia el comercio, no esa dispersión. Sin esa documentación
 * y sin credenciales, este módulo no llama a ningún proveedor.
 */
export function paymentGatewayFromEnv(_env: Record<string, string | undefined>): PaymentGateway {
  return {
    configured: false,
    unavailableMessage: PAYMENT_PROVIDER_PENDING,
    createSession() {
      return Promise.reject(new HttpError(503, PAYMENT_PROVIDER_PENDING));
    },
    verifyNotification() {
      return Promise.resolve(null);
    },
  };
}

export function httpsPaymentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!url.hostname || url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function payableSettlement(payment: WeeklyPaymentRecord): { amount: number; yapePhone: string } {
  if (payment.status !== "confirmed") throw new HttpError(404, "No hay una liquidación confirmada para esa semana.");
  if (!Number.isInteger(payment.totalMinutes) || payment.totalMinutes <= 0) {
    throw new HttpError(409, "La liquidación no tiene minutos válidos para pagar.");
  }
  const expectedCents = amountCents(payment.totalMinutes, payment.hourlyRate);
  const storedCents = Math.round(payment.amount * 100);
  if (!Number.isFinite(payment.amount) || Math.abs(payment.amount * 100 - storedCents) > 1e-6 || storedCents !== expectedCents || storedCents <= 0) {
    throw new HttpError(409, "El importe guardado no coincide con el cálculo del servidor. No se inicia el pago.");
  }
  if (!payment.yapePhone || !/^9\d{8}$/.test(payment.yapePhone)) {
    throw new HttpError(400, "La liquidación confirmada no tiene un celular Yape.");
  }
  return { amount: expectedCents / 100, yapePhone: payment.yapePhone };
}

function safeProviderMessage(message: string): string {
  if (message.length === 0 || message.length > 180 || /bearer|token|secret|clave|password/i.test(message)) {
    return "El proveedor no completó la sesión de pago.";
  }
  return message;
}

function safeProviderName(value: string): string | null {
  return /^[a-z0-9-]{1,40}$/.test(value) ? value : null;
}

function safeReference(value: string): string | null {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : null;
}

function resume(operation: PaymentOperationRecord, amount: number): StartedPayment {
  if (operation.status === "processing" && operation.redirectUrl) {
    return {
      status: 200,
      body: {
        ok: true,
        paymentStatus: "processing",
        redirectUrl: operation.redirectUrl,
        amount,
        currency: "PEN",
        resumed: true,
      },
    };
  }
  throw new HttpError(409, PAYMENT_UNCERTAIN);
}

export async function startYapePayment(
  database: AdminDatabase,
  gateway: PaymentGateway,
  input: { employeeId: string; weekStart: string },
  now: Date,
): Promise<StartedPayment> {
  const week = weekBoundsFromKey(input.weekStart);
  if (!week) throw new HttpError(400, "La semana no es válida. Indica el lunes de inicio.");
  const settlement = (await database.listWeeklyPayments(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
  if (!settlement) throw new HttpError(404, "No hay una liquidación confirmada para esa semana.");
  const payable = payableSettlement(settlement);
  const existing = (await database.listPaymentOperations(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
  if (existing?.status === "paid") throw new HttpError(409, PAYMENT_ALREADY_PAID);
  if (existing && (existing.status === "pending" || existing.status === "processing")) {
    if (Math.round(existing.amount * 100) !== Math.round(payable.amount * 100)) throw new HttpError(409, PAYMENT_UNCERTAIN);
    return resume(existing, payable.amount);
  }
  if (!gateway.configured) throw new HttpError(503, gateway.unavailableMessage);

  const reserved = await database.reservePaymentOperation({
    employeeId: settlement.employeeId,
    weekStart: settlement.weekStart,
    weekEnd: settlement.weekEnd,
    amount: payable.amount,
    currency: "PEN",
    yapePhone: payable.yapePhone,
  }, now);
  if (!reserved.reserved) {
    if (Math.round(reserved.operation.amount * 100) !== Math.round(payable.amount * 100)) throw new HttpError(409, PAYMENT_UNCERTAIN);
    return resume(reserved.operation, payable.amount);
  }

  let session: PaymentSessionResult;
  try {
    session = await gateway.createSession({
      operationId: reserved.operation.id,
      attempt: reserved.operation.attempt,
      amount: reserved.operation.amount,
      currency: "PEN",
      yapePhone: reserved.operation.yapePhone,
      employeeName: settlement.employeeName,
      weekStart: settlement.weekStart,
      weekEnd: settlement.weekEnd,
    });
  } catch {
    throw new HttpError(409, PAYMENT_UNCERTAIN);
  }

  if (!session.ok) {
    if (session.outcome === "failed") {
      await database.finishPaymentAttempt(reserved.operation.id, reserved.operation.attempt, { status: "failed" }, now);
      throw new HttpError(502, safeProviderMessage(session.message));
    }
    throw new HttpError(409, PAYMENT_UNCERTAIN);
  }

  const redirectUrl = httpsPaymentUrl(session.redirectUrl);
  const provider = safeProviderName(session.provider);
  const providerReference = safeReference(session.providerReference);
  if (!redirectUrl || !provider || !providerReference) throw new HttpError(409, PAYMENT_UNCERTAIN);

  try {
    await database.finishPaymentAttempt(reserved.operation.id, reserved.operation.attempt, {
      status: "processing",
      provider,
      providerReference,
      redirectUrl,
    }, now);
  } catch {
    throw new HttpError(409, PAYMENT_UNCERTAIN);
  }

  return {
    status: 200,
    body: {
      ok: true,
      paymentStatus: "processing",
      redirectUrl,
      amount: payable.amount,
      currency: "PEN",
      resumed: false,
    },
  };
}

export async function describePaymentReturn(
  database: AdminDatabase,
  input: { employeeId: string; weekStart: string },
): Promise<{
  ok: true;
  confirmsPayment: false;
  settlementStatus: "confirmed" | null;
  paymentStatus: PaymentStatus | null;
  message: string;
}> {
  const week = weekBoundsFromKey(input.weekStart);
  let settlementStatus: "confirmed" | null = null;
  let paymentStatus: PaymentStatus | null = null;
  if (week && input.employeeId && !input.employeeId.includes("/") && input.employeeId.length <= 128) {
    const settlement = (await database.listWeeklyPayments(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
    if (settlement?.status === "confirmed") settlementStatus = "confirmed";
    const operation = (await database.listPaymentOperations(week.weekStartKey)).find((item) => item.employeeId === input.employeeId);
    if (operation) paymentStatus = operation.status;
  }
  return {
    ok: true,
    confirmsPayment: false,
    settlementStatus,
    paymentStatus,
    message: PAYMENT_RETURN_IGNORED,
  };
}

export async function acceptProviderNotification(
  database: AdminDatabase,
  gateway: PaymentGateway,
  body: unknown,
  headers: { get(name: string): string | undefined },
  now: Date,
): Promise<{ applied: boolean }> {
  if (!gateway.configured) throw new HttpError(503, gateway.unavailableMessage);
  let verified: VerifiedPayment | null = null;
  try {
    verified = await gateway.verifyNotification(body, headers);
  } catch {
    verified = null;
  }
  if (!verified || verified.currency !== "PEN" || (verified.status !== "paid" && verified.status !== "failed" && verified.status !== "processing")) {
    throw new HttpError(401, "No se pudo verificar la notificación del proveedor.");
  }
  if (verified.operationId.includes("/") || verified.operationId.length > 300) {
    throw new HttpError(401, "No se pudo verificar la notificación del proveedor.");
  }
  return database.applyVerifiedPayment(verified, now);
}
