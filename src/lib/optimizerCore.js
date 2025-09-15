// src/lib/optimizerCore.js
/* =============================== 타입(주석용 정의) =============================== */
/** @typedef {"dealer"|"support"} Role */
/** @typedef {"atk"|"add"|"boss"|"brand"|"allyDmg"|"allyAtk"} OptionKey */
/** @typedef {"HERO"|"LEGEND"|"RELIC"|"ANCIENT"} CoreGrade */
/** @typedef {{id:string, will:number|null, point:number|null, o1k:OptionKey, o1v:number|null, o2k:OptionKey, o2v:number|null}} Gem */
/** @typedef {{[k in OptionKey]: number}} Weights */
/** @typedef {{ id:string, name:string, grade:CoreGrade, minThreshold?:number, enforceMin:boolean }} CoreDef */
/** @typedef {{ list: Gem[], totalWill:number, totalPoint:number, thr:number[], roleSum:number, score:number }} ComboInfo */

/* =============================== 상수 정의 =============================== */
export const CORE_SUPPLY = { HERO: 7, LEGEND: 11, RELIC: 15, ANCIENT: 17 };
export const CORE_THRESHOLDS = {
  HERO: [10],
  LEGEND: [10, 14],
  RELIC: [10, 14, 17, 18, 19, 20],
  ANCIENT: [10, 14, 17, 18, 19, 20],
};
export const CORE_LABEL = { HERO: "영웅", LEGEND: "전설", RELIC: "유물", ANCIENT: "고대" };
export const GRADES = ["HERO", "LEGEND", "RELIC", "ANCIENT"];
export const OPTION_LABELS = {
  atk: "공격력",
  add: "추가 피해",
  boss: "보스 피해",
  brand: "낙인력",
  allyDmg: "아군 피해 강화",
  allyAtk: "아군 공격 강화",
};
export const OPTIONS = ["atk", "add", "boss", "brand", "allyDmg", "allyAtk"];
export const ROLE_KEYS = {
  dealer: new Set(["atk", "add", "boss"]),
  support: new Set(["brand", "allyDmg", "allyAtk"]),
};
export const DEFAULT_WEIGHTS = { atk: 1, add: 1, boss: 1, brand: 1, allyDmg: 1, allyAtk: 1 };
// 딜러 가중치: y ≈ slope * level (원점 통과 회귀 추정)
export const DEALER_WEIGHTS = {
  boss: 0.07870909,
  add: 0.06018182,
  atk: 0.03407273,
  brand: 0,
  allyDmg: 0,
  allyAtk: 0,
};

/* =============================== 유틸/헬퍼 =============================== */
export function sanitizeWeights(w) {
  const base = { ...DEFAULT_WEIGHTS };
  if (!w) return base;
  Object.keys(base).forEach((k) => {
    const raw = w[k];
    const num = typeof raw === 'number' ? raw : Number(raw);
    base[k] = Number.isFinite(num) && num >= 0 ? num : DEFAULT_WEIGHTS[k];
  });
  return /** @type {Weights} */(base);
}
export function scoreGemForRole(g, role, w) {
  if (role == null) return 0; // 역할 미선택이면 유효옵션 점수 0
  const keys = role === "dealer" ? ROLE_KEYS.dealer : ROLE_KEYS.support;
  const s1 = keys.has(g.o1k) ? (g.o1v ?? 0) * (w[g.o1k] ?? 1) : 0;
  const s2 = keys.has(g.o2k) ? (g.o2v ?? 0) * (w[g.o2k] ?? 1) : 0;
  return s1 + s2;
}
export function* combinations(arr, k) {
  const n = arr.length; if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map(i => arr[i]);
    let p = k - 1;
    while (p >= 0 && idx[p] === n - k + p) p--;
    if (p < 0) break;
    idx[p]++;
    for (let j = p + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}
export function thresholdsHit(grade, totalPoint) {
  const th = CORE_THRESHOLDS[grade];
  return th.filter(t => totalPoint >= t);
}
export function scoreCombo(combo, grade, role, weights) {
  const totalWill = combo.reduce((s, g) => s + ((g.will ?? 0)), 0);
  const totalPoint = combo.reduce((s, g) => s + ((g.point ?? 0)), 0);
  const thr = thresholdsHit(grade, totalPoint);
  const roleSum = combo.reduce((s, g) => s + scoreGemForRole(g, role, weights), 0);
  const score = (thr.length * 10_000_000)
    + (totalPoint * 10_000)
    + ((5_000 - totalWill) * 10)
    + roleSum
    - combo.length;
  return { totalWill, totalPoint, thr, roleSum, score };
}
/* 단일 코어 후보 산출 (통일 정책: 달성 구간이 없으면 결과 없음) */
export function enumerateCoreCombos(pool, grade, role, weights, minThreshold, enforceMin, onStep) {
  const supply = CORE_SUPPLY[grade];
  const W = sanitizeWeights(weights);

  /** @type {ComboInfo[]} */
  const all = [];
  const maxPick = Math.min(4, pool.length);

  for (let k = 0; k <= maxPick; k++) {
    if (k === 0) {
      all.push({ list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 });
      continue;
    }
    for (const combo of combinations(pool, k)) {
      onStep && onStep(1);
      const totalWill = combo.reduce((s, g) => s + (g.will || 0), 0);
      if (totalWill > supply) continue;
      const { totalPoint, thr, roleSum, score } = scoreCombo(combo, grade, role, W);
      all.push({ list: combo, totalWill, totalPoint, thr, roleSum, score });
    }
  }

  all.sort((a, b) => b.score - a.score);

  // [수정] UI 변경에 맞춰 필터링 로직 전체를 새로운 로직으로 변경합니다.
  let filtered;

  // '이상 탐색' 모드 (체크박스 ON)
  if (enforceMin) {
    const minOfGrade = Math.min(...CORE_THRESHOLDS[grade]);
    const effMin = minThreshold ?? minOfGrade; // 목표 설정 없으면 등급 최소치 적용
    filtered = all.filter(ci =>
      ci.totalPoint >= effMin && ci.thr.length > 0 && ci.list.length > 0
    );
  }
  // '정확히 일치' 모드 (체크박스 OFF, 기본값)
  else {
    // 목표 포인트가 명확히 설정된 경우
    if (minThreshold != null) {
      filtered = all.filter(ci =>
        ci.totalPoint === minThreshold && ci.list.length > 0
      );
    }
    // 목표 포인트 설정이 없는 경우 (가장 점수 높은 순으로)
    else {
      filtered = all.filter(ci => ci.thr.length > 0 && ci.list.length > 0);
    }
  }

  if (filtered.length === 0) {
    return [{ list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 }];
  }
  
  return filtered;
}