import express, { type NextFunction, type Request, type Response } from "express";
import { parseAttendanceInput, recordAttendance } from "./attendance.js";
import { HttpError } from "./http-error.js";
import { createRateLimiter } from "./rate-limit.js";
import type { FirestoreReadiness } from "./firebase.js";
import {
  draftFromView,
  parsePayUpdate,
  parseSettlementConfirm,
  previewWeek,
  settlementAttendanceWindow,
  settlementFromPayment,
  weekBoundsFromKey,
  weekContaining,
} from "./settlements.js";
import type { AccountRecord, AccountStore, AdminDatabase, AttendanceDatabase, AuthDirectory, TokenVerifier } from "./types.js";

const NOT_CONFIGURED = "El servidor no está configurado para acceder a Firestore.";
const ADMIN_DENIED = "Se requiere permiso de administrador.";

export type AppOptions = {
  database: (AttendanceDatabase & AdminDatabase) | null;
  verifyToken: TokenVerifier | null;
  accounts?: AccountStore | null;
  authDirectory?: AuthDirectory | null;
  allowedOrigins: string[];
  firestoreStatus?: FirestoreReadiness;
  now?: () => Date;
  attendanceRateLimit?: { max: number; windowMs: number };
};

type AdminAccess = {
  uid: string;
  email: string | null;
  account: AccountRecord | null;
};

function cors(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(origin && allowed.has(origin) ? 204 : 403).end();
      return;
    }
    next();
  };
}

async function requireAdmin(req: Request, verifyToken: TokenVerifier | null, accounts: AccountStore | null): Promise<AdminAccess> {
  if (!verifyToken) throw new HttpError(503, NOT_CONFIGURED);
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, ADMIN_DENIED);
  let token;
  try {
    token = await verifyToken(match[1]);
  } catch {
    throw new HttpError(401, ADMIN_DENIED);
  }
  if (!accounts) {
    if (token.admin !== true) throw new HttpError(403, ADMIN_DENIED);
    return { uid: token.uid, email: token.email, account: null };
  }
  let account: AccountRecord | null;
  try {
    account = await accounts.get(token.uid);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, NOT_CONFIGURED);
  }
  // El documento manda cuando existe. El claim solo cubre a quien todavía no tiene accounts/{uid}.
  if (account) {
    if (account.role !== "admin" || account.active !== true) throw new HttpError(403, ADMIN_DENIED);
    return { uid: token.uid, email: account.email || token.email, account };
  }
  if (token.admin === true) return { uid: token.uid, email: token.email, account: null };
  throw new HttpError(403, ADMIN_DENIED);
}

function parseCreateEmployee(body: unknown): { name: string; employeeCode: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "La solicitud no es válida.");
  }
  const record = body as { name?: unknown; employeeCode?: unknown };
  const name = String(record.name ?? "").trim();
  const employeeCode = String(record.employeeCode ?? "").trim().toUpperCase();
  if (name.length < 2 || name.length > 100 || !/^[A-Z0-9-]{3,20}$/.test(employeeCode)) {
    throw new HttpError(400, "Nombre o código no válidos.");
  }
  return { name, employeeCode };
}

function parseCreateAccount(body: unknown): { name: string; email: string; password: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "La solicitud no es válida.");
  }
  const record = body as { name?: unknown; email?: unknown; password?: unknown };
  const name = String(record.name ?? "").trim().replace(/\s+/g, " ");
  const email = String(record.email ?? "").trim().toLowerCase();
  const password = typeof record.password === "string" ? record.password : "";
  if (name.length < 2 || name.length > 100) throw new HttpError(400, "El nombre debe tener entre 2 y 100 caracteres.");
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "El correo no es válido.");
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "La contraseña debe tener entre 8 y 128 caracteres.");
  return { name, email, password };
}

function parseAccountActive(body: unknown): { uid: string; active: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Datos no válidos.");
  const record = body as { uid?: unknown; active?: unknown };
  const uid = String(record.uid ?? "").trim();
  if (!uid || uid.includes("/") || uid.length > 128 || typeof record.active !== "boolean") {
    throw new HttpError(400, "Datos no válidos.");
  }
  return { uid, active: record.active };
}

function publicAccount(account: AccountRecord) {
  return {
    uid: account.uid,
    name: account.name,
    email: account.email,
    role: account.role,
    active: account.active,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function authErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z0-9/_-]+$/i.test(code) ? code : "";
}

async function registerAdminAccount(
  accounts: AccountStore,
  directory: AuthDirectory,
  input: { name: string; email: string; password: string },
  now: Date,
): Promise<AccountRecord> {
  let created: { uid: string; email: string } | null = null;
  try {
    created = await directory.createUser(input);
    const account = await accounts.create({
      uid: created.uid,
      name: input.name,
      email: created.email.trim().toLowerCase(),
      now,
    });
    try {
      await directory.setAdminClaim(created.uid);
    } catch {
      console.error("No se pudo conservar el claim admin de la cuenta nueva.");
    }
    return account;
  } catch (error) {
    if (created) {
      try {
        await directory.deleteUser(created.uid);
      } catch {
        console.error("No se pudo eliminar el usuario de Authentication creado en esta solicitud.");
      }
    }
    if (error instanceof HttpError) throw error;
    const code = authErrorCode(error);
    if (code === "auth/email-already-exists" || code === "auth/email-already-in-use") {
      throw new HttpError(409, "Ya existe una cuenta con ese correo.");
    }
    if (code === "auth/invalid-email") throw new HttpError(400, "El correo no es válido.");
    if (code === "auth/invalid-password") throw new HttpError(400, "La contraseña debe tener entre 8 y 128 caracteres.");
    throw new HttpError(503, "No se pudo registrar la cuenta administrativa.");
  }
}

