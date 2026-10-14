import { HttpError } from "./http-error.js";
import type { AccountRecord, AccountStore, AuthDirectory } from "./types.js";

export type MemoryAccount = {
  uid: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type MemoryAuthUser = {
  uid: string;
  email: string;
  password: string;
  claims: Record<string, unknown>;
};

const DUPLICATE_EMAIL = "Ya existe una cuenta con ese correo.";
const DUPLICATE_UID = "Esa cuenta ya está registrada.";
const MISSING_ACCOUNT = "No encontramos esa cuenta administrativa.";
const INVALID_ROLE = "Esa cuenta no tiene el rol de administrador.";
const LAST_ADMIN = "Debe quedar al menos un administrador activo.";

function toRecord(account: MemoryAccount): AccountRecord {
  return {
    uid: account.uid,
    name: account.name,
    email: account.email,
    role: account.role,
    active: account.active,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

export class MemoryAccountStore implements AccountStore {
  accounts: MemoryAccount[] = [];
  failCreateMessage: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  get(uid: string): Promise<AccountRecord | null> {
    return this.enqueue(async () => {
      const account = this.accounts.find((item) => item.uid === uid);
      return account ? toRecord(account) : null;
    });
  }

  list(): Promise<AccountRecord[]> {
    return this.enqueue(async () => this.accounts.map((account) => toRecord(account)).sort((a, b) => a.name.localeCompare(b.name, "es")));
  }

  create(input: { uid: string; name: string; email: string; now: Date }): Promise<AccountRecord> {
    return this.enqueue(async () => {
      if (this.failCreateMessage) {
        const message = this.failCreateMessage;
        this.failCreateMessage = null;
        throw new Error(message);
      }
      const email = input.email.trim().toLowerCase();
      if (this.accounts.some((account) => account.uid === input.uid)) throw new HttpError(409, DUPLICATE_UID);
      if (this.accounts.some((account) => account.email === email)) throw new HttpError(409, DUPLICATE_EMAIL);
      const account: MemoryAccount = {
        uid: input.uid,
        name: input.name,
        email,
        role: "admin",
        active: true,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.accounts.push(account);
      return toRecord(account);
    });
  }

  setActive(uid: string, active: boolean, now: Date): Promise<AccountRecord> {
    return this.enqueue(async () => {
      const account = this.accounts.find((item) => item.uid === uid);
      if (!account) throw new HttpError(404, MISSING_ACCOUNT);
      if (account.role !== "admin") throw new HttpError(409, INVALID_ROLE);
      if (account.active === active) return toRecord(account);
      if (!active) {
        const others = this.accounts.filter((item) => item.uid !== uid && item.role === "admin" && item.active);
        if (others.length === 0) throw new HttpError(409, LAST_ADMIN);
      }
      account.active = active;
      account.updatedAt = now;
      return toRecord(account);
    });
  }
}

export class EmailAlreadyExistsError extends Error {
  readonly code = "auth/email-already-exists";

  constructor() {
    super("email-already-exists");
    this.name = "EmailAlreadyExistsError";
  }
}

export class MemoryAuthDirectory implements AuthDirectory {
  users: MemoryAuthUser[] = [];
  private sequence = 0;

  async createUser(input: { name: string; email: string; password: string }): Promise<{ uid: string; email: string }> {
    const email = input.email.trim().toLowerCase();
    if (this.users.some((user) => user.email === email)) throw new EmailAlreadyExistsError();
    this.sequence += 1;
    const user: MemoryAuthUser = {
      uid: `auth-${this.sequence}`,
      email,
      password: input.password,
      claims: {},
    };
    this.users.push(user);
    return { uid: user.uid, email: user.email };
  }

  async deleteUser(uid: string): Promise<void> {
    const before = this.users.length;
    this.users = this.users.filter((user) => user.uid !== uid);
    if (this.users.length === before) throw new Error("missing-user");
  }

  async setAdminClaim(uid: string): Promise<void> {
    const user = this.users.find((item) => item.uid === uid);
    if (!user) throw new Error("missing-user");
    user.claims = { ...user.claims, admin: true };
  }
}
