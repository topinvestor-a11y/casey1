import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Sprout, Sun, Moon, ArrowLeftRight, Check, X, ChevronLeft, ChevronRight,
  Users, CalendarDays, Send, Inbox, Info, Search, RotateCcw, Clock3,
  ChevronDown, Leaf, Home, CircleDot, Sparkles, RefreshCw, AlertTriangle,
  ShieldCheck, UserMinus, UserPlus, Lock,
} from "lucide-react";
import { fetchBootstrap, createRequest, respondToRequest, cancelRequest, generateNextWeek, replaceEmployee, setShift, fetchShiftLog } from "./api";

const APP_NAME = "우리 근무표";
const TAG_HUES = ["#3E6B49", "#46527D", "#C68A3D", "#8A5A6B", "#3E7A78", "#7A6B3E", "#5B5B8A"];
const ME_KEY = "wt-me";
const POLL_MS = 30000;

/* ============================== HELPERS ============================== */
function hueFor(id) {
  return TAG_HUES[id % TAG_HUES.length];
}

function buildWeeks(shifts) {
  const dates = Array.from(new Set(shifts.map((s) => s.date))).sort();
  const weeks = [];
  for (let i = 0; i < dates.length; i += 7) {
    const chunk = dates.slice(i, i + 7);
    if (chunk.length === 0) continue;
    const fmt = (d) => {
      const [, m, day] = d.split("-");
      return `${m}.${day}`;
    };
    weeks.push({
      label: `${weeks.length + 1}주차`,
      range: `${fmt(chunk[0])} ~ ${fmt(chunk[chunk.length - 1])}`,
      dates: chunk,
    });
  }
  return weeks;
}

function isWeekend(dow) {
  return dow === "토" || dow === "일";
}

// Look up the weekday label for a date from any employee's shift that day
// (every employee shares the same weekday for a given date).
function dowForDate(date, shifts) {
  const found = shifts.find((s) => s.date === date);
  return found ? found.dow : "";
}

// Same rotation rule the server uses (generateNextWeek.js / admin.js):
// A조 = seats 1-19, B조 = seats 20-36, each
// group advances by one seat per week, wrapping at the end of its group.
const ANCHOR_MONDAY = "2026-09-07";
const GROUP_A_SEATS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const GROUP_B_SEATS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];

function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
function advanceSeat(seat, steps, group) {
  const order = group === "A" ? GROUP_A_SEATS : GROUP_B_SEATS;
  const idx = order.indexOf(seat);
  if (idx === -1) return seat;
  const n = order.length;
  return order[((idx + steps) % n + n) % n];
}
// `employees` carries each person's seat/group as of the anchor week —
// this rotates that forward to whichever week (by its Monday date) is
// actually being displayed, so the on-screen order tracks the real rotation.
function rotatedSeat(e, weekMonday) {
  if (e.seat == null || !e.group) return null;
  if (!weekMonday) return e.seat;
  const weekOffset = Math.round(daysBetween(ANCHOR_MONDAY, weekMonday) / 7);
  return advanceSeat(e.seat, weekOffset, e.group);
}

// A조(1~19번) → B조(20~35번) 순서로, 각 그룹 안에서는 그 주의 회전된 자리
// 번호 순서로. 자리 정보가 없는 직원(퇴사 등)은 맨 뒤로.
function seatSortKey(e, weekMonday) {
  if (e.group === "A") return [0, rotatedSeat(e, weekMonday)];
  if (e.group === "B") return [1, rotatedSeat(e, weekMonday)];
  return [2, e.id];
}
function sortBySeat(list, weekMonday) {
  return [...list].sort((a, b) => {
    const ka = seatSortKey(a, weekMonday);
    const kb = seatSortKey(b, weekMonday);
    return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1] - kb[1];
  });
}

function dateAdd(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Client only needs to know *whether* a next week can be offered — the
// actual rotation math runs server-side in generate-next-week.js.
function planNextWeek(shifts) {
  const dates = Array.from(new Set(shifts.map((s) => s.date))).sort();
  if (dates.length === 0) return null;
  const lastDate = dates[dates.length - 1];
  const nextMonday = dateAdd(lastDate, 1);
  if (dates.includes(nextMonday)) return null;
  const weekDates = Array.from({ length: 7 }, (_, i) => dateAdd(nextMonday, i));
  return { nextMonday, weekDates };
}

function labelForFactory(codeTable) {
  return (code, period) => {
    const entry = codeTable[code];
    if (!entry) return code;
    return period === "주간" ? entry.dayLabel : entry.nightLabel || entry.dayLabel;
  };
}

const CODE_HOURS = {
  "1C": { day: "05:00–15:00", night: "15:00–01:00" },
  "3A": { day: "05:00–15:00", night: "15:00–01:00" },
  "3B": { day: "05:00–15:00", night: "15:00–20:00" },
  N: { day: "06:00–18:00", night: null },
  N1: { day: "06:00–18:00", night: null },
};
function hoursFor(code, period) {
  const h = CODE_HOURS[code];
  if (!h) return null;
  return period === "주간" ? h.day : h.night;
}

/* ============================== PLANT TAG (signature element) ============================== */
function PlantTag({ name, hue, size = "md", active = false, onClick, disabled }) {
  const dims = size === "lg" ? { w: 148, h: 92, fs: 17 } : size === "sm" ? { w: 96, h: 60, fs: 12 } : { w: 118, h: 72, fs: 14 };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="tag-btn"
      style={{ width: dims.w, opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : onClick ? "pointer" : "default" }}
    >
      <div
        className="tag-card"
        style={{
          height: dims.h,
          borderColor: active ? hue : "var(--line)",
          boxShadow: active ? `0 0 0 2px ${hue}` : "0 2px 0 var(--line)",
          background: active ? `${hue}14` : "var(--surface)",
        }}
      >
        <span className="tag-hole" style={{ borderColor: hue }} />
        <div className="tag-text">
          <div style={{ fontSize: dims.fs, fontFamily: "var(--font-display)", color: "var(--ink)", fontWeight: 600, lineHeight: 1.15 }}>
            {name}
          </div>
        </div>
        <span className="tag-string" style={{ background: hue }} />
      </div>
    </button>
  );
}

