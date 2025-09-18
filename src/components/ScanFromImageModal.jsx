// src/components/ScanFromImageModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ScanLine, Eraser, BoxSelect, Trash2, MinusCircle, ImageUp } from "lucide-react";
import parseFromRaw from "../lib/ocrRescueFromRaw";

/** 2줄(홀수/짝수)을 1개 젬으로 묶기 */
function pairParsedToGems(list = []) {
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i];       // 홀수번째(0-based): will + 옵션1
    const b = list[i + 1];   // 짝수번째: will = point, 옵션2
    if (!a || !b) break;
    out.push({
      will: a.will,
      point: b.will,
      opt1: { label: a.labelKey, level: a.level, raw: a.rawRight },
      opt2: { label: b.labelKey, level: b.level, raw: b.rawRight },
      _raw: {
        leftA: a.rawLeft, rightA: a.rawRight,
        leftB: b.rawLeft, rightB: b.rawRight,
      },
    });
  }
  return out;
}

/**
 * 이미지 업로드 + 수동 ROI & 제외 영역 지정 모달 (컨테이너 상대좌표 버전)
 * - 포함 ROI 1개, 제외영역 여러 개
 * - 오버레이는 모두 이미지 컨테이너 내부 absolute 좌표로 렌더 (스크롤/리사이즈 안정)
 * - 워커는 rawLeft/rawRight를 반환, parseFromRaw → parsed → pairParsedToGems → gems
 */
