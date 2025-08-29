import React, { useEffect, useMemo, useState, useRef, Suspense } from "react";
import { Plus, Trash2, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
/* =============================== 타입(주석용 정의) =============================== */
/** @typedef {"dealer"|"support"} Role */
/** @typedef {"atk"|"add"|"boss"|"brand"|"allyDmg"|"allyAtk"} OptionKey */
/** @typedef {"HERO"|"LEGEND"|"RELIC"|"ANCIENT"} CoreGrade */
/** @typedef {{id:string, will:number, point:number, o1k:OptionKey, o1v:number, o2k:OptionKey, o2v:number}} Gem */
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
  const totalWill = combo.reduce((s,g)=>s+(g.will||0),0);
  const totalPoint = combo.reduce((s,g)=>s+(g.point||0),0);
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
/* 우선순위 기반 최적화(그리디): ★현재 배열 순서★(위→아래)가 우선순위 */
function optimizeByPriority(cores, pool, role, weights){
  const W = sanitizeWeights(weights);
  const order = cores.map((c,i)=>({ i, pr:i })).sort((a,b)=>a.pr-b.pr);
  /** @type {ComboInfo[]} */
  const picks = Array.from({length: cores.length}, ()=>({ list:[], totalWill:0, totalPoint:0, thr:[], roleSum:0, score:0 }));
  let remaining = pool.slice();
  for(const { i } of order){
    const c = cores[i];
    const cand = enumerateCoreCombos(remaining, c.grade, role, W, c.minThreshold, c.enforceMin);
    const choice = cand.find(ci=>ci.list.length>0) || cand[0] || { list:[], totalWill:0, totalPoint:0, thr:[], roleSum:0, score:0 };
    picks[i] = choice;
    const chosenIds = new Set(choice.list.map(g=>g.id));
    remaining = remaining.filter(g=>!chosenIds.has(g.id));
  }
  return { picks };
}
/* =============================== 공통 UI 훅/컴포넌트 =============================== */
function useOnClickOutside(ref, handler){
  React.useEffect(()=>{
    function listener(e){ if(!ref.current || ref.current.contains(e.target)) return; handler(e); }
    document.addEventListener('mousedown', listener); document.addEventListener('touchstart', listener);
    return ()=>{ document.removeEventListener('mousedown', listener); document.removeEventListener('touchstart', listener); };
  },[ref, handler]);
}
function Dropdown({ value, items, onChange, placeholder, className }){
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOnClickOutside(ref, ()=> setOpen(false));
  const selected = items.find(i=> i.value === value);
  return (
    <div ref={ref} className={`relative min-w-0 overflow-visible ${className||''}`}>
      <button type="button" onClick={()=>setOpen(v=>!v)} className="min-w-0 h-10 w-full inline-flex items-center justify-between rounded-xl border px-3 bg-white hover:bg-gray-50 transition">
        <span className="truncate text-sm">{selected? selected.label : (placeholder||'선택')}</span>
        <span className="text-gray-500 text-sm select-none">{open? '▴':'▾'}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul initial={{opacity:0, y:-4}} animate={{opacity:1, y:0}} exit={{opacity:0, y:-4}} transition={{duration:0.12}} className="absolute z-50 mt-1 w-full rounded-xl border bg-white shadow-lg overflow-auto max-h-60">
            {items.map((it)=> (
              <li key={String(it.value)}>
                <button type="button" onClick={()=>{ onChange(it.value); setOpen(false); }} className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${it.value===value? 'bg-gray-100':''}`}>
                  <span className="block truncate">{it.label}</span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
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
/* =============================== Optimizer (탭 1) =============================== */
function ArkGridOptimizer(){
  const [role, setRole] = useState("dealer");
  const [weights, setWeights] = useState({...DEFAULT_WEIGHTS});
  const [cores, setCores] = useState([
    { id: uid(), name: "해 코어", grade: "RELIC", minThreshold: undefined, enforceMin: false }
  ]);
  const [gems, setGems] = useState([
    { id: uid(), will: 4, point: 5, o1k:"atk", o1v:3, o2k:"add", o2v:5 },
    { id: uid(), will: 5, point: 5, o1k:"atk", o1v:5, o2k:"brand", o2v:5 },
    { id: uid(), will: 5, point: 5, o1k:"allyDmg", o1v:5, o2k:"brand", o2v:5 },
    { id: uid(), will: 3, point: 4, o1k:"boss", o1v:4, o2k:"add", o2v:2 },
  ]);
  const { toasts, push, remove } = useToasts();
  const { picks: priorityPicks } = useMemo(()=> optimizeByPriority(cores, gems, role, weights), [cores, gems, role, weights]);
  const resetWeights = ()=> setWeights({...DEFAULT_WEIGHTS});
  const addGem = ()=> setGems(v=>[
    { id: uid(), will: 4, point: 4, o1k:"atk", o1v:0, o2k:"add", o2v:0 },
    ...v
  ]);
  const removeGem = (id)=> setGems(v=> v.filter(g=> g.id!==id));
  const updateGem = (id, patch) => setGems(v => v.map(g => g.id === id ? { ...g, ...patch } : g));
  const addCore = ()=> setCores(cs=>{
    if(cs.length >= 3){ push("코어는 최대 3개까지 추가할 수 있어요."); return cs; }
    return [
      { id: uid(), name: "해 코어", grade: "RELIC", minThreshold: undefined, enforceMin: false },
      ...cs
    ];
  });
  const removeCore = (id)=> setCores(cs=> cs.length<=1 ? cs : cs.filter(c=> c.id!==id));
  const updateCore = (id, patch)=> setCores(cs=> cs.map(c=> c.id===id? {...c, ...patch}: c));
  // Mobile-friendly reorder helpers for cores
  const moveCoreUp = (index) => setCores(prev => {
    if(index <= 0) return prev;
    const next = [...prev];
    const tmp = next[index-1]; next[index-1] = next[index]; next[index] = tmp;
    return next;
  });
  const moveCoreDown = (index) => setCores(prev => {
    if(index >= prev.length-1) return prev;
    const next = [...prev];
    const tmp = next[index+1]; next[index+1] = next[index]; next[index] = tmp;
    return next;
  });
  // DnD: 코어 순서가 곧 우선순위(위쪽이 더 높음)
  const onDragEnd = (result) => {
    if (!result.destination) return;
    setCores(prev => {
      const next = Array.from(prev);
      const [moved] = next.splice(result.source.index, 1);
      next.splice(result.destination.index, 0, moved);
      return next;
    });
  };
  const smallFieldBase = "h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-white";
  const sectionTitle = "text-base font-semibold whitespace-nowrap";
  const card = "bg-white rounded-2xl shadow-sm border";
  const chip = "px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs lg:text-[13px] border";
  const labelCls = "block text-xs text-gray-500 mb-1";
  const displayIndexCore = (idx) => idx + 1;
  const displayIndexGem = (idx, total) => total - idx;
  return (
    <div className="max-w-6xl mx-auto space-y-4 lg:space-y-6">
      {/* 타이틀 + 포지션(우측) */}
      <section className="py-2 lg:py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-xl lg:text-2xl font-bold leading-tight bg-clip-text text-transparent bg-gradient-to-r from-[#85d8ea] to-[#a399f2]">LoA 아크그리드 멀티 코어 최적화 (β)</h1>
          <div className="flex gap-2 w-full lg:w-auto">
            <button onClick={()=>setRole('dealer')} className={`h-10 inline-flex items-center justify-center lg:justify-start gap-1 px-3 rounded-xl border ${role==='dealer'? 'bg-gray-900 text-white':'bg-white'} w-full lg:w-auto`}>딜러</button>
            <button onClick={()=>setRole('support')} className={`h-10 inline-flex items-center justify-center lg:justify-start gap-1 px-3 rounded-xl border ${role==='support'? 'bg-gray-900 text-white':'bg-white'} w-full lg:w-auto`}>서포터</button>
          </div>
        </div>
      </section>
      {/* 코어 입력 (DnD 우선순위) */}
      <section className={`${card} p-4 lg:p-6`}>
        <div className="flex items-center gap-2 lg:gap-3">
          <h2 className={sectionTitle}>코어 입력</h2>
          <div className="flex items-center gap-2 ml-auto whitespace-nowrap">
            <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2" onClick={addCore} aria-label="코어 추가"><Plus size={16}/><span className="hidden lg:inline"> 코어 추가</span></button>
          </div>
        </div>
        <p className="text-xs text-gray-600 mt-2">드래그 앤 드롭으로 순서를 바꾸세요. <b>우선순위가 높은 항목을 1번(맨 위)으로 배치하세요.</b></p>
        <div className="mt-3">
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId="cores-droppable">
              {(provided)=> (
                <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-3">
                  {cores.map((c, idx)=> {
                    const supply = CORE_SUPPLY[c.grade];
                    const targetItems = [{ value: '', label: '(선택 안 함)' }].concat(
                      CORE_THRESHOLDS[c.grade].map(v => ({ value: String(v), label: `${v}P 이상` }))
                    );
                    const minOfGrade = Math.min(...CORE_THRESHOLDS[c.grade]);
                    return (
                      <Draggable key={c.id} draggableId={c.id} index={idx}>
                        {(prov)=> (
                          <div ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps} className="relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible">
                            {/* Index badge - 모바일 왼쪽 정렬 / 데스크톱 중앙 */}
                            <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl self-start lg:self-center">#{displayIndexCore(idx)}</div>
                            <div className="flex flex-col min-w-[120px] w-full lg:w-40">
                              <label className={labelCls}>코어명</label>
                              <Dropdown className="w-full lg:w-40" value={c.name} onChange={(val)=>updateCore(c.id,{name: val})} items={CORE_NAME_ITEMS} placeholder="코어명"/>
                            </div>
                            <div className="flex flex-col min-w-[160px] w-full lg:w-auto">
                              <label className={labelCls}>코어 등급</label>
                              <Dropdown className="w-full lg:w-40" value={c.grade} onChange={(val)=>updateCore(c.id,{grade: /** @type {CoreGrade} */(val)})} items={GRADES.map(g=>({value:g, label: CORE_LABEL[g]}))} placeholder="코어 등급"/>
                            </div>
                            <div className="flex flex-col w-full lg:w-auto">
                              <label className={labelCls}>공급 의지력</label>
                              <div className="h-10 px-3 rounded-xl border bg-gray-50 inline-flex items-center">{supply}</div>
                            </div>
                            <div className="flex flex-col w-full lg:w-auto">
                              <label className={labelCls}>목표 구간</label>
                              <Dropdown className="w-full lg:w-40" value={String(c.minThreshold ?? '')} onChange={(val)=>{ if(val) updateCore(c.id,{minThreshold:Number(val), enforceMin:true}); else updateCore(c.id,{minThreshold:undefined, enforceMin:false}); }} items={targetItems} placeholder="구간"/>
                            </div>
                            <div className="flex flex-col w-full lg:w-auto">
                              <div className="flex items-center gap-2">
                                <input id={`enf-${c.id}`} type="checkbox" className="accent-black" checked={c.enforceMin} onChange={(e)=>updateCore(c.id,{enforceMin:e.target.checked})}/>
                                <label htmlFor={`enf-${c.id}`} className="text-sm">목표 구간 강제</label>
                              </div>
                              <p className="text-xs text-gray-500 mt-1">선택 안 함이면 내부적으로 <b>{minOfGrade}P</b> 최소 구간을 기본 목표로 적용합니다.</p>
                            </div>
                            {/* 모바일: 순서 버튼 + 삭제 버튼 묶음 (삭제 왼쪽에 순서) */}
                            <div className="lg:ml-auto lg:static absolute top-2 right-2 flex items-center gap-1">
                              <div className="hidden lg:hidden" />
                              <div className="flex lg:hidden flex-row gap-1 mr-1">
                                <button className="h-8 w-8 rounded-lg border inline-flex items-center justify-center bg-white" onClick={()=>moveCoreUp(idx)} aria-label="위로"><ChevronUp size={16}/></button>
                                <button className="h-8 w-8 rounded-lg border inline-flex items-center justify-center bg-white" onClick={()=>moveCoreDown(idx)} aria-label="아래로"><ChevronDown size={16}/></button>
                              </div>
                              <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border-0 lg:border text-red-600 inline-flex items-center justify-center gap-2" onClick={()=>removeCore(c.id)} disabled={cores.length<=1} aria-label="코어 삭제"><Trash2 size={16}/><span className="hidden lg:inline"> 삭제</span></button>
                            </div>
                          </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        </div>
      </section>
      {/* 젬 입력 */}
      <section className={`${card} p-4 lg:p-6`}>
        <div className="flex items-center gap-2 lg:gap-3 mb-3">
          <h2 className={sectionTitle}>젬 입력 (공용)</h2>
          <div className="flex gap-2 ml-auto whitespace-nowrap">
            <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2" onClick={addGem} aria-label="젬 추가"><Plus size={16}/><span className="hidden lg:inline"> 젬 추가</span></button>
            <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border inline-flex items-center justify-center gap-2 text-red-600" onClick={()=>setGems([])} aria-label="전체 삭제"><Trash2 size={16}/><span className="hidden lg:inline"> 전체 삭제</span></button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {gems.map((g,idx)=> (
            <div key={g.id} className="relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-center border rounded-xl p-3 overflow-visible min-w-0 bg-white">
              <div className="h-10 w-10 flex items-center justify-center text-base font-semibold text-gray-800 bg-gray-100 rounded-xl flex-none self-start lg:self-center">#{displayIndexGem(idx, gems.length)}</div>
              {/* 필요 의지력 + 포인트: 모바일 한 줄 / PC 기존 유지 */}
              <div className="w-full lg:w-auto flex flex-row gap-2 lg:gap-3 flex-1 lg:flex-none">
                <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
                  <label className="block text-xs text-gray-500 mb-1">필요 의지력</label>
                  <input type="number" min={0} step="1" title="의지력" className={`${smallFieldBase} w-full lg:w-24`} value={g.will} onChange={e=>updateGem(g.id,{will: Number(e.target.value)})} placeholder="의지력"/>
                </div>
                <div className="flex flex-col flex-1 min-w-0 lg:w-auto lg:flex-none">
                  <label className="block text-xs text-gray-500 mb-1">(질서/혼돈)포인트</label>
                  <input type="number" min={0} step="1" title="포인트" className={`${smallFieldBase} w-full lg:w-24`} value={g.point} onChange={e=>updateGem(g.id,{point: Number(e.target.value)})} placeholder="포인트"/>
                </div>
              </div>
              {/* 옵션 1 */}
              <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                <div className="flex-1 lg:flex-none min-w-0">
                  <label className="block text-xs text-gray-500 mb-1">옵션 1</label>
                  <Dropdown className="w-full lg:w-44" value={g.o1k} onChange={(val)=>updateGem(g.id,{o1k: /** @type {OptionKey} */(val)})} items={OPTIONS.map(k=> ({ value:k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택"/>
                </div>
                <div className="flex-1 lg:flex-none">
                  <label className="block text-xs text-gray-500 mb-1">수치</label>
                  <input type="number" step="1" className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-white w-full lg:w-20" value={g.o1v} onChange={e=>updateGem(g.id,{o1v: Number(e.target.value)})} placeholder="0"/>
                </div>
              </div>
              {/* 옵션 2 */}
              <div className="flex items-end gap-2 w-full lg:w-auto lg:flex-none min-w-0">
                <div className="flex-1 lg:flex-none min-w-0">
                  <label className="block text-xs text-gray-500 mb-1">옵션 2</label>
                  <Dropdown className="w-full lg:w-44" value={g.o2k} onChange={(val)=>updateGem(g.id,{o2k: /** @type {OptionKey} */(val)})} items={OPTIONS.map(k=> ({ value:k, label: OPTION_LABELS[k] }))} placeholder="옵션 선택"/>
                </div>
                <div className="flex-1 lg:flex-none">
                  <label className="block text-xs text-gray-500 mb-1">수치</label>
                  <input type="number" step="1" className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-white w-full lg:w-20" value={g.o2v} onChange={e=>updateGem(g.id,{o2v: Number(e.target.value)})} placeholder="0"/>
                </div>
              </div>
              <div className="lg:static absolute top-2 right-2 lg:top-auto lg:right-auto lg:ml-auto w-auto lg:flex-none">
                <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border-0 lg:border text-red-600 inline-flex items-center justify-center gap-2" onClick={()=>removeGem(g.id)} aria-label="젬 삭제"><Trash2 size={16}/><span className="hidden lg:inline"> 삭제</span></button>
              </div>
            </div>
          ))}
          {gems.length===0 && <div className="text-sm text-gray-600 p-2">젬을 추가하세요. (코어당 최대 4개가 배정됩니다)</div>}
        </div>
      </section>
      {/* 가중치 설정 */}
      <section className={`${card} p-4 lg:p-6`}>
        <div className="flex items-center gap-2 lg:gap-3">
          <h2 className={sectionTitle}>유효옵션 가중치</h2>
          <button className="h-10 w-10 lg:w-auto px-0 lg:px-3 rounded-xl border ml-auto whitespace-nowrap inline-flex items-center justify-center gap-2" onClick={resetWeights} aria-label="가중치 초기화"><RotateCcw size={16}/><span className="hidden lg:inline"> 가중치 초기화</span></button>
        </div>
        <div className="mt-2">
          <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-nowrap text-sm min-w-0">
            {OPTIONS.map((k) => (
              <div key={k} className="bg-gray-50 border rounded-xl px-2 py-2 w-full lg:w-1/6 min-w-[120px]">
                <label className="block text-xs text-gray-500 mb-1">{OPTION_LABELS[k]}</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  className="h-10 w-full px-2 rounded-md border bg-white"
                  value={String(weights[k])}
                  onChange={(e) => setWeights((v) => ({ ...v, [k]: Number(e.target.value) }))}
                />
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* 결과 */}
      <section className={`${card} p-4 lg:p-6`}>
        <h2 className={sectionTitle}>결과</h2>
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
                      <div className={`${"px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs lg:text-[13px] border"}`}>총 의지력 <span className="font-semibold">{String(pick.totalWill)}</span> / 공급 {String(supply)} (<span className="text-green-600">잔여 {String(supply - pick.totalWill)}</span>)</div>
                      <div className={`px-2.5 py-1.5 rounded-xl text-xs lg:text-[13px] border bg-[#aaa1f3] text-white border-[#aaa1f3]`}>총 포인트 <span className="font-semibold">{String(pick.totalPoint)}</span></div>
                      <div className={`px-2.5 py-1.5 rounded-xl text-xs lg:text-[13px] border bg-[#85d8ea] text-white border-[#85d8ea]`}>달성 구간 <span className="font-semibold">{pick.thr.length? String(pick.thr.join(", ")): "없음"}</span></div>
                      <div className={"px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs lg:text-[13px] border"}>유효 옵션 합(<span className="font-semibold">{role==='dealer'?"딜러":"서폿"}</span>) <span className="font-semibold">{String(pick.roleSum.toFixed(2))}</span></div>
                    </div>
                  )}
                </div>
                {!hasResult ? (
                  <div className="text-sm text-gray-600 mt-2">
                    결과가 없습니다. (이 코어에 배정 가능한 조합이 없거나, 목표 구간 강제 조건을 만족하지 못함{c.minThreshold == null ? ` / 최소 ${minOfGrade}P 자동 적용중` : ""})
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
                                <td className="px-2 py-2">{String(g.will)}</td>
                                <td className="px-2 py-2">{String(g.point)}</td>
                                <td className="px-2 py-2">{OPTION_LABELS[g.o1k]} {String(g.o1v)}</td>
                                <td className="px-2 py-2">{OPTION_LABELS[g.o2k]} {String(g.o2v)}</td>
                                <td className="px-2 py-2">{String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(2))}</td>
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
                              <div className="text-xs text-gray-500">유효합 {String(scoreGemForRole(g, role, sanitizeWeights(weights)).toFixed(2))}</div>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                              <div className="text-gray-500">의지력</div>
                              <div>{String(g.will)}</div>
                              <div className="text-gray-500">포인트</div>
                              <div>{String(g.point)}</div>
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
      <ToastStack toasts={toasts} onClose={remove}/>
    </div>
  );
}
export default CORE_SUPPLY;
