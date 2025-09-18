/**
 * LoACoreOptimizer.jsx
 *
 * 재구성(리팩터링된 파일 배치 & 계층 주석) 버전.
 * - 실행 로직/동작 동일 유지 (함수/값, 상태, JSX 구조, 훅 호출 순서에 의존하는 부분 불변).
 * - 기존 주석은 모두 제거했고, 가독성을 위한 섹션/행동 중심의 주석을 새로 정리하여 추가함.
 * - "재그룹/재배치"는 선언의 물리적 위치만 정렬(의존성 방향상 안전한 순서)했을 뿐, 코드 의미를 바꾸지 않음.
 *
 * 섹션 구성
 *  A. 외부/내부 모듈 임포트
 *  B. 도메인/뷰 공통 상수 및 매핑
 *  C. 직업-코어 프리셋/효과 유틸
 *  D. 공용 유틸(로컬스토리지, UID, 외부 클릭 등)
 *  E. DnD 포털용 Draggable 래퍼
 *  F. UI 프리미티브(드롭다운, 토스트, 숫자입력)
 *  G. 프리셋 설명 툴팁(CoreEffectInfo)
 *  H. 메인 컴포넌트(LoACoreOptimizer) + QuickAddPad(내부)
 */

import React, { useEffect, useState, useRef, useLayoutEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import { createPortal } from "react-dom";
import { Plus, Trash2, ChevronUp, ChevronDown, Info, Download, Upload } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useOptimizer } from '../hooks/useOptimizer';
import KakaoAdfit from "./KakaoAdfit";
import './LoACoreOptimizer.css';

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
  levelValueByRole,
} from '../lib/optimizerCore.js';
import ARC_CORES from "../data/arc_cores_select.json";

/* ──────────────────────────────────────────────────────────────────────────
 * B. 도메인/뷰 공통 상수 및 매핑
 *    - 화면 공통 라벨/세트, 로컬스토리지 키, 직업/코어 그룹 매핑 등
 * ────────────────────────────────────────────────────────────────────────── */

const CORE_NAME_ITEMS = [
  { value: "해 코어", label: "해 코어" },
  { value: "달 코어", label: "달 코어" },
  { value: "별 코어", label: "별 코어" },
];

const CATEGORY_LABEL = { order: "질서", chaos: "혼돈" };
const LS_KEY = "LoA-CoreOptimizer-v2";

const JOBS = ARC_CORES?.jobs ?? [];
const CORE_NAME_BY_GROUP = { "해": "해 코어", "달": "달 코어", "별": "별 코어" };
const GROUP_BY_CORE_NAME = { "해 코어": "해", "달 코어": "달", "별 코어": "별" };

const CORE_ORDER = ["해 코어", "달 코어", "별 코어"];

const TARGET_MAX_BY_GRADE = {
  HERO: 10,
  LEGEND: 14,
  RELIC: 19,
  ANCIENT: 20,
};


/* ──────────────────────────────────────────────────────────────────────────
 * C. 직업-코어 프리셋/효과 유틸
 *    - 직업별 허용 코어, 프리셋 목록, 효과 정규화/조회
 * ────────────────────────────────────────────────────────────────────────── */

function getAllowedCoreNameSet(job) {
  const entries = ARC_CORES?.data?.[job] ?? [];
  const groups = new Set(entries.map(e => e["그룹"]));
  const names = new Set(
    Array.from(groups).map(g => CORE_NAME_BY_GROUP[g]).filter(Boolean)
  );
  return names;
}

function getPresetItems(job, groupKey) {
  if (!job || !groupKey) return [];
  const entries = ARC_CORES?.data?.[job] ?? [];
  return entries
    .filter(e => e["그룹"] === groupKey)
    .map(e => ({ value: e["코어"], label: e["코어"] }));
}

function normalizeEffects(raw) {
  if (!raw) return [];
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw.flatMap((item) => {
      if (!item) return [];
      if (typeof item === "string") {
        const m = item.match(/(\d+)\s*P?/i);
        const p = m ? Number(m[1]) : null;
        return p ? [{ point: p, text: item.replace(/^.*?:\s*/, "").trim() || item.trim() }] : [];
      }
      if (typeof item === "object") {
        let p = item.point ?? item.P ?? item.포인트 ?? null;
        if (typeof p === "string") p = parseInt(p.replace(/\D/g, ""), 10);
        const t = item.text ?? item.desc ?? item.효과 ?? item.value ?? "";
        return Number.isFinite(p) ? [{ point: Number(p), text: String(t) }] : [];
      }
      return [];
    });
  } else if (typeof raw === "object") {
    arr = Object.entries(raw).map(([k, v]) => {
      const p = parseInt(String(k).replace(/\D/g, ""), 10);
      return { point: p, text: String(v) };
    });
  } else if (typeof raw === "string") {
    arr = raw.split(/\r?\n/).flatMap((line) => {
      const m = line.match(/(\d+)\s*P?/i);
      const p = m ? Number(m[1]) : null;
      return p ? [{ point: p, text: line.replace(/^.*?:\s*/, "").trim() || line.trim() }] : [];
    });
  }

  return arr
    .filter((x) => Number.isFinite(x.point) && x.text)
    .sort((a, b) => a.point - b.point);
}

function getEffectsForPreset(job, groupKey, preset) {
  if (!job || !groupKey || !preset) return [];
  const entries = ARC_CORES?.data?.[job] ?? [];
  const row = entries.find((e) => e["그룹"] === groupKey && e["코어"] === preset);
  return normalizeEffects(row?.["효과"]);
}

/* ──────────────────────────────────────────────────────────────────────────
 * D. 공용 유틸
 *    - UID 생성, 역할별 가중치 마스킹, 로컬스토리지 I/O, 다음 코어명 탐색, 외부클릭
 * ────────────────────────────────────────────────────────────────────────── */

