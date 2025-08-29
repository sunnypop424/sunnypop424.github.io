import React, { useState } from 'react';
import './App.css';
import './components/AvatarComparisonAuto.css';
import AvatarComparisonAuto from './components/AvatarComparisonAuto';
import PeonCalculator from './components/PeonCalculator';
import KakaoAdfit from './components/KakaoAdfit';
function App() {
  const [activeTab, setActiveTab] = useState('peon');
  
  const openCoreInNewWindow = () => {
    // 현재 오리진/경로를 유지한 채 #/core만 붙여 새창 오픈
    const url = `${window.location.origin}${window.location.pathname}#/core`;
    window.open(url, "_blank", "popup=no,width=1200,height=800,resizable=yes,scrollbars=yes");
  };
  return (
    <div className="app-container">
      <div className="tab-buttons">
        <button
          className={activeTab === 'peon' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('peon')}
        >
          페온<span className='none'> 계산기</span>
        </button>
        <button
          className={activeTab === 'avatar' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('avatar')}
        >
          아바타<span className='none'> 가격 비교 계산기</span>
        </button>
        <button className='tab' onClick={openCoreInNewWindow}>
          코어 최적화
        </button>
      </div>
      <div className="tab-content">
        {activeTab === 'peon' && <PeonCalculator />}
        {activeTab === 'avatar' && <AvatarComparisonAuto />}
      </div>
      <KakaoAdfit />
    </div>
  );
}
export default App;
