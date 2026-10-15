import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Clock,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  Timer,
  Users,
  Wallet,
  X,
} from "lucide-react";
import AccountsPanel from "./AccountsPanel";
import SettlementsPanel from "./SettlementsPanel";
import StaffPanel from "./StaffPanel";

export type AttendanceRow = {
  id: string;
  employeeName: string;
  employeeCode: string;
  checkInAt?: string | null;
  checkOutAt?: string | null;
  status: string;
  workedMinutes?: number | null;
};

type Notice = { type: "success" | "error" | "info"; text: string };
type View = "resumen" | "registros" | "personal" | "liquidaciones" | "cuentas";
type StatusFilter = "all" | "open" | "closed";
type DayPoint = { key: string; label: string; entries: number; exits: number };
type WorkerHours = { key: string; name: string; code: string; minutes: number };

type Props = {
  email?: string | null;
  rows: AttendanceRow[];
  busy: boolean;
  recordsReady: boolean;
  notice: Notice | null;
  onRefresh: () => void;
  onLogout: () => void;
};

const CHART_HEIGHT = 248;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" });
}

function formatWorked(minutes?: number | null) {
  if (minutes == null) return "—";
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function dayKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayKeyFromIso(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dayKey(date);
}

function parseDayKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function daySpan(first: Date, last: Date) {
  let count = 1;
  const cursor = new Date(first);
  while (cursor.getTime() < last.getTime() && count < 400) {
    cursor.setDate(cursor.getDate() + 1);
    count += 1;
  }
  return count;
}

function buildDailySeries(rows: AttendanceRow[]): DayPoint[] {
  const counts = new Map<string, { entries: number; exits: number }>();
  const bump = (key: string | null, field: "entries" | "exits") => {
    if (!key) return;
    const current = counts.get(key) ?? { entries: 0, exits: 0 };
    current[field] += 1;
    counts.set(key, current);
  };
  for (const row of rows) {
    bump(dayKeyFromIso(row.checkInAt), "entries");
    bump(dayKeyFromIso(row.checkOutAt), "exits");
  }
  const activeKeys = [...counts.keys()].sort().slice(-14);
  if (activeKeys.length === 0) return [];
  const first = parseDayKey(activeKeys[0]);
  const last = parseDayKey(activeKeys[activeKeys.length - 1]);
  const toPoint = (key: string, value: { entries: number; exits: number }): DayPoint => ({
    key,
    label: parseDayKey(key).toLocaleDateString("es-PE", { day: "2-digit", month: "short" }),
    entries: value.entries,
    exits: value.exits,
  });
  if (daySpan(first, last) > 14) {
    return activeKeys.map((key) => toPoint(key, counts.get(key) ?? { entries: 0, exits: 0 }));
  }
  const points: DayPoint[] = [];
  const cursor = new Date(first);
  while (cursor.getTime() <= last.getTime()) {
    const key = dayKey(cursor);
    points.push(toPoint(key, counts.get(key) ?? { entries: 0, exits: 0 }));
    cursor.setDate(cursor.getDate() + 1);
  }
  return points;
}

function hoursByWorker(rows: AttendanceRow[]): WorkerHours[] {
  const map = new Map<string, WorkerHours>();
  for (const row of rows) {
    if (row.workedMinutes == null) continue;
    const key = row.employeeCode || row.employeeName || row.id;
    const current = map.get(key) ?? { key, name: row.employeeName, code: row.employeeCode, minutes: 0 };
    current.minutes += row.workedMinutes;
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, "es"));
}

function summarize(rows: AttendanceRow[]) {
  let open = 0;
  let minutes = 0;
  let hasTime = false;
  const workers = new Set<string>();
  for (const row of rows) {
    if (row.status === "open") open += 1;
    if (row.workedMinutes != null) {
      hasTime = true;
      minutes += row.workedMinutes;
    }
    workers.add(row.employeeCode || row.employeeName || row.id);
  }
  return { total: rows.length, open, closed: rows.length - open, workers: workers.size, minutes, hasTime };
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty-state">
      <p>{title}</p>
      {detail ? <p className="empty-detail">{detail}</p> : null}
    </div>
  );
}

