import { HttpError } from "./http-error.js";
import { settlementDocumentId } from "./settlements.js";
import { PAYMENT_ALREADY_PAID, PAYMENT_UNCERTAIN } from "./payments.js";
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
  VerifiedPayment,
  WeeklyPaymentRecord,
  YapeDeclarationRecord,
  YapeQrRecord,
} from "./types.js";

type StoredEmployee = EmployeePublic & {
  pinHash?: string;
  createdAt?: Date;
  updatedAt?: Date;
  hourlyRate?: number;
  yapePhone?: string;
  yapeQrRegistered?: boolean;
};

type PaymentDraft = Parameters<AdminDatabase["saveWeeklyPayment"]>[0];

export class MemoryDatabase implements AttendanceDatabase, AdminDatabase {
  employees: StoredEmployee[] = [];
  attendances: AttendanceDoc[] = [];
  weeklyPayments: WeeklyPaymentRecord[] = [];
  paymentOperations: PaymentOperationRecord[] = [];
  yapeQr = new Map<string, YapeQrRecord>();
  yapeDeclarations: YapeDeclarationRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;

  private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  listActiveEmployees(): Promise<EmployeePublic[]> {
    return Promise.resolve(
      this.employees
        .filter((employee) => employee.active === true)
        .map(({ id, name, employeeCode, active }) => ({ id, name, employeeCode, active })),
    );
  }

