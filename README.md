# AsistenciaVictoria

Control de asistencia de Victoria Catering & Eventos. El trabajador escribe su nombre completo para registrar la entrada o la salida. El administrador inicia sesión con Firebase Authentication y consulta los últimos 500 registros.

- Frontend: React, TypeScript y Vite, en el puerto local **5174**.
- Backend: Node.js y Express, en `server/`. Escucha `process.env.PORT` en `0.0.0.0`.
- Base de datos: Cloud Firestore (`employees` y `attendances`).
- El navegador no escribe asistencias. Lo hace el backend con Firebase Admin SDK.
- Las Cloud Functions de `functions/` siguen en el repositorio. Publicar asistencias en Render no exige desplegarlas.

## Desarrollo local

1. Copia `.env.example` a `.env` y completa las variables `VITE_` de la app web de Firebase.
2. Deja `VITE_API_BASE_URL=http://localhost:8080`.
3. Instala y arranca el frontend:

```bash
npm install
npm run dev
```

4. En otra terminal, configura el backend sin guardar la clave en el repositorio. Una de estas dos formas:

```powershell
$env:PORT = "8080"
$env:ALLOWED_ORIGINS = "http://localhost:5174"
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\ruta\segura\service-account.json"
$env:FIREBASE_PROJECT_ID = "tu-project-id"
```

O, en Render, la variable `FIREBASE_SERVICE_ACCOUNT_JSON` con el JSON completo de la cuenta de servicio.

5. Instala, prueba y arranca el backend:

```bash
cd server
npm install
npm test
npm start
```

Sin credenciales, `GET /api/health` responde `{ "ok": true, "firestore": false, "reason": "not-configured" }`. Si el proyecto de la cuenta de servicio no coincide con `FIREBASE_PROJECT_ID`, `reason` es `project-mismatch`. `firestore: true` solo indica que el Admin SDK arrancó con ese proyecto; no demuestra por sí solo una consulta real a Firestore. La marcación, si el servidor no está configurado, responde que no puede acceder a Firestore y no confirma la asistencia.

La pantalla queda en http://localhost:5174/. El API local queda en http://localhost:8080/.

## Contrato de marcación

`POST /api/attendance`

```json
{ "name": "Nombre Apellido", "employeeId": "opcional" }
```

- Un empleado activo con ese nombre, sin jornada abierta: crea la entrada.
- Con una jornada `status: "open"`: cierra la salida y calcula `workedMinutes` con la hora del servidor.
- Varios empleados activos con el mismo nombre y sin `employeeId`: responde `ok: false` y `employees` con `id`, `name`, `employeeCode` y `active`.
- La comparación ignora mayúsculas y tildes.

La comparación de la jornada abierta y la escritura ocurren dentro de una transacción de Firestore. Dos solicitudes simultáneas no pueden dejar dos jornadas abiertas del mismo trabajador. Si la segunda llega cuando la primera ya abrió la jornada, registra la salida.

## Administración

El administrador entra con correo y contraseña de Firebase Authentication. La contraseña no se guarda en Firestore. El navegador envía el ID token y el backend lo verifica con Firebase Admin SDK. El panel solo se abre si `GET /api/admin/session` autoriza la sesión.

La autorización administrativa es esta:

- Si existe `accounts/{uid}`, entra solo con `role: "admin"` y `active: true`. Un claim antiguo no reactiva una cuenta desactivada.
- Si ese documento todavía no existe, sigue valiendo el custom claim `admin: true`.

El único rol es `admin`. El servidor lo escribe; no acepta un rol enviado por el navegador.

Endpoints de personal y registros, todos con `Authorization: Bearer <ID token>`:

- `GET /api/admin/attendances`
- `GET /api/admin/employees`
- `POST /api/admin/employees` con `name` y `employeeCode`
- `POST /api/admin/employees/active` con `employeeId` y `active`

Endpoints de cuentas, con la misma autorización:

- `GET /api/admin/session`
- `GET /api/admin/accounts`
- `POST /api/admin/accounts` con `name`, `email` y `password`
- `POST /api/admin/accounts/active` con `uid` y `active`

`POST /api/admin/accounts` crea el usuario en Firebase Authentication y después el documento `accounts/{uid}` con `name`, `email`, `role: "admin"`, `active: true`, `createdAt` y `updatedAt`. También conserva el claim `admin: true` para la transición. Si el documento no llega a guardarse, se elimina solo el usuario creado en esa petición. No se puede desactivar al último administrador activo.

El alta de un trabajador guarda nombre, código, estado y fecha. No escribe `pin` ni `pinHash`. Los documentos de personal que ya tenían `pinHash` no se reescriben. Ninguna respuesta incluye `pin`, `pinHash` ni la contraseña de una cuenta. El panel administrativo usa estos endpoints para listar, registrar y activar o desactivar personal. `GET /api/admin/employees` incluye `createdAt` en ISO cuando el documento ya tiene esa fecha; si no existe, el valor es `null`.

### Primera cuenta de administrador

