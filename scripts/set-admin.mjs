// Ejecutar una sola vez desde un entorno confiable con credenciales de Firebase Admin.
// Requiere GOOGLE_APPLICATION_CREDENTIALS apuntando a una clave de cuenta de servicio
// descargada de Firebase Console > Project settings > Service accounts.
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = process.argv[2];
if (!email) {
  console.error("Uso: node scripts/set-admin.mjs correo@empresa.com");
  process.exit(1);
}
initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const user = await auth.getUserByEmail(email);
await auth.setCustomUserClaims(user.uid, { admin: true });
console.log(`Rol admin asignado a ${email}. Cierra sesión y vuelve a iniciar sesión.`);