/* ============================== SHIFT CHIP ============================== */
function ShiftChip({ shift, compact }) {
  if (!shift) return <span className="chip chip-empty">비번</span>;
  const isNight = shift.period === "야간";
  const hrs = hoursFor(shift.code, shift.period);
  const prefix = isNight ? "야" : "주";
  return (
    <span className={`chip ${isNight ? "chip-night" : "chip-day"}`} title={hrs ? `${shift.label} · ${hrs}` : shift.label}>
      {isNight ? <Moon size={11} /> : <Sun size={11} />}
      <span className="chip-code">{prefix}{shift.code}</span>
      {!compact && hrs && <span className="chip-hrs">{hrs}</span>}
    </span>
  );
}

/* ============================== MAIN APP ============================== */
export default function App() {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [me, setMe] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [codeTable, setCodeTable] = useState({});
  const [tab, setTab] = useState("my");
  const [weekIdx, setWeekIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const labelFor = useMemo(() => labelForFactory(codeTable), [codeTable]);
  const weeks = useMemo(() => buildWeeks(shifts), [shifts]);

  const notify = useCallback((msg, tone = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 10000);
  }, []);

  const load = useCallback(async (opts = {}) => {
    try {
      const data = await fetchBootstrap();
      setEmployees(data.employees);
      setShifts(data.shifts);
      setRequests(data.requests);
      setCodeTable(data.codeTable);
      setLoadError(null);
      if (!opts.silent) setReady(true);
    } catch (e) {
      setLoadError(e.message || "데이터를 불러오지 못했어요.");
      if (!opts.silent) setReady(true);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(ME_KEY);
    if (stored) {
      try {
        setMe(JSON.parse(stored));
      } catch {
        localStorage.removeItem(ME_KEY);
      }
    }
    load();
  }, [load]);

  // Light polling so a swap someone else approves shows up without a manual refresh.
  useEffect(() => {
    const id = setInterval(() => load({ silent: true }), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const chooseMe = useCallback((emp) => {
    setMe(emp);
    localStorage.setItem(ME_KEY, JSON.stringify(emp));
  }, []);

  const switchUser = useCallback(() => {
    setMe(null);
    localStorage.removeItem(ME_KEY);
  }, []);

  const nextWeekPlan = useMemo(() => planNextWeek(shifts), [shifts]);

  const handleGenerateNextWeek = useCallback(
    async (pin) => {
      const res = await generateNextWeek(pin);
      await load({ silent: true });
      setWeekIdx((i) => i + 1);
      notify(`${res.weekStart.slice(5)} 주 근무표를 자동 생성했어요.`);
      return res;
    },
    [load, notify]
  );

  const submitRequest = useCallback(
    async ({ myShift, targetEmp, targetShift, memo }) => {
      try {
        await createRequest({
          requesterId: me.id,
          requesterName: me.name,
          targetId: targetEmp.id,
          targetName: targetEmp.name,
          myDate: myShift.date,
          myDow: myShift.dow,
          myCode: myShift.code,
          myPeriod: myShift.period,
          targetDate: targetShift.date,
          targetDow: targetShift.dow,
          targetCode: targetShift.code,
          targetPeriod: targetShift.period,
          memo: memo || "",
        });
        await load({ silent: true });
        notify("교환 요청을 보냈어요.");
      } catch (e) {
        notify(e.message || "요청을 보내지 못했어요.", "warn");
      }
    },
    [me, load, notify]
  );

  const respond = useCallback(
    async (reqId, accept, pin) => {
      const res = await respondToRequest(reqId, accept, pin);
      await load({ silent: true });
      notify(accept ? "근무를 교환했어요." : "요청을 거절했어요.", accept ? "ok" : "warn");
      return res;
    },
    [load, notify]
  );

  const cancel = useCallback(
    async (reqId) => {
      try {
        await cancelRequest(reqId);
        await load({ silent: true });
        notify("요청을 취소했어요.", "warn");
      } catch (e) {
        notify(e.message || "취소하지 못했어요.", "warn");
      }
    },
    [load, notify]
  );

  const handleReplaceEmployee = useCallback(
    async ({ pin, retiringEmpId, newEmployeeName }) => {
      const res = await replaceEmployee({ pin, retiringEmpId, newEmployeeName });
      await load({ silent: true });
      notify(`${res.retired.name}님 자리를 ${res.hired.name}님이 이어받았어요.`);
      return res;
    },
    [load, notify]
  );

  const handleSetShift = useCallback(
    async ({ pin, empId, date, code, period }) => {
      const res = await setShift({ pin, empId, date, code, period });
      return res;
    },
    []
  );

  if (!ready) {
    return (
      <div className="wt-root" style={{ minHeight: 420, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "var(--ink-soft)" }}>
          <Sprout size={26} className="animate-pulse" />
          <span style={{ fontSize: 13 }}>불러오는 중…</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="wt-root" style={{ minHeight: 420, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: "var(--clay)", textAlign: "center" }}>
          <AlertTriangle size={26} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{loadError}</span>
          <button className="btn" onClick={() => load()}>다시 시도</button>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="wt-root" style={{ minHeight: 480, padding: "28px 20px", borderRadius: 16 }}>
        <NameGate employees={employees} weeks={weeks} search={search} setSearch={setSearch} onChoose={chooseMe} />
      </div>
    );
  }

  const myPendingIncoming = requests.filter((r) => r.targetId === me.id && r.status === "대기").length;

  return (
    <div className="wt-root" style={{ minHeight: 480, borderRadius: 16, overflow: "hidden" }}>
      <TopBar me={me} onSwitch={switchUser} pending={myPendingIncoming} />
      <div style={{ padding: "16px 18px 28px" }}>
        <NavTabs tab={tab} setTab={setTab} pending={myPendingIncoming} />
        <div style={{ marginTop: 16 }}>
          {tab === "my" && (
            <MyScheduleView me={me} shifts={shifts} weeks={weeks} weekIdx={weekIdx} setWeekIdx={setWeekIdx} />
          )}
          {tab === "all" && (
            <AllScheduleView
              employees={employees}
              shifts={shifts}
              weeks={weeks}
              weekIdx={weekIdx}
              setWeekIdx={setWeekIdx}
              nextWeekPlan={nextWeekPlan}
              onGenerate={handleGenerateNextWeek}
            />
          )}
          {tab === "swap" && (
            <SwapView
              me={me}
              employees={employees}
              shifts={shifts}
              weeks={weeks}
              requests={requests}
              labelFor={labelFor}
              onSubmit={submitRequest}
              onRespond={respond}
              onCancel={cancel}
            />
          )}
          {tab === "admin" && (
            <AdminView employees={employees} requests={requests} codeTable={codeTable} weeks={weeks} labelFor={labelFor} onReplace={handleReplaceEmployee} onRespond={respond} onSetShift={handleSetShift} onRefresh={() => load({ silent: true })} />
          )}
        </div>
      </div>
      {toast && <div className={`toast ${toast.tone === "warn" ? "toast-warn" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

/* ============================== NAME GATE ============================== */
function NameGate({ employees, weeks, search, setSearch, onChoose }) {
  const latestMonday = weeks?.length ? weeks[weeks.length - 1].dates[0] : null;
  const filtered = sortBySeat(employees.filter((e) => e.active !== false && e.name.includes(search.trim())), latestMonday);
  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 22 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--forest)" }}>
          <Sprout size={22} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, letterSpacing: ".08em" }}>
            {APP_NAME.toUpperCase()}
          </span>
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, margin: "8px 0 4px", color: "var(--ink)" }}>
          내 이름표를 골라주세요
        </h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 13.5, margin: 0 }}>
          이름표를 선택하면 이 기기에서 자동으로 기억해둘게요.
        </p>
      </div>
      <div style={{ position: "relative", marginBottom: 18 }}>
        <Search size={15} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-soft)" }} />
        <input type="text" placeholder="이름 검색" value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 34 }} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 2 }}>
        {filtered.map((e) => (
          <PlantTag key={e.id} name={e.name} hue={hueFor(e.id)} onClick={() => onChoose(e)} />
        ))}
        {filtered.length === 0 && <p style={{ color: "var(--ink-soft)", fontSize: 13, padding: 20 }}>일치하는 이름이 없어요.</p>}
      </div>
    </div>
  );
}

/* ============================== TOP BAR ============================== */
function TopBar({ me, onSwitch, pending }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", background: "var(--forest)", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Leaf size={18} />
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 17 }}>{APP_NAME}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          className="btn btn-ghost"
          onClick={onSwitch}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(255,255,255,.14)", borderColor: "transparent",
            color: "#fff", padding: "5px 10px", borderRadius: 999,
          }}
        >
          <CircleDot size={13} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{me.name}</span>
          {pending > 0 && (
            <span style={{ background: "var(--amber)", color: "#fff", fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "1px 6px" }}>{pending}</span>
          )}
        </button>
        <button className="btn btn-ghost" style={{ color: "#fff", borderColor: "transparent" }} onClick={onSwitch}>
          <Home size={14} /> 홈
        </button>
      </div>
    </div>
  );
}

/* ============================== NAV TABS ============================== */
function NavTabs({ tab, setTab, pending }) {
  const items = [
    { id: "my", label: "내 근무표", icon: CalendarDays },
    { id: "all", label: "전체 근무표", icon: Users },
    { id: "swap", label: "근무 교환", icon: ArrowLeftRight, badge: pending },
    { id: "admin", label: "관리", icon: ShieldCheck },
  ];
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {items.map((it) => (
        <button key={it.id} className={`nav-btn ${tab === it.id ? "active" : ""}`} onClick={() => setTab(it.id)}>
          <it.icon size={15} />
          {it.label}
          {!!it.badge && (
            <span style={{ background: "var(--amber)", color: "#fff", fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "1px 6px" }}>{it.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ============================== WEEK SWITCHER ============================== */
function WeekSwitcher({ weeks, weekIdx, setWeekIdx }) {
  const w = weeks[weekIdx];
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
      <button className="btn btn-ghost" disabled={weekIdx === 0} onClick={() => setWeekIdx((i) => Math.max(0, i - 1))}>
        <ChevronLeft size={16} />
      </button>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16 }}>{w?.label}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-soft)" }}>{w?.range}</div>
      </div>
      <button className="btn btn-ghost" disabled={weekIdx >= weeks.length - 1} onClick={() => setWeekIdx((i) => Math.min(weeks.length - 1, i + 1))}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

/* ============================== MY SCHEDULE ============================== */
function MyScheduleView({ me, shifts, weeks, weekIdx, setWeekIdx }) {
  const week = weeks[weekIdx];
  return (
    <div>
      <WeekSwitcher weeks={weeks} weekIdx={weekIdx} setWeekIdx={setWeekIdx} />
      <div style={{ display: "grid", gap: 8 }}>
        {week?.dates.map((date) => {
          const shift = shifts.find((s) => s.date === date && s.empId === me.id) || null;
          const dow = shift ? shift.dow : dowForDate(date, shifts);
          const weekend = isWeekend(dow);
          return (
            <div key={date} className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: weekend ? "var(--surface-2)" : "var(--surface)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-soft)" }}>{date.slice(5)}</span>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, color: weekend ? "var(--clay)" : "var(--ink)" }}>{dow || "-"}</span>
              </div>
              <ShiftChip shift={shift} />
            </div>
          );
        })}
      </div>
      <Legend />
    </div>
  );
}

/* ============================== ALL SCHEDULE (matrix) ============================== */
function AllScheduleView({ employees, shifts, weeks, weekIdx, setWeekIdx, nextWeekPlan, onGenerate }) {
  const week = weeks[weekIdx];
  const [q, setQ] = useState("");
  const filtered = sortBySeat(employees.filter((e) => e.name.includes(q.trim())), week?.dates[0]);
  const isLastWeek = weekIdx === weeks.length - 1;

  return (
    <div>
      <WeekSwitcher weeks={weeks} weekIdx={weekIdx} setWeekIdx={setWeekIdx} />
      {isLastWeek && <AutoGeneratePanel plan={nextWeekPlan} onGenerate={onGenerate} />}
      <div style={{ position: "relative", marginBottom: 10, maxWidth: 260 }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: 11, color: "var(--ink-soft)" }} />
        <input type="text" placeholder="직원 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 30 }} />
      </div>
      <div className="card" style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={thStyle("left")}>직원</th>
              {week?.dates.map((d) => {
                const dow = shifts.find((s) => s.date === d)?.dow || "";
                return (
                  <th key={d} style={{ ...thStyle("center"), color: isWeekend(dow) ? "var(--clay)" : "var(--ink-soft)" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{d.slice(5)}</div>
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>{dow}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((emp, i) => (
              <tr key={emp.id} style={{ background: i % 2 ? "var(--surface-2)" : "transparent" }}>
                <td style={{ ...tdStyle, fontWeight: 600, whiteSpace: "nowrap", position: "sticky", left: 0, background: i % 2 ? "var(--surface-2)" : "var(--surface)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: hueFor(emp.id), display: "inline-block" }} />
                    {emp.name}
                    {emp.active === false && (
                      <span style={{ fontSize: 10, color: "var(--ink-soft)", fontWeight: 500, border: "1px solid var(--line)", borderRadius: 4, padding: "0 4px" }}>휴직</span>
                    )}
                  </span>
                </td>
                {week?.dates.map((d) => {
                  const shift = shifts.find((s) => s.date === d && s.empId === emp.id) || null;
                  return (
                    <td key={d} style={{ ...tdStyle, textAlign: "center" }}>
                      <ShiftChip shift={shift} compact />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Legend />
    </div>
  );
}
const thStyle = (align) => ({ textAlign: align, padding: "8px 10px", borderBottom: "1.5px solid var(--line)", fontWeight: 600, color: "var(--ink-soft)", fontSize: 11.5 });
const tdStyle = { padding: "7px 10px", borderBottom: "1px solid var(--line)" };

/* ============================== AUTO-GENERATE PANEL ============================== */
function AutoGeneratePanel({ plan, onGenerate }) {
  const [pin, setPin] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!plan) return null;
  const rangeLabel = `${plan.weekDates[0].slice(5)} ~ ${plan.weekDates[6].slice(5)}`;

  const handleClick = async () => {
    if (pin.trim().length === 0) {
      setError("비밀번호를 입력해주세요.");
      return;
    }
    if (!confirming) {
      setConfirming(true);
      setError("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onGenerate(pin);
      setPin("");
      setConfirming(false);
    } catch (e) {
      setError(e.message || "생성하지 못했어요.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", marginBottom: 12, flexWrap: "wrap", background: "linear-gradient(0deg, var(--surface), #F8F4E6)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Sparkles size={16} color="var(--amber)" />
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{rangeLabel} 근무표가 아직 없어요</div>
          {error && <div style={{ fontSize: 12, color: "var(--clay)", marginTop: 4 }}>{error}</div>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          placeholder="관리자 비밀번호"
          value={pin}
          onChange={(e) => { setPin(e.target.value); setConfirming(false); }}
          style={{ width: 130 }}
        />
        {confirming && (
          <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>취소</button>
        )}
        <button className="btn btn-primary" onClick={handleClick} disabled={busy}>
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
          {confirming ? "정말 생성할까요?" : "다음 주 자동 생성"}
        </button>
      </div>
    </div>
  );
}

/* ============================== LEGEND ============================== */
function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginTop: 14, padding: "10px 14px" }}>
      <button className="btn btn-ghost" style={{ padding: 0 }} onClick={() => setOpen((o) => !o)}>
        <Info size={14} /> 근무 코드 안내 <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--ink-soft)", display: "grid", gap: 6 }}>
          <div><ShiftChip shift={{ code: "1C", period: "주간", label: "주간1C" }} compact /> 1C · 3A · 3B <span style={{ fontFamily: "var(--font-mono)" }}>주간 05:00–15:00</span></div>
          <div><ShiftChip shift={{ code: "1C", period: "야간", label: "야간1C" }} compact /> 1C · 3A <span style={{ fontFamily: "var(--font-mono)" }}>야간 15:00–01:00</span> · 3B <span style={{ fontFamily: "var(--font-mono)" }}>야간 15:00–20:00</span></div>
          <div><ShiftChip shift={{ code: "N", period: "주간", label: "주간N" }} compact /> N · N1 <span style={{ fontFamily: "var(--font-mono)" }}>06:00–18:00</span> — 평일 주간 전용, 토·일요일은 배정하지 않아요.</div>
          <div style={{ color: "var(--ink-soft)" }}>표시가 없는 코드는 회사 근무 규정을 따라요.</div>
          <div style={{ color: "var(--ink-soft)" }}>근무 자리는 매주 A조·B조 그룹 안에서 한 칸씩 자동으로 순환돼요.</div>
        </div>
      )}
    </div>
  );
}

/* ============================== SWAP VIEW ============================== */
function SwapView({ me, employees, shifts, weeks, requests, labelFor, onSubmit, onRespond, onCancel }) {
  const [sub, setSub] = useState("new");
  const incoming = requests.filter((r) => r.targetId === me.id);
  const outgoing = requests.filter((r) => r.requesterId === me.id);
  const incomingPending = incoming.filter((r) => r.status === "대기").length;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <SubTab id="new" sub={sub} setSub={setSub} icon={ArrowLeftRight} label="새 요청" />
        <SubTab id="received" sub={sub} setSub={setSub} icon={Inbox} label="받은 요청" badge={incomingPending} />
        <SubTab id="sent" sub={sub} setSub={setSub} icon={Send} label="보낸 요청" />
      </div>
      {sub === "new" && <NewSwapForm me={me} employees={employees} shifts={shifts} weeks={weeks} onSubmit={onSubmit} />}
      {sub === "received" && <RequestList list={incoming} viewer="target" labelFor={labelFor} onRespond={onRespond} />}
      {sub === "sent" && <RequestList list={outgoing} viewer="requester" labelFor={labelFor} onCancel={onCancel} />}
    </div>
  );
}

function SubTab({ id, sub, setSub, icon: Icon, label, badge }) {
  return (
    <button className={`nav-btn ${sub === id ? "active" : ""}`} onClick={() => setSub(id)}>
      <Icon size={14} /> {label}
      {!!badge && <span style={{ background: "var(--amber)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "1px 6px" }}>{badge}</span>}
    </button>
  );
}

function NewSwapForm({ me, employees, shifts, weeks, onSubmit }) {
  const visibleWeeks = weeks.slice(-3);
  const visibleDates = visibleWeeks.flatMap((w) => w.dates);
  const rangeLabel = visibleWeeks.length
    ? `${visibleWeeks[0].dates[0].slice(5)} ~ ${visibleWeeks[visibleWeeks.length - 1].dates[6].slice(5)}`
    : "";

  const [myDate, setMyDate] = useState("");
  const [targetId, setTargetId] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const targetEmp = employees.find((e) => String(e.id) === String(targetId));

  // Every date in range is selectable on both sides — either the actual
  // shift, or (if there's none) that person's day off.
  const myDateOptions = visibleDates.map((d) => {
    const shift = shifts.find((s) => s.date === d && s.empId === me.id) || null;
    const dow = shift ? shift.dow : dowForDate(d, shifts);
    return { date: d, dow, shift };
  });
  const targetDateOptions = visibleDates.map((d) => {
    const shift = targetEmp ? shifts.find((s) => s.date === d && s.empId === targetEmp.id) : null;
    const dow = shift ? shift.dow : dowForDate(d, shifts);
    return { date: d, dow, shift };
  });

  const myShift = myDateOptions.find((o) => o.date === myDate)?.shift || null;
  const myDow = myDateOptions.find((o) => o.date === myDate)?.dow || "";
  const targetShift = targetEmp ? shifts.find((s) => s.date === targetDate && s.empId === targetEmp.id) || null : null;
  const targetDow = targetDateOptions.find((o) => o.date === targetDate)?.dow || "";

  // Both sides being a day off would trade nothing.
  const canSubmit = myDate && targetEmp && targetDate && (myShift || targetShift) && targetEmp.id !== me.id && memo.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const myPayload = myShift || { date: myDate, dow: myDow, code: null, period: null };
    const targetPayload = targetShift || { date: targetDate, dow: targetDow, code: null, period: null };
    await onSubmit({ myShift: myPayload, targetEmp, targetShift: targetPayload, memo });
    setSubmitting(false);
    setMyDate("");
    setTargetId("");
    setTargetDate("");
    setMemo("");
  };

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 14, maxWidth: 560 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16 }}>날짜 선택 범위</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-soft)" }}>{rangeLabel}</div>
      </div>

      <Field label="1. 내가 내놓을 근무 (비번 포함)">
        <select value={myDate} onChange={(e) => setMyDate(e.target.value)}>
          <option value="">날짜 선택</option>
          {myDateOptions.map((o) => (
            <option key={o.date} value={o.date}>
              {o.date.slice(5)} ({o.dow}) · {o.shift ? o.shift.label : "비번"}
            </option>
          ))}
        </select>
      </Field>

      <Field label="2. 교환 상대">
        <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setTargetDate(""); }}>
          <option value="">직원 선택</option>
          {sortBySeat(employees.filter((e) => e.id !== me.id && e.active !== false), visibleWeeks[visibleWeeks.length - 1]?.dates[0]).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </Field>

      <Field label="3. 받고 싶은 상대의 근무 (비번 포함)">
        <select value={targetDate} onChange={(e) => setTargetDate(e.target.value)} disabled={!targetEmp}>
          <option value="">날짜 선택</option>
          {targetDateOptions.map((o) => (
            <option key={o.date} value={o.date}>
              {o.date.slice(5)} ({o.dow}) · {o.shift ? o.shift.label : "비번"}
            </option>
          ))}
        </select>
      </Field>

      <Field label="사유 (필수)">
        <textarea rows={2} placeholder="교환 사유를 남겨주세요" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </Field>

      {myDate && targetDate && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "10px 0" }}>
          <ShiftChip shift={myShift} />
          <ArrowLeftRight size={15} color="var(--ink-soft)" />
          <ShiftChip shift={targetShift} />
        </div>
      )}

      <button className="btn btn-primary" disabled={!canSubmit} onClick={handleSubmit} style={{ justifyContent: "center" }}>
        <Send size={14} /> {submitting ? "보내는 중…" : "교환 요청 보내기"}
      </button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>{label}</span>
      {children}
    </label>
  );
}
function Hint({ children }) {
  return <span style={{ fontSize: 12, color: "var(--amber)" }}>{children}</span>;
}

function RequestList({ list, viewer, labelFor, onRespond, onCancel }) {
  const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (sorted.length === 0) {
    return (
      <div className="card" style={{ padding: 28, textAlign: "center", color: "var(--ink-soft)" }}>
        <Inbox size={22} style={{ marginBottom: 8, opacity: 0.5 }} />
        <div style={{ fontSize: 13.5 }}>{viewer === "target" ? "받은 요청이 없어요." : "보낸 요청이 없어요."}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sorted.map((r) => (
        <div key={r.id} className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13.5 }}>
              <span style={{ fontWeight: 700 }}>{r.requesterName}</span>
              <span style={{ color: "var(--ink-soft)" }}> → </span>
              <span style={{ fontWeight: 700 }}>{r.targetName}</span>
            </div>
            <StatusStamp status={r.status} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <MiniShift date={r.myDate} dow={r.myDow} code={r.myCode} period={r.myPeriod} owner={r.requesterName} labelFor={labelFor} />
            <ArrowLeftRight size={14} color="var(--ink-soft)" />
            <MiniShift date={r.targetDate} dow={r.targetDow} code={r.targetCode} period={r.targetPeriod} owner={r.targetName} labelFor={labelFor} />
          </div>
          {r.memo && <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>"{r.memo}"</p>}
          {viewer === "target" && r.status === "대기" && (
            <AcceptRejectControls request={r} onRespond={onRespond} />
          )}
          {viewer === "requester" && r.status === "대기" && (
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-ghost" onClick={() => onCancel(r.id)}><RotateCcw size={13} /> 요청 취소</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AcceptRejectControls({ request, onRespond }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleAccept = async () => {
    if (pin.trim().length === 0) {
      setError("수락하려면 관리자 비밀번호가 필요해요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onRespond(request.id, true, pin);
    } catch (e) {
      setError(e.message || "처리하지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    setError("");
    try {
      await onRespond(request.id, false);
    } catch (e) {
      setError(e.message || "처리하지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="관리자 비밀번호 (수락 시 필요)"
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError(""); }}
          style={{ maxWidth: 200 }}
          disabled={busy}
        />
        <button className="btn btn-primary" onClick={handleAccept} disabled={busy}><Check size={14} /> 수락</button>
        <button className="btn btn-danger" onClick={handleReject} disabled={busy}><X size={14} /> 거절</button>
      </div>
      {error && <p style={{ color: "var(--clay)", fontSize: 12, marginTop: 6 }}>{error}</p>}
    </div>
  );
}

function MiniShift({ date, dow, code, period, owner, labelFor }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>{owner}</span>
      <ShiftChip shift={code ? { code, period, label: labelFor(code, period) } : null} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-soft)" }}>{date?.slice(5)} ({dow})</span>
    </div>
  );
}

function StatusStamp({ status }) {
  const map = {
    "대기": { cls: "stamp-wait", icon: Clock3, text: "대기중" },
    "완료": { cls: "stamp-ok", icon: Check, text: "교환완료" },
    "거절": { cls: "stamp-no", icon: X, text: "거절됨" },
    "취소": { cls: "stamp-no", icon: RotateCcw, text: "취소됨" },
  };
  const m = map[status] || map["대기"];
  return (
    <span className={`stamp ${m.cls}`}>
      <m.icon size={11} /> {m.text}
    </span>
  );
}

/* ============================== ADMIN VIEW ============================== */
function AdminView({ employees, requests, codeTable, weeks, labelFor, onReplace, onRespond, onSetShift, onRefresh }) {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [pinError, setPinError] = useState("");

  const latestMonday = weeks?.length ? weeks[weeks.length - 1].dates[0] : null;
  const activeEmployees = sortBySeat(employees.filter((e) => e.active !== false), latestMonday);
  const pendingRequests = requests.filter((r) => r.status === "대기").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const [shiftLog, setShiftLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState("");

  const loadLog = useCallback(async (currentPin) => {
    setLogLoading(true);
    setLogError("");
    try {
      const rows = await fetchShiftLog(currentPin);
      setShiftLog(rows);
    } catch (e) {
      setLogError(e.message || "이력을 불러오지 못했어요.");
    } finally {
      setLogLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await onRefresh();
    await loadLog(pin);
  }, [onRefresh, loadLog, pin]);

  const [retiringId, setRetiringId] = useState("");
  const [newName, setNewName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [lastResult, setLastResult] = useState(null);

  const retiring = employees.find((e) => String(e.id) === String(retiringId));
  const canSubmit = retiring && newName.trim().length > 0 && !submitting;

  const handleUnlock = () => {
    if (pin.trim().length === 0) return;
    setUnlocked(true);
    setPinError("");
    loadLog(pin);
  };

  const handleSubmit = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      const res = await onReplace({ pin, retiringEmpId: retiring.id, newEmployeeName: newName.trim() });
      setLastResult(res);
      setRetiringId("");
      setNewName("");
      setConfirming(false);
    } catch (e) {
      if (e.status === 403) {
        setUnlocked(false);
        setPinError("비밀번호가 올바르지 않아요. 다시 입력해주세요.");
      } else {
        setFormError(e.message || "처리하지 못했어요.");
      }
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!unlocked) {
    return (
      <div className="card" style={{ padding: 24, maxWidth: 420, margin: "0 auto", textAlign: "center" }}>
        <Lock size={22} color="var(--ink-soft)" style={{ marginBottom: 10 }} />
        <div style={{ fontWeight: 600, marginBottom: 4 }}>관리자 비밀번호</div>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 0, marginBottom: 14 }}>
          교환 요청 승인, 퇴사·입사 자리 교체는 근무표에 영향을 주는 작업이라 비밀번호가 필요해요.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            placeholder="비밀번호"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
          />
          <button className="btn btn-primary" onClick={handleUnlock}>확인</button>
        </div>
        {pinError && <p style={{ color: "var(--clay)", fontSize: 12.5, marginTop: 10 }}>{pinError}</p>}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 20, maxWidth: 560, margin: "0 auto" }}>
      <PendingRequestsQueue requests={pendingRequests} labelFor={labelFor} pin={pin} onRespond={onRespond} />

      <div className="card" style={{ padding: 20, display: "grid", gap: 16 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>자리 교체 (퇴사 → 입사)</div>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: 0 }}>
          퇴사하는 직원의 순환 자리를 새로 입사하는 직원이 그대로 이어받아요. 지난 근무 기록은 그대로 남고,
          다음 자동 생성부터 새 직원 이름으로 반영돼요.
        </p>
      </div>

      <Field label="1. 퇴사하는 직원">
        <select value={retiringId} onChange={(e) => { setRetiringId(e.target.value); setConfirming(false); }}>
          <option value="">직원 선택</option>
          {activeEmployees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.group === "A" ? "A조" : "B조"} {e.seat}번)
            </option>
          ))}
        </select>
      </Field>

      <Field label="2. 새로 입사하는 직원 이름">
        <input
          type="text"
          placeholder="이름 입력"
          value={newName}
          onChange={(e) => { setNewName(e.target.value); setConfirming(false); }}
        />
      </Field>

      {retiring && newName.trim() && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "6px 0", fontSize: 13.5 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--clay)" }}>
            <UserMinus size={14} /> {retiring.name}
          </span>
          <ArrowLeftRight size={14} color="var(--ink-soft)" />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--forest-dark)" }}>
            <UserPlus size={14} /> {newName.trim()}
          </span>
        </div>
      )}

      {formError && <p style={{ color: "var(--clay)", fontSize: 12.5, margin: 0 }}>{formError}</p>}

      <div style={{ display: "flex", gap: 8 }}>
        {confirming && (
          <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={submitting}>취소</button>
        )}
        <button className="btn btn-primary" disabled={!canSubmit} onClick={handleSubmit} style={{ flex: 1, justifyContent: "center" }}>
          {submitting ? "처리 중…" : confirming ? "정말 진행할까요? 다시 클릭" : "자리 교체하기"}
        </button>
      </div>

      {lastResult && (
        <div className="card" style={{ padding: 10, fontSize: 12.5, color: "var(--ink-soft)", background: "var(--surface-2)" }}>
          {lastResult.retired.name}님 → {lastResult.hired.name}님으로 교체 완료 ({lastResult.hired.group === "A" ? "A조" : "B조"} {lastResult.hired.seat}번)
        </div>
      )}
      </div>

      <ManualShiftEditor
        employees={employees}
        codeTable={codeTable}
        weekMonday={latestMonday}
        labelFor={labelFor}
        pin={pin}
        onSetShift={onSetShift}
        onRefresh={refreshAll}
      />

      <ShiftEditLog log={shiftLog} loading={logLoading} error={logError} onRefresh={() => loadLog(pin)} />
    </div>
  );
}

function ShiftEditLog({ log, loading, error, onRefresh }) {
  return (
    <div className="card" style={{ padding: 20, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>근무 직접 수정 이력</div>
          <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: 0 }}>
            비번·특정 코드 변경 기록이에요 (최근 순). 근무 교환은 여기 안 나와요.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>

      {error && <p style={{ color: "var(--clay)", fontSize: 12.5, margin: 0 }}>{error}</p>}

      {!loading && log.length === 0 && !error && (
        <div style={{ padding: "12px 0", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
          아직 수정 이력이 없어요.
        </div>
      )}

      {log.length > 0 && (
        <div style={{ display: "grid", gap: 8, maxHeight: 360, overflowY: "auto" }}>
          {log.map((r) => (
            <div key={r.id} className="card" style={{ padding: 10, background: "var(--surface-2)", fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                <span><strong>{r.empName}</strong> · {r.date?.slice(5)} ({r.dow})</span>
                <span style={{ color: "var(--ink-soft)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {r.createdAt ? new Date(r.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <span style={{ color: "var(--ink-soft)" }}>{r.oldLabel || "비번"}</span>
                <ArrowLeftRight size={12} color="var(--ink-soft)" />
                <span style={{ fontWeight: 600 }}>{r.newLabel || "비번"}</span>
              </div>
              {r.reason && <div style={{ color: "var(--ink-soft)", marginTop: 4 }}>{r.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ManualShiftEditor({ employees, codeTable, weekMonday, labelFor, pin, onSetShift, onRefresh }) {
  const activeEmployees = sortBySeat(employees.filter((e) => e.active !== false), weekMonday);
  const codeOptions = Object.keys(codeTable || {}).filter((c) => c !== "비번").sort();

  const [empId, setEmpId] = useState("");
  const [mode, setMode] = useState("leave"); // leave | code | clear
  const [substituteId, setSubstituteId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [code, setCode] = useState("");
  const [period, setPeriod] = useState("주간");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const selectedEmp = employees.find((e) => String(e.id) === String(empId));

  function datesInRange(start, end) {
    const out = [];
    const [sy, sm, sd] = start.split("-").map(Number);
    const [ey, em, ed] = end.split("-").map(Number);
    let cur = new Date(Date.UTC(sy, sm - 1, sd));
    const last = new Date(Date.UTC(ey, em - 1, ed));
    while (cur <= last) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  const canSubmit = empId && startDate && (mode !== "code" || code) && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const end = endDate || startDate;
    const dates = datesInRange(startDate, end);
    if (dates.length === 0 || dates.length > 60) {
      setError("날짜 범위가 올바르지 않아요 (최대 60일).");
      setConfirming(false);
      return;
    }

    setSubmitting(true);
    setError("");
    setResult("");
    let okCount = 0;
    const failed = [];
    const freedNames = new Set();
    const substituteNotes = [];
    for (const d of dates) {
      try {
        let res;
        if (mode === "leave") {
          res = await onSetShift({
            pin, empId, date: d, code: "비번", period: "주간",
            substituteEmpId: substituteId || undefined,
          });
          if (res?.substitute) {
            substituteNotes.push(`${d.slice(5)} ${res.substitute.name}님이 ${res.substitute.label} 대신 근무`);
          }
        } else if (mode === "clear") {
          res = await onSetShift({ pin, empId, date: d, code: null });
        } else {
          res = await onSetShift({ pin, empId, date: d, code, period });
        }
        (res?.freed || []).forEach((n) => freedNames.add(n));
        okCount += 1;
      } catch (e) {
        failed.push(`${d.slice(5)} (${e.message || "실패"})`);
      }
    }
    await onRefresh();
    setSubmitting(false);
    setConfirming(false);
    const freedNote = freedNames.size > 0 ? ` (${[...freedNames].join(", ")}님은 해당 근무가 비번으로 바뀌었어요)` : "";
    const subNote = substituteNotes.length > 0 ? ` / ${substituteNotes.join(", ")}` : "";
    if (failed.length === 0) {
      setResult(`${selectedEmp?.name}님 ${okCount}일 처리 완료했어요.${freedNote}${subNote}`);
    } else {
      setResult(`${okCount}일 성공, ${failed.length}일 실패: ${failed.join(", ")}${freedNote}${subNote}`);
    }
  };

  return (
    <div className="card" style={{ padding: 20, display: "grid", gap: 16 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>근무 직접 수정</div>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: 0 }}>
          휴가·장기 요양처럼 순환 규칙과 상관없이 근무를 직접 바꿔야 할 때 사용해요. 기간을 선택하면 그 기간 전체에 적용돼요.
        </p>
      </div>

      <Field label="1. 대상 직원">
        <select value={empId} onChange={(e) => { setEmpId(e.target.value); setConfirming(false); }}>
          <option value="">직원 선택</option>
          {activeEmployees.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </Field>

      <Field label="2. 작업 종류">
        <select value={mode} onChange={(e) => { setMode(e.target.value); setConfirming(false); }}>
          <option value="leave">비번 처리 (대체 근무자 지정 가능)</option>
          <option value="code">특정 근무 코드로 설정</option>
          <option value="clear">근무 기록 삭제 (대체자 없음)</option>
        </select>
      </Field>

      {mode === "leave" && (
        <Field label="대체 근무자 (선택, 원래 근무를 이어받아요)">
          <select value={substituteId} onChange={(e) => { setSubstituteId(e.target.value); setConfirming(false); }}>
            <option value="">지정 안 함</option>
            {sortBySeat(employees.filter((e) => e.active !== false && String(e.id) !== String(empId)), weekMonday).map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </Field>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <Field label="3. 시작일">
          <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setConfirming(false); }} />
        </Field>
        <Field label="종료일 (하루면 비워두세요)">
          <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setConfirming(false); }} />
        </Field>
      </div>

      {mode === "code" && (
        <div style={{ display: "flex", gap: 10 }}>
          <Field label="근무 코드">
            <select value={code} onChange={(e) => { setCode(e.target.value); setConfirming(false); }}>
              <option value="">코드 선택</option>
              {codeOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="주간/야간">
            <select value={period} onChange={(e) => { setPeriod(e.target.value); setConfirming(false); }}>
              <option value="주간">주간</option>
              <option value="야간">야간</option>
            </select>
          </Field>
        </div>
      )}

      {error && <p style={{ color: "var(--clay)", fontSize: 12.5, margin: 0 }}>{error}</p>}
      {result && <p style={{ color: "var(--forest-dark)", fontSize: 12.5, margin: 0 }}>{result}</p>}

      <div style={{ display: "flex", gap: 8 }}>
        {confirming && (
          <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={submitting}>취소</button>
        )}
        <button className="btn btn-primary" disabled={!canSubmit} onClick={handleSubmit} style={{ flex: 1, justifyContent: "center" }}>
          {submitting ? "처리 중…" : confirming ? "정말 적용할까요? 다시 클릭" : "적용하기"}
        </button>
      </div>
    </div>
  );
}


function PendingRequestsQueue({ requests, labelFor, pin, onRespond }) {
  const [busyId, setBusyId] = useState(null);
  const [errorById, setErrorById] = useState({});

  const handle = async (reqId, accept) => {
    setBusyId(reqId);
    setErrorById((prev) => ({ ...prev, [reqId]: "" }));
    try {
      await onRespond(reqId, accept, accept ? pin : undefined);
    } catch (e) {
      setErrorById((prev) => ({ ...prev, [reqId]: e.message || "처리하지 못했어요." }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card" style={{ padding: 20, display: "grid", gap: 14 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>대기 중인 교환 요청 ({requests.length})</div>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: 0 }}>
          직원 이름을 하나씩 눌러보지 않아도, 여기서 전체 요청을 한 번에 확인하고 처리할 수 있어요.
        </p>
      </div>

      {requests.length === 0 && (
        <div style={{ padding: "16px 0", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
          <Inbox size={20} style={{ marginBottom: 6, opacity: 0.5 }} />
          <div>대기 중인 요청이 없어요.</div>
        </div>
      )}

      {requests.map((r) => (
        <div key={r.id} className="card" style={{ padding: 14, background: "var(--surface-2)" }}>
          <div style={{ fontSize: 13.5 }}>
            <span style={{ fontWeight: 700 }}>{r.requesterName}</span>
            <span style={{ color: "var(--ink-soft)" }}> → </span>
            <span style={{ fontWeight: 700 }}>{r.targetName}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <MiniShift date={r.myDate} dow={r.myDow} code={r.myCode} period={r.myPeriod} owner={r.requesterName} labelFor={labelFor} />
            <ArrowLeftRight size={14} color="var(--ink-soft)" />
            <MiniShift date={r.targetDate} dow={r.targetDow} code={r.targetCode} period={r.targetPeriod} owner={r.targetName} labelFor={labelFor} />
          </div>
          {r.memo && <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>"{r.memo}"</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => handle(r.id, true)} disabled={busyId === r.id}>
              <Check size={14} /> 수락
            </button>
            <button className="btn btn-danger" onClick={() => handle(r.id, false)} disabled={busyId === r.id}>
              <X size={14} /> 거절
            </button>
          </div>
          {errorById[r.id] && <p style={{ color: "var(--clay)", fontSize: 12, marginTop: 6 }}>{errorById[r.id]}</p>}
        </div>
      ))}
    </div>
  );
}
