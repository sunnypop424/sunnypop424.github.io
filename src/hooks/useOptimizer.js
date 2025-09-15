// src/hooks/useOptimizer.js
import { useState, useRef, useEffect, useCallback } from 'react'; // ✅ useCallback 추가
import { flushSync } from 'react-dom';

// 훅의 입력 파라미터는 계산에 필요한 데이터들입니다.
export function useOptimizer(cores, gems, role, weights) {
  // 1. 계산과 관련된 모든 상태(state)와 참조(ref)를 이 훅 안으로 가져옵니다.
  const [calcVersion, setCalcVersion] = useState(0);
  const [hasCalculated, setHasCalculated] = useState(false); 
  const [computing, setComputing] = useState(false);
  const [progress, setProgress] = useState({
    pct: 0,
    label: "준비 중…",
    indeterminate: true,
    phase: undefined,
    coreIndex: null,
    coreCount: null,
    coreDone: null,
    coreTotal: null,
    rate: null,
    elapsedMs: null,
    etaMs: null,
    pulse: 0,
  });
  const [priorityPicks, setPriorityPicks] = useState([]);
  const workerRef = useRef(null);

  // 2. Web Worker를 초기화하고 해제하는 로직도 훅 안으로 가져옵니다.
  useEffect(() => {
    workerRef.current = new Worker(new URL('../workers/optimizer.worker.js', import.meta.url), { type: 'module' });
    try {
      workerRef.current?.postMessage({ type: "kickoff" });
    } catch { }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // 3. 가장 핵심적인 계산 로직 useEffect를 통째로 가져옵니다.
  useEffect(() => {
    if (calcVersion === 0) return;
    let cancelled = false;

    setTimeout(() => {
      if (cancelled) return;
      flushSync(() => {
        setComputing(true);
        setProgress({
          pct: 0,
          label: "최적의 젬 조합을 찾고 있습니다…",
          indeterminate: false,
          phase: 'gen',
          coreIndex: null,
          coreCount: cores.length || null,
          coreDone: null,
          coreTotal: null,
          rate: null,
          elapsedMs: null,
          etaMs: null,
          pulse: 0,
        });
      });
    }, 0);

    (async () => {
      try {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const worker = workerRef.current;
        if (!worker) throw new Error("Worker not initialized");

        const onMessage = (e) => {
          if (cancelled) return;
          const msg = e.data || {};
          if (msg?.type === "error" || msg?.error) {
            console.error(e.data?.error || msg?.error);
            setComputing(false);
            setProgress((p) => ({ ...p, pct: 0, label: "에러", indeterminate: true }));
            worker.removeEventListener('message', onMessage);
            return;
          }
          if (msg.type === "progress") {
            const { done, total, indeterminate = false, phase, coreIndex, coreCount, coreDone, coreTotal, rate, elapsedMs, etaMs, pulse } = msg;
            if (indeterminate || !total || total <= 0 || done == null) {
              setProgress((p) => ({ ...p, pct: 0, indeterminate: true, phase, coreIndex: coreIndex ?? p.coreIndex, coreCount: coreCount ?? p.coreCount, coreDone: coreDone ?? p.coreDone, coreTotal: coreTotal ?? p.coreTotal, rate: rate ?? p.rate, elapsedMs: elapsedMs ?? p.elapsedMs, etaMs: etaMs ?? p.etaMs, pulse: pulse ?? (p.pulse ?? 0) }));
            } else {
              const pct = Math.max(0, Math.min(100, Math.floor((done / Math.max(1, total)) * 100)));
              setProgress((p) => ({ ...p, pct, indeterminate: false, phase, coreIndex: coreIndex ?? p.coreIndex, coreCount: coreCount ?? p.coreCount, coreDone: coreDone ?? p.coreDone, coreTotal: coreTotal ?? p.coreTotal, rate: rate ?? p.rate, elapsedMs: elapsedMs ?? p.elapsedMs, etaMs: etaMs ?? p.etaMs, pulse: undefined }));
            }
            return;
          }
          if (msg.type === "result") {
            const { picks } = msg;
            setPriorityPicks(picks || []);
            // setStale(false); // setStale은 이제 이 훅의 책임이 아님
            setComputing(false);
            setProgress((p) => ({ ...p, pct: 100, label: "완료", indeterminate: false, pulse: undefined }));
            worker.removeEventListener('message', onMessage);
            return;
          }
        };

        worker.addEventListener('message', onMessage);

        const perCoreLimit = gems.length > 60 ? 800 : gems.length > 45 ? 1200 : gems.length > 30 ? 1600 : 2000;
        worker.postMessage({ type: "run", cores, gems, role, weights, perCoreLimit });
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setComputing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // useEffect의 의존성 배열에 훅의 입력 파라미터를 추가해줍니다.
  }, [calcVersion, cores, gems, role, weights]);

  // 4. 컴포넌트에서 계산을 시작할 수 있는 트리거 함수를 만듭니다.
  const calculate = useCallback(() => {
    // 계산이 필요할 때마다 내부의 calcVersion을 올려서 useEffect를 재실행시킵니다.
    setCalcVersion(v => v + 1);
    setHasCalculated(true);
  }, []);

  // 5. 훅을 사용하는 컴포넌트에게 필요한 상태와 함수를 반환합니다.
  return {
    isComputing: computing,
    progress,
    results: priorityPicks,
    calculate, // 계산 시작 함수
    hasCalculated,
  };
}