// src/lib/ocrRescueFromRaw.js

// 표준 라벨 매핑
const LABEL_MAP = new Map([
  ["공격력", "atk"],
  ["추가피해", "add"],
  ["보스피해", "boss"],
  ["아군공격강화", "allyAtk"],
  ["아군피해강화", "allyDmg"],
  ["낙인력", "brand"],
]);

// 디버깅/퍼지 비교용 표준 라벨 원형
const CANON_LABELS = {
  atk: "공격력",
  add: "추가피해",
  boss: "보스피해",
  allyAtk: "아군공격강화",
  allyDmg: "아군피해강화",
  brand: "낙인력",
};

// ─────────── 문자열 유틸 ───────────
const norm = (s) => String(s ?? "").trim();
const toHalf = (s) =>
  norm(s).replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );

const normalizeAscii = (s) =>
  toHalf(s)
    .replaceAll("I", "1")
    .replaceAll("l", "1")
    .replaceAll("i", "1")
    .replaceAll("S", "5")
    .replaceAll("B", "8")
    .replaceAll("O", "0");

// 공백/구분자 제거(한글 라벨 비교 전용)
const collapseKo = (s) =>
  norm(s)
    .replace(/\s+/g, "")
    .replace(/[·.\-_/()[\]|\\,:;'"`~!?]/g, "");

// ─────────── 라벨 문자열 보정 ───────────
function fixKoLabel(raw) {
  let t = norm(raw);

  // 양끝의 괄호류 제거
  t = t.replace(/^[[(]+/, "").replace(/[\])]+$/, "");

  // '군' → '아군' (선행어 없는 군을 보정)
  t = t.replace(/(^|\s)군(?=\s*(공격|피해))/g, "$1아군");

  // 스페이싱 표준화
  t = t.replace(/공격\s*강화/g, "공격 강화");
  t = t.replace(/피해\s*강화/g, "피해 강화");
  t = t.replace(/추가\s*피해/g, "추가 피해");
  t = t.replace(/보스\s*피해/g, "보스 피해");
  t = t.replace(/공격\s*력/g, "공격력");

  // '낙인력' 깨짐 빠른 보정 (낙민력/낙임력/낙인려/낚인력/…)
  const c0 = collapseKo(t);
  if (
    /낙[민인]력/.test(c0) ||
    /낙.?인.?력/.test(c0) ||
    /낚인력/.test(c0) ||
    (c0.includes("인력") && !c0.includes("공격력"))
  ) {
    t = "낙인력";
  }

  return t;
}

// ─────────── 레벤슈타인 거리(간단) ───────────
function lev(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // 삭제
        dp[i][j - 1] + 1, // 삽입
        dp[i - 1][j - 1] + cost // 치환
      );
    }
  }
  return dp[n][m];
}

// ─────────── 라벨 퍼지 매칭 ───────────
function fuzzyLabelKey(collapsed) {
  // 0) 정확 일치
  if (LABEL_MAP.has(collapsed)) return LABEL_MAP.get(collapsed);

  // 1) 부분 포함
  for (const [k, v] of LABEL_MAP.entries()) {
    if (collapsed.includes(k)) return v;
  }

  // 2) '강화'가 빠진 경우도 허용
  if (collapsed.includes("아군피해")) return "allyDmg";
  if (collapsed.includes("아군공격")) return "allyAtk";

  // 3) 낙인력 변형 정규식
  if (/^낙[민인][려력]?$/.test(collapsed)) return "brand";

  // 4) 레벤슈타인 거리로 퍼지 (편집거리 ≤ 2)
  const candidates = Object.entries(CANON_LABELS).map(([key, canon]) => [
    key,
    collapseKo(canon),
  ]);

  let best = null;
  for (const [key, canonC] of candidates) {
    const d = lev(collapsed, canonC);
    if (d <= 2 && (!best || d < best.d)) best = { key, d };
  }
  return best ? best.key : null;
}

