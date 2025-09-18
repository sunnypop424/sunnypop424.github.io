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

/* ─────────── preprocess (×2 업스케일 + soft bin) ─────────── */
async function preprocessToBitmap(bitmap, { invert = true } = {}) {
  const W = bitmap.width;
  const H = bitmap.height;
  const up = 2;

  const canvas = new OffscreenCanvas(W * up, H * up);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, W, H, 0, 0, canvas.width, canvas.height);

  // gray
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const gr = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gr;
  }
  // invert
  if (invert) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    }
  }

  // Otsu (soft)
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i] | 0]++;
  const total = canvas.width * canvas.height;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0,
    wB = 0,
    varMax = 0,
    thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > varMax) {
      varMax = between;
      thr = t;
    }
  }
  const softness = 50;
  for (let i = 0; i < d.length; i += 4) {
    const diff = d[i] - thr;
    let v =
      Math.abs(diff) >= softness
        ? diff > 0
          ? 255
          : 0
        : Math.round(((diff + softness) / (2 * softness)) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const binBlob = await canvas.convertToBlob({ type: "image/png", quality: 0.95 });
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

/* ─────────── 좌/우 밴드 OCR (각 1회) ─────────── */
async function ocrByBands(roiCanvas, lang, progress) {
  const W = roiCanvas.width,
    H = roiCanvas.height;
  const roiBitmap = await createImageBitmap(
    await roiCanvas.convertToBlob({ type: "image/png", quality: 0.95 })
  );

  // 레이아웃 가정: [왼쪽 숫자][아이콘][오른쪽 라벨+Lv]
  const leftW = Math.max(20, Math.round(W * 0.22));
  const gapX = Math.round(W * 0.06);
  const rightX = Math.min(W - 1, leftW + gapX);
  const rightW = Math.max(10, W - rightX);

  const { blob: leftBlob } = await cropBitmap(roiBitmap, 0, 0, leftW, H);
  const { blob: rightBlob } = await cropBitmap(roiBitmap, rightX, 0, rightW, H);

  const leftPre = await preprocessToBitmap(await createImageBitmap(leftBlob), {
    invert: true,
  });
  const rightPre = await preprocessToBitmap(await createImageBitmap(rightBlob), {
    invert: true,
  });

  const WL_NUM = "123456789";
  const WL_LABEL =
    "0123456789.Lv공격력추가피해보스피해아군공격강화아군피해강화낙인력";

  const lUrl = URL.createObjectURL(await blobFromBitmap(leftPre));
  const rUrl = URL.createObjectURL(await blobFromBitmap(rightPre));

  let leftWords = [],
    rightWords = [],
    leftRaw = "",
    rightRaw = "";
  try {
    const l = await ocrWords(lUrl, lang, "왼쪽(숫자)", progress, {
      psm: 7,
      whitelist: WL_NUM,
    });
    leftWords = l.words || [];
    leftRaw = l.rawText || "";

    // 오른쪽은 'kor'만 (영문 끔)
    const r = await ocrWords(rUrl, "kor", "오른쪽(라벨/Lv)", progress, {
      psm: 7,
      whitelist: WL_LABEL,
    });
    rightWords = r.words || [];
    rightRaw = r.rawText || "";
  } finally {
    URL.revokeObjectURL(lUrl);
    URL.revokeObjectURL(rUrl);
  }

  const words = dedupeWords([
    ...leftWords,
    ...shiftX(dedupeWords(rightWords), rightX),
  ]);

  return {
    words,
    leftRaw,
    rightRaw,
    debug: { bands: { W, H, leftW, gapX, rightX, rightW } },
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
    const W = bitmap.width,
      H = bitmap.height;
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

    // ROI 캔버스에 제외영역 마스킹 적용 (ROI 좌표계로 변환)
    await maskExcludesOnRoi(
      roi.canvas,
      (excludes || []).map((r) => ({
        x: r.x - safe.x,
        y: r.y - safe.y,
        w: r.w,
        h: r.h,
      }))
    );

    const progress = (label, ind, pct) =>
      send("progress", { label, indeterminate: !!ind, pct: pct ?? 0 });

    // 밴드 OCR
    const band = await ocrByBands(roi.canvas, lang, progress);

    const roiArrayBuf = await roi.blob.arrayBuffer();
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
          roiPng: roiArrayBuf,
          roiMime: "image/png",
          debug: band.debug,
        },
      },
      [roiArrayBuf]
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
