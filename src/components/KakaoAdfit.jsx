import React, { useEffect, useRef } from 'react';

function KakaoAdfit() {
  const adRef = useRef(null);

  useEffect(() => {
    const ins = document.createElement('ins');
    ins.className = 'kakao_ad_area';
    ins.style.display = 'none';
    ins.setAttribute('data-ad-unit', 'DAN-V4UQDzJ7BdEKoWll');
    ins.setAttribute('data-ad-width', '320');
    ins.setAttribute('data-ad-height', '50');

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = '//t1.daumcdn.net/kas/static/ba.min.js';

    if (adRef.current) {
      adRef.current.innerHTML = ''; // 중복 방지
      adRef.current.appendChild(ins);
      adRef.current.appendChild(script);
    }
  }, []);

  return <div ref={adRef} className="kakao-adfit-container" />;
}

export default KakaoAdfit;