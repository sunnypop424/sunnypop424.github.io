import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

(async function bootstrap() {
  const isCoreOnly = window.location.hash === '#/core';
  const { default: Entry } = isCoreOnly
    ? await import('./CoreOnly')
    : await import('./App');

  if (isCoreOnly) {
    // 코어 전용 창: StrictMode 해제 (DnD 애니메이션 타이밍 충돌 방지)
    root.render(<Entry />);
  } else {
    // 일반 앱: 기존처럼 StrictMode 유지
    root.render(
      <React.StrictMode>
        <Entry />
      </React.StrictMode>
    );
  }
})();

reportWebVitals();
