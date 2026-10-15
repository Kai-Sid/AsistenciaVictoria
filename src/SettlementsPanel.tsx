import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { apiUrl, auth } from "./firebase";

type Shift = { attendanceId: string; checkInAt: string; checkOutAt: string; minutes: number };
type Exclusion = { attendanceId: string; reason: "open" | "invalid" | "duplicate" | "non-positive" };
type PaymentStatus = "pending" | "processing" | "paid" | "failed";
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
  paymentStatus: PaymentStatus | null;
  yapePhone: string | null;
  yapeQrRegistered: boolean;
  transfer: TransferInfo | null;
  shifts: Shift[];
  excluded: Exclusion[];
};

type TransferInfo = {
  amount: number;
  declaredAt: string;
  declaredByName: string;
};

type Notice = { type: "success" | "error" | "info"; text: string };

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

const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  pending: "Pago pendiente",
  processing: "Pago en proceso",
  paid: "Pagado",
  failed: "Pago fallido",
};

const MISSING_QR = "Falta registrar el QR del trabajador.";

type QrStatus = "idle" | "loading" | "ready" | "missing" | "error";

type PayModal = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  amount: number | null;
  yapePhone: string | null;
  yapeQrRegistered: boolean;
  transfer: TransferInfo | null;
  qrStatus: QrStatus;
  notice: string;
};

function formatSoles(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function transferLabel(row: { status: Settlement["status"]; transfer: TransferInfo | null }) {
  if (row.transfer) return "Declarada por el administrador";
  if (row.status === "confirmed") return "Pendiente de confirmar";
  return "Al confirmar la liquidación";
}

function readTransfer(value: unknown): TransferInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.status !== "declared" || record.verifiesDeposit !== false) return null;
  if (typeof record.amount !== "number" || !Number.isFinite(record.amount)) return null;
  if (typeof record.declaredAt !== "string" || typeof record.declaredByName !== "string" || record.declaredByName.length === 0) return null;
  return { amount: record.amount, declaredAt: record.declaredAt, declaredByName: record.declaredByName };
}

