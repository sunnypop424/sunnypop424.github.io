// worker.js
export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allow = (env.ALLOW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allow.length === 0 || allow.includes(origin);
    const corsOrigin = okOrigin ? origin : "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method Not Allowed" }, corsOrigin, 405);
    }

    // API 키 (?key=... / ?api_key=...)
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || url.searchParams.get("api_key") || "";
    if (env.API_KEY && key !== env.API_KEY) {
      return json({ ok: false, error: "Unauthorized" }, corsOrigin, 401);
    }

    // 중복 전송 방지 (30초)
    const once = url.searchParams.get("once");
    if (once) {
      const now = Date.now();
      for (const [k, ts] of SEEN) if (now - ts > 30000) SEEN.delete(k);
      if (SEEN.has(once)) return json({ ok: true, dedup: true }, corsOrigin, 200);
      SEEN.set(once, now);
    }

    const ctype = (request.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("multipart/form-data")) {
      return json({ ok: false, error: "Use multipart/form-data only" }, corsOrigin, 415);
    }

    // ─────────────────────────────────────────────────────────────
    // 폼 파싱
    const form = await request.formData();
    const title = (form.get("title") || "").toString().slice(0, 80);
    const content = (form.get("content") || "").toString().slice(0, 4000);
    if (!title || !content) {
      return json({ ok: false, error: "Missing title/content" }, corsOrigin, 400);
    }

    // 파일 수집 (files[] 또는 files)
    const filesArr = [];
    for (const [k, v] of form.entries()) {
      if ((k === "files[]" || k === "files") && v instanceof File) filesArr.push(v);
    }

    // 제한/필터
    const MAX_FILES = 4;
    const PER_FILE  = 4 * 1024 * 1024;   // 4MB
    const TOTAL     = 16 * 1024 * 1024;  // 16MB
    const okTypes   = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

    const files = filesArr.filter(f => okTypes.has((f.type || "").toLowerCase())).slice(0, MAX_FILES);
    let total = 0;
    for (const f of files) {
      total += f.size || 0;
      if ((f.size || 0) > PER_FILE)  return json({ ok: false, error: "Image too large (per-file)" }, corsOrigin, 400);
      if (total > TOTAL)             return json({ ok: false, error: "Images too large (total)" }, corsOrigin, 400);
    }

    // 디스코드로 multipart 전송 (임베드 X, content만)
    const webhook = (env.WEBHOOK || "").trim();
    if (!webhook) return json({ ok: false, error: "Missing WEBHOOK" }, corsOrigin, 500);
    const target = webhook.includes("?") ? `${webhook}&wait=true` : `${webhook}?wait=true`;

    // KST 시간 문자열 (YYYY-MM-DD HH:mm:ss KST)
    const ts = formatKST();

    // 2000자 안전 분할: "[제목: ...]\n\n" + 내용 + "\n\n" + 시간
    const header = `[제목 : ${title}]`;
    const footer = ts;
    const reserved = header.length + 2 /*\n\n*/ + 2 /*\n\n*/ + footer.length;
    const maxContent = Math.max(0, 2000 - reserved);
    const bodySafe = content.slice(0, maxContent);

    const contentText = `${header}\n\n${bodySafe}\n\n${footer}`;

    const out = new FormData();
    out.append("payload_json", JSON.stringify({
      username: "아크그리드 문의봇",
      content: contentText
    }));
    files.forEach((f, i) => out.append(`files[${i}]`, f, f.name));

    const resp = await fetch(target, { method: "POST", body: out });
    return json({ ok: resp.ok }, corsOrigin, resp.ok ? 200 : 500);
  }
};

const SEEN = new Map();

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(obj, origin = "*", status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}
function formatKST(d = new Date()) {
  // Intl parts로 "YYYY-MM-DD HH:mm:ss KST"
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(d).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST`;
}
