import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { HttpError } from "./http-error.js";
import { httpsPaymentUrl, PAYMENT_ALREADY_PAID, PAYMENT_UNCERTAIN } from "./payments.js";
import { yapeQrContentType } from "./yape-qr.js";
import { settlementDocumentId } from "./settlements.js";
import type {
  AdminDatabase,
  AttendanceDatabase,
  AttendanceDoc,
  AttendanceTx,
  AttendanceView,
  EmployeePublic,
  EmployeeRecord,
  PaymentAttemptResult,
  PaymentOperationRecord,
  PaymentReserveDraft,
  PaymentStatus,
  VerifiedPayment,
  WeeklyPaymentRecord,
  YapeDeclarationRecord,
  YapeQrRecord,
} from "./types.js";

type PaymentDraft = Parameters<AdminDatabase["saveWeeklyPayment"]>[0];

function asBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== "string" || value.length === 0 || value.length > 410_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return null;
}

export class FirestoreDatabase implements AttendanceDatabase, AdminDatabase {
  constructor(private readonly db: Firestore) {}

  async listActiveEmployees(): Promise<EmployeePublic[]> {
    const snap = await this.db.collection("employees").where("active", "==", true).select("name", "employeeCode", "active").get();
    const employees: EmployeePublic[] = [];
    for (const doc of snap.docs) {
      const name = doc.get("name");
      const employeeCode = doc.get("employeeCode");
      if (typeof name !== "string" || typeof employeeCode !== "string") continue;
      employees.push({ id: doc.id, name, employeeCode, active: true });
    }
    return employees;
  }

  runAttendanceTransaction<T>(work: (tx: AttendanceTx) => Promise<T>): Promise<T> {
    const db = this.db;
    return db.runTransaction(async (tx) => {
      const adapter: AttendanceTx = {
        async getEmployee(id: string): Promise<EmployeePublic | null> {
          const snap = await tx.get(db.collection("employees").doc(id));
          if (!snap.exists) return null;
          const name = snap.get("name");
          const employeeCode = snap.get("employeeCode");
          if (typeof name !== "string" || typeof employeeCode !== "string") return null;
          return { id: snap.id, name, employeeCode, active: snap.get("active") === true };
        },
        async listOpenAttendances(employeeId: string): Promise<AttendanceDoc[]> {
          const query = db.collection("attendances")
            .where("employeeId", "==", employeeId)
            .where("status", "==", "open")
            .limit(5);
          const snap = await tx.get(query);
          return snap.docs.map((doc) => {
            const checkInAt = asDate(doc.get("checkInAt")) ?? new Date(Number.NaN);
            const checkOutAt = asDate(doc.get("checkOutAt"));
            const createdAt = asDate(doc.get("createdAt")) ?? checkInAt;
            const worked = doc.get("workedMinutes");
            return {
              id: doc.id,
              employeeId: String(doc.get("employeeId") ?? ""),
              employeeCode: String(doc.get("employeeCode") ?? ""),
              employeeName: String(doc.get("employeeName") ?? ""),
              status: String(doc.get("status") ?? ""),
              checkInAt,
              checkOutAt: checkOutAt ?? undefined,
              workedMinutes: typeof worked === "number" ? worked : undefined,
              createdAt,
            };
          });
        },
        createOpenAttendance(record) {
          const ref = db.collection("attendances").doc();
          tx.create(ref, {
            employeeId: record.employeeId,
            employeeCode: record.employeeCode,
            employeeName: record.employeeName,
            status: "open",
            checkInAt: Timestamp.fromDate(record.checkInAt),
            createdAt: Timestamp.fromDate(record.createdAt),
          });
        },
        closeAttendance(id, patch) {
          tx.update(db.collection("attendances").doc(id), {
            status: "closed",
            checkOutAt: Timestamp.fromDate(patch.checkOutAt),
            workedMinutes: patch.workedMinutes,
            updatedAt: Timestamp.fromDate(patch.updatedAt),
          });
        },
        touchEmployee(id, updatedAt) {
          tx.update(db.collection("employees").doc(id), { updatedAt: Timestamp.fromDate(updatedAt) });
        },
      };
      return work(adapter);
    });
  }

