import React, { useEffect, useMemo, useRef, useState, useLayoutEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Edit3, Save, RotateCcw, RefreshCcw, ChevronDown, ChevronUp, Undo2, Redo2 } from "lucide-react";
import KakaoAdfit from "./KakaoAdfit";
import './LoACoreOptimizer.css';

/* =========================================================================
 * 1) 전역 동작 플래그
 *    - 시뮬레이션 분산 감소, 희귀사건 스케일업 등 런타임 전역 옵션
 * ========================================================================= */
const USE_ANTITHETIC = true;
const AUTO_SCALE_RARE = true;
const OFFICIAL_RNG = true;

/* =========================================================================
 * 2) 상수/테이블
 *    - 등급 경계, 젬 타입별 유효 효과 풀, 희귀도별 시도/리롤, 수치 범위, 비용
 * ========================================================================= */
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

const SIM_OPTIONS = [
  { value: 1000, label: "1,000회 (빠름)" },
  { value: 5000, label: "5,000회 (보통)" },
  { value: 10000, label: "10,000회 (추천)" },
  { value: 50000, label: "50,000회 (정밀)" },
];

/* =========================================================================
 * 3) 결정적 난수 및 보조 수학 유틸
 *    - 해시 기반 시드, xorshift 변종 RNG, 경계 체크/클램프, CI 계산 등
 * ========================================================================= */
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

const isZeroProb = (p) => !(Number(p) > 0);
const isOneProb = (p) => Number(p) >= 1;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function wilsonCI(p, n, z = 1.96) {
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function zeroSuccessUpperBound(n, alpha = 0.05) {
  return 1 - Math.pow(alpha, 1 / n);
}

const epsilonByTrials = (n) => {
  if (n >= 200000) return 0.0001;
  if (n >= 100000) return 0.0002;
  if (n >= 50000) return 0.0003;
  if (n >= 10000) return 0.0005;
  if (n >= 5000) return 0.0007;
  return 0.001;
};

const batchByTrials = (n) => {
  if (n >= 50000) return 1000;
  if (n >= 10000) return 800;
  if (n >= 5000) return 600;
  return 400;
};

/* =========================================================================
 * 4) 표시/형식 유틸
 *    - 확률/숫자 출력, 부담 배지, 성공률 추정
 * ========================================================================= */
function fmtProbSmart(p) {
  const x = Number(p);
  if (!Number.isFinite(x) || x <= 0) return "0%";
  if (x >= 1) return "100.00000%";
  return (x * 100).toFixed(5) + "%";
}

const fmtProb = (p) => fmtProbSmart(p);
const fmtNum = (n) => n.toLocaleString();

function goldPerSuccess(expectedGold, p) {
  if (!Number.isFinite(expectedGold) || expectedGold <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0) return Infinity;
  return expectedGold / p;
}

const pct = (p) => `${Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100)))}%`;

function burdenBadge(p) {
  if (p >= 0.20) return { label: "낮음", tone: "bg-emerald-50 border-emerald-200 text-emerald-800" };
  if (p >= 0.05) return { label: "보통", tone: "bg-amber-50 border-amber-200 text-amber-800" };
  if (p >= 0.01) return { label: "높음", tone: "bg-orange-50 border-orange-200 text-orange-800" };
  return { label: "매우 높음", tone: "bg-rose-50 border-rose-200 text-rose-800" };
}

function estimateRate(successes, n, method = "mle") {
  if (n <= 0) return 0;
  if (successes === 0) return 0;
  if (successes === n) return 1;
  switch (method) {
    case "laplace":
      return (successes + 1) / (n + 2);
    case "jeffreys":
      return (successes + 0.5) / (n + 1);
    case "mle":
    default:
      return successes / n;
  }
}

/* =========================================================================
 * 5) 효과/등급 판정 로직
 *    - 유효 효과 풀, 총점/등급, 목표 충족 판정, 거리(부족분) 계산
 * ========================================================================= */
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
  const pool = allowedEffectNames(gemKey, pos);
  const isAny = (nm) => nm === "상관없음";
  const TA = isAny(tgtNames?.aName) ? "상관없음" : (pool.includes(tgtNames?.aName) ? tgtNames?.aName : null);
  const TB = isAny(tgtNames?.bName) ? "상관없음" : (pool.includes(tgtNames?.bName) ? tgtNames?.bName : null);
  const match = (lineName, lineLvl, targetName, lvlReq) =>
    isAny(targetName) ? (pool.includes(lineName) && lineLvl >= lvlReq)
      : (lineName === targetName && lineLvl >= lvlReq);

  if (abMode === "ANY_ONE") {
    const okA = TA && (match(s.aName, s.aLvl, TA, t.aLvl) || match(s.bName, s.bLvl, TA, t.aLvl));
    return base && !!okA;
  } else {
    if (!TA || !TB) return false;
    return base && (
      (match(s.aName, s.aLvl, TA, t.aLvl) && match(s.bName, s.bLvl, TB, t.bLvl)) ||
      (match(s.aName, s.aLvl, TB, t.bLvl) && match(s.bName, s.bLvl, TA, t.aLvl))
    );
  }
}

function needDistanceByMode(pos, abMode, s, t, gemKey, tgtNames) {
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
    const c1 = levelCostTo(s.aName, s.aLvl, TA, t.aLvl);
    const c2 = levelCostTo(s.bName, s.bLvl, TA, t.aLvl);
    sum += Math.min(c1, c2);
  } else {
    if (!TA || !TB) return Number.POSITIVE_INFINITY;
    const c11 = levelCostTo(s.aName, s.aLvl, TA, t.aLvl) + levelCostTo(s.bName, s.bLvl, TB, t.bLvl);
    const c22 = levelCostTo(s.aName, s.aLvl, TB, t.bLvl) + levelCostTo(s.bName, s.bLvl, TA, t.aLvl);
    sum += Math.min(c11, c22);
  }
  return sum;
}

/* =========================================================================
 * 6) 슬롯(선택지) 구성/적용 로직
 *    - 선택지 가중치 테이블 구성, 표현/해석, 실제 반영
 * ========================================================================= */
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

  const names = allowedEffectNames(gemKey, "상관 없음");
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
    case "A_CHANGE": return `${s.aName} 효과 변경`;
    case "B_CHANGE": return `${s.bName} 효과 변경`;
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
  let nextRate = 0;
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

/* =========================================================================
 * 7) 시뮬레이션 코어
 *    - 몬테카를로 기반 확률/기대치 추정, 저분산 페어, 희귀사건 가드
 * ========================================================================= */
const ZERO_VALUE = { successProb: 0, legendProb: 0, relicProb: 0, ancientProb: 0, expectedGold: 0 };

