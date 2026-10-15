export type EmployeePublic = {
  id: string;
  name: string;
  employeeCode: string;
  active: boolean;
};

export type EmployeeRecord = EmployeePublic & {
  createdAt: string | null;
  hourlyRate: number | null;
  yapePhone: string | null;
  yapeQrRegistered: boolean;
};

export type YapeQrRecord = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
};

export type YapeDeclarationRecord = {
  id: string;
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  amount: number;
  currency: "PEN";
  status: "reported_paid";
  declaredAt: string;
  declaredByUid: string;
  declaredByName: string;
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

export type PaymentStatus = "pending" | "processing" | "paid" | "failed";

export type PaymentOperationRecord = {
  id: string;
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  amount: number;
  currency: "PEN";
  yapePhone: string;
  status: PaymentStatus;
  attempt: number;
  provider: string | null;
  providerReference: string | null;
  redirectUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentReserveDraft = {
  employeeId: string;
  weekStart: string;
  weekEnd: string;
  amount: number;
  currency: "PEN";
  yapePhone: string;
};

export type PaymentAttemptResult =
  | { status: "processing"; provider: string; providerReference: string; redirectUrl: string }
  | { status: "failed" };

export type VerifiedPayment = {
  operationId: string;
  providerReference: string;
  status: "paid" | "failed" | "processing";
  amount: number;
  currency: "PEN";
};

export type WeeklyPaymentRecord = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  hourlyRate: number;
  amount: number;
  currency: "PEN";
  status: "confirmed";
  yapePhone: string | null;
  shifts: { attendanceId: string; checkInAt: string; checkOutAt: string; minutes: number }[];
  createdAt: string;
  updatedAt: string;
};

export type AdminDatabase = {
  createEmployee(input: { name: string; employeeCode: string }): Promise<EmployeePublic>;
  listEmployees(): Promise<EmployeeRecord[]>;
  listAttendances(): Promise<AttendanceView[]>;
  setEmployeeActive(employeeId: string, active: boolean): Promise<{ ok: true }>;
  updateEmployeePay(employeeId: string, input: { hourlyRate: number; yapePhone: string | null }): Promise<EmployeeRecord>;
  saveYapeQr(employeeId: string, image: YapeQrRecord | null, now: Date): Promise<EmployeeRecord>;
  getYapeQr(employeeId: string): Promise<YapeQrRecord | null>;
  listYapeDeclarations(weekStart: string): Promise<YapeDeclarationRecord[]>;
  saveYapeDeclaration(draft: YapeDeclarationRecord): Promise<{ declaration: YapeDeclarationRecord; created: boolean }>;
  listSettlementAttendances(from: Date, to: Date): Promise<AttendanceDoc[]>;
  listWeeklyPayments(weekStart: string): Promise<WeeklyPaymentRecord[]>;
  saveWeeklyPayment(draft: {
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    weekStart: string;
    weekEnd: string;
    totalMinutes: number;
    hourlyRate: number;
    amount: number;
    currency: "PEN";
    yapePhone: string | null;
    shifts: WeeklyPaymentRecord["shifts"];
  }, now: Date): Promise<{ payment: WeeklyPaymentRecord; created: boolean }>;
  listPaymentOperations(weekStart: string): Promise<PaymentOperationRecord[]>;
  reservePaymentOperation(draft: PaymentReserveDraft, now: Date): Promise<{ operation: PaymentOperationRecord; reserved: boolean }>;
  finishPaymentAttempt(id: string, attempt: number, result: PaymentAttemptResult, now: Date): Promise<PaymentOperationRecord>;
  applyVerifiedPayment(notice: VerifiedPayment, now: Date): Promise<{ applied: boolean }>;
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