export default function ScanFromImageModal({ open, onClose, onScanned }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ label: "", pct: 0, indeterminate: true });

  const [file, setFile] = useState(null);
  const [imgURL, setImgURL] = useState(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });

  // 포함 ROI (wrapRef 상대좌표)
  const [rectRel, setRectRel] = useState(null); // {x,y,w,h}
  // 제외 영역들 (wrapRef 상대좌표)
  const [excludesRel, setExcludesRel] = useState([]); // [{id,x,y,w,h}]
  // 제외 영역 드래그 임시 박스
  const [tempExcludeRel, setTempExcludeRel] = useState(null);

  // 드래그 상태
  const [drag, setDrag] = useState(null); // {mode:'include'|'exclude', x0,y0,x1,y1} (wrap 기준)
  const [mode, setMode] = useState("include");

  const wrapRef = useRef(null); // 이미지 컨테이너 (좌표 기준점)
  const imgRef = useRef(null);
  const inputRef = useRef(null);

  // 워커
  const worker = useMemo(() => {
    try {
      return new Worker(new URL("../workers/gemScanner.worker.js", import.meta.url), { type: "module" });
    } catch {
      return new Worker(new URL("../workers/gemScanner.worker.js", import.meta.url));
    }
  }, []);

  // 워커 메시지
  useEffect(() => {
    if (!worker) return;
    const onMessage = (ev) => {
      const { type, payload } = ev.data || {};
      if (type === "progress") {
        setProgress(payload);
      } else if (type === "done") {
        setBusy(false);
        setProgress({ label: "", pct: 0, indeterminate: true });

        // 1) joined (디버그)
        console.groupCollapsed("%c[Gem OCR] ROI words (joined)", "color:#8b5cf6");
        console.log(payload?.joinedWords || "(empty)");
        console.groupEnd();

        // 2) raw left/right
        console.groupCollapsed("%c[Gem OCR] Raw (left / right)", "color:#0ea5e9");
        console.log("rawLeft:\n" + (payload?.rawLeft || "(empty)"));
        console.log("rawRight:\n" + (payload?.rawRight || "(empty)"));
        console.groupEnd();

        // 3) 파싱 → 페어링
        const parsed = parseFromRaw(payload?.rawLeft || "", payload?.rawRight || "");
        console.groupCollapsed(`%c[Gem OCR] Parsed (N + Label + Lv) ${parsed.length}`, "color:#10b981");
        parsed.forEach((p, i) => {
          console.log(
            `#${i + 1}`,
            `will=${p.will}`,
            `label=${p.labelKey}`,
            `Lv.${p.level}`,
            { rawLeft: p.rawLeft, rawRight: p.rawRight }
          );
        });
        console.groupEnd();

        const gems = pairParsedToGems(parsed);
        console.groupCollapsed(`%c[Gem OCR] Gems (paired) ${gems.length}`, "color:#22c55e");
        gems.forEach((g, i) => {
          console.log(
            `Gem #${i + 1}`,
            `will=${g.will}`,
            `point=${g.point}`,
            `opt1=${g.opt1.label}(Lv.${g.opt1.level})`,
            `opt2=${g.opt2.label}(Lv.${g.opt2.level})`,
            g._raw
          );
        });
        console.groupEnd();

        onScanned?.({ ...payload, parsed, gems });
      } else if (type === "error") {
        setBusy(false);
        setProgress({ label: "", pct: 0, indeterminate: true });
        console.error("[gem-scanner:error]", payload?.message ?? payload, payload);
        alert("이미지 스캔 중 오류가 발생했어요. 콘솔을 확인해 주세요.");
      }
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, [worker, onScanned]);

  // 파일 선택 시 미리보기 URL
  useEffect(() => {
    if (!file) { setImgURL(null); return; }
    const url = URL.createObjectURL(file);
    setImgURL(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // 이미지 로드 → 원본 크기 보관 & 기존 선택 초기화
  const onImgLoad = (e) => {
    const img = e.currentTarget;
    setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
    resetSelections();
  };

  const pickFile = () => inputRef.current?.click();

  // 전체 선택 초기화
  const resetSelections = () => {
    setRectRel(null);
    setExcludesRel([]);
    setTempExcludeRel(null);
    setDrag(null);
  };

  // 래퍼 기준 좌표 가져오기
  const getRelPoint = (e) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return {
      x: Math.max(0, Math.min(x, r.width)),
      y: Math.max(0, Math.min(y, r.height)),
    };
  };

  // 래퍼 상대 → 원본 해상도 사각형
  const rectRelToNatural = (rel) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height || !imgNatural.w || !imgNatural.h) return null;
    const sx = imgNatural.w / r.width;
    const sy = imgNatural.h / r.height;
    return {
      x: Math.max(0, Math.round(rel.x * sx)),
      y: Math.max(0, Math.round(rel.y * sy)),
      w: Math.max(1, Math.round(rel.w * sx)),
      h: Math.max(1, Math.round(rel.h * sy)),
    };
  };

  const convertExcludesToNatural = (arr) =>
    (arr || []).map(rectRelToNatural).filter(Boolean);

  // 모드 전환 시 임시 박스 정리
  useEffect(() => {
    setTempExcludeRel(null);
  }, [mode]);

  // 드래그 시작/이동/끝 (wrap 기준)
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    if (!wrapRef.current) return;
    const p = getRelPoint(e);
    const start = { mode, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    setDrag(start);
    if (mode === "include") {
      setRectRel(null);
    } else {
      setTempExcludeRel(null);
    }
  };

  const onMouseMove = (e) => {
    if (!drag) return;
    const p = getRelPoint(e);
    const cur = { ...drag, x1: p.x, y1: p.y };
    setDrag(cur);
    const x = Math.min(cur.x0, cur.x1);
    const y = Math.min(cur.y0, cur.y1);
    const w = Math.abs(cur.x1 - cur.x0);
    const h = Math.abs(cur.y1 - cur.y0);
    if (drag.mode === "include") {
      setRectRel({ x, y, w, h });
    } else {
      setTempExcludeRel(w > 0 && h > 0 ? { x, y, w, h } : null);
    }
  };

  const onMouseUp = () => {
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);

    if (drag.mode === "exclude") {
      if (w > 2 && h > 2) {
        setExcludesRel((prev) => [...prev, { id: Math.random().toString(36).slice(2), x, y, w, h }]);
      }
      setTempExcludeRel(null);
    }
    setDrag(null);
  };

  const removeExclude = (id) => setExcludesRel((prev) => prev.filter((r) => r.id !== id));

  // OCR 실행
  const runManual = () => {
    if (!file) { alert("먼저 스크린샷을 선택해 주세요."); return; }
    if (!rectRel) { alert("이미지 위에서 드래그로 포함 영역을 지정해 주세요."); return; }
    const rect = rectRelToNatural(rectRel);
    if (!rect) { alert("좌표 변환에 실패했습니다."); return; }

    const excludes = convertExcludesToNatural(excludesRel);

    setBusy(true);
    setProgress({ label: "스캔중...", pct: 0, indeterminate: true });

    file.arrayBuffer().then((buf) => {
      worker.postMessage(
        {
          type: "scan",
          payload: {
            buf,
            mime: file.type || "image/png",
            lang: "kor+eng", // 필요시 "kor"로 변경 가능
            rect,
            excludes,
          },
        },
        [buf]
      );
    });
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[99999] bg-black/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="w-auto min-w-6xl rounded-2xl bg-white border shadow-lg overflow-hidden">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-semibold">이미지에서 젬 목록 스캔 (수동 ROI + 제외영역)</div>
          <button
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100"
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* 바디 */}
        <div className="p-4 space-y-3">
          {/* 상단 컨트롤 */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2"
              onClick={pickFile}
              disabled={busy}
            >
              <ImageUp size={18} />
              <span>{file ? "다른 이미지 선택" : "스크린샷 선택"}</span>
            </button>

            <div className="flex items-center gap-2 ml-2">
              <span className="text-xs text-gray-600">드래그 모드</span>
              <button
                type="button"
                onClick={() => setMode("include")}
                disabled={busy}
                className={`h-10 px-3 rounded-xl border inline-flex items-center gap-2 ${mode === "include" ? "bg-indigo-50 border-indigo-300" : "bg-white"}`}
                title="젬 리스트 영역 지정"
              >
                <BoxSelect size={16} />
                <span>젬 리스트 영역</span>
              </button>
              <button
                type="button"
                onClick={() => setMode("exclude")}
                disabled={busy}
                className={`h-10 px-3 rounded-xl border inline-flex items-center gap-2 ${mode === "exclude" ? "bg-rose-50 border-rose-300" : "bg-white"}`}
                title="제외 영역 지정"
              >
                <Eraser size={16} />
                <span>제외 영역</span>
              </button>
            </div>


            <div className="ml-auto flex items-center gap-2">
              {/* 선택영역 초기화 */}
              <button
                type="button"
                onClick={resetSelections}
                disabled={busy || (!rectRel && excludesRel.length === 0)}
                className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2"
                title="포함/제외 영역 모두 초기화"
              >
                <Trash2 size={16} />
                <span>선택 영역 초기화</span>
              </button>
              <button
                className="h-10 px-3 rounded-xl border bg-white hover:bg-white/90 inline-flex items-center gap-2"
                onClick={runManual}
                disabled={!file || !rectRel || busy}
                title="선택 영역 스캔"
              >
                <ScanLine size={18} />
                <span>선택 영역 스캔</span>
              </button>
            </div>
          </div>

          {/* 파일 input */}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />

          {/* 미리보기 + 오버레이 */}
          {imgURL ? (
            <div className="relative border overflow-hidden max-h-[80vh] bg-gray-50">
              <div
                ref={wrapRef}
                className="relative inline-block"
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onDragStart={(e) => e.preventDefault()}
                style={{ cursor: "crosshair" }}
              >
                <img
                  ref={imgRef}
                  src={imgURL}
                  alt="preview"
                  className="block max-h-[80vh] w-auto select-none"
                  onLoad={onImgLoad}
                  draggable={false}
                />

                {/* 포함 ROI 표시 */}
                {rectRel && (
                  <div
                    style={{
                      position: "absolute",
                      left: rectRel.x,
                      top: rectRel.y,
                      width: rectRel.w,
                      height: rectRel.h,
                      border: "1px solid #6366f1",
                      background: "rgba(99,102,241,0.18)",
                      pointerEvents: "none",
                      zIndex: 5,
                    }}
                  />
                )}

                {/* 제외 영역들 */}
                {excludesRel.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      position: "absolute",
                      left: r.x,
                      top: r.y,
                      width: r.w,
                      height: r.h,
                      border: "1px dashed #ef4444",
                      background: "rgba(239,68,68,0.18)",
                      pointerEvents: "none",
                      zIndex: 6,
                    }}
                  >
                    <div style={{ position: "absolute", right: -12, top: -12, pointerEvents: "auto" }}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeExclude(r.id); }}
                        className="h-6 w-6 rounded-full bg-white border shadow flex items-center justify-center"
                        title="이 제외영역 삭제"
                      >
                        <MinusCircle size={16} className="text-rose-600" />
                      </button>
                    </div>
                  </div>
                ))}

                {/* 제외 영역 드래그 임시 미리보기 */}
                {tempExcludeRel && (
                  <div
                    style={{
                      position: "absolute",
                      left: tempExcludeRel.x,
                      top: tempExcludeRel.y,
                      width: tempExcludeRel.w,
                      height: tempExcludeRel.h,
                      border: "1px dashed rgba(239,68,68,0.8)",
                      background: "rgba(239,68,68,0.12)",
                      pointerEvents: "none",
                      zIndex: 6,
                    }}
                  />
                )}

                {/* 진행중 오버레이 (absolute) */}
                {busy && (
                  <div className="absolute inset-0 z-10 bg-black/30 backdrop-blur-[1px] flex items-center justify-center">
                    <div className="w-[320px] rounded-xl bg-white/95 border shadow p-3">
                      <div className="text-xs font-medium text-gray-800 mb-1">
                        {progress.label || "스캔중 중…"}
                      </div>
                      <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden relative">
                        {progress.indeterminate ? (
                          <div className="absolute inset-0">
                            <div className="h-full w-1/3 bg-[#a399f2] animate-[marquee_1.1s_linear_infinite] rounded-full" />
                          </div>
                        ) : (
                          <div
                            className="h-full bg-[#a399f2] transition-[width] duration-150"
                            style={{ width: `${progress.pct ?? 0}%` }}
                          />
                        )}
                      </div>
                      <style>{`@keyframes marquee { 0%{transform:translateX(-100%)} 100%{transform:translateX(300%)} }`}</style>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="border rounded-xl p-4 text-sm text-gray-600 bg-gray-50 text-center">
              스크린샷을 선택한 뒤, 이미지에서 드래그로 <b>젬 리스트 영역</b>을 지정하세요.<br />
              (젬 아이콘은 제외하고, <b>의지력·포인트 숫자가 시작되는 지점부터</b> 넉넉히 잡아주세요.)<br />
              그다음 <b>제외 영역</b>을 선택해 <b>의지력·포인트 아이콘</b> 부분을 빼주세요.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
