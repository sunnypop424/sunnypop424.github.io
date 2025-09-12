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
  const minOfGrade = Math.min(...CORE_THRESHOLDS[grade]);
  const effMin = minThreshold ?? minOfGrade;
  const effEnforce = enforceMin || minThreshold == null;
  /** @type {ComboInfo[]} */
  const all = [];
  const maxPick = Math.min(4, pool.length);
  for (let k = 0; k <= maxPick; k++) {
    if (k === 0) { all.push({ list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 }); continue; }
    for (const combo of combinations(pool, k)) {
      onStep && onStep(1); // 콤보 하나 평가 시작(진행률 카운트)
      const totalWill = combo.reduce((s, g) => s + (g.will || 0), 0);
      if (totalWill > supply) continue;
      const { totalPoint, thr, roleSum, score } = scoreCombo(combo, grade, role, W);
      all.push({ list: combo, totalWill, totalPoint, thr, roleSum, score });
    }
  }
  all.sort((a, b) => b.score - a.score);
  let filtered;
  if (effEnforce) {
    filtered = all.filter(ci => {
      const maxThr = Math.max(0, ...ci.thr);
      return ci.list.length > 0 && maxThr >= (effMin ?? 0);
    });
  } else {
    filtered = all.filter(ci => ci.list.length > 0 && ci.thr.length > 0);
  }
  if (filtered.length === 0) {
    return [{ list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 }];
  }
  return filtered;
}
/* ===== 전역 최적 배치: thr 합 최대(1순위) + 강제는 하한(≥min) + 우선순위 사전식 ===== */
export function optimizeRoundRobinTargets(cores, pool, role, weights, perCoreLimit = 300) {
  const W = sanitizeWeights(weights);
  const thresholdsOf = (grade) => CORE_THRESHOLDS[grade];
  const minOf = (grade) => Math.min(...thresholdsOf(grade));
  const thrMax = (ci) => (ci?.thr?.length ? Math.max(...ci.thr) : 0);

  const emptyPick = { list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 };

  // 표시 우선순위(위→아래)
  const order = cores.map((_, i) => i);
  const enforcedIdx = cores.map((c, i) => (c.enforceMin ? i : -1)).filter(i => i !== -1);

  const candidatesFor = (core, gemPool) => {
    const arr = enumerateCoreCombos(gemPool, core.grade, role, W, undefined, false)
      .filter(ci => ci.list.length > 0 && ci.thr.length > 0);
    arr.sort((a, b) => {
      const ta = thrMax(a), tb = thrMax(b);
      if (ta !== tb) return tb - ta;
      if (a.totalPoint !== b.totalPoint) return b.totalPoint - a.totalPoint;
      if (a.roleSum !== b.roleSum) return b.roleSum - a.roleSum; // 유효합 우선
      return a.totalWill - b.totalWill;
    });
    return arr.slice(0, Math.max(perCoreLimit, 10000));
  };

  const allCandidates = order.map(i => candidatesFor(cores[i], pool));

  function betterThan(A, B) {
    if (!B) return true;
    if (A.sumThr !== B.sumThr) return A.sumThr > B.sumThr;
    for (let i = 0; i < A.thrVec.length; i++) {
      if (A.thrVec[i] !== B.thrVec[i]) return A.thrVec[i] > B.thrVec[i];
    }
    if (A.sumPoint !== B.sumPoint) return A.sumPoint > B.sumPoint;
    for (let i = 0; i < A.ptVec.length; i++) {
      if (A.ptVec[i] !== B.ptVec[i]) return A.ptVec[i] > B.ptVec[i];
    }
    if (A.roleSum !== B.roleSum) return A.roleSum > B.roleSum; // 유효합 더 큰 쪽
    if (A.sumWill !== B.sumWill) return A.sumWill < B.sumWill; // 의지력 적을수록 우위
    return false;
  }

  // ---- 공통 백트래킹: 주어진 enforceSet에 대해 최적해 탐색 ----
  function trySolve(enforceSet, blockedSet = new Set()) {
    let best = null;
    const used = new Set();

    function backtrack(pos, picksAcc, sumThrAcc, sumPointAcc, sumWillAcc, roleSumAcc, thrVec, ptVec) {
      if (pos === order.length) {
        // 강제 코어 하한 검사
        for (const idx of enforceSet) {
          const effMin = (cores[idx].minThreshold ?? minOf(cores[idx].grade));
          const t = thrMax(picksAcc[idx]);
          if (t < effMin) return;
        }
        const cand = {
          picks: picksAcc.map(x => x),
          sumThr: sumThrAcc,
          sumPoint: sumPointAcc,
          sumWill: sumWillAcc,
          roleSum: roleSumAcc,
          thrVec: thrVec.slice(),
          ptVec: ptVec.slice(),
        };
        if (betterThan(cand, best)) best = cand;
        return;
      }

      const coreIdx = order[pos];
      const isEnf = enforceSet.has(coreIdx);
      const effMin = isEnf ? (cores[coreIdx].minThreshold ?? minOf(cores[coreIdx].grade)) : -Infinity;

      // 차단 코어는 empty만 허용
      if (blockedSet.has(coreIdx)) {
        backtrack(pos + 1, picksAcc, sumThrAcc, sumPointAcc, sumWillAcc, roleSumAcc, thrVec, ptVec);
        return;
      }

      const candList = allCandidates[pos];

      // 후보 시도
      for (const pick of candList) {
        const t = thrMax(pick);
        if (isEnf && t < effMin) continue;

        // 젬 충돌
        let clash = false;
        for (const g of pick.list) { if (used.has(g.id)) { clash = true; break; } }
        if (clash) continue;

        pick.list.forEach(g => used.add(g.id));
        const prev = picksAcc[coreIdx];
        picksAcc[coreIdx] = pick;

        thrVec[pos] = t;
        ptVec[pos] = pick.totalPoint;

        backtrack(
          pos + 1,
          picksAcc,
          sumThrAcc + t,
          sumPointAcc + pick.totalPoint,
          sumWillAcc + pick.totalWill,
          roleSumAcc + pick.roleSum,
          thrVec,
          ptVec
        );

        // 롤백
        pick.list.forEach(g => used.delete(g.id));
        picksAcc[coreIdx] = prev;
        thrVec[pos] = 0;
        ptVec[pos] = 0;
      }

      // 비강제는 빈 선택 허용
      if (!isEnf) {
        backtrack(pos + 1, picksAcc, sumThrAcc, sumPointAcc, sumWillAcc, roleSumAcc, thrVec, ptVec);
      }
    }

    backtrack(
      0,
      cores.map(() => emptyPick),
      0, 0, 0, 0,
      Array(order.length).fill(0),
      Array(order.length).fill(0)
    );

    return best; // null(실패) 또는 최적해
  }

  // 1) 원래 로직(강제 전부 지킴) 우선 시도
  const enforcedSetFull = new Set(enforcedIdx);
  const bestFull = trySolve(enforcedSetFull);
  if (bestFull) {
    return { picks: bestFull.picks };
  }

  // 1.5) 전역해가 없으면: 최하 코어를 차단하고 재시도
  if (order.length > 0) {
    const lowestIdx = order[order.length - 1];
    const enforcedMinusLowest = new Set([...enforcedSetFull].filter(i => i !== lowestIdx));
    const bestDropLowest = trySolve(enforcedMinusLowest, new Set([lowestIdx]));
    if (bestDropLowest) {
      const finalPicks = bestDropLowest.picks.map((p, i) => (i === lowestIdx ? emptyPick : (p || emptyPick)));
      return { picks: finalPicks };
    }
  }

  // 2) 강제 불가능 판별
  const infeasibleEnforced = new Set();
  for (const idx of enforcedIdx) {
    const effMin = (cores[idx].minThreshold ?? minOf(cores[idx].grade));
    const pos = order.indexOf(idx);
    const hasFeasible = (allCandidates[pos] || []).some(ci => thrMax(ci) >= effMin);
    if (!hasFeasible) infeasibleEnforced.add(idx);
  }

  // 3) 가능한 강제만 유지하고 다시 최적화
  const enforcedSetReduced = new Set(enforcedIdx.filter(i => !infeasibleEnforced.has(i)));
  const bestReduced = trySolve(enforcedSetReduced);

  if (bestReduced) {
    // 4) 최종 출력에서 "실제로 불가능했던 강제 코어"만 결과없음 처리
    const finalPicks = bestReduced.picks.map((p, i) => (infeasibleEnforced.has(i) ? emptyPick : (p || emptyPick)));
    return { picks: finalPicks };
  }

  // 5) 그래도 실패 시 안전망
  return { picks: cores.map(() => emptyPick) };
}
