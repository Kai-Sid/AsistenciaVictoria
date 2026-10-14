import bcrypt from "bcryptjs";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { HttpError } from "./http-error.js";
import type {
  AdminDatabase,
  AttendanceDatabase,
  AttendanceDoc,
  AttendanceTx,
  AttendanceView,
  EmployeePublic,
  EmployeeRecord,
} from "./types.js";

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

  async createEmployee(input: { name: string; employeeCode: string; pin: string }): Promise<EmployeePublic> {
    const existing = await this.db.collection("employees").where("employeeCode", "==", input.employeeCode).limit(1).get();
    if (!existing.empty) throw new HttpError(409, "Ese código de trabajador ya existe.");
    const pinHash = await bcrypt.hash(input.pin, 12);
    const ref = await this.db.collection("employees").add({
      name: input.name,
      employeeCode: input.employeeCode,
      pinHash,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id, name: input.name, employeeCode: input.employeeCode, active: true };
  }

  async listEmployees(): Promise<EmployeeRecord[]> {
    const snap = await this.db.collection("employees").orderBy("name").get();
    return snap.docs.map((doc) => ({
      id: doc.id,
      name: String(doc.get("name") ?? ""),
      employeeCode: String(doc.get("employeeCode") ?? ""),
      active: doc.get("active") === true,
      createdAt: asDate(doc.get("createdAt"))?.toISOString() ?? null,
    }));
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
}