function AttendanceTable({ rows }: { rows: AttendanceRow[] }) {
  return (
    <div className="table-container" tabIndex={0} role="region" aria-label="Registros de asistencia">
      <table>
        <caption className="sr-only">Asistencia del personal</caption>
        <thead>
          <tr>
            <th scope="col">Trabajador</th>
            <th scope="col">Código</th>
            <th scope="col">Entrada</th>
            <th scope="col">Salida</th>
            <th scope="col">Tiempo</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = row.status === "open";
            return (
              <tr key={row.id}>
                <td>{row.employeeName}</td>
                <td>{row.employeeCode}</td>
                <td>{formatDate(row.checkInAt)}</td>
                <td>{formatDate(row.checkOutAt)}</td>
                <td>{formatWorked(row.workedMinutes)}</td>
                <td>
                  <span className={open ? "status open" : "status closed"}>
                    <span className="status-dot" aria-hidden="true" />
                    {open ? "En curso" : "Cerrada"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActivityChart({ points }: { points: DayPoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; point: DayPoint } | null>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setChartWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (points.length === 0) {
    return <EmptyState title="Aún no hay marcaciones con fecha para graficar." />;
  }

  const max = Math.max(1, ...points.map((point) => Math.max(point.entries, point.exits)));
  const ticks = max <= 2 ? [0, max] : [0, Math.round(max / 2), max];
  const pad = { top: 12, right: 8, bottom: 32, left: 36 };
  const innerH = CHART_HEIGHT - pad.top - pad.bottom;
  const innerW = Math.max(chartWidth - pad.left - pad.right, 1);
  const groupW = innerW / points.length;
  const labelStep = points.length > 8 && chartWidth < 560 ? 2 : 1;

  function showTip(event: { clientX: number; clientY: number }, point: DayPoint) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const bounds = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - bounds.left, 88), Math.max(bounds.width - 88, 88));
    const y = event.clientY - bounds.top;
    setTip({ x, y, point });
  }

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <table className="sr-only">
        <caption>Entradas y salidas por día</caption>
        <thead>
          <tr>
            <th>Día</th>
            <th>Entradas</th>
            <th>Salidas</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key}>
              <td>{point.label}</td>
              <td>{point.entries}</td>
              <td>{point.exits}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {chartWidth > 0 && (
        <svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`} role="img" aria-label="Gráfico de entradas y salidas por día">
          {ticks.map((tick) => {
            const y = pad.top + innerH - (tick / max) * innerH;
            return (
              <g key={tick}>
                <line className="chart-grid" x1={pad.left} x2={chartWidth - pad.right} y1={y} y2={y} />
                <text className="chart-label" x={pad.left - 8} y={y} textAnchor="end" dominantBaseline="middle">{tick}</text>
              </g>
            );
          })}
          <line className="chart-axis" x1={pad.left} x2={chartWidth - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} />
          {points.map((point, index) => {
            const entryH = (point.entries / max) * innerH;
            const exitH = (point.exits / max) * innerH;
            const barW = Math.max(3, Math.min(14, (groupW - 10) / 2));
            const pairW = barW * 2 + 4;
            const origin = pad.left + index * groupW + (groupW - pairW) / 2;
            const baseline = pad.top + innerH;
            return (
              <g
                key={point.key}
                className="chart-group"
                onMouseMove={(event) => showTip(event, point)}
                onMouseLeave={() => setTip(null)}
              >
                <rect className="chart-hit" x={pad.left + index * groupW} y={pad.top} width={groupW} height={innerH} />
                {entryH > 0 && <rect className="bar-entry" x={origin} y={baseline - entryH} width={barW} height={entryH} rx={Math.min(3, entryH / 2)} />}
                {exitH > 0 && <rect className="bar-exit" x={origin + barW + 4} y={baseline - exitH} width={barW} height={exitH} rx={Math.min(3, exitH / 2)} />}
                {(index % labelStep === 0 || index === points.length - 1) && (
                  <text className="chart-label" x={pad.left + index * groupW + groupW / 2} y={baseline + 18} textAnchor="middle">{point.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {tip && (
        <div className={`chart-tip${tip.y < 78 ? " is-below" : ""}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
          <p>{tip.point.label}</p>
          <p><strong>{tip.point.entries}</strong> entradas</p>
          <p><strong>{tip.point.exits}</strong> salidas</p>
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard({ email, rows, busy, recordsReady, notice, onRefresh, onLogout }: Props) {
  const [view, setView] = useState<View>(() => (
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("pago") === "regreso" ? "liquidaciones" : "resumen"
  ));
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const summary = useMemo(() => summarize(rows), [rows]);
  const points = useMemo(() => buildDailySeries(rows), [rows]);
  const ranked = useMemo(() => hoursByWorker(rows), [rows]);
  const shownWorkers = ranked.slice(0, 8);
  const maxMinutes = shownWorkers.reduce((peak, worker) => Math.max(peak, worker.minutes), 0);
  const failedEmpty = recordsReady && rows.length === 0 && notice?.type === "error";
  const visible = rows.filter((row) => {
    const matchesQuery = `${row.employeeName} ${row.employeeCode}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "open" ? row.status === "open" : row.status !== "open");
    return matchesQuery && matchesStatus;
  });

  useEffect(() => {
    if (!menuOpen) return;
    const media = window.matchMedia("(max-width: 900px)");
    const previous = document.body.style.overflow;
    const sync = () => {
      document.body.style.overflow = media.matches ? "hidden" : previous;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    sync();
    window.addEventListener("keydown", onKey);
    media.addEventListener("change", sync);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      media.removeEventListener("change", sync);
    };
  }, [menuOpen]);

  function selectView(next: View) {
    setView(next);
    setMenuOpen(false);
  }

  const managed = view === "personal" || view === "cuentas" || view === "liquidaciones";
  const title = view === "resumen" ? "Panel de asistencia" : view === "registros" ? "Registros de asistencia" : view === "personal" ? "Personal" : view === "liquidaciones" ? "Liquidaciones" : "Cuentas administrativas";
  const subtitle = view === "personal" ? "Alta y estado de los trabajadores" : view === "liquidaciones" ? "Horas y montos por semana" : view === "cuentas" ? "Alta y estado de los administradores" : "Últimos 500 registros";

  return (
    <div className={`admin-app${menuOpen ? " menu-open" : ""}`}>
      {menuOpen && <button className="sidebar-backdrop" type="button" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar${menuOpen ? " is-open" : ""}`} id="admin-sidebar">
        <button className="sidebar-close btn btn-secondary" type="button" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)}>
          <X size={18} aria-hidden="true" />
        </button>
        <div className="sidebar-brand">
          <img className="sidebar-logo" src="/logo-victoria.png" alt="Logotipo oficial de Victoria Catering y Eventos" />
        </div>
        <nav className="sidebar-nav" aria-label="Secciones del panel">
          <button className={view === "resumen" ? "nav-item active" : "nav-item"} type="button" aria-current={view === "resumen" ? "page" : undefined} onClick={() => selectView("resumen")}>
            <LayoutDashboard size={18} aria-hidden="true" />
            Resumen
          </button>
          <button className={view === "registros" ? "nav-item active" : "nav-item"} type="button" aria-current={view === "registros" ? "page" : undefined} onClick={() => selectView("registros")}>
            <ClipboardList size={18} aria-hidden="true" />
            Registros
          </button>
          <button className={view === "personal" ? "nav-item active" : "nav-item"} type="button" aria-current={view === "personal" ? "page" : undefined} onClick={() => selectView("personal")}>
            <Users size={18} aria-hidden="true" />
            Personal
          </button>
          <button className={view === "liquidaciones" ? "nav-item active" : "nav-item"} type="button" aria-current={view === "liquidaciones" ? "page" : undefined} onClick={() => selectView("liquidaciones")}>
            <Wallet size={18} aria-hidden="true" />
            Liquidaciones
          </button>
          <button className={view === "cuentas" ? "nav-item active" : "nav-item"} type="button" aria-current={view === "cuentas" ? "page" : undefined} onClick={() => selectView("cuentas")}>
            <ShieldCheck size={18} aria-hidden="true" />
            Cuentas
          </button>
        </nav>
        <p className="sidebar-foot">
          <ShieldCheck size={15} aria-hidden="true" />
          Consulta reservada a cuentas con rol administrativo.
        </p>
      </aside>

      <div className="admin-main">
        <header className="admin-header">
          <div className="admin-heading-copy">
            <button className="menu-toggle btn btn-secondary" type="button" aria-expanded={menuOpen} aria-controls="admin-sidebar" aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"} onClick={() => setMenuOpen((open) => !open)}>
              <Menu size={18} aria-hidden="true" />
            </button>
            <div>
              <p className="admin-kicker">Administración</p>
              <h1>{title}</h1>
              <p className="admin-subtitle">{subtitle}</p>
            </div>
          </div>
          <div className="admin-header-actions">
            {email ? <p className="admin-identity" title={email}>{email}</p> : null}
            <button className="btn btn-secondary" type="button" onClick={onLogout}>
              <LogOut size={17} aria-hidden="true" />
              Cerrar sesión
            </button>
            {managed ? null : (
              <button className="btn btn-primary" type="button" onClick={onRefresh} disabled={busy} aria-busy={busy}>
                {busy ? <span className="spinner spinner-light" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}
                {busy ? "Actualizando…" : "Actualizar"}
              </button>
            )}
          </div>
        </header>

        <main className="admin-content" aria-busy={managed ? undefined : !recordsReady || busy}>
          {notice && !managed && <div className={`notice ${notice.type}`} role="status">{notice.text}</div>}
          {view === "personal" ? <StaffPanel /> : view === "cuentas" ? <AccountsPanel onSelfDeactivated={onLogout} /> : view === "liquidaciones" ? <SettlementsPanel /> : !recordsReady ? (
            <section className="panel-card loading-card" role="status">
              <span className="spinner spinner-light" aria-hidden="true" />
              <p>Consultando registros…</p>
            </section>
          ) : failedEmpty ? (
            <EmptyState title="No se pudieron mostrar los registros." detail="Revisa el aviso e inténtalo de nuevo con Actualizar." />
          ) : view === "resumen" ? (
            <div className="admin-stack">
              <section className="stat-grid" aria-label="Resumen de la consulta">
                <article className="stat-card">
                  <span className="stat-icon"><ClipboardList size={18} aria-hidden="true" /></span>
                  <p className="stat-label">Registros</p>
                  <p className="stat-value">{summary.total.toLocaleString("es-PE")}</p>
                  <p className="stat-hint">En la consulta actual</p>
                </article>
                <article className="stat-card">
                  <span className="stat-icon"><Clock size={18} aria-hidden="true" /></span>
                  <p className="stat-label">En curso</p>
                  <p className="stat-value">{summary.open.toLocaleString("es-PE")}</p>
                  <p className="stat-hint">Jornadas abiertas</p>
                </article>
                <article className="stat-card">
                  <span className="stat-icon"><CheckCircle2 size={18} aria-hidden="true" /></span>
                  <p className="stat-label">Cerradas</p>
                  <p className="stat-value">{summary.closed.toLocaleString("es-PE")}</p>
                  <p className="stat-hint">Jornadas finalizadas</p>
                </article>
                <article className="stat-card">
                  <span className="stat-icon"><Timer size={18} aria-hidden="true" /></span>
                  <p className="stat-label">Horas registradas</p>
                  <p className="stat-value">{summary.hasTime ? formatWorked(summary.minutes) : "—"}</p>
                  <p className="stat-hint">Tiempos ya calculados</p>
                </article>
              </section>
              <p className="scope-note">
                Cifras de los registros cargados · {summary.workers.toLocaleString("es-PE")} {summary.workers === 1 ? "trabajador" : "trabajadores"}
              </p>
              <div className="insight-grid">
                <section className="panel-card" aria-labelledby="chart-activity-title">
                  <header className="card-head">
                    <div>
                      <h2 id="chart-activity-title">Actividad por día</h2>
                      <p>Entradas y salidas contadas por fecha local.</p>
                    </div>
                    <div className="legend" aria-hidden="true">
                      <span><i className="swatch swatch-entry" /> Entradas</span>
                      <span><i className="swatch swatch-exit" /> Salidas</span>
                    </div>
                  </header>
                  <ActivityChart points={points} />
                </section>
                <section className="panel-card" aria-labelledby="chart-hours-title">
                  <header className="card-head">
                    <div>
                      <h2 id="chart-hours-title">Horas por trabajador</h2>
                      <p>Suma de los tiempos ya registrados en cada jornada.</p>
                    </div>
                  </header>
                  {shownWorkers.length === 0 ? (
                    <EmptyState title="Aún no hay horas registradas." detail="Aparecen cuando una jornada ya tiene tiempo calculado." />
                  ) : (
                    <>
                      <ul className="bar-list">
                        {shownWorkers.map((worker) => (
                          <li key={worker.key}>
                            <div className="bar-meta">
                              <span className="bar-name">{worker.name}{worker.code ? <span className="bar-code">{worker.code}</span> : null}</span>
                              <strong>{formatWorked(worker.minutes)}</strong>
                            </div>
                            <div className="bar-track" role="img" aria-label={`${worker.name}: ${formatWorked(worker.minutes)}`}>
                              <span className="bar-fill" style={{ width: `${maxMinutes > 0 ? (worker.minutes / maxMinutes) * 100 : 0}%` }} />
                            </div>
                          </li>
                        ))}
                      </ul>
                      {ranked.length > shownWorkers.length && (
                        <p className="chart-note">Mostrando {shownWorkers.length} de {ranked.length} trabajadores con horas registradas.</p>
                      )}
                    </>
                  )}
                </section>
              </div>
              <section className="panel-card table-card" aria-labelledby="recent-title">
                <header className="card-head">
                  <div>
                    <h2 id="recent-title">Últimos registros</h2>
                    <p>Vista previa de la consulta actual.</p>
                  </div>
                  {rows.length > 6 && (
                    <button className="btn btn-secondary" type="button" onClick={() => selectView("registros")}>Ver todos</button>
                  )}
                </header>
                {rows.length === 0 ? (
                  <EmptyState title="Todavía no hay registros en esta consulta." detail="Cuando existan marcaciones, aparecerán aquí." />
                ) : (
                  <AttendanceTable rows={rows.slice(0, 6)} />
                )}
              </section>
            </div>
          ) : (
            <div className="admin-stack">
              <div className="filters">
                <label className="field grow">
                  <span>Buscar</span>
                  <div className="searchbox">
                    <Search size={17} aria-hidden="true" />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre o código" />
                  </div>
                </label>
                <label className="field">
                  <span>Estado de jornada</span>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                    <option value="all">Todas</option>
                    <option value="open">En curso</option>
                    <option value="closed">Cerradas</option>
                  </select>
                </label>
                <p className="record-count" aria-live="polite">{visible.length.toLocaleString("es-PE")} registros</p>
              </div>
              <section className="panel-card table-card">
                {visible.length === 0 ? (
                  <EmptyState
                    title={rows.length === 0 ? "Todavía no hay registros en esta consulta." : "No hay registros que coincidan."}
                    detail={rows.length === 0 ? "Cuando existan marcaciones, aparecerán aquí." : "Prueba con otro nombre, código o estado."}
                  />
                ) : (
                  <AttendanceTable rows={visible} />
                )}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
