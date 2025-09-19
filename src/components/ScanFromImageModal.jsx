// src/components/ScanFromImageModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ScanLine, Eraser, BoxSelect, Trash2, MinusCircle, ImageUp } from "lucide-react";
// parseFromRaw는 당김 현상을 유발하므로 사용하지 않음
// import parseFromRaw from "../lib/ocrRescueFromRaw";

/* -----------------------------------------------------------
 *  내부 옵션 키 매핑 (한글 라벨 → 내부키)
 * ----------------------------------------------------------- */
const LABEL2KEY = {
  "공격력": "atk",
  "추가 피해": "add",
  "보스 피해": "boss",
  "낙인력": "brand",
  "아군 피해 강화": "allyDmg",
  "아군 공격 강화": "allyAtk",
};

/* -----------------------------------------------------------
 *  왼쪽/오른쪽을 "당기지 않는" 락스텝 파서
 *  - left[i]와 right[i]를 같은 인덱스로만 묶음
 *  - 왼쪽 숫자(Will)가 오인식이면 그대로 NaN이 되도록 두고,
 *    pair 단계에서 그 젬(2줄)을 스킵
 * ----------------------------------------------------------- */
function parseNoShift(rawLeft = "", rawRight = "") {
  const norm = (s) =>
    String(s ?? "")
      .replace(/\r/g, "")
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);

  // 왼쪽(숫자열) 라인들
  const L = norm(rawLeft);

  // 오른쪽(라벨+레벨) 라인들
  const R = norm(rawRight);

  // 허용 라벨 키워드(우선순위 순)
  const LABELS = [
    "아군 공격 강화",
    "아군 피해 강화",
    "보스 피해",
    "추가 피해",
    "공격력",
    "낙인력",
  ];

  const clean = (t) =>
    String(t ?? "")
      // 한글/영문/숫자/공백/점만 남기고 나머지는 공백
      .replace(/[^\u3131-\uD79D0-9A-Za-z.\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // ✅ 라벨 줄에서 "가장 마지막에 나오는 숫자"를 레벨로 사용
  function parseRight(text) {
    const raw = text ?? "";
    const t = clean(raw);

    let labelKey = null;
    for (const lab of LABELS) {
      if (t.includes(lab)) {
        labelKey = lab;
        break;
      }
    }

    let level = NaN;
    const nums = t.match(/\d+/g); // 모든 숫자 찾기
    if (nums && nums.length) {
      level = parseInt(nums[nums.length - 1], 10); // 마지막 숫자
    }
    return { labelKey, level, rawRight: raw };
  }

  const rows = [];
  const N = Math.max(L.length, R.length);
  for (let i = 0; i < N; i++) {
    const leftStr = L[i] ?? ""; // 없으면 빈 문자열(→ NaN)
    const rightStr = R[i] ?? "";

    const right = parseRight(rightStr);
    rows.push({
      will: leftStr, // 숫자 변환은 나중에
      labelKey: right.labelKey,
      level: right.level,
      rawLeft: leftStr,
      rawRight: right.rawRight,
    });
  }

  return rows;
}

/** 2줄(홀수/짝수)을 1개 젬으로 묶되, 오인식 시 해당 젬은 스킵
 *  - opt1/opt2.label은 내부키로 변환
 *  - 레벨은 1~5로 클램프
 */
function pairParsedToGems(list = []) {
  const gems = [];
  const skipped = []; // 제외된 젬의 1-based 인덱스

  const toNum = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const s = String(v ?? "")
      .trim()
      // 흔한 OCR 혼동 문자 보정
      .replace(/[|Il]/g, "1")
      .replace(/[Oo]/g, "0")
      .replace(/[sS]/g, "5")
      .replace(/[bB]/g, "6");
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : NaN;
  };

  const toKey = (lab) => (lab ? LABEL2KEY[lab] ?? null : null);
  const clampLv = (lv) => {
    const n = Number(lv);
    return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : null;
  };

  for (let i = 0, gemIdx = 1; i < list.length; i += 2, gemIdx++) {
    const a = list[i];       // 홀수번째(0-based): will + 옵션1
    const b = list[i + 1];   // 짝수번째: will = point, 옵션2
    if (!a || !b) break;

    const will = toNum(a.will);
    const point = toNum(b.will);

    // 숫자 인식 실패 → 이 젬은 제외(땡기지 않음)
    if (!Number.isFinite(will) || !Number.isFinite(point)) {
      skipped.push(gemIdx);
      continue;
    }

    const o1k = toKey(a.labelKey);
    const o2k = toKey(b.labelKey);

    gems.push({
      will,
      point,
      opt1: { label: o1k, level: clampLv(a.level), raw: a.rawRight },
      opt2: { label: o2k, level: clampLv(b.level), raw: b.rawRight },
      _raw: {
        leftA: a.rawLeft,
        rightA: a.rawRight,
        leftB: b.rawLeft,
        rightB: b.rawRight,
      },
    });
  }

  return { gems, skipped };
}

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
  const [drag, setDrag] = useState(null); // {mode:'include'|'exclude', x0,y0,x1,y1}
  const [mode, setMode] = useState("include");

  const wrapRef = useRef(null);
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

        // joined(디버그)
        console.groupCollapsed("%c[Gem OCR] ROI words (joined)", "color:#8b5cf6");
        console.log(payload?.joinedWords || "(empty)");
        console.groupEnd();

        // raw left/right
        console.groupCollapsed("%c[Gem OCR] Raw (left / right)", "color:#0ea5e9");
        console.log("rawLeft:\n" + (payload?.rawLeft || "(empty)"));
        console.log("rawRight:\n" + (payload?.rawRight || "(empty)"));
        console.groupEnd();

        // 당김 없는 파싱 → 고정 인덱스 매칭
        const parsed = parseNoShift(payload?.rawLeft || "", payload?.rawRight || "");
        console.groupCollapsed(`%c[Gem OCR] Parsed(no-shift) rows ${parsed.length}`, "color:#10b981");
        parsed.forEach((p, i) => {
          console.log(
            `#${i + 1}`,
            `will='${p.will}'`,
            `label=${p.labelKey ?? "(?)"}`,
            `Lv.${Number.isFinite(p.level) ? p.level : "?"}`
          );
        });
        console.groupEnd();

        const { gems, skipped } = pairParsedToGems(parsed);

        console.groupCollapsed(`%c[Gem OCR] Gems (paired, after-skip) ${gems.length}`, "color:#22c55e");
        gems.forEach((g, i) => {
          console.log(
            `Gem #${i + 1}`,
            `will=${g.will}`,
            `point=${g.point}`,
            `opt1=${g.opt1.label}(Lv.${g.opt1.level})`,
            `opt2=${g.opt2.label}(Lv.${g.opt2.level})`
          );
        });
        console.groupEnd();

        if ((skipped || []).length) {
          console.warn("[Gem OCR] 오인식으로 제외된 젬:", skipped.join(", "));
        }

        onScanned?.({ ...payload, parsed, gems, skippedGems: skipped });
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
    if (!file) {
      setImgURL(null);
      return;
    }
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

  const convertExcludesToNatural = (arr) => (arr || []).map(rectRelToNatural).filter(Boolean);

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
    if (!file) {
      alert("먼저 스크린샷을 선택해 주세요.");
      return;
    }
    if (!rectRel) {
      alert("이미지 위에서 드래그로 포함 영역을 지정해 주세요.");
      return;
    }
    const rect = rectRelToNatural(rectRel);
    if (!rect) {
      alert("좌표 변환에 실패했습니다.");
      return;
    }

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
            lang: "kor+eng", // 필요시 "kor"로 변경
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
      {/* 모달 컨테이너 */}
      <div className="w-auto rounded-2xl bg-white border shadow-lg overflow-hidden flex flex-col max-h-[98vh] min-w-[720px]">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b flex-none">
          <div className="font-semibold">이미지에서 젬 목록 스캔 (수동 ROI + 제외영역)</div>
          <button
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100"
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* 바디 래퍼 */}
        <div className="flex flex-col min-h-0">
          {/* 툴바(고정) */}
          <div className="px-4 py-3 border-b flex-none">
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
                  className={`h-10 px-3 rounded-xl border inline-flex items-center gap-2 ${
                    mode === "include" ? "bg-indigo-50 border-indigo-300" : "bg-white"
                  }`}
                  title="젬 리스트 영역 지정"
                >
                  <BoxSelect size={16} />
                  <span>젬 리스트 영역</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("exclude")}
                  disabled={busy}
                  className={`h-10 px-3 rounded-xl border inline-flex items-center gap-2 ${
                    mode === "exclude" ? "bg-rose-50 border-rose-300" : "bg-white"
                  }`}
                  title="제외 영역 지정"
                >
                  <Eraser size={16} />
                  <span>제외 영역</span>
                </button>
              </div>

              <div className="ml-auto flex items-center gap-2">
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
          </div>

          {/* 내용 스크롤 영역 */}
          <div className="p-4 space-y-3 overflow-auto flex-1">
            {imgURL ? (
              <div className="relative border overflow-hidden bg-gray-50">
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
                          onClick={(e) => {
                            e.stopPropagation();
                            removeExclude(r.id);
                          }}
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

                  {/* 진행중 오버레이 */}
                  {busy && (
                    <div className="absolute inset-0 z-10 bg-black/30 backdrop-blur-[1px] flex items-center justify-center">
                      <div className="w-[320px] rounded-xl bg-white/95 border shadow p-3">
                        <div className="text-xs font-medium text-gray-800 mb-1">
                          {progress.label || "스캔중…"}
                        </div>
                        <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden relative">
                          {progress.indeterminate ? (
                            <div className="absolute inset-0">
                              <div className="h-full w-1/3 animate-[marquee_1.1s_linear_infinite] bg-[#a399f2] rounded-full" />
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
              <div className="text-sm text-center">
                <div className="mb-4">
                  <p>
                    <span className="text-rose-600">1920×1080 이상의 해상도</span>
                    로 스크린샷을 촬영하는 것을 권장합니다.
                  </p>
                  <p className="mt-1 text-xs">
                    ※ 예시 이미지는 편의를 위해 <strong>아크그리드 창만 크롭</strong>했지만, 실제 작업에서는{" "}
                    <strong>전체 화면 스크린샷</strong>을 사용해도 무방합니다.
                  </p>
                  <p className="mt-1 text-xs">
                    ※ 작업 시에는 아래 <strong>예시 이미지</strong>를 참고하여{" "}
                    <strong>동일한 방식으로 가이드를 그려주세요.</strong>
                  </p>
                </div>

                <figure>
                  <img
                    src="https://i.ibb.co/Qjk1QkCF/example.jpg"
                    alt="예시: 젬 리스트 영역만 드래그 지정하고, 의지력·포인트 아이콘은 제외한 스크린샷 가이드"
                  />
                  <figcaption>
                    <ol className="mt-4 text-xs">
                      <li>
                        스크린샷을 드래그해 <strong>젬 리스트 영역</strong>만 지정하세요. (
                        <strong>젬 아이콘 제외</strong>, <strong>의지력·포인트 숫자 시작 지점</strong>부터)
                      </li>
                      <li>
                        <strong>제외 영역</strong>으로 <strong>의지력·포인트 아이콘</strong>을 빼주세요.
                      </li>
                    </ol>
                  </figcaption>
                </figure>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