1. Crea el usuario en Firebase Console > Authentication > Add user.
2. Descarga la clave de cuenta de servicio fuera del repositorio.
3. Define `GOOGLE_APPLICATION_CREDENTIALS` con esa ruta.
4. Asigna el claim, sin quitar otros claims:

```bash
npm install --no-save firebase-admin
node scripts/set-admin.mjs admin@tuempresa.com
```

5. Crea el documento `accounts/{uid}` de ese mismo usuario, sin crear otra cuenta y sin modificar `employees` ni `attendances`:

```bash
node scripts/bootstrap-admin-account.mjs --email admin@tuempresa.com --name "Nombre Apellido"
```

6. Cierra sesión y vuelve a entrar. A partir de ese documento, el acceso depende de `accounts`, no solo del claim.

Estas dos órdenes escriben en Firebase. No forman parte del arranque automático del servidor.

## Reglas de Firestore

El frontend actual solo usa Firebase Authentication. No lee ni escribe `employees`, `attendances` ni `accounts`.

Antes, `firestore.rules` permitía a un administrador autenticado leer y escribir `attendances` desde el navegador. El archivo ya deja ambas colecciones cerradas al cliente. **Ese cambio no está publicado.** Para aplicarlo, cuando el backend de Render ya esté funcionando:

```bash
firebase deploy --only firestore:rules
```

No despliegues las reglas antes de tener el API: el panel antiguo leía Firestore directamente y dejaría de poder cargar la tabla.

La consulta de jornadas abiertas usa `employeeId` y `status`. Si Firestore pide un índice compuesto, créalo en la consola con esos dos campos. La consulta de los últimos 500 registros ordena `createdAt` descendente.

## Despliegue en Render

No hace falta desplegar Cloud Functions. Hay dos servicios, descritos en `render.yaml`. Las variables van en el panel de Render; el archivo no contiene secretos.

### 1. Web Service para el API

- Root directory: `server`
- Build: `npm install && npm run build`
- Start: `npm start`
- Health check: `/api/health`

Variables:

| Variable | Uso |
| --- | --- |
| `ALLOWED_ORIGINS` | Orígenes extra, separados por coma. El sitio publicado `https://asistenciavictoria-web.onrender.com` y `http://localhost:5174` quedan autorizados aunque esta variable solo tenga el origen local. |
| `FIREBASE_PROJECT_ID` | ID del proyecto Firebase. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON completo de la cuenta de servicio, en una sola línea. |

`PORT` lo asigna Render. El proceso escucha en `0.0.0.0`.

### 2. Cuenta de servicio

1. En Google Cloud Console del mismo proyecto Firebase, abre IAM > Cuentas de servicio.
2. Usa la cuenta de Firebase Admin o crea una con acceso a Cloud Datastore User / Firebase Admin.
3. Crea una clave JSON y descárgala fuera del repositorio.
4. En Render, abre el servicio del API > Environment y pega el contenido del archivo en `FIREBASE_SERVICE_ACCOUNT_JSON`.
5. No subas ese archivo a Git. `.gitignore` ya excluye `service-account*.json` y `.env`.

Sin esa variable, o sin `GOOGLE_APPLICATION_CREDENTIALS` en local, Render no puede leer ni escribir Firestore.

### 3. Static Site para el frontend

- Build: `npm install && npm run build`
- Publish directory: `dist`
- Rewrite: `/*` → `/index.html`, para que el enrutado de la aplicación no devuelva 404.

Las variables `VITE_` se aplican **durante la compilación**, no al abrir el sitio. Si cambias `VITE_API_BASE_URL`, vuelve a compilar.

| Variable | Uso |
| --- | --- |
| `VITE_API_BASE_URL` | URL pública del API, sin barra final. Ejemplo: `https://asistenciavictoria.onrender.com` |
| `VITE_FIREBASE_API_KEY` | Configuración pública de la app web |
| `VITE_FIREBASE_AUTH_DOMAIN` | Igual |
| `VITE_FIREBASE_PROJECT_ID` | Igual |
| `VITE_FIREBASE_STORAGE_BUCKET` | Igual |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Igual |
| `VITE_FIREBASE_APP_ID` | Igual |

En Authentication > Settings > Authorized domains, añade el dominio del sitio de Render.

Orden recomendado: publicar el API y comprobar `/api/health`, publicar el frontend con `VITE_API_BASE_URL` apuntando a ese API, y al final publicar las reglas de Firestore.

## Límites

- El nombre no demuestra la identidad del trabajador. Cualquiera que lo conozca puede marcar en la pantalla compartida.
- El límite de solicitudes es por IP y vive en la memoria del proceso. Un plan de Render con varias instancias no comparte ese contador. El límite de marcación es 60 por minuto, pensado para que un tablet compartido pueda registrar un cambio de turno.
- Dos clics ya enviados al servidor se aplican en orden: el segundo, si encuentra la jornada abierta, registra la salida.
- El tiempo trabajado es la diferencia entre entrada y salida. No descuenta pausas.
- El servicio gratuito de Render puede dormirse; la primera solicitud después de eso tarda más.
- Esta base no está auditada como sistema de control horario.
