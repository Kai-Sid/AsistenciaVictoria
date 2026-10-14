export type EmployeePublic = {
  id: string;
  name: string;
  employeeCode: string;
  active: boolean;
};

export type EmployeeRecord = EmployeePublic & {
  createdAt: string | null;
};

export type EmployeeMatch = {
  id: string;
  name: string;
  employeeCode: string;
};

export type AttendanceDoc = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  status: string;
  checkInAt: Date;
  checkOutAt?: Date;
  workedMinutes?: number;
  createdAt: Date;
  updatedAt?: Date;
};

export type AttendanceView = {
  id: string;
  employeeName: string;
  employeeCode: string;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
};

export type AttendanceTx = {
  getEmployee(id: string): Promise<EmployeePublic | null>;
  listOpenAttendances(employeeId: string): Promise<AttendanceDoc[]>;
  createOpenAttendance(record: {
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    checkInAt: Date;
    createdAt: Date;
  }): void;
  closeAttendance(id: string, patch: { checkOutAt: Date; workedMinutes: number; updatedAt: Date }): void;
  touchEmployee(id: string, updatedAt: Date): void;
};

export type AttendanceDatabase = {
  listActiveEmployees(): Promise<EmployeeMatch[]>;
  runAttendanceTransaction<T>(work: (tx: AttendanceTx) => Promise<T>): Promise<T>;
};

export type AdminDatabase = {
  createEmployee(input: { name: string; employeeCode: string }): Promise<EmployeePublic>;
  listEmployees(): Promise<EmployeeRecord[]>;
  listAttendances(): Promise<AttendanceView[]>;
  setEmployeeActive(employeeId: string, active: boolean): Promise<{ ok: true }>;
};

export type TokenCheck = { uid: string; admin: boolean; email: string | null };
export type TokenVerifier = (idToken: string) => Promise<TokenCheck>;

export type AccountRecord = {
  uid: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AccountStore = {
  get(uid: string): Promise<AccountRecord | null>;
  list(): Promise<AccountRecord[]>;
  create(input: { uid: string; name: string; email: string; now: Date }): Promise<AccountRecord>;
  setActive(uid: string, active: boolean, now: Date): Promise<AccountRecord>;
};

export type AuthDirectory = {
  createUser(input: { name: string; email: string; password: string }): Promise<{ uid: string; email: string }>;
  deleteUser(uid: string): Promise<void>;
  setAdminClaim(uid: string): Promise<void>;
};

export type AttendanceSuccess = {
  ok: true;
  action: "entrada" | "salida";
  employeeName: string;
  timestamp: string;
  message: string;
};

export type AttendanceChoice = {
  ok: false;
  message: string;
  employees: EmployeePublic[];
};
