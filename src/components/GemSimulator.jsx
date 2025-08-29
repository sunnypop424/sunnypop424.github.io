import React, { useEffect, useMemo, useRef, useState, useLayoutEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Edit3, Save, RotateCcw, RefreshCcw } from "lucide-react";
import KakaoAdfit from "./KakaoAdfit";

/* =========================
   결정적 RNG 유틸리티 (원본 유지)
   ========================= */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function makeDeterministicSeed(obj) {
  const json = JSON.stringify(obj);
  return hash32(json) || 1;
}
function makeRNG(seed) {
  let s = seed >>> 0;
  return function rand() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s >>>= 0;
    s ^= s << 5;
    s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

/* =========================
   등급/젬타입/상수 (원본 유지)
   ========================= */
const GRADE = { LEGEND_MIN: 4, LEGEND_MAX: 15, RELIC_MIN: 16, RELIC_MAX: 18, ANCIENT_MIN: 19 };
const GEM_TYPES = {
  "질서-안정": { baseNeed: 8, attack: ["공격력", "추가 피해"], support: ["낙인력", "아군 피해 강화"] },
  "질서-견고": { baseNeed: 9, attack: ["공격력", "보스 피해"], support: ["아군 피해 강화", "아군 공격 강화"] },
  "질서-불변": { baseNeed: 10, attack: ["추가 피해", "보스 피해"], support: ["낙인력", "아군 공격 강화"] },
  "혼돈-침식": { baseNeed: 8, attack: ["공격력", "추가 피해"], support: ["낙인력", "아군 피해 강화"] },
  "혼돈-왜곡": { baseNeed: 9, attack: ["공격력", "보스 피해"], support: ["아군 피해 강화", "아군 공격 강화"] },
  "혼돈-붕괴": { baseNeed: 10, attack: ["추가 피해", "보스 피해"], support: ["낙인력", "아군 공격 강화"] },
};
const RARITY_ATTEMPTS = { 고급: 5, 희귀: 7, 영웅: 9 };
const RARITY_BASE_REROLLS = { 고급: 0, 희귀: 1, 영웅: 2 };
const MIN_STAT = 1;
const MAX_STAT = 5;
const GOLD_PER_ATTEMPT = 900;
// 고정 TRIALS 대신 opts로 제어 (기본값은 적당히 큼)
// maxTrials: 최대 시뮬 회수, epsilon: 95% CI 반폭(절대값), batch: 배치 크기
// note: successProb는 베르누이 평균이라 표준오차를 정확히 계산 가능
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtProb = (p) => ((Math.max(0, Math.min(1, isNaN(p) ? 0 : p)) * 100).toFixed(5) + "%");
const fmtNum = (n) => n.toLocaleString();
const OFFICIAL_RNG = true;

/* =========================
   효과명/포지션/스코어/목표 (원본 유지)
   ========================= */
function allowedEffectNames(gemKey, pos) {
  const g = GEM_TYPES[gemKey];
  if (!g) return [];
  if (pos === "공격형") return g.attack;
  if (pos === "지원형") return g.support;
  return [...g.attack, ...g.support];
}
const totalScore = (s) => s.eff + s.pts + s.aLvl + s.bLvl;
function gradeOf(score) {
  if (score >= GRADE.ANCIENT_MIN) return "고대";
  if (score >= GRADE.RELIC_MIN && score <= GRADE.RELIC_MAX) return "유물";
  if (score >= GRADE.LEGEND_MIN && score <= GRADE.LEGEND_MAX) return "전설";
  return "등급 미만";
}
function meetsTargetByMode(pos, abMode, s, t, gemKey, tgtNames) {
  const base = s.eff >= t.eff && s.pts >= t.pts;
  if (pos === "상관 없음") return base;
  // 이름 기반 목표: 유효풀(공격형/서폿) 내에서만 선택 가능하므로 UI가 보장하지만,
  // 안전하게 한 번 더 보정
  const pool = allowedEffectNames(gemKey, pos);
  const isAny = (nm) => nm === "상관없음";
  const TA = isAny(tgtNames?.aName) ? "상관없음" : (pool.includes(tgtNames?.aName) ? tgtNames?.aName : null);
  const TB = isAny(tgtNames?.bName) ? "상관없음" : (pool.includes(tgtNames?.bName) ? tgtNames?.bName : null);
  const match = (lineName, lineLvl, targetName, lvlReq) =>
    isAny(targetName) ? (pool.includes(lineName) && lineLvl >= lvlReq)
      : (lineName === targetName && lineLvl >= lvlReq);

  if (abMode === "ANY_ONE") {
    // 한 개 목표만 의미: (A 라인 or B 라인)가 "목표 이름 A" + 레벨≥t.aLvl
    const okA = TA && (match(s.aName, s.aLvl, TA, t.aLvl) || match(s.bName, s.bLvl, TA, t.aLvl));
    return base && !!okA;
  } else {
    // BOTH: 두 개 목표 모두 충족 (순서 상관없이 A/B에 배치되기만 하면 됨)
    if (!TA || !TB) return false;
    return base && (
      (match(s.aName, s.aLvl, TA, t.aLvl) && match(s.bName, s.bLvl, TB, t.bLvl)) ||
      (match(s.aName, s.aLvl, TB, t.bLvl) && match(s.bName, s.bLvl, TA, t.aLvl))
    );
  }
}
function needDistanceByMode(pos, abMode, s, t, gemKey, tgtNames) {
  // 기본(의지력 효율/포인트) 부족분
  let sum = Math.max(0, t.eff - s.eff) + Math.max(0, t.pts - s.pts);
  if (pos === "상관 없음") return sum;
  const pool = allowedEffectNames(gemKey, pos);
  const isAny = (nm) => nm === "상관없음";
  const TA = isAny(tgtNames?.aName) ? "상관없음" : (pool.includes(tgtNames?.aName) ? tgtNames?.aName : null);
  const TB = isAny(tgtNames?.bName) ? "상관없음" : (pool.includes(tgtNames?.bName) ? tgtNames?.bName : null);
  const levelCostTo = (curName, curLvl, targetName, targetLvl) => {
    if (isAny(targetName)) {
      const renameCost = pool.includes(curName) ? 0 : 1;
      return renameCost + Math.max(0, targetLvl - curLvl);
    }
    return (curName === targetName ? 0 : 1) + Math.max(0, targetLvl - curLvl);
  };

  if (abMode === "ANY_ONE") {
    if (!TA) return Number.POSITIVE_INFINITY;
    // A라인을 TA로 맞추기 vs B라인을 TA로 맞추기
    const c1 = levelCostTo(s.aName, s.aLvl, TA, t.aLvl);
    const c2 = levelCostTo(s.bName, s.bLvl, TA, t.aLvl);
    sum += Math.min(c1, c2);
  } else {
    if (!TA || !TB) return Number.POSITIVE_INFINITY;
    // (A→TA + B→TB) vs (A→TB + B→TA) 중 더 싼 배치
    const c11 = levelCostTo(s.aName, s.aLvl, TA, t.aLvl) + levelCostTo(s.bName, s.bLvl, TB, t.bLvl);
    const c22 = levelCostTo(s.aName, s.aLvl, TB, t.bLvl) + levelCostTo(s.bName, s.bLvl, TA, t.aLvl);
    sum += Math.min(c11, c22);
  }
  return sum;
}

/* =========================
   가중치/라벨/슬롯/적용 (원본 유지)
   ========================= */
function minusAppears_TABLE(v) { return v !== 1; }
function buildWeightedItems(state, attemptsLeft, pos, gemKey, costAddRate) {
  const s = state;
  const items = [];
  if (s.eff < 5) items.push({ slot: { kind: "EFF", delta: 1 }, w: 11.65 });
  if (s.eff <= 3) items.push({ slot: { kind: "EFF", delta: 2 }, w: 4.4 });
  if (s.eff <= 2) items.push({ slot: { kind: "EFF", delta: 3 }, w: 1.75 });
  if (s.eff <= 1) items.push({ slot: { kind: "EFF", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.eff)) items.push({ slot: { kind: "EFF", delta: -1 }, w: 3.0 });

  if (s.pts < 5) items.push({ slot: { kind: "PTS", delta: 1 }, w: 11.65 });
  if (s.pts <= 3) items.push({ slot: { kind: "PTS", delta: 2 }, w: 4.4 });
  if (s.pts <= 2) items.push({ slot: { kind: "PTS", delta: 3 }, w: 1.75 });
  if (s.pts <= 1) items.push({ slot: { kind: "PTS", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.pts)) items.push({ slot: { kind: "PTS", delta: -1 }, w: 3.0 });

  if (s.aLvl < 5) items.push({ slot: { kind: "A_LVL", delta: 1 }, w: 11.65 });
  if (s.aLvl <= 3) items.push({ slot: { kind: "A_LVL", delta: 2 }, w: 4.4 });
  if (s.aLvl <= 2) items.push({ slot: { kind: "A_LVL", delta: 3 }, w: 1.75 });
  if (s.aLvl <= 1) items.push({ slot: { kind: "A_LVL", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.aLvl)) items.push({ slot: { kind: "A_LVL", delta: -1 }, w: 3.0 });

  if (s.bLvl < 5) items.push({ slot: { kind: "B_LVL", delta: 1 }, w: 11.65 });
  if (s.bLvl <= 3) items.push({ slot: { kind: "B_LVL", delta: 2 }, w: 4.4 });
  if (s.bLvl <= 2) items.push({ slot: { kind: "B_LVL", delta: 3 }, w: 1.75 });
  if (s.bLvl <= 1) items.push({ slot: { kind: "B_LVL", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.bLvl)) items.push({ slot: { kind: "B_LVL", delta: -1 }, w: 3.0 });

  const names = allowedEffectNames(gemKey, "상관 없음"); // 역할군 풀을 쓰려면 pos, 전체풀 쓰려면 "상관 없음"
  const canAChange = names.filter((n) => n !== s.bName && n !== s.aName).length > 0;
  const canBChange = names.filter((n) => n !== s.aName && n !== s.bName).length > 0;
  if (canAChange) items.push({ slot: { kind: "A_CHANGE" }, w: 3.25 });
  if (canBChange) items.push({ slot: { kind: "B_CHANGE" }, w: 3.25 });

  if (attemptsLeft > 1) {
    if (costAddRate !== 1) items.push({ slot: { kind: "COST", mod: 1 }, w: 1.75 });
    if (costAddRate !== -1) items.push({ slot: { kind: "COST", mod: -1 }, w: 1.75 });
    items.push({ slot: { kind: "REROLL_PLUS", amount: 1 }, w: 2.5 });
    items.push({ slot: { kind: "REROLL_PLUS", amount: 2 }, w: 0.75 });
  }
  items.push({ slot: { kind: "HOLD" }, w: 1.75 });
  return items;
}
function slotToPrettyLabel(slot, s) {
  switch (slot.kind) {
    case "EFF": return `의지력 효율 ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "PTS": return `포인트 ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "A_LVL": return `${s.aName} Lv. ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "B_LVL": return `${s.bName} Lv. ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "A_CHANGE": return `${s.aName} 변경`;
    case "B_CHANGE": return `${s.bName} 변경`;
    case "COST": return slot.mod === 1 ? "가공 비용 +100% 증가" : "가공 비용 -100% 감소";
    case "HOLD": return "가공 상태 유지";
    case "REROLL_PLUS": return `다른 항목 보기 ${slot.amount === 2 ? "+2회" : "+1회"}`;
    default: return "";
  }
}
function labelToSlot(label, s) {
  label = label.trim();
  const num = (t) => (t.includes("-1") ? -1 : parseInt(t.replace(/[^0-9]/g, ""), 10) || 1);
  if (label.startsWith("의지력 효율")) return { kind: "EFF", delta: num(label) };
  if (label.startsWith("포인트")) return { kind: "PTS", delta: num(label) };
  if (label.startsWith(s.aName + " ")) return label.includes("변경") ? { kind: "A_CHANGE" } : { kind: "A_LVL", delta: num(label) };
  if (label.startsWith(s.bName + " ")) return label.includes("변경") ? { kind: "B_CHANGE" } : { kind: "B_LVL", delta: num(label) };
  if (label.startsWith("가공 비용")) return { kind: "COST", mod: label.includes("+100%") ? 1 : -1 };
  if (label.startsWith("가공 상태 유지")) return { kind: "HOLD" };
  if (label.startsWith("다른 항목 보기")) return { kind: "REROLL_PLUS", amount: label.includes("+2") ? 2 : 1 };
  return null;
}
function applySlot(gemKey, pos, s, slot, costAddRate, rngFn) {
  const rng = typeof rngFn === "function" ? rngFn : Math.random;

  let next = { ...s };
  const goldThisAttempt = GOLD_PER_ATTEMPT * (costAddRate === -1 ? 0 : costAddRate === 1 ? 2 : 1);
  let nextRate = costAddRate;
  let rerollDelta = 0;
  const names = allowedEffectNames(gemKey, "상관 없음");
  switch (slot.kind) {
    case "EFF": next.eff = clamp(next.eff + slot.delta, 0, MAX_STAT); break;
    case "PTS": next.pts = clamp(next.pts + slot.delta, 0, MAX_STAT); break;
    case "A_LVL": next.aLvl = clamp(next.aLvl + slot.delta, 0, MAX_STAT); break;
    case "B_LVL": next.bLvl = clamp(next.bLvl + slot.delta, 0, MAX_STAT); break;
    case "A_CHANGE": {
      const pool = names.filter((n) => n !== next.bName && n !== next.aName);
      if (pool.length) {
        const pick = pool[Math.floor(rng() * pool.length)];
        next.aName = pick;
      }
      break;
    }
    case "B_CHANGE": {
      const pool = names.filter((n) => n !== next.aName && n !== next.bName);
      if (pool.length) {
        const pick = pool[Math.floor(rng() * pool.length)];
        next.bName = pick;
      }
      break;
    }
    case "COST": nextRate = slot.mod; break;
    case "HOLD": break;
    case "REROLL_PLUS": rerollDelta += slot.amount; break;
    default: break;
  }
  return { next, goldThisAttempt, nextRate, rerollDelta };
}

/* =========================
   시뮬레이션 (원본 유지)
   ========================= */
const ZERO_VALUE = { successProb: 0, legendProb: 0, relicProb: 0, ancientProb: 0, expectedGold: 0 };
function evaluateFromSimulation(
  gemKey, pos, abMode, start, target, policy, attemptsLeft, rerolls, costAddRate, unlockedReroll, selectedFirstFour, seed, tgtNames, opts = {}
) {
  const {
    maxTrials = 50000,
    epsilon   = 0.002,   // 목표 달성 확률의 95% CI 반폭(±0.2%p)
    batch     = 1000,
  } = opts;
  const rand = makeRNG(seed);
  const weightedPickIndex = (arr) => {
    const sum = arr.reduce((a, b) => a + b.w, 0);
    let r = rand() * sum;
    for (let i = 0; i < arr.length; i++) { r -= arr[i].w; if (r <= 0) return i; }
    return arr.length - 1;
  };
  const desirability = (s) => needDistanceByMode(pos, abMode, s, target, gemKey, tgtNames);
  let agg = { ...ZERO_VALUE, trialsUsed: 0, ci: { low: 0, high: 0, halfWidth: 0 } };

  const simOnce = () => {
    let s = { ...start };
    let left = attemptsLeft;
    let rrs = rerolls;
    let unlocked = unlockedReroll;
    let rate = costAddRate;
    let goldSum = 0;
    let first = true;

    // ✅ 이미 목표를 만족한 상태라면(달성 즉시 가공 완료 정책) 바로 성공 처리
    if (policy === "STOP_ON_SUCCESS" &&
        meetsTargetByMode(pos, abMode, s, target, gemKey, tgtNames)) {
      const score = totalScore(s);
      const g = gradeOf(score);
      return {
        successProb: 1,
        legendProb: g === "전설" ? 1 : 0,
        relicProb:  g === "유물" ? 1 : 0,
        ancientProb:g === "고대" ? 1 : 0,
        expectedGold: 0, // 시도 안 했으니 비용 0
      };
    }    

    while (left > 0) {
      let cand = [];
      if (first && selectedFirstFour.length > 0) {
        cand = selectedFirstFour.slice(0, 4);
      } else {
        const pool = buildWeightedItems(s, left, pos, gemKey, rate);
        if (!pool.length) break;
        const temp = [...pool];
        const n = Math.min(4, temp.length);
        for (let i = 0; i < n; i++) {
          const idx = weightedPickIndex(temp);
          cand.push(temp[idx].slot);
          temp.splice(idx, 1);
        }
      }

      // 공식 모드: cand 중 1개 균등 무작위(각 25%). 효과 변경은 applySlot 내부에서 무작위.
      if (OFFICIAL_RNG) {
        const pick = cand[Math.floor(rand() * cand.length)];
        const res = applySlot(gemKey, pos, s, pick, rate, rand);
        s = res.next; goldSum += res.goldThisAttempt; rate = res.nextRate; rrs += res.rerollDelta; unlocked = true;
      } else {
        // 기존 탐욕 선택 유지 (옵션)
        const namesList = allowedEffectNames(gemKey, pos);
        const aName = s.aName, bName = s.bName;
        const canAChange = namesList.some((n) => n !== bName && n !== aName);
        const canBChange = namesList.some((n) => n !== aName && n !== bName);
        const before = desirability(s);
        let best = null;
        for (const sl of cand) {
          if (sl.kind === "A_CHANGE" && !canAChange) continue;
          if (sl.kind === "B_CHANGE" && !canBChange) continue;
          const res = applySlot(gemKey, pos, s, sl, rate, rand);
          const gain = before - desirability(res.next);
          if (!best || gain > best.gain) {
            best = { next: res.next, gold: res.goldThisAttempt, nextRate: res.nextRate, rrd: res.rerollDelta, gain };
          }
        }
        // 탐욕 리롤 휴리스틱(원래 로직)
        if (best && best.gain <= 0 && unlocked && rrs > 0) { rrs -= 1; first = false; continue; }
        if (best) { s = best.next; goldSum += best.gold; rate = best.nextRate; rrs += best.rrd; unlocked = true; }
      }

      left -= 1; first = false;
      if (policy === "STOP_ON_SUCCESS" && meetsTargetByMode(pos, abMode, s, target, gemKey, tgtNames)) break;
    }

    const score = totalScore(s);
    const g = gradeOf(score);
    return {
      successProb: meetsTargetByMode(pos, abMode, s, target, gemKey, tgtNames) ? 1 : 0,
      legendProb: g === "전설" ? 1 : 0,
      relicProb: g === "유물" ? 1 : 0,
      ancientProb: g === "고대" ? 1 : 0,
      expectedGold: goldSum,
    };
  };

  let n = 0;
  let succSum = 0, legendSum = 0, relicSum = 0, ancientSum = 0, goldSum = 0;
  // gold의 표준오차도 보여주고 싶다면 분산추정 추가(선택)
  while (n < maxTrials) {
    const until = Math.min(batch, maxTrials - n);
    for (let i = 0; i < until; i++) {
      const one = simOnce();
      succSum   += one.successProb;   // 0 또는 1
      legendSum += one.legendProb;
      relicSum  += one.relicProb;
      ancientSum+= one.ancientProb;
      goldSum   += one.expectedGold;
    }
    n += until;

    // 95% 신뢰구간 (정규 근사): p ± 1.96*sqrt(p(1-p)/n)
    const p   = succSum / n;
    const se  = Math.sqrt(Math.max(p*(1-p), 0) / Math.max(n, 1));
    const hw  = 1.96 * se;
    agg.ci = { low: Math.max(0, p - hw), high: Math.min(1, p + hw), halfWidth: hw };

    if (hw <= epsilon) break; // 충분히 수렴하면 종료
  }

  agg.trialsUsed  = n;
  agg.successProb = succSum / n;
  agg.legendProb  = legendSum / n;
  agg.relicProb   = relicSum  / n;
  agg.ancientProb = ancientSum/ n;
  agg.expectedGold= goldSum   / n;
  return agg;
}

/* ===============================
   공통 UI(LoACore 스타일): Dropdown + Toast + NumberInput
   =============================== */
function useOnClickOutside(refs, handler) {
  const refsArray = useMemo(() => (Array.isArray(refs) ? refs : [refs]), [refs]);
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; }, [handler]);
  useEffect(() => {
    const listener = (e) => {
      if (refsArray.some(r => r?.current && r.current.contains(e.target))) return;
      handlerRef.current?.(e);
    };
    document.addEventListener('click', listener, true);
    return () => document.removeEventListener('click', listener, true);
  }, [refsArray]);
}

function Dropdown({ value, items, onChange, placeholder, className, disabled }) {
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
    forceTick((v) => v + 1);
    const onScroll = () => {
      const r = btnRef.current?.getBoundingClientRect(); if (!r) return;
      menuPos.current = { top: r.bottom + 4, left: r.left, width: r.width };
      forceTick((v) => v + 1);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); };
  }, [open]);

  const selected = items.find((i) => i.value === value);
  const menu = open && !disabled ? (
    <AnimatePresence>
      <motion.ul
        ref={menuRef}
        key="menu"
        initial={{ opacity: 0, y: -4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.98 }}
        transition={{ duration: 0.12 }}
        style={{ position: "fixed", top: menuPos.current.top, left: menuPos.current.left, width: menuPos.current.width, zIndex: 9999 }}
        className="rounded-xl border bg-white shadow-lg overflow-auto max-h-60"
      >
        {items.map((it) => (
          <li key={String(it.value)}>
            <button
              type="button"
              onClick={() => { if (it.disabled) return; onChange(it.value); setOpen(false); }}
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
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={`min-w-0 h-10 w-full inline-flex items-center justify-between rounded-xl border px-3 bg-white hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <span className="truncate text-sm">{selected ? selected.label : placeholder || "선택"}</span>
        <span className="text-gray-500 text-sm select-none">{open ? "▲" : "▼"}</span>
      </button>
      {open && menu}
    </div>
  );
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = (msg, tone = "info") => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };
  const remove = (id) => setToasts((t) => t.filter((x) => x.id !== id));
  return { toasts, push, remove };
}
function ToastStack({ toasts, onClose }) {
  const toneBg = (tone) => ({
    success: "bg-emerald-50/95 border-emerald-200 text-emerald-900",
    info: "bg-sky-50/95 border-sky-200 text-sky-900",
    warning: "bg-amber-50/95 border-amber-200 text-amber-900",
    error: "bg-rose-50/95 border-rose-200 text-rose-900",
  }[tone] || "bg-amber-50/95 border-amber-200 text-amber-900");
  const toneBtn = (tone) => ({
    success: "text-emerald-900/80 hover:text-emerald-900",
    info: "text-sky-900/80 hover:text-sky-900",
    warning: "text-amber-900/80 hover:text-amber-900",
    error: "text-rose-900/80 hover:text-rose-900",
  }[tone] || "text-amber-900/80 hover:text-amber-900");

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none px-4">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
            className={`pointer-events-auto overflow-hidden rounded-2xl border shadow-lg backdrop-blur px-4 py-3 flex items-center gap-3 min-w-[320px] max-w-[90vw] ${toneBg(t.tone)}`}
          >
            <div className="text-sm flex-1">{t.msg}</div>
            <button
              className={`text-sm font-medium self-center ${toneBtn(t.tone)}`}
              onClick={() => onClose(t.id)}
              aria-label="닫기"
            >
              닫기
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function NumberInput({ value, set, min = MIN_STAT, max = 99, disabled }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => set(clamp(parseInt(e.target.value || String(MIN_STAT), 10), min ?? MIN_STAT, max ?? 99))}
      className="h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white"
    />
  );
}

/* ===============================
   원래 Select API를 유지하면서 내부는 Dropdown 사용
   =============================== */
const Select = ({ value, set, options, disabled, placeholder }) => {
  const items = (options || []).map((o) =>
    typeof o === "string"
      ? { value: o, label: o }
      : { value: o.value ?? o, label: o.label ?? String(o) }
  );
  return (
    <Dropdown
      value={value}
      onChange={set}
      items={items}
      disabled={!!disabled}
      className="w-full lg:w-44"
      placeholder={placeholder || "선택"}
    />
  );
};

/* =========================
   중복 라벨 검출 (원본 유지)
   ========================= */
function hasDuplicateLabels(labels) {
  const arr = labels.filter(Boolean);
  return new Set(arr).size !== arr.length;
}

/* =========================
   메인 컴포넌트
   ========================= */
export default function GemSimulator() {
  const { toasts, push, remove } = useToasts();

  const [gemKey, setGemKey] = useState("질서-안정");
  const [pos, setPos] = useState("상관 없음");
  const [rarity, setRarity] = useState("고급");
  const [abModePrimary, setAbModePrimary] = useState("ANY_ONE");

  const effectPoolAny = useMemo(() => allowedEffectNames(gemKey, "상관 없음"), [gemKey]);
  const effectPoolByPos = useMemo(() => allowedEffectNames(gemKey, "상관 없음"), [gemKey]);

  const [cur, setCur] = useState({ eff: MIN_STAT, pts: MIN_STAT, aName: effectPoolAny[0], aLvl: MIN_STAT, bName: effectPoolAny[1] || effectPoolAny[0], bLvl: MIN_STAT });
  const [tgt, setTgt] = useState({ eff: MIN_STAT, pts: MIN_STAT, aLvl: MIN_STAT, bLvl: MIN_STAT });
  const [tgtNames, setTgtNames] = useState({
    aName: allowedEffectNames(gemKey, pos)[0],   // 유효풀에서 시작
    bName: allowedEffectNames(gemKey, pos)[1] || allowedEffectNames(gemKey, pos)[0],
  });
  const [basicLocked, setBasicLocked] = useState(false);
  const [curLocked, setCurLocked] = useState(false);
  const [tgtLocked, setTgtLocked] = useState(false);

  // 시작 상태가 포지션 풀과 안 맞아도 계산은 진행 (이름 변경으로 충족 가능)
  const curValid = cur.aName !== cur.bName;


  const migratedRef = useRef(false); // StrictMode 중복 실행 방지(개발모드)
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;

    setCur(s => ({
      ...s,
      eff: Math.max(s.eff, MIN_STAT),
      pts: Math.max(s.pts, MIN_STAT),
      aLvl: Math.max(s.aLvl, MIN_STAT),
      bLvl: Math.max(s.bLvl, MIN_STAT),
    }));
    setTgt(t => ({
      ...t,
      eff: Math.max(t.eff, MIN_STAT),
      pts: Math.max(t.pts, MIN_STAT),
      aLvl: Math.max(t.aLvl, MIN_STAT),
      bLvl: Math.max(t.bLvl, MIN_STAT),
    }));
  }, []);


  const [manual, setManual] = useState(() => ({
    attemptsLeft: RARITY_ATTEMPTS[rarity],
    rerolls: RARITY_BASE_REROLLS[rarity],
    unlocked: false,
    costAddRate: 0,
    gold: 0,
    state: { ...cur },
  }));
  useEffect(() => {
    setManual((m) => ({
      ...m,
      attemptsLeft: RARITY_ATTEMPTS[rarity],
      rerolls: RARITY_BASE_REROLLS[rarity],
      state: { ...cur },
      unlocked: false,
      costAddRate: 0,
      gold: 0,
    }));
  }, [rarity, cur]);
 
 
  const [changeMode, setChangeMode] = useState(null); // { who: 'A'|'B', options: string[] }
  const [changePick, setChangePick] = useState("");



  // 포지션/젬타입 바뀔 때 목표 이름을 유효풀로 보정
  useEffect(() => {
    const pool = allowedEffectNames(gemKey, pos);
    setTgtNames((old) => {
      const a = pool.includes(old.aName) ? old.aName : pool[0];
      const bCand = pool[1] || pool[0];
      const b = pool.includes(old.bName) ? old.bName : (a === bCand ? pool.find(n => n !== a) || a : bCand);
      return { aName: a, bName: b };
    });
  }, [gemKey, pos]);

  const allOptionLabels = useMemo(() => {
    const items = buildWeightedItems(manual.state, manual.attemptsLeft, pos, gemKey, manual.costAddRate);
    const labels = items.map((it) => slotToPrettyLabel(it.slot, manual.state));
    return Array.from(new Set(labels));
  }, [manual.state, manual.attemptsLeft, manual.costAddRate, pos, gemKey]);

  const defaultLabels = useMemo(() => {
    const want = [`의지력 효율 +1`, `포인트 +1`, `${manual.state.aName} Lv. +1`, `${manual.state.bName} Lv. +1`];
    const out = [];
    let cursor = 0;
    for (const w of want) {
      if (allOptionLabels.includes(w) && !out.includes(w)) out.push(w);
      else {
        while (cursor < allOptionLabels.length && out.includes(allOptionLabels[cursor])) cursor++;
        out.push(allOptionLabels[cursor] ?? w);
        cursor++;
      }
    }
    while (out.length < 4) {
      while (cursor < allOptionLabels.length && out.includes(allOptionLabels[cursor])) cursor++;
      out.push(allOptionLabels[cursor++] ?? allOptionLabels[0] ?? "가공 상태 유지");
    }
    return out.slice(0, 4);
  }, [allOptionLabels, manual.state.aName, manual.state.bName]);

  const [manLabels, setManLabels] = useState(defaultLabels);
  useEffect(() => {
    setManLabels((prev) => {
      const next = prev.map((v, i) => (allOptionLabels.includes(v) ? v : allOptionLabels[i] ?? allOptionLabels[0] ?? v));
      const used = new Set();
      for (let i = 0; i < next.length; i++) {
        if (!used.has(next[i])) { used.add(next[i]); continue; }
        const replacement = allOptionLabels.find((l) => !used.has(l));
        if (replacement) { next[i] = replacement; used.add(replacement); }
      }
      return next;
    });
  }, [allOptionLabels]);

  const [resultStop, setResultStop] = useState(null);
  const [resultRun, setResultRun] = useState(null);
  const [isComputing, setIsComputing] = useState(false);
  const tokenRef = useRef(0);
  const timerRef = useRef(null);

  /* 리롤 EV (원본 유지) */
  const REROLL_SAMPLES = 16;
  const TAU = 0.0025;
  const expectedSuccessProbForLabels = useCallback((labels, gemKeyIn, posIn, abForEval, manualIn, tgtIn, seed) => {
    let acc = 0, cnt = 0;
    for (const lb of labels) {
      const sl = labelToSlot(lb, manualIn.state); if (!sl) continue;
      if (sl.kind === "A_CHANGE") {
        const ok = allowedEffectNames(gemKeyIn, "상관 없음").filter((n) => n !== manualIn.state.bName && n !== manualIn.state.aName).length > 0;
        if (!ok) continue;
      }
      if (sl.kind === "B_CHANGE") {
        const ok = allowedEffectNames(gemKeyIn, "상관 없음").filter((n) => n !== manualIn.state.aName && n !== manualIn.state.bName).length > 0;
        if (!ok) continue;
      }
      const res = applySlot(gemKeyIn, posIn, manualIn.state, sl, manualIn.costAddRate, () => {
        // 라벨별로도 결정성을 주고 싶다면 seed 변형해서 rand 쓰기 가능
        return (makeRNG(seed + hash32(lb))());
      });
      const nextManual = {
        attemptsLeft: manualIn.attemptsLeft - 1,
        rerolls: manualIn.rerolls + res.rerollDelta,
        unlocked: true,
        costAddRate: res.nextRate,
        gold: manualIn.gold + res.goldThisAttempt,
        state: res.next,
      };
      const v = evaluateFromSimulation(
        gemKeyIn, posIn, abForEval, nextManual.state, tgtIn, "RUN_TO_END",
        nextManual.attemptsLeft, nextManual.rerolls, nextManual.costAddRate, nextManual.unlocked, [],
        seed + hash32(lb), tgtNames
      , { maxTrials: 8000, epsilon: 0.006, batch: 500 });
      acc += v.successProb; cnt += 1;
    }
    return cnt ? acc / cnt : 0;
  }, [tgtNames]);
  function sampleNewFourSlots(seed, gemKeyIn, posIn, manualIn) {
    const rng = makeRNG(seed);
    const pool = buildWeightedItems(manualIn.state, manualIn.attemptsLeft, posIn, gemKeyIn, manualIn.costAddRate);
    const temp = [...pool];
    const out = [];
    const weightedPickIndex = (arr) => {
      const sum = arr.reduce((a, b) => a + b.w, 0);
      let r = rng() * sum;
      for (let i = 0; i < arr.length; i++) { r -= arr[i].w; if (r <= 0) return i; }
      return arr.length - 1;
    };
    const n = Math.min(4, temp.length);
    for (let i = 0; i < n; i++) { const idx = weightedPickIndex(temp); out.push(temp[idx].slot); temp.splice(idx, 1); }
    return out;
  }
  function slotsToLabels(slots, s) { return slots.map((sl) => slotToPrettyLabel(sl, s)); }

  const rerollAdvice = useMemo(() => {
    if (!manual.unlocked) return { shouldReroll: false, reason: "첫 가공 이전에는 리롤 추천을 하지 않습니다." };
    if (manual.rerolls <= 0) return { shouldReroll: false, reason: "리롤이 없습니다." };
    if (manual.attemptsLeft <= 0) return { shouldReroll: false, reason: "가공이 완료되어 리롤 판단이 무의미합니다." };

    const abForEval = pos === "상관 없음" ? "ANY_ONE" : abModePrimary;
    const seedBase = makeDeterministicSeed({ gemKey, pos, rarity, manual, tgt, manLabels, abForEval, salt: "REROLL_EV" });

    const nowProb = expectedSuccessProbForLabels(manLabels, gemKey, pos, abForEval, manual, tgt, seedBase + 7);

    let acc = 0;
    for (let i = 0; i < REROLL_SAMPLES; i++) {
      const seed = seedBase + 1000 + i * 31;
      const afterRerollManual = { ...manual, rerolls: manual.rerolls - 1 };
      const newSlots = sampleNewFourSlots(seed, gemKey, pos, afterRerollManual);
      const newLabels = slotsToLabels(newSlots, afterRerollManual.state);
      const prob = expectedSuccessProbForLabels(newLabels, gemKey, pos, abForEval, afterRerollManual, tgt, seed + 17);
      acc += prob;
    }
    const rerollProb = acc / REROLL_SAMPLES;
    const delta = rerollProb - nowProb;
    const pct = (x) => (x * 100).toFixed(2) + "%";

    if (delta > TAU) {
      return { shouldReroll: true, reason: `룩어헤드 기준 리롤 추천: 현재 최선 ${pct(nowProb)} → 리롤 기대 ${pct(rerollProb)} (▲${pct(delta)}).` };
    } else if (delta < -TAU) {
      return { shouldReroll: false, reason: `룩어헤드 기준 리롤 비추천: 현재 최선 ${pct(nowProb)}가 리롤 기대 ${pct(rerollProb)}보다 유리 (▼${pct(-delta)}).` };
    } else {
      return { shouldReroll: false, reason: `두 경로 차이 미미: 현재 ${pct(nowProb)} vs 리롤 ${pct(rerollProb)} (|Δ| < ${(TAU * 100).toFixed(2)}%).` };
    }
  }, [gemKey, pos, rarity, manual, tgt, manLabels, abModePrimary, expectedSuccessProbForLabels]);


  // BOTH로 전환 시, 목표 이름에 '상관없음'이 포함되어 있으면 유효한 이름으로 자동 보정
  useEffect(() => {
    if (abModePrimary !== "BOTH" || pos === "상관 없음") return;
    const base = allowedEffectNames(gemKey, pos);
    setTgtNames((prev) => {
      const a = base.includes(prev.aName) && prev.aName !== "상관없음" ? prev.aName : base[0];
      const bCandidate = base.find((n) => n !== a) || base[0];
      const b = base.includes(prev.bName) && prev.bName !== "상관없음" && prev.bName !== a ? prev.bName : bCandidate;
      return { aName: a, bName: b };
    });
  }, [abModePrimary, gemKey, pos]);

  /* 확률 계산 트리거 */
  useEffect(() => {
    if (!tgtLocked || !curValid) { setResultStop(null); setResultRun(null); return; }
    if (hasDuplicateLabels(manLabels)) {
      setResultStop(null); setResultRun(null);
      return;
    }

    const selectedFirstFour = manLabels.map((lb) => labelToSlot(lb, manual.state)).filter((x) => !!x);
    const calcMode = pos === "상관 없음" ? "IGNORE_AB" : abModePrimary;
    const abForEval = pos === "상관 없음" ? "ANY_ONE" : abModePrimary;
    const seedBase = makeDeterministicSeed({ gemKey, pos, rarity, manual, tgt, selectedFirstFour, calcMode });

    const token = ++tokenRef.current;
    setIsComputing(true);
    // 이전 예약 취소
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const stop = evaluateFromSimulation(
        gemKey, pos, abForEval, manual.state, tgt, "STOP_ON_SUCCESS",
        manual.attemptsLeft, manual.rerolls, manual.costAddRate, manual.unlocked, selectedFirstFour, seedBase + 101, tgtNames
        , { maxTrials: 120000, epsilon: 0.002, batch: 1000 }
      );
      const run = evaluateFromSimulation(
        gemKey, pos, abForEval, manual.state, tgt, "RUN_TO_END",
        manual.attemptsLeft, manual.rerolls, manual.costAddRate, manual.unlocked, selectedFirstFour, seedBase + 103, tgtNames
        , { maxTrials: 120000, epsilon: 0.002, batch: 1000 }
      );
      if (token === tokenRef.current) { setResultStop(stop); setResultRun(run); setIsComputing(false); }
    }, 0);
    // clean up: 이 이펙트가 갱신/언마운트되면 예약 취소 + 로딩 정리
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

  }, [gemKey, pos, rarity, curValid, manual, tgt, tgtLocked, manLabels, abModePrimary, tgtNames]);



  /* 사용자 액션: 토스트로 안내 */
  function applyManual(slotIdx) {
    if (!tgtLocked) { push("목표 옵션을 먼저 저장해 주세요."); return; }
    if (manual.attemptsLeft <= 0) return;
    if (hasDuplicateLabels(manLabels)) { push("중복된 항목이 있습니다. 확인해주세요."); return; }

    const label = manLabels[slotIdx];
    if (!allOptionLabels.includes(label)) { push("미등장 조건으로 현재 선택은 사용할 수 없어요."); return; }
    const action = labelToSlot(label, manual.state);
    if (!action) { push("선택을 해석할 수 없어요."); return; }
    // 🔁 부여 효과 변경은 '선택 모드'로 전환하여 왼쪽에서 사용자가 직접 고르게 함
    if (action.kind === "A_CHANGE" || action.kind === "B_CHANGE") {
      const names = allowedEffectNames(gemKey, "상관 없음");
      const pool = names.filter((n) => n !== manual.state.aName && n !== manual.state.bName);
      if (pool.length <= 0) { push("추가 효과 조건/중복으로 효과 변경이 불가합니다."); return; }
      setChangeMode({ who: action.kind === "A_CHANGE" ? "A" : "B", options: pool });
      setChangePick(pool[0]);
      push("변경할 효과를 선택해 주세요. 왼쪽 패널에서 적용을 누르면 이번 차수에 반영됩니다.", "info");
      return; // ✅ 여기서 종료 (아직 시도/골드 소모하지 않음)
    }
  
    const res = applySlot(gemKey, pos, manual.state, action, manual.costAddRate);
    const nextAttemptsLeft = manual.attemptsLeft - 1;
    setManual((m) => ({
      attemptsLeft: nextAttemptsLeft,
      rerolls: m.rerolls + res.rerollDelta,
      unlocked: true,
      costAddRate: res.nextRate,
      gold: m.gold + res.goldThisAttempt,
      state: res.next,
    }));
    // 다음 라운드가 남아있을 때만 안내 토스트 표시
    if (nextAttemptsLeft > 0) {
      push("선택한 효과가 반영되었습니다. 업데이트된 4개의 선택지를 다시 설정해주세요.", "success");
    }
  }
  function doReroll() {
    if (manual.attemptsLeft <= 0) { push("가공이 완료되어 리롤을 사용할 수 없어요."); return; }
    if (!manual.unlocked) { push("가공 1회 이후부터 리롤을 사용할 수 있어요."); return; }
    if (manual.rerolls <= 0) { push("리롤 횟수가 부족해요."); return; }
    setManual((m) => ({ ...m, rerolls: m.rerolls - 1 }));
  }
  function manualReset() {
    setManual({ attemptsLeft: RARITY_ATTEMPTS[rarity], rerolls: RARITY_BASE_REROLLS[rarity], unlocked: false, costAddRate: 0, gold: 0, state: { ...cur } });
  }


  function confirmEffectChange() {
    if (!changeMode) return;
    const goldThisAttempt =
      GOLD_PER_ATTEMPT * (manual.costAddRate === -1 ? 0 : manual.costAddRate === 1 ? 2 : 1);
    setManual((m) => {
      const next = { ...m.state };
      if (changeMode.who === "A") next.aName = changePick;
      else next.bName = changePick;
      return {
        attemptsLeft: m.attemptsLeft - 1, // 이번 차수 소비
        rerolls: m.rerolls,
        unlocked: true,
        costAddRate: m.costAddRate,
        gold: m.gold + goldThisAttempt,
        state: next,
      };
    });
    setChangeMode(null);
    push("선택한 효과로 변경되었습니다.", "success");
  }
 
  function cancelEffectChange() {
    setChangeMode(null);
    push("효과 변경을 취소했습니다.", "warning");
  }

  /* ====== UI 토큰 ====== */
  useEffect(() => { document.title = "로스트아크 젬 가공 헬퍼"; }, []);
  const card = "bg-white rounded-2xl shadow-sm p-4 lg:p-6";
  const labelCls = "block text-xs text-gray-500 mb-1";
  const sectionTitle = "text-base font-semibold whitespace-nowrap";

  const calcMode = pos === "상관 없음" ? "IGNORE_AB" : abModePrimary;
  const tgtALabel = `목표 효과 A 레벨 ≥`;
  const tgtBLabel = `목표 효과 B 레벨 ≥`;
  const rateText = manual.costAddRate === 1 ? "+100%" : manual.costAddRate === -1 ? "-100%" : "0%";
  const hasDup = hasDuplicateLabels(manLabels);
  const showEffectsUI = true;

  const actionDisabled = hasDup || !!changeMode || manual.attemptsLeft <= 0;
  const rerollDisabled = !!changeMode || manual.attemptsLeft <= 0 || manual.rerolls <= 0;


  const dupWarnShown = useRef(false);
  useEffect(() => {
    if (hasDup) {
      if (!dupWarnShown.current) {
        push("중복된 항목이 있습니다. 확인해주세요.");
        dupWarnShown.current = true;
      }
    } else {
      dupWarnShown.current = false;
    }
  }, [hasDup, push]);


  const targetPool = useMemo(() => {
    const base = allowedEffectNames(gemKey, pos);
    if (pos === "상관 없음") return base;
    return abModePrimary === "ANY_ONE" ? ["상관없음", ...base] : base; // BOTH면 '상관없음' 제외
  }, [gemKey, pos, abModePrimary]);

  return (
    <div className="min-h-screen text-gray-900 p-4 lg:p-6" style={{ backgroundImage: "linear-gradient(125deg, #85d8ea, #a399f2)", backgroundAttachment: "fixed" }}>
      <style>{`
        :root{ --primary:#a399f2; --grad:linear-gradient(125deg,#85d8ea,#a399f2); }
        .text-primary{ color:#a399f2; }
        .accent-primary{ accent-color:#a399f2; }
      `}</style>

      <div className="max-w-6xl mx-auto space-y-4 lg:space-y-6">
        <section className="py-2 lg:py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className="text-xl lg:text-2xl font-bold leading-tight text-white drop-shadow">로스트아크 젬 가공 시뮬레이션 기반 확률 계산기</h1>
          </div>
        </section>

        {/* 1) 기본 설정 */}
        {/* 1) 기본 설정 */}
        <section className={`${card} !mt-2`}>
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>기본 설정</h2>

            {/* 타이틀 우측: 저장/편집 버튼 (LoACoreOptimizer 스타일) */}
            <div className="ml-auto flex items-center gap-2">
              {basicLocked ? (
                <>
                  <span className="text-xs text-gray-500 hidden sm:inline">저장됨 (읽기 전용)</span>
                  <button
                    type="button"
                    onClick={() => setBasicLocked(false)}
                    className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
                  >
                    <Edit3 size={16} />
                    편집하기
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setBasicLocked(true)}
                  className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
                >
                  <Save size={16} />
                  저장하기
                </button>
              )}
            </div>
          </div>

          {/* 코어 카드와 동일한 레이아웃/간격/높이 */}
          <div className="mt-3">
            <div className="relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible">
              {/* 젬 타입 */}
              <div className="flex flex-col min-w-[160px] w-full lg:w-56">
                <label className={labelCls}>젬 타입</label>
                <Dropdown
                  className="w-full lg:w-56"
                  value={gemKey}
                  onChange={(v) => setGemKey(v)}
                  items={Object.keys(GEM_TYPES).map(k => ({ value: k, label: k }))}
                  placeholder="젬 타입"
                  disabled={basicLocked}
                />
              </div>

              {/* 등급 */}
              <div className="flex flex-col min-w-[120px] w-full lg:w-40">
                <label className={labelCls}>등급</label>
                <Dropdown
                  className="w-full lg:w-40"
                  value={rarity}
                  onChange={(v) => setRarity(v)}
                  items={["고급", "희귀", "영웅"].map(k => ({ value: k, label: k }))}
                  placeholder="등급"
                  disabled={basicLocked}
                />
              </div>

              {/* 가공/리롤 정보 */}
              <div className="flex flex-col w-full lg:w-auto">
                <label className={labelCls}>기본 시도/리롤</label>
                <div className="h-10 px-3 rounded-xl border bg-gray-50 inline-flex items-center text-sm">
                  가공 횟수 <b className="mx-1">{RARITY_ATTEMPTS[rarity]}</b> · 기본 리롤{" "}
                  <b className="ml-1">{RARITY_BASE_REROLLS[rarity]}</b>
                </div>
              </div>
            </div>
          </div>
        </section>


        {/* 2) 현재 옵션 */}
        <section className={card}>
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>현재 옵션 설정</h2>
            <div className="ml-auto flex items-center gap-2">
              {curLocked ? (
                <>
                  <span className="text-xs text-gray-500 hidden sm:inline">
                    저장됨 (읽기 전용)
                  </span>
                  <button
                    type="button"
                    onClick={() => setCurLocked(false)}
                    className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
                  >
                    <Edit3 size={16} />
                    편집하기
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setCurLocked(true)}
                  className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
                >
                  <Save size={16} />
                  저장하기
                </button>
              )}
            </div>
          </div>

          {/* 2) 현재 옵션 설정 — 입력 블록 교체(간격/폭 기본설정 카드와 동일) */}
          <div className="mt-3">
            <div className="relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible">
              {/* 의지력 효율 */}
              <div className="flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px]">
                <label className={labelCls}>의지력 효율</label>
                <NumberInput
                  value={cur.eff}
                  set={(v) => setCur({ ...cur, eff: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={curLocked}
                />
              </div>

              {/* 포인트 */}
              <div className="flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px]">
                <label className={labelCls}>포인트</label>
                <NumberInput
                  value={cur.pts}
                  set={(v) => setCur({ ...cur, pts: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={curLocked}
                />
              </div>

              {(() => {
                const effectsDisabled = curLocked;
                const effCls = effectsDisabled ? "opacity-50" : "";
                const disabledPH = effectsDisabled ? "비활성화" : undefined;
                return (
                  <>
                    {/* 효과 A */}
                    <div className={`flex flex-col w-full lg:w-auto lg:flex-none min-w-[160px] ${effCls}`}>
                      <label className={labelCls}>효과 A</label>
                      <Select
                        value={cur.aName}
                        set={(v) => setCur({ ...cur, aName: v })}
                        options={effectPoolByPos}
                        disabled={effectsDisabled}
                        placeholder={disabledPH}
                      />
                    </div>

                    {/* A 레벨 */}
                    <div className={`flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px] ${effCls}`}>
                      <label className={labelCls}>효과 A 레벨</label>
                      <NumberInput
                        value={cur.aLvl}
                        set={(v) => setCur({ ...cur, aLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                        min={MIN_STAT}
                        max={MAX_STAT}
                        disabled={effectsDisabled}
                      />
                    </div>

                    {/* 효과 B */}
                    <div className={`flex flex-col w-full lg:w-auto lg:flex-none min-w-[160px] ${effCls}`}>
                      <label className={labelCls}>효과 B</label>
                      <Select
                        value={cur.bName}
                        set={(v) => setCur({ ...cur, bName: v })}
                        options={effectPoolByPos.filter((n) => n !== cur.aName)}
                        disabled={effectsDisabled}
                        placeholder={disabledPH}
                      />
                    </div>

                    {/* B 레벨 */}
                    <div className={`flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px] ${effCls}`}>
                      <label className={labelCls}>효과 B 레벨</label>
                      <NumberInput
                        value={cur.bLvl}
                        set={(v) => setCur({ ...cur, bLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                        min={MIN_STAT}
                        max={MAX_STAT}
                        disabled={effectsDisabled}
                      />
                    </div>
                  </>
                );
              })()}
            </div>
          </div>


        </section>


        {/* 3) 목표 옵션 설정 — 입력 블록 교체(간격/폭 LoACore와 동일) */}
        <section className={card}>
<div className="flex items-center gap-2">
  <h2 className={sectionTitle}>목표 옵션 설정</h2>

  {/* ⬇️ 헤더 우측: '목표 충족 방식'을 저장/편집 버튼 왼쪽에 배치 */}
  <div className="ml-auto flex items-center gap-3 flex-wrap">
    <div className={`flex items-center gap-4 text-sm ${tgtLocked || pos === "상관 없음" ? "opacity-50" : ""}`}>
      <span className="text-xs text-gray-500">목표 충족 방식</span>
      <label className="inline-flex items-center gap-2">
        <input
          type="radio"
          checked={abModePrimary === "ANY_ONE"}
          onChange={() => setAbModePrimary("ANY_ONE")}
          disabled={tgtLocked || pos === "상관 없음"}
          className="accent-primary"
        />
        1개 이상
      </label>
      <label className="inline-flex items-center gap-2">
        <input
          type="radio"
          checked={abModePrimary === "BOTH"}
          onChange={() => setAbModePrimary("BOTH")}
          disabled={tgtLocked || pos === "상관 없음"}
          className="accent-primary"
        />
        2개
      </label>
    </div>

    {/* 저장/편집 토글 버튼 (그대로) */}
    {tgtLocked ? (
      <>
        <span className="text-xs text-gray-500 hidden sm:inline">저장됨 (계산 활성)</span>
        <button
          type="button"
          onClick={() => setTgtLocked(false)}
          className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
        >
          <Edit3 size={16} />
          편집하기
        </button>
      </>
    ) : (
      <button
        type="button"
        onClick={() => setTgtLocked(true)}
        className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
      >
        <Save size={16} />
        저장하기
      </button>
    )}
  </div>
</div>


          {/* LoACore 코어행과 동일한 한 줄 카드 레이아웃 */}
          <div className="mt-3">
            <div className="relative flex flex-col lg:flex-row lg:flex-nowrap gap-2 lg:gap-3 items-stretch lg:items-end border rounded-xl p-3 bg-white overflow-visible">
              {/* 의지력 효율 ≥ */}
              <div className="flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px]">
                <label className={labelCls}>의지력 효율 ≥</label>
                <NumberInput
                  value={tgt.eff}
                  set={(v) => setTgt({ ...tgt, eff: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={tgtLocked}
                />
              </div>

              {/* 포인트 ≥ */}
              <div className="flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px]">
                <label className={labelCls}>포인트 ≥</label>
                <NumberInput
                  value={tgt.pts}
                  set={(v) => setTgt({ ...tgt, pts: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={tgtLocked}
                />
              </div>

              
              {/* 추가 효과 */}
              <div className="flex flex-col min-w-[100px] w-full lg:w-[100px]">
                <label className={labelCls}>추가 효과</label>
                <Dropdown
                  className="w-full lg:w-[100px]"
                  value={pos}
                  onChange={(v) => setPos(v)}
                  items={["상관 없음", "공격형", "지원형"].map(k => ({ value: k, label: k }))}
                  placeholder="추가 효과"
                  disabled={tgtLocked}
                />
              </div>

              {(() => {
                // 상관 없음이어도 보이게 + 비활성화 처리
                const effectsDisabled = tgtLocked || pos === "상관 없음";
                const bLevelDisabled = effectsDisabled || abModePrimary !== "BOTH"; // 🔹 ANY_ONE이면 B 레벨도 비활성
                const effCls = effectsDisabled ? "opacity-50" : "";
                const effClsB = bLevelDisabled ? "opacity-50" : "";
                return (
                  <>

                    {/* 목표 이름 A */}
                    <div className={`flex flex-col ${tgtLocked || pos === "상관 없음" ? "opacity-50" : ""}`}>
                      <label className={labelCls}>목표 효과 A</label>
                      <Select
                        value={tgtNames.aName}
                        set={(v) => setTgtNames((t) => ({ ...t, aName: v === t.bName ? t.aName : v }))}
                        options={targetPool}
                        disabled={tgtLocked || pos === "상관 없음"}
                      />
                    </div>

                    {/* A 레벨 ≥ */}
                    <div className={`flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px] ${effCls}`}>
                      <label className={labelCls}>{tgtALabel}</label>
                      <NumberInput
                        value={tgt.aLvl}
                        set={(v) => setTgt({ ...tgt, aLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                        min={MIN_STAT}
                        max={MAX_STAT}
                        disabled={effectsDisabled}
                      />
                    </div>

                    {/* 목표 이름 B (BOTH일 때만 활성) */}
                    <div className={`flex flex-col ${(tgtLocked || pos === "상관 없음" || abModePrimary !== "BOTH") ? "opacity-50" : ""}`}>
                      <label className={labelCls}>목표 효과 B</label>
                      <Select
                        value={tgtNames.bName}
                        set={(v) => setTgtNames((t) => v === t.aName ? t : ({ ...t, bName: v }))}
                        options={targetPool.filter(n => n !== tgtNames.aName)}
                        disabled={tgtLocked || pos === "상관 없음" || abModePrimary !== "BOTH"}
                      />
                    </div>


                    {/* B 레벨 ≥ */}
                    <div className={`flex flex-col w-full lg:w-auto lg:flex-none min-w-[120px] ${effClsB}`}>
                      <label className={labelCls}>{tgtBLabel}</label>
                      <NumberInput
                        value={tgt.bLvl}
                        set={(v) => setTgt({ ...tgt, bLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                        min={MIN_STAT}
                        max={MAX_STAT}
                        disabled={bLevelDisabled}
                      />
                    </div>

                  </>
                );
              })()}
            </div>
          </div>
        </section>



        {/* 4) 가공 시뮬레이션 */}
        <section className={card}>
          {/* 타이틀 + 우측 액션 */}
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>가공 시뮬레이션</h2>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={manualReset}
                className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2 text-sm"
              >
                <RotateCcw size={16} />
                시뮬레이션 초기화
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 왼쪽: 상태/리소스(가독성 업) */}
            <div className="rounded-xl border p-3 bg-white">
              <div className="text-sm font-semibold mb-2">현재 젬 상태</div>

              {/* 작은 스탯 카드 4그리드 */}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-xl border p-2">
                  <div className="text-xs text-gray-500">의지력 효율</div>
                  <div className="text-lg font-semibold">{manual.state.eff}</div>
                </div>
                <div className="rounded-xl border p-2">
                  <div className="text-xs text-gray-500">질서·혼돈 포인트</div>
                  <div className="text-lg font-semibold">{manual.state.pts}</div>
                </div>

                {showEffectsUI && (
                  <>
                    <div className="rounded-xl border p-2">
                      {changeMode?.who === "A" ? (
                        <>
                          <div className="mt-1">
                            <Select
                              value={changePick}
                              set={setChangePick}
                              options={changeMode.options}
                            />
                          </div>
                          <div className="mt-2 flex gap-2">
                            <button onClick={confirmEffectChange}
                              className="h-9 px-3 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700">
                              적용
                            </button>
                            <button onClick={cancelEffectChange}
                              className="h-9 px-3 rounded-xl border bg-white hover:bg-gray-50">
                              취소
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-xs text-gray-500">{manual.state.aName}</div>
                          <div className="text-lg font-semibold">Lv. {manual.state.aLvl}</div>
                        </>
                      )}
                    </div>
                    <div className="rounded-xl border p-2">
                      {changeMode?.who === "B" ? (
                        <>
                          <div className="mt-1">
                            <Select
                              value={changePick}
                              set={setChangePick}
                              options={changeMode.options}
                            />
                          </div>
                          <div className="mt-2 flex gap-2">
                            <button onClick={confirmEffectChange}
                              className="h-9 px-3 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700">
                              적용
                            </button>
                            <button onClick={cancelEffectChange}
                              className="h-9 px-3 rounded-xl border bg-white hover:bg-gray-50">
                              취소
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="text-xs text-gray-500">{manual.state.bName}</div>
                          <div className="text-lg font-semibold">Lv. {manual.state.bLvl}</div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* 리소스 칩 */}
              <div className="mt-3 flex flex-wrap gap-2 text-[12px] lg:text-[13px]">
                <div className="px-2.5 py-1.5 rounded-xl bg-gray-100">
                  남은 가공 횟수 <b className="ml-1">{manual.attemptsLeft}</b>
                </div>
                <div className="px-2.5 py-1.5 rounded-xl bg-gray-100">
                  남은 다른 항목 보기 <b className="ml-1">{manual.rerolls}</b>
                </div>
                <div className="px-2.5 py-1.5 rounded-xl bg-gray-100">
                  가공 비용 추가 비율 <b className="ml-1">{rateText}</b>
                </div>
                <div className="px-2.5 py-1.5 rounded-xl bg-gray-100">
                  누적 골드 <b className="ml-1">{fmtNum(manual.gold)}</b> G
                </div>
              </div>

              {/* 완료 배지 */}
              {manual.attemptsLeft <= 0 && (
                <div className="mt-2 inline-flex items-center px-2.5 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                  가공이 완료되었습니다.
                </div>
              )}
            </div>

            {/* 오른쪽: 선택지 + 액션 */}
            <div className="rounded-xl border p-3 bg-white">
              <div className="text-sm font-semibold mb-2">이번에 등장한 4개 항목</div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {manLabels.map((label, idx) => (
                  <div key={idx} className="rounded-xl border p-2">
                    <div className="text-xs text-gray-500 mb-1">슬롯 {idx + 1}</div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={label}
                        set={(v) => {
                          const ns = [...manLabels];
                          ns[idx] = v;
                          setManLabels(ns);
                        }}
                        options={allOptionLabels}
                      />
                      <button 
                        onClick={() => applyManual(idx)} 
                        disabled={actionDisabled}
                        className={`justify-center min-w-[60px] h-10 px-3 rounded-xl border bg-white hover:bg-gray-50 inline-flex items-center ${hasDup ? "opacity-50 cursor-not-allowed" : ""
                          }`}
                      >
                        선택
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <button onClick={doReroll} disabled={rerollDisabled}
                  className={`h-10 px-3 rounded-xl border ${rerollDisabled ? "opacity-50 cursor-not-allowed" : "bg-white hover:bg-gray-50"} inline-flex items-center gap-2`}>
                  <RefreshCcw size={16} />
                  남은 다른 항목 보기 {manual.rerolls}회
                </button>
                <span className="text-xs text-gray-600">
                  {manual.attemptsLeft <= 0
                    ? "가공 완료"
                    : !manual.unlocked
                      ? "다른 항목 보기는 첫 가공 이후 가능합니다."
                      : manual.rerolls <= 0
                        ? "리롤 없음"
                        : (rerollAdvice.shouldReroll ? "리롤 추천" : "리롤 비추천")}
                </span>
              </div>

              {manual.unlocked && manual.rerolls > 0 && (
                <div className="mt-2 text-xs text-gray-700">{rerollAdvice.reason}</div>
              )}
            </div>
          </div>
        </section>


        {/* 5) 결과 출력 */}
        <section className={card}>
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>결과 출력</h2>
            <div className="ml-auto flex items-center gap-2">
 <span className="px-2.5 py-1.5 rounded-xl bg-gray-100 text-xs text-gray-600">
   Monte Carlo {fmtNum(Math.max(resultRun?.trialsUsed || 0, resultStop?.trialsUsed || 0))}회
   {resultRun?.ci?.halfWidth
     ? ` (±${(resultRun.ci.halfWidth * 100).toFixed(2)}%p @95%)`
     : ""}
 </span>
            </div>
          </div>

          {/* 1회차 선택지 – 칩으로 보기 좋게 */}
          <div className="mt-2 text-sm text-gray-700">
            <div className="text-xs text-gray-500 mb-1">현재 계산에 반영되는 1회차 선택지</div>
            <div className="flex flex-wrap gap-1.5">
              {manLabels.map((l, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border bg-white text-[12px]"
                >
                  {l}
                </span>
              ))}
            </div>
          </div>

          {/* 로딩 스켈레톤 */}
          {isComputing && (
            <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
              {[0, 1].map((k) => (
                <div key={k} className="rounded-xl border p-3 bg-white">
                  <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
                  <div className="mt-3 h-10 w-2/3 bg-gray-100 rounded animate-pulse" />
                  <div className="mt-2 h-2 w-full bg-gray-100 rounded animate-pulse" />
                  <div className="mt-4 h-4 w-40 bg-gray-100 rounded animate-pulse" />
                </div>
              ))}
            </div>
          )}

          {/* 결과 카드 */}
          {resultRun && resultStop && !isComputing && (
            <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* 목표 달성 확률 */}
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: .18 }}
                className="rounded-xl border p-3 bg-white"
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold flex items-center gap-2">
                    목표 달성 확률
                  </div>
                  <span className="px-2 py-1 rounded-lg bg-gray-50 text-[11px] text-gray-600">
                    {calcMode === "IGNORE_AB"
                      ? "추가 효과 상관 없음"
                      : calcMode === "ANY_ONE"
                        ? "추가 효과 역할군 옵션 1개 이상"
                        : "추가 효과 역할군 옵션 2개 전부"}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {/* STOP_ON_SUCCESS */}
                  <div className="rounded-xl border p-3 bg-white/60 backdrop-blur-sm">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-gray-500">달성 즉시 가공 완료</div>
                    </div>
                    <div className="mt-1 text-2xl font-bold">{fmtProb(resultStop.successProb)}</div>
                    {/* progress */}
                    <div className="mt-2 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(resultStop.successProb * 100)}%` }}
                        transition={{ type: "spring", stiffness: 260, damping: 28 }}
                        className="h-full bg-gradient-to-r from-[#85d8ea] to-[#a399f2]"
                      />
                    </div>
                    <div className="mt-2 text-xs text-gray-600 flex items-center gap-1">
                      기대 골드: <b>{fmtNum(Math.round(resultStop.expectedGold))}</b> G ({fmtNum(Math.max(resultRun?.trialsUsed || 0, resultStop?.trialsUsed || 0))}회 평균)
                    </div>
                  </div>

                  {/* RUN_TO_END */}
                  <div className="rounded-xl border p-3 bg-white/60 backdrop-blur-sm">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-gray-500">가공 횟수 전부 소모</div>
                    </div>
                    <div className="mt-1 text-2xl font-bold">{fmtProb(resultRun.successProb)}</div>
                    <div className="mt-2 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(resultRun.successProb * 100)}%` }}
                        transition={{ type: "spring", stiffness: 260, damping: 28 }}
                        className="h-full bg-gradient-to-r from-[#85d8ea] to-[#a399f2]"
                      />
                    </div>
                    <div className="mt-2 text-xs text-gray-600 flex items-center gap-1">
                      기대 골드: <b>{fmtNum(Math.round(resultRun.expectedGold))}</b> G ({fmtNum(Math.max(resultRun?.trialsUsed || 0, resultStop?.trialsUsed || 0))}회 평균)
                    </div>
                  </div>
                </div>
              </motion.div>

              {/* 등급 확률 */}
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: .18, delay: .05 }}
                className="rounded-xl border p-3 bg-white"
              >
                <div className="text-sm font-semibold flex items-center gap-2">
                  등급 확률
                </div>

                <div className="mt-3 space-y-3 text-sm">
                  {/* 전설 */}
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">전설 (4~15)</span>
                      <b>{fmtProb(resultRun.legendProb)}</b>
                    </div>
                    <div className="mt-1 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(resultRun.legendProb * 100)}%` }}
                        transition={{ type: "spring", stiffness: 260, damping: 28 }}
                        className="h-full bg-gradient-to-r from-[#85d8ea] to-[#a399f2]"
                      />
                    </div>
                  </div>

                  {/* 유물 */}
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">유물 (16~18)</span>
                      <b>{fmtProb(resultRun.relicProb)}</b>
                    </div>
                    <div className="mt-1 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(resultRun.relicProb * 100)}%` }}
                        transition={{ type: "spring", stiffness: 260, damping: 28 }}
                        className="h-full bg-gradient-to-r from-[#85d8ea] to-[#a399f2]"
                      />
                    </div>
                  </div>

                  {/* 고대 */}
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-700">고대 (19+)</span>
                      <b>{fmtProb(resultRun.ancientProb)}</b>
                    </div>
                    <div className="mt-1 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(resultRun.ancientProb * 100)}%` }}
                        transition={{ type: "spring", stiffness: 260, damping: 28 }}
                        className="h-full bg-gradient-to-r from-[#85d8ea] to-[#a399f2]"
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </section>

      </div>

      <ToastStack toasts={toasts} onClose={remove} />
      

      <div className="mt-6">
        <KakaoAdfit />
      </div>
    </div>
  );
}
