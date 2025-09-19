/* eslint-disable no-restricted-globals */
import Tesseract from "tesseract.js";

/* ───────────────── helpers ───────────────── */

const send = (type, payload) => {
  if (type === "error" && payload instanceof Error) {
    postMessage({
      type,
      payload: {
        code: payload.code || "UNKNOWN",
        message: payload.message,
        stack: payload.stack,
      },
    });
  } else {
    postMessage({ type, payload });
  }
};

async function blobFromBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  return await canvas.convertToBlob({ type: "image/png", quality: 0.95 });
}

async function cropBitmap(bitmap, sx, sy, sw, sh) {
  const W = Math.max(1, Math.round(sw));
  const H = Math.max(1, Math.round(sh));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, W, H);
  const blob = await canvas.convertToBlob({ type: "image/png", quality: 0.95 });
  const url = URL.createObjectURL(blob);
  return { blob, url, W, H, canvas, ctx };
}

async function cropToObject(srcBlobOrBitmap, rect) {
  const srcBitmap =
    srcBlobOrBitmap instanceof ImageBitmap
      ? srcBlobOrBitmap
      : await createImageBitmap(srcBlobOrBitmap);
  const { x, y, w, h } = rect;
  return await cropBitmap(srcBitmap, x, y, w, h);
}

