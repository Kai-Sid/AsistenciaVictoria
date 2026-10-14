// Asigna admin: true a un usuario que ya existe en Firebase Authentication.
// No crea cuentas ni modifica a otros usuarios.
//
// Credenciales: GOOGLE_APPLICATION_CREDENTIALS debe apuntar a la clave JSON
// de una cuenta de servicio del proyecto asistenciavictoria-5a865
// (Firebase Console > Project settings > Service accounts).
// Este script no lee FIREBASE_SERVICE_ACCOUNT_JSON.
//
// setCustomUserClaims reemplaza el mapa completo de claims. Por eso se leen
// los claims actuales y solo se añade admin: true.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const EXPECTED_PROJECT_ID = "asistenciavictoria-5a865";

function exitWith(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  exitWith(
    [
      "Uso: node scripts/set-admin.mjs <correo-o-uid>",
      "     node scripts/set-admin.mjs --email <correo>",
      "     node scripts/set-admin.mjs --uid <uid>",
      "Muestra el usuario y solo escribe si confirmas con su UID.",
    ].join("\n"),
  );
}

function parseTarget(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0].trim() && !args[0].startsWith("-")) {
    const value = args[0].trim();
    return value.includes("@") ? { kind: "email", value } : { kind: "uid", value };
  }
  if (args.length === 2 && (args[0] === "--email" || args[0] === "--uid")) {
    const value = args[1].trim();
    if (!value || value.startsWith("-")) return null;
    return { kind: args[0] === "--email" ? "email" : "uid", value };
  }
  return null;
}

function assertServiceAccountProject() {
  const credentialsPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (!credentialsPath) {
    exitWith(
      `Define GOOGLE_APPLICATION_CREDENTIALS con la ruta local de la clave JSON de la cuenta de servicio de ${EXPECTED_PROJECT_ID}. No se modificó ningún usuario.`,
    );
  }

  let projectId = "";
  let serviceAccount = false;
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8").replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";
      serviceAccount = parsed.type === "service_account"
        && typeof parsed.private_key === "string"
        && parsed.private_key.includes("PRIVATE KEY");
    }
  } catch {
    exitWith("No se pudo leer la cuenta de servicio. Comprueba GOOGLE_APPLICATION_CREDENTIALS. No se modificó ningún usuario.");
  }

  if (!serviceAccount) {
    exitWith("El archivo no es una clave de cuenta de servicio. No se modificó ningún usuario.");
  }
  if (!projectId) {
    exitWith("La cuenta de servicio no incluye project_id. No se modificó ningún usuario.");
  }
  if (projectId !== EXPECTED_PROJECT_ID) {
    exitWith(`La cuenta de servicio pertenece a "${projectId}", no a ${EXPECTED_PROJECT_ID}. No se modificó ningún usuario.`);
  }
}

function claimsOf(user) {
  const raw = user.customClaims;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...raw };
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function safeCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = error.code;
  return typeof code === "string" && /^[a-z0-9/_-]+$/i.test(code) ? code : "";
}

function lookupFailure(error) {
  const code = safeCode(error);
  if (code === "auth/user-not-found") {
    return "Ese usuario no existe en Firebase Authentication. No se creó ninguna cuenta ni se modificó ningún claim.";
  }
  if (code === "auth/invalid-email" || code === "auth/invalid-uid" || code === "auth/argument-error") {
    return "El identificador no es un correo ni un UID válido. No se modificó ningún usuario.";
  }
  const suffix = code ? ` (${code})` : "";
  return `No se pudo consultar Firebase Authentication${suffix}. No se modificó ningún usuario.`;
}

const target = parseTarget(process.argv);
if (!target) usage();

assertServiceAccountProject();

let initializeApp;
let applicationDefault;
let getAuth;
try {
  ({ initializeApp, applicationDefault } = await import("firebase-admin/app"));
  ({ getAuth } = await import("firebase-admin/auth"));
} catch {
  exitWith("Falta el paquete firebase-admin. Instálalo en la raíz del repositorio con: npm install --no-save firebase-admin");
}

try {
  initializeApp({
    credential: applicationDefault(),
    projectId: EXPECTED_PROJECT_ID,
  });
} catch {
  exitWith("No se pudo iniciar Firebase Admin. No se modificó ningún usuario.");
}

const auth = getAuth();
let user;
try {
  user = target.kind === "email"
    ? await auth.getUserByEmail(target.value)
    : await auth.getUser(target.value);
} catch (error) {
  exitWith(lookupFailure(error));
}

const shownClaims = claimsOf(user);
const shownEmail = user.email ?? null;
const nextClaims = { ...shownClaims, admin: true };

console.log("Usuario encontrado en Firebase Authentication:");
console.log(`  correo: ${shownEmail ?? "(sin correo)"}`);
console.log(`  uid: ${user.uid}`);
console.log(`  claims actuales: ${JSON.stringify(shownClaims)}`);
console.log(`  claims resultantes: ${JSON.stringify(nextClaims)}`);
console.log("");
console.log("Solo se modifican los custom claims de este usuario. No se crean cuentas ni se toca a nadie más.");
if (shownClaims.admin === true) {
  console.log("Este usuario ya tiene admin: true. Si confirmas, se conservan sus claims y se mantiene ese permiso.");
}

if (!input.isTTY || !output.isTTY) {
  exitWith("Hace falta una terminal interactiva para confirmar. No se modificó ningún claim.");
}

console.log("");
console.log("Para escribir el cambio, escribe el UID exacto y pulsa Enter.");
console.log("Para cancelar, pulsa Enter sin escribir nada.");

const rl = createInterface({ input, output });
let answer = "";
try {
  answer = (await rl.question("> ")).trim();
} finally {
  rl.close();
}

if (answer !== user.uid) {
  exitWith("Confirmación cancelada. No se modificó ningún claim.");
}

let fresh;
try {
  fresh = await auth.getUser(user.uid);
} catch (error) {
  exitWith(lookupFailure(error));
}

const freshClaims = claimsOf(fresh);
if (fresh.uid !== user.uid || (fresh.email ?? null) !== shownEmail || stable(freshClaims) !== stable(shownClaims)) {
  exitWith("El usuario cambió mientras confirmabas. No se escribió nada. Vuelve a ejecutar el script.");
}

try {
  await auth.setCustomUserClaims(fresh.uid, { ...freshClaims, admin: true });
} catch (error) {
  const suffix = safeCode(error) ? ` (${safeCode(error)})` : "";
  exitWith(`Firebase rechazó la actualización de claims${suffix}. No se imprimen detalles de la credencial.`);
}

console.log(`admin: true asignado a ${fresh.email ?? fresh.uid} (${fresh.uid}).`);
console.log("Cierra sesión y vuelve a iniciar sesión para obtener un token nuevo.");
