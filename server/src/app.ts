import express, { type NextFunction, type Request, type Response } from "express";
import { parseAttendanceInput, recordAttendance } from "./attendance.js";
import { HttpError } from "./http-error.js";
import { createRateLimiter } from "./rate-limit.js";
import type { FirestoreReadiness } from "./firebase.js";
import type { AdminDatabase, AttendanceDatabase, TokenVerifier } from "./types.js";

const NOT_CONFIGURED = "El servidor no está configurado para acceder a Firestore.";
const ADMIN_DENIED = "Se requiere permiso de administrador.";

export type AppOptions = {
  database: (AttendanceDatabase & AdminDatabase) | null;
  verifyToken: TokenVerifier | null;
  allowedOrigins: string[];
  firestoreStatus?: FirestoreReadiness;
  now?: () => Date;
  attendanceRateLimit?: { max: number; windowMs: number };
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

async function requireAdmin(req: Request, verifyToken: TokenVerifier | null): Promise<void> {
  if (!verifyToken) throw new HttpError(503, NOT_CONFIGURED);
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, ADMIN_DENIED);
  try {
    const token = await verifyToken(match[1]);
    if (token.admin !== true) throw new HttpError(403, ADMIN_DENIED);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, ADMIN_DENIED);
  }
}

function parseCreateEmployee(body: unknown): { name: string; employeeCode: string; pin: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "La solicitud no es válida.");
  }
  const record = body as { name?: unknown; employeeCode?: unknown; pin?: unknown };
  const name = String(record.name ?? "").trim();
  const employeeCode = String(record.employeeCode ?? "").trim().toUpperCase();
  const pin = String(record.pin ?? "");
  if (name.length < 2 || name.length > 100 || !/^[A-Z0-9-]{3,20}$/.test(employeeCode) || !/^\d{4,8}$/.test(pin)) {
    throw new HttpError(400, "Nombre, código o PIN no válidos. El PIN debe tener de 4 a 8 dígitos.");
  }
  return { name, employeeCode, pin };
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
      await requireAdmin(req, options.verifyToken);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      res.json({ employees: await options.database.listEmployees() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/employees", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken);
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
      await requireAdmin(req, options.verifyToken);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      const input = parseActive(req.body);
      res.json(await options.database.setEmployeeActive(input.employeeId, input.active));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/attendances", async (req, res, next) => {
    try {
      if (!allowAdmin(req.ip || "desconocido")) throw new HttpError(429, "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
      await requireAdmin(req, options.verifyToken);
      if (!options.database) throw new HttpError(503, NOT_CONFIGURED);
      res.json({ attendances: await options.database.listAttendances() });
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
