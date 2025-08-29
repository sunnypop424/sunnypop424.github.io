// src/utils/openIsolatedWindow.js
import { createRoot } from "react-dom/client";
export function openIsolatedWindow(
  reactElement,
  { title = "LoA Core Optimizer", width = 1200, height = 800 } = {}
) {
  const features = `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=yes`;
  const win = window.open("", "_blank", features);
  if (!win) {
    alert("팝업이 차단되었어요. 브라우저 팝업 허용을 켜주세요.");
    return;
  }
  // skeleton 문서 주입 (프로젝트 전역 CSS는 복사 X → AvatarComparisonAuto.css 영향 차단)
  win.document.open();
  win.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <!-- 폰트 -->
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.8/dist/web/variable/pretendardvariable-dynamic-subset.css" />
        <!-- Tailwind (격리된 창 전용) -->
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          :root{ --primary:#85d8ea; }
          .text-primary{ color:#a399f2; } /* 요청: 강조 텍스트 보라톤 */
          html,body,#root{ height:100%; }
          body{ margin:0; background: linear-gradient(125deg, #85d8ea, #a399f2); font-family: Pretendard Variable, Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, 'Helvetica Neue', 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif; }
        </style>
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `);
  win.document.close();
  // #root가 만들어질 때까지 짧게 폴링 후 마운트
  const tryMount = () => {
    const el = win.document.getElementById("root");
    if (!el) return false;
    try {
      // 중복 마운트 방지
      if (!win.__reactRoot) {
        win.__reactRoot = createRoot(el);
      }
      win.__reactRoot.render(reactElement);
      // 창 닫힐 때 정리
      const cleanup = () => { try { win.__reactRoot?.unmount(); } catch {} };
      win.addEventListener("beforeunload", cleanup, { once: true });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };
  if (!tryMount()) {
    const iv = win.setInterval(() => {
      if (tryMount()) win.clearInterval(iv);
    }, 20);
    // 5초 타임아웃
    win.setTimeout(() => win.clearInterval(iv), 5000);
  }
}
