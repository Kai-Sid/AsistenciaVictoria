// Crea accounts/{uid} para un usuario que ya existe en Firebase Authentication.
// No crea usuarios, no cambia claims y no toca otras colecciones.
//
// Credenciales: GOOGLE_APPLICATION_CREDENTIALS debe apuntar a la clave JSON
// de una cuenta de servicio del proyecto asistenciavictoria-5a865.
// Este script no lee FIREBASE_SERVICE_ACCOUNT_JSON.
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
      "Uso: node scripts/bootstrap-admin-account.mjs --email <correo> --name \"Nombre Apellido\"",
      "     node scripts/bootstrap-admin-account.mjs --uid <uid> --name \"Nombre Apellido\"",
      "Muestra el usuario y solo crea accounts/{uid} si confirmas con su UID.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let email = "";
  let uid = "";
  let name = "";
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("-") || (flag !== "--email" && flag !== "--uid" && flag !== "--name")) return null;
    if (flag === "--email") email = value.trim().toLowerCase();
    if (flag === "--uid") uid = value.trim();
    if (flag === "--name") name = value.trim().replace(/\s+/g, " ");
    index += 1;
  }
  if (!name || name.length < 2 || name.length > 100 || (Boolean(email) === Boolean(uid))) return null;
  return { kind: email ? "email" : "uid", value: email || uid, name };
}

function assertServiceAccountProject() {
  const credentialsPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (!credentialsPath) {
    exitWith(`Define GOOGLE_APPLICATION_CREDENTIALS con la ruta local de la clave JSON de la cuenta de servicio de ${EXPECTED_PROJECT_ID}. No se modificó ningún documento.`);
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
    exitWith("No se pudo leer la cuenta de servicio. Comprueba GOOGLE_APPLICATION_CREDENTIALS. No se modificó ningún documento.");
  }
  if (!serviceAccount) exitWith("El archivo no es una clave de cuenta de servicio. No se modificó ningún documento.");
  if (projectId !== EXPECTED_PROJECT_ID) {
    exitWith(`La cuenta de servicio no es del proyecto ${EXPECTED_PROJECT_ID}. No se modificó ningún documento.`);
  }
}

function safeCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = error.code;
  if (code === 6 || code === "already-exists" || code === "auth/user-not-found") return String(code);
  return typeof code === "string" && /^[a-z0-9/_-]+$/i.test(code) ? code : "";
}

const target = parseArgs(process.argv);
if (!target) usage();
assertServiceAccountProject();

let initializeApp;
let applicationDefault;
let getAuth;
let getFirestore;
let FieldValue;
try {
  ({ initializeApp, applicationDefault } = await import("firebase-admin/app"));
  ({ getAuth } = await import("firebase-admin/auth"));
  ({ getFirestore, FieldValue } = await import("firebase-admin/firestore"));
} catch {
  exitWith("Falta el paquete firebase-admin. Instálalo en la raíz del repositorio con: npm install --no-save firebase-admin");
}

try {
  initializeApp({ credential: applicationDefault(), projectId: EXPECTED_PROJECT_ID });
} catch {
  exitWith("No se pudo iniciar Firebase Admin. No se modificó ningún documento.");
}

const auth = getAuth();
let user;
try {
  user = target.kind === "email" ? await auth.getUserByEmail(target.value) : await auth.getUser(target.value);
} catch (error) {
  const code = safeCode(error);
  if (code === "auth/user-not-found") exitWith("Ese usuario no existe en Firebase Authentication. No se creó ninguna cuenta.");
  exitWith("No se pudo consultar Firebase Authentication. No se modificó ningún documento.");
}

if (!user.email) exitWith("Ese usuario no tiene correo en Firebase Authentication. No se modificó ningún documento.");

const firestore = getFirestore();
const ref = firestore.collection("accounts").doc(user.uid);
let existing;
try {
  existing = await ref.get();
} catch {
  exitWith("No se pudo leer accounts. No se modificó ningún documento.");
}
if (existing.exists) {
  console.log(`La cuenta ${user.email} (${user.uid}) ya existe. No se modificó ningún documento.`);
  process.exit(0);
}

console.log("Usuario encontrado en Firebase Authentication:");
console.log(`  correo: ${user.email}`);
console.log(`  uid: ${user.uid}`);
console.log(`  nombre: ${target.name}`);
console.log("");
console.log("Se creará solo accounts/" + user.uid + " con role admin y active true.");
console.log("No se crean usuarios, no se cambian claims y no se tocan otras colecciones.");

if (!input.isTTY || !output.isTTY) {
  exitWith("Hace falta una terminal interactiva para confirmar. No se modificó ningún documento.");
}

console.log("");
console.log("Para crear el documento, escribe el UID exacto y pulsa Enter.");
console.log("Para cancelar, pulsa Enter sin escribir nada.");
const rl = createInterface({ input, output });
let answer = "";
try {
  answer = (await rl.question("> ")).trim();
} finally {
  rl.close();
}
if (answer !== user.uid) exitWith("Confirmación cancelada. No se modificó ningún documento.");

let fresh;
try {
  fresh = await auth.getUser(user.uid);
} catch {
  exitWith("El usuario ya no está disponible. No se modificó ningún documento.");
}
if (fresh.uid !== user.uid || fresh.email !== user.email) {
  exitWith("El usuario cambió mientras confirmabas. No se escribió nada. Vuelve a ejecutar el script.");
}

try {
  await ref.create({
    name: target.name,
    email: fresh.email,
    role: "admin",
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
} catch (error) {
  if (safeCode(error) === "6" || safeCode(error) === "already-exists") {
    console.log("La cuenta ya existe. No se modificó ningún documento.");
    process.exit(0);
  }
  exitWith("No se pudo crear el documento de la cuenta. No se imprimen detalles de la credencial.");
}

console.log(`Cuenta administrativa creada para ${fresh.email} (${fresh.uid}).`);
console.log("El claim admin existente no se modificó. Cierra sesión y vuelve a entrar.");