  async createEmployee(input: { name: string; employeeCode: string }): Promise<EmployeePublic> {
    const existing = await this.db.collection("employees").where("employeeCode", "==", input.employeeCode).limit(1).get();
    if (!existing.empty) throw new HttpError(409, "Ese código de trabajador ya existe.");
    const ref = await this.db.collection("employees").add({
      name: input.name,
      employeeCode: input.employeeCode,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id, name: input.name, employeeCode: input.employeeCode, active: true };
  }

  async listEmployees(): Promise<EmployeeRecord[]> {
    const snap = await this.db.collection("employees").orderBy("name").get();
    return snap.docs.map((doc) => this.employeeRecord(doc.id, doc.get.bind(doc)));
  }

  async listAttendances(): Promise<AttendanceView[]> {
    const snap = await this.db.collection("attendances").orderBy("createdAt", "desc").limit(500).get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      const worked = data.workedMinutes;
      return {
        id: doc.id,
        employeeName: typeof data.employeeName === "string" ? data.employeeName : "",
        employeeCode: typeof data.employeeCode === "string" ? data.employeeCode : "",
        status: typeof data.status === "string" ? data.status : "",
        checkInAt: asDate(data.checkInAt)?.toISOString() ?? null,
        checkOutAt: asDate(data.checkOutAt)?.toISOString() ?? null,
        workedMinutes: typeof worked === "number" ? worked : null,
      };
    });
  }

  async setEmployeeActive(employeeId: string, active: boolean): Promise<{ ok: true }> {
    const ref = this.db.collection("employees").doc(employeeId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, "No encontramos ese trabajador.");
    await ref.update({ active, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }

  async updateEmployeePay(employeeId: string, input: { hourlyRate: number; yapePhone: string | null }): Promise<EmployeeRecord> {
    const ref = this.db.collection("employees").doc(employeeId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, "No encontramos ese trabajador.");
    await ref.update({
      hourlyRate: input.hourlyRate,
      yapePhone: input.yapePhone ?? FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      ...this.employeeRecord(snap.id, snap.get.bind(snap)),
      hourlyRate: input.hourlyRate,
      yapePhone: input.yapePhone,
    };
  }

  async saveYapeQr(employeeId: string, image: YapeQrRecord | null, now: Date): Promise<EmployeeRecord> {
    const employeeRef = this.db.collection("employees").doc(employeeId);
    const qrRef = this.db.collection("employeeYapeQr").doc(employeeId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(employeeRef);
      if (!snap.exists) throw new HttpError(404, "No encontramos ese trabajador.");
      if (image) {
        tx.set(qrRef, {
          contentType: image.contentType,
          image: image.bytes.toString("base64"),
          updatedAt: Timestamp.fromDate(now),
        });
      } else {
        tx.delete(qrRef);
      }
      tx.update(employeeRef, {
        yapeQrRegistered: image != null,
        updatedAt: Timestamp.fromDate(now),
      });
      return {
        ...this.employeeRecord(snap.id, snap.get.bind(snap)),
        yapeQrRegistered: image != null,
      };
    });
  }

  async getYapeQr(employeeId: string): Promise<YapeQrRecord | null> {
    if (!employeeId || employeeId.includes("/") || employeeId.length > 128) return null;
    const snap = await this.db.collection("employeeYapeQr").doc(employeeId).get();
    if (!snap.exists) return null;
    const bytes = asBytes(snap.get("image"));
    const contentType = bytes ? yapeQrContentType(bytes) : null;
    if (!bytes || !contentType || snap.get("contentType") !== contentType) return null;
    return { contentType, bytes };
  }

  async listYapeDeclarations(weekStart: string): Promise<YapeDeclarationRecord[]> {
    const snap = await this.db.collection("yapeDeclarations").where("weekStart", "==", weekStart).get();
    return snap.docs.flatMap((doc) => {
      const declaration = this.declarationRecord(doc.id, doc.get.bind(doc));
      return declaration ? [declaration] : [];
    });
  }

  saveYapeDeclaration(draft: YapeDeclarationRecord): Promise<{ declaration: YapeDeclarationRecord; created: boolean }> {
    const ref = this.db.collection("yapeDeclarations").doc(draft.id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const current = this.declarationRecord(snap.id, snap.get.bind(snap));
        if (!current) throw new HttpError(409, "La declaración de esa liquidación no se puede leer.");
        return { declaration: current, created: false };
      }
      tx.create(ref, {
        employeeId: draft.employeeId,
        weekStart: draft.weekStart,
        weekEnd: draft.weekEnd,
        amount: draft.amount,
        currency: "PEN",
        declaredAt: Timestamp.fromDate(new Date(draft.declaredAt)),
        declaredByUid: draft.declaredByUid,
        declaredByName: draft.declaredByName,
      });
      return { declaration: { ...draft }, created: true };
    });
  }

  async listSettlementAttendances(from: Date, to: Date): Promise<AttendanceDoc[]> {
    const snap = await this.db.collection("attendances")
      .where("checkInAt", ">=", Timestamp.fromDate(from))
      .where("checkInAt", "<", Timestamp.fromDate(to))
      .get();
    return snap.docs.map((doc) => this.attendanceDoc(doc.id, doc.get.bind(doc)));
  }

  async listWeeklyPayments(weekStart: string): Promise<WeeklyPaymentRecord[]> {
    const snap = await this.db.collection("weeklyPayments").where("weekStart", "==", weekStart).get();
    return snap.docs.flatMap((doc) => {
      const payment = this.paymentRecord(doc.id, doc.get.bind(doc));
      return payment ? [payment] : [];
    });
  }

  async saveWeeklyPayment(draft: PaymentDraft, now: Date): Promise<{ payment: WeeklyPaymentRecord; created: boolean }> {
    const id = settlementDocumentId(draft.employeeId, draft.weekStart);
    const ref = this.db.collection("weeklyPayments").doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const payment = this.paymentRecord(snap.id, snap.get.bind(snap));
        if (!payment) throw new HttpError(409, "La liquidación de esa semana ya existe y no se puede leer.");
        return { payment, created: false };
      }
      const payment: WeeklyPaymentRecord = {
        id,
        employeeId: draft.employeeId,
        employeeCode: draft.employeeCode,
        employeeName: draft.employeeName,
        weekStart: draft.weekStart,
        weekEnd: draft.weekEnd,
        totalMinutes: draft.totalMinutes,
        hourlyRate: draft.hourlyRate,
        amount: draft.amount,
        currency: "PEN",
        status: "confirmed",
        yapePhone: draft.yapePhone,
        shifts: draft.shifts.map((shift) => ({ ...shift })),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      tx.create(ref, {
        ...payment,
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      });
      return { payment, created: true };
    });
  }

  async listPaymentOperations(weekStart: string): Promise<PaymentOperationRecord[]> {
    const snap = await this.db.collection("paymentOperations").where("weekStart", "==", weekStart).get();
    return snap.docs.flatMap((doc) => {
      const operation = this.paymentOperation(doc.id, doc.get.bind(doc));
      return operation ? [operation] : [];
    });
  }

  async reservePaymentOperation(draft: PaymentReserveDraft, now: Date): Promise<{ operation: PaymentOperationRecord; reserved: boolean }> {
    const id = settlementDocumentId(draft.employeeId, draft.weekStart);
    const ref = this.db.collection("paymentOperations").doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const current = this.paymentOperation(snap.id, snap.get.bind(snap));
        if (!current) throw new HttpError(409, "La operación de pago de esa liquidación no se puede leer.");
        if (current.status === "paid") throw new HttpError(409, PAYMENT_ALREADY_PAID);
        if (current.status === "pending" || current.status === "processing") return { operation: current, reserved: false };
        const next: PaymentOperationRecord = {
          ...current,
          weekEnd: draft.weekEnd,
          amount: draft.amount,
          yapePhone: draft.yapePhone,
          status: "pending",
          attempt: current.attempt + 1,
          provider: null,
          providerReference: null,
          redirectUrl: null,
          updatedAt: now.toISOString(),
        };
        tx.update(ref, {
          weekEnd: next.weekEnd,
          amount: next.amount,
          yapePhone: next.yapePhone,
          status: "pending",
          attempt: next.attempt,
          provider: null,
          providerReference: null,
          redirectUrl: null,
          updatedAt: Timestamp.fromDate(now),
        });
        return { operation: next, reserved: true };
      }
      const operation: PaymentOperationRecord = {
        id,
        employeeId: draft.employeeId,
        weekStart: draft.weekStart,
        weekEnd: draft.weekEnd,
        amount: draft.amount,
        currency: "PEN",
        yapePhone: draft.yapePhone,
        status: "pending",
        attempt: 1,
        provider: null,
        providerReference: null,
        redirectUrl: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      tx.create(ref, {
        ...operation,
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      });
      return { operation, reserved: true };
    });
  }

  async finishPaymentAttempt(id: string, attempt: number, result: PaymentAttemptResult, now: Date): Promise<PaymentOperationRecord> {
    const ref = this.db.collection("paymentOperations").doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? this.paymentOperation(snap.id, snap.get.bind(snap)) : null;
      if (!current || current.attempt !== attempt || current.status !== "pending") throw new HttpError(409, PAYMENT_UNCERTAIN);
      const next: PaymentOperationRecord = result.status === "processing"
        ? {
          ...current,
          status: "processing",
          provider: result.provider,
          providerReference: result.providerReference,
          redirectUrl: result.redirectUrl,
          updatedAt: now.toISOString(),
        }
        : {
          ...current,
          status: "failed",
          provider: null,
          providerReference: null,
          redirectUrl: null,
          updatedAt: now.toISOString(),
        };
      tx.update(ref, {
        status: next.status,
        provider: next.provider,
        providerReference: next.providerReference,
        redirectUrl: next.redirectUrl,
        updatedAt: Timestamp.fromDate(now),
      });
      return next;
    });
  }

  async applyVerifiedPayment(notice: VerifiedPayment, now: Date): Promise<{ applied: boolean }> {
    if (notice.currency !== "PEN" || (notice.status !== "paid" && notice.status !== "failed")) return { applied: false };
    if (notice.operationId.includes("/") || notice.operationId.length > 300) return { applied: false };
    const ref = this.db.collection("paymentOperations").doc(notice.operationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? this.paymentOperation(snap.id, snap.get.bind(snap)) : null;
      if (!current || current.status !== "processing" || !current.providerReference || current.providerReference !== notice.providerReference) {
        return { applied: false };
      }
      if (Math.round(current.amount * 100) !== Math.round(notice.amount * 100)) return { applied: false };
      tx.update(ref, { status: notice.status, updatedAt: Timestamp.fromDate(now) });
      return { applied: true };
    });
  }

  private employeeRecord(id: string, get: (field: string) => unknown): EmployeeRecord {
    const hourlyRate = get("hourlyRate");
    const yapePhone = get("yapePhone");
    return {
      id,
      name: String(get("name") ?? ""),
      employeeCode: String(get("employeeCode") ?? ""),
      active: get("active") === true,
      createdAt: asDate(get("createdAt"))?.toISOString() ?? null,
      hourlyRate: typeof hourlyRate === "number" && Number.isFinite(hourlyRate) && hourlyRate > 0 ? Math.round(hourlyRate * 100) / 100 : null,
      yapePhone: typeof yapePhone === "string" && /^9\d{8}$/.test(yapePhone) ? yapePhone : null,
      yapeQrRegistered: get("yapeQrRegistered") === true,
    };
  }

  private declarationRecord(id: string, get: (field: string) => unknown): YapeDeclarationRecord | null {
    const amount = get("amount");
    const declaredAt = asDate(get("declaredAt"));
    const weekStart = String(get("weekStart") ?? "");
    const weekEnd = String(get("weekEnd") ?? "");
    const declaredByUid = get("declaredByUid");
    const declaredByName = get("declaredByName");
    if (typeof amount !== "number" || !Number.isFinite(amount) || !declaredAt || !weekStart || !weekEnd) return null;
    if (typeof declaredByUid !== "string" || declaredByUid.length === 0 || declaredByUid.length > 128) return null;
    if (typeof declaredByName !== "string" || declaredByName.length < 2 || declaredByName.length > 120) return null;
    if (get("currency") != null && get("currency") !== "PEN") return null;
    return {
      id,
      employeeId: String(get("employeeId") ?? ""),
      weekStart,
      weekEnd,
      amount,
      currency: "PEN",
      declaredAt: declaredAt.toISOString(),
      declaredByUid,
      declaredByName,
    };
  }

  private attendanceDoc(id: string, get: (field: string) => unknown): AttendanceDoc {
    const worked = get("workedMinutes");
    return {
      id,
      employeeId: String(get("employeeId") ?? ""),
      employeeCode: String(get("employeeCode") ?? ""),
      employeeName: String(get("employeeName") ?? ""),
      status: String(get("status") ?? ""),
      checkInAt: asDate(get("checkInAt")) ?? new Date(Number.NaN),
      checkOutAt: asDate(get("checkOutAt")) ?? undefined,
      workedMinutes: typeof worked === "number" ? worked : undefined,
      createdAt: asDate(get("createdAt")) ?? new Date(Number.NaN),
      updatedAt: asDate(get("updatedAt")) ?? undefined,
    };
  }

  private paymentRecord(id: string, get: (field: string) => unknown): WeeklyPaymentRecord | null {
    const hourlyRate = get("hourlyRate");
    const amount = get("amount");
    const totalMinutes = get("totalMinutes");
    const shifts = get("shifts");
    if (typeof hourlyRate !== "number" || typeof amount !== "number" || typeof totalMinutes !== "number" || !Array.isArray(shifts)) return null;
    const weekStart = String(get("weekStart") ?? "");
    const weekEnd = String(get("weekEnd") ?? "");
    if (!weekStart || !weekEnd) return null;
    const status = get("status");
    if (status != null && status !== "confirmed") return null;
    const yapePhone = get("yapePhone");
    return {
      id,
      employeeId: String(get("employeeId") ?? ""),
      employeeCode: String(get("employeeCode") ?? ""),
      employeeName: String(get("employeeName") ?? ""),
      weekStart,
      weekEnd,
      totalMinutes,
      hourlyRate,
      amount,
      currency: "PEN",
      status: "confirmed",
      yapePhone: typeof yapePhone === "string" && /^9\d{8}$/.test(yapePhone) ? yapePhone : null,
      shifts: shifts.flatMap((shift) => {
        if (!shift || typeof shift !== "object") return [];
        const record = shift as { attendanceId?: unknown; checkInAt?: unknown; checkOutAt?: unknown; minutes?: unknown };
        if (typeof record.attendanceId !== "string" || typeof record.checkInAt !== "string" || typeof record.checkOutAt !== "string" || typeof record.minutes !== "number") return [];
        return [{ attendanceId: record.attendanceId, checkInAt: record.checkInAt, checkOutAt: record.checkOutAt, minutes: record.minutes }];
      }),
      createdAt: asDate(get("createdAt"))?.toISOString() ?? "",
      updatedAt: asDate(get("updatedAt"))?.toISOString() ?? "",
    };
  }

  private paymentOperation(id: string, get: (field: string) => unknown): PaymentOperationRecord | null {
    const amount = get("amount");
    const attempt = get("attempt");
    const status = get("status");
    const weekStart = String(get("weekStart") ?? "");
    const weekEnd = String(get("weekEnd") ?? "");
    const yapePhone = get("yapePhone");
    const currency = get("currency");
    if (typeof amount !== "number" || !Number.isFinite(amount) || typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return null;
    if (!isPaymentStatus(status) || !weekStart || !weekEnd) return null;
    if (currency != null && currency !== "PEN") return null;
    if (typeof yapePhone !== "string" || !/^9\d{8}$/.test(yapePhone)) return null;
    const provider = get("provider");
    const providerReference = get("providerReference");
    const redirectUrl = get("redirectUrl");
    return {
      id,
      employeeId: String(get("employeeId") ?? ""),
      weekStart,
      weekEnd,
      amount,
      currency: "PEN",
      yapePhone,
      status,
      attempt,
      provider: typeof provider === "string" && provider.length > 0 ? provider : null,
      providerReference: typeof providerReference === "string" && providerReference.length > 0 ? providerReference : null,
      redirectUrl: typeof redirectUrl === "string" ? httpsPaymentUrl(redirectUrl) : null,
      createdAt: asDate(get("createdAt"))?.toISOString() ?? "",
      updatedAt: asDate(get("updatedAt"))?.toISOString() ?? "",
    };
  }
}

function isPaymentStatus(value: unknown): value is PaymentStatus {
  return value === "pending" || value === "processing" || value === "paid" || value === "failed";
}
