import { createHash } from "node:crypto";

export const PIN_FAILURE_MESSAGE = "Código o PIN incorrectos.";
export const PIN_WINDOW_MS = 15 * 60 * 1000;
export const PIN_LOCK_MS = 15 * 60 * 1000;
export const PIN_MAX_FAILURES = 5;

/** Hash bcrypt de costo 12 de un valor aleatorio descartado. No es un PIN de personal. */
export const DUMMY_PIN_HASH = "$2a$12$O7Rmg55YfDlAZ5jNlmv48OUiFqGIR9A6yOLEBTYleF4teZu8jJfhS";

export type AttemptState = {
  failCount: number;
  windowStartedAtMs: number;
  lockedUntilMs: number | null;
};

export type ReserveDecision = {
  /** True si este fallo puede registrarse. No autoriza ni rechaza un PIN correcto. */
  allowed: boolean;
  changed: boolean;
  next: AttemptState;
};

export type PinAttemptOutcome =
  | { kind: "accept"; attemptDocumentId: string }
  | { kind: "reject"; failure: ReserveDecision };

export function shouldPersistAttempt(employeeFound: boolean, active: boolean, hasPinHash: boolean): boolean {
  return employeeFound && active && hasPinHash;
}

/** Id del cupo. Solo entra el id estable del empleado: ni el PIN ni datos de red. */
export function pinAttemptDocumentId(employeeId: string): string {
  return createHash("sha256").update(employeeId).digest("hex");
}

export function attemptStateFromParts(
  failCount: unknown,
  windowStartedAtMs: unknown,
  lockedUntilMs: unknown,
): AttemptState | null {
  if (typeof failCount !== "number" || !Number.isInteger(failCount) || failCount < 1) return null;
  if (typeof windowStartedAtMs !== "number" || !Number.isFinite(windowStartedAtMs)) return null;
  if (lockedUntilMs != null && (typeof lockedUntilMs !== "number" || !Number.isFinite(lockedUntilMs))) return null;
  return {
    failCount,
    windowStartedAtMs,
    lockedUntilMs: typeof lockedUntilMs === "number" ? lockedUntilMs : null,
  };
}

export function reserveAttempt(prev: AttemptState | null, nowMs: number): ReserveDecision {
  if (prev?.lockedUntilMs != null && prev.lockedUntilMs > nowMs) {
    return { allowed: false, changed: false, next: prev };
  }
  const windowOpen = prev != null && nowMs - prev.windowStartedAtMs < PIN_WINDOW_MS;
  if (!prev || !windowOpen) {
    return {
      allowed: true,
      changed: true,
      next: { failCount: 1, windowStartedAtMs: nowMs, lockedUntilMs: null },
    };
  }
  const failCount = prev.failCount + 1;
  return {
    allowed: true,
    changed: true,
    next: {
      failCount,
      windowStartedAtMs: prev.windowStartedAtMs,
      lockedUntilMs: failCount >= PIN_MAX_FAILURES ? nowMs + PIN_LOCK_MS : null,
    },
  };
}

/**
 * Un PIN correcto se acepta aunque el cupo esté bloqueado y solo nombra el
 * documento de ese empleado. Un tercero puede llenar el contador, pero no
 * impide la marcación ni obtiene el id de otro trabajador. Un fallo durante
 * el bloqueo no mueve el vencimiento.
 */
export function pinAttemptOutcome(
  employeeId: string,
  pinMatches: boolean,
  prev: AttemptState | null,
  nowMs: number,
): PinAttemptOutcome {
  if (pinMatches) {
    return { kind: "accept", attemptDocumentId: pinAttemptDocumentId(employeeId) };
  }
  return { kind: "reject", failure: reserveAttempt(prev, nowMs) };
}
