import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { apiUrl, auth } from "./firebase";

type Shift = { attendanceId: string; checkInAt: string; checkOutAt: string; minutes: number };
type Exclusion = { attendanceId: string; reason: "open" | "invalid" | "duplicate" | "non-positive" };
type Settlement = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  hourlyRate: number | null;
  amount: number | null;
  currency: "PEN";
  status: "confirmed" | "pending" | "missing-rate";
  yapePhone: string | null;
  shifts: Shift[];
  excluded: Exclusion[];
};

type Notice = { type: "success" | "error"; text: string };

const EXCLUSION_LABEL: Record<Exclusion["reason"], string> = {
  open: "Jornada abierta, sin salida. No entra en el importe.",
  invalid: "Fechas no fiables. No se inventan horas.",
  duplicate: "Jornada duplicada. Se contó una sola vez.",
  "non-positive": "Duración no válida.",
};

const STATUS_LABEL: Record<Settlement["status"], string> = {
  confirmed: "Confirmada",
  pending: "Por confirmar",
  "missing-rate": "Falta tarifa",
};

function addDays(key: string, days: number) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${nextMonth}-${nextDay}`;
}

function limaDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function currentWeekStart(now = new Date()) {
  const key = limaDateKey(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Lima", weekday: "short" }).format(now);
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const fromMonday = index <= 0 ? 6 : index - 1;
  return addDays(key, -fromMonday);
}

function formatDay(key: string) {
  const date = new Date(`${key}T05:00:00.000Z`);
  return date.toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Lima" });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" });
}

function formatWorked(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatMoney(value: number | null) {
  if (value == null) return "—";
  return new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(value);
}

function formatPhone(value: string | null) {
  if (!value) return "Sin celular";
  return value.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
}

function readSettlement(value: unknown): Settlement | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.employeeId !== "string" || typeof record.employeeName !== "string") return null;
  const status = record.status === "confirmed" || record.status === "pending" || record.status === "missing-rate" ? record.status : "pending";
  return {
    employeeId: record.employeeId,
    employeeCode: typeof record.employeeCode === "string" ? record.employeeCode : "",
    employeeName: record.employeeName,
    weekStart: typeof record.weekStart === "string" ? record.weekStart : "",
    weekEnd: typeof record.weekEnd === "string" ? record.weekEnd : "",
    totalMinutes: typeof record.totalMinutes === "number" ? record.totalMinutes : 0,
    hourlyRate: typeof record.hourlyRate === "number" ? record.hourlyRate : null,
    amount: typeof record.amount === "number" ? record.amount : null,
    currency: "PEN",
    status,
    yapePhone: typeof record.yapePhone === "string" ? record.yapePhone : null,
    shifts: Array.isArray(record.shifts) ? record.shifts.flatMap((shift) => {
      if (!shift || typeof shift !== "object") return [];
      const item = shift as Shift;
      if (typeof item.attendanceId !== "string" || typeof item.minutes !== "number") return [];
      return [item];
    }) : [],
    excluded: Array.isArray(record.excluded) ? record.excluded.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const exclusion = item as Exclusion;
      if (typeof exclusion.attendanceId !== "string" || !(exclusion.reason in EXCLUSION_LABEL)) return [];
      return [exclusion];
    }) : [],
  };
}

export default function SettlementsPanel() {
  const [weekStart, setWeekStart] = useState(() => currentWeekStart());
  const [weekEnd, setWeekEnd] = useState("");
  const [rows, setRows] = useState<Settlement[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [detail, setDetail] = useState<Settlement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const thisWeek = currentWeekStart();

  useEffect(() => {
    void loadWeek(weekStart);
  }, [weekStart]);

  useEffect(() => {
    if (!detail) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming) setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, confirming]);

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

  async function loadWeek(week: string, keepNotice = false) {
    setLoading(true);
    if (!keepNotice) setNotice(null);
    try {
      const response = await authorized(`/api/admin/settlements?week=${encodeURIComponent(week)}`);
      const data = await response.json() as { message?: string; weekEnd?: string; settlements?: unknown };
      if (!response.ok) {
        setNotice({ type: "error", text: data.message || "No se pudo consultar la semana." });
        return;
      }
      setWeekEnd(typeof data.weekEnd === "string" ? data.weekEnd : "");
      setRows(Array.isArray(data.settlements) ? data.settlements.map(readSettlement).filter((row): row is Settlement => row !== null) : []);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "error", text: error instanceof TypeError ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo." : "No se pudo consultar la semana." });
    } finally {
      setLoading(false);
      setReady(true);
    }
  }

  async function confirmSettlement() {
    if (!detail || detail.status !== "pending" || detail.totalMinutes <= 0) return;
    setConfirming(true);
    setDialogError("");
    try {
      const response = await authorized("/api/admin/settlements", {
        method: "POST",
        body: JSON.stringify({ employeeId: detail.employeeId, weekStart: detail.weekStart }),
      });
      const data = await response.json() as { message?: string; settlement?: unknown };
      if (!response.ok) {
        setDialogError(data.message || "No se pudo confirmar la liquidación.");
        return;
      }
      const saved = readSettlement(data.settlement);
      setNotice({ type: "success", text: saved?.status === "confirmed" ? "Liquidación confirmada. El importe queda fijo." : "Liquidación registrada." });
      setDetail(saved);
      await loadWeek(weekStart, true);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setDialogError(error instanceof TypeError ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo." : "No se pudo confirmar la liquidación.");
    } finally {
      setConfirming(false);
    }
  }

  const weekLabel = weekEnd ? `${formatDay(weekStart)} – ${formatDay(weekEnd)}` : formatDay(weekStart);

  return (
    <div className="admin-stack">
      {notice && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
      <section className="panel-card" aria-labelledby="settlements-title">
        <header className="card-head">
          <div>
            <h2 id="settlements-title">Control semanal</h2>
            <p>Lunes a domingo, hora de Perú. Consultar no guarda nada y no realiza pagos.</p>
          </div>
          <div className="week-switch">
            <button className="btn btn-secondary" type="button" onClick={() => setWeekStart((current) => addDays(current, -7))} disabled={loading} aria-label="Semana anterior">
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <strong>{weekLabel}</strong>
            <button className="btn btn-secondary" type="button" onClick={() => setWeekStart((current) => addDays(current, 7))} disabled={loading || weekStart >= thisWeek} aria-label="Semana siguiente">
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void loadWeek(weekStart)} disabled={loading}>
              {loading ? <span className="spinner spinner-light" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}
              {loading ? "Consultando…" : "Actualizar"}
            </button>
          </div>
        </header>
        {!ready || (loading && rows.length === 0) ? (
          <div className="loading-card" role="status">
            <span className="spinner spinner-light" aria-hidden="true" />
            <p>Consultando liquidaciones…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <p>No hay jornadas para esta semana.</p>
            <p className="empty-detail">Cuando existan marcaciones cerradas, cada trabajador aparecerá una sola vez.</p>
          </div>
        ) : (
          <div className="table-container" tabIndex={0} role="region" aria-label="Liquidaciones de la semana">
            <table>
              <caption className="sr-only">Resumen semanal del {weekLabel}</caption>
              <thead>
                <tr>
                  <th scope="col">Trabajador</th>
                  <th scope="col">Código</th>
                  <th scope="col">Semana</th>
                  <th scope="col">Horas</th>
                  <th scope="col">Tarifa</th>
                  <th scope="col">Importe</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.employeeId}>
                    <td>{row.employeeName}</td>
                    <td>{row.employeeCode}</td>
                    <td>{weekLabel}</td>
                    <td>{formatWorked(row.totalMinutes)}</td>
                    <td>{row.hourlyRate == null ? "Sin tarifa" : formatMoney(row.hourlyRate)}</td>
                    <td>{formatMoney(row.amount)}</td>
                    <td>
                      <span className={`status ${row.status}`}>
                        <span className="status-dot" aria-hidden="true" />
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-secondary" type="button" onClick={() => { setDialogError(""); setDetail(row); }}>
                        Ver detalle
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail && (
        <div className="modal-backdrop">
          <div className="modal-card settlement-modal" role="dialog" aria-modal="true" aria-labelledby="settlement-detail-title">
            <h2 id="settlement-detail-title">{detail.employeeName}</h2>
            <p>{detail.employeeCode} · {formatDay(detail.weekStart)} – {formatDay(detail.weekEnd)}</p>
            <div className="settlement-facts">
              <div><span>Horas</span><strong>{formatWorked(detail.totalMinutes)}</strong></div>
              <div><span>Tarifa aplicada</span><strong>{detail.hourlyRate == null ? "Sin tarifa" : `${formatMoney(detail.hourlyRate)} / hora`}</strong></div>
              <div><span>Importe</span><strong>{formatMoney(detail.amount)}</strong></div>
              <div><span>Estado</span><strong>{STATUS_LABEL[detail.status]}</strong></div>
              <div><span>Celular Yape</span><strong>{formatPhone(detail.yapePhone)}</strong></div>
              <div><span>Moneda</span><strong>PEN</strong></div>
            </div>
            {detail.status === "missing-rate" && <p>Configura la tarifa en Personal antes de confirmar. No se usa una tarifa supuesta.</p>}
            {detail.status === "confirmed" && <p>Esta liquidación conserva la tarifa y el importe del momento en que se confirmó.</p>}
            <h3>Jornadas incluidas</h3>
            {detail.shifts.length === 0 ? (
              <p>No hay jornadas cerradas que sumen tiempo en esta semana.</p>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Entrada</th>
                      <th scope="col">Salida</th>
                      <th scope="col">Minutos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.shifts.map((shift) => (
                      <tr key={shift.attendanceId}>
                        <td>{formatDateTime(shift.checkInAt)}</td>
                        <td>{formatDateTime(shift.checkOutAt)}</td>
                        <td>{formatWorked(shift.minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {detail.excluded.length > 0 && (
              <>
                <h3>No incluidas</h3>
                <ul className="exclusion-list">
                  {detail.excluded.map((item) => (
                    <li key={`${item.attendanceId}-${item.reason}`}>{EXCLUSION_LABEL[item.reason]}</li>
                  ))}
                </ul>
              </>
            )}
            {dialogError && <p className="field-error" role="alert">{dialogError}</p>}
            <div className="modal-actions">
              <button ref={closeRef} className="btn btn-secondary" type="button" disabled={confirming} onClick={() => setDetail(null)}>Cerrar</button>
              {detail.status === "pending" && detail.totalMinutes > 0 && (
                <button className="btn btn-primary" type="button" disabled={confirming} onClick={() => void confirmSettlement()}>
                  {confirming && <span className="spinner spinner-light" aria-hidden="true" />}
                  {confirming ? "Confirmando…" : "Confirmar liquidación"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
