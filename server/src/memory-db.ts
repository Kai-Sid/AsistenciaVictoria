import bcrypt from "bcryptjs";
import { HttpError } from "./http-error.js";
import type {
  AdminDatabase,
  AttendanceDatabase,
  AttendanceDoc,
  AttendanceTx,
  AttendanceView,
  EmployeePublic,
} from "./types.js";

type StoredEmployee = EmployeePublic & { pinHash?: string; createdAt?: Date; updatedAt?: Date };

export class MemoryDatabase implements AttendanceDatabase, AdminDatabase {
  employees: StoredEmployee[] = [];
  attendances: AttendanceDoc[] = [];
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;

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

  async createEmployee(input: { name: string; employeeCode: string; pin: string }): Promise<EmployeePublic> {
    if (this.employees.some((employee) => employee.employeeCode === input.employeeCode)) {
      throw new HttpError(409, "Ese código de trabajador ya existe.");
    }
    const pinHash = await bcrypt.hash(input.pin, 12);
    const employee: StoredEmployee = {
      id: this.nextId("emp"),
      name: input.name,
      employeeCode: input.employeeCode,
      active: true,
      pinHash,
      createdAt: new Date(),
    };
    this.employees.push(employee);
    return { id: employee.id, name: employee.name, employeeCode: employee.employeeCode, active: true };
  }

  async listEmployees(): Promise<EmployeePublic[]> {
    return this.employees
      .map(({ id, name, employeeCode, active }) => ({ id, name, employeeCode, active }))
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
    this.db.employees = this.employees.map((employee) => ({ ...employee }));
    this.db.attendances = this.attendances.map((attendance) => ({ ...attendance }));
  }
}
