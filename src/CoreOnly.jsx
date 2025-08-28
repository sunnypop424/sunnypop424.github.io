import React, { useEffect, useMemo, useState } from "react";
import LoACoreOptimizer from "./components/LoACoreOptimizer";
import GemSimulator from "./components/GemSimulator"; // 경로 필요시 조정

/**
 * CoreOnly with tabs
 * - URL 유지: #/core?tab=optimizer | #/core?tab=gem
 * - 마지막 선택 저장: localStorage("core_tab")
 * - 키보드 접근성: role="tablist"/"tab"
 */
export default function CoreOnly() {
  // 초기 탭: URL > localStorage > 기본값("optimizer")
  const getTabFromUrl = () => {
    try {
      const m = window.location.hash.match(/tab=([^&]+)/);
      return m?.[1] || null;
    } catch (_) { return null; }
  };
  const initialTab = getTabFromUrl() || localStorage.getItem("core_tab") || "optimizer";
  const [tab, setTab] = useState(initialTab);

  // 탭 변경 시 URL/hash & localStorage 동기화 ( #/core 그대로 유지 )
  useEffect(() => {
    const base = "#/core";
    const search = `?tab=${tab}`;
    const nextHash = base + search;
    if (window.location.hash !== nextHash) {
      // replaceState로 히스토리 오염 방지
      window.history.replaceState(null, "", window.location.pathname + window.location.search + nextHash);
    }
    localStorage.setItem("core_tab", tab);
  }, [tab]);

  // 해시 외부 변경(#/core 유지) 시 탭 동기화
  useEffect(() => {
    const onHash = () => {
      const u = getTabFromUrl();
      if (u && u !== tab) setTab(u);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [tab]);

  const tabs = useMemo(() => ([
    { key: "optimizer", label: "아크그리드 젬 장착 도우미" },
    { key: "gem", label: "아크그리드 젬 가공 도우미" },
  ]), []);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="px-4 sm:px-6 py-4 border-b bg-white/70 backdrop-blur">
        <h1 className="text-xl font-bold">코어 최적화</h1>
      </header>

      {/* Tabs */}
      <div className="px-4 sm:px-6 mt-4">
        <div role="tablist" aria-label="CoreOnly tabs" className="inline-flex rounded-2xl border bg-white shadow-sm overflow-hidden">
          {tabs.map((t, i) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${t.key}`}
                className={`px-4 py-2 text-sm outline-none focus-visible:ring-2 ${active ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"} ${i>0?"border-l":""}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Panels */}
      <main className="px-4 sm:px-6 py-4">
        <section id="panel-optimizer" role="tabpanel" hidden={tab !== "optimizer"} className="mt-4">
          <LoACoreOptimizer />
        </section>
        <section id="panel-gem" role="tabpanel" hidden={tab !== "gem"} className="mt-4">
          <GemSimulator />
        </section>
      </main>
    </div>
  );
}
