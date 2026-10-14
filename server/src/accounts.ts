import type { Auth } from "firebase-admin/auth";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { HttpError } from "./http-error.js";
import type { AccountRecord, AccountStore, AuthDirectory } from "./types.js";

const DUPLICATE_EMAIL = "Ya existe una cuenta con ese correo.";
const DUPLICATE_UID = "Esa cuenta ya está registrada.";
const MISSING_ACCOUNT = "No encontramos esa cuenta administrativa.";
const INVALID_ROLE = "Esa cuenta no tiene el rol de administrador.";
const LAST_ADMIN = "Debe quedar al menos un administrador activo.";

function asIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

function readAccount(id: string, data: Record<string, unknown>): AccountRecord {
  return {
    uid: id,
    name: typeof data.name === "string" ? data.name : "",
    email: typeof data.email === "string" ? data.email : "",
    role: typeof data.role === "string" ? data.role : "",
    active: data.active === true,
    createdAt: asIso(data.createdAt),
    updatedAt: asIso(data.updatedAt),
  };
}

type ActiveOutcome =
  | { ok: true; account: AccountRecord }
  | { ok: false; error: "missing" | "role" | "last" };

type CreateOutcome =
  | { ok: true; account: AccountRecord }
  | { ok: false; error: "uid" | "email" };

export class FirestoreAccountStore implements AccountStore {
  constructor(private readonly db: Firestore) {}

  async get(uid: string): Promise<AccountRecord | null> {
    const snap = await this.db.collection("accounts").doc(uid).get();
    if (!snap.exists) return null;
    return readAccount(snap.id, snap.data() ?? {});
  }

  async list(): Promise<AccountRecord[]> {
    const snap = await this.db.collection("accounts").get();
    return snap.docs
      .map((doc) => readAccount(doc.id, doc.data()))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }

  async create(input: { uid: string; name: string; email: string; now: Date }): Promise<AccountRecord> {
    const email = input.email.trim().toLowerCase();
    const outcome = await this.db.runTransaction(async (tx): Promise<CreateOutcome> => {
      const ref = this.db.collection("accounts").doc(input.uid);
      const current = await tx.get(ref);
      if (current.exists) return { ok: false, error: "uid" };
      const all = await tx.get(this.db.collection("accounts"));
      if (all.docs.some((doc) => String(doc.get("email") ?? "").toLowerCase() === email)) {
        return { ok: false, error: "email" };
      }
      const createdAt = Timestamp.fromDate(input.now);
      tx.create(ref, {
        name: input.name,
        email,
        role: "admin",
        active: true,
        createdAt,
        updatedAt: createdAt,
      });
      return {
        ok: true,
        account: {
          uid: input.uid,
          name: input.name,
          email,
          role: "admin",
          active: true,
          createdAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        },
      };
    });
    if (!outcome.ok) {
      throw new HttpError(409, outcome.error === "email" ? DUPLICATE_EMAIL : DUPLICATE_UID);
    }
    return outcome.account;
  }

  async setActive(uid: string, active: boolean, now: Date): Promise<AccountRecord> {
    const outcome = await this.db.runTransaction(async (tx): Promise<ActiveOutcome> => {
      const ref = this.db.collection("accounts").doc(uid);
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, error: "missing" };
      const current = readAccount(snap.id, snap.data() ?? {});
      if (current.role !== "admin") return { ok: false, error: "role" };
      if (current.active === active) return { ok: true, account: current };
      if (!active) {
        const all = await tx.get(this.db.collection("accounts"));
        const others = all.docs.filter((doc) => doc.id !== uid && doc.get("role") === "admin" && doc.get("active") === true);
        if (others.length === 0) return { ok: false, error: "last" };
      }
      tx.update(ref, { active, updatedAt: Timestamp.fromDate(now) });
      return { ok: true, account: { ...current, active, updatedAt: now.toISOString() } };
    });
    if (!outcome.ok) {
      if (outcome.error === "missing") throw new HttpError(404, MISSING_ACCOUNT);
      if (outcome.error === "last") throw new HttpError(409, LAST_ADMIN);
      throw new HttpError(409, INVALID_ROLE);
    }
    return outcome.account;
  }
}

export class FirebaseAuthDirectory implements AuthDirectory {
  constructor(private readonly auth: Auth) {}

  async createUser(input: { name: string; email: string; password: string }): Promise<{ uid: string; email: string }> {
    const user = await this.auth.createUser({
      email: input.email,
      password: input.password,
      displayName: input.name,
    });
    return { uid: user.uid, email: user.email ?? input.email };
  }

  deleteUser(uid: string): Promise<void> {
    return this.auth.deleteUser(uid);
  }

  async setAdminClaim(uid: string): Promise<void> {
    const user = await this.auth.getUser(uid);
    const current = user.customClaims;
    const claims = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    await this.auth.setCustomUserClaims(uid, { ...claims, admin: true });
  }
}
