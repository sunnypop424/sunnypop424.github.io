import React, { useState } from 'react';
import { CircleCheckBig, ThumbsUp } from 'lucide-react';

function AvatarComparisonAuto() {
    const [avatarName, setAvatarName] = useState('');
    const [goldPer100Crystal, setGoldPer100Crystal] = useState(10000);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [selectedClass, setSelectedClass] = useState('');
    const [groupedPrices, setGroupedPrices] = useState({});
    const [hasFetched, setHasFetched] = useState(false);
    const [cheapestGroupSnapshot, setCheapestGroupSnapshot] = useState(null);
    const [selectedGrade, setSelectedGrade] = useState('전체');
    const [selectedCategory, setSelectedCategory] = useState('20000');

    const crystalRate = goldPer100Crystal / 95;

    const calculatePeonCost = (peons) => {
        const packRules = [
            { size: 100, cost: 850 },
            { size: 30, cost: 270 },
            { size: 1, cost: 10 },
        ];
        let remaining = peons;
        let totalCrystals = 0;
        for (let pack of packRules) {
            const count = Math.floor(remaining / pack.size);
            totalCrystals += count * pack.cost;
            remaining -= count * pack.size;
        }
        return totalCrystals * crystalRate;
    };

    const fetchPrices = async () => {
        const allowSearchWithoutName = selectedGrade === '전설' && selectedCategory !== '20000';

        if (!allowSearchWithoutName && (!avatarName.trim() || !selectedClass.trim())) {
            alert('영웅 아바타 검색시 직업과 아바타 이름을 모두 입력해주세요.');
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const res = await fetch('https://lostark-proxy.jinsun264.workers.dev', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    Sort: 'GRADE',
                    SortCondition: 'ASC',
                    CategoryCode: Number(selectedCategory),
                    CharacterClass: selectedClass,
                    ItemName: avatarName.trim() !== '' ? avatarName : (allowSearchWithoutName ? '' : avatarName),
                    ItemGrade: selectedGrade === '전체' ? null : selectedGrade,
                    grade: selectedGrade === '전체' ? null : selectedGrade,
                }),
            });

            if (!res.ok) throw new Error('API 호출 실패');

            const data = await res.json();
            const groupByName = {};
            for (const item of data.items) {
                const group = item.itemGroup || item.name;
                const remain = item.tradeLeft === 0 ? '거래불가'
                    : item.tradeLeft === '정보 없음' ? '정보 없음'
                        : `${item.tradeLeft}회`;
                const grade = item.grade;
                const icon = item.icon;

                if (!groupByName[group]) {
                    groupByName[group] = { grade, items: {}, icon, displayName: item.name };
                }

                const current = groupByName[group].items[remain] ?? Infinity;
                if (item.minPrice && item.minPrice < current) {
                    groupByName[group].items[remain] = item.minPrice;
                }
            }

            // 📌 그룹별 minTotal 계산
            let minKey = null;
            let minValue = Infinity;
            for (const [key, info] of Object.entries(groupByName)) {
                const peons = info.grade?.includes('전설') ? 30 : info.grade?.includes('영웅') ? 10 : 0;
                const peonCost = calculatePeonCost(peons);
                const totalList = Object.entries(info.items).map(([label, price]) => {
                    const needsPeon = label !== '3회';
                    return price + (needsPeon && peons > 0 ? peonCost : 0);
                });
                const groupMin = Math.min(...totalList);
                info.minTotal = groupMin;
                if (groupMin < minValue) {
                    minValue = groupMin;
                    minKey = key;
                }
            }

            setGroupedPrices(groupByName);
            setCheapestGroupSnapshot(minKey); // ✅ 저장
            setHasFetched(true);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const classList = [
        '디스트로이어', '워로드', '버서커', '홀리나이트', '슬레이어', '발키리',
        '배틀마스터', '인파이터', '기공사', '창술사', '스트라이커', '브레이커',
        '데빌헌터', '블래스터', '호크아이', '스카우터', '건슬링어',
        '바드', '서머너', '아르카나', '소서리스',
        '블레이드', '데모닉', '리퍼', '소울이터',
        '도화가', '기상술사', '환수사'
    ];

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            fetchPrices();
        }
    };

    const showCheapestHighlight =
        hasFetched &&
        selectedGrade === '전설' &&
        selectedCategory !== '20000' &&
        avatarName.trim() === '';

    const cheapestGroupKey = showCheapestHighlight
        ? Object.entries(groupedPrices).reduce((minKey, [key, info]) => {
            const peons = info.grade?.includes('전설') ? 30 : info.grade?.includes('영웅') ? 10 : 0;
            const peonCost = calculatePeonCost(peons);

            // 🔽 이 그룹 내에서 가장 싼 total 가격
            const minTotalInGroup = Object.entries(info.items).reduce((min, [label, price]) => {
                const needsPeon = label !== '3회';
                const total = price + (needsPeon && peons > 0 ? peonCost : 0);
                return Math.min(min, total);
            }, Infinity);

            info.minTotal = minTotalInGroup; // 전체 비교용

            if (!minKey) return key;
            return minTotalInGroup < groupedPrices[minKey].minTotal ? key : minKey;
        }, null)
        : null;

    console.log('✅ 그룹별 최소 total 비교용 minTotal:');
    Object.entries(groupedPrices).forEach(([key, info]) => {
        console.log(`- ${key}: ${info.minTotal?.toLocaleString()}G (${info.displayName})`);
    });
    console.log('🏆 가장 저렴한 그룹:', cheapestGroupKey);


    return (
        <div className='avatar'>
            <div className='wrapper'>
                <div className='avatar-comparison'>
                    <h1 className='title'>아바타 가격 비교 계산기</h1>
                    <div className='avatar-row'>
                        <label><span className='label'>블루크리스탈 100개당 골드 (직접 입력해주세요)</span>
                            <div className='label-form'>
                                <input
                                    type='number'
                                    value={goldPer100Crystal}
                                    onChange={(e) => setGoldPer100Crystal(Number(e.target.value))}
                                />
                            </div>
                        </label>
                        <div>
                            ※ 수수료 5% 반영 (실수령 95개 기준) <br />
                            전설 아바타는 페온 30개 묶음 기준 (270 크리스탈)<br />
                            영웅 아바타는 페온 10개 낱개 기준 (100 크리스탈) 로 계산됩니다.
                        </div>
                    </div>
                    <div className='avatar-row'>
                        <label><span className='label'>클래스 선택</span>
                            <div className='label-form'>
                                <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                                    <option value=''>-- 클래스 선택 --</option>
                                    {classList.map((cls) => (
                                        <option key={cls} value={cls}>{cls}</option>
                                    ))}
                                </select>
                            </div>
                        </label>
                        <label><span className='label'>등급 선택</span>
                            <div className='label-form'>
                                <select value={selectedGrade} onChange={(e) => setSelectedGrade(e.target.value)}>
                                    <option value='전체'>전체</option>
                                    <option value='전설'>전설</option>
                                    <option value='영웅'>영웅</option>
                                </select>
                            </div>
                        </label>
                        <label style={{paddingBottom: 0}}><span className='label'>구분 선택</span>
                            <div className='label-form'>
                                <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}>
                                    <option value='20000'>전체</option>
                                    <option value='20005'>무기</option>
                                    <option value='20010'>머리</option>
                                    <option value='20050'>상의</option>
                                    <option value='20060'>하의</option>
                                </select>
                            </div>
                        </label>
                    </div>
                    <div className="avatar-row" style={{marginBottom: 0, borderBottom: 0}}>
                        <div className='search-info'>
                            <div>
                                <strong className='grade-info heroic'>영웅 아바타</strong>
                                <div className='info-box'>
                                    <p>→ 아바타 이름을 반드시 입력해야 검색할 수 있어요.</p>
                                </div>
                            </div>
                            <div>
                                <strong className='grade-info legend'>전설 아바타</strong>
                                <div className='info-box'>
                                    <p>구분이 <span style={{color: '#c00'}}>‘전체’</span>인 경우</p>
                                    <p>→ 아바타 이름을 반드시 입력해야 검색할 수 있어요.</p>
                                </div>
                                <div className='info-box'>
                                    <p>구분이  <span style={{color: '#c00'}}>‘무기 / 머리 / 상의 / 하의’</span> 중 하나인 경우</p>
                                    <p>→ 아바타 이름 없이도 검색 가능하며, 해당 구분 내에서 가장 저렴한 아바타가 표시됩니다.(전설 아바타를 가장 저렴하게 구매하고 싶을 때 사용해 보세요.)</p>
                                </div>
                            </div>
                        </div>
                        <label><span className='label'>아바타 이름</span>
                            <div className='label-form'>
                                <input
                                    type='text'
                                    value={avatarName}
                                    onChange={(e) => setAvatarName(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                />
                            </div>
                        </label>
                    </div>
                    <button className='btn-mint' onClick={fetchPrices} disabled={loading}>
                        <span>{loading ? '불러오는 중...' : '시세 조회'}</span>
                    </button>
                </div>
                <div className='comparison-result'>
                    {error && <p>⚠️ {error}</p>}
                    {!loading && (
                        <>
                            {Object.keys(groupedPrices).length > 0 ? (
                                Object.entries(groupedPrices).map(([groupKey, info]) => {
                                    const { grade, items, icon, displayName } = info;
                                    const name = displayName;
                                    const p3 = items['3회'] || 0;
                                    const p2 = items['2회'] || 0;
                                    const p1 = items['1회'] || 0;
                                    const p0 = items['거래불가'] || 0;
                                    const peons = grade?.toLowerCase().includes('전설') ? 30 : grade?.toLowerCase().includes('영웅') ? 10 : 0;
                                    const peonCost = calculatePeonCost(peons);

                                    const totalList = [
                                        p3 > 0 ? p3 : null,
                                        p2 > 0 ? p2 + (peons > 0 ? peonCost : 0) : null,
                                        p1 > 0 ? p1 + (peons > 0 ? peonCost : 0) : null,
                                        p0 > 0 ? p0 + (peons > 0 ? peonCost : 0) : null
                                    ].filter(val => val !== null);

                                    const minValue = Math.min(...totalList);

                                    const getDiffLabel = (value) => {
                                        if (totalList.length <= 1) return '';
                                        if (value === minValue) return (
                                            <span className='badge row-price'>
                                                <CircleCheckBig size={16} style={{ verticalAlign: 'text-top' }} /> 최저가
                                            </span>
                                        );
                                        const diff = value - minValue;
                                        return (
                                            <span className='badge'>
                                                최저가보다 {Math.round(diff).toLocaleString()}<span className='gold'>골드</span> 비쌈
                                            </span>
                                        );
                                    };

                                    return (
                                        <div className='price-result' key={groupKey}>
                                            <img className='avatar-thumb' src={icon} alt={name} />
                                            <div className='avatar-info'>
                                                <div className='name'>
                                                    <span>
                                                        <strong>{name}</strong>
                                                        {hasFetched && cheapestGroupSnapshot === groupKey && (
                                                            <span className='badge best-of-all'><ThumbsUp size={16} style={{ verticalAlign: 'text-top' }} /> 제일 싸요!</span>
                                                        )}
                                                    </span>
                                                    {peons > 0 && (
                                                        <p className={`grade ${grade?.includes('전설') ? 'legend' : grade?.includes('영웅') ? 'heroic' : ''}`}>
                                                            {grade} 아바타
                                                        </p>
                                                    )}
                                                </div>
                                                <ul>
                                                    {[{ label: '3회', price: p3 }, { label: '2회', price: p2 }, { label: '1회', price: p1 }, { label: '거래불가', price: p0 }]
                                                        .filter(({ price }) => price > 0)
                                                        .map(({ label, price }) => {
                                                            const isPeonNeeded = label !== '3회' && peons > 0;
                                                            const total = price + (isPeonNeeded ? peonCost : 0);
                                                            return (
                                                                <li key={label}>
                                                                    <p className='left'>
                                                                        구매 시 거래{' '}
                                                                        {label === '거래불가' ? (
                                                                            <strong>불가</strong>
                                                                        ) : (
                                                                            <>
                                                                                <strong>{label}</strong> 가능
                                                                            </>
                                                                        )}
                                                                    </p>
                                                                    <p>
                                                                        <span className='price-summary'>
                                                                            <strong className={total === minValue ? 'best' : ''}>
                                                                                {Math.round(total).toLocaleString()}
                                                                                <span className='gold'>골드</span>
                                                                            </strong>
                                                                            <span className='price-calcul'>
                                                                                ({price.toLocaleString()}<span className='gold'>골드</span>
                                                                                {isPeonNeeded && (
                                                                                    <>
                                                                                        {' + '}
                                                                                        {Math.round(peonCost).toLocaleString()}
                                                                                        <span className='gold'>골드</span>
                                                                                        {' ('}{peons}<span className='peon'>페온</span>)
                                                                                    </>
                                                                                )}) &nbsp;
                                                                            </span>
                                                                        </span>
                                                                        {getDiffLabel(total)}
                                                                    </p>
                                                                </li>
                                                            );
                                                        })}
                                                    {items['정보 없음'] && (
                                                        <li><p className='left'>아바타 상자</p><p>{items['정보 없음'].toLocaleString()}<span className='gold'>골드</span></p></li>
                                                    )}
                                                </ul>
                                            </div>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className='empty-result'>
                                    거래소 검색 결과가 보여집니다.
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AvatarComparisonAuto;