/* ─────────── preprocess (×2 업스케일 + soft bin + optional Levels) ─────────── */
async function preprocessToBitmap(
  bitmap,
  {
    invert = true,
    boostWhiteByS = false, // ← 왼쪽(흰 글자)에서만 켜기
    // HSV기반(이전과 동일하게 유지하고 싶다면 사용, S=0만 쓰려면 호출쪽에서 satThresh=0으로)
    satThresh = 0.18,      // 채도 임계 (0~1)
    vThresh = 0.80,        // 밝기 임계 (0~1)

    softness = 50,
    up = 2,

    // ✅ 추가: Photoshop Levels 옵션
    // 예) { inBlack: 50, gamma: 0.75, inWhite: 220, outBlack: 0, outWhite: 255 }
    levels = null,
    // ✅ 추가: 배경색 눌러주기 옵션
    // 숫자(흰색/저채도·고밝기)를 건드리지 않으면서,
    // 배경과 ‘색이 비슷한’ 픽셀을 업프론트에서 검정(0)으로 밀어버린 뒤,
    // 나중에 invert=true면 배경이 최대한 하얗게 됩니다.
    bgSuppress = {
      enabled: false,
      // 자동 샘플링(ROI 전체에서 배경 후보 픽셀만 평균)
      // 숫자 후보(저채도·고밝기)는 샘플에서 제외
      satMin: 0.12,   // 배경 샘플링에 포함할 최소 채도
      vMax: 0.92,     // 배경 샘플링에 포함할 최대 명도
      dist: 38,       // 배경색과의 RGB 거리 임계(0~441) – ↑이면 배경으로 간주 폭이 넓어짐
      smooth: 0,      // >0이면 부드럽게 밀어주기(0=하드 클램핑)
      sampleRect: null // {x,y,w,h} 지정 시 그 영역만으로 배경색 추정
    },
  } = {}
) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = new OffscreenCanvas(W * up, H * up);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, W, H, 0, 0, canvas.width, canvas.height);

  // (A0) ✅ Levels(포토샵) 적용: 업스케일 직후 RGB 단계에서 선적용
  if (levels && Number.isFinite(levels.inBlack) && Number.isFinite(levels.inWhite) && Number.isFinite(levels.gamma)) {
    const inB = Math.max(0, Math.min(255, levels.inBlack | 0));
    const inW = Math.max(0, Math.min(255, levels.inWhite | 0));
    const g   = Math.max(0.01, levels.gamma);
    const outB = Number.isFinite(levels.outBlack) ? Math.max(0, Math.min(255, levels.outBlack | 0)) : 0;
    const outW = Number.isFinite(levels.outWhite) ? Math.max(0, Math.min(255, levels.outWhite | 0)) : 255;
    const rng  = Math.max(1, inW - inB);

    const srcLv = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sd = srcLv.data;
    for (let i = 0; i < sd.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const c = sd[i + k];
        let x = (c - inB) / rng;
        x = Math.max(0, Math.min(1, x));
        x = Math.pow(x, 1 / g);
        sd[i + k] = (outB + x * (outW - outB)) | 0;
      }
      sd[i + 3] = 255;
    }
    ctx.putImageData(srcLv, 0, 0);
  }

  // (A1) ✅ 배경색 자동 추정 & 배경 눌러주기 (RGB 단계에서 선적용)
  if (bgSuppress?.enabled) {
    const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sd = src.data;

    // RGB→HSV (0~1)
    const rgb2hsv = (r, g, b) => {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
      const diff = max - min;
      let h = 0;
      if (diff !== 0) {
        if (max === rn) h = ((gn - bn) / diff) % 6;
        else if (max === gn) h = (bn - rn) / diff + 2;
        else h = (rn - gn) / diff + 4;
        h /= 6; if (h < 0) h += 1;
      }
      const s = max === 0 ? 0 : diff / max;
      const v = max;
      return [h, s, v];
    };

    // 1) 배경색 샘플링 (자동/영역)
    const rx = bgSuppress.sampleRect?.x ?? 0;
    const ry = bgSuppress.sampleRect?.y ?? 0;
    const rw = bgSuppress.sampleRect?.w ?? canvas.width;
    const rh = bgSuppress.sampleRect?.h ?? canvas.height;
    let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
    const sMin = Math.max(0, Math.min(1, bgSuppress.satMin ?? 0.12));
    const vMax = Math.max(0, Math.min(1, bgSuppress.vMax ?? 0.92));

    for (let y = ry; y < ry + rh; y += 2) {           // 2픽셀 스텝으로 다운샘플링
      for (let x = rx; x < rx + rw; x += 2) {
        const i = (y * canvas.width + x) * 4;
        const r = sd[i], g = sd[i + 1], b = sd[i + 2];
        const [, s, v] = rgb2hsv(r, g, b);
        // 숫자(흰색) 후보는 제외하고 배경만 모음
        if (s >= sMin && v <= vMax) {
          sumR += r; sumG += g; sumB += b; cnt++;
        }
      }
    }
    const bgR = cnt ? (sumR / cnt) : 0;
    const bgG = cnt ? (sumG / cnt) : 0;
    const bgB = cnt ? (sumB / cnt) : 0;

    // 2) 배경과 가까운 픽셀을 검정으로 눌러주기
    const distThr = Math.max(0, Math.min(441, bgSuppress.dist ?? 38)); // √(255^2*3)=441
    const smooth = Math.max(0, bgSuppress.smooth ?? 0);

    // 약간 그린 가중을 주는 거리(배경이 갈색·황색 계열일 때 경계가 잘 섭니다)
    const dist = (r, g, b) => {
      const dr = r - bgR, dg = g - bgG, db = b - bgB;
      return Math.sqrt((dr * 0.9) ** 2 + (dg * 1.1) ** 2 + (db * 1.0) ** 2);
    };

    for (let i = 0; i < sd.length; i += 4) {
      const r = sd[i], g = sd[i + 1], b = sd[i + 2];
      const d = dist(r, g, b);
      if (smooth <= 0) {
        if (d <= distThr) { sd[i] = sd[i + 1] = sd[i + 2] = 0; } // 하드 클램핑
      } else {
        // 부드럽게 눌러주기: d<=thr면 0, thr~thr+smooth 사이는 선형 보간
        const t = d <= distThr ? 0
                : d >= distThr + smooth ? 1
                : (d - distThr) / smooth;
        const k = 1 - t; // 배경에 가까울수록 더 검정으로
        if (k > 0) {
          sd[i]   = Math.round(r * (1 - k));
          sd[i+1] = Math.round(g * (1 - k));
          sd[i+2] = Math.round(b * (1 - k));
        }
      }
      sd[i + 3] = 255;
    }
    ctx.putImageData(src, 0, 0);
  }

  // ── (A) 흰 글자 마스크를 원본 RGB(또는 Levels 후) 기준으로 선계산(옵션)
  let whiteMask = null;
  if (boostWhiteByS) {
    const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sd = src.data;
    whiteMask = new Uint8Array(canvas.width * canvas.height);

    // RGB→HSV (0~1)
    const rgb2hsv = (r, g, b) => {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
      const diff = max - min;
      let h = 0;
      if (diff !== 0) {
        if (max === rn) h = ((gn - bn) / diff) % 6;
        else if (max === gn) h = (bn - rn) / diff + 2;
        else h = (rn - gn) / diff + 4;
        h /= 6; if (h < 0) h += 1;
      }
      const s = max === 0 ? 0 : diff / max;
      const v = max;
      return [h, s, v];
    };

    for (let i = 0, px = 0; i < sd.length; i += 4, px++) {
      const r = sd[i], g = sd[i + 1], b = sd[i + 2];
      const [, s, v] = rgb2hsv(r, g, b);
      // 저채도(흰) + 고밝기만 표시
      whiteMask[px] = (s <= satThresh && v >= vThresh) ? 1 : 0;
    }
  }

  // ── (B) 그레이 + (옵션) 반전
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const gr = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gr;
  }
  if (invert) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    }
  }

  // ── (C) Otsu (soft)
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i] | 0]++;
  const total = canvas.width * canvas.height;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, varMax = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > varMax) { varMax = between; thr = t; }
  }

  for (let i = 0; i < d.length; i += 4) {
    const diff = d[i] - thr;
    const v =
      Math.abs(diff) >= softness
        ? (diff > 0 ? 255 : 0)
        : Math.round(((diff + softness) / (2 * softness)) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }

  // ── (D) 저채도(흰 글자)만 더 선명하게 밀어주기 (옵션)
  if (boostWhiteByS && whiteMask) {
    const boostTo = invert ? 0 : 255; // 반전했으면 검정으로 고정
    for (let px = 0, i = 0; px < whiteMask.length; px++, i += 4) {
      if (whiteMask[px]) {
        d[i] = d[i + 1] = d[i + 2] = boostTo;
        d[i + 3] = 255;
      }
    }
  }

  ctx.putImageData(img, 0, 0);

  const binBlob = await canvas.convertToBlob({ type: "image/png", quality: 1 });
  return await createImageBitmap(binBlob);
}



