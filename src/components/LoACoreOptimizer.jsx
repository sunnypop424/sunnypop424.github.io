// src/components/LoACoreOptimizer.jsx
import React, { useEffect, useState, useRef, useLayoutEffect } from "react";
import { createPortal, flushSync } from "react-dom";
import { Plus, Trash2, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import KakaoAdfit from "./KakaoAdfit";
import './LoACoreOptimizer.css';

// 최적화 순수 로직/상수 import (UI에서 쓰는 상수/헬퍼만)
import {
  CORE_SUPPLY,
  CORE_THRESHOLDS,
  CORE_LABEL,
  GRADES,
  OPTION_LABELS,
  OPTIONS,
  DEFAULT_WEIGHTS,
  DEALER_WEIGHTS,
  ROLE_KEYS,
  sanitizeWeights,
  scoreGemForRole,
  thresholdsHit,
  scoreCombo,
} from '../lib/optimizerCore.js';

/* --------------------------------------------------------------------------
 * [타입 설명 - 코드 동작과 무관한 개발자 참고 주석]
 *  - Role: "dealer"(딜러) | "support"(서폿)
 *  - OptionKey: 각 젬 옵션 키 ("atk","add","boss","brand","allyDmg","allyAtk")
 *  - CoreGrade: 코어 등급 ("HERO","LEGEND","RELIC","ANCIENT")
 *  - Gem/CoreDef/Weights/ComboInfo: 데이터 모델
 * -------------------------------------------------------------------------- */

/* 도메인 외 UI 전용 상수 */
const CORE_NAME_ITEMS = [
  { value: "해 코어", label: "해 코어" },
  { value: "달 코어", label: "달 코어" },
  { value: "별 코어", label: "별 코어" },
];
const CATEGORY_LABEL = { order: "질서", chaos: "혼돈" };
const LS_KEY = "LoA-CoreOptimizer-v2";

/* =============================== 유틸/헬퍼 (UI) =============================== */
const CORE_ORDER = ["해 코어", "달 코어", "별 코어"];
function nextAvailableCoreName(existingNames) {
  for (const n of CORE_ORDER) if (!existingNames.has(n)) return n;
  return null;
}
const uid = () => Math.random().toString(36).slice(2, 9);

// 역할 선택 시 반대 역할 키 가중치를 0으로 마스킹
function maskWeightsForRole(prev, role) {
  const next = { ...prev };
  const zeroSet = role === "dealer" ? ROLE_KEYS.support : ROLE_KEYS.dealer;
  zeroSet.forEach((k) => { next[k] = 0; });
  const oneSet = ROLE_KEYS[role];
  oneSet.forEach((k) => { next[k] = 1; });
  return next;
}
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("loadFromStorage fail", e);
    return null;
  }
}
function saveToStorage(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("saveToStorage fail", e);
  }
}

/* =============================== Portal-aware Draggable =============================== */
const dragPortal = typeof document !== "undefined" ? document.body : null;
function PortalAwareDraggable({ draggableId, index, children }) {
  return (
    <Draggable draggableId={draggableId} index={index}>
      {(provided, snapshot) => {
        const rendered =
          typeof children === "function" ? children(provided, snapshot) : children;
        return snapshot.isDragging && dragPortal
          ? createPortal(rendered, dragPortal)
          : rendered;
      }}
    </Draggable>
  );
}

