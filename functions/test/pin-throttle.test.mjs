import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  PIN_LOCK_MS,
  PIN_MAX_FAILURES,
  PIN_WINDOW_MS,
  attemptStateFromParts,
  pinAttemptDocumentId,
  pinAttemptOutcome,
  reserveAttempt,
  shouldPersistAttempt,
} = require("../lib/pin-throttle.js");

test("un código inexistente o inactivo no autoriza un documento de intentos", () => {
  assert.equal(shouldPersistAttempt(false, true, true), false);
  assert.equal(shouldPersistAttempt(true, false, true), false);
  assert.equal(shouldPersistAttempt(true, true, false), false);
  assert.equal(shouldPersistAttempt(true, true, true), true);
});

test("el id del cupo solo depende del empleado y no incluye el PIN", () => {
  assert.equal(pinAttemptDocumentId.length, 1);
  const employeeId = "emp-estable-001";
  const pin = "123456";
  const documentId = pinAttemptDocumentId(employeeId);
  assert.equal(documentId, pinAttemptDocumentId(employeeId));
  assert.equal(documentId.length, 64);
  assert.equal(documentId.includes(employeeId), false);
  assert.equal(documentId.includes(pin), false);
  assert.notEqual(documentId, pinAttemptDocumentId("emp-estable-002"));
});

test("cinco fallos reservan cupo y el sexto queda bloqueado sin ampliar el contador", () => {
  let state = null;
  const now = 1_000_000;
  for (let attempt = 1; attempt <= PIN_MAX_FAILURES; attempt += 1) {
    const decision = reserveAttempt(state, now);
    assert.equal(decision.allowed, true);
    assert.equal(decision.next.failCount, attempt);
    assert.deepEqual(Object.keys(decision.next).sort(), ["failCount", "lockedUntilMs", "windowStartedAtMs"]);
    state = decision.next;
  }
  assert.equal(state.lockedUntilMs, now + PIN_LOCK_MS);
  const blocked = reserveAttempt(state, now + 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.changed, false);
  assert.equal(blocked.next.failCount, PIN_MAX_FAILURES);
  assert.equal(blocked.next.lockedUntilMs, state.lockedUntilMs);
});

test("reservas concurrentes sobre el mismo empleado solo conceden cinco cupos", async () => {
  let version = 0;
  let state = null;
  const now = 5_000_000;

  async function reserveInTransaction() {
    for (;;) {
      const seen = version;
      const snapshot = state == null ? null : { ...state };
      const decision = reserveAttempt(snapshot, now);
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
      if (version !== seen) continue;
      if (decision.changed) state = { ...decision.next };
      version += 1;
      return decision.allowed;
    }
  }

  const results = await Promise.all(Array.from({ length: 20 }, () => reserveInTransaction()));
  assert.equal(results.filter(Boolean).length, PIN_MAX_FAILURES);
  assert.equal(state.failCount, PIN_MAX_FAILURES);
  assert.equal(state.lockedUntilMs, now + PIN_LOCK_MS);
});

function applyOutcome(docs, employeeId, pinMatches, now) {
  const id = pinAttemptDocumentId(employeeId);
  const prev = docs.has(id) ? { ...docs.get(id) } : null;
  const outcome = pinAttemptOutcome(employeeId, pinMatches, prev, now);
  if (outcome.kind === "accept") {
    assert.equal(outcome.attemptDocumentId, id);
    docs.delete(outcome.attemptDocumentId);
    return outcome;
  }
  if (outcome.failure.changed) docs.set(id, { ...outcome.failure.next });
  return outcome;
}

