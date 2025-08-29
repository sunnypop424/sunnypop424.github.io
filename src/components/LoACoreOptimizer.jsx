// src/components/LoACoreOptimizer.jsx
import React, { useEffect, useMemo, useState, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import KakaoAdfit from "./KakaoAdfit";
import './LoACoreOptimizer.css';

/* =============================== 타입(주석용 정의) =============================== */
/** @typedef {"dealer"|"support"} Role */
/** @typedef {"atk"|"add"|"boss"|"brand"|"allyDmg"|"allyAtk"} OptionKey */
/** @typedef {"HERO"|"LEGEND"|"RELIC"|"ANCIENT"} CoreGrade */
/** @typedef {{id:string, will:number|null, point:number|null, o1k:OptionKey, o1v:number|null, o2k:OptionKey, o2v:number|null}} Gem */
/** @typedef {{[k in OptionKey]: number}} Weights */
/** @typedef {{ id:string, name:string, grade:CoreGrade, minThreshold?:number, enforceMin:boolean }} CoreDef */
/** @typedef {{ list: Gem[], totalWill:number, totalPoint:number, thr:number[], roleSum:number, score:number }} ComboInfo */

/* =============================== 상수 정의 =============================== */
const CORE_SUPPLY = { HERO: 7, LEGEND: 11, RELIC: 15, ANCIENT: 17 };
const CORE_THRESHOLDS = {
  HERO: [10],
  LEGEND: [10, 14],
  RELIC: [10, 14, 17, 18, 19, 20],
  ANCIENT: [10, 14, 17, 18, 19, 20],
};
const CORE_LABEL = { HERO: "영웅", LEGEND: "전설", RELIC: "유물", ANCIENT: "고대" };
const GRADES = ["HERO", "LEGEND", "RELIC", "ANCIENT"];

const OPTION_LABELS = {
  atk: "공격력",
  add: "추가 피해",
  boss: "보스 피해",
  brand: "낙인력",
  allyDmg: "아군 피해 강화",
  allyAtk: "아군 공격 강화",
};
const OPTIONS = ["atk","add","boss","brand","allyDmg","allyAtk"];

const ROLE_KEYS = {
  dealer: new Set(["atk","add","boss"]),
  support: new Set(["brand","allyDmg","allyAtk"]),
};
const DEFAULT_WEIGHTS = { atk:1, add:1, boss:1, brand:1, allyDmg:1, allyAtk:1 };

const CORE_NAME_ITEMS = [
  { value: "해 코어", label: "해 코어" },
  { value: "달 코어", label: "달 코어" },
  { value: "별 코어", label: "별 코어" },
];

/* =============================== 유틸/헬퍼 =============================== */

const CORE_ORDER = ["해 코어","달 코어","별 코어"];
function nextAvailableCoreName(existingNames){
  for (const n of CORE_ORDER) if (!existingNames.has(n)) return n;
  return null; // 모두 사용됨
}

const uid = () => Math.random().toString(36).slice(2,9);

function sanitizeWeights(w){
  const base = { ...DEFAULT_WEIGHTS };
  if(!w) return base;
  Object.keys(base).forEach((k)=>{
    const raw = w[k];
    const num = typeof raw === 'number' ? raw : Number(raw);
    base[k] = Number.isFinite(num) && num >= 0 ? num : DEFAULT_WEIGHTS[k];
  });
  return /** @type {Weights} */(base);
}
function scoreGemForRole(g, role, w){
  const keys = role === "dealer" ? ROLE_KEYS.dealer : ROLE_KEYS.support;
  const s1 = keys.has(g.o1k) ? g.o1v * (w[g.o1k] ?? 1) : 0;
  const s2 = keys.has(g.o2k) ? g.o2v * (w[g.o2k] ?? 1) : 0;
  return s1 + s2;
}
function* combinations(arr, k){
  const n = arr.length; if(k>n) return;
  const idx = Array.from({length:k}, (_,i)=>i);
  while(true){
    yield idx.map(i=>arr[i]);
    let p=k-1; while(p>=0 && idx[p]===n-k+p) p--; if(p<0) break; idx[p]++; for(let j=p+1;j<k;j++) idx[j]=idx[j-1]+1;
  }
}
function thresholdsHit(grade, totalPoint){
  const th = CORE_THRESHOLDS[grade];
  return th.filter(t => totalPoint >= t);
}
function scoreCombo(combo, grade, role, weights){
  const totalWill = combo.reduce((s,g)=>s+((g.will ?? 0)),0);
  const totalPoint = combo.reduce((s,g)=>s+((g.point ?? 0)),0);
  const thr = thresholdsHit(grade, totalPoint);
  const roleSum = combo.reduce((s,g)=>s+scoreGemForRole(g, role, weights),0);
  const score = (thr.length*10_000_000) + (totalPoint*10_000) + ((5_000 - totalWill)*10) + roleSum - combo.length;
  return { totalWill, totalPoint, thr, roleSum, score };
}

/* 단일 코어 후보 산출 (통일 정책: 달성 구간이 없으면 결과 없음) */
function enumerateCoreCombos(pool, grade, role, weights, minThreshold, enforceMin){
  const supply = CORE_SUPPLY[grade];
  const W = sanitizeWeights(weights);
  const minOfGrade = Math.min(...CORE_THRESHOLDS[grade]);
  const effMin = minThreshold ?? minOfGrade;
  const effEnforce = enforceMin || minThreshold == null;

  /** @type {ComboInfo[]} */
  const all = [];
  const maxPick = Math.min(4, pool.length);
  for(let k=0;k<=maxPick;k++){
    if(k===0){ all.push({ list:[], totalWill:0, totalPoint:0, thr:[], roleSum:0, score:0 }); continue; }
    for(const combo of combinations(pool, k)){
      const totalWill = combo.reduce((s,g)=>s+(g.will||0),0);
      if(totalWill > supply) continue;
      const { totalPoint, thr, roleSum, score } = scoreCombo(combo, grade, role, W);
      all.push({ list:combo, totalWill, totalPoint, thr, roleSum, score });
    }
  }
  all.sort((a,b)=>b.score-a.score);

  let filtered;
  if(effEnforce){
    filtered = all.filter(ci => {
      const maxThr = Math.max(0, ...ci.thr);
      return ci.list.length>0 && maxThr >= (effMin ?? 0);
    });
  }else{
    filtered = all.filter(ci => ci.list.length>0 && ci.thr.length>0);
  }
  if(filtered.length===0){
    return [{ list:[], totalWill:0, totalPoint:0, thr:[], roleSum:0, score:0 }];
  }
  return filtered.slice(0,200);
}


/* ===== 라운드 로빈 타깃 업그레이드 그리디 ===== */
function optimizeRoundRobinTargets(cores, pool, role, weights, perCoreLimit = 80) {
  const W = sanitizeWeights(weights);

  const thresholdsOf = (grade) => CORE_THRESHOLDS[grade];
  const minOf = (grade) => Math.min(...thresholdsOf(grade));
  const nextThreshold = (grade, current) => {
    const arr = thresholdsOf(grade);
    for (let i=0;i<arr.length;i++){
      if (arr[i] > (current ?? -Infinity)) return arr[i];
    }
    return null;
  };
  const bestMinHit = (cands, target) => {
    // target 이상 달성 조합 중 "딱 넘기는" 걸 우선
    const ok = cands.filter(ci => (ci.thr.length ? Math.max(...ci.thr) : 0) >= target);
    if (ok.length === 0) return null;
    // totalPoint ASC → totalWill ASC → roleSum DESC → score DESC
    ok.sort((a,b)=>{
      if (a.totalPoint !== b.totalPoint) return a.totalPoint - b.totalPoint;
      if (a.totalWill  !== b.totalWill ) return a.totalWill  - b.totalWill;
      if (a.roleSum    !== b.roleSum   ) return b.roleSum    - a.roleSum;
      return b.score - a.score;
    });
    return ok[0];
  };
  const bestScore = (cands) => cands.sort((a,b)=>b.score-a.score)[0] || null;

  // 코어별 현재 pick과 남은 젬 풀
  /** @type {ComboInfo[]} */
  const picks = Array.from({length: cores.length}, () => ({ list:[], totalWill:0, totalPoint:0, thr:[], roleSum:0, score:0 }));
  let remaining = pool.slice();

  // 후보 생성기 (풀과 조건에 따라 매번 생성)
  const candidatesFor = (core, gemPool) => {
    const list = enumerateCoreCombos(gemPool, core.grade, role, W, core.minThreshold, core.enforceMin)
      .filter(ci => ci.list.length > 0)
      .sort((a,b)=>b.score-a.score)
      .slice(0, perCoreLimit);
    return list;
  };

  // 젬 사용/반납 헬퍼
  const removeUsed = (gemPool, combo) => {
    if (!combo || !combo.list) return gemPool;
    const used = new Set(combo.list.map(g=>g.id));
    return gemPool.filter(g=>!used.has(g.id));
  };
  const returnUsed = (gemPool, combo) => {
    if (!combo || !combo.list) return gemPool;
    // 이미 들어있는지 체크해서 중복 삽입 방지
    const inPool = new Set(gemPool.map(g=>g.id));
    const add = combo.list.filter(g=>!inPool.has(g.id));
    return gemPool.concat(add);
  };

  // 1) 1라운드: 강제 최소(effMin) 먼저 전부 달성 (가능하면)
  for (let i=0;i<cores.length;i++){
    const c = cores[i];
    const effMin = (c.minThreshold ?? minOf(c.grade));
    const cands = candidatesFor(c, remaining);

    let choice = null;
    if (c.enforceMin) {
      choice = bestMinHit(cands, effMin) || bestScore(cands);
    } else {
      // 비강제: 점수 높은 거
      choice = bestScore(cands);
    }
    picks[i] = choice || { list:[], totalWill:0, totalPoint:0, thr:[], roleSum:0, score:0 };
    remaining = removeUsed(remaining, picks[i]);
  }

  // 2) 모두 목표(effMin) 달성했는지 확인
  const allMinOk = cores.every((c, i) => {
    if (!c.enforceMin) return true; // 비강제는 패스
    const effMin = (c.minThreshold ?? minOf(c.grade));
    const maxThr = picks[i].thr.length ? Math.max(...picks[i].thr) : 0;
    return maxThr >= effMin;
  });

  if (!allMinOk) {
    // 최소도 안 되는 상황이면 여기서 종료(현 그리디 결과 반환)
    return { picks };
  }

  // 3) 라운드 로빈 업그레이드: 1→2→3 코어 다음 구간, 그 다음 라운드엔 다다음 구간…
  let progressed = true;
  while (progressed) {
    progressed = false;

    for (let i=0;i<cores.length;i++){
      const c = cores[i];
      // 현재 달성 구간(없으면 0)
      const curMax = picks[i].thr.length ? Math.max(...picks[i].thr) : 0;
      const nxt = nextThreshold(c.grade, curMax);
      if (nxt == null) continue; // 더 이상 업그레이드 구간 없음

      // 이 코어가 쓰던 젬을 잠시 반환하고, 업그레이드 시도
      let poolWithRefund = returnUsed(remaining, picks[i]);
      const cands = candidatesFor(c, poolWithRefund);
      const upgrade = bestMinHit(cands, nxt);

      if (upgrade) {
        // 성공: 새 픽으로 교체
        //  - 기존 픽 젬은 refund 상태에서 제거되었을 것이므로, 남은 풀은 새 픽 사용분만 빼면 됨
        picks[i] = upgrade;
        // poolWithRefund에서 새 픽 사용 젬을 제거 → 그게 새로운 remaining
        const used = new Set(upgrade.list.map(g=>g.id));
        remaining = poolWithRefund.filter(g=>!used.has(g.id));
        progressed = true;
      } else {
        // 실패: 반환했던 걸 되돌리기(= 아무 변화 없이 유지)
        // remaining은 그대로(환불 전 상태)여야 하므로, 아무 것도 건드리지 않음
        // (위에서 poolWithRefund를 지역변수로만 썼기 때문에 remaining 불변)
      }
    }
  }

  return { picks };
}



/* =============================== Portal-aware Draggable =============================== */
const dragPortal = typeof document !== "undefined" ? document.body : null;

function PortalAwareDraggable({ draggableId, index, children }) {
  return (
    <Draggable draggableId={draggableId} index={index}>
      {(provided, snapshot) => {
        // 자식이 function이면 provided/snapshot을 넘겨 "자식이 직접" props를 붙이게 함
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
 function useOnClickOutside(refs, handler){
   const refsArray = React.useMemo(
     () => (Array.isArray(refs) ? refs : [refs]),
     // refs가 동일 ref 객체를 재사용하므로 이 deps로 충분
     [refs]
   );
   // 최신 handler를 참조하도록 ref로 보관
   const handlerRef = React.useRef(handler);
   React.useEffect(() => { handlerRef.current = handler; }, [handler]);

   React.useEffect(() => {
     const listener = (e) => {
       if (refsArray.some(r => r?.current && r.current.contains(e.target))) return;
       handlerRef.current?.(e);
     };
     // click 시점(캡처링)으로: 내부 onClick 먼저 실행되도록
     document.addEventListener('click', listener, true);
     return ()=> document.removeEventListener('click', listener, true);
   }, [refsArray]);
 }
function Dropdown({ value, items, onChange, placeholder, className }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const menuPos = useRef({ top: 0, left: 0, width: 0 });
  const [, forceTick] = useState(0);   // 포지션 리렌더 트리거(값은 사용 안 함)

  // 전역 close-all-dropdowns 이벤트 받으면 닫기
  useEffect(() => {
    const h = () => setOpen(false);
    window.addEventListener('close-all-dropdowns', h);
    return () => window.removeEventListener('close-all-dropdowns', h);
  }, []);

  // 버튼/메뉴 외부 클릭 시 닫기 (둘 다 제외)
  useOnClickOutside([btnRef, menuRef], () => setOpen(false));

  // 열릴 때 버튼 위치 측정 → 고정 포지션으로 포탈 렌더
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    menuPos.current = {
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    };
    forceTick((v) => v + 1);

    const onScroll = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      menuPos.current = {
        top: r.bottom + 4,
        left: r.left,
        width: r.width,
      };
      forceTick((v) => v + 1);
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
        style={{
          position: "fixed",
          top: menuPos.current.top,
          left: menuPos.current.left,
          width: menuPos.current.width,
          zIndex: 9999, // 최상단
        }}
        className="rounded-xl border bg-white shadow-lg overflow-auto max-h-60"
      >
        {items.map((it) => (
          <li key={String(it.value)}>
            <button
              type="button"
              onClick={() => {
                if (it.disabled) return;         // 비활성 항목 클릭 무시
                onChange(it.value);
                setOpen(false);
              }}
              aria-disabled={it.disabled ? true : undefined}
              className={`w-full text-left px-3 py-2 text-sm ${
                it.disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-gray-50"
              } ${it.value === value ? "bg-gray-100" : ""}`}
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
        onClick={() => setOpen((v) => !v)}
        className="min-w-0 h-10 w-full inline-flex items-center justify-between rounded-xl border px-3 bg-white hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50"
      >
        <span className="truncate text-sm">
          {selected ? selected.label : placeholder || "선택"}
        </span>
        <span className="text-gray-500 text-sm select-none">
          {open ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
        </span>
      </button>
      {open && createPortal(menu, document.body)}
    </div>
  );
}

function useToasts(){
  const [toasts, setToasts] = useState([]);
  const push = (msg) => {
    const id = uid();
    setToasts(t=>[...t, { id, msg }]);
    setTimeout(()=> setToasts(t=> t.filter(x=>x.id!==id)), 2600);
  };
  const remove = (id) => setToasts(t=> t.filter(x=> x.id!==id));
  return { toasts, push, remove };
}
function ToastStack({ toasts, onClose }){
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none px-4">
      <AnimatePresence>
        {toasts.map(t=> (
          <motion.div key={t.id} initial={{opacity:0, scale:0.98}} animate={{opacity:1, scale:1}} exit={{opacity:0, scale:0.98}} transition={{type:'spring', stiffness:380, damping:28}} className="pointer-events-auto overflow-hidden rounded-2xl border shadow-lg bg-amber-50/95 border-amber-200 text-amber-900 backdrop-blur px-4 py-3 flex items-center gap-3 min-w-[320px] max-w-[90vw]">
            <div className="text-sm flex-1">{t.msg}</div>
            <button className="text-sm font-medium text-amber-900/80 hover:text-amber-900 self-center" onClick={()=>onClose(t.id)} aria-label="닫기">닫기</button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function NumberInput({
  value,
  onChange,          // (number|null)=>void
  min,
  max,
  step = 1,
  allowFloat = false,
  zeroOnBlur = true, // blur 시 빈값을 0(or min)으로 보정할지
  className = "",
  inputProps = {},
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

  // 휠로 값 바뀌는 사고 방지(선택)
  const handleWheel = (e) => e.currentTarget.blur();

  return (
    <input
      type="number"                     // ← 스핀/키보드 ↑↓ 유지
      inputMode={allowFloat ? "decimal" : "numeric"}
      step={step}
      min={min}
      max={max}
      value={inner}                     // ← "" 허용 (빈 입력 유지)
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") {
          setInner("");
          onChange?.(null);             // 입력 중 빈값은 null로 보존
          return;
        }
        // number 타입은 브라우저가 숫자형 문자열만 넣어줌(예: "1", "1.2", "1e2")
        setInner(v);
        const num = Number(v);
        if (Number.isFinite(num)) {
          onChange?.(allowFloat ? num : Math.trunc(num)); // 입력 중에도 숫자 전달(필요하면 null로 바꿔도 됨)
        } else {
          onChange?.(null);
        }
      }}
      onBlur={() => {
        const n = normalizeOnBlur(inner);          // blur 시에만 확정/보정
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
export default function LoACoreOptimizer(){

  useEffect(() => {
    document.title = "로아 아크그리드 젬 장착 헬퍼";
  }, []);

  const [role, setRole] = useState("dealer");
  const [weights, setWeights] = useState({...DEFAULT_WEIGHTS});
  const [highlightCoreId, setHighlightCoreId] = useState(null);   // 최근 추가 코어 ID
  const [highlightGemId, setHighlightGemId] = useState(null); 
  const [cores, setCores] = useState([]);
  const [gems, setGems] = useState([]);
  const { toasts, push, remove } = useToasts();

  
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


  const { picks: priorityPicks } = useMemo(
    () => optimizeRoundRobinTargets(cores, gems, role, weights, /* perCoreLimit */ 80),
    [cores, gems, role, weights]
  );
  const resetWeights = ()=> setWeights({...DEFAULT_WEIGHTS});
  const addGem = ()=> {
    const id = uid();
    setGems(v => [{ id, will: null, point: null, o1k:"atk", o1v:0, o2k:"add", o2v:0 }, ...v]);
    setHighlightGemId(id);
  };

  const removeGem = (id)=> {
    setGems(v=> v.filter(g=> g.id!==id));
    if (highlightGemId === id) setHighlightGemId(null);
  };
  const updateGem = (id, patch) => setGems(v => v.map(g => g.id === id ? { ...g, ...patch } : g));

  const addCore = ()=> setCores(cs=>{
    if (cs.length >= 3) { push("코어는 최대 3개까지 추가할 수 있어요."); return cs; }
    const existing = new Set(cs.map(c=>c.name));
    const nextName = nextAvailableCoreName(existing);
    if (!nextName) { push("해/달/별 코어가 모두 추가되어 있어요."); return cs; }
    const id = uid();
    setHighlightCoreId(id);
    return [
      { id, name: nextName, grade: "RELIC", minThreshold: undefined, enforceMin: false },
      ...cs
    ];
  });
  const removeCore = (id)=> {
    setCores(cs=> cs.length<=0 ? cs : cs.filter(c=> c.id!==id));
    if (highlightCoreId === id) setHighlightCoreId(null);
  };
  const updateCore = (id, patch)=> setCores(cs=>{
    if ('name' in patch) {
      const dup = cs.some(c => c.id !== id && c.name === patch.name);
      if (dup) {
        push(`${patch.name}는 이미 존재하는 코어입니다`);
        return cs; // 변경 취소
      }
    }
    return cs.map(c=> c.id===id? {...c, ...patch}: c);
  });

  // Drag state (for backdrop blur toggle)
  const [dragging, setDragging] = useState(false);

  // DnD: 코어 순서가 곧 우선순위(위쪽이 더 높음)
const onDragStart = () => {
  requestAnimationFrame(() => setDragging(true));
  // 드래그 시작하면 모든 드롭다운 닫기 이벤트 발송
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

  // UI tokens (모바일 최적화 포함)
  const smallFieldBase = "h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white";
  const sectionTitle = "text-base font-semibold whitespace-nowrap";
  const card = "bg-white rounded-2xl shadow-sm";
  const chip = "px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs lg:text-[13px]";
  const labelCls = "block text-xs text-gray-500 mb-1";

  // 인덱스 표기: 코어(위→1), 젬(아래→1)
  const displayIndexCore = (idx) => idx + 1;
  const displayIndexGem = (idx, total) => total - idx;

  // ===== Self-tests (non-blocking) =====
  useEffect(() => {
    function runSelfTests(){
      try {
        const w = sanitizeWeights({ atk: 2, add: "3", boss: -1 });
        console.assert(w.atk === 2 && w.add === 3 && w.boss === 1, "sanitizeWeights failed");
        const gem = { id:"t1", will:1, point:1, o1k:"atk", o1v:2, o2k:"brand", o2v:3 };
        console.assert(scoreGemForRole(gem, "dealer", w) === 2 * w.atk, "scoreGemForRole dealer failed");
        console.assert(scoreGemForRole(gem, "support", w) === 3 * (w.brand ?? 1), "scoreGemForRole support failed");
        console.assert(thresholdsHit("RELIC", 20).includes(20) && thresholdsHit("RELIC", 9).length === 0, "thresholdsHit failed");
        const cA = scoreCombo([gem], "RELIC", "dealer", w);
        const cB = scoreCombo([gem, { ...gem, id:"t2", will:0, point:10 }], "RELIC", "dealer", w);
        console.assert(cB.score >= cA.score, "scoreCombo monotonicity failed");
        console.log("✅ Self-tests passed");
      } catch (e) {
        console.warn("❌ Self-tests encountered an error", e);
      }
    }
    runSelfTests();
  }, []);

  return (
    <div className="min-h-screen text-gray-900 p-4 lg:p-6" style={{
      backgroundImage: "linear-gradient(125deg, #85d8ea, #a399f2)",
      backgroundAttachment: 'fixed'
    }}>
      {/* 전역 프라이머리 컬러 토큰 & 유틸 */}
      <style>{`
        :root{ --primary:#a399f2; --grad:linear-gradient(125deg,#85d8ea,#a399f2); }
        .btn-primary{ background: #000000; color:#fff; border:none; }
        .text-primary{ color:#a399f2; }
        .accent-primary{ accent-color:#a399f2; }
        .ring-primary:focus{ outline:none; box-shadow:0 0 0 2px rgba(163,153,242,.35); }
      `}</style>

      {/* 모든 버튼 커서 포인터 */}
      <style>{`button{cursor:pointer}`}</style>

      <div className="max-w-6xl mx-auto space-y-4 lg:space-y-6">
        {/* 타이틀 + 포지션(우측) */}
        <section className="py-2 lg:py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className="text-xl lg:text-2xl font-bold leading-tight text-white drop-shadow text-center lg:text-left w-full lg:w-auto">로아 아크그리드 젬 장착 헬퍼</h1>
            <div className="flex gap-2 w-auto ml-auto lg:ml-0">
              <button onClick={()=>setRole('dealer')} className={`min-w-[80px] h-8 inline-flex items-center justify-center gap-1 px-3 rounded-xl w-full lg:w-auto ${role==='dealer'? 'bg-white':'bg-white opacity-50'}`}>
                딜러
              </button>
              <button onClick={()=>setRole('support')} className={`min-w-[80px] h-8 inline-flex items-center justify-center gap-1 px-3 rounded-xl w-full lg:w-auto ${role==='support'? 'bg-white':'bg-white opacity-50'}`}>
                서포터
              </button>
            </div>
          </div>
        </section>

        {/* 코어 입력 (DnD 우선순위) */}
        <section className={`${card} p-4 lg:p-6 !mt-2 ${dragging ? '' : 'backdrop-blur'}`}>
          <div className="flex items-center gap-2 lg:gap-3">
            <h2 className={sectionTitle}>코어 입력</h2>
            <div className="flex items-center gap-2 ml-auto whitespace-nowrap">
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90 ring-primary" onClick={addCore} aria-label="코어 추가"><Plus size={16}/><span className="hidden lg:inline"> 코어 추가</span></button>
            </div>
          </div>
          <p className="hidden lg:block text-xs text-gray-600">드래그 앤 드롭으로 순서를 바꾸세요. <b>우선순위가 높은 항목을 1번(맨 위)으로 배치하세요.</b></p>
          <p className="block lg:hidden text-xs text-gray-600">화살표로 순서를 바꾸세요. <b>우선순위가 높은 항목을 1번(맨 위)으로 배치하세요.</b></p>

          <div className="mt-3">
            <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
              <Droppable droppableId="cores-droppable" ignoreContainerClipping={true}>
                {(provided)=> (
                  <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-3">
                    {cores.map((c, idx)=> {
                      const supply = CORE_SUPPLY[c.grade];
                      const targetItems = [{ value: '', label: '(선택 안 함)' }].concat(
                        CORE_THRESHOLDS[c.grade].map(v => ({ value: String(v), label: `${v}P 이상` }))
                      );
                      const takenNames = new Set(cores.filter(x=>x.id!==c.id).map(x=>x.name));
                      const coreNameItems = CORE_NAME_ITEMS.map(it => ({
                        ...it,
                        disabled: takenNames.has(it.value)
                      }));
                      const minOfGrade = Math.min(...CORE_THRESHOLDS[c.grade]);
                      return (
                        <PortalAwareDraggable key={c.id} draggableId={c.id} index={idx}>
                          {(prov)=> (
                            <div ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps} className={`relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible ${c.id===highlightCoreId ? 'LoA-highlight' : ''}`} style={prov.draggableProps.style}>
                              {/* Index badge - 모바일 좌측 정렬, 데스크톱 중앙 정렬 */}
                              <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl self-start lg:self-center">#{displayIndexCore(idx)}</div>

                              <div className="flex flex-col min-w-[120px] w-full lg:w-40">
                                <label className={labelCls}>코어 종류</label>
                                <Dropdown className="w-full lg:w-40" value={c.name} onChange={(val)=>updateCore(c.id,{name: val})} items={coreNameItems} placeholder="코어명"/>
                              </div>

                              <div className="flex flex-col min-w-[160px] w-full lg:w-auto">
                                <label className={labelCls}>코어 등급</label>
                                <Dropdown className="w-full lg:w-40" value={c.grade} onChange={(val)=>updateCore(c.id,{grade: /** @type {CoreGrade} */(val)})} items={GRADES.map(g=>({value:g, label: CORE_LABEL[g]}))} placeholder="코어 등급"/>
                              </div>

                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>공급 의지력</label>
                                <div className="h-10 px-3 rounded-xl border bg-gray-50 inline-flex items-center"><span className="text-primary font-semibold">{supply}</span></div>
                              </div>

                              <div className="flex flex-col w-full lg:w-auto">
                                <label className={labelCls}>목표 구간</label>
                                <Dropdown className="w-full lg:w-40" value={String(c.minThreshold ?? '')} onChange={(val)=>{ if(val) updateCore(c.id,{minThreshold:Number(val), enforceMin:true}); else updateCore(c.id,{minThreshold:undefined, enforceMin:false}); }} items={targetItems} placeholder="구간"/>
                              </div>

                              <div className="flex flex-col w-full lg:w-auto">
                                <div className="flex items-center gap-2">
                                  <input id={`enf-${c.id}`} type="checkbox" className="accent-primary" checked={c.enforceMin} onChange={(e)=>updateCore(c.id,{enforceMin:e.target.checked})}/>
                                  <label htmlFor={`enf-${c.id}`} className="text-sm">목표 구간 강제</label>
                                </div>
                                <p className="text-xs text-gray-500 mt-1">선택 안 함이면 내부적으로 <br className="hidden lg:block"/>최소 구간 <b className="text-primary">{minOfGrade}P</b>을 기본 목표로 적용합니다.</p>
                              </div>

                              {/* 모바일: 순서 버튼 + 삭제 버튼 묶음 */}
                              <div className="lg:ml-auto lg:static absolute top-2 right-2 flex items-center gap-1">
                                <div className="hidden lg:hidden" />
                                <div className="flex lg:hidden flex-row gap-1 mr-1">
                                  <button className="h-8 w-8 rounded-lg border inline-flex items-center justify-center bg-white" onClick={()=>moveCoreUp(idx)} aria-label="위로"><ChevronUp size={16}/></button>
                                  <button className="h-8 w-8 rounded-lg border inline-flex items-center justify-center bg-white" onClick={()=>moveCoreDown(idx)} aria-label="아래로"><ChevronDown size={16}/></button>
                                </div>
                                <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border-0 lg:border text-red-600 inline-flex items-center justify-center gap-2" onClick={()=>removeCore(c.id)} disabled={cores.length<=0} aria-label="코어 삭제"><Trash2 size={16}/><span className="hidden lg:inline"> 삭제</span></button>
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
            {cores.length===0 && <div className="text-sm text-gray-700 p-2 text-center">코어를 추가하세요. (최대 3개의 코어까지 추가할 수 있습니다)</div>}
          </div>
        </section>

        {/* 젬 입력 */}
        <section className={`${card} p-4 lg:p-6 ${dragging ? '' : 'backdrop-blur'}`}>
          <div className="flex items-center gap-2 lg:gap-3 mb-3">
            <h2 className={sectionTitle}>젬 입력</h2>
            <div className="flex gap-2 ml-auto whitespace-nowrap">
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={addGem} aria-label="젬 추가"><Plus size={16}/><span className="hidden lg:inline"> 젬 추가</span></button>
              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={()=>setGems([])} aria-label="전체 삭제"><Trash2 size={16}/><span className="hidden lg:inline"> 전체 삭제</span></button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {gems.map((g,idx)=> (
              <div key={g.id} className={`relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-center border rounded-xl p-3 overflow-visible min-w-0 bg-white ${g.id===highlightGemId ? 'LoA-highlight' : ''}`}>
                <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl flex-none">#{displayIndexGem(idx, gems.length)}</div>

                {/* 필요 의지력 + 포인트 */}
                <div className="w-full lg:w-auto flex flex-row gap-2 lg:gap-3 flex-1 lg:flex-none">
                  <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
                    <label className={labelCls}>필요 의지력</label>
                    <NumberInput
                      value={g.will }
                      onChange={(v)=>updateGem(g.id,{will: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className={`${smallFieldBase} w-full lg:w-24`}
                      inputProps={{ title:"의지력", placeholder:"의지력" }}
                    />
                  </div>
                  <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
                    <label className={labelCls}>(질서/혼돈)포인트</label>
                    <NumberInput
                      value={g.point }
                      onChange={(v)=>updateGem(g.id,{point: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className={`${smallFieldBase} w-full lg:w-24`}
                      inputProps={{ title:"포인트", placeholder:"포인트" }}
                    />
                  </div>
                </div>

                {/* 옵션 1 */}
                <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                  <div className="flex-1 lg:flex-none min-w-0">
                    <label className={labelCls}>옵션 1</label>
                    <Dropdown className="w-full lg:w-44" value={g.o1k} onChange={(val)=>updateGem(g.id,{o1k: /** @type {OptionKey} */(val)})} items={OPTIONS.map(k=> ({ value:k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택"/>
                  </div>
                  <div className="flex-1 lg:flex-none">
                    <label className={labelCls}>수치</label>
                    <NumberInput
                      value={g.o1v }
                      onChange={(v)=>updateGem(g.id,{o1v: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                      inputProps={{ placeholder:"0" }}
                    />
                  </div>
                </div>

                {/* 옵션 2 */}
                <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                  <div className="flex-1 lg:flex-none min-w-0">
                    <label className={labelCls}>옵션 2</label>
                    <Dropdown className="w-full lg:w-44" value={g.o2k} onChange={(val)=>updateGem(g.id,{o2k: /** @type {OptionKey} */(val)})} items={OPTIONS.map(k=> ({ value:k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택"/>
                  </div>
                  <div className="flex-1 lg:flex-none">
                    <label className={labelCls}>수치</label>
                    <NumberInput
                      value={g.o2v }
                      onChange={(v)=>updateGem(g.id,{o2v: v })}
                      min={0}
                      max={9}
                      step={1}
                      allowFloat={false}
                      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white w-full lg:w-20"
                      inputProps={{ placeholder:"0" }}
                    />
                  </div>
                </div>

                <div className="lg:static absolute top-2 right-2 lg:top-auto lg:right-auto lg:ml-auto w-auto lg:flex-none">
                  <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border-0 lg:border text-red-600 inline-flex items-center justify-center gap-2" onClick={()=>removeGem(g.id)} aria-label="젬 삭제"><Trash2 size={16}/><span className="hidden lg:inline"> 삭제</span></button>
                </div>
              </div>
            ))}
            {gems.length===0 && <div className="text-sm text-gray-700 p-2 text-center">젬을 추가하세요.</div>}
          </div>
        </section>

        {/* 유효옵션 가중치 */}
        <section className={`${card} p-4 lg:p-6 ${dragging ? '' : 'backdrop-blur'}`}>
          <div className="flex items-center gap-2 lg:gap-3">
            <h2 className={sectionTitle}>유효옵션 가중치</h2>
            <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border ml-auto whitespace-nowrap inline-flex items-center justify-center gap-2 bg-white hover:bg-white/90" onClick={resetWeights} aria-label="가중치 초기화"><RotateCcw size={16}/><span className="hidden lg:inline"> 가중치 초기화</span></button>
          </div>
          <div className="mt-2">
            <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-nowrap text-sm min-w-0">
              {OPTIONS.map((k) => (
                <div key={k} className="bg-gray-50 border rounded-xl px-2 py-2 w-full lg:w-1/6 min-w-[120px]">
                  <label className={labelCls}>{OPTION_LABELS[k]}</label>
                  <NumberInput
                    value={weights[k] }
                    onChange={(v)=> setWeights((w)=> ({ ...w, [k]: (v ) }))}
                    min={0}
                    max={5}
                    step={0.0001}
                    allowFloat={true}
                    className="h-10 w-full px-2 rounded-md border bg-white focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50"
                  />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 결과 */}
        <section className={`${card} p-4 lg:p-6 ${dragging ? '' : 'backdrop-blur'}`}>
          <h2 className={sectionTitle}>결과</h2>
          <p className="text-xs text-gray-600 mt-2">코어 1개당 최대 <b>젬 4개</b>까지 장착할 수 있습니다.</p>
          <div className="space-y-4 mt-2">
            {cores.map((c,i)=> {
              const supply = CORE_SUPPLY[c.grade];
              const pick = priorityPicks?.[i];
              const hasResult = !!(pick && pick.list && pick.list.length>0);
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
                        <div className={chip}>유효 옵션 합(<span className="font-semibold">{role==='dealer'?"딜러":"서폿"}</span>) <span className="font-semibold text-primary">{String(pick.roleSum.toFixed(4))}</span></div>
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
                          <thead>
                            <tr className="text-left text-gray-500">
                              <th className="px-2 py-2">선택</th>
                              <th className="px-2 py-2">의지력</th>
                              <th className="px-2 py-2">포인트</th>
                              <th className="px-2 py-2">옵션1</th>
                              <th className="px-2 py-2">옵션2</th>
                              <th className="px-2 py-2">유효합</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pick.list.map(g=> {
                              const gi = gems.findIndex(x=>x.id===g.id);
                              const disp = displayIndexGem(gi, gems.length);
                              return (
                                <tr key={g.id} className="border-t">
                                  <td className="px-2 py-2">#{String(disp)}</td>
                                  <td className="px-2 py-2">{String(g.will ?? 0)}</td>
                                  <td className="px-2 py-2">{String(g.point ?? 0)}</td>
                                  <td className="px-2 py-2">{OPTION_LABELS[g.o1k]} {String(g.o1v)}</td>
                                  <td className="px-2 py-2">{OPTION_LABELS[g.o2k]} {String(g.o2v)}</td>
                                  <td className="px-2 py-2 text-primary">{String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(4))}</td>
                                </tr>
                              );
                            }) }
                          </tbody>
                        </table>
                      </div>
                      {/* Mobile cards */}
                      <div className="lg:hidden mt-2 space-y-2">
                        {pick.list.map(g => {
                          const gi = gems.findIndex(x=>x.id===g.id);
                          const disp = displayIndexGem(gi, gems.length);
                          return (
                            <div key={g.id} className="rounded-xl border p-3 bg-white">
                              <div className="flex items-center justify-between text-sm">
                                <div className="font-medium">#{String(disp)}</div>
                                <div className="text-xs text-primary">유효합 {String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(2))}</div>
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

      <ToastStack toasts={toasts} onClose={remove}/>

      <div className="mt-6">
        <KakaoAdfit />
      </div>
    </div>
  );
}
