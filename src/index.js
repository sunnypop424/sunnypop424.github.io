import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

(async function bootstrap() {
  // '#/core'로 시작하면 CoreOnly 엔트리로 분기 (서브경로 허용)
  const isCoreOnly = (window.location.hash || '').startsWith('#/core');
  const { default: Entry } = isCoreOnly
    ? await import('./CoreOnly')
    : await import('./App');

  if (isCoreOnly) {
    // 코어 전용 창: StrictMode 해제 (DnD 타이밍 이슈 회피 등)
    root.render(<Entry />);
  } else {
    root.render(
      <React.StrictMode>
        <Entry />
      </React.StrictMode>
    );
  }
})();

reportWebVitals();
