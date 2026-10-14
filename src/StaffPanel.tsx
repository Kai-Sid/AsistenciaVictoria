import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw, Search } from "lucide-react";
import { apiUrl, auth } from "./firebase";

type Employee = {
  id: string;
  name: string;
  employeeCode: string;
  active: boolean;
  createdAt: string | null;
};

type Notice = { type: "success" | "error"; text: string };
type FieldErrors = { name?: string; employeeCode?: string };

const CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

function formatCreated(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });
}

function readEmployee(value: unknown): Employee | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  const employeeCode = typeof record.employeeCode === "string" ? record.employeeCode : "";
  if (!id || !name) return null;
  return {
    id,
    name,
    employeeCode,
    active: record.active === true,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : null,
  };
}

async function readBody(response: Response): Promise<{ message?: string; employees?: unknown } | null> {
  try {
    return await response.json() as { message?: string; employees?: unknown };
  } catch {
    return null;
  }
}

function networkMessage(error: unknown, fallback: string) {
  return error instanceof TypeError
    ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo."
    : fallback;
}

export default function StaffPanel() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [name, setName] = useState("");
  const [employeeCode, setEmployeeCode] = useState("");
  const [deactivateTarget, setDeactivateTarget] = useState<Employee | null>(null);
  const [dialogError, setDialogError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void loadEmployees();
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

  async function loadEmployees(keepNotice = false) {
    setLoading(true);
    if (!keepNotice) setNotice(null);
    try {
      const response = await authorized("/api/admin/employees");
      const data = await readBody(response);
      if (!response.ok) {
        setNotice({ type: "error", text: data?.message || "No se pudieron leer los trabajadores." });
        return;
      }
      if (!Array.isArray(data?.employees)) {
        setNotice({ type: "error", text: "La respuesta del servidor no tiene el formato esperado." });
        return;
      }
      setEmployees(data.employees.map(readEmployee).filter((employee): employee is Employee => employee !== null));
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "error", text: networkMessage(error, "No se pudieron leer los trabajadores.") });
    } finally {
      setLoading(false);
      setReady(true);
    }
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const cleanName = name.trim();
    const code = employeeCode.trim().toUpperCase();
    if (cleanName.length < 2 || cleanName.length > 100) {
      errors.name = "Escribe el nombre completo, entre 2 y 100 caracteres.";
    }
    if (!CODE_PATTERN.test(code)) {
      errors.employeeCode = "El código debe tener de 3 a 20 caracteres: letras, números o guiones.";
    }
    return errors;
  }

  async function createEmployee(event: FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const cleanName = name.trim();
    const code = employeeCode.trim().toUpperCase();
    if (employees.some((employee) => employee.employeeCode.toUpperCase() === code)) {
      setFieldErrors({ employeeCode: "Ese código de trabajador ya existe." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const response = await authorized("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ name: cleanName, employeeCode: code }),
      });
      const data = await readBody(response);
      if (!response.ok) {
        setNotice({ type: "error", text: data?.message || "No se pudo registrar al trabajador." });
        return;
      }
      setName("");
      setEmployeeCode("");
      setFieldErrors({});
      setNotice({ type: "success", text: "Trabajador registrado." });
      await loadEmployees(true);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "error", text: networkMessage(error, "No se pudo registrar al trabajador.") });
    } finally {
      setSaving(false);
    }
  }

  async function setActive(employee: Employee, active: boolean) {
    setPendingId(employee.id);
    setDialogError("");
    setNotice(null);
    try {
      const response = await authorized("/api/admin/employees/active", {
        method: "POST",
        body: JSON.stringify({ employeeId: employee.id, active }),
      });
      const data = await readBody(response);
      if (!response.ok) {
        const text = data?.message || "No se pudo actualizar el estado del trabajador.";
        if (!active) setDialogError(text);
        else setNotice({ type: "error", text });
        return;
      }
      setEmployees((current) => current.map((item) => item.id === employee.id ? { ...item, active } : item));
      setDeactivateTarget(null);
      setNotice({
        type: "success",
        text: active ? `${employee.name} volvió a estar activo.` : `${employee.name} quedó inactivo.`,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      const text = networkMessage(error, "No se pudo actualizar el estado del trabajador.");
      if (!active) setDialogError(text);
      else setNotice({ type: "error", text });
    } finally {
      setPendingId(null);
    }
  }

  const visible = employees.filter((employee) => `${employee.name} ${employee.employeeCode}`.toLowerCase().includes(query.toLowerCase()));
  const busy = loading || saving || pendingId !== null;

  return (
    <div className="admin-stack">
      {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
      <div className="staff-layout">
        <section className="panel-card" aria-labelledby="staff-form-title">
          <header className="card-head">
            <div>
              <h2 id="staff-form-title">Registrar trabajador</h2>
              <p>El código distingue a quienes comparten nombre.</p>
            </div>
          </header>
          <form className="staff-form staff-register" onSubmit={(event) => void createEmployee(event)} noValidate>
            <label className="field">
              <span>Nombre completo</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoComplete="name" disabled={saving} aria-invalid={Boolean(fieldErrors.name)} />
              {fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}
            </label>
            <label className="field">
              <span>Código</span>
              <input value={employeeCode} onChange={(event) => setEmployeeCode(event.target.value.toUpperCase())} maxLength={20} autoComplete="off" spellCheck={false} disabled={saving} aria-invalid={Boolean(fieldErrors.employeeCode)} placeholder="VIC-001" />
              {fieldErrors.employeeCode && <small className="field-error">{fieldErrors.employeeCode}</small>}
            </label>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving && <span className="spinner spinner-light" aria-hidden="true" />}
              {saving ? "Registrando…" : "Registrar trabajador"}
            </button>
          </form>
        </section>

        <section className="admin-stack" aria-labelledby="staff-list-title">
          <h2 className="sr-only" id="staff-list-title">Listado de trabajadores</h2>
          <div className="filters">
            <label className="field grow">
              <span>Buscar</span>
              <div className="searchbox">
                <Search size={17} aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre o código" />
              </div>
            </label>
            <p className="record-count" aria-live="polite">{visible.length.toLocaleString("es-PE")} trabajadores</p>
            <button className="btn btn-secondary" type="button" onClick={() => void loadEmployees()} disabled={busy}>
              {loading ? <span className="spinner spinner-light" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}
              {loading ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
          <section className="panel-card table-card">
            {!ready || (loading && employees.length === 0) ? (
              <div className="loading-card" role="status">
                <span className="spinner spinner-light" aria-hidden="true" />
                <p>Consultando trabajadores…</p>
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <p>{employees.length === 0 ? "Todavía no hay trabajadores registrados." : "No hay trabajadores que coincidan."}</p>
                <p className="empty-detail">{employees.length === 0 ? "Registra el primero con el formulario." : "Prueba con otro nombre o código."}</p>
              </div>
            ) : (
              <div className="table-container" tabIndex={0} role="region" aria-label="Listado de trabajadores">
                <table>
                  <caption className="sr-only">Trabajadores registrados</caption>
                  <thead>
                    <tr>
                      <th scope="col">Nombre</th>
                      <th scope="col">Código</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Registro</th>
                      <th scope="col">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((employee) => (
                      <tr key={employee.id}>
                        <td>{employee.name}</td>
                        <td>{employee.employeeCode}</td>
                        <td>
                          <span className={employee.active ? "status active" : "status inactive"}>
                            <span className="status-dot" aria-hidden="true" />
                            {employee.active ? "Activo" : "Inactivo"}
                          </span>
                        </td>
                        <td>{formatCreated(employee.createdAt)}</td>
                        <td>
                          {employee.active ? (
                            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setDialogError(""); setDeactivateTarget(employee); }}>
                              Desactivar
                            </button>
                          ) : (
                            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void setActive(employee, true)}>
                              {pendingId === employee.id && <span className="spinner spinner-light" aria-hidden="true" />}
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
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="deactivate-title">
            <h2 id="deactivate-title">Desactivar trabajador</h2>
            <p>{deactivateTarget.name} ({deactivateTarget.employeeCode}) no podrá registrar asistencia mientras esté inactivo. Las marcaciones ya guardadas se conservan.</p>
            {dialogError && <p className="field-error" role="alert">{dialogError}</p>}
            <div className="modal-actions">
              <button ref={cancelRef} className="btn btn-secondary" type="button" disabled={pendingId === deactivateTarget.id} onClick={() => setDeactivateTarget(null)}>Cancelar</button>
              <button className="btn btn-danger" type="button" disabled={pendingId === deactivateTarget.id} onClick={() => void setActive(deactivateTarget, false)}>
                {pendingId === deactivateTarget.id && <span className="spinner spinner-light" aria-hidden="true" />}
                {pendingId === deactivateTarget.id ? "Desactivando…" : "Desactivar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