test("dos trabajadores conservan contadores distintos y el acierto solo borra el propio", () => {
  const docs = new Map();
  const now = 9_000_000;
  const workerA = "emp-a";
  const workerB = "emp-b";
  const idA = pinAttemptDocumentId(workerA);
  const idB = pinAttemptDocumentId(workerB);
  assert.notEqual(idA, idB);

  for (let i = 0; i < PIN_MAX_FAILURES; i += 1) {
    const outcome = applyOutcome(docs, workerA, false, now);
    assert.equal(outcome.kind, "reject");
  }
  applyOutcome(docs, workerB, false, now);
  assert.equal(docs.get(idA).failCount, PIN_MAX_FAILURES);
  assert.equal(docs.get(idA).lockedUntilMs, now + PIN_LOCK_MS);
  assert.equal(docs.get(idB).failCount, 1);
  assert.equal(docs.get(idB).lockedUntilMs, null);

  const blockedAgain = applyOutcome(docs, workerA, false, now + 1);
  assert.equal(blockedAgain.kind, "reject");
  assert.equal(blockedAgain.failure.changed, false);
  assert.equal(docs.get(idA).lockedUntilMs, now + PIN_LOCK_MS);

  const accepted = applyOutcome(docs, workerA, true, now + 2);
  assert.equal(accepted.kind, "accept");
  assert.equal(accepted.attemptDocumentId, idA);
  assert.equal(docs.has(idA), false);
  assert.equal(docs.get(idB).failCount, 1);
  assert.equal(docs.get(idB).windowStartedAtMs, now);

  for (let i = 0; i < PIN_MAX_FAILURES - 1; i += 1) applyOutcome(docs, workerB, false, now);
  assert.equal(docs.get(idB).failCount, PIN_MAX_FAILURES);
  assert.ok(docs.get(idB).lockedUntilMs);
  applyOutcome(docs, workerA, true, now + 3);
  assert.equal(docs.has(idA), false);
  assert.equal(docs.get(idB).failCount, PIN_MAX_FAILURES);
});

test("fallos concurrentes de dos empleados no comparten cupo ni bloqueo", async () => {
  const docs = new Map();
  const now = 11_000_000;

  async function fail(employeeId) {
    const id = pinAttemptDocumentId(employeeId);
    for (;;) {
      const current = docs.get(id);
      const seen = current?.version ?? 0;
      const prev = current?.state == null ? null : { ...current.state };
      const outcome = pinAttemptOutcome(employeeId, false, prev, now);
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
      const latest = docs.get(id);
      if ((latest?.version ?? 0) !== seen) continue;
      assert.equal(outcome.kind, "reject");
      docs.set(id, {
        version: seen + 1,
        state: outcome.failure.changed ? { ...outcome.failure.next } : prev,
      });
      return outcome.failure.allowed;
    }
  }

  const [resultsA, resultsB] = await Promise.all([
    Promise.all(Array.from({ length: 20 }, () => fail("emp-a"))),
    Promise.all(Array.from({ length: 20 }, () => fail("emp-b"))),
  ]);
  assert.equal(resultsA.filter(Boolean).length, PIN_MAX_FAILURES);
  assert.equal(resultsB.filter(Boolean).length, PIN_MAX_FAILURES);
  const stateA = docs.get(pinAttemptDocumentId("emp-a")).state;
  const stateB = docs.get(pinAttemptDocumentId("emp-b")).state;
  assert.equal(stateA.failCount, PIN_MAX_FAILURES);
  assert.equal(stateB.failCount, PIN_MAX_FAILURES);
  assert.equal(stateA.lockedUntilMs, now + PIN_LOCK_MS);
  assert.equal(stateB.lockedUntilMs, now + PIN_LOCK_MS);
});

test("la ventana vencida empieza de nuevo y un estado ilegible no se reutiliza", () => {
  const opened = reserveAttempt(null, 0);
  const later = reserveAttempt(opened.next, PIN_WINDOW_MS);
  assert.equal(later.next.failCount, 1);
  assert.equal(later.next.windowStartedAtMs, PIN_WINDOW_MS);
  assert.equal(attemptStateFromParts(0, 10, null), null);
  assert.equal(attemptStateFromParts(2, Number.NaN, null), null);
});
