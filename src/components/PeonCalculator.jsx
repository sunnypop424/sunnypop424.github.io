import React, { useState } from 'react';
import './AvatarComparisonAuto.css';
import { LoaderCircle } from 'lucide-react'

function calculatePeonCost(peonCount, crystalRate) {
    if (peonCount <= 0) return null;

    let best = null;
    const max100 = Math.ceil(peonCount / 100) + 1;

    for (let c100 = 0; c100 <= max100; c100++) {
        for (let c30 = 0; c30 <= Math.ceil(peonCount / 30) + 1; c30++) {
            for (let c1 = 0; c1 <= Math.ceil(peonCount / 1); c1++) {
                const totalPeons = c100 * 100 + c30 * 30 + c1;
                if (totalPeons < peonCount) continue;

                const totalCrystals = c100 * 850 + c30 * 270 + c1 * 10;
                const totalGold = totalCrystals * crystalRate;
                const avgGoldPerPeon = totalGold / peonCount;

                if (!best || totalGold < best.totalGold) {
                    best = {
                        breakdown: [
                            ...(c100 > 0 ? [{ name: '100개 묶음', count: c100, totalCrystals: c100 * 850 }] : []),
                            ...(c30 > 0 ? [{ name: '30개 묶음', count: c30, totalCrystals: c30 * 270 }] : []),
                            ...(c1 > 0 ? [{ name: '1개 단품', count: c1, totalCrystals: c1 * 10 }] : []),
                        ],
                        totalPeons,
                        leftoverPeons: totalPeons - peonCount,
                        totalCrystals,
                        totalGold,
                        avgGoldPerPeon,
                        crystalRate,
                        usedPlan: '모든 조합 중 최저가',
                    };
                }
            }
        }
    }

    return best;
}

function PeonCalculator() {
    const [peonCountInput, setPeonCountInput] = useState(60);
    const [goldPer100CrystalInput, setGoldPer100CrystalInput] = useState(10000);
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);

    const handleCalculate = () => {
        if (peonCountInput <= 0) {
            alert('1개 이상 입력해주세요.');
            return;
        }
        if (peonCountInput > 10000) {
            alert('10000개 이하만 입력 가능합니다.');
            return;
        }

        setLoading(true);
        setTimeout(() => {
            const crystalRate = goldPer100CrystalInput / 95;
            const calculated = calculatePeonCost(peonCountInput, crystalRate);
            setResult(calculated);
            setLoading(false);
        }, 300);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleCalculate();
        }
    };

    return (
        <div className="avatar">
            <div className="wrapper">
                <div className="avatar-comparison">
                    <h1 className="title">페온 계산기</h1>
                    <div className="avatar-row">
                        <label>
                            <span className="label">블루크리스탈 100개당 골드 (직접 입력해주세요)</span>
                            <div className="label-form">
                                <input
                                    type="number"
                                    value={goldPer100CrystalInput}
                                    onChange={(e) => setGoldPer100CrystalInput(Number(e.target.value))}
                                    onKeyDown={handleKeyDown}
                                />
                            </div>
                        </label>
                        <div className="note">
                            ※ 수수료 5% 반영 (실수령 95개 기준)<br />
                            모든 패키지 조합 중 가장 저렴한 조합을 자동 계산합니다.
                        </div>
                    </div>

                    <div className="avatar-row">
                        <label>
                            <span className="label">페온 수량</span>
                            <div className="label-form">
                                <input
                                    type="number"
                                    value={peonCountInput}
                                    onChange={(e) => setPeonCountInput(Number(e.target.value))}
                                    onKeyDown={handleKeyDown}
                                    min={0}
                                    max={10000}
                                />
                            </div>
                        </label>
                    </div>

                    <button
                        className="btn-mint"
                        onClick={handleCalculate}
                        disabled={loading}
                    >
                        {loading ? (
                            <>
                                <LoaderCircle className='spinning' color='#fff' />
                            </>
                        ) : (
                            '계산하기'
                        )}
                    </button>
                </div>

                <div className="comparison-result">
                    {result ? (
                        <>
                            <div className="price-result flex-c">
                                <h3>추천 페온 패키지</h3>
                                <span className='badge row-price'>{result.usedPlan}</span>
                                <ul className='recom'>
                                    {result.breakdown.map((item, idx) => (
                                        <li key={idx}>
                                            <p><span className='peon'>페온</span><strong>{item.name}</strong> × {item.count}개</p><p>{item.totalCrystals.toLocaleString()}<span className="crystal"> 크리스탈</span></p>
                                        </li>
                                    ))}

                                </ul>
                            </div>
                            <div className="price-result flex-c">
                                <h3>총 비용</h3>
                                <ul className='impact'>
                                    <li>
                                        <p>총 골드 소모</p><p><strong>{Math.round(result.totalGold).toLocaleString()}</strong><span className="gold"> G</span></p>
                                    </li>
                                </ul>
                                <ul>
                                    <li>
                                        <p>총 크리스탈 필요량</p><p><strong>{result.totalCrystals.toLocaleString()}</strong><span className="crystal"> 크리스탈</span></p>
                                    </li>
                                    <li>
                                        <p>1 크리스탈당 골드</p><p><strong>{result.crystalRate.toFixed(2)}</strong><span className="gold"> G</span></p>
                                    </li>
                                    <li>
                                        <p>1 페온당 평균 골드</p><p><strong>{result.avgGoldPerPeon.toFixed(2)}</strong><span className="gold"> G</span></p>
                                    </li>
                                    {result.leftoverPeons > 0 && (
                                        <li>
                                            <p>남는 페온</p><p><strong>{result.leftoverPeons.toLocaleString()}</strong><span className='peon'>페온</span></p>
                                        </li>
                                    )}
                                </ul>
                            </div>
                        </>
                    ) : (
                        <div className="empty-result">
                            계산 결과가 보여집니다.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default PeonCalculator;