function readPaymentStatus(value: unknown): PaymentStatus | null {
  return value === "pending" || value === "processing" || value === "paid" || value === "failed" ? value : null;
}

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
    paymentStatus: readPaymentStatus(record.paymentStatus),
    yapePhone: typeof record.yapePhone === "string" ? record.yapePhone : null,
    yapeQrRegistered: record.yapeQrRegistered === true,
    transfer: readTransfer(record.transfer),
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
  const [payModal, setPayModal] = useState<PayModal | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const paymentCloseRef = useRef<HTMLButtonElement>(null);
  const returnHandled = useRef(false);
  const payOpenRef = useRef(false);
  const qrRequest = useRef(0);
  const thisWeek = currentWeekStart();

  useEffect(() => {
    void loadWeek(weekStart);
  }, [weekStart]);

  useEffect(() => {
    return () => {
      if (qrUrl) URL.revokeObjectURL(qrUrl);
    };
  }, [qrUrl]);

  useEffect(() => {
    if (!detail && !payModal) return;
    if (payModal) paymentCloseRef.current?.focus();
    else closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (expanded) {
        setExpanded(false);
        return;
      }
      if (payOpenRef.current) {
        closePayModal();
        return;
      }
      if (!confirming && !declaring) setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, payModal, expanded, confirming, declaring]);

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
        return null;
      }
      setWeekEnd(typeof data.weekEnd === "string" ? data.weekEnd : "");
      const next = Array.isArray(data.settlements) ? data.settlements.map(readSettlement).filter((row): row is Settlement => row !== null) : [];
      setRows(next);
      return next;
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "error", text: error instanceof TypeError ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo." : "No se pudo consultar la semana." });
      return null;
    } finally {
      await notePaymentReturn();
      setLoading(false);
      setReady(true);
    }
  }

  async function notePaymentReturn() {
    const params = new URLSearchParams(window.location.search);
    if (returnHandled.current || params.get("pago") !== "regreso") return;
    returnHandled.current = true;
    const employeeId = params.get("employeeId") ?? "";
    const weekStartKey = params.get("weekStart") ?? "";
    ["pago", "status", "collection_status", "payment_id", "external_reference", "merchant_order_id", "preference_id"].forEach((key) => params.delete(key));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    try {
      const response = await authorized(`/api/admin/payments/return?employeeId=${encodeURIComponent(employeeId)}&weekStart=${encodeURIComponent(weekStartKey)}`);
      const data = await response.json() as { message?: string; confirmsPayment?: boolean };
      setNotice({
        type: "info",
        text: data.confirmsPayment === false && data.message
          ? data.message
          : "Volver a AsistenciaVictoria deja el pago como está. Solo una verificación del proveedor en el servidor puede marcarlo como pagado.",
      });
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setNotice({ type: "info", text: "No se pudo consultar el estado del pago. Volver a esta pantalla no lo marca como pagado." });
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
      const next = await loadWeek(weekStart, true);
      const refreshed = next?.find((row) => row.employeeId === detail.employeeId);
      setDetail(refreshed ?? saved);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      setDialogError(error instanceof TypeError ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo." : "No se pudo confirmar la liquidación.");
    } finally {
      setConfirming(false);
    }
  }

  function closePayModal() {
    payOpenRef.current = false;
    qrRequest.current += 1;
    setExpanded(false);
    setPayModal(null);
    setQrUrl(null);
  }

  async function loadWorkerQr(employeeId: string) {
    const request = ++qrRequest.current;
    setQrUrl(null);
    setPayModal((current) => current && current.employeeId === employeeId ? { ...current, qrStatus: "loading" } : current);
    try {
      const response = await authorized(`/api/admin/employees/yape-qr?employeeId=${encodeURIComponent(employeeId)}`);
      if (qrRequest.current !== request) return;
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/^image\/(png|jpeg|webp)$/.test(type)) {
        setPayModal((current) => current && current.employeeId === employeeId ? { ...current, qrStatus: "missing" } : current);
        return;
      }
      const blob = await response.blob();
      if (qrRequest.current !== request) return;
      if (blob.size === 0 || blob.size > 300_000) {
        setPayModal((current) => current && current.employeeId === employeeId ? { ...current, qrStatus: "error" } : current);
        return;
      }
      setQrUrl(URL.createObjectURL(blob));
      setPayModal((current) => current && current.employeeId === employeeId ? { ...current, qrStatus: "ready" } : current);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      if (qrRequest.current !== request) return;
      setPayModal((current) => current && current.employeeId === employeeId ? { ...current, qrStatus: "error" } : current);
    }
  }

  function openYapePayment(row: Settlement) {
    if (row.status !== "confirmed" || row.amount == null) return;
    qrRequest.current += 1;
    payOpenRef.current = true;
    setExpanded(false);
    setDialogError("");
    setQrUrl(null);
    setPayModal({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      amount: row.amount,
      yapePhone: row.yapePhone,
      yapeQrRegistered: row.yapeQrRegistered,
      transfer: row.transfer,
      qrStatus: row.yapeQrRegistered ? "loading" : "missing",
      notice: "",
    });
    if (row.yapeQrRegistered) void loadWorkerQr(row.employeeId);
  }

  async function declareTransfer() {
    if (!payModal || payModal.transfer || declaring || payModal.amount == null) return;
    const target = payModal;
    setDeclaring(true);
    setPayModal((current) => current ? { ...current, notice: "" } : current);
    try {
      const response = await authorized("/api/admin/settlements/transfer", {
        method: "POST",
        body: JSON.stringify({ employeeId: target.employeeId, weekStart: target.weekStart, amount: target.amount }),
      });
      const data = await response.json() as { message?: string; verifiesDeposit?: boolean; transfer?: unknown };
      const transfer = readTransfer(data.transfer);
      if (!response.ok || data.verifiesDeposit !== false || !transfer) {
        const text = data.message || "No se pudo registrar la declaración.";
        if (payOpenRef.current) setPayModal((current) => current && current.employeeId === target.employeeId ? { ...current, notice: text } : current);
        else setDialogError(text);
        return;
      }
      const next = await loadWeek(weekStart, true);
      const updated = next?.find((row) => row.employeeId === target.employeeId);
      if (updated) setDetail(updated);
      if (!payOpenRef.current) {
        setNotice({ type: "info", text: "Quedó registrada tu declaración. AsistenciaVictoria no comprobó el ingreso en Yape." });
        return;
      }
      setPayModal((current) => current && current.employeeId === target.employeeId ? {
        ...current,
        amount: updated?.amount ?? current.amount,
        yapePhone: updated?.yapePhone ?? current.yapePhone,
        yapeQrRegistered: updated?.yapeQrRegistered ?? current.yapeQrRegistered,
        transfer: updated?.transfer ?? transfer,
        notice: "",
      } : current);
    } catch (error) {
      console.error(error instanceof Error ? error.name : "error");
      const text = error instanceof TypeError ? "No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo." : "No se pudo registrar la declaración.";
      if (payOpenRef.current) setPayModal((current) => current && current.employeeId === target.employeeId ? { ...current, notice: text } : current);
      else setDialogError(text);
    } finally {
      setDeclaring(false);
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
                  <th scope="col">Transferencia</th>
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
                      <span className={`status ${row.transfer ? "transfer-declared" : row.status === "confirmed" ? "transfer-pending" : "inactive"}`}>
                        <span className="status-dot" aria-hidden="true" />
                        {transferLabel(row)}
                      </span>
                      {row.paymentStatus && <span className="transfer-provider">Proveedor: {PAYMENT_LABEL[row.paymentStatus]}</span>}
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
              <div><span>Liquidación calculada</span><strong>{STATUS_LABEL[detail.status]}</strong></div>
              <div><span>Transferencia</span><strong>{transferLabel(detail)}</strong></div>
              <div><span>Celular Yape</span><strong>{formatPhone(detail.yapePhone)}</strong></div>
              <div><span>QR de Yape</span><strong>{detail.yapeQrRegistered ? "Registrado" : "Sin registrar"}</strong></div>
              {detail.paymentStatus && <div><span>Proveedor</span><strong>{PAYMENT_LABEL[detail.paymentStatus]}</strong></div>}
              <div><span>Moneda</span><strong>PEN</strong></div>
            </div>
            {detail.status === "missing-rate" && <p>Configura la tarifa en Personal antes de confirmar. No se usa una tarifa supuesta.</p>}
            {detail.status === "confirmed" && <p>Esta liquidación conserva la tarifa y el importe del momento en que se confirmó.</p>}
            {detail.status === "confirmed" && (
              <p className="payment-note">Pagar con Yape muestra el celular y el QR registrado para que hagas la transferencia en tu aplicación. Cerrar la ventana deja la transferencia como está.</p>
            )}
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
              <button ref={closeRef} className="btn btn-secondary" type="button" disabled={confirming || declaring} onClick={() => setDetail(null)}>Cerrar</button>
              {detail.status === "pending" && detail.totalMinutes > 0 && (
                <button className="btn btn-primary" type="button" disabled={confirming || declaring} onClick={() => void confirmSettlement()}>
                  {confirming && <span className="spinner spinner-light" aria-hidden="true" />}
                  {confirming ? "Confirmando…" : "Confirmar liquidación"}
                </button>
              )}
              {detail.status === "confirmed" && detail.amount != null && (
                <button className="btn btn-primary" type="button" disabled={confirming || declaring} onClick={() => openYapePayment(detail)}>
                  Pagar con Yape
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {payModal && (
        <div className="modal-backdrop yape-backdrop">
          <div className="modal-card yape-modal" role="dialog" aria-modal="true" aria-labelledby="yape-pay-title" aria-describedby="yape-pay-result">
            <p className="yape-kicker">Liquidación calculada</p>
            <h2 id="yape-pay-title">{payModal.employeeName}</h2>
            <p>Código {payModal.employeeCode || "—"}</p>
            <p>Semana {formatDay(payModal.weekStart)} – {formatDay(payModal.weekEnd)}</p>
            <p className="yape-amount">{formatSoles(payModal.amount)}</p>
            <div className="yape-status-line">
              <span>Celular Yape</span>
              <strong>{formatPhone(payModal.yapePhone)}</strong>
            </div>
            <div className="yape-status-line">
              <span>Transferencia</span>
              <strong>{payModal.transfer ? "Declarada por el administrador" : "Pendiente de confirmar"}</strong>
            </div>
            <div className="yape-qr-slot" id="yape-pay-result">
              {payModal.qrStatus === "ready" && qrUrl ? (
                <>
                  <img src={qrUrl} alt={`QR de Yape de ${payModal.employeeName}`} />
                  <button className="btn btn-secondary" type="button" onClick={() => setExpanded(true)}>Ampliar QR</button>
                </>
              ) : payModal.qrStatus === "loading" ? (
                <>
                  <span className="spinner spinner-light" aria-hidden="true" />
                  <p>Cargando el QR registrado.</p>
                </>
              ) : payModal.qrStatus === "error" ? (
                <p>No se pudo cargar el QR registrado.</p>
              ) : (
                <>
                  <strong>{MISSING_QR}</strong>
                  <p>Regístralo en Personal, dentro de Tarifa y Yape, con la imagen que generó el trabajador.</p>
                </>
              )}
            </div>
            {payModal.qrStatus === "ready" && (
              <ol className="yape-steps">
                <li>Abre Yape en tu celular.</li>
                <li>Escanea este QR.</li>
                <li>Verifica que el destinatario sea {payModal.employeeName}.</li>
                <li>Introduce el importe {formatSoles(payModal.amount)}.</li>
              </ol>
            )}
            {payModal.qrStatus === "ready" && <p className="payment-note">Si AsistenciaVictoria está en el mismo celular, amplía el QR para verlo con claridad antes de abrir Yape.</p>}
            {payModal.transfer ? (
              <p className="payment-note">
                {payModal.transfer.declaredByName} declaró esta transferencia el {formatDateTime(payModal.transfer.declaredAt)}. Importe declarado: {formatSoles(payModal.transfer.amount)}. AsistenciaVictoria no comprobó el ingreso en Yape.
              </p>
            ) : (
              <p className="payment-note">El botón siguiente solo guarda tu declaración, con la fecha, tu usuario y el importe de la liquidación.</p>
            )}
            {payModal.notice && <p className="field-error" role="alert">{payModal.notice}</p>}
            <div className="modal-actions">
              <button ref={paymentCloseRef} className="btn btn-secondary" type="button" onClick={closePayModal}>Cerrar</button>
              {!payModal.transfer && (
                <button className="btn btn-primary" type="button" disabled={declaring || payModal.amount == null} onClick={() => void declareTransfer()}>
                  {declaring && <span className="spinner spinner-light" aria-hidden="true" />}
                  {declaring ? "Registrando…" : "Registrar transferencia realizada"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {expanded && qrUrl && payModal && (
        <div className="yape-enlarge">
          <div role="dialog" aria-modal="true" aria-labelledby="yape-enlarge-title">
            <h2 id="yape-enlarge-title" className="sr-only">QR ampliado de {payModal.employeeName}</h2>
            <img src={qrUrl} alt={`QR de Yape de ${payModal.employeeName}, ampliado`} />
            <p>{formatSoles(payModal.amount)} · {formatPhone(payModal.yapePhone)}</p>
            <button className="btn btn-secondary" type="button" onClick={() => setExpanded(false)}>Cerrar ampliación</button>
          </div>
        </div>
      )}
    </div>
  );
}