const uid = () => Math.random().toString(36).slice(2, 9);

function nextAvailableCoreName(existingNames) {
  for (const n of CORE_ORDER) if (!existingNames.has(n)) return n;
  return null;
}

// 딜러: 0.123%  /  서포터: 0.123  (둘 다 소수 3자리)
function fmtByRole(role, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return role === 'dealer' ? `${n.toFixed(3)}%` : n.toFixed(3);
}

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

/* ──────────────────────────────────────────────────────────────────────────
 * E. Portal-aware Draggable 래퍼
 *    - 드래그 시 body 포털로 이동시켜 클리핑/레이어 문제 방지
 * ────────────────────────────────────────────────────────────────────────── */

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

/* ──────────────────────────────────────────────────────────────────────────
 * F. UI 프리미티브
 *    1) Dropdown: 키보드 접근성/포털 메뉴/ARIA 적용
 *    2) ToastStack + useToasts: 간단 토스트 큐
 *    3) NumberInput: 숫자 입력 공통(클램프/포맷/휠 방지)
 * ────────────────────────────────────────────────────────────────────────── */

function Dropdown({ value, items, onChange, placeholder, className, bordered = true }) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const menuPos = useRef({ top: 0, left: 0, width: 0 });
  const [, forceTick] = useState(0);
  const listboxId = useRef(`dd-list-${Math.random().toString(36).slice(2)}`).current;

  const initFocusIndex = useCallback(() => {
    const sel = items.findIndex(i => i.value === value && !i.disabled);
    if (sel >= 0) return sel;
    const firstEnabled = items.findIndex(i => !i.disabled);
    return firstEnabled >= 0 ? firstEnabled : -1;
  }, [items, value]);

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

  useEffect(() => {
    if (!open) return;
    setFocusedIndex(initFocusIndex());
    const t = requestAnimationFrame(() => {
      const el = itemRefs.current[initFocusIndex()];
      (el ?? menuRef.current)?.focus?.();
    });
    return () => cancelAnimationFrame(t);
  }, [open, initFocusIndex]);

  const selected = items.find((i) => i.value === value);

  const getNextEnabled = (start, dir) => {
    const n = items.length;
    if (n === 0) return -1;
    let i = start;
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (!items[i].disabled) return i;
    }
    return -1;
  };

  const onButtonKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const willOpen = !open;
      if (willOpen) {
        setOpen(true);
      } else {
        const base = focusedIndex >= 0 ? focusedIndex : initFocusIndex();
        const next = e.key === "ArrowDown" ? getNextEnabled(base, +1) : getNextEnabled(base, -1);
        if (next >= 0) setFocusedIndex(next);
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(v => !v);
    }
  };

  const onMenuKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const base = focusedIndex >= 0 ? focusedIndex : initFocusIndex();
      const next = e.key === "ArrowDown" ? getNextEnabled(base, +1) : getNextEnabled(base, -1);
      if (next >= 0) setFocusedIndex(next);
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = items.findIndex(i => !i.disabled);
      if (first >= 0) setFocusedIndex(first);
    } else if (e.key === "End") {
      e.preventDefault();
      let last = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (!items[i].disabled) { last = i; break; }
      }
      if (last >= 0) setFocusedIndex(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = items[focusedIndex];
      if (it && !it.disabled) {
        onChange(it.value);
        setOpen(false);
        requestAnimationFrame(() => btnRef.current?.querySelector("button")?.focus?.());
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => btnRef.current?.querySelector("button")?.focus?.());
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const onItemMouseEnter = (i) => setFocusedIndex(i);

  const menu = open ? (
    <AnimatePresence>
      <motion.ul
        ref={menuRef}
        key="menu"
        role="listbox"
        id={listboxId}
        tabIndex={-1}
        aria-activedescendant={focusedIndex >= 0 ? `${listboxId}-opt-${focusedIndex}` : undefined}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.12 }}
        style={{ position: "fixed", top: menuPos.current.top, left: menuPos.current.left, width: menuPos.current.width, zIndex: 9999 }}
        className={`rounded-xl bg-white shadow-lg overflow-auto max-h-60 ${bordered ? "border" : ""}`}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((it, i) => {
          const isSelected = it.value === value;
          const isActive = i === focusedIndex;
          return (
            <li key={String(it.value)}>
              <button
                ref={(el) => (itemRefs.current[i] = el)}
                id={`${listboxId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => onItemMouseEnter(i)}
                onClick={() => {
                  if (it.disabled) return;
                  onChange(it.value);
                  setOpen(false);
                  requestAnimationFrame(() => btnRef.current?.querySelector("button")?.focus?.());
                }}
                aria-disabled={it.disabled ? true : undefined}
                className={`w-full text-left px-3 py-2 text-sm
                  ${it.disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-50"}
                  ${isSelected ? "bg-gray-100" : ""}
                  ${isActive ? "outline-none ring-2 ring-[#a399f2]/40" : ""}
                `}
              >
                <span className="block truncate">{it.label}</span>
              </button>
            </li>
          );
        })}
      </motion.ul>
    </AnimatePresence>
  ) : null;

  return (
    <div ref={btnRef} className={`relative min-w-0 ${className || ""}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onKeyDown={onButtonKeyDown}
        onClick={() => setOpen(v => !v)}
        className={`min-w-0 h-10 w-full inline-flex items-center justify-between rounded-xl px-3 bg-white hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 ${bordered ? "border" : ""}`}
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

/* ──────────────────────────────────────────────────────────────────────────
 * G. 프리셋 효과 툴팁
 *    - 선택한 직업/그룹/프리셋 기준으로 등급 제한 내 효과를 미리보기
 * ────────────────────────────────────────────────────────────────────────── */

function CoreEffectInfo({ job, groupKey, preset, grade, category, coreName, supply }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const effects = getEffectsForPreset(job, groupKey, preset);
  const maxP = TARGET_MAX_BY_GRADE[grade] ?? 999;
  const list = effects.filter((e) => e.point <= maxP);

  const coreShort =
    GROUP_BY_CORE_NAME[coreName] ??
    coreName.replace(/\s*코어$/, "");

  const LABEL_CLS = "text-[12px] text-gray-500 mb-1 text-indigo-400";

  const isAncient =
    (CORE_LABEL?.[grade] ?? "").includes("고대") || String(grade).toLowerCase() === "ancient";

  const gradeColorCls =
    String(grade).toUpperCase() === "HERO" || (CORE_LABEL?.[grade] ?? "").includes("영웅") ? "text-fuchsia-500" :
      String(grade).toUpperCase() === "LEGEND" || (CORE_LABEL?.[grade] ?? "").includes("전설") ? "text-amber-500" :
        String(grade).toUpperCase() === "RELIC" || (CORE_LABEL?.[grade] ?? "").includes("유물") ? "text-orange-700" :
          String(grade).toUpperCase() === "ANCIENT" || (CORE_LABEL?.[grade] ?? "").includes("고대") ? "text-[#d3bd8b]" :
            "text-gray-800";

  const pickSlashValueByGrade = (text) => {
    const pickRight = isAncient;

    let out = text.replace(
      /(\d+(?:\.\d+)?)%\s*\/\s*(\d+(?:\.\d+)?)%/g,
      (_, a, b) => (pickRight ? b : a) + "%"
    );

    out = out.replace(
      /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(%)/g,
      (_, a, b, pct) => (pickRight ? b : a) + pct
    );

    out = out.replace(
      /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?!\s*[%\d])/g,
      (_, a, b) => (pickRight ? b : a)
    );

    return out;
  };

  return (
    <span
      ref={ref}
      className="relative inline-flex items-center align-top ml-1 cursor-pointer"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <Info size={16} aria-hidden="true" color="#a399f2" />

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute z-[999999] mt-2 left-1/2 -translate-x-1/2 w-[400px] rounded-xl border bg-white shadow-lg p-3 text-xs"
            role="tooltip"
          >
            <div className="text-[13px] font-semibold mb-2">
              <div>{CATEGORY_LABEL[category]}의 {coreName} : {preset}</div>
              <div className={`text-[12px] font-medium ${gradeColorCls}`}>{CORE_LABEL[grade]} 아크 그리드 코어</div>
            </div>

            <div className="mb-2">
              <div className={LABEL_CLS}>코어 타입</div>
              <div className="text-[12px] font-medium">
                <span>{CATEGORY_LABEL[category]}</span>
                <span className="mx-1">–</span>
                <span>{coreShort}</span>
              </div>
            </div>

            <div className="mb-2">
              <div className={LABEL_CLS}>코어 공급 의지력</div>
              <div className="text-[12px] font-medium">{String(supply)} 포인트</div>
            </div>

            <div className={LABEL_CLS}>코어 옵션</div>
            {list.length === 0 ? (
              <div className="text-gray-500">옵션 정보가 없습니다.</div>
            ) : (
              <ul className="mt-1 space-y-1">
                {list.map((e) => {
                  const text = e.point === 17 ? pickSlashValueByGrade(e.text) : e.text;
                  return (
                    <li
                      key={e.point}
                      className="grid grid-cols-[32px_1fr] gap-x-1 items-start min-w-0"
                    >
                      <span className="w-[32px] shrink-0 text-amber-500 font-semibold">
                        [{e.point}P]
                      </span>
                      <span className="text-gray-800 break-words min-w-0">
                        {text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * H. 메인 컴포넌트
 *    - 상태/로직/뷰 그대로 유지
 *    - 내부에 QuickAddPad 폼 컴포넌트 포함
 * ────────────────────────────────────────────────────────────────────────── */

export default function LoACoreOptimizer() {
  useEffect(() => { document.title = "로아 아크그리드 젬 장착 헬퍼"; }, []);

  const [category, setCategory] = useState(
    () => (loadFromStorage()?.category ?? "order")
  );
  const [coresByCat, setCoresByCat] = useState(() => {
    const loaded = loadFromStorage();
    return loaded?.coresByCat ?? { order: [], chaos: [] };
  });
  const [gemsByCat, setGemsByCat] = useState(() => {
    const loaded = loadFromStorage();
    return loaded?.gemsByCat ?? { order: [], chaos: [] };
  });

  const [role, setRole] = useState(() => loadFromStorage()?.role ?? "dealer");
  const [weights, setWeights] = useState(() => {
    const saved = loadFromStorage();
    const w = saved?.weights;
    if (w && typeof w === "object") {
      const vals = ["atk","add","boss","brand","allyDmg","allyAtk"].map(k => Number(w[k]));
      const allOnes = vals.every(v => v === 1);
      // 과거 기본값(전부 1)만 저장돼 있고 역할 정보가 없거나 딜러로 추정되면 → 딜러 프리셋으로 이행
      if (allOnes && (!saved?.role || saved.role === "dealer")) {
        return { ...DEALER_WEIGHTS };
      }
      return sanitizeWeights(w);
    }
    // 저장된 게 없으면 딜러 프리셋으로 시작
    return { ...DEALER_WEIGHTS };
  });
  const [highlightCoreId, setHighlightCoreId] = useState(null);
  const [highlightGemId, setHighlightGemId] = useState(null);
  const { toasts, push, remove } = useToasts();
  const [quickAddMode, setQuickAddMode] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  const [stale, setStale] = useState(false);
  const didMountRef = useRef(false);

  const cores = coresByCat[category];
  const gems = gemsByCat[category];

  const { isComputing, progress, results, calculate, hasCalculated } = useOptimizer(cores, gems, role, weights);

  const [selectedJob, setSelectedJob] = useState(() => (loadFromStorage()?.selectedJob ?? ""));

  const fileInputRef = useRef(null);

  const buildSnapshot = useCallback(() => ({
    app: "LoA-CoreOptimizer",
    version: 2,
    exportedAt: new Date().toISOString(),
    category,
    coresByCat,
    gemsByCat,
    role,
    weights: sanitizeWeights(weights),
    selectedJob,
  }), [category, coresByCat, gemsByCat, role, weights, selectedJob]);

  const handleExportJson = useCallback(() => {
    try {
      const data = buildSnapshot();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

      // 직업명이 있을 때만 파일명에 추가 (불가 문자는 제거)
      const jobPart =
        selectedJob && selectedJob.trim()
          ? `_${selectedJob.trim().replace(/[\\/:*?"<>|]+/g, "")}`
          : "";

      const a = document.createElement("a");
      a.href = url;
      a.download = `아크그리드${jobPart}_${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      push("JSON 파일로 내보냈습니다.");
    } catch (e) {
      console.error(e);
      push("내보내기 중 오류가 발생했어요.");
    }
  }, [buildSnapshot, push, selectedJob]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result));
        if (!json || typeof json !== "object") throw new Error("invalid");
        if (!json.coresByCat || !json.gemsByCat) throw new Error("missing fields");
        flushSync(() => {
          setCoresByCat(json.coresByCat);
          setGemsByCat(json.gemsByCat);
          setCategory(json.category === "chaos" ? "chaos" : "order");
          setRole(json.role === "dealer" || json.role === "support" ? json.role : null);
          setWeights(() => {
            const r = json.role === "support" ? "support" : "dealer";
            return r === "dealer" ? { ...DEALER_WEIGHTS } : maskWeightsForRole(DEFAULT_WEIGHTS, "support");
          });
          setSelectedJob(typeof json.selectedJob === "string" ? json.selectedJob : "");
          setHighlightCoreId(null);
          setHighlightGemId(null);
          setQuickAddMode(false);
          setStale(true);
        });
        setDataVersion(v => v + 1);
        push("JSON 데이터를 불러왔습니다.");
      } catch (err) {
        console.error(err);
        push("가져오기 실패: JSON 형식이 올바르지 않아요.");
      }
    };
    reader.onerror = () => push("가져오기 실패: 파일을 읽을 수 없어요.");
    reader.readAsText(file);
  }, [push, setCoresByCat, setGemsByCat, setCategory, setRole, setWeights, setSelectedJob]);

  useEffect(() => {
    if (results && results.length > 0) {
      setStale(false);
    }
  }, [results]);

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

  useEffect(() => {
    if (category !== "order" || !selectedJob) return;

    setCoresByCat((prevByCat) => {
      const list = prevByCat[category] ?? [];
      let changed = false;

      const next = list.map((c) => {
        const groupKey = GROUP_BY_CORE_NAME[c.name];
        const items = getPresetItems(selectedJob, groupKey);
        const isValid = c.preset && items.some((i) => i.value === c.preset);
        const nextPreset = isValid ? c.preset : (items[0]?.value ?? undefined);

        if (nextPreset !== c.preset) {
          changed = true;
          return { ...c, preset: nextPreset };
        }
        return c;
      });

      if (!changed) return prevByCat;
      setStale(true);
      return { ...prevByCat, [category]: next };
    });
  }, [category, selectedJob, cores, setCoresByCat, setStale]);

  const addGem = () => {
    const id = uid();
    setGems(v => [{ id, will: null, point: null, o1k: "atk", o1v: null, o2k: "add", o2v: null }, ...v]);
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

    const initialPreset =
      category === "order" && selectedJob
        ? getPresetItems(selectedJob, GROUP_BY_CORE_NAME[nextName])[0]?.value
        : undefined;
    return [
      { id, name: nextName, grade: "RELIC", minThreshold: undefined, enforceMin: false, preset: initialPreset },
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
  // eslint-disable-next-line
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

  const smallFieldBase = "h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white";
  const sectionTitle = "text-base font-semibold whitespace-nowrap";
  const card = "bg-white rounded-2xl shadow-sm";
  const chip = "px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs lg:text-[13px]";
  const labelCls = "block text-xs text-gray-500 mb-1";
  const displayIndexCore = (idx) => idx + 1;
  const displayIndexGem = (idx, total) => total - idx;

  useEffect(() => {
    saveToStorage({ category, coresByCat, gemsByCat, role, weights, selectedJob });
  }, [category, coresByCat, gemsByCat, role, weights, selectedJob]);

  function QuickAddPad({ onAdd, focusOnMount = false }) {
    const [o1k, setO1k] = useState("atk");
    const [o2k, setO2k] = useState("add");
    const [o1v, setO1v] = useState(1);
    const [o2v, setO2v] = useState(1);
    const [will, setWill] = useState(1);
    const [point, setPoint] = useState(1);

    const firstRef = useRef(null);
    const focusAfterSubmitRef = useRef(false);
    const WILL_INPUT_ID = "quick-pad-will-input";

    useEffect(() => {
      if (!focusOnMount) return;
      requestAnimationFrame(() => {
        firstRef.current?.focus?.();
        firstRef.current?.select?.();
      });
    }, [focusOnMount]);

    const focusWill = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (firstRef.current) {
            try { firstRef.current.focus(); firstRef.current.select?.(); return; } catch { }
          }
          const el = document.getElementById(WILL_INPUT_ID);
          if (el) { el.focus(); el.select?.(); }
        });
      });
    };

    const handleSubmit = (e) => {
      e?.preventDefault?.();
      const id = uid();
      onAdd({
        id,
        will: Number.isFinite(will) ? will : 0,
        point: Number.isFinite(point) ? point : 0,
        o1k,
        o1v: Number.isFinite(o1v) ? o1v : 0,
        o2k,
        o2v: Number.isFinite(o2v) ? o2v : 0,
      });

      if (focusAfterSubmitRef.current) {
        focusWill();
        focusAfterSubmitRef.current = false;
      }
    };

    const onKeyDownSubmit = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        focusAfterSubmitRef.current = true;
        handleSubmit(e);
      }
    };

    return (
      <form onSubmit={handleSubmit}>
        <div className="relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-center border rounded-xl p-3 overflow-visible min-w-0 bg-white">
          <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl flex-none" title="빠른 추가">
            <Plus size={18} />
          </div>

          <div className="w-full lg:w-auto flex flex-row gap-2 lg:gap-3 flex-1 lg:flex-none">
            <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
              <label className={labelCls}>필요 의지력</label>
              <NumberInput
                value={will}
                onChange={setWill}
                min={3}
                max={9}
                step={1}
                allowFloat={false}
                className={`${smallFieldBase} w-full lg:w-24`}
                inputProps={{
                  id: WILL_INPUT_ID,
                  title: "의지력",
                  placeholder: "의지력",
                  onKeyDown: onKeyDownSubmit,
                  ref: firstRef,
                }}
              />
            </div>
            <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
              <label className={labelCls}>(질서/혼돈)포인트</label>
              <NumberInput
                value={point}
                onChange={setPoint}
                min={1}
                max={5}
                step={1}
                allowFloat={false}
                className={`${smallFieldBase} w-full lg:w-24`}
                inputProps={{ title: "포인트", placeholder: "포인트", onKeyDown: onKeyDownSubmit }}
              />
            </div>
          </div>

          <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
            <div className="flex-1 lg:flex-none min-w-0">
              <label className={labelCls}>옵션 1</label>
              <Dropdown
                className="w-full lg:w-44"
                value={o1k}
                onChange={(v) => setO1k(v)}
                items={OPTIONS.map(k => ({ value: k, label: OPTION_LABELS[k] }))}
                placeholder="옵션 선택"
              />
            </div>
            <div className="flex-1 lg:flex-none">
              <label className={labelCls}>수치</label>
              <NumberInput
                value={o1v}
                onChange={setO1v}
                min={1}
                max={5}
                step={1}
                allowFloat={false}
                className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                inputProps={{ placeholder: "1", onKeyDown: onKeyDownSubmit }}
              />
            </div>
          </div>

          <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
            <div className="flex-1 lg:flex-none min-w-0">
              <label className={labelCls}>옵션 2</label>
              <Dropdown
                className="w-full lg:w-44"
                value={o2k}
                onChange={(v) => setO2k(v)}
                items={OPTIONS.map(k => ({ value: k, label: OPTION_LABELS[k] }))}
                placeholder="옵션 선택"
              />
            </div>
            <div className="flex-1 lg:flex-none">
              <label className={labelCls}>수치</label>
              <NumberInput
                value={o2v}
                onChange={setO2v}
                min={1}
                max={5}
                step={1}
                allowFloat={false}
                className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                inputProps={{ placeholder: "1", onKeyDown: onKeyDownSubmit }}
              />
            </div>
          </div>

          <div className="top-2 right-2 lg:top-auto lg:right-auto lg:ml-auto w-auto lg:flex-none">
            <button
              type="submit"
              onClick={() => { (focusAfterSubmitRef.current = true); }}
              className="h-10 w-full lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90"
              title="Enter로도 추가 가능"
            >
              <Plus size={16} />
              <span className="inline"> 젬 추가</span>
            </button>
          </div>
        </div>

        <div className="relative flex items-center my-4">
          <div className="flex-grow border-t"></div>
          <span className="mx-3 text-sm text-gray-600">
            아래에서 추가한 젬들을 확인하세요.
          </span>
          <div className="flex-grow border-t"></div>
        </div>
      </form>
    );
  }

  return (
    <div className="min-h-screen text-gray-900 p-4 lg:p-6" style={{
      backgroundImage: "linear-gradient(125deg, #85d8ea, #a399f2)",
      backgroundAttachment: 'fixed'
    }}>
      <style>{`
        :root{ --primary:#a399f2; --grad:linear-gradient(125deg,#85d8ea,#a399f2); }
        .btn-primary{ background: #000000; color:#fff; border:none; }
        .text-primary{ color:#a399f2; }
        .accent-primary{ accent-color:#a399f2; }
        .ring-primary:focus{ outline:none; box-shadow:0 0 0 2px rgba(163,153,242,.35); }
        @keyframes loa-marquee { 0%{ transform: translateX(-100%);} 100%{ transform: translateX(300%);} }
        .animate-loa-marquee{ animation: loa-marquee 1.2s cubic-bezier(.4,0,.2,1) infinite; }
      `}</style>
      <style>{`button{cursor:pointer}`}</style>

      <div key={dataVersion} className="max-w-6xl mx-auto space-y-4 lg:space-y-6">
        <section className="py-2 lg:py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className="text-xl lg:text-2xl font-bold leading-tight text-white drop-shadow text-center lg:text-left w-full lg:w-auto">
              로아 아크그리드 젬 장착 도우미
            </h1>
            <div className="flex items-center gap-2 w-auto ml-auto lg:ml-0">
              <button
                type="button"
                onClick={handleExportJson}
                className="h-10 px-3 rounded-xl inline-flex items-center gap-2 bg-white hover:bg-white/90"
                title="현재 입력값을 JSON으로 저장"
              >
                <Download size={16} />
                <span className="hidden md:inline text-sm">저장하기</span>
              </button>
              <button
                type="button"
                onClick={handleImportClick}
                className="h-10 px-3 rounded-xl inline-flex items-center gap-2 bg-white hover:bg-white/90"
                title="JSON에서 불러오기"
              >
                <Upload size={16} />
                <span className="hidden md:inline text-sm">불러오기</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportFile}
              />
              <div className="h-6 w-px bg-white/50 mx-1 hidden sm:block" aria-hidden />
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

        <section className={`${card} p-4 lg:p-6 !mt-2`}>
          <div className="flex items-center gap-2 lg:gap-3">
            <h2 className={sectionTitle}>{CATEGORY_LABEL[category]} 코어 입력</h2>
            <div className="flex items-center gap-2 ml-auto whitespace-nowrap">
              {category === "order" && (
                <Dropdown
                  className="w-32"
                  value={selectedJob}
                  onChange={(val) => {
                    setSelectedJob(val);
                    setCores(prev => prev.map(c => {
                      const groupKey = GROUP_BY_CORE_NAME[c.name];
                      const items = getPresetItems(val, groupKey);
                      const ok = c.preset && items.some(i => i.value === c.preset);
                      return ok ? c : { ...c, preset: (items[0]?.value ?? undefined) };
                    }));
                  }}
                  items={[{ value: "", label: "선택 안함" }, ...JOBS.map(j => ({ value: j, label: j }))]}
                  placeholder="직업 선택"
                />
              )}
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
                      const gradeMax = TARGET_MAX_BY_GRADE[c.grade];
                      const thresholds = (CORE_THRESHOLDS[c.grade] ?? []).filter(v => v <= gradeMax);
                      const targetItems = [{ value: '', label: '(선택 안 함)' }].concat(
                        thresholds.map(v => ({ value: String(v), label: `${v}P` }))
                      );
                      const takenNames = new Set(cores.filter(x => x.id !== c.id).map(x => x.name));
                      let coreNameItems = CORE_NAME_ITEMS.map(it => ({ ...it }));

                      if (category === "order" && selectedJob) {
                        const allowed = getAllowedCoreNameSet(selectedJob);
                        coreNameItems = coreNameItems.map(it => ({
                          ...it,
                          disabled: takenNames.has(it.value) || !allowed.has(it.value)
                        }));
                      } else {
                        coreNameItems = coreNameItems.map(it => ({
                          ...it,
                          disabled: takenNames.has(it.value)
                        }));
                      }

                      return (
                        <PortalAwareDraggable key={c.id} draggableId={c.id} index={idx}>
                          {(prov) => (
                            <div ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps} className={`relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible ${c.id === highlightCoreId ? 'LoA-highlight' : ''}`} style={prov.draggableProps.style}>
                              <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl self-start lg:self-center">#{displayIndexCore(idx)}</div>
                              <div className="flex flex-col min-w-[120px] w-full lg:w-40">
                                <label className={labelCls}>코어 종류</label>
                                <Dropdown className="w-full lg:w-40" value={c.name} onChange={(val) => updateCore(c.id, { name: val })} items={coreNameItems} placeholder="코어명" />
                              </div>
                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>코어 등급</label>
                                <Dropdown
                                  className="w-full lg:w-24"
                                  value={c.grade}
                                  onChange={(val) => {
                                    const g = (val);
                                    const maxAllowed = TARGET_MAX_BY_GRADE[g];
                                    const nextMin =
                                      (c.minThreshold != null && c.minThreshold > maxAllowed)
                                        ? maxAllowed
                                        : c.minThreshold;
                                    updateCore(c.id, { grade: g, minThreshold: nextMin });
                                  }}
                                  items={GRADES.map(g => ({ value: g, label: CORE_LABEL[g] }))}
                                  placeholder="코어 등급"
                                />
                              </div>
                              {category === "order" && selectedJob && (
                                (() => {
                                  const groupKey = GROUP_BY_CORE_NAME[c.name];
                                  const presetItems = getPresetItems(selectedJob, groupKey);
                                  const resolvedPreset =
                                    c.preset && presetItems.some(i => i.value === c.preset)
                                      ? c.preset
                                      : (presetItems[0]?.value ?? "");
                                  return (
                                    <div className="flex flex-col min-w-[160px] w-full lg:w-auto">
                                      <label className={labelCls}>
                                        직업 코어 선택
                                        <CoreEffectInfo
                                          job={selectedJob}
                                          groupKey={groupKey}
                                          preset={resolvedPreset}
                                          grade={c.grade}
                                          category={category}
                                          coreName={c.name}
                                          supply={CORE_SUPPLY[c.grade]}
                                        />
                                      </label>
                                      <Dropdown
                                        className="w-full"
                                        value={resolvedPreset}
                                        onChange={(val) => updateCore(c.id, { preset: val })}
                                        items={presetItems}
                                        placeholder="직업 코어 선택"
                                      />
                                    </div>
                                  );
                                })()
                              )}
                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>공급 의지력</label>
                                <div className="h-10 px-3 rounded-xl border bg-gray-50 inline-flex items-center"><span className="text-primary font-semibold">{supply}</span></div>
                              </div>
                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>목표 포인트</label>
                                <Dropdown className="w-full lg:w-32" value={String(c.minThreshold ?? '')} onChange={(val) => { if (val) updateCore(c.id, { minThreshold: Number(val) }); else updateCore(c.id, { minThreshold: undefined }); }} items={targetItems} placeholder="목표 포인트 선택" />
                              </div>
                              <div className="flex flex-col w-full lg:w-auto">
                                <div className="flex items-center gap-2">
                                  <input id={`enf-${c.id}`} type="checkbox" className="accent-primary" checked={c.enforceMin} onChange={(e) => updateCore(c.id, { enforceMin: e.target.checked })} />
                                  <label htmlFor={`enf-${c.id}`} className="text-sm">선택한 포인트 이상으로 탐색</label>
                                </div>
                                <p className="text-xs text-gray-500 mt-1">체크 해제 시, 목표 포인트와 <br className="hidden lg:block" /><b className="text-primary">정확히 일치하는 조합만 계산</b>합니다.</p>
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

        <section className={`${card} p-4 lg:p-6`}>
          <div
            className={`flex items-center gap-2 lg:gap-3 ${quickAddMode ? '' : 'mb-3'}`}
          >
            <h2 className={sectionTitle}>{CATEGORY_LABEL[category]} 젬 입력</h2>
            <div className="flex items-center gap-2 ml-1">
              <span className="text-xs text-gray-600">빠르게 추가</span>
              <button
                type="button"
                role="switch"
                aria-checked={quickAddMode}
                onClick={() => setQuickAddMode(v => !v)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${quickAddMode ? "bg-[#a399f2]" : "bg-gray-300"
                  }`}
                aria-label="빠르게 추가 모드"
              >
                <span
                  className={`inline-block h-4 w-5 transform rounded-full bg-white shadow transition ${quickAddMode ? "translate-x-5" : "translate-x-1"
                    }`}
                />
              </button>
            </div>
            <div className="flex gap-2 ml-auto whitespace-nowrap">
              {!quickAddMode && (
                <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={addGem} aria-label="젬 추가"><Plus size={16} /><span className="hidden lg:inline"> 젬 추가</span></button>
              )}
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={() => setGems([])} aria-label="전체 삭제"><Trash2 size={16} /><span className="hidden lg:inline"> 전체 삭제</span></button>
            </div>
          </div>
          {quickAddMode && (
            <p className="text-[11px] text-gray-500 mb-3">
              Tab 키로 입력 칸을 이동할 수 있고, Enter 키로 빠르게 추가할 수 있습니다.
            </p>
          )}
          {quickAddMode && (
            <div className="mb-3">
              <QuickAddPad
                focusOnMount
                onAdd={(gem) => {
                  setGems(v => [gem, ...v]);
                  setHighlightGemId(gem.id);
                  setStale(true);
                }}
              />
            </div>
          )}
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
                      min={3}
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
                      min={1}
                      max={5}
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
                    <Dropdown className="w-full lg:w-44" value={g.o1k} onChange={(val) => updateGem(g.id, { o1k: (val) })} items={OPTIONS.map(k => ({ value: k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택" />
                  </div>
                  <div className="flex-1 lg:flex-none">
                    <label className={labelCls}>수치</label>
                    <NumberInput
                      value={g.o1v}
                      onChange={(v) => updateGem(g.id, { o1v: v })}
                      min={1}
                      max={5}
                      step={1}
                      allowFloat={false}
                      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                      inputProps={{ placeholder: "1" }}
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                  <div className="flex-1 lg:flex-none min-w-0">
                    <label className={labelCls}>옵션 2</label>
                    <Dropdown className="w-full lg:w-44" value={g.o2k} onChange={(val) => updateGem(g.id, { o2k: (val) })} items={OPTIONS.map(k => ({ value: k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택" />
                  </div>
                  <div className="flex-1 lg:flex-none">
                    <label className={labelCls}>수치</label>
                    <NumberInput
                      value={g.o2v}
                      onChange={(v) => updateGem(g.id, { o2v: v })}
                      min={1}
                      max={5}
                      step={1}
                      allowFloat={false}
                      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                      inputProps={{ placeholder: "1" }}
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

<section className={`${card} p-4 lg:p-6`}>
  <div className="flex items-center gap-2 lg:gap-3">
    <h2 className={sectionTitle}>유효 옵션 가중치</h2>

  {/* 포지션 선택은 그대로 유지 */}
  <div className={`flex items-center gap-4 text-sm`}>
    <span className="text-xs text-gray-500 hidden sm:block">포지션 선택</span>
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
          setWeights((w) => maskWeightsForRole(DEFAULT_WEIGHTS, "support"));
        }}
        className="accent-primary"
      />
      서포터
    </label>
  </div>
  </div>


<p className="text-[12px] text-gray-600 mt-2">
  가중치는 역할 프리셋으로 고정됩니다. 
</p>

{/* 옵션별 L1~L5 퍼센트 표 (반응형) */}
{(() => {
  const levels = [1, 2, 3, 4, 5];
  const allowSet =
    role && ROLE_KEYS?.[role] && typeof ROLE_KEYS[role].has === "function"
      ? ROLE_KEYS[role]
      : null;

  // 현재 역할에 해당하는 옵션만 노출 (역할 미선택이면 전체)
  const showKeys = OPTIONS.filter((k) => !allowSet || allowSet.has(k));

  const rows = showKeys.map((k) => {
    const values = levels.map((L) => levelValueByRole(role, k, L));
    const isCurve = role === "dealer"; // 딜러는 커브, 서포터는 선형
    return { k, values, isCurve };
  });

  return (
    <div className="mt-3">
      {/* 데스크톱/태블릿: 표 형태 */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="min-w-full text-sm">
          <colgroup>
            <col width="18%" />
            <col width="16%" />
            <col width="16%" />
            <col width="16%" />
            <col width="16%" />
            <col width="16%" />
          </colgroup>
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2">옵션</th>
              <th className="py-2">Lv. 1</th>
              <th className="py-2">Lv. 2</th>
              <th className="py-2">Lv. 3</th>
              <th className="py-2">Lv. 4</th>
              <th className="py-2">Lv. 5</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ k, values, isCurve }) => (
              <tr key={k} className="border-t">
                <td className="py-2">
                  <span className="font-medium">{OPTION_LABELS[k]}</span>
                </td>
                {values.map((v, i) => (
                  <td key={i} className="py-2 tabular-nums">
                    {fmtByRole(role, v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 모바일: 카드 + 칩 형태 */}
      <div className="sm:hidden space-y-2">
        {rows.map(({ k, values, isCurve }) => (
          <div key={k} className="rounded-xl border p-3 bg-white">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{OPTION_LABELS[k]}</div>
              <span
                className={`text-[11px] ${
                  isCurve ? "text-primary" : "text-gray-400"
                }`}
              >
                {isCurve ? "커브" : "선형"}
              </span>
            </div>

            {/* L1~L5 그리드: 세로 스크롤 없이 한눈에 */}
            <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
              {values.map((v, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-gray-50 border"
                >
                  <span className="text-gray-500">Lv. {i + 1}</span>
                  <span className="tabular-nums font-medium">
                    {fmtByRole(role, v)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
})()}

</section>



        <div className="flex flex-col lg:flex-row lg:items-center gap-2">
          {stale && !isComputing && hasCalculated && (
            <span className="inline-block text-[11px] px-3 py-1.5 rounded-lg bg-red-100 text-red-800 border border-red-200 text-center lg:text-left">
              입력값이 변경되었습니다. <b>계산하기</b> 버튼을 눌러 다시 계산해 주세요.
            </span>
          )}
          <div className="flex items-center gap-2 lg:ml-auto w-full lg:w-auto">
            <button
              type="button"
              onClick={calculate}
              disabled={isComputing}
              className="h-10 w-full lg:w-[120px] px-0 lg:px-3 rounded-xl ml-auto whitespace-nowrap inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90"
            >
              {isComputing ? "계산 중…" : "계산하기"}
            </button>
          </div>
        </div>

        <section className={`${card} p-4 lg:p-6`}>
          <h2 className={sectionTitle}>결과</h2>
          <p className="text-xs text-gray-600 mt-2">코어 1개당 최대 <b>젬 4개</b>까지 장착할 수 있습니다.</p>
          {!isComputing && stale && hasCalculated && (
            <p className="text-xs text-red-700 mt-1">입력값이 변경되었습니다. 우측 상단의 <b>계산하기</b> 버튼을 눌러 다시 계산해 주세요.</p>
          )}
          <div className="space-y-4 mt-2">
            {cores.map((c, i) => {
              const supply = CORE_SUPPLY[c.grade];
              const pick = results?.[i];
              const hasResult = !!(pick && pick.list && pick.list.length > 0);
              const minOfGrade = Math.min(...CORE_THRESHOLDS[c.grade]);
              const groupKey = GROUP_BY_CORE_NAME[c.name];
              const presetFallback = (category === "order" && selectedJob)
                ? getPresetItems(selectedJob, groupKey)[0]?.value
                : undefined;
              return (
                <div key={c.id} className="border rounded-xl p-3 bg-white">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="text-base font-semibold">
                      {c.name}
                      {category === "order" && selectedJob && (c.preset || presetFallback) && (
                        <>:&nbsp;{c.preset ?? presetFallback}</>
                      )}&nbsp;
                      <span className="text-sm text-gray-500">({CORE_LABEL[c.grade]})</span>
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
                        <div className={chip}>{role === 'dealer' ? "예상 딜 증가량 (젬) " : role === 'support' ? "유효 옵션 합 " : "유효 옵션 합 "}
                          <span className="font-semibold text-primary">{String(pick.roleSum.toFixed(3))}{role === 'dealer' ? "%" : ""}</span></div>
                      </div>
                    )}
                  </div>
                  {!hasResult ? (
                    <div className="text-sm text-gray-700 mt-2">
                      결과가 없습니다. (이 코어에 배정 가능한 조합이 없거나, 목표 포인트를 만족하지 못합니다.{c.minThreshold == null ? ` / 최소 ${minOfGrade}P 자동 적용중` : ""})
                    </div>
                  ) : (
                    <>
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
                              <th className="px-2 py-2">{role === 'dealer' ? "예상 딜 증가량 (젬) " : role === 'support' ? "유효 옵션 합 " : "유효 옵션 합 "}</th>
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
                                  <td className="px-2 py-2 text-primary">{String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(3))}{role === 'dealer' ? "%" : ""}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="lg:hidden mt-2 space-y-2">
                        {pick.list.map(g => {
                          const gi = gems.findIndex(x => x.id === g.id);
                          const disp = displayIndexGem(gi, gems.length);
                          return (
                            <div key={g.id} className="rounded-xl border p-3 bg-white">
                              <div className="flex items-center justify-between text-sm">
                                <div className="font-medium">#{String(disp)}</div>
                                <div className="text-xs text-primary">{role === 'dealer' ? "예상 딜 증가량 (젬) " : role === 'support' ? "예상 지원 증가량 (젬) " : "유효 옵션 합 "} {String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(3))}%</div>
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

      {isComputing && (
        <div className="fixed inset-0 z-[99999] bg-black/35 backdrop-blur-[1px] flex items-center justify-center px-6">
          <div className="w-full max-w-md rounded-2xl bg-white/95 border shadow p-4">
            <div className="text-sm font-medium text-gray-800 mb-2">{progress.label}</div>

            <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden relative">
              {progress.indeterminate ? (
                <div className="absolute inset-0">
                  <div className="h-full w-1/3 bg-[#a399f2] animate-loa-marquee rounded-full" />
                </div>
              ) : (
                <div
                  className="h-full bg-[#a399f2] transition-[width] duration-100"
                  style={{ width: `${progress.pct}%` }}
                />
              )}
            </div>

            <div className="mt-2 text-right text-xs text-gray-600">
              {progress.indeterminate
                ? (progress.pulse != null ? Number(progress.pulse).toLocaleString() : "")
                : `${progress.pct}%`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
