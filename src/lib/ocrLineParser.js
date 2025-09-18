// src/lib/ocrLineParser.js

/** 라벨 6종 → 내부 키 */
const LABEL_MAP = new Map([
  ["공격력", "atk"],
  ["추가피해", "add"],
  ["보스피해", "boss"],
  ["아군공격강화", "allyAtk"],
  ["아군피해강화", "allyDmg"],
  ["낙인력", "brand"],
]);

/* ── 유틸 ─────────────────────────────────────────────────────────────── */

const norm = (s) => String(s ?? "").trim();

const collapseKo = (s) =>
  norm(s)
    .replace(/\s+/g, "")
    .replace(/[·.\-_/,:;'"`~!@#$%^&*()[\]{}<>|\\]/g, "");

const toHalfWidth = (s) =>
  String(s ?? "").replace(/[\uFF10-\uFF19]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );

const normalizeAscii = (s) =>
  norm(s)
    .replaceAll("I", "1")
    .replaceAll("l", "1")
    .replaceAll("i", "1")
    .replaceAll("S", "5")
    .replaceAll("B", "8")
    .replaceAll("O", "0");

/** 아이콘/잡문자 토큰 필터 */
function isIconLike(text) {
  const t = norm(text);
  if (!t) return true;
  // 길이 1~2이고 한글/영문/숫자 전혀 없으면 아이콘 취급
  if (t.length <= 2 && !/[A-Za-z0-9가-힣]/.test(t)) return true;
  // 전부 기호
  if (/^[\s·.\-_/,:;'"`~!@#$%^&*()[\]{}<>|\\]+$/.test(t)) return true;
  // 원 문자/화살표/기타 심볼 블록
  if (/[\u2460-\u24FF\u2600-\u27BF]/.test(t) && !/[A-Za-z0-9가-힣]/.test(t)) return true;
  return false;
}

/** 숫자(1자리) */
function tryOneDigitNumber(text) {
  const t = toHalfWidth(normalizeAscii(text));
  // 토큰 안의 첫 1~9를 허용(괄호/점에 붙어도 OK)
  const m = t.match(/([1-9])(?!\d)/);
  return m ? { num: Number(m[1]), raw: text } : null;
}

/** Lv. n */
function tryLevelToken(text) {
  const t = toHalfWidth(normalizeAscii(text))
    .toLowerCase()
    .replace(/\bly\b/g, "lv")
    .replace(/\bl[1i]\b/g, "lv");
  const m = t.replace(/\s+/g, "").match(/\blv\.?([1-9])\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 9 ? { lv: n, raw: text } : null;
}

/** 라벨 */
function tryLabelToken(text) {
  const c = collapseKo(text);
  return LABEL_MAP.has(c) ? { key: LABEL_MAP.get(c), raw: text } : null;
}

/* ── 줄(라인) 묶기 ───────────────────────────────────────────────────── */

export function groupWordsToLines(words, { yMergeFactor = 0.6 } = {}) {
  if (!Array.isArray(words) || words.length === 0) return [];

  const enriched = words
    .filter((w) => w?.text && w?.bbox)
    .map((w) => {
      const { x, y, w: bw, h: bh } = w.bbox;
      return { ...w, _cx: x + bw / 2, _cy: y + bh / 2, _h: bh };
    })
    .sort((a, b) => a._cy - b._cy || a._cx - b._cx);

  const hs = enriched.map((w) => w._h).sort((a, b) => a - b);
  const medianH = hs[Math.floor(hs.length / 2)] || 16;
  const yThresh = Math.max(4, medianH * yMergeFactor);

  const lines = [];
  let cur = [];
  let lastCy = null;

  for (const w of enriched) {
    if (lastCy == null || Math.abs(w._cy - lastCy) <= yThresh) {
      cur.push(w);
      lastCy = lastCy == null ? w._cy : lastCy * 0.6 + w._cy * 0.4;
    } else {
      lines.push(cur.sort((a, b) => a.bbox.x - b.bbox.x));
      cur = [w];
      lastCy = w._cy;
    }
  }
  if (cur.length) lines.push(cur.sort((a, b) => a.bbox.x - b.bbox.x));
  return lines;
}

/* ── 파싱: 숫자(필수) + (아이콘 무시) + 라벨 + Lv.n ─────────────────── */

export function parseNumberLabelLvLine(lineWords) {
  if (!Array.isArray(lineWords) || lineWords.length < 3) return null;

  // 0) 아이콘 제거
  const clean = lineWords.filter((w) => !isIconLike(w.text));
  if (clean.length < 3) return null;

  // 1) 가장 왼쪽에서 "숫자 1자리"를 찾는다 (필수)
  let nIdx = -1;
  let nTok = null;
  for (let i = 0; i < Math.min(4, clean.length); i++) {
    const t = tryOneDigitNumber(clean[i].text);
    if (t) {
      nTok = t;
      nIdx = i;
      break;
    }
  }
  if (!nTok) return null;

  // 2) 가장 오른쪽에서 Lv 토큰을 찾는다 (필수)
  let lvIdx = -1;
  let lvTok = null;
  for (let i = clean.length - 1; i > nIdx; i--) {
    const t = tryLevelToken(clean[i].text);
    if (t) {
      lvTok = t;
      lvIdx = i;
      break;
    }
  }
  if (!lvTok || lvIdx <= nIdx) return null;

  // 3) 숫자~Lv 사이에서 라벨 만들기(한글/키워드만 골라 결합)
  const mid = clean.slice(nIdx + 1, lvIdx);
  if (mid.length === 0) return null;

  const labelSrc = mid
    .filter((w) => /[가-힣]/.test(w.text) || /(공격|피해|강화|낙인)/.test(w.text))
    .map((w) => w.text)
    .join(" ");
  const labelTok = tryLabelToken(labelSrc);
  if (!labelTok) return null;

  // 4) bbox/conf
  const keep = clean.slice(nIdx, lvIdx + 1);
  const xs = keep.map((w) => w.bbox.x);
  const ys = keep.map((w) => w.bbox.y);
  const xe = keep.map((w) => w.bbox.x + w.bbox.w);
  const ye = keep.map((w) => w.bbox.y + w.bbox.h);
  const bbox = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xe) - Math.min(...xs),
    h: Math.max(...ye) - Math.min(...ys),
  };
  const confAvg = keep.reduce((s, w) => s + (w.conf ?? 0), 0) / keep.length;

  return {
    ok: true,
    will: nTok.num,           // 숫자 1자리 (필수)
    labelKey: labelTok.key,   // atk/add/boss/allyAtk/allyDmg/brand
    level: lvTok.lv,          // 1~9
    tokens: keep.map((w) => ({ text: w.text, bbox: w.bbox, conf: w.conf })),
    bbox,
    confAvg,
  };
}

/** words 전체에서 “숫자 + 라벨 + Lv.n” 줄만 추출 */
export function extractNumberLabelLvFromWords(words) {
  const lines = groupWordsToLines(words);
  const out = [];
  for (const line of lines) {
    const parsed = parseNumberLabelLvLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

const api = {
  groupWordsToLines,
  parseNumberLabelLvLine,
  extractNumberLabelLvFromWords,
};

export default api;
