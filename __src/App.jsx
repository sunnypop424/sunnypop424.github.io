import "./index.css";
import React, { useEffect, useState } from "react";

import AvatarComparisonAuto from "./components/AvatarComparisonAuto";
import PeonCalculator from "./components/PeonCalculator";
import ArkGridOptimizer from "./components/ArkGridOptimizer";

function DarkModeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const d = saved ? saved === "dark" : prefers;
    setDark(d);
    document.documentElement.classList.toggle("dark", d);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <button
      onClick={() => setDark((v) => !v)}
      className="btn btn-ghost fixed right-4 top-4 z-50"
      aria-label="Toggle dark mode"
    >
      {dark ? "🌙 Dark" : "☀️ Light"}
    </button>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("peon");

  return (
    <div className="section">
      <DarkModeToggle />
      <div className="tabs">
        <button
          className={activeTab === "optimizer" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("optimizer")}
        >
          아크그리드 <span>최적화</span>
        </button>
        <button
          className={activeTab === "peon" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("peon")}
        >
          페온 <span>계산기</span>
        </button>
        <button
          className={activeTab === "avatar" ? "tab tab-active" : "tab"}
          onClick={() => setActiveTab("avatar")}
        >
          아바타 <span>가격 비교 계산기</span>
        </button>
      </div>

      <div className="pt-4">
        {activeTab === "optimizer" && <ArkGridOptimizer />}
        {activeTab === "peon" && <PeonCalculator />}
        {activeTab === "avatar" && <AvatarComparisonAuto />}
      </div>
    </div>
  );
}

export default App;
