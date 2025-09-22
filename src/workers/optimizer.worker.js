// src/workers/optimizer.worker.js
/* eslint-env worker, es2020 */
import { enumerateCoreCombos, CORE_THRESHOLDS, sanitizeWeights } from "../lib/optimizerCore.js";

const thrMax = (ci) => (ci?.thr?.length ? Math.max(...ci.thr) : 0);
const minOf = (g) => Math.min(...CORE_THRESHOLDS[g]);
const now = () => (globalThis.performance?.now?.() ?? Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clash(pick, usedSet) {
  for (const g of pick.list) if (usedSet.has(g.id)) return true;
  return false;
}

// emit을 너무 자주 보내지 않도록 간단 throttle
function makeThrottledEmit(emit, minMs = 16) {
  let last = 0;
  return (payload, force = false) => {
    const t = now();
    if (force || t - last >= minMs) {
      last = t;
      emit(payload);
    }
  };
}

// 정렬 comparator를 루프 밖으로 (ESLint 안정성/성능)
const comboCmp = (a, b) => {
  const ta = thrMax(a), tb = thrMax(b);
  if (ta !== tb) return tb - ta;
  if (a.totalPoint !== b.totalPoint) return b.totalPoint - a.totalPoint;
  if (a.roleSum !== b.roleSum) return b.roleSum - a.roleSum;
  return a.totalWill - b.totalWill;
};

/**
* 후보 생성: 코어별로 프레임 양보하면서 진행 브로드캐스트
* - gen 단계는 전체 후보 조합 수를 알 수 있으니 **결정형 퍼센트(done/total)** 제공
* - 동시에 코어별 상세(코어 n/m, x/y, 속도/ETA)도 함께 전송
*/
async function buildAllCandidates({ cores, pool, role, weights, perCoreLimit, emitOverall }) {
  const n = pool.length;
  const maxPick = Math.min(4, n);

  const nCk = (N, K) => {
    let c = 1;
    for (let i = 1; i <= K; i++) c = (c * (N - i + 1)) / i;
    return Math.floor(c);
  };

  // 한 코어당 이론상 생성할 조합 개수(1~4개 선택 합)
  const totalCombosPerCore = Array.from({ length: maxPick }, (_, i) => nCk(n, i + 1))
    .reduce((a, b) => a + b, 0);

  // 전체(gen) 퍼센트용 총량
  const totalGenAll = totalCombosPerCore * cores.length;

  let doneCombos = 0;
  const candidatesPerCore = [];

  const state = {
    coreIndex: 0,
    coreCount: cores.length,
    coreDone: 0,
    coreTotal: 0,
    t0: 0,
  };

  // 루프 밖 단일 onTick (ESLint no-loop-func 대응)
  const onTick = () => {
    // 전역(doneCombos) & 코어별 진행 증가
    doneCombos += 1;
    state.coreDone += 1;

    const elapsedMs = now() - state.t0;
    const showSpeed = elapsedMs >= 250 && state.coreDone >= Math.min(1000, state.coreTotal * 0.05);
    const rate = showSpeed ? (state.coreDone / (elapsedMs / 1000)) : null;
    const etaMs = showSpeed && rate ? Math.max(0, (state.coreTotal - state.coreDone) / rate) * 1000 : null;

    emitOverall?.({
      type: "progress",
      phase: "gen",
      label: `후보 생성 중… (${cores[state.coreIndex - 1]?.name || `코어 ${state.coreIndex}`})`,
      indeterminate: false,        // ✅ 결정형
      done: doneCombos,          // ✅ 전체(gen) 진행수
      total: totalGenAll,         // ✅ 전체(gen) 총량
      coreIndex: state.coreIndex,
      coreCount: state.coreCount,
      coreDone: state.coreDone,
      coreTotal: state.coreTotal,
      rate, elapsedMs, etaMs
    });
  };

  // 코어별로 순차 생성 + 프레임 양보
  for (let idx = 0; idx < cores.length; idx++) {
    const core = cores[idx];

    state.coreIndex = idx + 1;
    state.coreDone = 0;
    state.coreTotal = totalCombosPerCore; // 동일 풀 기준 이론 총량
    state.t0 = now();

    // 시작 알림 (렌더 기회) — 결정형 퍼센트 0%에서 시작
    emitOverall?.({
      type: "progress",
      phase: "gen",
      label: `후보 생성 중… (${core.name || `코어 ${state.coreIndex}`})`,
      indeterminate: false,
      done: doneCombos,
      total: totalGenAll,
      coreIndex: state.coreIndex,
      coreCount: state.coreCount,
      coreDone: state.coreDone,
      coreTotal: state.coreTotal
    }, true);
    await sleep(0);

    const list = enumerateCoreCombos(
       pool, core.grade, role, weights, core.minThreshold, core.enforceMin, onTick, core.supply
    )
      .filter((ci) => ci.list.length > 0 && ci.thr.length > 0)
      .sort(comboCmp)
      .slice(0, perCoreLimit);

    candidatesPerCore[idx] = list;

    // 코어 종료 스냅샷(강제 1회) + 프레임 양보
    emitOverall?.({
      type: "progress",
      phase: "gen",
      label: `후보 생성 중… (${core.name || `코어 ${state.coreIndex}`})`,
      indeterminate: false,
      done: doneCombos,
      total: totalGenAll,
      coreIndex: state.coreIndex,
      coreCount: state.coreCount,
      coreDone: state.coreTotal,
      coreTotal: state.coreTotal
    }, true);
    await sleep(0);
  }

  return { candidatesPerCore, totalGenAll, doneCombos };
}

/**
* 최적 배치 탐색 (개선된 Fallback 로직 적용)
* - 비결정형으로 진행하되, 매 브로드캐스트마다 **pulse(카운터)** 를 증가시켜 탐색량을 시각화
*/
async function solveWithAdvancedFallback({ cores, pool, role, weights, perCoreLimit, emit }) {
  const order = cores.map((_, i) => i);
  const throttled = makeThrottledEmit(emit, 24);

  // 1) 후보 생성
  const { candidatesPerCore } = await buildAllCandidates({
    cores, pool, role, weights, perCoreLimit, emitOverall: throttled,
  });
  const allCandidates = candidatesPerCore;

  // 2) 탐색 준비
  let pulse = 0;
  const emitSearchProgress = (force = false) => {
    pulse++;
    throttled({
      type: "progress",
      phase: "search",
      label: "최적 배치 탐색 중…",
      indeterminate: true,
      pulse
    }, force);
  };
  emitSearchProgress(true); // 탐색 시작 알림 (pulse 1)

  // 3) 탐색 로직 (백트래킹)
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

  // 백트래킹 솔버
  function trySolve(enforceSet, blockedSet = new Set()) {
    let best = null;
    const used = new Set();

    function backtrack(pos, picksAcc, sumThrAcc, sumPointAcc, sumWillAcc, roleSumAcc, thrVec, ptVec) {
      emitSearchProgress();

      if (pos === order.length) {
        for (const idx of enforceSet) {
          const effMin = (cores[idx].minThreshold ?? minOf(cores[idx].grade));
          const t = thrMax(picksAcc[idx]);
          if (t < effMin) return;
        }
        const cand = {
          picks: picksAcc.map(x => x),
          sumThr: sumThrAcc, sumPoint: sumPointAcc, sumWill: sumWillAcc, roleSum: roleSumAcc,
          thrVec: thrVec.slice(), ptVec: ptVec.slice(),
        };
        if (betterThan(cand, best)) best = cand;
        return;
      }

      const coreIdx = order[pos];
      const isEnf = enforceSet.has(coreIdx);
      const effMin = isEnf ? (cores[coreIdx].minThreshold ?? minOf(cores[coreIdx].grade)) : -Infinity;

      if (blockedSet.has(coreIdx)) {
        backtrack(pos + 1, picksAcc, sumThrAcc, sumPointAcc, sumWillAcc, roleSumAcc, thrVec, ptVec);
        return;
      }

      const candList = allCandidates[pos] || [];
      for (const pick of candList) {
        const t = thrMax(pick);
        if (isEnf && t < effMin) continue;
        if (clash(pick, used)) continue;

        pick.list.forEach(g => used.add(g.id));
        const prev = picksAcc[coreIdx];
        picksAcc[coreIdx] = pick;
        thrVec[pos] = t;
        ptVec[pos] = pick.totalPoint;

        backtrack(pos + 1, picksAcc, sumThrAcc + t, sumPointAcc + pick.totalPoint, sumWillAcc + pick.totalWill, roleSumAcc + pick.roleSum, thrVec, ptVec);

        pick.list.forEach(g => used.delete(g.id));
        picksAcc[coreIdx] = prev;
        thrVec[pos] = 0;
        ptVec[pos] = 0;
      }

      if (!isEnf) {
        backtrack(pos + 1, picksAcc, sumThrAcc, sumPointAcc, sumWillAcc, roleSumAcc, thrVec, ptVec);
      }
    }

    backtrack(0, cores.map(() => emptyPick), 0, 0, 0, 0, Array(order.length).fill(0), Array(order.length).fill(0));
    return best;
  }

  // --- 메인 해결 로직 (Fallback 적용) ---
  const enforcedIdx = cores.map((c, i) => (c.enforceMin ? i : -1)).filter(i => i !== -1);

  // 1) 전체 강제조건을 만족하는 해 시도
  const enforcedSetFull = new Set(enforcedIdx);
  const bestFull = trySolve(enforcedSetFull);
  if (bestFull) {
    return { picks: bestFull.picks };
  }

  // 2) 1번 실패 시, 최하위 우선순위 코어를 포기하고 재시도
  if (order.length > 0) {
    const lowestIdx = order[order.length - 1];
    // 최하위 코어가 강제 대상이었을 때만 의미가 있음
    if (enforcedSetFull.has(lowestIdx)) {
      const enforcedMinusLowest = new Set([...enforcedSetFull].filter(i => i !== lowestIdx));
      const bestDropLowest = trySolve(enforcedMinusLowest, new Set([lowestIdx]));
      if (bestDropLowest) {
        const finalPicks = bestDropLowest.picks.map((p, i) => (i === lowestIdx ? emptyPick : (p || emptyPick)));
        return { picks: finalPicks };
      }
    }
  }

  // 3) 그래도 실패 시: 애초에 달성 불가능한 강제 조건이 있는지 판별
  const infeasibleEnforced = new Set();
  for (const idx of enforcedIdx) {
    const effMin = (cores[idx].minThreshold ?? minOf(cores[idx].grade));
    const pos = order.indexOf(idx);
    const hasFeasibleCandidate = (allCandidates[pos] || []).some(ci => thrMax(ci) >= effMin);
    if (!hasFeasibleCandidate) {
      infeasibleEnforced.add(idx);
    }
  }

  // 4) 달성 가능한 강제 조건만 걸고 재시도
  const enforcedSetReduced = new Set(enforcedIdx.filter(i => !infeasibleEnforced.has(i)));
  const bestReduced = trySolve(enforcedSetReduced);

  if (bestReduced) {
    // 불가능했던 코어는 결과 없음 처리
    const finalPicks = bestReduced.picks.map((p, i) => (infeasibleEnforced.has(i) ? emptyPick : (p || emptyPick)));
    return { picks: finalPicks };
  }

  // 5) 최종 안전망
  return { picks: cores.map(() => emptyPick) };
}


globalThis.onmessage = async (e) => {
  const { type = "run", cores, gems, role, weights, perCoreLimit } = e.data;
  const emit = (msg) => globalThis.postMessage(msg);

  try {
    if (type === "kickoff") {
      // 워밍업만 수행하고 UI 갱신은 하지 않음
      return;
    }

    const result = await solveWithAdvancedFallback({
      cores,
      pool: gems,
      role,
      weights: sanitizeWeights(weights),
      perCoreLimit,
      emit,
    });

    emit({ type: "result", ...result });
  } catch (err) {
    console.error("Worker error:", err);
    emit({ type: "error", error: String(err?.message || err) });
  }
};