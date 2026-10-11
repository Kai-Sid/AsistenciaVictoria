export type EmployeePublic = {
  id: string;
  name: string;
  employeeCode: string;
  active: boolean;
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
  createEmployee(input: { name: string; employeeCode: string; pin: string }): Promise<EmployeePublic>;
  listEmployees(): Promise<EmployeePublic[]>;
  listAttendances(): Promise<AttendanceView[]>;
  setEmployeeActive(employeeId: string, active: boolean): Promise<{ ok: true }>;
};

export type TokenCheck = { uid: string; admin: boolean };
export type TokenVerifier = (idToken: string) => Promise<TokenCheck>;

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