  runAttendanceTransaction<T>(work: (tx: AttendanceTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const tx = new MemoryTx(this);
      const result = await work(tx);
      tx.commit();
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  async createEmployee(input: { name: string; employeeCode: string }): Promise<EmployeePublic> {
    if (this.employees.some((employee) => employee.employeeCode === input.employeeCode)) {
      throw new HttpError(409, "Ese código de trabajador ya existe.");
    }
    const employee: StoredEmployee = {
      id: this.nextId("emp"),
      name: input.name,
      employeeCode: input.employeeCode,
      active: true,
      createdAt: new Date(),
    };
    this.employees.push(employee);
    return { id: employee.id, name: employee.name, employeeCode: employee.employeeCode, active: true };
  }

  async listEmployees(): Promise<EmployeeRecord[]> {
    return this.employees
      .map((employee) => this.toEmployeeRecord(employee))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }

  async listAttendances(): Promise<AttendanceView[]> {
    return this.attendances
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 500)
      .map((row) => ({
        id: row.id,
        employeeName: row.employeeName,
        employeeCode: row.employeeCode,
        status: row.status,
        checkInAt: row.checkInAt.toISOString(),
        checkOutAt: row.checkOutAt ? row.checkOutAt.toISOString() : null,
        workedMinutes: row.workedMinutes ?? null,
      }));
  }

  async setEmployeeActive(employeeId: string, active: boolean): Promise<{ ok: true }> {
    const employee = this.employees.find((item) => item.id === employeeId);
    if (!employee) throw new HttpError(404, "No encontramos ese trabajador.");
    employee.active = active;
    employee.updatedAt = new Date();
    return { ok: true };
  }

  async updateEmployeePay(employeeId: string, input: { hourlyRate: number; yapePhone: string | null }): Promise<EmployeeRecord> {
    const employee = this.employees.find((item) => item.id === employeeId);
    if (!employee) throw new HttpError(404, "No encontramos ese trabajador.");
    employee.hourlyRate = input.hourlyRate;
    if (input.yapePhone) employee.yapePhone = input.yapePhone;
    else delete employee.yapePhone;
    employee.updatedAt = new Date();
    return this.toEmployeeRecord(employee);
  }

  saveYapeQr(employeeId: string, image: YapeQrRecord | null, now: Date): Promise<EmployeeRecord> {
    return this.enqueue(() => {
      const employee = this.employees.find((item) => item.id === employeeId);
      if (!employee) throw new HttpError(404, "No encontramos ese trabajador.");
      if (image) this.yapeQr.set(employeeId, { contentType: image.contentType, bytes: Buffer.from(image.bytes) });
      else this.yapeQr.delete(employeeId);
      employee.yapeQrRegistered = image != null;
      employee.updatedAt = now;
      return this.toEmployeeRecord(employee);
    });
  }

  async getYapeQr(employeeId: string): Promise<YapeQrRecord | null> {
    const image = this.yapeQr.get(employeeId);
    if (!image) return null;
    return { contentType: image.contentType, bytes: Buffer.from(image.bytes) };
  }

  async listYapeDeclarations(weekStart: string): Promise<YapeDeclarationRecord[]> {
    return this.yapeDeclarations
      .filter((item) => item.weekStart === weekStart)
      .map((item) => ({ ...item }));
  }

  saveYapeDeclaration(draft: YapeDeclarationRecord): Promise<{ declaration: YapeDeclarationRecord; created: boolean }> {
    return this.enqueue(() => {
      const existing = this.yapeDeclarations.find((item) => item.id === draft.id);
      if (existing) return { declaration: { ...existing }, created: false };
      const declaration: YapeDeclarationRecord = { ...draft, status: "reported_paid" };
      this.yapeDeclarations.push(declaration);
      return { declaration: { ...declaration }, created: true };
    });
  }

  async listSettlementAttendances(from: Date, to: Date): Promise<AttendanceDoc[]> {
    return this.attendances
      .filter((attendance) => {
        const checkIn = attendance.checkInAt?.getTime();
        return typeof checkIn === "number" && Number.isFinite(checkIn) && checkIn >= from.getTime() && checkIn < to.getTime();
      })
      .map((attendance) => ({ ...attendance }));
  }

  async listWeeklyPayments(weekStart: string): Promise<WeeklyPaymentRecord[]> {
    return this.weeklyPayments
      .filter((payment) => payment.weekStart === weekStart)
      .map((payment) => ({ ...payment, shifts: payment.shifts.map((shift) => ({ ...shift })) }));
  }

  saveWeeklyPayment(draft: PaymentDraft, now: Date): Promise<{ payment: WeeklyPaymentRecord; created: boolean }> {
    return this.enqueue(() => {
      const id = settlementDocumentId(draft.employeeId, draft.weekStart);
      const existing = this.weeklyPayments.find((payment) => payment.id === id);
      if (existing) return { payment: { ...existing, shifts: existing.shifts.map((shift) => ({ ...shift })) }, created: false };
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
      this.weeklyPayments.push(payment);
      return { payment: { ...payment, shifts: payment.shifts.map((shift) => ({ ...shift })) }, created: true };
    });
  }

  async listPaymentOperations(weekStart: string): Promise<PaymentOperationRecord[]> {
    return this.paymentOperations
      .filter((operation) => operation.weekStart === weekStart)
      .map((operation) => ({ ...operation }));
  }

  reservePaymentOperation(draft: PaymentReserveDraft, now: Date): Promise<{ operation: PaymentOperationRecord; reserved: boolean }> {
    return this.enqueue(() => {
      const id = settlementDocumentId(draft.employeeId, draft.weekStart);
      const current = this.paymentOperations.find((operation) => operation.id === id);
      if (current?.status === "paid") throw new HttpError(409, PAYMENT_ALREADY_PAID);
      if (current && (current.status === "pending" || current.status === "processing")) {
        return { operation: { ...current }, reserved: false };
      }
      if (current) {
        current.weekEnd = draft.weekEnd;
        current.amount = draft.amount;
        current.yapePhone = draft.yapePhone;
        current.status = "pending";
        current.attempt += 1;
        current.provider = null;
        current.providerReference = null;
        current.redirectUrl = null;
        current.updatedAt = now.toISOString();
        return { operation: { ...current }, reserved: true };
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
      this.paymentOperations.push(operation);
      return { operation: { ...operation }, reserved: true };
    });
  }

  finishPaymentAttempt(id: string, attempt: number, result: PaymentAttemptResult, now: Date): Promise<PaymentOperationRecord> {
    return this.enqueue(() => {
      const current = this.paymentOperations.find((operation) => operation.id === id);
      if (!current || current.attempt !== attempt || current.status !== "pending") throw new HttpError(409, PAYMENT_UNCERTAIN);
      if (result.status === "processing") {
        current.status = "processing";
        current.provider = result.provider;
        current.providerReference = result.providerReference;
        current.redirectUrl = result.redirectUrl;
      } else {
        current.status = "failed";
        current.provider = null;
        current.providerReference = null;
        current.redirectUrl = null;
      }
      current.updatedAt = now.toISOString();
      return { ...current };
    });
  }

  applyVerifiedPayment(notice: VerifiedPayment, now: Date): Promise<{ applied: boolean }> {
    return this.enqueue(() => {
      if (notice.currency !== "PEN" || (notice.status !== "paid" && notice.status !== "failed")) return { applied: false };
      const current = this.paymentOperations.find((operation) => operation.id === notice.operationId);
      if (!current || current.status !== "processing" || !current.providerReference || current.providerReference !== notice.providerReference) {
        return { applied: false };
      }
      if (Math.round(current.amount * 100) !== Math.round(notice.amount * 100)) return { applied: false };
      current.status = notice.status;
      current.updatedAt = now.toISOString();
      return { applied: true };
    });
  }

  private toEmployeeRecord(employee: StoredEmployee): EmployeeRecord {
    return {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employeeCode,
      active: employee.active,
      createdAt: employee.createdAt ? employee.createdAt.toISOString() : null,
      hourlyRate: typeof employee.hourlyRate === "number" ? employee.hourlyRate : null,
      yapePhone: employee.yapePhone ?? null,
      yapeQrRegistered: employee.yapeQrRegistered === true,
    };
  }
}

class MemoryTx implements AttendanceTx {
  private employees: StoredEmployee[];
  private attendances: AttendanceDoc[];

  constructor(private readonly db: MemoryDatabase) {
    this.employees = db.employees.map((employee) => ({ ...employee }));
    this.attendances = db.attendances.map((attendance) => ({ ...attendance }));
  }

  async getEmployee(id: string): Promise<EmployeePublic | null> {
    const employee = this.employees.find((item) => item.id === id);
    if (!employee) return null;
    return { id: employee.id, name: employee.name, employeeCode: employee.employeeCode, active: employee.active };
  }

  async listOpenAttendances(employeeId: string): Promise<AttendanceDoc[]> {
    return this.attendances
      .filter((attendance) => attendance.employeeId === employeeId && attendance.status === "open")
      .slice(0, 5)
      .map((attendance) => ({ ...attendance }));
  }

  createOpenAttendance(record: {
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    checkInAt: Date;
    createdAt: Date;
  }): void {
    this.attendances.push({
      id: this.db.nextId("att"),
      employeeId: record.employeeId,
      employeeCode: record.employeeCode,
      employeeName: record.employeeName,
      status: "open",
      checkInAt: record.checkInAt,
      createdAt: record.createdAt,
    });
  }

  closeAttendance(id: string, patch: { checkOutAt: Date; workedMinutes: number; updatedAt: Date }): void {
    const attendance = this.attendances.find((item) => item.id === id);
    if (!attendance) throw new HttpError(409, "No se pudo registrar la marcación. Inténtalo de nuevo.");
    attendance.status = "closed";
    attendance.checkOutAt = patch.checkOutAt;
    attendance.workedMinutes = patch.workedMinutes;
    attendance.updatedAt = patch.updatedAt;
  }

  touchEmployee(id: string, updatedAt: Date): void {
    const employee = this.employees.find((item) => item.id === id);
    if (!employee) throw new HttpError(404, "No encontramos un trabajador registrado con ese nombre.");
    employee.updatedAt = updatedAt;
  }

  commit(): void {
    const live = new Map(this.db.employees.map((employee) => [employee.id, employee]));
    this.db.employees = this.employees.map((employee) => {
      const current = live.get(employee.id);
      return {
        ...employee,
        hourlyRate: current?.hourlyRate,
        yapePhone: current?.yapePhone,
        yapeQrRegistered: current?.yapeQrRegistered,
      };
    });
    this.db.attendances = this.attendances.map((attendance) => ({ ...attendance }));
  }
}
