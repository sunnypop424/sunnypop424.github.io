// src/lib/optimizerCore.js
/* =============================== 타입(주석용 정의) =============================== */
/** @typedef {"dealer"|"support"} Role */
/** @typedef {"atk"|"add"|"boss"|"brand"|"allyDmg"|"allyAtk"} OptionKey */
/** @typedef {"HERO"|"LEGEND"|"RELIC"|"ANCIENT"} CoreGrade */
/** @typedef {{id:string, will:number|null, point:number|null, o1k:OptionKey, o1v:number|null, o2k:OptionKey, o2v:number|null}} Gem */
/** @typedef {{[k in OptionKey]: number}} Weights */
/** @typedef {{ id:string, name:string, grade:CoreGrade, minThreshold?:number, enforceMin:boolean, supply?: number }} CoreDef */
/** @typedef {{ list: Gem[], totalWill:number, totalPoint:number, thr:number[], roleSum:number, score:number }} ComboInfo */

/* =============================== 상수 정의 =============================== */
// 기본값(미선택 시 사용)
export const CORE_SUPPLY = { HERO: 7, LEGEND: 11, RELIC: 15, ANCIENT: 17 };
// 등급별 “선택 가능한 공급 의지력” 목록
export const CORE_SUPPLY_OPTIONS = {
  HERO: [7, 9],
  LEGEND: [11, 12],
  RELIC: [15],
  ANCIENT: [17],
};
export const CORE_POINT_CAP = { HERO: 13, LEGEND: 16, RELIC: 20, ANCIENT: 20 };
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

/** 딜러 프리셋(가중치; 배율) */
export const DEALER_WEIGHTS = {
  boss: 1,
  add: 1,
  atk: 1,
  brand: 0,
  allyDmg: 0,
  allyAtk: 0,
};
/** 기본 가중치는 = 딜러 프리셋 */
export const DEFAULT_WEIGHTS = { ...DEALER_WEIGHTS };

/** 딜러: 옵션 레벨 → 퍼센트 커브 */
export const DEALER_LEVEL_CURVES = {
  // key 는 OPTIONS 의 실제 키와 일치해야 합니다.
  boss: [0, 0.078, 0.156, 0.244, 0.313, 0.391], // 보스 피해
  add:  [0, 0.060, 0.119, 0.187, 0.239, 0.299], // 추가 피해
  atk:  [0, 0.029, 0.067, 0.105, 0.134, 0.172], // 공격력
};

/** 서포터: 옵션 레벨 → 유효율(커브) */
export const SUPPORT_LEVEL_CURVES = {
  // 낙인력
  brand:   [0, 0.167, 0.334, 0.501, 0.668, 0.835],
  // 아군 공격 강화
  allyAtk: [0, 0.130, 0.260, 0.390, 0.520, 0.650],
  // 아군 피해 강화
  allyDmg: [0, 0.052, 0.104, 0.156, 0.208, 0.260],
};

/* =============================== 유틸/헬퍼 =============================== */
export function roleAllowsKey(role, key) {
  const allow = ROLE_KEYS?.[role];
  if (!allow) return true;                               // 미정의면 모두 허용
  if (Array.isArray(allow)) return allow.includes(key);  // 배열
  if (allow && typeof allow.has === 'function') return allow.has(key); // Set
  if (allow && typeof allow === 'object') return !!allow[key]; // { atk:true } 객체
  return true;
}

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

export function levelValueByRole(role, key, lvl) {
  const L = Math.max(0, Math.min(5, Number(lvl) || 0));

  // 딜러: 사전 정의된 퍼센트 커브
  if (role === 'dealer' && DEALER_LEVEL_CURVES[key]) {
    return DEALER_LEVEL_CURVES[key][L] || 0;
  }

  // 서포터: 사전 정의된 유효율 커브
  if (role === 'support' && SUPPORT_LEVEL_CURVES[key]) {
    return SUPPORT_LEVEL_CURVES[key][L] || 0;
  }

  // 그 외: 선형(레벨 숫자 그대로)
  return L;
}

export function scoreGemForRole(gem, role, weights) {
  const w = sanitizeWeights(weights || {});
  let sum = 0;

  const add = (key, lvl) => {
    if (!key || !lvl) return;
    if (role && !roleAllowsKey(role, key)) return;

    const basePct = levelValueByRole(role, key, lvl); // 레벨→퍼센트(커브/선형)
    const scale   = w[key] ?? 0;                      // 가중치(배율)
    sum += basePct * scale;
  };

  add(gem.o1k, gem.o1v);
  add(gem.o2k, gem.o2v);

  // 퍼센트 값으로 반환 (상위 UI에서 toFixed(4) + '%' 처리)
  return sum;
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

// --- helpers for fallback by TOTAL POINT ---
const thrMaxOf = (ci) => (ci?.thr?.length ? Math.max(...ci.thr) : -Infinity);

/**
 * 선택한 포인트 p(예: 14)로 정확히 맞는 조합이 없으면
 * 총 포인트를 p+1, p+2 … 식으로 올려가며 첫 매칭 세트를 반환.
 * (임계치 드롭다운은 건드리지 않음)
 */
function pickByPointExactThenUp(all, grade, startPoint) {
  const maxP = CORE_POINT_CAP?.[grade] ?? startPoint;
  for (let p = startPoint; p <= maxP; p += 1) {
    const hits = all.filter(ci =>
      ci?.list?.length > 0 &&
      Number.isFinite(ci?.totalPoint) &&
      ci.totalPoint === p
    );
    if (hits.length) return hits;
  }
  return [];
}


/* 단일 코어 후보 산출 (통일 정책: 달성 구간이 없으면 결과 없음) */
export function enumerateCoreCombos(
  pool, grade, role, weights, minThreshold, enforceMin, onStep, supplyOverride
) {
  const supply = (supplyOverride ?? CORE_SUPPLY[grade]);
  const pointCap = (CORE_POINT_CAP?.[grade] ?? Infinity);
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
      // ✅ 등급별 최대 포인트 초과 조합은 제외 (예: 전설은 14P 초과 금지)
      if (totalPoint > pointCap) continue;
      all.push({ list: combo, totalWill, totalPoint, thr, roleSum, score });
    }
  }

  all.sort((a, b) => b.score - a.score);

  // UI 정책에 맞춘 필터링
  let filtered;
  if (enforceMin) {
    // 강제(ON): '선택 임계치 이상(≥)'인 조합 허용
    const need = Number.isFinite(minThreshold) ? minThreshold : -Infinity;
    filtered = all.filter(ci =>
      ci.list?.length > 0 &&
      ci.thr?.length > 0 &&
      thrMaxOf(ci) >= need
    );
  } else {
    // 정확 매칭 모드(OFF):
    //    1) minThreshold 있으면: '총 포인트 == 선택값' 우선 → 없으면 총 포인트를 +1씩 올리며 탐색
    //    2) minThreshold 없으면: 임계치(=효과) 한 개라도 달성한 조합만
    if (Number.isFinite(minThreshold)) {
      const hits = pickByPointExactThenUp(all, grade, minThreshold);
      filtered = hits.length ? hits : [];
    } else {
      filtered = all.filter(ci => ci.list?.length > 0 && ci.thr?.length > 0);
    }
  }

  if (filtered.length === 0) {
    return [{ list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 }];
  }

  return filtered;
}
