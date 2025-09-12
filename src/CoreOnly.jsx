import React from "react";
import { HashRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import LoACoreOptimizer from "./components/LoACoreOptimizer";
import GemSimulator from "./components/GemSimulator";
import { ChevronUp } from "lucide-react";

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

function TopFab() {
  const visible = useNearBottom(520);
  return (
    <div className="fixed z-50 right-4 bottom-4 sm:right-6 sm:bottom-6 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]">
      <button
        type="button"
        aria-label="맨 위로"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className={[
          "inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur",
          "text-gray-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a399f2]/40",
          "transition transform duration-200",
          visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        ].join(" ")}
      >
        <ChevronUp size={18} />
        <span className="hidden sm:inline text-sm font-medium">TOP</span>
      </button>
    </div>
  );
}

export default function CoreOnly() {
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
      <TopFab />
    </HashRouter>
  );
}