// ─────────── 레벨 추론 (Lv 표식이 없어도 동작) ───────────
function inferLevelFromTail(line) {
  // 끝자리 한 자리 숫자(1~9)를 레벨로 사용.
  // 중간의 '2%' 같은 숫자는 무시하고, 맨 끝만 본다.
  const m = String(line).match(/([1-9])\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 9 ? n : null;
}

function stripTailGarbageBeforeLevel(line) {
  // 맨 끝 레벨 직전의 쓰레기 토큰(예: '1.', '[\.', '#.', '14.' 등)을 제거
  // 예) "공격력 1*. 4" → "공격력"
  //     "보스 피해 14. 3" → "보스 피해"
  let s = norm(line);
  // 레벨 숫자 제거 전, 숫자 앞의 잡음 토큰 제거 (문자클래스 대신 명시적 분기)
  s = s.replace(
    /(14\.|1(?:#|\*|\[).?|(?:#|\*|\[|\]|\\)\.?|(?:#|\*|\[)\.?)\s*([1-9])\s*$/i,
    "$2"
  );
  // 이제 맨 끝 숫자까지 잘라내고 앞부분만 라벨로 사용
  const m = s.match(/([1-9])\s*$/);
  if (!m) return s;
  return s.slice(0, m.index).trim();
}

// ─────────── 오른쪽(라벨+레벨) 라인 파싱 ───────────
function parseRightLines(rawRight) {
  const lines = String(rawRight || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    const lv = inferLevelFromTail(line);
    if (!lv) continue;

    const labelPart = fixKoLabel(stripTailGarbageBeforeLevel(line));
    const c = collapseKo(labelPart);
    const key = fuzzyLabelKey(c);
    if (!key) continue;

    out.push({ labelKey: key, level: lv, rawRight: line });
  }
  return out;
}

// ─────────── 왼쪽(숫자) 라인 파싱 ───────────
function parseLeftNumbers(rawLeft) {
  const lines = String(rawLeft || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const nums = [];
  for (const line of lines) {
    // 0) iE/lE/IE (전각/공백 포함 변형) → 5로 선보정
    const raw = line.trim();
    const koHalf = toHalf(raw).replace(/\s+/g, "");
    if (/^[ilI][eE]$/.test(koHalf)) {
      nums.push({ will: 5, rawLeft: line });
      continue;
    }
    // 1) 일반 숫자 매칭 (i, l, I → 1 등 ASCII 보정 적용)
    const t = normalizeAscii(line);
    const m = t.match(/[1-9]/);
    if (m) {
      nums.push({ will: Number(m[0]), rawLeft: line });
      continue;
    }
    // 2) 한글 오인식: '는' → 5
    if (raw === "는") {
      nums.push({ will: 5, rawLeft: line });
      continue;
    }
  }
  return nums;
}

// ─────────── 최종 페어링 ───────────
export default function parseFromRaw(leftRaw, rightRaw) {
  const rights = parseRightLines(rightRaw);
  const lefts = parseLeftNumbers(leftRaw);
  const n = Math.min(lefts.length, rights.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      will: lefts[i].will,
      labelKey: rights[i].labelKey,
      level: rights[i].level,
      rawLeft: lefts[i].rawLeft,
      rawRight: rights[i].rawRight,
    });
  }

  // 개수 안 맞으면 어떤 줄이 빠졌는지 로그 (디버깅용)
  if (lefts.length !== rights.length) {
    console.groupCollapsed(
      `%c[Gem OCR] pairing diff left=${lefts.length} right=${rights.length}`,
      "color:#ef4444"
    );
    const maxN = Math.max(lefts.length, rights.length);
    for (let i = 0; i < maxN; i++) {
      console.log(`#${String(i + 1).padStart(2, "0")}`, {
        left: lefts[i]?.rawLeft ?? "(missing)",
        right: rights[i]?.rawRight ?? "(missing)",
      });
    }
    console.groupEnd();
  }

  return out;
}