/* ─────────── OCR(words) ─────────── */
async function ocrWords(url, lang, label, onProgress, { psm = 7, whitelist = "" } = {}) {
  const opts = {
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "1",
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        onProgress?.(`${label}…`, false, Math.round(m.progress * 100));
      }
    },
  };
  if (whitelist) opts.tessedit_char_whitelist = whitelist;

  const { data } = await Tesseract.recognize(url, lang, opts);

  const words = [];
  const pushWord = (w) => {
    if (!w?.text || !w?.bbox) return;
    const text = String(w.text).trim();
    if (!text) return;
    const bbox = {
      x: w.bbox?.x0 ?? 0,
      y: w.bbox?.y0 ?? 0,
      w: (w.bbox?.x1 ?? 0) - (w.bbox?.x0 ?? 0),
      h: (w.bbox?.y1 ?? 0) - (w.bbox?.y0 ?? 0),
    };
    const conf = w.confidence ?? w.conf ?? null;
    words.push({ text, bbox, conf });
  };

  if (Array.isArray(data?.words)) {
    for (const w of data.words) pushWord(w);
  }

  return {
    words,
    rawText: data?.text || "",
  };
}

/* ─────────── merge utils ─────────── */
function shiftX(arr, dx) {
  return (arr || []).map((w) => ({
    text: w.text,
    bbox: { x: w.bbox.x + dx, y: w.bbox.y, w: w.bbox.w, h: w.bbox.h },
    conf: w.conf,
  }));
}

