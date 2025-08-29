/* eslint-disable no-restricted-globals */
/**
 * LoA Gem Simulator Worker (deterministic RNG + Monte Carlo with early stopping)
 * - 메시지 타입:
 *   - 'EVAL'       : 단일 정책(STOP_ON_SUCCESS | RUN_TO_END) 확률/CI 계산
 *   - 'REROLL_EV'  : 리롤 EV(룩어헤드) 계산 (현재 4슬롯 vs 리롤 샘플 평균)
 */
const GRADE = { LEGEND_MIN: 4, LEGEND_MAX: 15, RELIC_MIN: 16, RELIC_MAX: 18, ANCIENT_MIN: 19 };
const GEM_TYPES = {
  "질서-안정": { baseNeed: 8, attack: ["공격력", "추가 피해"], support: ["낙인력", "아군 피해 강화"] },
  "질서-견고": { baseNeed: 9, attack: ["공격력", "보스 피해"], support: ["아군 피해 강화", "아군 공격 강화"] },
  "질서-불변": { baseNeed: 10, attack: ["추가 피해", "보스 피해"], support: ["낙인력", "아군 공격 강화"] },
  "혼돈-침식": { baseNeed: 8, attack: ["공격력", "추가 피해"], support: ["낙인력", "아군 피해 강화"] },
  "혼돈-왜곡": { baseNeed: 9, attack: ["공격력", "보스 피해"], support: ["아군 피해 강화", "아군 공격 강화"] },
  "혼돈-붕괴": { baseNeed: 10, attack: ["추가 피해", "보스 피해"], support: ["낙인력", "아군 공격 강화"] },
};
const MIN_STAT = 1;
const MAX_STAT = 5;
const GOLD_PER_ATTEMPT = 900;
const OFFICIAL_RNG = true;

/* ===== RNG / utils ===== */
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
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const totalScore = (s) => s.eff + s.pts + s.aLvl + s.bLvl;
function gradeOf(score) {
  if (score >= GRADE.ANCIENT_MIN) return "고대";
  if (score >= GRADE.RELIC_MIN && score <= GRADE.RELIC_MAX) return "유물";
  if (score >= GRADE.LEGEND_MIN && score <= GRADE.LEGEND_MAX) return "전설";
  return "등급 미만";
}

