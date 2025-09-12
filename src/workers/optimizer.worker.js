// src/workers/optimizer.worker.js
/* eslint-env worker, es2020 */
import { enumerateCoreCombos, CORE_THRESHOLDS, sanitizeWeights } from "../lib/optimizerCore.js";

const thrMax = (ci) => (ci?.thr?.length ? Math.max(...ci.thr) : 0);
const minOf = (g) => Math.min(...CORE_THRESHOLDS[g]);
const now = () => (globalThis.performance?.now?.() ?? Date.now());

function clash(pick, usedSet) {
  for (const g of pick.list) if (usedSet.has(g.id)) return true;
  return false;
}

// emit을 너무 자주 보내지 않도록 간단 throttle
function makeThrottledEmit(emit, minMs = 8) {
  let last = 0;
  return (payload, force = false) => {
    const t = now();
    if (force || t - last >= minMs) {
      last = t;
      emit(payload);
    }
  };
}

function buildAllCandidates({ cores, pool, role, weights, perCoreLimit, emitOverall }) {
  const n = pool.length;
  const maxPick = Math.min(4, n);
  const nCk = (N, K) => {
    let c = 1; for (let i = 1; i <= K; i++) c = (c * (N - i + 1)) / i;
    return Math.floor(c);
  };
  const totalCombos = Array.from({ length: maxPick }, (_, i) => nCk(n, i + 1)).reduce((a, b) => a + b, 0);

  let doneCombos = 0;
  const candidatesPerCore = cores.map((core) => {
    const list = enumerateCoreCombos(
      pool, core.grade, role, weights, undefined, false,
      () => { doneCombos += 1; } // ✅ 내부 카운트만 누적
    )
      .filter((ci) => ci.list.length > 0 && ci.thr.length > 0)
      .sort((a, b) => {
        const ta = thrMax(a), tb = thrMax(b);
        if (ta !== tb) return tb - ta;
        if (a.totalPoint !== b.totalPoint) return b.totalPoint - a.totalPoint;
        if (a.roleSum !== b.roleSum) return b.roleSum - a.roleSum;
        return a.totalWill - b.totalWill;
      })
      .slice(0, Math.max(perCoreLimit, 10000));

    // ⚠️ 여기서는 emit 안 함(“후보 단계가 번쩍”하는 문제 방지)
    // doneCombos는 누적돼 있고, 전체 total을 알게 된 뒤 한꺼번에 반영한다.
    return list;
  });

  return { candidatesPerCore, totalCombos, doneCombos };
}

function countSearchNodes({ cores, order, enforcedSet, candidatesPerCore }) {
  let total = 0;
  const used = new Set();

  (function dfs(pos) {
    if (pos === order.length) return;
    const coreIdx = order[pos];
    const isEnf = enforcedSet.has(coreIdx);
    const effMin = isEnf ? (cores[coreIdx].minThreshold ?? minOf(cores[coreIdx].grade)) : -Infinity;
    const list = candidatesPerCore[coreIdx];

    for (const pick of list) {
      const t = thrMax(pick);
      if (isEnf && t < effMin) continue;
      if (clash(pick, used)) continue;
      total += 1; // 시도 노드
      pick.list.forEach((g) => used.add(g.id));
      dfs(pos + 1);
      pick.list.forEach((g) => used.delete(g.id));
    }
    if (!isEnf) { total += 1; dfs(pos + 1); } // 빈 선택 시도
  })(0);

  return total;
}

