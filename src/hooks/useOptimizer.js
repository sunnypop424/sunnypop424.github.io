// src/hooks/useOptimizer.js
import { useState, useRef, useEffect, useCallback } from 'react';
import { flushSync } from 'react-dom';

export function useOptimizer(cores, gems, role, weights) {
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

  // ✅ 새로 추가: 마지막으로 "계산하기"를 눌렀을 때의 입력값 스냅샷
  const paramsRef = useRef({ cores, gems, role, weights });

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

  // ✅ 변경점: 의존성 배열을 calcVersion 하나만 사용
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
          coreCount: paramsRef.current.cores?.length || null, // ← 스냅샷 사용
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
              setProgress((p) => ({ 
                ...p, pct: 0, indeterminate: true, phase,
                coreIndex: coreIndex ?? p.coreIndex,
                coreCount: coreCount ?? p.coreCount,
                coreDone: coreDone ?? p.coreDone,
                coreTotal: coreTotal ?? p.coreTotal,
                rate: rate ?? p.rate,
                elapsedMs: elapsedMs ?? p.elapsedMs,
                etaMs: etaMs ?? p.etaMs,
                pulse: pulse ?? (p.pulse ?? 0)
              }));
            } else {
              const pct = Math.max(0, Math.min(100, Math.floor((done / Math.max(1, total)) * 100)));
              setProgress((p) => ({ 
                ...p, pct, indeterminate: false, phase,
                coreIndex: coreIndex ?? p.coreIndex,
                coreCount: coreCount ?? p.coreCount,
                coreDone: coreDone ?? p.coreDone,
                coreTotal: coreTotal ?? p.coreTotal,
                rate: rate ?? p.rate,
                elapsedMs: elapsedMs ?? p.elapsedMs,
                etaMs: etaMs ?? p.etaMs,
                pulse: undefined
              }));
            }
            return;
          }
          if (msg.type === "result") {
            const { picks } = msg;
            setPriorityPicks(picks || []);
            setComputing(false);
            setProgress((p) => ({ ...p, pct: 100, label: "완료", indeterminate: false, pulse: undefined }));
            worker.removeEventListener('message', onMessage);
            return;
          }
        };

        worker.addEventListener('message', onMessage);

        // ✅ 스냅샷을 꺼내서 사용
        const { cores: c, gems: g, role: r, weights: w } = paramsRef.current;
        const perCoreLimit = g.length > 60 ? 400 : g.length > 45 ? 600 : g.length > 30 ? 800 : 1000;

        worker.postMessage({ type: "run", cores: c, gems: g, role: r, weights: w, perCoreLimit });
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setComputing(false);
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calcVersion]); // ← 오직 버튼 클릭으로 증가한 calcVersion에만 반응

  // ✅ 변경점: 계산 버튼을 눌렀을 때 현재 입력값을 스냅샷으로 저장한 뒤 calcVersion 증가
  const calculate = useCallback(() => {
    paramsRef.current = { cores, gems, role, weights }; // 최신값 스냅샷
    setCalcVersion(v => v + 1);
    setHasCalculated(true);
  }, [cores, gems, role, weights]);

  return {
    isComputing: computing,
    progress,
    results: priorityPicks,
    calculate, // ← 이 함수가 “계산하기” 버튼 onClick에 연결되면 됩니다.
    hasCalculated,
  };
}