function parseActive(body: unknown): { employeeId: string; active: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Datos no válidos.");
  }
  const record = body as { employeeId?: unknown; active?: unknown };
  const employeeId = String(record.employeeId ?? "").trim();
  if (!employeeId || employeeId.includes("/") || employeeId.length > 128 || typeof record.active !== "boolean") {
    throw new HttpError(400, "Datos no válidos.");
  }
  return { employeeId, active: record.active };
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const allowed = new Set(options.allowedOrigins);
  const limit = options.attendanceRateLimit ?? { max: 60, windowMs: 60_000 };
  const allowAttendance = createRateLimiter(limit.max, limit.windowMs);
  const allowAdmin = createRateLimiter(30, 60_000);
  const now = options.now ?? (() => new Date());

  app.use(cors(allowed));
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (_req, res) => {
    const status = options.firestoreStatus ?? (options.database ? "ready" : "not-configured");
    if (status === "ready") {
      res.json({ ok: true, firestore: true });
      return;
    }
    res.json({ ok: true, firestore: false, reason: status });
  });

  app.post("/api/attendance", async (req, res, next) => {
    try {
      if (!allowAttendance(req.ip || "desconocido")) {
        throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      }
      const input = parseAttendanceInput(req.body);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      let result;
      try {
        result = await recordAttendance(options.database, input, now());
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "No se pudo registrar la marcación. No se guardó ninguna asistencia.");
      }
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/employees", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      res.json({ employees: await options.database.listEmployees() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/employees", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      const input = parseCreateEmployee(req.body);
      const employee = await options.database.createEmployee(input);
      res.status(201).json(employee);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/employees/active", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      const input = parseActive(req.body);
      res.json(await options.database.setEmployeeActive(input.employeeId, input.active));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/employees/pay", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      const input = parsePayUpdate(req.body);
      res.json(await options.database.updateEmployeePay(input.employeeId, input));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/settlements", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      const requested = typeof req.query.week === "string" ? req.query.week : "";
      const week = requested ? weekBoundsFromKey(requested) : weekContaining(now());
      if (!week) throw new HttpError(400, "La semana no es válida. Indica el lunes de inicio.");
      const window = settlementAttendanceWindow(week);
      const [employees, attendances, payments] = await Promise.all([
        options.database.listEmployees(),
        options.database.listSettlementAttendances(window.from, window.to),
        options.database.listWeeklyPayments(week.weekStartKey),
      ]);
      const settlements = previewWeek({
        employees,
        attendances,
        confirmed: payments.map(settlementFromPayment),
        week,
      });
      res.json({ weekStart: week.weekStartKey, weekEnd: week.weekEndKey, settlements });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/settlements", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      const input = parseSettlementConfirm(req.body);
      const week = weekBoundsFromKey(input.weekStart);
      if (!week) throw new HttpError(400, "La semana no es válida. Indica el lunes de inicio.");
      const stored = (await options.database.listWeeklyPayments(week.weekStartKey)).find((payment) => payment.employeeId === input.employeeId);
      if (stored) {
        res.json({ created: false, settlement: settlementFromPayment(stored) });
        return;
      }
      const employees = await options.database.listEmployees();
      const employee = employees.find((item) => item.id === input.employeeId);
      if (!employee) throw new HttpError(404, "No encontramos ese trabajador.");
      const window = settlementAttendanceWindow(week);
      const attendances = (await options.database.listSettlementAttendances(window.from, window.to))
        .filter((attendance) => attendance.employeeId === input.employeeId);
      const [settlement] = previewWeek({ employees: [employee], attendances, confirmed: [], week });
      if (!settlement) throw new HttpError(400, "No hay jornadas cerradas para liquidar en esa semana.");
      const draft = draftFromView(settlement);
      const saved = await options.database.saveWeeklyPayment(draft, now());
      res.status(saved.created ? 201 : 200).json({ created: saved.created, settlement: settlementFromPayment(saved.payment) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/attendances", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      res.json({ attendances: await options.database.listAttendances() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/session", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      const access = await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      res.json({
        uid: access.uid,
        name: access.account?.name ?? null,
        email: access.account?.email ?? access.email,
        role: "admin",
        active: true,
        source: access.account ? "account" : "claim",
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/accounts", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.accounts) throw new HttpError(503, NOT_CONFIGURED);
      const accounts = await options.accounts.list();
      res.json({ accounts: accounts.map(publicAccount) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/accounts", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.accounts || !options.authDirectory) throw new HttpError(503, NOT_CONFIGURED);
      const input = parseCreateAccount(req.body);
      const known = await options.accounts.list();
      if (known.some((account) => account.email.toLowerCase() === input.email)) {
        throw new HttpError(409, "Ya existe una cuenta con ese correo.");
      }
      const account = await registerAdminAccount(options.accounts, options.authDirectory, input, now());
      res.status(201).json(publicAccount(account));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/accounts/active", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken, options.accounts ?? null);
      if (!options.accounts) throw new HttpError(503, NOT_CONFIGURED);
      const input = parseAccountActive(req.body);
      res.json(publicAccount(await options.accounts.setActive(input.uid, input.active, now())));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ ok: false, message: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ ok: false, message: "La solicitud no es válida." });
      return;
    }
    console.error("solicitud fallida");
    res.status(500).json({ ok: false, message: "El servidor no pudo completar la solicitud. Inténtalo de nuevo." });
  });

  return app;
}
