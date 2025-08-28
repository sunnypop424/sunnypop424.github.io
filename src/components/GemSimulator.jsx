import React, { useEffect, useMemo, useRef, useState } from "react";

// LoA 젬 가공 도우미 · 룰북 확률 시뮬레이터 (v2.9.2)
// ------------------------------------------------------
// 🔁 "추가 효과": 상관 없음 / 딜러 / 서포터
// 🧩 딜러·서포터일 때 ANY_ONE/BOTH 선택 후 "저장됨(읽기전용)"
// 🎯 결과는 "선택된 모드만" 계산/표시
//    - 상관 없음 → IGNORE_AB (A/B 완전 무시)
//    - ANY_ONE → 1개 이상 만족
//    - BOTH    → 2개 모두 만족
// 🧠 상관 없음: 판정에서 A/B 완전 제외(효과 변경 포함 전부 허용)
// ✅ 유지: 비용 보정(다음 차수부터), 중복 금지, 표 규격 미등장, 결정적 Monte Carlo(5,000회)
// 🟢 NEW(v2.9.2): 리롤 추천/비추천 = 1-스텝 룩어헤드 기반 “최종 성공확률 EV 비교(B안)”
// ------------------------------------------------------

// -------------------- Deterministic RNG --------------------
function hash32(str) {
  let h = 2166136261 >>> 0; // FNV-1a
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

// -------------------- Consts --------------------
const GRADE = {
  LEGEND_MIN: 4,
  LEGEND_MAX: 15,
  RELIC_MIN: 16,
  RELIC_MAX: 18,
  ANCIENT_MIN: 19,
};

const GEM_TYPES = {
  // 질서
  "질서-안정": {
    baseNeed: 8,
    attack: ["공격력", "추가 피해"],
    support: ["낙인력", "아군 피해 강화"],
  },
  "질서-견고": {
    baseNeed: 9,
    attack: ["공격력", "보스 피해"],
    support: ["아군 피해 강화", "아군 공격 강화"],
  },
  "질서-불변": {
    baseNeed: 10,
    attack: ["추가 피해", "보스 피해"],
    support: ["낙인력", "아군 공격 강화"],
  },
  // 혼돈
  "혼돈-침식": {
    baseNeed: 8,
    attack: ["공격력", "추가 피해"],
    support: ["낙인력", "아군 피해 강화"],
  },
  "혼돈-왜곡": {
    baseNeed: 9,
    attack: ["공격력", "보스 피해"],
    support: ["아군 피해 강화", "아군 공격 강화"],
  },
  "혼돈-붕괴": {
    baseNeed: 10,
    attack: ["추가 피해", "보스 피해"],
    support: ["낙인력", "아군 공격 강화"],
  },
};

const RARITY_ATTEMPTS = { 고급: 5, 희귀: 7, 영웅: 9 };
const RARITY_BASE_REROLLS = { 고급: 0, 희귀: 1, 영웅: 2 };
const MAX_STAT = 5; // 포인트/레벨/의지력 효율 모두 0~5
const GOLD_PER_ATTEMPT = 900;
const TRIALS = 2000; // 항상 5000회

// -------------------- Utils --------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtProb = (p) =>
  (isNaN(p) ? 0 : Math.max(0, Math.min(1, p))) * 100
    .toFixed?.() === undefined
    ? (Math.max(0, Math.min(1, p)) * 100).toFixed(4) + "%"
    : (Math.max(0, Math.min(1, p)) * 100).toFixed(4) + "%";
const fmtNum = (n) => n.toLocaleString();

function allowedEffectNames(gemKey, pos) {
  const g = GEM_TYPES[gemKey];
  if (!g) return [];
  if (pos === "딜러") return g.attack;
  if (pos === "서포터") return g.support;
  return [...g.attack, ...g.support];
}
function validatePositionConstraint(pos, aName, bName, gemKey) {
  if (pos === "상관 없음") return true;
  const { attack, support } = GEM_TYPES[gemKey];
  const isAtk = (n) => attack.includes(n);
  const isSup = (n) => support.includes(n);
  const aAtk = isAtk(aName),
    bAtk = isAtk(bName);
  const aSup = isSup(aName),
    bSup = isSup(bName);
  if (pos === "딜러") return aAtk || bAtk;
  if (pos === "서포터") return aSup || bSup;
  return true;
}
const totalScore = (s) => s.eff + s.pts + s.aLvl + s.bLvl;
function gradeOf(score) {
  if (score >= GRADE.ANCIENT_MIN) return "고대";
  if (score >= GRADE.RELIC_MIN && score <= GRADE.RELIC_MAX) return "유물";
  if (score >= GRADE.LEGEND_MIN && score <= GRADE.LEGEND_MAX) return "전설";
  return "등급 미만";
}

// ✅ 목표 판정/거리
function meetsTargetByMode(pos, abMode, s, t) {
  const base = s.eff >= t.eff && s.pts >= t.pts;
  if (pos === "상관 없음") return base;
  if (abMode === "ANY_ONE")
    return base && (s.aLvl >= t.aLvl || s.bLvl >= t.bLvl);
  return base && s.aLvl >= t.aLvl && s.bLvl >= t.bLvl;
}
function needDistanceByMode(pos, abMode, s, t) {
  let sum =
    Math.max(0, t.eff - s.eff) + Math.max(0, t.pts - s.pts);
  if (pos !== "상관 없음") {
    if (abMode === "BOTH") {
      sum +=
        Math.max(0, t.aLvl - s.aLvl) + Math.max(0, t.bLvl - s.bLvl);
    } else {
      const needA = Math.max(0, t.aLvl - s.aLvl);
      const needB = Math.max(0, t.bLvl - s.bLvl);
      sum += Math.min(needA, needB);
    }
  }
  return sum;
}

// -------------------- Rule Table --------------------
function minusAppears_TABLE(v) {
  // 표 규격: 값이 1인 경우에만 -1 미등장
  return v !== 1;
}

function buildWeightedItems(state, attemptsLeft, pos, gemKey, costAddRate) {
  const s = state;
  const items = [];

  // 의지력 효율
  if (s.eff < 5) items.push({ slot: { kind: "EFF", delta: 1 }, w: 11.65 });
  if (s.eff <= 3) items.push({ slot: { kind: "EFF", delta: 2 }, w: 4.4 });
  if (s.eff <= 2) items.push({ slot: { kind: "EFF", delta: 3 }, w: 1.75 });
  if (s.eff <= 1) items.push({ slot: { kind: "EFF", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.eff))
    items.push({ slot: { kind: "EFF", delta: -1 }, w: 3.0 });

  // 포인트
  if (s.pts < 5) items.push({ slot: { kind: "PTS", delta: 1 }, w: 11.65 });
  if (s.pts <= 3) items.push({ slot: { kind: "PTS", delta: 2 }, w: 4.4 });
  if (s.pts <= 2) items.push({ slot: { kind: "PTS", delta: 3 }, w: 1.75 });
  if (s.pts <= 1) items.push({ slot: { kind: "PTS", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.pts))
    items.push({ slot: { kind: "PTS", delta: -1 }, w: 3.0 });

  // A/B 레벨
  if (s.aLvl < 5) items.push({ slot: { kind: "A_LVL", delta: 1 }, w: 11.65 });
  if (s.aLvl <= 3) items.push({ slot: { kind: "A_LVL", delta: 2 }, w: 4.4 });
  if (s.aLvl <= 2) items.push({ slot: { kind: "A_LVL", delta: 3 }, w: 1.75 });
  if (s.aLvl <= 1) items.push({ slot: { kind: "A_LVL", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.aLvl))
    items.push({ slot: { kind: "A_LVL", delta: -1 }, w: 3.0 });

  if (s.bLvl < 5) items.push({ slot: { kind: "B_LVL", delta: 1 }, w: 11.65 });
  if (s.bLvl <= 3) items.push({ slot: { kind: "B_LVL", delta: 2 }, w: 4.4 });
  if (s.bLvl <= 2) items.push({ slot: { kind: "B_LVL", delta: 3 }, w: 1.75 });
  if (s.bLvl <= 1) items.push({ slot: { kind: "B_LVL", delta: 4 }, w: 0.45 });
  if (minusAppears_TABLE(s.bLvl))
    items.push({ slot: { kind: "B_LVL", delta: -1 }, w: 3.0 });

  // 효과 변경(가능 후보 존재 시에만)
  const names = allowedEffectNames(gemKey, pos);
  const canAChange =
    names.filter((n) => n !== s.bName && n !== s.aName).length > 0;
  const canBChange =
    names.filter((n) => n !== s.aName && n !== s.bName).length > 0;
  if (canAChange) items.push({ slot: { kind: "A_CHANGE" }, w: 3.25 });
  if (canBChange) items.push({ slot: { kind: "B_CHANGE" }, w: 3.25 });

  // 비용/리롤(남은 1회면 제외) + 상태 유지
  if (attemptsLeft > 1) {
    if (costAddRate !== 1)
      items.push({ slot: { kind: "COST", mod: 1 }, w: 1.75 });
    if (costAddRate !== -1)
      items.push({ slot: { kind: "COST", mod: -1 }, w: 1.75 });
    items.push({ slot: { kind: "REROLL_PLUS", amount: 1 }, w: 2.5 });
    items.push({ slot: { kind: "REROLL_PLUS", amount: 2 }, w: 0.75 });
  }
  items.push({ slot: { kind: "HOLD" }, w: 1.75 });

  return items;
}

// -------------------- Labels --------------------
function slotToPrettyLabel(slot, s) {
  switch (slot.kind) {
    case "EFF":
      return `의지력 효율 ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "PTS":
      return `포인트 ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "A_LVL":
      return `${s.aName} Lv. ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "B_LVL":
      return `${s.bName} Lv. ${slot.delta > 0 ? "+" + slot.delta : "-1"}`;
    case "A_CHANGE":
      return `${s.aName} 변경`;
    case "B_CHANGE":
      return `${s.bName} 변경`;
    case "COST":
      return slot.mod === 1
        ? "가공 비용 +100% 증가"
        : "가공 비용 -100% 감소";
    case "HOLD":
      return "가공 상태 유지";
    case "REROLL_PLUS":
      return `다른 항목 보기 ${
        slot.amount === 2 ? "+2회" : "+1회"
      }`;
    default:
      return "";
  }
}
function labelToSlot(label, s) {
  label = label.trim();
  const num = (t) =>
    t.includes("-1") ? -1 : parseInt(t.replace(/[^0-9]/g, ""), 10) || 1;
  if (label.startsWith("의지력 효율"))
    return { kind: "EFF", delta: num(label) };
  if (label.startsWith("포인트")) return { kind: "PTS", delta: num(label) };
  if (label.startsWith(s.aName + " "))
    return label.includes("변경")
      ? { kind: "A_CHANGE" }
      : { kind: "A_LVL", delta: num(label) };
  if (label.startsWith(s.bName + " "))
    return label.includes("변경")
      ? { kind: "B_CHANGE" }
      : { kind: "B_LVL", delta: num(label) };
  if (label.startsWith("가공 비용"))
    return { kind: "COST", mod: label.includes("+100%") ? 1 : -1 };
  if (label.startsWith("가공 상태 유지")) return { kind: "HOLD" };
  if (label.startsWith("다른 항목 보기"))
    return { kind: "REROLL_PLUS", amount: label.includes("+2") ? 2 : 1 };
  return null;
}

// -------------------- Apply Slot --------------------
function applySlot(gemKey, pos, s, slot, costAddRate) {
  let next = { ...s };
  const goldThisAttempt =
    GOLD_PER_ATTEMPT *
    (costAddRate === -1 ? 0 : costAddRate === 1 ? 2 : 1);
  let nextRate = costAddRate;
  let rerollDelta = 0;
  const names = allowedEffectNames(gemKey, pos);

  switch (slot.kind) {
    case "EFF":
      next.eff = clamp(next.eff + slot.delta, 0, MAX_STAT);
      break;
    case "PTS":
      next.pts = clamp(next.pts + slot.delta, 0, MAX_STAT);
      break;
    case "A_LVL":
      next.aLvl = clamp(next.aLvl + slot.delta, 0, MAX_STAT);
      break;
    case "B_LVL":
      next.bLvl = clamp(next.bLvl + slot.delta, 0, MAX_STAT);
      break;
    case "A_CHANGE": {
      const pool = names.filter(
        (n) => n !== next.bName && n !== next.aName
      );
      if (pool.length) next.aName = pool[0];
      break;
    }
    case "B_CHANGE": {
      const pool = names.filter(
        (n) => n !== next.aName && n !== next.bName
      );
      if (pool.length) next.bName = pool[0];
      break;
    }
    case "COST":
      nextRate = slot.mod; // 다음 가공부터 적용
      break;
    case "HOLD":
      break;
    case "REROLL_PLUS":
      rerollDelta += slot.amount;
      break;
    default:
      break;
  }
  return { next, goldThisAttempt, nextRate, rerollDelta };
}

// -------------------- Monte Carlo (Deterministic 5,000) --------------------
const ZERO_VALUE = {
  successProb: 0,
  legendProb: 0,
  relicProb: 0,
  ancientProb: 0,
  expectedGold: 0,
};

function evaluateFromSimulation(
  gemKey,
  pos,
  abMode,
  start,
  target,
  policy,
  attemptsLeft,
  rerolls,
  costAddRate,
  unlockedReroll,
  selectedFirstFour,
  seed
) {
  const rand = makeRNG(seed);
  const weightedPickIndex = (arr) => {
    const sum = arr.reduce((a, b) => a + b.w, 0);
    let r = rand() * sum;
    for (let i = 0; i < arr.length; i++) {
      r -= arr[i].w;
      if (r <= 0) return i;
    }
    return arr.length - 1;
  };
  const desirability = (s) => needDistanceByMode(pos, abMode, s, target);

  let agg = { ...ZERO_VALUE };

  const simOnce = () => {
    let s = { ...start };
    let left = attemptsLeft;
    let rrs = rerolls;
    let unlocked = unlockedReroll;
    let rate = costAddRate;
    let goldSum = 0;
    let first = true;

    while (left > 0) {
      // 후보 4개 생성
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

      // 🔧 사전 계산: 현재 상태에서 A/B 변경 가능 여부 (loop 내부 함수 생성 방지)
      const namesList = allowedEffectNames(gemKey, pos);
      const aName = s.aName;
      const bName = s.bName;
      const canAChange = namesList.some((n) => n !== bName && n !== aName);
      const canBChange = namesList.some((n) => n !== aName && n !== bName);

      // 최적 선택(목표까지의 필요치 감소 최대)
      const before = desirability(s);
      let best = null;
      for (const sl of cand) {
        if (sl.kind === "A_CHANGE" && !canAChange) continue;
        if (sl.kind === "B_CHANGE" && !canBChange) continue;

        const res = applySlot(gemKey, pos, s, sl, rate);
        const gain = before - desirability(res.next);
        if (!best || gain > best.gain) {
          best = {
            next: res.next,
            gold: res.goldThisAttempt,
            nextRate: res.nextRate,
            rrd: res.rerollDelta,
            gain,
          };
        }
      }

      // 개선이 없고 리롤 가능 → 리롤 소비 후 다시 뽑기(상태/남은 시도 불변)
      if (best && best.gain <= 0 && unlocked && rrs > 0) {
        rrs -= 1;
        first = false;
        continue;
      }

      if (best) {
        s = best.next;
        goldSum += best.gold;
        rate = best.nextRate;
        rrs += best.rrd;
        unlocked = true;
      }
      left -= 1;
      first = false;
      if (policy === "STOP_ON_SUCCESS" && meetsTargetByMode(pos, abMode, s, target))
        break;
    }

    const score = totalScore(s);
    const g = gradeOf(score);
    return {
      successProb: meetsTargetByMode(pos, abMode, s, target) ? 1 : 0,
      legendProb: g === "전설" ? 1 : 0,
      relicProb: g === "유물" ? 1 : 0,
      ancientProb: g === "고대" ? 1 : 0,
      expectedGold: goldSum,
    };
  };

  for (let t = 0; t < TRIALS; t++) {
    const one = simOnce();
    agg.successProb += one.successProb;
    agg.legendProb += one.legendProb;
    agg.relicProb += one.relicProb;
    agg.ancientProb += one.ancientProb;
    agg.expectedGold += one.expectedGold;
  }
  agg.successProb /= TRIALS;
  agg.legendProb /= TRIALS;
  agg.relicProb /= TRIALS;
  agg.ancientProb /= TRIALS;
  agg.expectedGold /= TRIALS;
  return agg;
}

// -------------------- UI Bits --------------------
const Section = ({ title, children }) => (
  <div className="mb-6">
    <div className="text-lg font-semibold mb-2">{title}</div>
    <div className="p-4 rounded-2xl bg-white/60 shadow border border-gray-200">
      {children}
    </div>
  </div>
);
const Row = ({ children }) => (
  <div className="flex flex-wrap gap-3 items-center mb-3">{children}</div>
);
const Label = ({ children }) => (
  <span className="text-sm text-gray-600 w-28">{children}</span>
);
const NumInput = ({ value, set, min = 0, max = 99, disabled }) => (
  <input
    type="number"
    className="px-2 py-1 border rounded w-24"
    value={value}
    min={min}
    max={max}
    disabled={disabled}
    onChange={(e) =>
      set(
        clamp(
          parseInt(e.target.value || "0", 10),
          min ?? 0,
          max ?? 99
        )
      )
    }
  />
);
const Select = ({ value, set, options, disabled }) => (
  <select
    className="px-2 py-1 border rounded"
    value={value}
    onChange={(e) => set(e.target.value)}
    disabled={disabled}
  >
    {options.map((o, i) => (
      <option key={o + String(i)} value={o}>
        {o}
      </option>
    ))}
  </select>
);
const Toggle = ({ on, set }) => (
  <button
    className={`px-3 py-1 rounded-full text-sm border ${
      on ? "bg-blue-600 text-white" : "bg-white"
    }`}
    onClick={() => set(!on)}
  >
    {on ? "저장됨 (readonly)" : "편집 중"}
  </button>
);

function hasDuplicateLabels(labels) {
  const arr = labels.filter(Boolean);
  return new Set(arr).size !== arr.length;
}

// -------------------- Main --------------------
export default function GemSimulator() {
  const [gemKey, setGemKey] = useState("질서-안정");
  const [pos, setPos] = useState("상관 없음");
  const [rarity, setRarity] = useState("영웅");
  const [abModePrimary, setAbModePrimary] = useState("ANY_ONE");

  const effectPoolAny = useMemo(
    () => allowedEffectNames(gemKey, "상관 없음"),
    [gemKey]
  );
  const effectPoolByPos = useMemo(
    () => allowedEffectNames(gemKey, pos),
    [gemKey, pos]
  );

  const [cur, setCur] = useState({
    eff: 0,
    pts: 0,
    aName: effectPoolAny[0],
    aLvl: 0,
    bName: effectPoolAny[1] || effectPoolAny[0],
    bLvl: 0,
  });
  const [tgt, setTgt] = useState({ eff: 0, pts: 0, aLvl: 0, bLvl: 0 });

  const [curLocked, setCurLocked] = useState(false);
  const [tgtLocked, setTgtLocked] = useState(false);
  const [alert, setAlert] = useState(null);

  const curValid =
    pos === "상관 없음"
      ? true
      : cur.aName !== cur.bName &&
        validatePositionConstraint(pos, cur.aName, cur.bName, gemKey);

  // 수동 시뮬 상태
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
    // ✅ deps: cur 객체 단위로 관리
  }, [rarity, cur]);

  // 전체 선택지 라벨
  const allOptionLabels = useMemo(() => {
    const items = buildWeightedItems(
      manual.state,
      manual.attemptsLeft,
      pos,
      gemKey,
      manual.costAddRate
    );
    const labels = items.map((it) =>
      slotToPrettyLabel(it.slot, manual.state)
    );
    return Array.from(new Set(labels));
  }, [
    manual.state,
    manual.attemptsLeft,
    manual.costAddRate,
    pos,
    gemKey,
  ]);

  // SelectBox 4개 초기값
  const defaultLabels = useMemo(() => {
    const want = [
      `의지력 효율 +1`,
      `포인트 +1`,
      `${manual.state.aName} Lv. +1`,
      `${manual.state.bName} Lv. +1`,
    ];
    const out = [];
    let cursor = 0;
    for (const w of want) {
      if (allOptionLabels.includes(w) && !out.includes(w)) out.push(w);
      else {
        while (
          cursor < allOptionLabels.length &&
          out.includes(allOptionLabels[cursor])
        )
          cursor++;
        out.push(allOptionLabels[cursor] ?? w);
        cursor++;
      }
    }
    while (out.length < 4) {
      while (
        cursor < allOptionLabels.length &&
        out.includes(allOptionLabels[cursor])
      )
        cursor++;
      out.push(
        allOptionLabels[cursor++] ??
          allOptionLabels[0] ??
          "가공 상태 유지"
      );
    }
    return out.slice(0, 4);
  }, [allOptionLabels, manual.state.aName, manual.state.bName]);

  const [manLabels, setManLabels] = useState(defaultLabels);
  useEffect(() => {
    setManLabels((prev) => {
      const next = prev.map((v, i) =>
        allOptionLabels.includes(v)
          ? v
          : allOptionLabels[i] ?? allOptionLabels[0] ?? v
      );
      const used = new Set();
      for (let i = 0; i < next.length; i++) {
        if (!used.has(next[i])) {
          used.add(next[i]);
          continue;
        }
        const replacement = allOptionLabels.find((l) => !used.has(l));
        if (replacement) {
          next[i] = replacement; // ✅ comma operator 제거
          used.add(replacement);
        }
      }
      return next;
    });
  }, [allOptionLabels]);

  // ---------- 확률 계산(선택 모드만) ----------
  const [resultStop, setResultStop] = useState(null);
  const [resultRun, setResultRun] = useState(null);
  const [isComputing, setIsComputing] = useState(false);
  const tokenRef = useRef(0);

  // ---- Reroll EV Helpers (1-step lookahead, success-prob based) ----
  const REROLL_SAMPLES = 16; // 샘플 수 (성능/정확도 트레이드오프)
  const TAU = 0.0025; // 최소 유의차: 0.25%p 이상 차이일 때만 추천

  function bestSuccessProbForLabels(
    labels,
    gemKeyIn,
    posIn,
    abForEval,
    manualIn,
    tgtIn,
    seed
  ) {
    let best = 0;
    for (const lb of labels) {
      const sl = labelToSlot(lb, manualIn.state);
      if (!sl) continue;
      if (sl.kind === "A_CHANGE") {
        const ok =
          allowedEffectNames(gemKeyIn, posIn).filter(
            (n) => n !== manualIn.state.bName && n !== manualIn.state.aName
          ).length > 0;
        if (!ok) continue;
      }
      if (sl.kind === "B_CHANGE") {
        const ok =
          allowedEffectNames(gemKeyIn, posIn).filter(
            (n) => n !== manualIn.state.aName && n !== manualIn.state.bName
          ).length > 0;
        if (!ok) continue;
      }
      // 가상 적용(시도 1회 소비)
      const res = applySlot(
        gemKeyIn,
        posIn,
        manualIn.state,
        sl,
        manualIn.costAddRate
      );
      const nextManual = {
        attemptsLeft: manualIn.attemptsLeft - 1,
        rerolls: manualIn.rerolls + res.rerollDelta,
        unlocked: true,
        costAddRate: res.nextRate,
        gold: manualIn.gold + res.goldThisAttempt,
        state: res.next,
      };
      // 이후는 RUN_TO_END 성공확률
      const v = evaluateFromSimulation(
        gemKeyIn,
        posIn,
        abForEval,
        nextManual.state,
        tgtIn,
        "RUN_TO_END",
        nextManual.attemptsLeft,
        nextManual.rerolls,
        nextManual.costAddRate,
        nextManual.unlocked,
        [],
        seed + hash32(lb)
      );
      if (v.successProb > best) best = v.successProb;
    }
    return best;
  }

  function sampleNewFourSlots(seed, gemKeyIn, posIn, manualIn) {
    const rng = makeRNG(seed);
    const pool = buildWeightedItems(
      manualIn.state,
      manualIn.attemptsLeft,
      posIn,
      gemKeyIn,
      manualIn.costAddRate
    );
    const temp = [...pool];
    const out = [];
    const weightedPickIndex = (arr) => {
      const sum = arr.reduce((a, b) => a + b.w, 0);
      let r = rng() * sum;
      for (let i = 0; i < arr.length; i++) {
        r -= arr[i].w;
        if (r <= 0) return i;
      }
      return arr.length - 1;
    };
    const n = Math.min(4, temp.length);
    for (let i = 0; i < n; i++) {
      const idx = weightedPickIndex(temp);
      out.push(temp[idx].slot);
      temp.splice(idx, 1);
    }
    return out;
  }

  function slotsToLabels(slots, s) {
    return slots.map((sl) => slotToPrettyLabel(sl, s));
  }

  // ---- 리롤 추천 로직(B안): 1-step lookahead, 최종 성공확률 EV 비교 ----
  const rerollAdvice = useMemo(() => {
    if (!manual.unlocked)
      return {
        shouldReroll: false,
        reason: "첫 가공 이전에는 리롤 추천을 하지 않습니다.",
      };
    if (manual.rerolls <= 0)
      return { shouldReroll: false, reason: "리롤이 없습니다." };
    if (manual.attemptsLeft <= 0)
      return {
        shouldReroll: false,
        reason: "가공이 완료되어 리롤 판단이 무의미합니다.",
      };

    const abForEval = pos === "상관 없음" ? "ANY_ONE" : abModePrimary;
    const seedBase = makeDeterministicSeed({
      gemKey,
      pos,
      rarity,
      manual,
      tgt,
      manLabels,
      abForEval,
      salt: "REROLL_EV",
    });

    // NOW: 현 4개 중 최선 1개 선택 후 RUN_TO_END 성공확률
    const nowProb = bestSuccessProbForLabels(
      manLabels,
      gemKey,
      pos,
      abForEval,
      manual,
      tgt,
      seedBase + 7
    );

    // REROLL: 리롤 -1 후 새 4개 샘플링 → 각 최선 → 평균
    let acc = 0;
    for (let i = 0; i < REROLL_SAMPLES; i++) {
      const seed = seedBase + 1000 + i * 31;
      const afterRerollManual = { ...manual, rerolls: manual.rerolls - 1 };
      const newSlots = sampleNewFourSlots(
        seed,
        gemKey,
        pos,
        afterRerollManual
      );
      const newLabels = slotsToLabels(newSlots, afterRerollManual.state);

      const prob = bestSuccessProbForLabels(
        newLabels,
        gemKey,
        pos,
        abForEval,
        afterRerollManual,
        tgt,
        seed + 17
      );
      acc += prob;
    }
    const rerollProb = acc / REROLL_SAMPLES;

    const delta = rerollProb - nowProb;
    const pct = (x) => (x * 100).toFixed(2) + "%";

    if (delta > TAU) {
      return {
        shouldReroll: true,
        reason: `룩어헤드 기준 리롤 추천: 현재 최선 ${pct(
          nowProb
        )} → 리롤 기대 ${pct(rerollProb)} (▲${pct(delta)}).`,
      };
    } else if (delta < -TAU) {
      return {
        shouldReroll: false,
        reason: `룩어헤드 기준 리롤 비추천: 현재 최선 ${pct(
          nowProb
        )}가 리롤 기대 ${pct(rerollProb)}보다 유리 (▼${pct(-delta)}).`,
      };
    } else {
      return {
        shouldReroll: false,
        reason: `두 경로 차이 미미: 현재 ${pct(
          nowProb
        )} vs 리롤 ${pct(rerollProb)} (|Δ| < ${(TAU * 100).toFixed(2)}%).`,
      };
    }
    // ✅ deps: manual 객체 단위
  }, [manual, manLabels, tgt, gemKey, pos, abModePrimary, rarity]);

  useEffect(() => {
    // 잠금/유효성/중복 체크
    if (!tgtLocked || !curValid) {
      setResultStop(null);
      setResultRun(null);
      return;
    }
    if (hasDuplicateLabels(manLabels)) {
      setAlert("중복된 항목이 있습니다. 확인해주세요.");
      setResultStop(null);
      setResultRun(null);
      return;
    }

    // 현재 1회차 선택지 → Slot[]
    const selectedFirstFour = manLabels
      .map((lb) => labelToSlot(lb, manual.state))
      .filter((x) => !!x);

    const calcMode = pos === "상관 없음" ? "IGNORE_AB" : abModePrimary; // for seed only
    const abForEval = pos === "상관 없음" ? "ANY_ONE" : abModePrimary;

    const seedBase = makeDeterministicSeed({
      gemKey,
      pos,
      rarity,
      manual,
      tgt,
      selectedFirstFour,
      calcMode,
    });

    const token = ++tokenRef.current;
    setIsComputing(true);
    setTimeout(() => {
      const stop = evaluateFromSimulation(
        gemKey,
        pos,
        abForEval,
        manual.state,
        tgt,
        "STOP_ON_SUCCESS",
        manual.attemptsLeft,
        manual.rerolls,
        manual.costAddRate,
        manual.unlocked,
        selectedFirstFour,
        seedBase + 101
      );
      const run = evaluateFromSimulation(
        gemKey,
        pos,
        abForEval,
        manual.state,
        tgt,
        "RUN_TO_END",
        manual.attemptsLeft,
        manual.rerolls,
        manual.costAddRate,
        manual.unlocked,
        selectedFirstFour,
        seedBase + 103
      );
      if (token === tokenRef.current) {
        setResultStop(stop);
        setResultRun(run);
        setIsComputing(false);
      }
    }, 0);
  }, [
    gemKey,
    pos,
    rarity,
    curValid,
    manual,
    tgt,
    tgtLocked,
    manLabels,
    abModePrimary,
  ]);

  // -------------------- Actions --------------------
  function applyManual(slotIdx) {
    if (!tgtLocked) {
      setAlert("목표 옵션을 먼저 저장해 주세요.");
      return;
    }
    if (manual.attemptsLeft <= 0) return;
    if (hasDuplicateLabels(manLabels)) {
      setAlert("중복된 항목이 있습니다. 확인해주세요.");
      return;
    }

    const label = manLabels[slotIdx];
    if (!allOptionLabels.includes(label)) {
      setAlert("미등장 조건으로 현재 선택은 사용할 수 없어요.");
      return;
    }
    const action = labelToSlot(label, manual.state);
    if (!action) {
      setAlert("선택을 해석할 수 없어요.");
      return;
    }

    if (action.kind === "A_CHANGE") {
      const ok =
        allowedEffectNames(gemKey, pos).filter(
          (n) =>
            n !== manual.state.bName && n !== manual.state.aName
        ).length > 0;
      if (!ok) {
        setAlert("추가 효과 조건/중복으로 효과 변경이 불가합니다.");
        return;
      }
    }
    if (action.kind === "B_CHANGE") {
      const ok =
        allowedEffectNames(gemKey, pos).filter(
          (n) =>
            n !== manual.state.aName && n !== manual.state.bName
        ).length > 0;
      if (!ok) {
        setAlert("추가 효과 조건/중복으로 효과 변경이 불가합니다.");
        return;
      }
    }

    const res = applySlot(
      gemKey,
      pos,
      manual.state,
      action,
      manual.costAddRate
    );
    setManual((m) => ({
      attemptsLeft: m.attemptsLeft - 1,
      rerolls: m.rerolls + res.rerollDelta,
      unlocked: true,
      costAddRate: res.nextRate,
      gold: m.gold + res.goldThisAttempt,
      state: res.next,
    }));
  }

  function doReroll() {
    if (!manual.unlocked) {
      setAlert("가공 1회 이후부터 리롤을 사용할 수 있어요.");
      return;
    }
    if (manual.rerolls <= 0) {
      setAlert("리롤 횟수가 부족해요.");
      return;
    }
    setManual((m) => ({ ...m, rerolls: m.rerolls - 1 }));
  }

  function manualReset() {
    setManual({
      attemptsLeft: RARITY_ATTEMPTS[rarity],
      rerolls: RARITY_BASE_REROLLS[rarity],
      unlocked: false,
      costAddRate: 0,
      gold: 0,
      state: { ...cur },
    });
  }

  // -------------------- Self Tests (light) --------------------
  const tests = useMemo(() => {
    const arr = [];

    const table0 = buildWeightedItems(
      { eff: 0, pts: 0, aName: "공격력", aLvl: 0, bName: "추가 피해", bLvl: 0 },
      9,
      pos,
      gemKey,
      0
    );
    arr.push({
      name: "eff +1 present at start",
      ok: table0.some(
        (t) => t.slot.kind === "EFF" && t.slot.delta === 1
      ),
    });

    const tableEnd = buildWeightedItems(
      {
        eff: 5,
        pts: 5,
        aName: "공격력",
        aLvl: 5,
        bName: "추가 피해",
        bLvl: 5,
      },
      1,
      pos,
      gemKey,
      0
    );
    arr.push({
      name: "last attempt excludes cost/reroll",
      ok:
        !tableEnd.some((t) => t.slot.kind === "COST") &&
        !tableEnd.some((t) => t.slot.kind === "REROLL_PLUS"),
    });

    const noEffMinusWhen1 = buildWeightedItems(
      { eff: 1, pts: 0, aName: "공격력", aLvl: 0, bName: "추가 피해", bLvl: 0 },
      9,
      pos,
      gemKey,
      0
    );
    arr.push({
      name: "eff -1 excluded when eff==1",
      ok: !noEffMinusWhen1.some(
        (t) => t.slot.kind === "EFF" && t.slot.delta === -1
      ),
    });

    const costPlusHiddenWhenPlus = buildWeightedItems(
      { eff: 0, pts: 0, aName: "공격력", aLvl: 0, bName: "추가 피해", bLvl: 0 },
      9,
      pos,
      gemKey,
      1
    );
    arr.push({
      name: "cost +100 excluded when already +100",
      ok: !costPlusHiddenWhenPlus.some(
        (t) => t.slot.kind === "COST" && t.slot.mod === 1
      ),
    });

    const costMinusHiddenWhenMinus = buildWeightedItems(
      { eff: 0, pts: 0, aName: "공격력", aLvl: 0, bName: "추가 피해", bLvl: 0 },
      9,
      pos,
      gemKey,
      -1
    );
    arr.push({
      name: "cost -100 excluded when already -100",
      ok: !costMinusHiddenWhenMinus.some(
        (t) => t.slot.kind === "COST" && t.slot.mod === -1
      ),
    });

    // 모드별 판정 테스트: 상관 없음이면 A/B 무시
    const s = {
      eff: 3,
      pts: 2,
      aName: "공격력",
      aLvl: 0,
      bName: "추가 피해",
      bLvl: 0,
    };
    const t = { eff: 3, pts: 2, aLvl: 5, bLvl: 5 };
    arr.push({
      name: "meetsTarget ignores A/B when pos==상관 없음",
      ok: meetsTargetByMode("상관 없음", "ANY_ONE", s, t) === true,
    });
    arr.push({
      name: "meetsTarget requires both when BOTH",
      ok:
        meetsTargetByMode(
          "딜러",
          "BOTH",
          { ...s, aLvl: 5, bLvl: 4 },
          t
        ) === false,
    });
    arr.push({
      name: "meetsTarget allows either when ANY_ONE",
      ok:
        meetsTargetByMode(
          "딜러",
          "ANY_ONE",
          { ...s, aLvl: 5, bLvl: 0 },
          t
        ) === true,
    });

    // ✅ 중복 선택 방지 로직 테스트
    const dupDetected = hasDuplicateLabels([
      "의지력 효율 +1",
      "의지력 효율 +1",
      "포인트 +1",
      "가공 상태 유지",
    ]);
    arr.push({
      name: "duplicate labels are detected",
      ok: dupDetected === true,
    });

    return arr;
  }, [gemKey, pos]);

  // -------------------- 표시용 모드 텍스트 --------------------
  const calcMode = pos === "상관 없음" ? "IGNORE_AB" : abModePrimary;

  // -------------------- Render --------------------
  const tgtALabel = `${cur.aName} 레벨 ≥`;
  const tgtBLabel = `${cur.bName} 레벨 ≥`;

  const rateText =
    manual.costAddRate === 1
      ? "+100%"
      : manual.costAddRate === -1
      ? "-100%"
      : "0%";
  const hasDup = hasDuplicateLabels(manLabels);

  const showEffectsUI = pos !== "상관 없음";

  return (
    <div className="p-6 max-w-6xl mx-auto text-gray-900">
      <h1 className="text-2xl font-bold mb-2">
        LoA 젬 가공 도우미 · 시뮬레이션 기반 확률 계산기 (v2.9.2)
      </h1>
      <p className="text-sm text-gray-600 mb-6">
        딜러/서포터에서는 목표 충족 방식을 선택·저장하고, 결과는 선택 기준에
        맞춘 <b>단일 확률</b>만 표시됩니다.
        <br />
        “상관 없음” 모드에서는 A/B 효과명 및 레벨이 <b>성공 판정에서 완전히
        제외</b>되며, 시뮬레이션 동안의 모든 A/B 변동 케이스가 성공 확률
        계산에 <b>포함</b>됩니다.
      </p>

      {alert && (
        <div className="mb-4 p-3 rounded-xl bg-yellow-50 border border-yellow-200 text-sm text-yellow-900">
          {alert}
        </div>
      )}

      <Section title="1) 기본 설정">
        <Row>
          <Label>젬 타입</Label>
          <Select
            value={gemKey}
            set={(v) => setGemKey(v)}
            options={Object.keys(GEM_TYPES)}
          />
          <Label>추가 효과</Label>
          <Select
            value={pos}
            set={(v) => setPos(v)}
            options={["상관 없음", "딜러", "서포터"]}
          />
          <Label>등급</Label>
          <Select
            value={rarity}
            set={(v) => setRarity(v)}
            options={["고급", "희귀", "영웅"]}
          />
          <span className="text-sm text-gray-600">
            가공횟수 <b>{RARITY_ATTEMPTS[rarity]}</b> · 기본 리롤{" "}
            <b>{RARITY_BASE_REROLLS[rarity]}</b>
          </span>
        </Row>
      </Section>

      <Section title="2) 현재 옵션 설정 (읽기 전용으로 잠그면 안정적)">
        <Row>
          <Label>의지력 효율</Label>
          <NumInput
            value={cur.eff}
            set={(v) => setCur({ ...cur, eff: clamp(v, 0, MAX_STAT) })}
            min={0}
            max={MAX_STAT}
            disabled={curLocked}
          />
          <Label>포인트</Label>
          <NumInput
            value={cur.pts}
            set={(v) => setCur({ ...cur, pts: clamp(v, 0, MAX_STAT) })}
            min={0}
            max={MAX_STAT}
            disabled={curLocked}
          />
        </Row>
        {showEffectsUI && (
          <>
            <Row>
              <Label>효과 A</Label>
              <Select
                value={cur.aName}
                set={(v) => setCur({ ...cur, aName: v })}
                options={effectPoolByPos}
                disabled={curLocked}
              />
              <Label>A 레벨</Label>
              <NumInput
                value={cur.aLvl}
                set={(v) => setCur({ ...cur, aLvl: clamp(v, 0, MAX_STAT) })}
                min={0}
                max={MAX_STAT}
                disabled={curLocked}
              />
            </Row>
            <Row>
              <Label>효과 B</Label>
              <Select
                value={cur.bName}
                set={(v) => setCur({ ...cur, bName: v })}
                options={effectPoolByPos.filter((n) => n !== cur.aName)}
                disabled={curLocked}
              />
              <Label>B 레벨</Label>
              <NumInput
                value={cur.bLvl}
                set={(v) => setCur({ ...cur, bLvl: clamp(v, 0, MAX_STAT) })}
                min={0}
                max={MAX_STAT}
                disabled={curLocked}
              />
            </Row>
          </>
        )}
        <Row>
          <Toggle on={curLocked} set={(v) => setCurLocked(v)} />
          <span className="text-xs text-gray-500">
            시뮬레이션 초기화 시 현재 설정을 복사합니다.
          </span>
        </Row>
      </Section>

      <Section title="3) 목표 옵션 설정 (저장 후 계산 활성)">
        <Row>
          <Label>의지력 효율 ≥</Label>
          <NumInput
            value={tgt.eff}
            set={(v) => setTgt({ ...tgt, eff: clamp(v, 0, MAX_STAT) })}
            min={0}
            max={MAX_STAT}
            disabled={tgtLocked}
          />
          <Label>포인트 ≥</Label>
          <NumInput
            value={tgt.pts}
            set={(v) => setTgt({ ...tgt, pts: clamp(v, 0, MAX_STAT) })}
            min={0}
            max={MAX_STAT}
            disabled={tgtLocked}
          />
        </Row>
        {showEffectsUI && (
          <>
            <Row>
              <Label>{tgtALabel}</Label>
              <NumInput
                value={tgt.aLvl}
                set={(v) => setTgt({ ...tgt, aLvl: clamp(v, 0, MAX_STAT) })}
                min={0}
                max={MAX_STAT}
                disabled={tgtLocked}
              />
              <Label>{tgtBLabel}</Label>
              <NumInput
                value={tgt.bLvl}
                set={(v) => setTgt({ ...tgt, bLvl: clamp(v, 0, MAX_STAT) })}
                min={0}
                max={MAX_STAT}
                disabled={tgtLocked}
              />
            </Row>
            <Row>
              <Label>목표 충족 방식</Label>
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={abModePrimary === "ANY_ONE"}
                    onChange={() => setAbModePrimary("ANY_ONE")}
                    disabled={tgtLocked}
                  />
                  1개 이상 만족
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={abModePrimary === "BOTH"}
                    onChange={() => setAbModePrimary("BOTH")}
                    disabled={tgtLocked}
                  />
                  2개 모두 만족
                </label>
              </div>
            </Row>
          </>
        )}
        <Row>
          <Toggle on={tgtLocked} set={(v) => setTgtLocked(v)} />
        </Row>
      </Section>

      <Section title="4) 가공 시뮬레이션 (인게임 스타일)">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl border bg-white">
            <div className="font-semibold mb-2">현재 젬 상태</div>
            <ul className="text-sm leading-7">
              <li>
                의지력 효율: <b>{manual.state.eff}</b>
              </li>
              <li>
                질서·혼돈 포인트: <b>{manual.state.pts}</b>
              </li>
              {showEffectsUI && (
                <li>
                  <b>{manual.state.aName}</b> Lv.<b>{manual.state.aLvl}</b>
                </li>
              )}
              {showEffectsUI && (
                <li>
                  <b>{manual.state.bName}</b> Lv.<b>{manual.state.bLvl}</b>
                </li>
              )}
            </ul>
            <div className="mt-3 text-xs text-gray-600">
              시도 남은 횟수: <b>{manual.attemptsLeft}</b> · 리롤:{" "}
              <b>{manual.rerolls}</b> · 가공 비용 추가 비율: <b>{rateText}</b>{" "}
              · 누적 골드: <b>{fmtNum(manual.gold)}</b> G
            </div>
            {manual.attemptsLeft <= 0 && (
              <div className="mt-2 text-xs inline-block px-2 py-1 rounded bg-green-100 text-green-800 border border-green-200">
                가공이 완료되었습니다.
              </div>
            )}
          </div>

          <div className="p-4 rounded-xl border bg-white md:col-span-2">
            <div className="font-semibold mb-2">
              이번에 등장한 4개 항목 (전체 선택지 · SelectBox 4개)
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {manLabels.map((label, idx) => (
                <div key={idx} className="p-3 rounded-lg border">
                  <div className="text-sm mb-2">슬롯 {idx + 1}</div>
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
                      className="ml-auto px-3 py-1 text-sm rounded bg-blue-600 text-white"
                      onClick={() => applyManual(idx)}
                      disabled={hasDup}
                    >
                      선택
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {hasDup && (
              <div className="mt-3 p-2 text-xs rounded border border-red-200 bg-red-50 text-red-800">
                중복된 항목이 있습니다. 확인해주세요.
              </div>
            )}
            <div className="flex items-center gap-2 mt-3 justify-between">
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1 rounded bg-gray-100 border"
                  onClick={doReroll}
                >
                  다른 항목 보기 (리롤 -1)
                </button>
                <span
                  className={`text-xs px-2 py-1 rounded border ${
                    manual.unlocked && manual.rerolls > 0
                      ? rerollAdvice.shouldReroll
                        ? "bg-amber-50 border-amber-200 text-amber-800"
                        : "bg-green-50 border-green-200 text-green-800"
                      : "bg-gray-50 border-gray-200 text-gray-500"
                  }`}
                >
                  {manual.unlocked
                    ? manual.rerolls > 0
                      ? rerollAdvice.shouldReroll
                        ? "리롤 추천(룩어헤드)"
                        : "리롤 비추천(룩어헤드)"
                      : "리롤 없음"
                    : "첫 가공 이후부터 리롤 판단"}
                </span>
              </div>
              <button
                className="px-3 py-1 rounded bg-gray-100 border"
                onClick={manualReset}
              >
                시뮬레이션 초기화
              </button>
            </div>
            {manual.unlocked && manual.rerolls > 0 && (
              <div className="mt-2 text-xs text-gray-600">
                {rerollAdvice.reason}
              </div>
            )}
          </div>
        </div>
      </Section>

      <Section title="5) 결과 출력 (시뮬레이션 기준)">
        <div className="text-xs text-gray-600 mb-2">
          현재 확률 계산에 반영되는 1회차 선택지:{" "}
          {manLabels.map((l, i) => (
            <span key={i} className="mr-2">
              [{l}]
            </span>
          ))}{" "}
          {hasDup && (
            <span className="ml-2 text-red-600">(중복 감지됨)</span>
          )}
        </div>
        {isComputing && (
          <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 p-3 rounded-xl">
            계산 중입니다… (5,000회)
          </div>
        )}
        {!resultRun && !isComputing && (
          <div className="text-sm text-gray-500">
            목표 옵션을 저장하면 현재 시뮬레이션 상태 기준으로 계산합니다.
          </div>
        )}
        {resultRun && resultStop && !isComputing && (
          <div className="grid grid-cols-1 gap-4">
            <div className="p-4 rounded-xl border bg-white">
              <div className="font-semibold mb-1">
                {calcMode === "IGNORE_AB"
                  ? "목표 달성 확률 (상관 없음: A/B 완전 무시)"
                  : calcMode === "ANY_ONE"
                  ? "[A/B 1개 이상 만족] 목표 달성 확률"
                  : "[A/B 2개 모두 만족] 목표 달성 확률"}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-gray-500 mb-1">
                    STOP_ON_SUCCESS
                  </div>
                  <div className="text-xl font-bold">
                    {fmtProb(resultStop.successProb)}
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    기대 골드: <b>{fmtNum(Math.round(resultStop.expectedGold))}</b>{" "}
                    G
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1">
                    RUN_TO_END
                  </div>
                  <div className="text-xl font-bold">
                    {fmtProb(resultRun.successProb)}
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    기대 골드: <b>{fmtNum(Math.round(resultRun.expectedGold))}</b>{" "}
                    G
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl border bg-white">
              <div className="font-semibold mb-2">등급 확률</div>
              <div className="flex items-center gap-6 text-sm">
                <div>
                  전설(4~15): <b>{fmtProb(resultRun.legendProb)}</b>
                </div>
                <div>
                  유물(16~18): <b>{fmtProb(resultRun.relicProb)}</b>
                </div>
                <div>
                  고대(19+): <b>{fmtProb(resultRun.ancientProb)}</b>
                </div>
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section title="6) 셀프 테스트 (개발용)">
        <div className="text-xs grid gap-2">
          {tests.map((t, i) => (
            <div
              key={i}
              className={`p-2 rounded border ${
                t.ok
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              <b>{t.ok ? "PASS" : "FAIL"}</b> — {t.name}
              {t.info ? ` · ${t.info}` : ""}
            </div>
          ))}
        </div>
      </Section>

      <div className="text-xs text-gray-400 mt-8">
        © Gem Helper v2.9.2 – IGNORE_AB 표기, 선택 모드 단일 계산, 결정적
        Monte Carlo(5,000회), 표 규격 미등장, 비용 보정(다음 차수부터), 중복 금지,
        리롤 추천(1-스텝 룩어헤드·최종 성공확률 EV).
      </div>
    </div>
  );
}
