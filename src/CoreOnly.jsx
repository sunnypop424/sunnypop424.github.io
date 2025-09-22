// src/CoreOnly.jsx

import React from "react";
import { HashRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import LoACoreOptimizer from "./components/LoACoreOptimizer";
import GemSimulator from "./components/GemSimulator";
import { ChevronUp, ChevronDown } from "lucide-react";
import { showToast } from "./lib/toastBus"; // 전역 토스트 버스
import localPatchNotes from "./data/patch.json"; // ← /src/data/patch.json 고정


const RAW_NOTES = Array.isArray(localPatchNotes)
  ? localPatchNotes
  : Array.isArray(localPatchNotes?.notes)
    ? localPatchNotes.notes
    : [];

/**
 * PatchNotesModal이 기대하는 스키마로 변환:
 * - 우선 title/sections 스키마를 그대로 사용
 * - 아니라면 ver/date/items(구스키마)를 sections 한 개짜리로 매핑
 * - date 기준 내림차순 정렬(YYYY-MM-DD 형식 가정)
 */
const PATCH_NOTES = RAW_NOTES
  .map((n) => {
    // 새 스키마(title/sections)면 그대로
    if (n && (n.title || n.sections)) {
      return {
        title: n.title ?? "",
        date: n.date ?? "",
        sections: Array.isArray(n.sections)
          ? n.sections.map((s) => ({
            heading: s.heading ?? "",
            bullets: Array.isArray(s.bullets) ? s.bullets : [],
          }))
          : [],
      };
    }

    // 구 스키마(ver/date/items) → 새 스키마로 변환
    const title =
      (n?.title && String(n.title)) ||
      (n?.ver ? `+) ${n.ver} update!` : "Update");
    const items = Array.isArray(n?.items) ? n.items : [];
    return {
      title,
      date: n?.date || "",
      sections: [
        {
          heading: "", // 필요하면 '변경 사항' 같은 기본 제목을 줄 수도 있음
          bullets: items,
        },
      ],
    };
  })
  // 최신 항목이 위로 (date 내림차순)
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));

const LS_PATCH_SEEN = "LoA-PatchNotes-seen"; // 최신 시그니처 저장 키

const patchSigOf = (n) => (n ? `${n.title || ""}|${n.date || ""}` : "");

// 날짜가 1일(24h) 이내인지
function isWithin1Day(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) <= 24 * 60 * 60 * 1000;
}

// (선택) JSON이 최신순이 아닐 수 있으니 정렬 보장
function sortNotesDescByDate(arr) {
  return [...arr].sort((a, b) => {
    const da = new Date(a?.date || 0).getTime();
    const db = new Date(b?.date || 0).getTime();
    return db - da; // 최신 우선
  });
}

function useScrollPast(threshold = window.innerHeight) {
  const [past, setPast] = React.useState(false);

  React.useEffect(() => {
    let t = threshold;
    const onResize = () => {
      // threshold가 함수/음수 방지: 뷰포트 기반일 때만 갱신
      if (threshold === window.innerHeight) t = window.innerHeight;
    };
    const onScroll = () => setPast(window.scrollY >= t);

    onResize();
    onScroll();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
    };
  }, [threshold]);

  return past;
}

/** 안전 토스트 호출 */
function safeToast(msg, type = "info") {
  try {
    const s = typeof msg === "string" ? msg : JSON.stringify(msg);
    showToast(s, type);
  } catch {
    showToast(String(msg), type);
  }
}

