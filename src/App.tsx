import { useEffect, useRef, useState, type FormEvent } from "react";
import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { apiUrl, auth } from "./firebase";
import { UserRound } from "lucide-react";
import AdminDashboard from "./AdminDashboard";

type EmployeeOption = { id: string; name: string; employeeCode: string; active?: boolean };
type Result = {
  ok: boolean;
  message: string;
  employeeName?: string;
  action?: string;
  timestamp?: string;
  employees?: EmployeeOption[];
};
type Row = { id: string; employeeName: string; employeeCode: string; checkInAt?: string | null; checkOutAt?: string | null; status: string; workedMinutes?: number | null };
type NoticeArea = "kiosk" | "login" | "admin";
type AttendanceAction = "entrada" | "salida";

async function loadAdminAccess(user: User): Promise<"ok" | "denied" | "unavailable"> {
  try {
    const token = await user.getIdToken();
    const response = await fetch(apiUrl("/api/admin/session"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return "ok";
    if (response.status === 401 || response.status === 403) return "denied";
    return "unavailable";
  } catch (error) {
    console.error(error instanceof Error ? error.name : "auth");
    return "unavailable";
  }
}

async function readJson(response: Response): Promise<Result | null> {
  try {
    return await response.json() as Result;
  } catch {
    return null;
  }
}

export default function App() {
  const [admin, setAdmin] = useState<User|null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [adminMode, setAdminMode] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [candidates, setCandidates] = useState<EmployeeOption[]>([]);
  const [pendingAction, setPendingAction] = useState<AttendanceAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<AttendanceAction | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success"|"error"|"info">("info");
  const [messageArea, setMessageArea] = useState<NoticeArea>("kiosk");
  const [result, setResult] = useState<Result|null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [recordsReady, setRecordsReady] = useState(false);
  const busyRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => onAuthStateChanged(auth, (u) => {
    void (async () => {
      try {
        if (!u) {
          setAdmin(null);
          setAdminMode(false);
          return;
        }
        const access = await loadAdminAccess(u);
        if (access === "ok") {
          setAdmin(u);
          setAdminMode(true);
          return;
        }
        setAdminMode(false);
        if (access === "denied") {
          setAdmin(null);
          await signOut(auth);
          return;
        }
        setAdmin(u);
      } finally {
        setCheckingAuth(false);
      }
    })();
  }), []);

  function showNotice(area: NoticeArea, type: "success"|"error"|"info", text: string) {
    setMessageArea(area);
    setMessageType(type);
    setMessage(text);
  }

  async function mark(action: AttendanceAction, selectedId?: string) {
    if (busyRef.current) return;
    const name = employeeName.trim().replace(/\s+/g, " ");
    if (name.length < 2) {
      setResult(null);
      setCandidates([]);
      setPendingAction(null);
      showNotice("kiosk", "error", "Ingresa tu nombre completo.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setBusyAction(action);
    setPendingAction(action);
    setMessage("");
    setResult(null);
    if (!selectedId) setCandidates([]);
    try {
      const response = await fetch(apiUrl("/api/attendance"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedId ? { name, employeeId: selectedId, action } : { name, action }),
      });
      const data = await readJson(response);
      if (!response.ok || !data) {
        setResult(null);
        showNotice("kiosk", "error", data?.message || "El servidor no pudo completar el registro. Inténtalo de nuevo.");
        return;
      }
      if (data.ok === false && data.employees && data.employees.length > 1) {
        setCandidates(data.employees);
        showNotice("kiosk", "info", data.message || "Hay varios trabajadores con ese nombre. Selecciona el correcto.");
        return;
      }
      setCandidates([]);
      setResult(data);
      showNotice("kiosk", data.ok ? "success" : "error", data.message);
      if (data.ok) {
        setEmployeeName("");
        setPendingAction(null);
        nameInput.current?.focus();
      }
    } catch (e) {
      console.error(e instanceof Error ? e.name : "error");
      setResult(null);
      showNotice("kiosk", "error", e instanceof TypeError
        ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo."
        : "No se pudo registrar la marcación. Inténtalo de nuevo.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const access = await loadAdminAccess(cred.user);
      if (access === "denied") {
        await signOut(auth);
        showNotice("login", "error", "Esta cuenta no tiene permisos de administrador.");
      } else if (access === "unavailable") {
        showNotice("login", "error", "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.");
      } else {
        setPassword("");
        setAdminMode(true);
        setLoginOpen(false);
        showNotice("admin", "success", "Sesión administrativa iniciada.");
      }
    } catch (e) {
      console.error(e instanceof FirebaseError ? e.code : "auth");
      showNotice("login", "error", e instanceof FirebaseError && (e.code === "auth/network-request-failed" || e.code === "auth/timeout")
        ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo."
        : "No se pudo iniciar sesión. Revisa tus credenciales.");
    } finally { setBusy(false); }
  }

  async function loadRows() {
    const user = auth.currentUser;
    if (!user) {
      showNotice("admin", "error", "Se requiere permiso de administrador.");
      setRecordsReady(true);
      return;
    }
    setBusy(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch(apiUrl("/api/admin/attendances"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json() as { attendances?: Row[]; message?: string };
      if (!response.ok) {
        showNotice("admin", "error", data.message || "No se pudieron leer los registros. Verifica que tu cuenta tenga el rol de administrador.");
        return;
      }
      setRows(data.attendances ?? []);
    } catch (e) {
      console.error(e instanceof Error ? e.name : "error");
      showNotice("admin", "error", e instanceof TypeError
        ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo."
        : "No se pudieron leer los registros. Verifica que tu cuenta tenga el rol de administrador.");
    } finally {
      setBusy(false);
      setRecordsReady(true);
    }
  }

  useEffect(() => {
    if (!adminMode) return;
    void loadRows();
  }, [adminMode]);

  async function logout() {
    await signOut(auth);
    setRows([]);
    setRecordsReady(false);
    setAdminMode(false);
    setAdmin(null);
    setLoginOpen(false);
    setMessage("");
  }

  function onNameChange(value: string) {
    setEmployeeName(value);
    setCandidates([]);
    setPendingAction(null);
    setResult(null);
    if (messageArea === "kiosk") setMessage("");
  }

  const kioskNoticeClass = messageType === "error" && message.includes("No encontramos un trabajador")
    ? "notice warning"
    : `notice ${messageType}`;

  if (checkingAuth) return <main className="loading">
    <img className="brand-logo" src="/logo-victoria.png" alt="Logotipo oficial de Victoria Catering y Eventos" />
    <p>Cargando AsistenciaVictoria…</p>
  </main>;

  if (adminMode) return (
    <AdminDashboard
      email={admin?.email}
      rows={rows}
      busy={busy}
      recordsReady={recordsReady}
      notice={message && messageArea === "admin" ? { type: messageType, text: message } : null}
      onRefresh={() => void loadRows()}
      onLogout={() => void logout()}
    />
  );

  return <main className="shell">
    <header className="site-header">
      <button className="login-button" type="button" aria-expanded={loginOpen} onClick={() => { setMessage(""); setLoginOpen(open => !open); }}><UserRound size={17}/> Iniciar sesión</button>
    </header>

    <div className="brand">
      <img className="brand-logo" src="/logo-victoria.png" alt="Logotipo oficial de Victoria Catering y Eventos" />
    </div>

    {!loginOpen && <section className="kiosk-card">
      <header className="kiosk-intro">
        <p className="eyebrow">CONTROL DE PERSONAL</p>
        <h1>Control de Asistencia</h1>
        <p className="subtitle">Escribe tu nombre completo y elige si registras tu entrada o tu salida.</p>
      </header>
      <form onSubmit={(e) => e.preventDefault()}>
        <div className="fields">
          <label>
            <span>Ingresa tu nombre completo</span>
            <input ref={nameInput} autoFocus autoComplete="name" value={employeeName} onChange={e => onNameChange(e.target.value)} placeholder="Ingresa tu nombre completo" maxLength={100} disabled={busy}/>
          </label>
        </div>
        <div className="actions">
          <button className="entry" type="button" disabled={busy} aria-busy={busy && busyAction === "entrada"} onClick={() => void mark("entrada")}>
            {busy && busyAction === "entrada" && <span className="spinner" aria-hidden="true" />}
            {busy && busyAction === "entrada" ? "Registrando entrada…" : "Registrar entrada"}
          </button>
          <button className="exit" type="button" disabled={busy} aria-busy={busy && busyAction === "salida"} onClick={() => void mark("salida")}>
            {busy && busyAction === "salida" && <span className="spinner spinner-light" aria-hidden="true" />}
            {busy && busyAction === "salida" ? "Registrando salida…" : "Registrar salida"}
          </button>
        </div>
      </form>
      {candidates.length > 1 && pendingAction && <div className="candidates" role="list">
        <p>{pendingAction === "salida" ? "Selecciona tu nombre para registrar la salida." : "Selecciona tu nombre para registrar la entrada."}</p>
        {candidates.map(person => <button key={person.id} type="button" disabled={busy} onClick={() => void mark(pendingAction, person.id)}>
          <strong>{person.name}</strong>
          <span>{person.employeeCode}</span>
        </button>)}
      </div>}
      {message && messageArea === "kiosk" && <div className={kioskNoticeClass} role="status">{message}</div>}
      {result?.ok && result.timestamp && <p className="receipt">{result.employeeName} · {result.action === "salida" ? "Salida" : "Entrada"} · {new Date(result.timestamp).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "medium" })}</p>}
    </section>}

    {loginOpen && <section className="login-panel" aria-labelledby="login-title">
      <h2 id="login-title">Sesión de administrador</h2>
      <p>Consulta los registros de todo el personal.</p>
      <form onSubmit={login} className="login-form">
        <label>
          <span>Correo</span>
          <input type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="Correo administrador" autoComplete="username"/>
        </label>
        <label>
          <span>Contraseña</span>
          <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Contraseña" autoComplete="current-password"/>
        </label>
        <button type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
      {message && messageArea === "login" && <p className={`notice ${messageType}`}>{message}</p>}
    </section>}
    <footer>AsistenciaVictoria · Victoria Catering & Eventos</footer>
  </main>;
}