function evaluateFromSimulation(
  gemKey, pos, abMode, start, target, policy, attemptsLeft, rerolls, costAddRate, unlockedReroll, selectedFirstFour, seed, tgtNames, opts = {}
) {
  const {
    maxTrials = 50000,
    epsilon = 0.002,
    batch = 1000,
    minTrials = Math.min(10000, maxTrials),
    estimator = "jeffreys",
    useAntithetic = true,
    autoScaleRare = true,
    rareTargetSuccesses = 100,
    rareMaxTrials = 200000,
    rareTiers = [200000],
  } = opts;

  const desirability = (s) => needDistanceByMode(pos, abMode, s, target, gemKey, tgtNames);

  const simOnce = (rand) => {
    const weightedPickIndex = (arr) => {
      const sum = arr.reduce((a, b) => a + b.w, 0);
      let r = rand() * sum;
      for (let i = 0; i < arr.length; i++) { r -= arr[i].w; if (r <= 0) return i; }
      return arr.length - 1;
    };

    let s = { ...start };
    let gold = 0;
    let left = attemptsLeft;
    let rrs = rerolls;
    let unlocked = unlockedReroll;
    let rate = costAddRate;
    let first = true;

    if (policy === "STOP_ON_SUCCESS" &&
      meetsTargetByMode(pos, abMode, s, target, gemKey, tgtNames)) {
      const score = totalScore(s);
      const g = gradeOf(score);
      return {
        successProb: 1,
        legendProb: g === "전설" ? 1 : 0,
        relicProb: g === "유물" ? 1 : 0,
        ancientProb: g === "고대" ? 1 : 0,
        expectedGold: 0,
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

      if (OFFICIAL_RNG) {
        const pick = cand[Math.floor(rand() * cand.length)];
        const res = applySlot(gemKey, pos, s, pick, rate, rand);
        s = res.next; gold += res.goldThisAttempt; rate = res.nextRate; rrs += res.rerollDelta; unlocked = true;
      } else {
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
        if (best && best.gain <= 0 && unlocked && rrs > 0) { rrs -= 1; first = false; continue; }
        if (best) { s = best.next; gold += best.gold; rate = best.nextRate; rrs += best.rrd; unlocked = true; }
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
      expectedGold: gold,
    };
  };

  let n = 0;
  let succSum = 0, legendSum = 0, relicSum = 0, ancientSum = 0, goldSum = 0;
  let agg = { ...ZERO_VALUE, trialsUsed: 0, ci: { low: 0, high: 0, halfWidth: 0 } };

  let localMaxTrials = maxTrials;
  let forceRare = false;

  const tiers = Array.isArray(rareTiers) && rareTiers.length
    ? [...rareTiers].sort((a, b) => a - b)
    : [rareMaxTrials];

  const hardCap = tiers[tiers.length - 1];
  const nextTier = (cur) => tiers.find(t => t > cur) || cur;
  const firstTier = tiers[0];

  const seedForTrial = (baseSeed, idx) => {
    const mixed = (baseSeed >>> 0) ^ (Math.imul((idx + 1) >>> 0, 2654435761) >>> 0);
    return mixed >>> 0;
  };

  const updateCI = () => {
    const p = succSum / Math.max(1, n);
    let ci;
    if (p === 0) {
      const up = zeroSuccessUpperBound(n);
      ci = { low: 0, high: up, halfWidth: up / 2 };
    } else if (p === 1) {
      const up = zeroSuccessUpperBound(n);
      const low = 1 - up;
      ci = { low, high: 1, halfWidth: (1 - low) / 2 };
    } else {
      const w = wilsonCI(p, n);
      ci = { low: w.low, high: w.high, halfWidth: (w.high - w.low) / 2 };
    }
    agg.ci = ci;
    return ci;
  };

  while (n < localMaxTrials) {
    const steps = batch;
    for (let i = 0; i < steps; i++) {
      if (n >= localMaxTrials) break;

      const trialSeed = seedForTrial(seed >>> 0, n + i);

      const r1 = makeRNG(trialSeed);
      const one = simOnce(r1);
      succSum += one.successProb;
      legendSum += one.legendProb;
      relicSum += one.relicProb;
      ancientSum += one.ancientProb;
      goldSum += one.expectedGold;
      n += 1;

      if (useAntithetic && n < localMaxTrials) {
        const r2base = makeRNG(trialSeed);
        const r2 = () => 1 - r2base();
        const two = simOnce(r2);
        succSum += two.successProb;
        legendSum += two.legendProb;
        relicSum += two.relicProb;
        ancientSum += two.ancientProb;
        goldSum += two.expectedGold;
        n += 1;
      }
    }

    const ci = updateCI();
    const hw = ci.halfWidth || 0;

    if (autoScaleRare && n >= minTrials && succSum === 0 && localMaxTrials < hardCap) {
      localMaxTrials = localMaxTrials < firstTier ? firstTier : nextTier(localMaxTrials);
      forceRare = true;
      continue;
    }

    const rareGuardActive =
      autoScaleRare &&
      n >= minTrials &&
      succSum < rareTargetSuccesses &&
      localMaxTrials < hardCap;

    if (rareGuardActive) {
      const next = localMaxTrials < firstTier ? firstTier : nextTier(localMaxTrials);
      localMaxTrials = Math.min(hardCap, next);
      continue;
    }

    if (!forceRare && hw <= epsilon && n >= minTrials) break;
  }

  agg.trialsUsed = n;
  agg.successProb = estimateRate(succSum, n, estimator);
  agg.legendProb = estimateRate(legendSum, n, estimator);
  agg.relicProb = estimateRate(relicSum, n, estimator);
  agg.ancientProb = estimateRate(ancientSum, n, estimator);
  agg.expectedGold = goldSum / Math.max(1, n);
  agg.successes = succSum | 0;
  return agg;
}

/* =========================================================================
 * 8) 등급 표시용 스타일/정렬 보조
 *    - 확률 0% 제거, 내림차순 정렬, 동률 판정
 * ========================================================================= */
const GRADE_GRADIENTS = {
  legend: "linear-gradient(90deg, #7A3E00, #B16800)",
  relic: "linear-gradient(90deg, #8C2F06, #AB4102)",
  ancient: "linear-gradient(90deg, #A67C37, #F5DFAB)",
};

function rankGradeOrder(run, eps = 0.0005) {
  if (!run) return { order: [], comps: [] };
  let arr = [
    { key: "legendProb", label: "전설", p: Number(run.legendProb || 0), grad: GRADE_GRADIENTS.legend },
    { key: "relicProb", label: "유물", p: Number(run.relicProb || 0), grad: GRADE_GRADIENTS.relic },
    { key: "ancientProb", label: "고대", p: Number(run.ancientProb || 0), grad: GRADE_GRADIENTS.ancient },
  ];
  arr = arr.filter(it => !isZeroProb(it.p));
  if (!arr.length) return { order: [], comps: [] };
  arr.sort((a, b) => b.p - a.p);
  const comps = [];
  for (let i = 0; i < arr.length - 1; i++) {
    const diff = arr[i].p - arr[i + 1].p;
    comps.push(Math.abs(diff) <= eps ? "=" : ">");
  }
  return { order: arr, comps };
}

/* =========================================================================
 * 9) 공통 UI 유틸/컴포넌트
 *    - 클릭외부감지 훅, 드롭다운, 토스트 스택, 숫자 입력, Select 래퍼
 * ========================================================================= */
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

function Dropdown({
  value,
  items,
  onChange,
  placeholder,
  className,
  disabled,
  bordered = true
}) {
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
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
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
        className={`rounded-xl bg-white shadow-lg overflow-auto max-h-60 ${bordered ? "border" : ""}`}
      >
        {items.map((it) => (
          <li key={String(it.value)}>
            <button
              type="button"
              onClick={() => { if (it.disabled) return; onChange(it.value); setOpen(false); }}
              aria-disabled={it.disabled ? true : undefined}
              className={`w-full text-left px-3 py-2 text-sm ${it.disabled ? "cursor-not-allowed" : "hover:bg-gray-50"} ${it.value === value ? "bg-gray-100" : ""}`}
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
        className={`min-w-0 h-10 w-full inline-flex items-center justify-between rounded-xl px-3 bg-white hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 ${bordered ? "border" : ""} ${disabled ? "cursor-not-allowed" : ""}`}
      >
        <span className="truncate text-sm">{selected ? selected.label : placeholder || "선택"}</span>
        <span className="text-gray-500 text-sm select-none">{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
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
    <div className="fixed inset-0 z-[9999] flex space-y-2 flex-col items-center justify-center pointer-events-none px-4">
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

function NumberInput({
  value,
  set,
  onChange,
  min = MIN_STAT,
  max = 99,
  step = 1,
  allowFloat = false,
  zeroOnBlur = true,
  className = "",
  inputProps = {},
  disabled,
}) {
  const toStr = (v) => (v === null || v === undefined ? "" : String(v));
  const [inner, setInner] = React.useState(toStr(value));
  React.useEffect(() => { setInner(toStr(value)); }, [value]);

  const clampLocal = (n) => {
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
    return clampLocal(n);
  };

  const handleWheel = (e) => e.currentTarget.blur();

  const hasNewApi = typeof onChange === "function";
  const callOld = typeof set === "function";

  return (
    <input
      type="number"
      inputMode={allowFloat ? "decimal" : "numeric"}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      value={inner}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") {
          setInner("");
          if (hasNewApi) onChange(null);
          return;
        }
        setInner(v);
        const num = Number(v);
        if (!Number.isFinite(num)) {
          if (hasNewApi) onChange(null);
          return;
        }
        const n = allowFloat ? num : Math.trunc(num);
        if (hasNewApi) {
          onChange(n);
        } else if (callOld) {
          set(clampLocal(n));
        }
      }}
      onBlur={() => {
        const n = normalizeOnBlur(inner);
        setInner(n == null ? "" : String(n));
        if (hasNewApi) {
          onChange(n);
        } else if (callOld) {
          set(n == null ? (min ?? 0) : n);
        }
      }}
      onWheel={handleWheel}
      className={`h-10 px-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50 bg-white ${className}`}
      {...inputProps}
    />
  );
}

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
      className="w-full lg:w-full"
      placeholder={placeholder || "선택"}
    />
  );
};

/* =========================================================================
 * 10) 보조 헬퍼
 *     - 라벨 중복 여부, 등 기타 메인에서 참조하는 작은 유틸
 * ========================================================================= */
function hasDuplicateLabels(labels) {
  const arr = labels.filter(Boolean);
  return new Set(arr).size !== arr.length;
}

/* =========================================================================
 * 11) 메인 컴포넌트 (GemSimulator)
 *     - 상태 정의, 파생값, 이펙트, 액션 핸들러, 렌더 스켈레톤만 유지
 *     - 요청 사항: 최종 UI 구현 마크업은 비워둠 (원본 로직 유지)
 * ========================================================================= */
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
    aName: allowedEffectNames(gemKey, pos)[0],
    bName: allowedEffectNames(gemKey, pos)[1] || allowedEffectNames(gemKey, pos)[0],
  });

  const [basicLocked, setBasicLocked] = useState(false);
  const [curLocked, setCurLocked] = useState(false);
  const [tgtLocked, setTgtLocked] = useState(false);

  const curValid = cur.aName !== cur.bName;

  const [simTrials, setSimTrials] = useState(10000);

  const migratedRef = useRef(false);
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

  const [changeMode, setChangeMode] = useState(null);
  const [changePick, setChangePick] = useState("");

  const HISTORY_LIMIT = 50;
  const [history, setHistory] = useState({ past: [], future: [] });

  const takeSnapshot = useCallback(() => ({
    manual: JSON.parse(JSON.stringify(manual)),
    changeMode: changeMode ? { ...changeMode, options: [...changeMode.options] } : null,
    changePick
  }), [manual, changeMode, changePick]);

  const restoreSnapshot = useCallback((snap) => {
    setManual(snap.manual);
    setChangeMode(snap.changeMode);
    setChangePick(snap.changePick);
  }, []);

  const pushHistory = useCallback(() => {
    setHistory(h => {
      const nextPast = [...h.past, takeSnapshot()];
      while (nextPast.length > HISTORY_LIMIT) nextPast.shift();
      return { past: nextPast, future: [] };
    });
  }, [takeSnapshot]);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const LOG_LIMIT = 200;
  const [logs, setLogs] = useState([]);
  const nowStr = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const addLog = useCallback((entry) => {
    setLogs((prev) => [
      { id: Math.random().toString(36).slice(2), time: nowStr(), ...entry },
      ...prev
    ].slice(0, LOG_LIMIT));
  }, []);

  const undo = useCallback(() => {
    setHistory(h => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1];
      const newPast = h.past.slice(0, -1);
      const current = takeSnapshot();
      restoreSnapshot(prev);
      addLog({ type: 'undo', title: '되돌리기', detail: '이전 상태로 복구' });
      return { past: newPast, future: [current, ...h.future] };
    });
  }, [restoreSnapshot, takeSnapshot, addLog]);

  const redo = useCallback(() => {
    setHistory(h => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      const restFuture = h.future.slice(1);
      const current = takeSnapshot();
      restoreSnapshot(next);
      addLog({ type: 'redo', title: '다시하기', detail: '되돌리기 취소' });
      return { past: [...h.past, current], future: restFuture };
    });
  }, [restoreSnapshot, takeSnapshot, addLog]);

  useEffect(() => {
    const onKey = (e) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) { if (canRedo) redo(); }
        else { if (canUndo) undo(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canUndo, canRedo, undo, redo]);

  const diffStats = (before, after) => {
    const parts = [];
    const pushIf = (k, label = k) => {
      if (before[k] !== after[k]) parts.push(`${label} ${before[k]}→${after[k]}`);
    };
    pushIf('eff', '효율');
    pushIf('pts', '포인트');
    if (before.aName !== after.aName || before.aLvl !== after.aLvl) {
      const name = before.aName === after.aName ? after.aName : `${before.aName}→${after.aName}`;
      parts.push(`A ${name} Lv.${before.aLvl}→${after.aLvl}`);
    }
    if (before.bName !== after.bName || before.bLvl !== after.bLvl) {
      const name = before.bName === after.bName ? after.bName : `${before.bName}→${after.bName}`;
      parts.push(`B ${name} Lv.${before.bLvl}→${after.bLvl}`);
    }
    return parts.join(' · ');
  };

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

  const simRef = useRef(null);
  const [logsMax, setLogsMax] = useState(null);

  useLayoutEffect(() => {
    const recalc = () => {
      if (simRef.current) {
        setLogsMax(simRef.current.offsetHeight);
      }
    };
    recalc();
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [manual, manLabels, resultRun, resultStop, changeMode, tgtLocked, basicLocked, curLocked]);

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
        seed + hash32(lb), tgtNames,
        {
          maxTrials: Math.min(8000, simTrials),
          minTrials: Math.min(8000, simTrials),
          epsilon: 0.006,
          batch: 500,
          estimator: "jeffreys",
          useAntithetic: USE_ANTITHETIC,
          autoScaleRare: false
        }
      );
      acc += v.successProb; cnt += 1;
    }
    return cnt ? acc / cnt : 0;
  }, [tgtNames, simTrials]);

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
    if (!manual.unlocked) return { shouldReroll: false, reason: "첫 가공 이전에는 다른 항목 보기를 추천을 하지 않습니다." };
    if (manual.rerolls <= 0) return { shouldReroll: false, reason: "다른 항목 보기가 없습니다." };
    if (manual.attemptsLeft <= 0) return { shouldReroll: false, reason: "가공이 완료되어 다른 항목 보기 판단이 무의미합니다." };
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
    const pct2 = (x) => (x * 100).toFixed(2) + "%";
    if (delta > TAU) {
      return { shouldReroll: true, reason: `룩어헤드 기준 다른 항목 보기 추천: 현재 최선 ${pct2(nowProb)} → 다른 항목 보기 기대 ${pct2(rerollProb)} (▲${pct2(delta)}).` };
    } else if (delta < -TAU) {
      return { shouldReroll: false, reason: `룩어헤드 기준 다른 항목 보기 비추천: 현재 최선 ${pct2(nowProb)}가 다른 항목 보기 기대 ${pct2(rerollProb)}보다 유리 (▼${pct2(-delta)}).` };
    } else {
      return { shouldReroll: false, reason: `두 경로 차이 미미: 현재 ${pct2(nowProb)} vs 다른 항목 보기 ${pct2(rerollProb)} (|Δ| < ${(TAU * 100).toFixed(2)}%).` };
    }
  }, [gemKey, pos, rarity, manual, tgt, manLabels, abModePrimary, expectedSuccessProbForLabels]);

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

  useEffect(() => {
    if (!tgtLocked || !curValid) { setResultStop(null); setResultRun(null); return; }
    if (hasDuplicateLabels(manLabels)) {
      setResultStop(null); setResultRun(null);
      return;
    }
    const selectedFirstFour = manLabels.map((lb) => labelToSlot(lb, manual.state)).filter((x) => !!x);
    const abForEval = pos === "상관 없음" ? "ANY_ONE" : abModePrimary;
    const seedBase = makeDeterministicSeed({ gemKey, pos, rarity, manual, tgt, selectedFirstFour, calcMode: pos === "상관 없음" ? "IGNORE_AB" : abModePrimary });
    const token = ++tokenRef.current;
    setIsComputing(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const commonOpts = {
        maxTrials: simTrials,
        minTrials: simTrials,
        epsilon: epsilonByTrials(simTrials),
        batch: batchByTrials(simTrials),
        estimator: "jeffreys",
        useAntithetic: USE_ANTITHETIC,
        autoScaleRare: AUTO_SCALE_RARE,
        rareTargetSuccesses: 100,
        rareTiers: [200000],
      };
      const stop = evaluateFromSimulation(
        gemKey, pos, abForEval, manual.state, tgt, "STOP_ON_SUCCESS",
        manual.attemptsLeft, manual.rerolls, manual.costAddRate, manual.unlocked, selectedFirstFour, seedBase + 101, tgtNames,
        commonOpts
      );
      const run = evaluateFromSimulation(
        gemKey, pos, abForEval, manual.state, tgt, "RUN_TO_END",
        manual.attemptsLeft, manual.rerolls, manual.costAddRate, manual.unlocked, selectedFirstFour, seedBase + 103, tgtNames,
        commonOpts
      );
      if (token === tokenRef.current) { setResultStop(stop); setResultRun(run); setIsComputing(false); }
    }, 0);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [gemKey, pos, rarity, curValid, manual, tgt, tgtLocked, manLabels, abModePrimary, tgtNames, simTrials]);

  function applyManual(slotIdx) {
    if (!allLocked) { push("항목을 적용하려면 '기본 설정/현재 옵션/목표 옵션'을 모두 저장(잠금)하세요.", "warning"); return; }
    pushHistory();
    if (!tgtLocked) { push("목표 옵션을 먼저 저장해 주세요."); return; }
    if (manual.attemptsLeft <= 0) return;
    if (hasDuplicateLabels(manLabels)) { push("중복된 항목이 있습니다. 확인해주세요."); return; }
    const label = manLabels[slotIdx];
    if (!allOptionLabels.includes(label)) { push("미등장 조건으로 현재 선택은 사용할 수 없어요."); return; }
    const action = labelToSlot(label, manual.state);
    if (!action) { push("선택을 해석할 수 없어요."); return; }

    if (action.kind === "A_CHANGE" || action.kind === "B_CHANGE") {
      const names = allowedEffectNames(gemKey, "상관 없음");
      const pool = names.filter((n) => n !== manual.state.aName && n !== manual.state.bName);
      if (pool.length <= 0) { push("추가 효과 조건/중복으로 효과 변경이 불가합니다."); return; }
      setChangeMode({ who: action.kind === "A_CHANGE" ? "A" : "B", options: pool });
      setChangePick(pool[0]);
      push("변경할 효과를 선택해 주세요. 왼쪽 패널에서 적용을 누르면 이번 차수에 반영됩니다.", "info");
      return;
    }

    if (manual.attemptsLeft <= 0) {
      push("가공이 완료되어 더 이상 적용할 수 없어요.", "warning");
      return;
    }

    const before = { ...manual.state };
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

    addLog({
      type: 'apply',
      title: `슬롯 ${slotIdx + 1} 적용: ${label}`,
      detail: diffStats(before, res.next),
      meta: { cost: res.goldThisAttempt, attemptsLeft: nextAttemptsLeft, rerollDelta: res.rerollDelta }
    });

    if (nextAttemptsLeft > 0) {
      push("선택한 효과가 반영되었습니다. 업데이트된 4개의 선택지를 다시 설정해주세요.", "success");
    }
  }

  function doReroll() {
    if (!allLocked) { push("다른 항목 보기는 모든 설정이 잠금된 상태에서만 가능합니다.", "warning"); return; }
    if (manual.attemptsLeft <= 0) { push("가공이 완료되어 다른 항목 보기를 사용할 수 없어요."); return; }
    if (!manual.unlocked) { push("가공 1회 이후부터 다른 항목 보기를 사용할 수 있어요."); return; }
    if (manual.rerolls <= 0) { push("다른 항목 보기 횟수가 부족해요."); return; }
    pushHistory();
    setManual((m) => ({ ...m, rerolls: m.rerolls - 1 }));
    addLog({
      type: 'reroll',
      title: '다른 항목 보기 사용',
      detail: `남은 다른 항목 보기 ${manual.rerolls - 1}회`,
    });
  }

  function manualReset() {
    setLogs([]);
    setHistory({ past: [], future: [] });
    setManual({ attemptsLeft: RARITY_ATTEMPTS[rarity], rerolls: RARITY_BASE_REROLLS[rarity], unlocked: false, costAddRate: 0, gold: 0, state: { ...cur } });
  }

  function confirmEffectChange() {
    if (!changeMode) return;
    if (!allLocked) { push("효과 변경 확정은 모든 설정이 잠금된 상태에서만 가능합니다.", "warning"); return; }
    pushHistory();
    const goldThisAttempt =
      GOLD_PER_ATTEMPT * (manual.costAddRate === -1 ? 0 : manual.costAddRate === 1 ? 2 : 1);
    const before = { ...manual.state };
    setManual((m) => {
      const next = { ...m.state };
      if (changeMode.who === "A") next.aName = changePick;
      else next.bName = changePick;
      return {
        attemptsLeft: m.attemptsLeft - 1,
        rerolls: m.rerolls,
        unlocked: true,
        costAddRate: m.costAddRate,
        gold: m.gold + goldThisAttempt,
        state: next,
      };
    });
    const after = { ...manual.state, ...(changeMode.who === "A" ? { aName: changePick } : { bName: changePick }) };
    addLog({
      type: 'change',
      title: `효과 변경 확정 (${changeMode.who}) → ${changePick}`,
      detail: diffStats(before, after),
      meta: { cost: goldThisAttempt }
    });
    setChangeMode(null);
    push("선택한 효과로 변경되었습니다.", "success");
  }

  function cancelEffectChange() {
    setChangeMode(null);
    push("효과 변경을 취소했습니다.", "warning");
  }

  useEffect(() => { document.title = "로아 아크그리드 젬 가공 헬퍼"; }, []);

  const card = "bg-white rounded-2xl shadow-sm p-4 lg:p-6";
  const labelCls = "block text-xs text-gray-500 mb-1";
  const sectionTitle = "text-base font-semibold whitespace-nowrap";
  const calcMode = pos === "상관 없음" ? "IGNORE_AB" : abModePrimary;
  const tgtALabel = `목표 효과 A 레벨 ≥`;
  const tgtBLabel = `목표 효과 B 레벨 ≥`;
  const rateText = manual.costAddRate === 1 ? "+100%" : manual.costAddRate === -1 ? "-100%" : "0%";
  const allLocked = basicLocked && curLocked && tgtLocked;
  const hasDup = hasDuplicateLabels(manLabels);
  const showEffectsUI = true;

  const showSkeleton = useMemo(
    () => curValid && (isComputing || !(resultRun && resultStop)),
    [curValid, isComputing, resultRun, resultStop]
  );

  const actionDisabled = !allLocked || hasDup || !!changeMode || manual.attemptsLeft <= 0;
  const rerollDisabled = !allLocked || !!changeMode || manual.attemptsLeft <= 0 || manual.rerolls <= 0;

  const dupWarnShown = useRef(false);

  useEffect(() => {
    if (!allLocked) {
      setLogs([]);
      setHistory({ past: [], future: [] });
    }
  }, [allLocked]);

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
    return abModePrimary === "ANY_ONE" ? ["상관없음", ...base] : base;
  }, [gemKey, pos, abModePrimary]);

  return (
    <div className="min-h-screen text-gray-900 p-4 lg:p-6" style={{ backgroundImage: "linear-gradient(125deg, #85d8ea, #a399f2)", backgroundAttachment: "fixed" }}>
      {/* 전역 CSS 변수와 유틸리티 클래스 주입: 주요 색상 및 accent-color 지정 */}
      <style>{`
    :root{ --primary:#a399f2; --grad:linear-gradient(125deg,#85d8ea,#a399f2); }
    .text-primary{ color:#a399f2; }
    .accent-primary{ accent-color:#a399f2; }
  `}</style>

      {/* 중앙 컨테이너: 최대 폭 제한 및 수직 간격 */}
      <div className="max-w-6xl mx-auto space-y-4 lg:space-y-6">
        {/* 헤더 섹션: 제목과 시뮬레이션 반복 횟수 선택 */}
        <section className="py-2 lg:py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* 페이지 타이틀: 그라디언트 배경 위에서 가독성 위한 화이트 텍스트/드롭섀도 */}
            <h1 className="text-xl lg:text-2xl font-bold leading-tight text-white drop-shadow text-center lg:text-left w-full lg:w-auto">
              로아 아크그리드 젬 가공 확률 계산기
            </h1>

            {/* 우측 컨트롤: 시뮬레이션 횟수 드롭다운 */}
            <div className="flex gap-2 w-auto ml-auto lg:ml-0 items-center">
              <span className="hidden sm:inline text-white/90 text-sm">시뮬레이션 횟수</span>
              <div className="min-w-[170px]">
                {/* 시뮬레이션 반복 수 선택 Dropdown (SIM_OPTIONS 기반) */}
                <Dropdown
                  value={simTrials}
                  onChange={setSimTrials}
                  items={SIM_OPTIONS}
                  placeholder="반복 수 선택"
                  bordered={false}
                />
              </div>
            </div>
          </div>
        </section>

        {/* 섹션: 기본 설정 카드 (젬 타입/등급/기본 시도/리롤 안내) */}
        <section className={`${card} !mt-2`}>
          <div className="flex items-center gap-2">
            {/* 카드 타이틀 */}
            <h2 className={sectionTitle}>기본 설정</h2>

            {/* 우측 액션: 저장/편집 토글 (잠금 상태 제어) */}
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

          {/* 입력 행: 젬 타입/등급/기본 시도·리롤 표시 */}
          <div className="mt-3">
            <div
              className="
    relative 
    grid grid-cols-2 gap-2 
    lg:flex lg:flex-row lg:flex-nowrap lg:gap-3 
    items-stretch lg:items-end 
    border rounded-xl p-3 bg-white overflow-visible
  "
            >
              {/* 젬 타입 선택: GEM_TYPES 키 목록을 드롭다운으로 제공 */}
              <div className={`flex flex-col w-full lg:w-[160px] w-full lg:w-56 ${basicLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>젬 타입</label>
                <Dropdown
                  className="w-full"
                  value={gemKey}
                  onChange={(v) => setGemKey(v)}
                  items={Object.keys(GEM_TYPES).map((k) => ({ value: k, label: k }))}
                  placeholder="젬 타입"
                  disabled={basicLocked}
                />
              </div>

              {/* 등급 선택: 고급/희귀/영웅 */}
              <div className={`flex flex-col w-full lg:w-[120px] w-full lg:w-40 ${basicLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>등급</label>
                <Dropdown
                  className="w-full"
                  value={rarity}
                  onChange={(v) => setRarity(v)}
                  items={["고급", "희귀", "영웅"].map((k) => ({ value: k, label: k }))}
                  placeholder="등급"
                  disabled={basicLocked}
                />
              </div>

              {/* 현재 등급 기준 기본 시도/리롤 수 정보 표시 (읽기 전용) */}
              <div className="flex flex-col w-full col-span-2 lg:col-span-1 lg:w-auto">
                <label className={labelCls}>기본 시도/다른 항목 보기</label>
                <div className="h-10 px-3 rounded-xl border bg-gray-50 inline-flex items-center text-sm">
                  가공 횟수 <b className="mx-1">{RARITY_ATTEMPTS[rarity]}</b> · 다른 항목 보기{" "}
                  <b className="ml-1">{RARITY_BASE_REROLLS[rarity]}</b>회
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 섹션: 현재 옵션 입력 카드 (현재 젬의 상태 입력/잠금) */}
        <section className={card}>
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>현재 옵션 설정</h2>

            {/* 우측 액션: 저장/편집 토글 (현재 값 고정 여부) */}
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

          {/* 현재 옵션 입력 행: 효율/포인트/효과 A/B 및 레벨 */}
          <div className="mt-3">
            <div className="
  relative 
  grid grid-cols-2 gap-2 
  lg:flex lg:flex-row lg:flex-nowrap lg:gap-3 
  items-stretch lg:items-end 
  border rounded-xl p-3 bg-white overflow-visible
">
              {/* 의지력 효율 입력 */}
              <div className={`flex flex-col w-full lg:w-[120px] ${curLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>의지력 효율</label>
                <NumberInput
                  value={cur.eff}
                  set={(v) => setCur({ ...cur, eff: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={curLocked}
                />
              </div>

              {/* 포인트 입력 */}
              <div className={`flex flex-col w-full lg:w-[120px] ${curLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>포인트</label>
                <NumberInput
                  value={cur.pts}
                  set={(v) => setCur({ ...cur, pts: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={curLocked}
                />
              </div>

              {/* 효과 A 선택 */}
              <div className={`flex flex-col w-full lg:w-[160px] ${curLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>효과 A</label>
                <Select
                  value={cur.aName}
                  set={(v) => setCur({ ...cur, aName: v })}
                  options={effectPoolByPos}
                  disabled={curLocked}
                  placeholder={curLocked ? "비활성화" : undefined}
                />
              </div>

              {/* 효과 A 레벨 입력 */}
              <div className={`flex flex-col w-full lg:w-[120px] ${curLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>효과 A 레벨</label>
                <NumberInput
                  value={cur.aLvl}
                  set={(v) => setCur({ ...cur, aLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={curLocked}
                />
              </div>

              {/* 효과 B 선택 (A와 중복 불가) */}
              <div className={`flex flex-col w-full lg:w-[160px] ${curLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>효과 B</label>
                <Select
                  value={cur.bName}
                  set={(v) => setCur({ ...cur, bName: v })}
                  options={effectPoolByPos.filter((n) => n !== cur.aName)}
                  disabled={curLocked}
                  placeholder={curLocked ? "비활성화" : undefined}
                />
              </div>

              {/* 효과 B 레벨 입력 */}
              <div className={`flex flex-col w-full lg:w-[120px] ${curLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>효과 B 레벨</label>
                <NumberInput
                  value={cur.bLvl}
                  set={(v) => setCur({ ...cur, bLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={curLocked}
                />
              </div>
            </div>
          </div>
        </section>

        {/* 섹션: 목표 옵션 입력 카드 (목표 충족 방식/효과/레벨) */}
        <section className={card}>
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>목표 옵션 설정</h2>

            {/* 우측: 저장/편집 토글 (잠금 시 계산 활성) */}
            <div className="ml-auto flex items-center gap-3 flex-wrap">
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

          {/* 목표 충족 방식 라디오: 상관 없음일 때 비활성화 */}
          <div className={`mb-1 flex items-center gap-4 text-sm ${tgtLocked || pos === "상관 없음" ? "opacity-50" : ""}`}>
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

          {/* 목표 조건 입력 행: 효율/포인트/추가 효과/효과명 및 레벨 */}
          <div className="mt-3">
            <div className="
  relative
  grid grid-cols-2 gap-2
  lg:flex lg:flex-row lg:flex-nowrap lg:gap-3
  items-stretch lg:items-end
  border rounded-xl p-3 bg-white overflow-visible
">
              {/* 목표 의지력 효율 하한 */}
              <div className={`flex flex-col w-full lg:w-[120px] lg:flex-none ${tgtLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>의지력 효율 ≥</label>
                <NumberInput
                  value={tgt.eff}
                  set={(v) => setTgt({ ...tgt, eff: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={tgtLocked}
                />
              </div>

              {/* 목표 포인트 하한 */}
              <div className={`flex flex-col w-full lg:w-[120px] lg:flex-none ${tgtLocked ? "opacity-50" : ""}`}>
                <label className={labelCls}>포인트 ≥</label>
                <NumberInput
                  value={tgt.pts}
                  set={(v) => setTgt({ ...tgt, pts: clamp(v, MIN_STAT, MAX_STAT) })}
                  min={MIN_STAT}
                  max={MAX_STAT}
                  disabled={tgtLocked}
                />
              </div>

              {/* 추가 효과 역할군: 상관 없음/공격형/지원형 */}
              <div className={`flex flex-col w-full col-span-2 lg:col-span-1 lg:w-[100px] ${tgtLocked ? "opacity-50" : ""}`}>
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

              {/* 목표 효과명/레벨: 역할군이 상관 없음이면 비활성화 */}
              {(() => {
                const effectsDisabled = tgtLocked || pos === "상관 없음";
                const bLevelDisabled = effectsDisabled || abModePrimary !== "BOTH";
                const effCls = effectsDisabled ? "opacity-50" : "";
                const effClsB = bLevelDisabled ? "opacity-50" : "";
                return (
                  <>
                    {/* 목표 효과 A 선택 */}
                    <div className={`w-full lg:w-[160px] flex flex-col ${tgtLocked || pos === "상관 없음" ? "opacity-50" : ""}`}>
                      <label className={labelCls}>목표 효과 A</label>
                      <Select
                        value={tgtNames.aName}
                        set={(v) => setTgtNames((t) => ({ ...t, aName: v }))}
                        options={abModePrimary === "BOTH"
                          ? targetPool.filter((n) => n !== tgtNames.bName)
                          : targetPool}
                        disabled={tgtLocked || pos === "상관 없음"}
                      />
                    </div>

                    {/* 목표 효과 A 레벨 하한 */}
                    <div className={`flex flex-col w-full lg:w-[120px] lg:flex-none ${effCls}`}>
                      <label className={labelCls}>{tgtALabel}</label>
                      <NumberInput
                        value={tgt.aLvl}
                        set={(v) => setTgt({ ...tgt, aLvl: clamp(v, MIN_STAT, MAX_STAT) })}
                        min={MIN_STAT}
                        max={MAX_STAT}
                        disabled={effectsDisabled}
                      />
                    </div>

                    {/* 목표 효과 B 선택: BOTH 모드에서만 활성 */}
                    <div className={`w-full lg:w-[160px] flex flex-col ${(tgtLocked || pos === "상관 없음" || abModePrimary !== "BOTH") ? "opacity-50" : ""}`}>
                      <label className={labelCls}>목표 효과 B</label>
                      <Select
                        value={tgtNames.bName}
                        set={(v) => setTgtNames((t) => ({ ...t, bName: v }))}
                        options={abModePrimary === "BOTH"
                          ? targetPool.filter((n) => n !== tgtNames.aName)
                          : targetPool}
                        disabled={tgtLocked || pos === "상관 없음" || abModePrimary !== "BOTH"}
                      />
                    </div>

                    {/* 목표 효과 B 레벨 하한: BOTH 모드일 때만 활성 */}
                    <div className={`flex flex-col w-full lg:w-[120px] lg:flex-none ${effClsB}`}>
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

        {/* 2열 레이아웃: 좌측 시뮬, 우측 작업 내역 */}
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* 좌측(2칸): 가공 시뮬레이션 패널 */}
          <section ref={simRef} className={`lg:col-span-2 ` + card}>
            {/* 헤더: 타이틀 및 초기화 버튼 */}
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

            {/* 사용 안내: 모든 설정 잠금 이후 액션 가능 */}
            <div className="mt-1 text-xs text-gray-500">
              항목 적용 / 다른 항목 보기는 <b>모든 설정을 저장(잠금)</b>한 뒤 이용하세요.
            </div>

            {/* 본문: 현재 상태 카드 + 선택지 카드 */}
            <div className="mt-3 gap-4">
              {/* 현재 젬 상태/리소스 패널 */}
              <div className="rounded-xl border p-3 bg-white">
                <div className="text-sm font-semibold mb-2">현재 젬 상태</div>

                {/* 핵심 스탯(효율/포인트/효과 A/B) 4그리드 */}
                <div className="grid grid-cols-4 gap-2 text-sm">
                  {/* 효율 */}
                  <div className="rounded-xl border p-2 text-center flex flex-col items-center justify-center col-span-2">
                    <div className="text-xs text-gray-500">의지력 효율</div>
                    <div className="text-lg font-semibold">{manual.state.eff}</div>
                  </div>

                  {/* 포인트 */}
                  <div className="rounded-xl border p-2 text-center flex flex-col items-center justify-center col-span-2">
                    <div className="text-xs text-gray-500">질서·혼돈 포인트</div>
                    <div className="text-lg font-semibold">{manual.state.pts}</div>
                  </div>

                  {/* 효과 A: 변경 모드면 선택 컨트롤 표시, 아니면 현재 값 표시 */}
                  {showEffectsUI && (
                    <div className="rounded-xl border p-2 text-center flex flex-col items-center justify-center col-span-2">
                      {changeMode?.who === "A" ? (
                        <>
                          <div className="w-full">
                            <Select
                              value={changePick}
                              set={setChangePick}
                              options={changeMode.options}
                            />
                          </div>
                          <div className="mt-2 flex gap-2 w-full">
                            <button onClick={confirmEffectChange}
                              className="h-9 px-3 rounded-xl bg-[#a399f2] text-white hover:bg-[#a399f2] w-[50%]">
                              적용
                            </button>
                            <button onClick={cancelEffectChange}
                              className="h-9 px-3 rounded-xl border bg-white hover:bg-gray-50 w-[50%]">
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
                  )}

                  {/* 효과 B: 변경 모드면 선택 컨트롤 표시, 아니면 현재 값 표시 */}
                  {showEffectsUI && (
                    <div className="rounded-xl border p-2 text-center flex flex-col items-center justify-center col-span-2">
                      {changeMode?.who === "B" ? (
                        <>
                          <div className="w-full">
                            <Select
                              value={changePick}
                              set={setChangePick}
                              options={changeMode.options}
                            />
                          </div>
                          <div className="mt-2 flex gap-2 w-full">
                            <button onClick={confirmEffectChange}
                              className="h-9 px-3 rounded-xl bg-[#a399f2] text-white hover:bg-[#a399f2] w-[50%]">
                              적용
                            </button>
                            <button onClick={cancelEffectChange}
                              className="h-9 px-3 rounded-xl border bg-white hover:bg-gray-50 w-[50%]">
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
                  )}
                </div>

                {/* 리소스 칩: 남은 가공/리롤/비용 증감률/누적 골드 */}
                <div className="mt-3 flex flex-wrap gap-2 text-[12px] lg:text-[13px]">
                  {manual.attemptsLeft <= 0 ? (
                    <div className="inline-flex items-center px-2.5 py-1.5 rounded-xl bg-violet-50 border border-violet-200 text-violet-900 text-[12px] lg:text-[13px]">
                      가공이 완료되었습니다.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2 text-[12px] lg:text-[13px]">
                      <div className="px-2.5 py-1.5 rounded-xl bg-gray-100 border">
                        남은 가공 횟수 <b className="ml-1">{manual.attemptsLeft}</b>
                      </div>
                      <div className="px-2.5 py-1.5 rounded-xl bg-gray-100 border">
                        다른 항목 보기 <b className="ml-1">{manual.rerolls}</b>
                      </div>
                      <div className="px-2.5 py-1.5 rounded-xl bg-gray-100 border">
                        가공 비용 추가 비율 <b className="ml-1">{rateText}</b>
                      </div>
                    </div>
                  )}
                  <div className="px-2.5 py-1.5 rounded-xl bg-gray-100 border">
                    누적 골드 <b className="ml-1">{fmtNum(manual.gold)}</b> G
                  </div>
                </div>
              </div>

              {/* 이번 차수 선택지 + 액션 패널 */}
              <div className="rounded-xl border p-3 bg-white mt-4">
                <div className="text-sm font-semibold mb-2">이번에 등장한 4개 항목</div>

                {/* 4개 슬롯: 라벨 선택 + 적용 버튼 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {manLabels.map((label, idx) => (
                    <div key={idx} className="slot-card rounded-xl border p-2 transition-all">
                      <div className="text-xs text-gray-500 mb-1">슬롯 {idx + 1}</div>
                      <div className="flex items-center gap-2">
                        {/* 현재 슬롯 라벨 변경 드롭다운 */}
                        <Select
                          value={label}
                          set={(v) => {
                            const ns = [...manLabels];
                            ns[idx] = v;
                            setManLabels(ns);
                          }}
                          options={allOptionLabels}
                        />
                        {/* 적용 버튼: 모든 설정 잠금 및 중복 미발생 등 조건 충족 시 활성 */}
                        <button
                          onClick={() => applyManual(idx)}
                          aria-disabled={actionDisabled}
                          className={`apply-btn transition-all justify-center min-w-[60px] h-10 px-3 rounded-xl border bg-white 
                          hover:border-[#a399f2] hover:text-white hover:bg-[#a399f2] inline-flex items-center
                          ${actionDisabled ? "opacity-50 cursor-not-allowed" : ""} 
                          ${hasDup ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          적용
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 다른 항목 보기 버튼 및 추천 문구 */}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <button onClick={doReroll} disabled={rerollDisabled}
                    className={`h-10 px-3 rounded-xl border ${rerollDisabled ? "opacity-50 cursor-not-allowed" : "bg-white hover:bg-gray-50"} inline-flex items-center gap-2`}>
                    <RefreshCcw size={16} />
                    다른 항목 보기 {manual.rerolls}회
                  </button>
                  <span className="text-xs text-gray-600">
                    {manual.attemptsLeft <= 0
                      ? "가공 완료"
                      : !manual.unlocked
                        ? "첫 가공 이후 가능합니다."
                        : manual.rerolls <= 0
                          ? "다른 항목 보기 없음"
                          : (rerollAdvice.shouldReroll ? "다른 항목 보기 추천" : "다른 항목 보기 비추천")}
                  </span>
                </div>

                {/* 다른 항목 보기 EV 근거 설명 (가능 시 노출) */}
                {manual.unlocked && manual.rerolls > 0 && (
                  <div className="mt-2 text-xs text-gray-700">{rerollAdvice.reason}</div>
                )}
              </div>
            </div>
          </section>

          {/* 우측(1칸): 작업 내역 패널 (Undo/Redo 포함) */}
          <section
            className={`${card} h-full flex flex-col`}
            style={logsMax ? { maxHeight: logsMax } : undefined}
          >
            <div className="flex items-center gap-2">
              <h2 className={sectionTitle}>작업 내역</h2>
              {/* Undo/Redo 버튼: 단축키 안내 포함 */}
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={undo}
                  disabled={!canUndo}
                  className={`ml-auto h-10 px-3 rounded-xl border ${!canUndo ? "opacity-50 cursor-not-allowed" : "bg-white hover:bg-gray-50"} inline-flex items-center gap-2 text-sm`}
                  title="되돌리기 (Ctrl/Cmd+Z)"
                >
                  <Undo2 size={16} />
                </button>
                <button
                  onClick={redo}
                  disabled={!canRedo}
                  className={`h-10 px-3 rounded-xl border ${!canRedo ? "opacity-50 cursor-not-allowed" : "bg-white hover:bg-gray-50"} inline-flex items-center gap-2 text-sm`}
                  title="다시하기 (Ctrl/Cmd+Shift+Z)"
                >
                  <Redo2 size={16} />
                </button>
              </div>
            </div>

            {/* 로그 비어있음/목록 렌더링 */}
            {logs.length === 0 ? (
              <div className="mt-3 text-sm text-gray-500">기록이 없습니다.</div>
            ) : (
              <div className="mt-3 flex-1 min-h-0 space-y-2 overflow-auto">
                {logs.map((l) => (
                  <div key={l.id} className="rounded-xl border p-2 bg-white">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">
                        {l.title}
                      </div>
                      <span className="text-[11px] text-gray-500">{l.time}</span>
                    </div>
                    {l.detail && (
                      <div className="mt-1 text-xs text-gray-700">{l.detail}</div>
                    )}
                    {l.meta && (
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-gray-600">
                        {'cost' in l.meta && (
                          <span className="px-1.5 py-0.5 rounded-lg border bg-gray-50">
                            비용 {fmtNum(l.meta.cost)} G
                          </span>
                        )}
                        {'attemptsLeft' in l.meta && (
                          <span className="px-1.5 py-0.5 rounded-lg border bg-gray-50">
                            남은 가공 {l.meta.attemptsLeft}회
                          </span>
                        )}
                        {'rerollDelta' in l.meta && l.meta.rerollDelta !== 0 && (
                          <span className="px-1.5 py-0.5 rounded-lg border bg-gray-50">
                            다른 항목 보기 {l.meta.rerollDelta > 0 ? `+${l.meta.rerollDelta}` : l.meta.rerollDelta}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 결과 출력 섹션: 스켈레톤/실데이터 2상태 렌더링 */}
        <section className={card}>
          <div className="flex items-center gap-2">
            <h2 className={sectionTitle}>결과 출력</h2>
            {/* 우측 표시: 실제 사용된 Monte Carlo 횟수 및 95% CI 폭 */}
            <div className="ml-auto flex items-center gap-2">
              <span className="px-2.5 py-1.5 rounded-xl bg-gray-100 text-[10px] lg:text-xs text-gray-600">
                Monte Carlo {fmtNum(Math.max(resultRun?.trialsUsed || 0, resultStop?.trialsUsed || 0))}회
                {resultRun?.ci?.halfWidth
                  ? ` (±${(resultRun.ci.halfWidth * 100).toFixed(2)}%p @95%)`
                  : ""}
              </span>
            </div>
          </div>

          {/* 계산 중 또는 데이터 미존재 시: 스켈레톤 UI */}
          {showSkeleton ? (
            <div className="mt-3 space-y-3">
              {/* 스켈레톤 칩 */}
              <div className="text-xs text-gray-500 mb-1">현재 계산에 반영되는 1회차 선택지</div>
              <div className="flex flex-wrap gap-1.5">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="h-6 w-28 rounded-lg bg-gray-100 animate-pulse"
                  />
                ))}
              </div>
              {/* 스켈레톤 카드 2장 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
                {[0, 1].map((k) => (
                  <div key={k} className="rounded-xl border p-3 bg-white">
                    <div className="h-4 w-32 bg-gray-100 rounded animate-pulse" />
                    <div className="mt-3 h-8 w-2/3 bg-gray-100 rounded animate-pulse" />
                    <div className="mt-2 h-2 w-full bg-gray-100 rounded animate-pulse" />
                    <div className="mt-4 h-4 w-40 bg-gray-100 rounded animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* 실데이터 표시: 1회차 선택지 목록 */}
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

              {/* 목표 달성 확률 및 등급 확률 카드 2열 */}
              {resultRun && resultStop && (
                <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {/* 목표 달성 확률 카드: STOP_ON_SUCCESS vs RUN_TO_END */}
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

                    {/* 좌측: STOP_ON_SUCCESS 결과 */}
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="rounded-xl border p-3 bg-white/60 backdrop-blur-sm">
                        <div className="flex items-center justify-between">
                          <div className="text-xs text-gray-500">
                            달성 즉시 가공 완료 ( {fmtNum(resultStop.successes)}회 / {fmtNum(resultStop.trialsUsed)}회 )
                          </div>                        </div>
                        <div className="mt-1 text-2xl font-bold">
                          {fmtProbSmart(resultStop.successProb, resultStop.ci)}
                        </div>
                        <div className="mt-2 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.round(resultStop.successProb * 100)}%` }}
                            transition={{ type: "spring", stiffness: 260, damping: 28 }}
                            className="h-full bg-gradient-to-r from-[#85d8ea] to-[#a399f2]"
                          />
                        </div>
                        {/* 기대 비용 및 부담 배지 */}
                        {(() => {
                          const gps = goldPerSuccess(resultStop.expectedGold, resultStop.successProb);
                          const badge = burdenBadge(resultStop.successProb);
                          return (
                            <div className="mt-2 text-xs text-gray-700 flex items-center gap-2 flex-wrap">
                              <span>
                                성공 1회 <b>기대비용</b>: <b>{Number.isFinite(gps) ? fmtNum(Math.round(gps)) : "∞"}</b> G
                              </span>
                              <span className={`px-2 py-0.5 rounded-lg border ${badge.tone}`}>
                                골드부담: {badge.label}
                              </span>
                              <span className="text-[11px] text-gray-500">
                                (확률이 낮을수록 기대비용이 커집니다)
                              </span>
                            </div>
                          );
                        })()}
                      </div>

                      {/* 우측: RUN_TO_END 결과 */}
                      <div className="rounded-xl border p-3 bg-white/60 backdrop-blur-sm">
                        <div className="flex items-center justify-between">
                          <div className="text-xs text-gray-500">
                            가공 횟수 전부 소모 ( {fmtNum(resultRun.successes)}회 / {fmtNum(resultRun.trialsUsed)}회 )
                          </div>
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
                        {/* 기대 비용 및 부담 배지 */}
                        {(() => {
                          const gps = goldPerSuccess(resultRun.expectedGold, resultRun.successProb);
                          const badge = burdenBadge(resultRun.successProb);
                          return (
                            <div className="mt-2 text-xs text-gray-700 flex items-center gap-2 flex-wrap">
                              <span>
                                성공 1회 <b>기대비용</b>: <b>{Number.isFinite(gps) ? fmtNum(Math.round(gps)) : "∞"}</b> G
                              </span>
                              <span className={`px-2 py-0.5 rounded-lg border ${badge.tone}`}>
                                골드부담: {badge.label}
                              </span>
                              <span className="text-[11px] text-gray-500">
                                (확률이 낮을수록 기대비용이 커집니다)
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </motion.div>

                  {/* 등급 확률 카드: 전설/유물/고대 각각의 달성 확률 및 순서 */}
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: .18, delay: .05 }}
                    className="rounded-xl border p-3 bg-white"
                  >
                    <div className="text-sm font-semibold flex items-center gap-2">
                      등급 확률
                    </div>

                    {/* 각 등급 확률 막대 및 수치 표시 (0%도 노출) */}
                    {(() => {
                      if (!resultRun) return null;
                      const grades = [
                        { key: "legendProb", name: "전설 (4~15)", p: Number(resultRun.legendProb || 0), grad: GRADE_GRADIENTS.legend },
                        { key: "relicProb", name: "유물 (16~18)", p: Number(resultRun.relicProb || 0), grad: GRADE_GRADIENTS.relic },
                        { key: "ancientProb", name: "고대 (19+)", p: Number(resultRun.ancientProb || 0), grad: GRADE_GRADIENTS.ancient },
                      ];
                      return (
                        <div className="mt-3 space-y-3 text-sm">
                          {grades.map(g => (
                            <div key={g.key}>
                              <div className="flex items-center justify-between">
                                <span className="text-gray-700">{g.name}</span>
                                <div className="flex items-center gap-2">
                                  {/* 100% 확정 배지 */}
                                  {isOneProb(g.p) && (
                                    <span className="px-2 py-0.5 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-800 text-[11px]">
                                      확정
                                    </span>
                                  )}
                                  <b>{fmtProb(g.p)}</b>
                                </div>
                              </div>
                              <div className="mt-1 w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                                <motion.div
                                  initial={{ width: 0 }}
                                  animate={{ width: isOneProb(g.p) ? "100%" : pct(g.p) }}
                                  transition={{ type: "spring", stiffness: 260, damping: 28 }}
                                  className="h-full bg-gradient-to-r"
                                  style={{ backgroundImage: g.grad }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}

                    {/* 등급 확률 순서 요약: 0% 제외, 동률 표기 */}
                    {(() => {
                      const { order, comps } = rankGradeOrder(resultRun);
                      if (!order.length) return null;
                      return (
                        <div className="mt-2 rounded-xl bg-white/70">
                          <div className="text-xs text-gray-500 mb-1">가능성 높은 순서</div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {order.map((it, idx) => (
                              <React.Fragment key={it.key}>
                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border bg-white shadow-sm">
                                  <span
                                    className="inline-block w-2 h-2 rounded-full bg-gradient-to-r"
                                    style={{ backgroundImage: it.grad }}
                                  />
                                  <span className="text-sm">
                                    {it.label}{isOneProb(it.p) ? " (확정)" : ""}
                                  </span>
                                </span>
                                {idx < order.length - 1 && (
                                  <span className="mx-0.5 text-gray-400 select-none">
                                    {comps[idx] === "=" ? "＝" : "＞"}
                                  </span>
                                )}
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </motion.div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* 전역 토스트 스택: 중앙 오버레이로 알림 표시 */}
      <ToastStack toasts={toasts} onClose={remove} />

      {/* 광고 영역: Kakao Adfit 삽입 */}
      <div className="mt-6">
        <KakaoAdfit />
      </div>
    </div>

  );
}