/** 문의 모달 (alert → toast) */
function InquiryModal({ open, onClose }) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [files, setFiles] = React.useState([]);
  const [sending, setSending] = React.useState(false);

  // 환경설정: Vite env → meta → window 순
  const endpoint =
    (import.meta && import.meta.env && import.meta.env.VITE_DISCORD_PROXY) ||
    (typeof document !== "undefined" &&
      document.querySelector('meta[name="arcgrid-proxy"]')?.getAttribute("content")) ||
    (typeof window !== "undefined" && window.__ARCGRID_PROXY__) ||
    "";

  const apiKey =
    (import.meta && import.meta.env && import.meta.env.VITE_DISCORD_API_KEY) ||
    (typeof document !== "undefined" &&
      document.querySelector('meta[name="arcgrid-api-key"]')?.getAttribute("content")) ||
    (typeof window !== "undefined" && window.__ARCGRID_API_KEY__) ||
    "";

  const MAX_FILES = 4;
  const PER_FILE = 4 * 1024 * 1024; // 4MB
  const TOTAL = 16 * 1024 * 1024; // 16MB
  const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleFiles = (e) => {
    const picked = Array.from(e?.target?.files || []);
    if (!picked.length) return;

    let next = [...files];
    for (const f of picked) {
      if (!OK_TYPES.includes(f.type)) {
        safeToast("이미지 파일만 첨부할 수 있어요. (png, jpg, webp, gif)", "warning");
        continue;
      }
      if (f.size > PER_FILE) {
        safeToast(`파일 ${f.name}이(가) 4MB를 초과합니다.`, "warning");
        continue;
      }
      if (next.length >= MAX_FILES) {
        safeToast(`이미지는 최대 ${MAX_FILES}장까지 첨부할 수 있어요.`, "warning");
        break;
      }
      next.push(f);
    }

    const totalSize = next.reduce((s, f) => s + f.size, 0);
    if (totalSize > TOTAL) {
      safeToast(`이미지 총 용량은 최대 ${(TOTAL / 1024 / 1024) | 0}MB까지 가능합니다.`, "warning");
      return;
    }

    setFiles(next);
    if (e && e.target) e.target.value = ""; // 같은 파일 다시 선택 가능
  };

  const removeFileAt = (idx) => setFiles((arr) => arr.filter((_, i) => i !== idx));

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (sending) return;
    if (!title.trim() || !body.trim()) {
      safeToast("제목과 내용을 모두 입력하세요.", "warning");
      return;
    }
    if (!endpoint) {
      safeToast("전송 경로가 설정되지 않았습니다.", "error");
      return;
    }
    try {
      setSending(true);

      const fd = new FormData();
      const nonce = (crypto && crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
      fd.append("title", title.trim().slice(0, 80));
      fd.append("content", body.trim().slice(0, 4000));
      fd.append("nonce", nonce);
      files.forEach((f) => fd.append("files[]", f, f.name));

      const url = `${endpoint}${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
      const res = await fetch(url, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        safeToast("문의가 전송되었습니다. 감사합니다!", "success");
        setTitle(""); setBody(""); setFiles([]);
        onClose?.();
      } else {
        safeToast("전송 실패: 잠시 후 다시 시도해 주세요.", "error");
      }
    } catch (err) {
      console.error(err);
      safeToast("전송 중 오류가 발생했습니다.", "error");
    } finally {
      setSending(false);
    }
  };

  // 항상 렌더하되, 열릴 때만 보이도록 처리 (깜빡임/지연 없음)
  return (
    <div
      id="inquiry-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 transition-opacity duration-150"
      role="dialog"
      aria-modal="true"
      aria-hidden={open ? "false" : "true"}
      onClick={onClose}
      style={{
        // 숨김 상태: 보이지 않고, 포인터 막고, 레이아웃 영향 최소화
        opacity: open ? 1 : 0,
        visibility: open ? "visible" : "hidden",
        pointerEvents: open ? "auto" : "none",
        // 배경 반투명은 여기서 처리 (open에 관계없이 프리렌더)
        backgroundColor: "rgba(0,0,0,0.40)",
        backdropFilter: "blur(1px)"
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-xl p-4 sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base sm:text-lg font-semibold">문의하기</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-[#a399f2]/40"
            aria-label="닫기"
          >
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>

        <p className="mt-1 text-xs text-gray-600">
          제목/내용과 함께 이미지를 <b>최대 4장</b>까지 첨부할 수 있어요. (파일당 4MB, 총 16MB)
        </p>

        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">제목</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              placeholder="예) 아크그리드 계산 관련 문의"
              className="block mb-1 h-10 w-full px-3 rounded-xl border bg-white focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50"
            />
            <div className="text-[11px] text-gray-400 text-right">{title.length}/80</div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">내용</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              maxLength={4000}
              placeholder="문의 내용을 적어주세요. (재현 방법, 스크린샷 링크 등)"
              className="block mb-1 w-full px-3 py-2 rounded-xl border bg-white focus:outline-none focus:ring-2 focus:ring-[#a399f2]/50"
            />
            <div className="text-[11px] text-gray-400 text-right">{body.length}/4000</div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              이미지 첨부 (선택, 최대 4장)
            </label>

            <div
              className={[
                "rounded-2xl border-2 border-dashed",
                "border-gray-300 bg-gray-50/60 hover:bg-gray-50 transition",
                "p-4 text-center"
              ].join(" ")}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = Array.from(e.dataTransfer?.files || []);
                if (!dropped.length) return;
                const fakeEvent = { target: { files: dropped } };
                handleFiles(fakeEvent);
              }}
            >
              <input
                id="inq-files"
                type="file"
                accept={["image/png", "image/jpeg", "image/webp", "image/gif"].join(",")}
                multiple
                onChange={handleFiles}
                disabled={sending}
                className="sr-only"
              />

              <div className="flex flex-col items-center justify-center gap-2">
                <div className="text-[13px] text-gray-600">
                  파일을 이곳에 <b>끌어다 놓기</b> 또는
                  <label
                    htmlFor="inq-files"
                    className={[
                      "inline-flex items-center justify-center gap-2",
                      "px-3 h-8 ml-1 rounded-xl shadow-sm cursor-pointer",
                      "border inline-flex items-center justify-center bg-white hover:bg-gray-50"
                    ].join(" ")}
                    title="이미지 선택"
                  >
                    이미지 선택
                  </label>
                </div>
                <div className="text-[11px] text-gray-500">
                  허용: png, jpg, webp, gif · 파일당 4MB · 총 16MB
                </div>
              </div>
            </div>

            {/* 미리보기 */}
            {files.length > 0 && (
              <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2">
                {files.map((f, idx) => {
                  const url = URL.createObjectURL(f);
                  return (
                    <div key={idx} className="relative">
                      <img
                        src={url}
                        alt={f.name}
                        className="h-24 w-full object-cover rounded-lg border"
                        onLoad={() => URL.revokeObjectURL(url)}
                      />
                      <button
                        type="button"
                        onClick={() => removeFileAt(idx)}
                        className="absolute -top-2 -right-2 bg-white border rounded-full w-6 h-6 text-xs font-bold"
                        title="제거"
                        aria-label="첨부 제거"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="pt-1 flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-3 rounded-xl border inline-flex items-center justify-center bg-white hover:bg-gray-50"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={sending}
              className={[
                "h-10 px-3 rounded-xl inline-flex items-center justify-center gap-2",
                "text-white",
                "hover:brightness-95 active:brightness-90",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/50",
                sending ? "opacity-70 cursor-not-allowed" : ""
              ].join(" ")}
              style={{ backgroundColor: "#a399f2" }}
            >
              {sending ? "전송 중…" : "전송하기"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}




// 보조 함수: **bold** 처리
function emphasize(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**")
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>
  );
}

// 보조 함수: bullet 안 줄바꿈(\n)과 단락(\n\n) 처리
function renderBullet(text) {
  const paras = String(text).split(/\n{2,}/); // \n\n 기준 단락
  return paras.map((p, pi) => {
    const lines = p.split(/\n/);
    return (
      <p key={pi} className={pi ? "mt-1.5" : ""}>
        {lines.map((ln, li) => (
          <React.Fragment key={li}>
            {emphasize(ln)}
            {li < lines.length - 1 ? <br /> : null}
          </React.Fragment>
        ))}
      </p>
    );
  });
}

// ─────────────────────────────────────────────────────────────
// 부드러운 접힘/펼침(닫힘 애니메이션 포함) - 개선판
// ─────────────────────────────────────────────────────────────
function Slide({ open, children, duration = 220 }) {
  const ref = React.useRef(null);
  const mounted = React.useRef(false);
  const endHandlerRef = React.useRef(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 이전 transitionend 리스너 제거
    if (endHandlerRef.current) {
      el.removeEventListener("transitionend", endHandlerRef.current);
      endHandlerRef.current = null;
    }

    el.style.overflow = "hidden";
    el.style.willChange = "max-height";
    el.style.transition = `max-height ${duration}ms ease`;

    const setMax = (v) => { el.style.maxHeight = v; };

    // 첫 마운트: 상태에 맞춰 바로 세팅(깜빡임 없음)
    if (!mounted.current) {
      setMax(open ? "none" : "0px");
      mounted.current = true;
      return;
    }

    const measure = () => el.scrollHeight + "px";

    if (open) {
      // 열기: 0 → px → (end) none
      // 시작점 강제 커밋 후 높이로 전환 (동시 토글에도 안전)
      setMax("0px");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMax(measure());
          const onEnd = () => {
            setMax("none"); // 열림 유지 중 내용 높이 변화 대응
            el.removeEventListener("transitionend", onEnd);
            endHandlerRef.current = null;
          };
          el.addEventListener("transitionend", onEnd);
          endHandlerRef.current = onEnd;
        });
      });
    } else {
      // 닫기: none/px → px → 0 (동시 토글에서도 스무스하게)
      // none이면 현재 높이로 고정해서 시작
      const curMax = getComputedStyle(el).maxHeight;
      if (curMax === "none") setMax(measure());
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMax("0px");
        });
      });
    }
  }, [open, children, duration]);

  return (
    <div ref={ref} aria-hidden={!open}>
      {children}
    </div>
  );
}




// ─────────────────────────────────────────────────────────────
// 패치 노트 모달 (리스트/아코디언, 하나만 열림, 최신 항목 기본 오픈)
// ─────────────────────────────────────────────────────────────
function PatchNotesModal({ open, onClose, notes }) {
  // 모달 열릴 때 0번(최신) 오픈
  const [openIdx, setOpenIdx] = React.useState(0);
  React.useEffect(() => {
    if (open) setOpenIdx(0);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const toggle = (idx) => {
    setOpenIdx((cur) => (cur === idx ? -1 : idx));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 transition-opacity duration-150"
      role="dialog"
      aria-modal="true"
      aria-hidden={open ? "false" : "true"}
      onClick={onClose}
      style={{
        opacity: open ? 1 : 0,
        visibility: open ? "visible" : "hidden",
        pointerEvents: open ? "auto" : "none",
        backgroundColor: "rgba(0,0,0,0.40)",
        backdropFilter: "blur(1px)"
      }}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">패치 노트</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-[#a399f2]/40"
            aria-label="닫기"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M6 6l12 12M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-3 max-h-[70vh] overflow-auto pr-1">
          {(notes ?? []).length === 0 ? (
            <div className="text-sm text-gray-600">표시할 내용이 없습니다.</div>
          ) : (
            <ul className="divide-y">
              {(notes ?? []).map((n, idx) => {
                const isOpen = openIdx === idx;
                return (
                  <li key={idx} className="py-2">
                    <button
                      type="button"
                      onClick={() => toggle(idx)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(idx);
                        }
                      }}
                      aria-expanded={isOpen}
                      className={`w-full grid grid-cols-[1fr_auto_auto] items-center gap-3 text-left rounded-lg px-2 py-2
                        hover:bg-gray-50
                        border border-2 ${isOpen ? "border-[#a399f2]/30 bg-gray-50" : "border-transparent"}`}
                    >
                      {/* 좌측: 제목 */}
                      <span className="min-w-0 truncate font-medium">
                        {n.title || "Update"}
                      </span>
                      {/* 중앙: 날짜 */}
                      <span className="text-[11px] text-gray-500">
                        {n.date || ""}
                      </span>
                      {/* 우측: 화살표 */}
                      <span aria-hidden className="flex items-center">
                        <ChevronDown
                          size={16}
                          className={`transition-transform text-gray-500 ${isOpen ? "rotate-180" : ""}`}
                        />
                      </span>
                    </button>

                    <Slide open={isOpen}>
                      <div className="px-2 pt-2 pb-3">
                        {(n.sections ?? []).map((sec, si) => (
                          <div key={si} className="mb-3 last:mb-0">
                            {sec.heading ? <div className="font-semibold mb-1">{sec.heading}</div> : null}
                            <ul className="list-disc pl-5 space-y-1 text-[15px] leading-7">
                              {(sec.bullets ?? []).map((b, bi) => (
                                <li key={bi}>{renderBullet(b)}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </Slide>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
/** TOP 전용 FAB */
function TopFab() {
  const show = useScrollPast(300); // 혹은 600, 1.25*window.innerHeight 등
  return (
    <div className="fixed right-4 bottom-4 sm:right-6 sm:bottom-6">
      <button
        type="button"
        aria-label="맨 위로"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className={[
          "inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur",
          "text-gray-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/40",
          "transition transform duration-200",
          show ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        ].join(" ")}
      >
        <ChevronUp size={18} />
        <span className="hidden sm:inline text-sm font-medium">TOP</span>
      </button>
    </div>
  );
}

/** 페이지 루트 */
export default function CoreOnly() {
  const [inqOpen, setInqOpen] = React.useState(false);
  const [patchOpen, setPatchOpen] = React.useState(false);

  // 정렬 보장(최신이 0번)
  const notesSorted = React.useMemo(() => sortNotesDescByDate(PATCH_NOTES), []);
  const latest = notesSorted[0];

  // 처음 진입 시 NEW 여부 계산 (최신이 1일 이내 & 이전에 본 적 없음)
  const [hasNew, setHasNew] = React.useState(() => {
    if (!latest) return false;
    if (!isWithin1Day(latest.date)) return false;
    const seen = localStorage.getItem(LS_PATCH_SEEN);
    return seen !== patchSigOf(latest);
  });

  const openPatch = React.useCallback(() => {
    setPatchOpen(true);
    // 열면 본 것으로 처리 -> NEW 제거 + 저장
    if (latest) {
      localStorage.setItem(LS_PATCH_SEEN, patchSigOf(latest));
      setHasNew(false);
    }
  }, [latest]);

  return (
    <HashRouter basename="/core">
      <div className="min-h-screen bg-gray-50 text-gray-900">
        <header className="sticky top-0 z-40 border-b border-gray-200/60 bg-white/70 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3">
            <nav aria-label="Core pages">
              <ul className="mx-auto flex w-full flex-wrap justify-center gap-1 rounded-xl">
                <li>
                  <NavLink
                    to="/gem"
                    className={({ isActive }) =>
                      [
                        "px-4 py-2 text-sm font-medium rounded-lg transition",
                        "outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/30",
                        isActive ? "bg-[#a399f2]/10 text-[#5b54c6]" : "text-gray-700 hover:bg-gray-50",
                      ].join(" ")
                    }
                  >
                    젬 가공 헬퍼
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/optimizer"
                    className={({ isActive }) =>
                      [
                        "px-4 py-2 text-sm font-medium rounded-lg transition",
                        "outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/30",
                        isActive ? "bg-[#a399f2]/10 text-[#5b54c6]" : "text-gray-700 hover:bg-gray-50",
                      ].join(" ")
                    }
                  >
                    젬 장착 헬퍼
                  </NavLink>
                </li>
                <li>
                  {/* 라우팅 이동 없이 모달만 열기 */}
                  <NavLink
                    to="/patch"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); openPatch(); }}
                    className={() =>
                      [
                        "px-4 py-2 text-sm font-medium rounded-lg transition",
                        "outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/30",
                        "text-gray-700 hover:bg-gray-50",
                      ].join(" ")
                    }
                    role="button"
                    aria-haspopup="dialog"
                    aria-expanded={patchOpen}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>패치 노트</span>
                      {hasNew && (
                        <span
                          className="inline-flex items-center rounded-full bg-[#a399f2] text-white
               text-[9px] font-semibold leading-none px-[6px] py-1
               motion-safe:animate-[pulse_1.6s_ease-in-out_infinite]"
                        >
                          NEW
                        </span>
                      )}
                    </span>
                  </NavLink>
                </li>
                <li>
                  {/* 라우팅 이동 없이 '문의하기' 모달 열기 */}
                  <NavLink
                    to="/inquiry"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setInqOpen(true); }}
                    className={() =>
                      [
                        "px-4 py-2 text-sm font-medium rounded-lg transition",
                        "outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/30",
                        "text-gray-700 hover:bg-gray-50",
                      ].join(" ")
                    }
                    role="button"
                    aria-haspopup="dialog"
                    aria-expanded={inqOpen}
                    aria-controls="inquiry-modal"
                  >
                    <span className="inline-flex items-center gap-1">
                      <span>문의하기</span>
                    </span>
                  </NavLink>
                </li>
              </ul>
            </nav>
          </div>
        </header>

        {/* 라우트 영역 */}
        <main>
          <Routes>
            <Route index element={<Navigate to="/optimizer" replace />} />
            <Route path="/gem" element={<GemSimulator />} />
            <Route path="/optimizer" element={<LoACoreOptimizer />} />
            <Route path="*" element={<Navigate to="/optimizer" replace />} />
          </Routes>
        </main>
      </div>

      <TopFab />
      <InquiryModal open={inqOpen} onClose={() => setInqOpen(false)} />
      <PatchNotesModal open={patchOpen} onClose={() => setPatchOpen(false)} notes={notesSorted} />
    </HashRouter>
  );
}
