import { readFileSync } from "node:fs";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { FirebaseAuthDirectory, FirestoreAccountStore } from "./accounts.js";
import { FirestoreDatabase } from "./firestore-db.js";
import type { TokenVerifier } from "./types.js";

export type FirestoreReadiness = "ready" | "not-configured" | "project-mismatch" | "invalid-credentials";

export class FirebaseConfigError extends Error {
  readonly reason: Exclude<FirestoreReadiness, "ready">;

  constructor(reason: Exclude<FirestoreReadiness, "ready">) {
    super(reason);
    this.name = "FirebaseConfigError";
    this.reason = reason;
  }
}

type ServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

export type FirebaseServices = {
  database: FirestoreDatabase;
  accounts: FirestoreAccountStore;
  authDirectory: FirebaseAuthDirectory;
  verifyToken: TokenVerifier;
  projectId: string;
};

function expectedProjectId(): string {
  return (process.env.FIREBASE_PROJECT_ID ?? "").trim();
}

function accountFromParsed(value: unknown): ServiceAccount {
  if (!value || typeof value !== "object") throw new FirebaseConfigError("invalid-credentials");
  const record = value as { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  const projectId = typeof record.project_id === "string" ? record.project_id.trim() : "";
  const clientEmail = typeof record.client_email === "string" ? record.client_email.trim() : "";
  const privateKey = typeof record.private_key === "string" ? record.private_key.replace(/\\n/g, "\n").trim() : "";
  if (!projectId || !clientEmail || !privateKey.includes("PRIVATE KEY")) {
    throw new FirebaseConfigError("invalid-credentials");
  }
  return { projectId, clientEmail, privateKey };
}

function parseAccountJson(raw: string): ServiceAccount {
  try {
    return accountFromParsed(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch (error) {
    if (error instanceof FirebaseConfigError) throw error;
    throw new FirebaseConfigError("invalid-credentials");
  }
}

function sameProject(credentialProjectId: string): string {
  const expected = expectedProjectId();
  if (!expected) throw new FirebaseConfigError("not-configured");
  if (expected !== credentialProjectId) throw new FirebaseConfigError("project-mismatch");
  return expected;
}

function accountFromEnvironment(): { account: ServiceAccount; source: "json" | "file" } {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const credentialsPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (!raw && !credentialsPath) throw new FirebaseConfigError("not-configured");
  if (raw) return { account: parseAccountJson(raw), source: "json" };
  let fileText: string;
  try {
    fileText = readFileSync(credentialsPath, "utf8");
  } catch {
    throw new FirebaseConfigError("invalid-credentials");
  }
  return { account: parseAccountJson(fileText), source: "file" };
}

export function inspectFirebaseConfig(): { ok: true; projectId: string; source: "json" | "file" } | { ok: false; reason: Exclude<FirestoreReadiness, "ready"> } {
  try {
    const { account, source } = accountFromEnvironment();
    return { ok: true, projectId: sameProject(account.projectId), source };
  } catch (error) {
    if (error instanceof FirebaseConfigError) return { ok: false, reason: error.reason };
    return { ok: false, reason: "invalid-credentials" };
  }
}

export function initFirebase(): FirebaseServices {
  const { account, source } = accountFromEnvironment();
  const projectId = sameProject(account.projectId);
  if (getApps().length === 0) {
    initializeApp(source === "json"
      ? {
          credential: cert({
            projectId,
            clientEmail: account.clientEmail,
            privateKey: account.privateKey,
          }),
          projectId,
        }
      : {
          credential: applicationDefault(),
          projectId,
        });
  }
  const auth = getAuth();
  const firestore = getFirestore();
  return {
    projectId,
    database: new FirestoreDatabase(firestore),
    accounts: new FirestoreAccountStore(firestore),
    authDirectory: new FirebaseAuthDirectory(auth),
    verifyToken: async (idToken: string) => {
      const decoded = await auth.verifyIdToken(idToken);
      return {
        uid: decoded.uid,
        admin: decoded.admin === true,
        email: typeof decoded.email === "string" ? decoded.email : null,
      };
    },
  };
}
