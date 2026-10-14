import { createApp } from "./app.js";
import { FirebaseConfigError, initFirebase, type FirestoreReadiness } from "./firebase.js";
import { resolveAllowedOrigins } from "./origins.js";
import type { AccountStore, AdminDatabase, AttendanceDatabase, AuthDirectory, TokenVerifier } from "./types.js";

const allowedOrigins = resolveAllowedOrigins(process.env.ALLOWED_ORIGINS);

let database: (AttendanceDatabase & AdminDatabase) | null = null;
let verifyToken: TokenVerifier | null = null;
let accounts: AccountStore | null = null;
let authDirectory: AuthDirectory | null = null;
let firestoreStatus: FirestoreReadiness = "not-configured";
try {
  const firebase = initFirebase();
  database = firebase.database;
  verifyToken = firebase.verifyToken;
  accounts = firebase.accounts;
  authDirectory = firebase.authDirectory;
  firestoreStatus = "ready";
} catch (error) {
  firestoreStatus = error instanceof FirebaseConfigError ? error.reason : "invalid-credentials";
  console.error(`Firebase Admin no quedó listo (${firestoreStatus}). /api/health sigue activo.`);
}

const app = createApp({ database, verifyToken, accounts, authDirectory, allowedOrigins, firestoreStatus });
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT no es válido");
  process.exit(1);
}

app.listen(port, "0.0.0.0", () => {
  console.log(`AsistenciaVictoria API escuchando en el puerto ${port}`);
  console.log(`CORS permitido para: ${allowedOrigins.join(", ")}`);
});