function solveWithUnifiedProgress({ cores, pool, role, weights, perCoreLimit, emit }) {
  const order = cores.map((_, i) => i);
  const enforcedSet = new Set(cores.map((c, i) => (c.enforceMin ? i : -1)).filter((i) => i !== -1));
  const throttled = makeThrottledEmit(emit, 8);

  // 1) 후보 생성 (내부 카운트만)
  const { candidatesPerCore, totalCombos, doneCombos } = buildAllCandidates({
    cores, pool, role, weights, perCoreLimit, emitOverall: throttled,
  });

  // 2) 전체 작업량 확정: combos + search
  const totalSearch = countSearchNodes({ cores, order, enforcedSet, candidatesPerCore });
  const totalAll = totalCombos + totalSearch;

  // 후보 단계까지의 누적을 **정확하게** 한 번 반영
  throttled({
    type: "progress",
    label: "후보 생성 정리 중…",
    done: doneCombos,
    total: totalAll,
  }, true);

  // 3) 실제 탐색 + 진행률 (정확)
  const emptyPick = { list: [], totalWill: 0, totalPoint: 0, thr: [], roleSum: 0, score: 0 };
  const betterThan = (A, B) => {
    if (!B) return true;
    if (A.sumThr !== B.sumThr) return A.sumThr > B.sumThr;
    for (let i = 0; i < A.thrVec.length; i++) if (A.thrVec[i] !== B.thrVec[i]) return A.thrVec[i] > B.thrVec[i];
    if (A.sumPoint !== B.sumPoint) return A.sumPoint > B.sumPoint;
    for (let i = 0; i < A.ptVec.length; i++) if (A.ptVec[i] !== B.ptVec[i]) return A.ptVec[i] > B.ptVec[i];
    if (A.roleSum !== B.roleSum) return A.roleSum > B.roleSum;
    if (A.sumWill !== B.sumWill) return A.sumWill < B.sumWill;
    return false;
  };

  let best = null;
  const used = new Set();
  let doneSearch = 0;

  (function dfs(pos, picksAcc, thrVec, ptVec) {
    if (pos === order.length) return;
    const coreIdx = order[pos];
    const isEnf = enforcedSet.has(coreIdx);
    const effMin = isEnf ? (cores[coreIdx].minThreshold ?? minOf(cores[coreIdx].grade)) : -Infinity;
    const list = candidatesPerCore[coreIdx];

    for (const pick of list) {
      const t = thrMax(pick);
      if (isEnf && t < effMin) continue;
      if (clash(pick, used)) continue;

      doneSearch += 1;
      throttled({ type: "progress", label: "최적 배치 탐색 중…", done: doneCombos + doneSearch, total: totalAll });

      pick.list.forEach((g) => used.add(g.id));
      const prev = picksAcc[coreIdx]; picksAcc[coreIdx] = pick;
      thrVec[pos] = t; ptVec[pos] = pick.totalPoint;

      if (pos + 1 === order.length) {
        let feasible = true;
        enforcedSet.forEach((idx) => {
          const m = thrMax(picksAcc[idx]);
          const minThr = cores[idx].minThreshold ?? minOf(cores[idx].grade);
          if (m < minThr) feasible = false;
        });
        if (feasible) {
          const cand = {
            picks: picksAcc.map((x) => x || emptyPick),
            sumThr: thrVec.reduce((a, b) => a + b, 0),
            sumPoint: ptVec.reduce((a, b) => a + b, 0),
            sumWill: picksAcc.reduce((s, p) => s + (p?.totalWill || 0), 0),
            roleSum: picksAcc.reduce((s, p) => s + (p?.roleSum || 0), 0),
            thrVec: thrVec.slice(),
            ptVec: ptVec.slice(),
          };
          if (betterThan(cand, best)) best = cand;
        }
      } else {
        dfs(pos + 1, picksAcc, thrVec, ptVec);
      }

      pick.list.forEach((g) => used.delete(g.id));
      picksAcc[coreIdx] = prev;
      thrVec[pos] = 0; ptVec[pos] = 0;
    }

    if (!isEnf) {
      doneSearch += 1;
      throttled({ type: "progress", label: "최적 배치 탐색 중…", done: doneCombos + doneSearch, total: totalAll });
      if (pos + 1 === order.length) {
        const cand = {
          picks: picksAcc.map((x) => x || emptyPick),
          sumThr: thrVec.reduce((a, b) => a + b, 0),
          sumPoint: ptVec.reduce((a, b) => a + b, 0),
          sumWill: picksAcc.reduce((s, p) => s + (p?.totalWill || 0), 0),
          roleSum: picksAcc.reduce((s, p) => s + (p?.roleSum || 0), 0),
          thrVec: thrVec.slice(),
          ptVec: ptVec.slice(),
        };
        if (betterThan(cand, best)) best = cand;
      } else {
        dfs(pos + 1, picksAcc, thrVec, ptVec);
      }
    }
  })(0, cores.map(() => emptyPick), Array(order.length).fill(0), Array(order.length).fill(0));

  return { picks: best ? best.picks : cores.map(() => emptyPick) };
}

globalThis.onmessage = (e) => {
  const { cores, gems, role, weights, perCoreLimit } = e.data;
  const emit = (msg) => globalThis.postMessage(msg);

  try {
    // 준비 알림(선택)
    emit({ type: "progress", label: "준비 중…", done: 0, total: 1 });

    const result = solveWithUnifiedProgress({
      cores,
      pool: gems,
      role,
      weights: sanitizeWeights(weights),
      perCoreLimit,
      emit,
    });

    emit({ type: "result", ...result });
  } catch (err) {
    emit({ type: "error", error: String(err?.message || err) });
  }
};
