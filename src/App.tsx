import { useEffect, useRef, useState, type FormEvent } from "react";
import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { apiUrl, auth } from "./firebase";
import { UserRound, LogIn, LogOut, ShieldCheck, Search, Users, RefreshCw } from "lucide-react";

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
const formatDate = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" });
};

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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success"|"error"|"info">("info");
  const [messageArea, setMessageArea] = useState<NoticeArea>("kiosk");
  const [result, setResult] = useState<Result|null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const busyRef = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setAdmin(u);
    setCheckingAuth(false);
    if (u) {
      const token = await u.getIdTokenResult(true);
      setAdminMode(token.claims.admin === true);
    } else setAdminMode(false);
  }), []);

  function showNotice(area: NoticeArea, type: "success"|"error"|"info", text: string) {
    setMessageArea(area);
    setMessageType(type);
    setMessage(text);
  }

  async function mark(selectedId?: string) {
    if (busyRef.current) return;
    const name = employeeName.trim().replace(/\s+/g, " ");
    if (name.length < 2) {
      setResult(null);
      setCandidates([]);
      showNotice("kiosk", "error", "Ingresa tu nombre completo.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    setResult(null);
    if (!selectedId) setCandidates([]);
    try {
      const response = await fetch(apiUrl("/api/attendance"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedId ? { name, employeeId: selectedId } : { name }),
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
    }
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await cred.user.getIdTokenResult(true);
      if (token.claims.admin !== true) {
        await signOut(auth);
        showNotice("login", "error", "Esta cuenta no tiene permisos de administrador.");
      } else {
        setAdminMode(true);
        showNotice("admin", "success", "Sesión administrativa iniciada.");
        await loadRows();
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
    } finally { setBusy(false); }
  }

  async function logout() {
    await signOut(auth);
    setRows([]);
    setAdminMode(false);
    setAdmin(null);
    setMessage("");
  }

  function onNameChange(value: string) {
    setEmployeeName(value);
    setCandidates([]);
    setResult(null);
    if (messageArea === "kiosk") setMessage("");
  }

  const filtered = rows.filter(r => `${r.employeeName} ${r.employeeCode}`.toLowerCase().includes(filter.toLowerCase()));

  if (checkingAuth) return <main className="loading">Cargando AsistenciaVictoria…</main>;

  return <main className="shell">
    <header className="site-header">
      <div className="brand-mini"><div className="mini-mark">V</div><span>VICTORIA <small>CATERING & EVENTOS</small></span></div>
      {adminMode
        ? <button className="login-button" onClick={logout}><LogOut size={17}/> Cerrar sesión</button>
        : <button className="login-button" onClick={() => { setMessage(""); document.getElementById("admin-login")?.scrollIntoView({ behavior: "smooth" }); }}><UserRound size={17}/> Iniciar sesión</button>}
    </header>

    {!adminMode ? <section className="kiosk-card">
      <div className="logo-frame"><div className="logo-emblem"><span className="ornament">✺</span><strong>V</strong><span className="logo-word">VICTORIA</span><small>CATERING & EVENTOS</small></div></div>
      <p className="eyebrow">CONTROL DE PERSONAL</p>
      <h1>Control de Asistencia</h1>
      <p className="subtitle">Escribe tu nombre completo para registrar tu entrada o tu salida.</p>
      <form onSubmit={(e) => { e.preventDefault(); void mark(); }}>
        <div className="fields">
          <label>
            <span>Ingresa tu nombre completo</span>
            <input ref={nameInput} autoFocus autoComplete="name" value={employeeName} onChange={e => onNameChange(e.target.value)} placeholder="Ingresa tu nombre completo" maxLength={100} disabled={busy}/>
          </label>
        </div>
        <div className="actions">
          <button type="submit" disabled={busy}>Registrar entrada / salida</button>
        </div>
      </form>
      {candidates.length > 1 && <div className="candidates" role="list">
        {candidates.map(person => <button key={person.id} type="button" disabled={busy} onClick={() => void mark(person.id)}>
          <strong>{person.name}</strong>
          <span>{person.employeeCode}</span>
        </button>)}
      </div>}
      {busy && <div className="progress" aria-hidden="true"><span/></div>}
      {message && messageArea === "kiosk" && <div className={`notice ${messageType}`} role="status">{message}</div>}
      {result?.ok && result.timestamp && <p className="receipt">{result.employeeName} · {result.action === "salida" ? "Salida" : "Entrada"} · {new Date(result.timestamp).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "medium" })}</p>}
    </section> : <section className="admin-panel">
      <div className="admin-heading"><div><p className="eyebrow">ADMINISTRACIÓN</p><h1>Registros de asistencia</h1><p className="subtitle">{admin?.email} · Últimos 500 registros</p></div><button className="refresh" onClick={loadRows} disabled={busy}><RefreshCw size={17}/> Actualizar</button></div>
      {message && messageArea === "admin" && <div className={`notice ${messageType}`} role="status">{message}</div>}
      <div className="admin-tools"><div className="searchbox"><Search size={17}/><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar por nombre o código"/></div><div className="record-count"><Users size={17}/> {filtered.length} registros</div></div>
      <div className="table-container"><table><thead><tr><th>Trabajador</th><th>Código</th><th>Entrada</th><th>Salida</th><th>Tiempo</th><th>Estado</th></tr></thead><tbody>{filtered.map(r => <tr key={r.id}><td>{r.employeeName}</td><td>{r.employeeCode}</td><td>{formatDate(r.checkInAt)}</td><td>{formatDate(r.checkOutAt)}</td><td>{r.workedMinutes != null ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : "—"}</td><td><span className={`status ${r.status}`}>{r.status === "open" ? "En curso" : "Cerrada"}</span></td></tr>)}</tbody></table>{filtered.length === 0 && <p className="empty">No hay registros que coincidan.</p>}</div>
      <p className="admin-note"><ShieldCheck size={16}/> Solo las cuentas con rol administrativo pueden consultar esta tabla.</p>
    </section>}

    {!adminMode && <section id="admin-login" className="admin-login">
      <div className="admin-login-icon"><ShieldCheck size={22}/></div>
      <div className="admin-login-copy"><strong>Acceso administrativo</strong><span>Consulta los registros de todo el personal.</span></div>
      <form onSubmit={login} className="login-form">
        <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Correo administrador"/>
        <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Contraseña"/>
        <button disabled={busy}>Iniciar sesión <LogIn size={16}/></button>
      </form>
      {message && messageArea === "login" && <p className={`notice ${messageType}`}>{message}</p>}
    </section>}
    <footer>AsistenciaVictoria · Victoria Catering & Eventos</footer>
  </main>;
}