function iou(a, b) {
  const ax2 = a.x + a.w,
    ay2 = a.y + a.h;
  const bx2 = b.x + b.w,
    by2 = b.y + b.h;
  const x1 = Math.max(a.x, b.x),
    y1 = Math.max(a.y, b.y);
  const x2 = Math.min(ax2, bx2),
    y2 = Math.min(ay2, by2);
  const iw = Math.max(0, x2 - x1),
    ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

function dedupeWords(words, { iouThresh = 0.6 } = {}) {
  const out = [];
  for (const w of words || []) {
    if (!out.find((o) => o.text === w.text && iou(o.bbox, w.bbox) >= iouThresh)) {
      out.push(w);
    }
  }
  return out;
}

/* ─────────── 제외영역 마스킹 ─────────── */
async function maskExcludesOnRoi(roiCanvas, excludes = []) {
  if (!excludes?.length) return;
  const ctx = roiCanvas.getContext("2d", { alpha: false });
  ctx.save();
  ctx.fillStyle = "#000";
  excludes.forEach((r) => {
    if (!r) return;
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    const w = Math.max(1, Math.round(r.w));
    const h = Math.max(1, Math.round(r.h));
    ctx.fillRect(x, y, w, h);
  });
  ctx.restore();
}

/* ─────────── 좌/우 경계 계산: 제외영역 기반 ─────────── */
function computeBandsFromExcludes(W, H, excludes = []) {
  const valid = (excludes || []).filter((r) => r && r.w > 2 && r.h > 2);
  if (!valid.length) return null;

  const minX = Math.max(0, Math.min(...valid.map((r) => r.x)));
  const maxX = Math.min(W - 1, Math.max(...valid.map((r) => r.x + r.w)));

  // 오른쪽 밴드 시작은 아이콘 우측 + 소량 패딩
  const pad = Math.round(Math.max(4, Math.min(24, W * 0.01)));
  const rightX = Math.min(W - 1, Math.max(minX + 1, maxX + pad));

  // 왼쪽 폭은 minX까지, 최소 폭 보장
  const leftW = Math.max(20, Math.min(rightX - 1, minX));
  const rightW = Math.max(10, W - rightX);

  // gapX는 디버깅용
  return { leftW, rightX, rightW, gapX: rightX - leftW };
}

/* ─────────── 좌/우 밴드 OCR (각 1회) ─────────── */
async function ocrByBands(roiCanvas, lang, progress, excludes = []) {
  const W = roiCanvas.width, H = roiCanvas.height;
  const roiBitmap = await createImageBitmap(
    await roiCanvas.convertToBlob({ type: "image/png", quality: 0.95 })
  );

  // 1) 제외영역 기반 경계 시도 → 실패 시 비율 기반 폴백
  let bands = computeBandsFromExcludes(W, H, excludes);
  if (!bands) {
    const leftW = Math.max(20, Math.round(W * 0.22));
    const gapX  = Math.round(W * 0.06);
    const rightX = Math.min(W - 1, leftW + gapX);
    const rightW = Math.max(10, W - rightX);
    bands = { leftW, rightX, rightW, gapX, _fallback: true };
  }

  const { leftW, rightX, rightW } = bands;

  const { blob: leftBlob }  = await cropBitmap(roiBitmap, 0,      0, leftW,  H);
  const { blob: rightBlob } = await cropBitmap(roiBitmap, rightX, 0, rightW, H);

  const leftPre = await preprocessToBitmap(await createImageBitmap(leftBlob), {
    invert: true,
    boostWhiteByS: true,
    satThresh: 0,        // 채도=0만 잡고 싶으면 0
    vThresh: 1,
    softness: 80,
    levels: { inBlack: 30, gamma: 0.75, inWhite: 220, outBlack: 0, outWhite: 255 },
    // ✅ 배경 눌러주기: 숫자를 제외한 갈색/황갈 배경을 0으로 다운클램프
    bgSuppress: {
      enabled: true,
      satMin: 0.12,
      vMax: 1,       // 더 어두운 쪽까지 배경으로 간주
      dist: 200,         // 배경 판정 범위 확대
      smooth: 0,        // 하드 클램핑(가장 쨍하게 분리)
    }
  });

  const rightPre = await preprocessToBitmap(await createImageBitmap(rightBlob), { invert: true });

  const WL_NUM   = "0123456789"; // 0 포함
  const WL_LABEL = "0123456789.Lv공격력추가피해보스피해아군공격강화아군피해강화낙인력";

  const lUrl = URL.createObjectURL(await blobFromBitmap(leftPre));
  const rUrl = URL.createObjectURL(await blobFromBitmap(rightPre));

  let leftWords = [], rightWords = [], leftRaw = "", rightRaw = "";
  try {
    const l = await ocrWords(lUrl, lang, "왼쪽(숫자)", progress, { psm: 7, whitelist: WL_NUM });
    leftWords = l.words || []; leftRaw = l.rawText || "";

    // 오른쪽은 'kor'만
    const r = await ocrWords(rUrl, "kor", "오른쪽(라벨/Lv)", progress, { psm: 7, whitelist: WL_LABEL });
    rightWords = r.words || []; rightRaw = r.rawText || "";
  } finally {
    URL.revokeObjectURL(lUrl);
    URL.revokeObjectURL(rUrl);
  }

  const words = dedupeWords([
    ...leftWords,
    ...shiftX(dedupeWords(rightWords), rightX),
  ]);

  // 미리보기 PNG 버퍼
  const leftPreBuf  = await (await blobFromBitmap(leftPre)).arrayBuffer();
  const rightPreBuf = await (await blobFromBitmap(rightPre)).arrayBuffer();

  return {
    words,
    leftRaw,
    rightRaw,
    debug: { bands: { W, H, ...bands } }, // 경계/폴백 여부 확인
    previews: {
      leftPrePng: leftPreBuf,
      rightPrePng: rightPreBuf,
      leftSize:  { w: leftPre.width,  h: leftPre.height },
      rightSize: { w: rightPre.width, h: rightPre.height },
    },
  };
}

/* ─────────── entrypoint ─────────── */
self.onmessage = async (e) => {
  const { type, payload } = e.data || {};
  if (type !== "scan") return;

  const { buf, mime = "image/png", lang = "kor+eng", rect, excludes = [] } =
    payload || {};

  if (!buf) return send("error", { code: "NO_IMAGE", message: "no image buffer" });
  if (
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.w) ||
    !Number.isFinite(rect.h)
  ) {
    return send("error", { code: "NO_ROI", message: "manual ROI(rect) is required" });
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buf], { type: mime }));
  } catch (err) {
    return send("error", {
      code: "DECODE_FAIL",
      message: "이미지를 디코드할 수 없습니다.",
      detail: String(err),
    });
  }

  try {
    const W = bitmap.width, H = bitmap.height;
    const safe = {
      x: Math.max(0, Math.min(W - 1, Math.round(rect.x))),
      y: Math.max(0, Math.min(H - 1, Math.round(rect.y))),
      w: Math.max(1, Math.min(W, Math.round(rect.w))),
      h: Math.max(1, Math.min(H, Math.round(rect.h))),
    };

    // 원본 전체를 캔버스로 만들어 ROI 추출
    const srcBlob = await (async () => {
      const cnv = new OffscreenCanvas(W, H);
      const c = cnv.getContext("2d", { alpha: false });
      c.drawImage(bitmap, 0, 0);
      return await cnv.convertToBlob({ type: "image/png", quality: 0.95 });
    })();

    const roi = await cropToObject(srcBlob, safe);

    // ROI 좌표계로 변환된 제외영역
    const excludesRoi = (excludes || []).map((r) => ({
      x: r.x - safe.x,
      y: r.y - safe.y,
      w: r.w,
      h: r.h,
    }));

    // ROI 캔버스에 제외영역 마스킹 적용 (텍스트 제거)
    await maskExcludesOnRoi(roi.canvas, excludesRoi);

    const progress = (label, ind, pct) =>
      send("progress", { label, indeterminate: !!ind, pct: pct ?? 0 });

    // 제외영역을 밴드 분할 근거로 전달
    const band = await ocrByBands(roi.canvas, lang, progress, excludesRoi);

    // ROI(마스킹 적용) 캔버스 PNG 버퍼
    const roiPreBlob = await roi.canvas.convertToBlob({ type: "image/png", quality: 0.95 });
    const roiPreBuf = await roiPreBlob.arrayBuffer();

    // 원본 ROI(blob) 버퍼
    const roiArrayBuf = await roi.blob.arrayBuffer();

    const transferList = [
      roiArrayBuf,
      roiPreBuf,
      band?.previews?.leftPrePng,
      band?.previews?.rightPrePng,
    ].filter(Boolean);

    postMessage(
      {
        type: "done",
        payload: {
          ok: true,
          anchor: null,
          panel: { ...safe, by: "manual" },
          imageSize: { w: roi.W, h: roi.H },
          words: band.words,
          joinedWords: (band.words || []).map((w) => w.text).join(" "),
          rawLeft: band.leftRaw,
          rawRight: band.rightRaw,
          roiPng: roiArrayBuf,   // 원본 ROI(bitmap→blob→buf)
          roiPrePng: roiPreBuf,  // 마스킹 적용된 ROI 캔버스 덤프
          roiMime: "image/png",
          debug: band.debug,     // bands 경계/폴백 여부 포함
          previews: band.previews, // 좌/우 전처리 이미지 버퍼
        },
      },
      transferList
    );
  } catch (err) {
    send("error", {
      code: err?.code || "UNKNOWN",
      message: err?.message || String(err),
      stack: err?.stack,
    });
  } finally {
    try {
      bitmap.close?.();
    } catch {}
  }
};
