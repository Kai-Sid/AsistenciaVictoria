import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw, Search } from "lucide-react";
import { apiUrl, auth } from "./firebase";

type Account = {
  uid: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type Notice = { type: "success" | "error"; text: string };
type FieldErrors = { name?: string; email?: string; password?: string; passwordConfirm?: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatCreated(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
}

function readAccount(value: unknown): Account | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const uid = typeof record.uid === "string" ? record.uid : "";
  const name = typeof record.name === "string" ? record.name : "";
  const email = typeof record.email === "string" ? record.email : "";
  if (!uid || !name || !email) return null;
  return {
    uid,
    name,
    email,
    role: typeof record.role === "string" ? record.role : "",
    active: record.active === true,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : null,
  };
}

async function readBody(response: Response): Promise<{ message?: string; accounts?: unknown; uid?: unknown } | null> {
  try {
    return await response.json() as { message?: string; accounts?: unknown; uid?: unknown };
  } catch {
    return null;
  }
}

function networkMessage(error: unknown, fallback: string) {
  return error instanceof TypeError
    ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo."
    : error instanceof Error && error.message === "auth"
      ? "Se requiere permiso de administrador."
      : fallback;
}

type Props = {
  onSelfDeactivated: () => void;
};

export default function AccountsPanel({ onSelfDeactivated }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selfUid, setSelfUid] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Account | null>(null);
  const [dialogError, setDialogError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void loadAccounts();
  }, []);

  useEffect(() => {
    if (!deactivateTarget) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingId) setDeactivateTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deactivateTarget, pendingId]);

  async function authorized(path: string, init?: RequestInit) {
    const user = auth.currentUser;
    if (!user) throw new Error("auth");
    const token = await user.getIdToken();
    return fetch(apiUrl(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  }

  async function loadAccounts(keepNotice = false) {
    setLoading(true);
    if (!keepNotice) setNotice(null);
    try {
      const [sessionResponse, listResponse] = await Promise.all([
        authorized("/api/admin/session"),
        authorized("/api/admin/accounts"),
      ]);
      const session = await readBody(sessionResponse);
      const data = await readBody(listResponse);
      if (!sessionResponse.ok || !listResponse.ok) {
        setNotice({ type: "error", text: data?.message || session?.message || "No se pudieron leer las cuentas administrativas." });
        return;
      }
      if (typeof session?.uid === "string") setSelfUid(session.uid);
      if (!Array.isArray(data?.accounts)) {
        setNotice({ type: "error", text: "No se pudieron leer las cuentas administrativas." });
        return;
      }
      setAccounts(data.accounts.map(readAccount).filter((account): account is Account => account !== null));
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "error", text: networkMessage(error, "No se pudieron leer las cuentas administrativas.") });
    } finally {
      setLoading(false);
      setReady(true);
    }
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const cleanName = name.trim().replace(/\s+/g, " ");
    if (cleanName.length < 2 || cleanName.length > 100) errors.name = "El nombre debe tener entre 2 y 100 caracteres.";
    if (!EMAIL_PATTERN.test(email.trim().toLowerCase())) errors.email = "El correo no es válido.";
    if (password.length < 8 || password.length > 128) errors.password = "La contraseña debe tener entre 8 y 128 caracteres.";
    if (password !== passwordConfirm) errors.passwordConfirm = "Las contraseñas no coinciden.";
    return errors;
  }

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setNotice(null);
    const cleanName = name.trim().replace(/\s+/g, " ");
    const cleanEmail = email.trim().toLowerCase();
    try {
      const response = await authorized("/api/admin/accounts", {
        method: "POST",
        body: JSON.stringify({ name: cleanName, email: cleanEmail, password }),
      });
      const data = await readBody(response);
      if (!response.ok) {
        setNotice({ type: "error", text: data?.message || "No se pudo crear la cuenta administrativa." });
        return;
      }
      const created = readAccount(data);
      if (created) setAccounts((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name, "es")));
      else void loadAccounts(true);
      setName("");
      setEmail("");
      setPassword("");
      setPasswordConfirm("");
      setFieldErrors({});
      setNotice({ type: "success", text: `Cuenta administrativa creada para ${cleanName}.` });
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "error", text: networkMessage(error, "No se pudo crear la cuenta administrativa.") });
    } finally {
      setSaving(false);
    }
  }

  async function setActive(account: Account, active: boolean) {
    setPendingId(account.uid);
    setDialogError("");
    setNotice(null);
    try {
      const response = await authorized("/api/admin/accounts/active", {
        method: "POST",
        body: JSON.stringify({ uid: account.uid, active }),
      });
      const data = await readBody(response);
      if (!response.ok) {
        const text = data?.message || "No se pudo actualizar el estado de la cuenta.";
        if (!active) setDialogError(text);
        else setNotice({ type: "error", text });
        return;
      }
      setAccounts((current) => current.map((item) => item.uid === account.uid ? { ...item, active } : item));
      setDeactivateTarget(null);
      if (!active && account.uid === selfUid) {
        onSelfDeactivated();
        return;
      }
      setNotice({
        type: "success",
        text: active ? `${account.name} volvió a estar activa.` : `${account.name} quedó inactiva.`,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      const text = networkMessage(error, "No se pudo actualizar el estado de la cuenta.");
      if (!active) setDialogError(text);
      else setNotice({ type: "error", text });
    } finally {
      setPendingId(null);
    }
  }

  const visible = accounts.filter((account) => `${account.name} ${account.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const busy = loading || saving || pendingId !== null;

  return (
    <div className="admin-stack">
      {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
      <div className="staff-layout">
        <section className="panel-card" aria-labelledby="accounts-form-title">
          <header className="card-head">
            <div>
              <h2 id="accounts-form-title">Nueva cuenta administrativa</h2>
              <p>La contraseña se guarda solo en Firebase Authentication. El rol siempre es administrador.</p>
            </div>
          </header>
          <form className="staff-form" onSubmit={(event) => void createAccount(event)} noValidate>
            <label className="field">
              <span>Nombre</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoComplete="name" disabled={saving} aria-invalid={Boolean(fieldErrors.name)} />
              {fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}
            </label>
            <label className="field">
              <span>Correo</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={200} autoComplete="off" disabled={saving} aria-invalid={Boolean(fieldErrors.email)} />
              {fieldErrors.email && <small className="field-error">{fieldErrors.email}</small>}
            </label>
            <label className="field">
              <span>Contraseña</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} autoComplete="new-password" disabled={saving} aria-invalid={Boolean(fieldErrors.password)} />
              {fieldErrors.password && <small className="field-error">{fieldErrors.password}</small>}
            </label>
            <label className="field">
              <span>Confirmar contraseña</span>
              <input type="password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} maxLength={128} autoComplete="new-password" disabled={saving} aria-invalid={Boolean(fieldErrors.passwordConfirm)} />
              {fieldErrors.passwordConfirm && <small className="field-error">{fieldErrors.passwordConfirm}</small>}
            </label>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving && <span className="spinner spinner-light" aria-hidden="true" />}
              {saving ? "Creando…" : "Crear cuenta"}
            </button>
          </form>
        </section>

        <section className="admin-stack" aria-labelledby="accounts-list-title">
          <h2 className="sr-only" id="accounts-list-title">Listado de cuentas administrativas</h2>
          <div className="filters">
            <label className="field grow">
              <span>Buscar</span>
              <div className="searchbox">
                <Search size={17} aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre o correo" />
              </div>
            </label>
            <p className="record-count" aria-live="polite">{visible.length.toLocaleString("es-PE")} cuentas</p>
            <button className="btn btn-secondary" type="button" onClick={() => void loadAccounts()} disabled={busy}>
              {loading ? <span className="spinner spinner-light" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}
              {loading ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
          <section className="panel-card table-card">
            {!ready || (loading && accounts.length === 0) ? (
              <div className="loading-card" role="status">
                <span className="spinner spinner-light" aria-hidden="true" />
                <p>Consultando cuentas…</p>
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <p>{accounts.length === 0 ? "Todavía no hay cuentas administrativas en Firestore." : "No hay cuentas que coincidan."}</p>
                <p className="empty-detail">{accounts.length === 0 ? "Crea la primera con el formulario, o conserva el acceso actual por el claim hasta registrarla." : "Prueba con otro nombre o correo."}</p>
              </div>
            ) : (
              <div className="table-container" tabIndex={0} role="region" aria-label="Listado de cuentas administrativas">
                <table>
                  <caption className="sr-only">Cuentas administrativas</caption>
                  <thead>
                    <tr>
                      <th scope="col">Nombre</th>
                      <th scope="col">Correo</th>
                      <th scope="col">Rol</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Registro</th>
                      <th scope="col">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((account) => (
                      <tr key={account.uid}>
                        <td>{account.name}</td>
                        <td>{account.email}</td>
                        <td>{account.role === "admin" ? "Administrador" : "No válido"}</td>
                        <td>
                          <span className={account.active ? "status active" : "status inactive"}>
                            <span className="status-dot" aria-hidden="true" />
                            {account.active ? "Activo" : "Inactivo"}
                          </span>
                        </td>
                        <td>{formatCreated(account.createdAt)}</td>
                        <td>
                          {account.role !== "admin" ? "—" : account.active ? (
                            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setDialogError(""); setDeactivateTarget(account); }}>
                              Desactivar
                            </button>
                          ) : (
                            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void setActive(account, true)}>
                              {pendingId === account.uid && <span className="spinner spinner-light" aria-hidden="true" />}
                              Activar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </section>
      </div>

      {deactivateTarget && (
        <div className="modal-backdrop">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="deactivate-account-title">
            <h2 id="deactivate-account-title">Desactivar cuenta administrativa</h2>
            <p>{deactivateTarget.name} ({deactivateTarget.email}) no podrá entrar al panel mientras esté inactiva. La cuenta de Authentication se conserva.</p>
            {dialogError && <p className="field-error" role="alert">{dialogError}</p>}
            <div className="modal-actions">
              <button ref={cancelRef} className="btn btn-secondary" type="button" disabled={pendingId === deactivateTarget.uid} onClick={() => setDeactivateTarget(null)}>Cancelar</button>
              <button className="btn btn-danger" type="button" disabled={pendingId === deactivateTarget.uid} onClick={() => void setActive(deactivateTarget, false)}>
                {pendingId === deactivateTarget.uid && <span className="spinner spinner-light" aria-hidden="true" />}
                {pendingId === deactivateTarget.uid ? "Desactivando…" : "Desactivar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