/* =============================== 공통 UI 훅/컴포넌트 =============================== */
function useOnClickOutside(refs, handler) {
  const refsArray = React.useMemo(
    () => (Array.isArray(refs) ? refs : [refs]),
    [refs]
  );
  const handlerRef = React.useRef(handler);
  React.useEffect(() => { handlerRef.current = handler; }, [handler]);
  React.useEffect(() => {
    const listener = (e) => {
      if (refsArray.some(r => r?.current && r.current.contains(e.target))) return;
      handlerRef.current?.(e);
    };
    document.addEventListener('click', listener, true);
    return () => document.removeEventListener('click', listener, true);
  }, [refsArray]);
}
function Dropdown({ value, items, onChange, placeholder, className }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const menuPos = useRef({ top: 0, left: 0, width: 0 });
  const [, forceTick] = useState(0);
  useEffect(() => {
    const h = () => setOpen(false);
    window.addEventListener('close-all-dropdowns', h);
    return () => window.removeEventListener('close-all-dropdowns', h);
  }, []);
  useOnClickOutside([btnRef, menuRef], () => setOpen(false));
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    menuPos.current = { top: rect.bottom + 4, left: rect.left, width: rect.width };
    forceTick(v => v + 1);
    const onScroll = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      menuPos.current = { top: r.bottom + 4, left: r.left, width: r.width };
      forceTick(v => v + 1);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);
  const selected = items.find((i) => i.value === value);
  const menu = open ? (
    <AnimatePresence>
      <motion.ul
        ref={menuRef}
        key="menu"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.12 }}
        style={{ position: "fixed", top: menuPos.current.top, left: menuPos.current.left, width: menuPos.current.width, zIndex: 9999 }}
        className="rounded-xl border bg-white shadow-lg overflow-auto max-h-60"
      >
        {items.map((it) => (
          <li key={String(it.value)}>
            <button
              type="button"
              onClick={() => {
                if (it.disabled) return;
                onChange(it.value);
                setOpen(false);
              }}
              aria-disabled={it.disabled ? true : undefined}
              className={`w-full text-left px-3 py-2 text-sm ${it.disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-50"} ${it.value === value ? "bg-gray-100" : ""}`}
            >
              <span className="block truncate">{it.label}</span>
            </button>
          </li>
        ))}
      </motion.ul>
    </AnimatePresence>
  ) : null;
  return (
    <div ref={btnRef} className={`relative min-w-0 ${className || ""}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="min-w-0 h-10 w-full inline-flex items-center justify-between rounded-xl border px-3 bg-white hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50"
      >
        <span className="truncate text-sm">{selected ? selected.label : placeholder || "선택"}</span>
        <span className="text-gray-500 text-sm select-none">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      {open && createPortal(menu, document.body)}
    </div>
  );
}
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = (msg) => {
    const id = uid();
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2600);
  };
  const remove = (id) => setToasts(t => t.filter(x => x.id !== id));
  return { toasts, push, remove };
}
function ToastStack({ toasts, onClose }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none px-4">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div key={t.id} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ type: 'spring', stiffness: 380, damping: 28 }} className="pointer-events-auto overflow-hidden rounded-2xl border shadow-lg bg-amber-50/95 border-amber-200 text-amber-900 backdrop-blur px-4 py-3 flex items-center gap-3 min-w-[320px] max-w-[90vw]">
            <div className="text-sm flex-1">{t.msg}</div>
            <button className="text-sm font-medium text-amber-900/80 hover:text-amber-900 self-center" onClick={() => onClose(t.id)} aria-label="닫기">닫기</button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
function NumberInput({
  value, onChange, min, max, step = 1, allowFloat = false, zeroOnBlur = true, className = "", inputProps = {},
}) {
  const toStr = (v) => (v === null || v === undefined ? "" : String(v));
  const [inner, setInner] = React.useState(toStr(value));
  React.useEffect(() => { setInner(toStr(value)); }, [value]);
  const clamp = (n) => {
    let x = n;
    if (min != null && x < min) x = min;
    if (max != null && x > max) x = max;
    return x;
  };
  const normalizeOnBlur = (s) => {
    if (s === "") return zeroOnBlur ? (min ?? 0) : null;
    let n = Number(s);
    if (!Number.isFinite(n)) return zeroOnBlur ? (min ?? 0) : null;
    n = allowFloat ? n : Math.trunc(n);
    return clamp(n);
  };
  const handleWheel = (e) => e.currentTarget.blur();
  return (
    <input
      type="number"
      inputMode={allowFloat ? "decimal" : "numeric"}
      step={step}
      min={min}
      max={max}
      value={inner}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") {
          setInner("");
          onChange?.(null);
          return;
        }
        setInner(v);
        const num = Number(v);
        if (Number.isFinite(num)) {
          onChange?.(allowFloat ? num : Math.trunc(num));
        } else {
          onChange?.(null);
        }
      }}
      onBlur={() => {
        const n = normalizeOnBlur(inner);
        setInner(n == null ? "" : String(n));
        onChange?.(n);
      }}
      onWheel={handleWheel}
      className={className}
      {...inputProps}
    />
  );
}

/* =============================== 메인 앱 =============================== */
export default function LoACoreOptimizer() {
  useEffect(() => { document.title = "로아 아크그리드 젬 장착 헬퍼"; }, []);

  // 현재 카테고리
  const [category, setCategory] = useState/** @type {Category} */(
    () => (loadFromStorage()?.category ?? "order")
  );
  // 카테고리별 상태
  const [coresByCat, setCoresByCat] = useState(() => {
    const loaded = loadFromStorage();
    return loaded?.coresByCat ?? { order: [], chaos: [] };
  });
  const [gemsByCat, setGemsByCat] = useState(() => {
    const loaded = loadFromStorage();
    return loaded?.gemsByCat ?? { order: [], chaos: [] };
  });

  // 기타 상태
  const [role, setRole] = useState/** @type {Role|null} */(null);
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS });
  const [highlightCoreId, setHighlightCoreId] = useState(null);
  const [highlightGemId, setHighlightGemId] = useState(null);
  const { toasts, push, remove } = useToasts();

  // 계산 제어(수동)
  const [calcVersion, setCalcVersion] = useState(0);
  const [computing, setComputing] = useState(false);
  const [stale, setStale] = useState(false);
  const didMountRef = useRef(false);
  const [priorityPicks, setPriorityPicks] = useState([]);

  // 현재 카테고리별 단축
  const cores = coresByCat[category];
  const gems = gemsByCat[category];

  // Web Worker 핸들
  const workerRef = useRef(null);

  // 워커 초기화/해제
  useEffect(() => {
    // Vite/CRA 모두 호환되는 URL 패턴
    workerRef.current = new Worker(new URL('../workers/optimizer.worker.js', import.meta.url), { type: 'module' });
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // 현재 카테고리에 대해서만 set 하는 헬퍼
  const setCores = (updater) => {
    setCoresByCat((prev) => {
      const next = typeof updater === "function" ? updater(prev[category]) : updater;
      setStale(true);
      return { ...prev, [category]: next };
    });
  };
  const setGems = (updater) => {
    setGemsByCat((prev) => {
      const next = typeof updater === "function" ? updater(prev[category]) : updater;
      setStale(true);
      return { ...prev, [category]: next };
    });
  };

  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    setStale(true);
  }, [role, weights, category]);

  const moveCoreUp = (index) => setCores(prev => {
    if (index <= 0) return prev;
    const next = [...prev];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    return next;
  });
  const moveCoreDown = (index) => setCores(prev => {
    if (index >= prev.length - 1) return prev;
    const next = [...prev];
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    return next;
  });

  // ==== 무거운 계산 → Web Worker로 비동기 이관 + 스피너 확실히 표시 ====
  useEffect(() => {
    if (calcVersion === 0) return;
    let cancelled = false;

    // 1) 스피너 즉시 커밋
    flushSync(() => setComputing(true));

    // 2) 두 번의 RAF로 레이아웃/페인트 기회 확보
    const nextFrame = () => new Promise(requestAnimationFrame);

    (async () => {
      try {
        await nextFrame();
        await nextFrame();

        const worker = workerRef.current;
        if (!worker) throw new Error("Worker not initialized");

        // 메시지 핸들러
        const onMessage = (e) => {
          if (cancelled) return;
          if (e.data?.error) {
            console.error(e.data.error);
            setComputing(false);
            worker.removeEventListener('message', onMessage);
            return;
          }
          const { picks } = e.data || {};
          setPriorityPicks(picks || []);
          setStale(false);
          setComputing(false);
          worker.removeEventListener('message', onMessage);
        };

        worker.addEventListener('message', onMessage);

        // 후보 제한(대규모 입력 방지용)
        const perCoreLimit =
          gems.length > 24 ? 120 :
          gems.length > 16 ? 200 :
          gems.length > 10 ? 260 : 300;

        // 3) 워커에 작업 위임
        worker.postMessage({ cores, gems, role, weights, perCoreLimit });
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setComputing(false);
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calcVersion]);

  const resetWeights = () => setWeights({ ...DEFAULT_WEIGHTS });
  const addGem = () => {
    const id = uid();
    setGems(v => [{ id, will: null, point: null, o1k: "atk", o1v: 0, o2k: "add", o2v: 0 }, ...v]);
    setHighlightGemId(id);
  };
  const removeGem = (id) => {
    setGems(v => v.filter(g => g.id !== id));
    if (highlightGemId === id) setHighlightGemId(null);
  };
  const updateGem = (id, patch) => setGems(v => v.map(g => g.id === id ? { ...g, ...patch } : g));
  const addCore = () => setCores(cs => {
    if (cs.length >= 3) { push("코어는 최대 3개까지 추가할 수 있어요."); return cs; }
    const existing = new Set(cs.map(c => c.name));
    const nextName = nextAvailableCoreName(existing);
    if (!nextName) { push("해/달/별 코어가 모두 추가되어 있어요."); return cs; }
    const id = uid();
    setHighlightCoreId(id);
    return [
      { id, name: nextName, grade: "RELIC", minThreshold: undefined, enforceMin: false },
      ...cs
    ];
  });
  const removeCore = (id) => {
    setCores(cs => cs.length <= 0 ? cs : cs.filter(c => c.id !== id));
    if (highlightCoreId === id) setHighlightCoreId(null);
  };
  const updateCore = (id, patch) => setCores(cs => {
    if ('name' in patch) {
      const dup = cs.some(c => c.id !== id && c.name === patch.name);
      if (dup) {
        push(`${patch.name}는 이미 존재하는 코어입니다`);
        return cs;
      }
    }
    return cs.map(c => c.id === id ? { ...c, ...patch } : c);
  });

  // Drag state (for backdrop blur toggle)
  const [dragging, setDragging] = useState(false);
  const onDragStart = () => {
    requestAnimationFrame(() => setDragging(true));
    const evt = new Event('close-all-dropdowns');
    window.dispatchEvent(evt);
  };
  const onDragEnd = (result) => {
    requestAnimationFrame(() => setDragging(false));
    if (!result.destination) return;
    setCores(prev => {
      const next = Array.from(prev);
      const [moved] = next.splice(result.source.index, 1);
      next.splice(result.destination.index, 0, moved);
      return next;
    });
  };

  // UI tokens
  const smallFieldBase = "h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white";
  const sectionTitle = "text-base font-semibold whitespace-nowrap";
  const card = "bg-white rounded-2xl shadow-sm";
  const chip = "px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs lg:text-[13px]";
  const labelCls = "block text-xs text-gray-500 mb-1";
  const displayIndexCore = (idx) => idx + 1;
  const displayIndexGem = (idx, total) => total - idx;

  // Self-tests (optional)
  useEffect(() => {
    function runSelfTests() {
      try {
        const w = sanitizeWeights({ atk: 2, add: "3", boss: -1 });
        console.assert(w.atk === 2 && w.add === 3 && w.boss === 1, "sanitizeWeights failed");
        const gem = { id: "t1", will: 1, point: 1, o1k: "atk", o1v: 2, o2k: "brand", o2v: 3 };
        console.assert(scoreGemForRole(gem, "dealer", w) === 2 * w.atk, "scoreGemForRole dealer failed");
        console.assert(scoreGemForRole(gem, "support", w) === 3 * (w.brand ?? 1), "scoreGemForRole support failed");
        console.assert(thresholdsHit("RELIC", 20).includes(20) && thresholdsHit("RELIC", 9).length === 0, "thresholdsHit failed");
        const cA = scoreCombo([gem], "RELIC", "dealer", w);
        const cB = scoreCombo([gem, { ...gem, id: "t2", will: 0, point: 10 }], "RELIC", "dealer", w);
        console.assert(cB.score >= cA.score, "scoreCombo monotonicity failed");
        console.log("✅ Self-tests passed");
      } catch (e) {
        console.warn("❌ Self-tests encountered an error", e);
      }
    }
    runSelfTests();
  }, []);
  useEffect(() => {
    saveToStorage({ category, coresByCat, gemsByCat, role, weights });
  }, [category, coresByCat, gemsByCat, role, weights]);

  return (
    <div className="min-h-screen text-gray-900 p-4 lg:p-6" style={{
      backgroundImage: "linear-gradient(125deg, #85d8ea, #a399f2)",
      backgroundAttachment: 'fixed'
    }}>
      {/* 전역 스타일 토큰 */}
      <style>{`
        :root{ --primary:#a399f2; --grad:linear-gradient(125deg,#85d8ea,#a399f2); }
        .btn-primary{ background: #000000; color:#fff; border:none; }
        .text-primary{ color:#a399f2; }
        .accent-primary{ accent-color:#a399f2; }
        .ring-primary:focus{ outline:none; box-shadow:0 0 0 2px rgba(163,153,242,.35); }
      `}</style>
      <style>{`button{cursor:pointer}`}</style>

      <div className="max-w-6xl mx-auto space-y-4 lg:space-y-6">
        {/* 헤더/카테고리 토글 */}
        <section className="py-2 lg:py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className="text-xl lg:text-2xl font-bold leading-tight text-white drop-shadow text-center lg:text-left w-full lg:w-auto">
              로아 아크그리드 젬 장착 도우미
            </h1>
            <div className="flex gap-2 w-auto ml-auto lg:ml-0">
              <button
                onClick={() => setCategory("order")}
                className={`min-w-[84px] h-10 inline-flex items-center justify-center px-3 rounded-xl ${category === 'order' ? 'bg-white' : 'bg-white/70'}`}
                title="질서 카테고리"
              >
                {CATEGORY_LABEL.order}
              </button>
              <button
                onClick={() => setCategory("chaos")}
                className={`min-w-[84px] h-10 inline-flex items-center justify-center px-3 rounded-xl ${category === 'chaos' ? 'bg-white' : 'bg-white/70'}`}
                title="혼돈 카테고리"
              >
                {CATEGORY_LABEL.chaos}
              </button>
            </div>
          </div>
        </section>

        {/* 코어 입력 & 우선순위(DnD/버튼 이동) */}
        <section className={`${card} p-4 lg:p-6 !mt-2 ${dragging ? '' : 'backdrop-blur'}`}>
          <div className="flex items-center gap-2 lg:gap-3">
            <h2 className={sectionTitle}>{CATEGORY_LABEL[category]} 코어 입력</h2>
            <div className="flex items-center gap-2 ml-auto whitespace-nowrap">
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90 ring-primary" onClick={addCore} aria-label="코어 추가"><Plus size={16} /><span className="hidden lg:inline"> 코어 추가</span></button>
            </div>
          </div>
          <p className="hidden lg:block text-xs text-gray-600">드래그 앤 드롭으로 순서를 바꾸세요. <b>우선순위가 높은 항목을 1번(맨 위)으로 배치하세요.</b></p>
          <p className="block lg:hidden text-xs text-gray-600">화살표로 순서를 바꾸세요. <b>우선순위가 높은 항목을 1번(맨 위)으로 배치하세요.</b></p>

          <div className="mt-3">
            <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
              <Droppable droppableId="cores-droppable" ignoreContainerClipping={true}>
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-3">
                    {cores.map((c, idx) => {
                      const supply = CORE_SUPPLY[c.grade];
                      const targetItems = [{ value: '', label: '(선택 안 함)' }].concat(
                        CORE_THRESHOLDS[c.grade].map(v => ({ value: String(v), label: `${v}P 이상` }))
                      );
                      const takenNames = new Set(cores.filter(x => x.id !== c.id).map(x => x.name));
                      const coreNameItems = CORE_NAME_ITEMS.map(it => ({ ...it, disabled: takenNames.has(it.value) }));
                      const minOfGrade = Math.min(...CORE_THRESHOLDS[c.grade]);
                      return (
                        <PortalAwareDraggable key={c.id} draggableId={c.id} index={idx}>
                          {(prov) => (
                            <div ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps} className={`relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible ${c.id === highlightCoreId ? 'LoA-highlight' : ''}`} style={prov.draggableProps.style}>
                              <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl self-start lg:self-center">#{displayIndexCore(idx)}</div>
                              <div className="flex flex-col min-w-[120px] w-full lg:w-40">
                                <label className={labelCls}>코어 종류</label>
                                <Dropdown className="w-full lg:w-40" value={c.name} onChange={(val) => updateCore(c.id, { name: val })} items={coreNameItems} placeholder="코어명" />
                              </div>
                              <div className="flex flex-col min-w-[160px] w-full lg:w-auto">
                                <label className={labelCls}>코어 등급</label>
                                <Dropdown className="w-full lg:w-40" value={c.grade} onChange={(val) => updateCore(c.id, { grade: /** @type {CoreGrade} */(val) })} items={GRADES.map(g => ({ value: g, label: CORE_LABEL[g] }))} placeholder="코어 등급" />
                              </div>
                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>공급 의지력</label>
                                <div className="h-10 px-3 rounded-xl border bg-gray-50 inline-flex items-center"><span className="text-primary font-semibold">{supply}</span></div>
                              </div>
                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>목표 구간</label>
                                <Dropdown className="w-full lg:w-40" value={String(c.minThreshold ?? '')} onChange={(val) => { if (val) updateCore(c.id, { minThreshold: Number(val), enforceMin: true }); else updateCore(c.id, { minThreshold: undefined, enforceMin: false }); }} items={targetItems} placeholder="구간" />
                              </div>
                              <div className="flex flex-col w-full lg:w-auto">
                                <div className="flex items-center gap-2">
                                  <input id={`enf-${c.id}`} type="checkbox" className="accent-primary" checked={c.enforceMin} onChange={(e) => updateCore(c.id, { enforceMin: e.target.checked })} />
                                  <label htmlFor={`enf-${c.id}`} className="text-sm">목표 구간 강제</label>
                                </div>
                                <p className="text-xs text-gray-500 mt-1">선택 안 함이면 내부적으로 <br className="hidden lg:block" />최소 구간 <b className="text-primary">{minOfGrade}P</b>을 기본 목표로 적용합니다.</p>
                              </div>
                              <div className="lg:ml-auto lg:static absolute top-2 right-2 flex items-center gap-1">
                                <div className="hidden lg:hidden" />
                                <div className="flex lg:hidden flex-row gap-1 mr-1">
                                  <button className="h-8 w-8 rounded-lg border inline-flex items-center justify-center bg-white" onClick={() => moveCoreUp(idx)} aria-label="위로"><ChevronUp size={16} /></button>
                                  <button className="h-8 w-8 rounded-lg border inline-flex items-center justify-center bg-white" onClick={() => moveCoreDown(idx)} aria-label="아래로"><ChevronDown size={16} /></button>
                                </div>
                                <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border-0 lg:border text-red-600 inline-flex items-center justify-center gap-2" onClick={() => removeCore(c.id)} disabled={cores.length <= 0} aria-label="코어 삭제"><Trash2 size={16} /><span className="hidden lg:inline"> 삭제</span></button>
                              </div>
                            </div>
                          )}
                        </PortalAwareDraggable>
                      );
                    })}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
            {cores.length === 0 && <div className="text-sm text-gray-700 p-2 text-center">코어를 추가하세요. (최대 3개의 코어까지 추가할 수 있습니다)</div>}
          </div>
        </section>

        {/* 젬 입력 */}
        <section className={`${card} p-4 lg:p-6 ${dragging ? '' : 'backdrop-blur'}`}>
          <div className="flex items-center gap-2 lg:gap-3 mb-3">
            <h2 className={sectionTitle}>{CATEGORY_LABEL[category]} 젬 입력</h2>
            <div className="flex gap-2 ml-auto whitespace-nowrap">
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={addGem} aria-label="젬 추가"><Plus size={16} /><span className="hidden lg:inline"> 젬 추가</span></button>
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={() => setGems([])} aria-label="전체 삭제"><Trash2 size={16} /><span className="hidden lg:inline"> 전체 삭제</span></button>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {gems.map((g, idx) => (
              <div key={g.id} className={`relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-center border rounded-xl p-3 overflow-visible min-w-0 bg-white ${g.id === highlightGemId ? 'LoA-highlight' : ''}`}>
                <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl flex-none">#{displayIndexGem(idx, gems.length)}</div>
                <div className="w-full lg:w-auto flex flex-row gap-2 lg:gap-3 flex-1 lg:flex-none">
                  <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
                    <label className={labelCls}>필요 의지력</label>
                    <NumberInput
                      value={g.will}
                      onChange={(v) => updateGem(g.id, { will: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className={`${smallFieldBase} w-full lg:w-24`}
                      inputProps={{ title: "의지력", placeholder: "의지력" }}
                    />
                  </div>
                  <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
                    <label className={labelCls}>(질서/혼돈)포인트</label>
                    <NumberInput
                      value={g.point}
                      onChange={(v) => updateGem(g.id, { point: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className={`${smallFieldBase} w-full lg:w-24`}
                      inputProps={{ title: "포인트", placeholder: "포인트" }}
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                  <div className="flex-1 lg:flex-none min-w-0">
                    <label className={labelCls}>옵션 1</label>
                    <Dropdown className="w-full lg:w-44" value={g.o1k} onChange={(val) => updateGem(g.id, { o1k: /** @type {OptionKey} */(val) })} items={OPTIONS.map(k => ({ value: k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택" />
                  </div>
                  <div className="flex-1 lg:flex-none">
                    <label className={labelCls}>수치</label>
                    <NumberInput
                      value={g.o1v}
                      onChange={(v) => updateGem(g.id, { o1v: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                      inputProps={{ placeholder: "0" }}
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                  <div className="flex-1 lg:flex-none min-w-0">
                    <label className={labelCls}>옵션 2</label>
                    <Dropdown className="w-full lg:w-44" value={g.o2k} onChange={(val) => updateGem(g.id, { o2k: /** @type {OptionKey} */(val) })} items={OPTIONS.map(k => ({ value: k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택" />
                  </div>
                  <div className="flex-1 lg:flex-none">
                    <label className={labelCls}>수치</label>
                    <NumberInput
                      value={g.o2v}
                      onChange={(v) => updateGem(g.id, { o2v: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                      inputProps={{ placeholder: "0" }}
                    />
                  </div>
                </div>
                <div className="lg:static absolute top-2 right-2 lg:top-auto lg:right-auto lg:ml-auto w-auto lg:flex-none">
                  <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border-0 lg:border text-red-600 inline-flex items-center justify-center gap-2" onClick={() => removeGem(g.id)} aria-label="젬 삭제"><Trash2 size={16} /><span className="hidden lg:inline"> 삭제</span></button>
                </div>
              </div>
            ))}
            {gems.length === 0 && <div className="text-sm text-gray-700 p-2 text-center">젬을 추가하세요.</div>}
          </div>
        </section>

        {/* 유효옵션 가중치 */}
        <section className={`${card} p-4 lg:p-6 ${dragging ? '' : 'backdrop-blur'}`}>
          <div className="flex items-center gap-2 lg:gap-3">
            <h2 className={sectionTitle}>유효옵션 가중치</h2>
            <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border ml-auto whitespace-nowrap inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={resetWeights} aria-label="가중치 초기화"><RotateCcw size={16} /><span className="hidden lg:inline"> 가중치 초기화</span></button>
          </div>
          <div className={`mb-1 flex items-center gap-4 text-sm`}>
            <span className="text-xs text-gray-500">포지션 선택</span>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="role"
                checked={role === "dealer"}
                onChange={() => {
                  setRole("dealer");
                  setWeights({ ...DEALER_WEIGHTS });
                }}
                className="accent-primary"
              />
              딜러
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="role"
                checked={role === "support"}
                onChange={() => {
                  setRole("support");
                  setWeights((w) => maskWeightsForRole(w, "support"));
                }}
                className="accent-primary"
              />
              서포터
            </label>
          </div>
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-nowrap text-sm min-w-0">
              {OPTIONS.map((k) => (
                <div key={k} className="bg-gray-50 border rounded-xl px-2 py-2 w-full lg:w-1/6 min-w-[120px]">
                  <label className={labelCls}>{OPTION_LABELS[k]}</label>
                  <NumberInput
                    value={weights[k]}
                    onChange={(v) => setWeights((w) => ({ ...w, [k]: (v) }))}
                    min={0}
                    max={5}
                    step={0.0000001}
                    allowFloat={true}
                    className="h-10 w-full px-2 rounded-md border bg-white focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50"
                  />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 하단 계산 액션/알림 */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-2">
          {stale && !computing && calcVersion > 0 && (
            <span className="inline-block text-[11px] px-3 py-1.5 rounded-lg bg-red-100 text-red-800 border border-red-200 text-center lg:text-left">
              입력값이 변경되었습니다. <b>계산하기</b> 버튼을 눌러 다시 계산해 주세요.
            </span>
          )}
          <div className="flex items-center gap-2 lg:ml-auto w-full lg:w-auto">
            <button
              type="button"
              onClick={() => setCalcVersion(v => v + 1)}
              disabled={computing}
              className="h-10 w-full lg:w-[120px] px-0 lg:px-3 rounded-xl ml-auto whitespace-nowrap inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90"
            >
              {computing ? "계산 중…" : "계산하기"}
            </button>
          </div>
        </div>

        {/* 결과 */}
        <section className={`${card} p-4 lg:p-6 ${dragging ? '' : 'backdrop-blur'}`}>
          <h2 className={sectionTitle}>결과</h2>
          <p className="text-xs text-gray-600 mt-2">코어 1개당 최대 <b>젬 4개</b>까지 장착할 수 있습니다.</p>
          {!computing && stale && calcVersion > 0 && (
            <p className="text-xs text-red-700 mt-1">입력값이 변경되었습니다. 우측 상단의 <b>계산하기</b> 버튼을 눌러 다시 계산해 주세요.</p>
          )}
          <div className="space-y-4 mt-2">
            {cores.map((c, i) => {
              const supply = CORE_SUPPLY[c.grade];
              const pick = priorityPicks?.[i];
              const hasResult = !!(pick && pick.list && pick.list.length > 0);
              const minOfGrade = Math.min(...CORE_THRESHOLDS[c.grade]);
              return (
                <div key={c.id} className="border rounded-xl p-3 bg-white">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="text-base font-semibold">
                      {c.name} <span className="text-sm text-gray-500">({CORE_LABEL[c.grade]})</span>
                    </div>
                    {hasResult && (
                      <div className="flex flex-wrap gap-2 items-center text-[12px] lg:text-[13px]">
                        <div className={chip}>총 의지력 <span className="font-semibold">{String(pick.totalWill)}</span> / 공급 <span>{String(supply)}</span> (<span>나머지 {String(supply - pick.totalWill)}</span>)</div>
                        <div className={chip}>총 포인트 <span className="font-semibold">{String(pick.totalPoint)}</span></div>
                        {(() => {
                          const maxThr = pick.thr.length ? Math.max(...pick.thr) : null;
                          return (
                            <div className={chip}>
                              달성 구간 <span className="font-semibold">{maxThr != null ? String(maxThr) : "없음"}</span>
                            </div>
                          );
                        })()}
                        <div className={chip}>{role === 'dealer' ? "예상 딜 증가량 (젬) " : role === 'support' ? "예상 지원 증가량 (젬) " : "유효 옵션 합 "}
                          <span className="font-semibold text-primary">{String(pick.roleSum.toFixed(4))}%</span></div>
                      </div>
                    )}
                  </div>
                  {!hasResult ? (
                    <div className="text-sm text-gray-700 mt-2">
                      결과가 없습니다. (이 코어에 배정 가능한 조합이 없거나, 목표 구간을 만족하지 못합니다.{c.minThreshold == null ? ` / 최소 ${minOfGrade}P 자동 적용중` : ""})
                    </div>
                  ) : (
                    <>
                      {/* Desktop table */}
                      <div className="hidden lg:block overflow-x-auto mt-2">
                        <table className="min-w-full text-sm">
                          <colgroup>
                            <col width={"13%"} />
                            <col width={"13%"} />
                            <col width={"13%"} />
                            <col width={"24%"} />
                            <col width={"24%"} />
                            <col width={"13%"} />
                          </colgroup>
                          <thead>
                            <tr className="text-left text-gray-500">
                              <th className="px-2 py-2">선택</th>
                              <th className="px-2 py-2">의지력</th>
                              <th className="px-2 py-2">포인트</th>
                              <th className="px-2 py-2">옵션1</th>
                              <th className="px-2 py-2">옵션2</th>
                              <th className="px-2 py-2">{role === 'dealer' ? "예상 딜 증가량 (젬) " : role === 'support' ? "예상 지원 증가량 (젬) " : "유효 옵션 합 "}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pick.list.map(g => {
                              const gi = gems.findIndex(x => x.id === g.id);
                              const disp = displayIndexGem(gi, gems.length);
                              return (
                                <tr key={g.id} className="border-t">
                                  <td className="px-2 py-2">#{String(disp)}</td>
                                  <td className="px-2 py-2">{String(g.wwill ?? g.will ?? 0)}</td>
                                  <td className="px-2 py-2">{String(g.point ?? 0)}</td>
                                  <td className="px-2 py-2">{OPTION_LABELS[g.o1k]} {String(g.o1v)}</td>
                                  <td className="px-2 py-2">{OPTION_LABELS[g.o2k]} {String(g.o2v)}</td>
                                  <td className="px-2 py-2 text-primary">{String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(4))}%</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile cards */}
                      <div className="lg:hidden mt-2 space-y-2">
                        {pick.list.map(g => {
                          const gi = gems.findIndex(x => x.id === g.id);
                          const disp = displayIndexGem(gi, gems.length);
                          return (
                            <div key={g.id} className="rounded-xl border p-3 bg-white">
                              <div className="flex items-center justify-between text-sm">
                                <div className="font-medium">#{String(disp)}</div>
                                <div className="text-xs text-primary">{role === 'dealer' ? "예상 딜 증가량 (젬) " : role === 'support' ? "예상 지원 증가량 (젬) " : "유효 옵션 합 "} {String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(4))}%</div>
                              </div>
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                                <div className="text-gray-500">의지력</div>
                                <div>{String(g.will)}</div>
                                <div className="text-gray-500">포인트</div>
                                <div className="text-primary">{String(g.point)}</div>
                                <div className="text-gray-500">옵션1</div>
                                <div>{OPTION_LABELS[g.o1k]} {String(g.o1v)}</div>
                                <div className="text-gray-500">옵션2</div>
                                <div>{OPTION_LABELS[g.o2k]} {String(g.o2v)}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <ToastStack toasts={toasts} onClose={remove} />
      <div className="mt-6">
        <KakaoAdfit />
      </div>

      {/* 전역 오버레이 스피너 (z-index 최상단) */}
      {computing && (
        <div className="fixed inset-0 z-[99999] bg-black/35 backdrop-blur-[1px] flex items-center justify-center">
          <div className="w-12 h-12 border-4 border-white/80 border-t-transparent rounded-full animate-spin" aria-label="계산 중" />
          <span className="ml-3 text-white font-semibold select-none">최적 조합 계산 중…</span>
        </div>
      )}
    </div>
  );
}
