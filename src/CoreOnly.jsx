import React from "react";
import { HashRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import LoACoreOptimizer from "./components/LoACoreOptimizer";
import GemSimulator from "./components/GemSimulator";
import { ChevronUp, MessageCircle } from "lucide-react";

/**
 * CoreOnly as pages via HashRouter
 * - 해시 URL: #/core/gem, #/core/optimizer
 * - 기본 리다이렉트: #/core/optimizer
 * - 상단 네비는 NavLink (접근성 role="navigation")
 */
function useNearBottom(offset = 520) {
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const scrollBottom = doc.scrollHeight - (doc.scrollTop + window.innerHeight);
      setNear(scrollBottom <= offset);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [offset]);
  return near;
}

/** 문의 모달 */
function InquiryModal({ open, onClose }) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [files, setFiles] = React.useState([]);          // File[] (여러 장)
  const [sending, setSending] = React.useState(false);

  

  const endpoint =
    import.meta.env?.VITE_DISCORD_PROXY ||
    (typeof document !== "undefined" &&
      document.querySelector('meta[name="arcgrid-proxy"]')?.content) ||
    (typeof window !== "undefined" && window.__ARCGRID_PROXY__) ||
    "";
  const apiKey =
    import.meta.env?.VITE_DISCORD_API_KEY ||
    (typeof document !== "undefined" &&
      document.querySelector('meta[name="arcgrid-api-key"]')?.content) ||
    (typeof window !== "undefined" && window.__ARCGRID_API_KEY__) ||
    "";

    // InquiryModal 내부에 임시로
    console.log("endpoint =", endpoint);
    console.log("apiKey   =", apiKey);

  const MAX_FILES = 4;
  const PER_FILE = 4 * 1024 * 1024;  // 4MB
  const TOTAL = 16 * 1024 * 1024; // 16MB
  const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;

    let next = [...files];
    for (const f of picked) {
      if (!OK_TYPES.includes(f.type)) {
        alert("이미지 파일만 첨부할 수 있어요. (png, jpg, webp, gif)");
        continue;
      }
      if (f.size > PER_FILE) {
        alert(`파일 ${f.name}이(가) 5MB를 초과합니다.`);
        continue;
      }
      if (next.length >= MAX_FILES) {
        alert(`이미지는 최대 ${MAX_FILES}장까지 첨부할 수 있어요.`);
        break;
      }
      next.push(f);
    }

    const totalSize = next.reduce((s, f) => s + f.size, 0);
    if (totalSize > TOTAL) {
      alert(`이미지 총 용량은 최대 ${(TOTAL / 1024 / 1024) | 0}MB까지 가능합니다.`);
      return;
    }

    setFiles(next);
    e.target.value = ""; // 같은 파일 다시 선택 가능하도록 초기화
  };

  const removeFileAt = (idx) => {
    setFiles((arr) => arr.filter((_, i) => i !== idx));
  };

  const fileToBase64 = async (f) => {
    const buf = await f.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary); // base64
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (sending) return; // 더블클릭 방지 (프레임 경합)
    if (!title.trim() || !body.trim()) {
      alert("제목과 내용을 모두 입력하세요.");
      return;
    }
    if (!endpoint) {
      alert("전송 경로가 설정되지 않았습니다. (VITE_DISCORD_PROXY)");
      return;
    }
    try {
      setSending(true);

      // File[] -> [{ name, type, data(base64) }, ...]
      const images = [];
      for (const f of files) {
        const data = await fileToBase64(f);
        images.push({ name: f.name, type: f.type, data });
      }

      const fd = new FormData();
      const nonce = (crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
      fd.append("title", title.trim().slice(0, 80));
      fd.append("content", body.trim().slice(0, 4000));
      fd.append("nonce", nonce); // ← 워커 디둡용 토큰
      files.forEach((f) => fd.append("files[]", f, f.name));
     
      const url = `${endpoint}${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
      const res = await fetch(url, { method: "POST", body: fd }); // Content-Type 수동 지정 X
      const data = await res.json().catch(() => ({}));
      if (data?.ok) {
        alert("문의가 전송되었습니다. 감사합니다!");
        setTitle(""); setBody(""); setFiles([]);
        onClose?.();
      } else {
        alert("전송 실패: 잠시 후 다시 시도해 주세요.");
      }
    } catch (err) {
      console.error(err);
      alert("전송 중 오류가 발생했습니다.");
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[1px] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white border shadow-xl p-4 sm:p-5"
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
          제목/내용과 함께 이미지를 <b>최대 {MAX_FILES}장</b>까지 첨부할 수 있어요. (파일당 4MB, 총 16MB)
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
            {/* 이미지 첨부 (선택, 최대 {MAX_FILES}장) */}
            <label className="block text-xs text-gray-500 mb-1">
              이미지 첨부 (선택, 최대 {MAX_FILES}장)
            </label>

            {/* 드래그&드롭 + 버튼 업로더 */}
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
                // 기존 handleFiles를 재활용: input change와 동일하게 처리하려면 아래 ingest 로직을 사용,
                // 아니면 handleFiles를 수정해도 됩니다.
                const fakeEvent = { target: { files: dropped } };
                handleFiles(fakeEvent);
              }}
            >
              {/* 숨겨진 파일 인풋 */}
              <input
                id="inq-files"
                type="file"
                accept={OK_TYPES.join(",")}
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
                  허용: png, jpg, webp, gif등 · 파일당 4MB · 총 16MB
                </div>
              </div>
            </div>

            {/* 미리보기 그리드 (기존 그대로 사용) */}
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

              <button
                type="button"
                onClick={onClose}
                className="h-10 px-3 rounded-xl border inline-flex items-center justify-center bg-white hover:bg-gray-50"
              >
                취소
              </button>
            </div>
        </form>
      </div>
    </div>
  );
}


/** FAB 스택: 문의 + TOP */
function FabStack({ onOpenInquiry }) {
  const nearBottom = useNearBottom(520);
  return (
    <div className="fixed z-50 right-4 bottom-4 sm:right-6 sm:bottom-6 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] flex flex-col gap-2">
      {/* 문의하기 FAB: 항상 노출 */}
      <button
        type="button"
        aria-label="문의하기"
        onClick={onOpenInquiry}
        className={[
          "inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur",
          "text-gray-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/40",
          "transition transform duration-200",
          nearBottom ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        ].join(" ")}
      >
        <MessageCircle size={18} />
        <span className="hidden sm:inline text-sm font-medium">문의</span>
      </button>

      {/* TOP FAB: 하단 근처일 때 노출 */}
      <button
        type="button"
        aria-label="맨 위로"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className={[
          "inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur",
          "text-gray-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/40",
          "transition transform duration-200",
          nearBottom ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        ].join(" ")}
      >
        <ChevronUp size={18} />
        <span className="hidden sm:inline text-sm font-medium">TOP</span>
      </button>
    </div>
  );
}

export default function CoreOnly() {
  const [inqOpen, setInqOpen] = React.useState(false);

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
              </ul>
            </nav>
          </div>
        </header>

        {/* 라우트 영역 */}
        <main>
          <Routes>
            {/* 기본 경로 보정: /#/core → /#/core/optimizer */}
            <Route index element={<Navigate to="/optimizer" replace />} />

            <Route path="/gem" element={<GemSimulator />} />
            <Route path="/optimizer" element={<LoACoreOptimizer />} />

            {/* 나머지 경로도 optimizer로 보정 */}
            <Route path="*" element={<Navigate to="/optimizer" replace />} />
          </Routes>
        </main>
      </div>

      {/* FAB 스택 & 모달 */}
      <FabStack onOpenInquiry={() => setInqOpen(true)} />
      <InquiryModal open={inqOpen} onClose={() => setInqOpen(false)} />
    </HashRouter>
  );
}
