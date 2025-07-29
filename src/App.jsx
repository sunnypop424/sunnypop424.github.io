import React, { useState } from 'react';
import './App.css';
import './components/AvatarComparisonAuto.css';
import AvatarComparisonAuto from './components/AvatarComparisonAuto';
import PeonCalculator from './components/PeonCalculator';
import KakaoAdfit from './components/KakaoAdfit';

function App() {
  const [activeTab, setActiveTab] = useState('peon');

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