/* ===== rules helpers ===== */
function allowedEffectNames(gemKey, pos) {
  const g = GEM_TYPES[gemKey];
  if (!g) return [];
  if (pos === "공격형") return g.attack;
  if (pos === "지원형") return g.support;
  return [...g.attack, ...g.support];
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

/* ===== rolling table & apply ===== */
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

/* ===== label <-> slot ===== */
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

/* ===== core simulation ===== */
const ZERO_VALUE = { successProb: 0, legendProb: 0, relicProb: 0, ancientProb: 0, expectedGold: 0 };
function evaluateFromSimulation(
  gemKey, pos, abMode, start, target, policy, attemptsLeft, rerolls, costAddRate, unlockedReroll, selectedFirstFour, seed, tgtNames, opts = {}
) {
  const { maxTrials = 50000, epsilon = 0.002, batch = 1000 } = opts;
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

    if (policy === "STOP_ON_SUCCESS" &&
        meetsTargetByMode(pos, abMode, s, target, gemKey, tgtNames)) {
      const score = totalScore(s);
      const g = gradeOf(score);
      return {
        successProb: 1,
        legendProb: g === "전설" ? 1 : 0,
        relicProb:  g === "유물" ? 1 : 0,
        ancientProb:g === "고대" ? 1 : 0,
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
        s = res.next; goldSum += res.goldThisAttempt; rate = res.nextRate; rrs += res.rerollDelta; unlocked = true;
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
  while (n < maxTrials) {
    const until = Math.min(batch, maxTrials - n);
    for (let i = 0; i < until; i++) {
      const one = simOnce();
      succSum   += one.successProb;
      legendSum += one.legendProb;
      relicSum  += one.relicProb;
      ancientSum+= one.ancientProb;
      goldSum   += one.expectedGold;
    }
    n += until;

    // 95% CI for Bernoulli
    const p  = succSum / n;
    const se = Math.sqrt(Math.max(p*(1-p), 0) / Math.max(n, 1));
    const hw = 1.96 * se;
    if (hw <= epsilon) {
      agg.ci = { low: Math.max(0, p - hw), high: Math.min(1, p + hw), halfWidth: hw };
      break;
    } else {
      agg.ci = { low: Math.max(0, p - hw), high: Math.min(1, p + hw), halfWidth: hw };
    }
  }

  agg.trialsUsed  = n;
  agg.successProb = succSum / n;
  agg.legendProb  = legendSum / n;
  agg.relicProb   = relicSum  / n;
  agg.ancientProb = ancientSum/ n;
  agg.expectedGold= goldSum   / n;
  return agg;
}

/* ===== EV for reroll (lookahead) ===== */
function expectedSuccessProbForLabels(labels, gemKeyIn, posIn, abForEval, manualIn, tgtIn, seed, tgtNames) {
  let acc = 0, cnt = 0;
  for (const lb of labels) {
    const sl = labelToSlot(lb, manualIn.state); if (!sl) continue;
    if (sl.kind === "A_CHANGE") {
      const ok = allowedEffectNames(gemKeyIn, "상관 없음")
        .filter((n) => n !== manualIn.state.bName && n !== manualIn.state.aName).length > 0;
      if (!ok) continue;
    }
    if (sl.kind === "B_CHANGE") {
      const ok = allowedEffectNames(gemKeyIn, "상관 없음")
        .filter((n) => n !== manualIn.state.aName && n !== manualIn.state.bName).length > 0;
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
      { maxTrials: 8000, epsilon: 0.006, batch: 500 }
    );
    acc += v.successProb; cnt += 1;
  }
  return cnt ? acc / cnt : 0;
}
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

/* ===== worker message handling ===== */
self.addEventListener("message", (e) => {
  try {
    const { type, jobId, payload } = e.data || {};
    if (type === "EVAL") {
      const {
        gemKey, pos, abMode, start, target, policy,
        attemptsLeft, rerolls, costAddRate, unlockedReroll,
        selectedFirstFour, seed, tgtNames, opts
      } = payload;
      const result = evaluateFromSimulation(
        gemKey, pos, abMode, start, target, policy, attemptsLeft, rerolls,
        costAddRate, unlockedReroll, selectedFirstFour || [], seed, tgtNames, opts || {}
      );
      self.postMessage({ type: "EVAL_RESULT", jobId, policy, result });
      return;
    }
    if (type === "REROLL_EV") {
      const {
        gemKey, pos, abModePrimary, manual, tgt, manLabels, tgtNames,
        REROLL_SAMPLES = 16, TAU = 0.0025
      } = payload;
      const abForEval = pos === "상관 없음" ? "ANY_ONE" : abModePrimary;
      const seedBase = makeDeterministicSeed({ gemKey, pos, manual, tgt, manLabels, abForEval, salt: "REROLL_EV" });

      const nowProb = expectedSuccessProbForLabels(manLabels, gemKey, pos, abForEval, manual, tgt, seedBase + 7, tgtNames);

      let acc = 0;
      for (let i = 0; i < REROLL_SAMPLES; i++) {
        const seed = seedBase + 1000 + i * 31;
        const afterRerollManual = { ...manual, rerolls: manual.rerolls - 1 };
        const newSlots = sampleNewFourSlots(seed, gemKey, pos, afterRerollManual);
        const newLabels = slotsToLabels(newSlots, afterRerollManual.state);
        const prob = expectedSuccessProbForLabels(newLabels, gemKey, pos, abForEval, afterRerollManual, tgt, seed + 17, tgtNames);
        acc += prob;
      }
      const rerollProb = acc / REROLL_SAMPLES;
      const delta = rerollProb - nowProb;
      const pct = (x) => (x * 100).toFixed(2) + "%";

      let shouldReroll = false;
      let reason = "";
      if (delta > TAU) {
        shouldReroll = true;
        reason = `룩어헤드 기준 리롤 추천: 현재 최선 ${pct(nowProb)} → 리롤 기대 ${pct(rerollProb)} (▲${pct(delta)}).`;
      } else if (delta < -TAU) {
        shouldReroll = false;
        reason = `룩어헤드 기준 리롤 비추천: 현재 최선 ${pct(nowProb)}가 리롤 기대 ${pct(rerollProb)}보다 유리 (▼${pct(-delta)}).`;
      } else {
        shouldReroll = false;
        reason = `두 경로 차이 미미: 현재 ${pct(nowProb)} vs 리롤 ${pct(rerollProb)} (|Δ| < ${(TAU * 100).toFixed(2)}%).`;
      }

      self.postMessage({
        type: "REROLL_RESULT",
        jobId,
        result: { shouldReroll, reason, nowProb, rerollProb, delta }
      });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "WORKER_ERROR", message: String(err), stack: err?.stack });
  }
});
