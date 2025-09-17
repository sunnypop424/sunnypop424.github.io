// worker.js
export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allow = (env.ALLOW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allow.length === 0 || allow.includes(origin);
    const corsOrigin = okOrigin ? origin : "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method Not Allowed" }, corsOrigin, 405);
    }

    // API 키 체크 (?key=... / ?api_key=...)
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
      // ✅ JSON/base64 경로는 더 이상 지원 안 함 (항상 멀티파트만)
      return json({ ok: false, error: "Use multipart/form-data only" }, corsOrigin, 415);
    }

    // ─────────────────────────────────────────────────────────────
    // 1) 폼 파싱
    const form = await request.formData();
    const title = (form.get("title") || "").toString().slice(0, 80);
    const content = (form.get("content") || "").toString().slice(0, 4000);

    if (!title || !content) {
      return json({ ok: false, error: "Missing title/content" }, corsOrigin, 400);
    }

    // files[] / files 키 모두 수집
    const filesArr = [];
    for (const [k, v] of form.entries()) {
      if ((k === "files[]" || k === "files") && v instanceof File) filesArr.push(v);
    }

    // 2) 제한/필터
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

    // 3) 디스코드로 항상 multipart 전송 (payload_json + files[n])
    const webhook = (env.WEBHOOK || "").trim();
    if (!webhook) return json({ ok: false, error: "Missing WEBHOOK" }, corsOrigin, 500);
    const target = webhook.includes("?") ? `${webhook}&wait=true` : `${webhook}?wait=true`;

    // ✅ "디스코드 메시지처럼": 임베드 없이 content만 사용
    const contentText = `**[${title}]**\n${content}`.slice(0, 2000); // webhook content 한도 안전
    const out = new FormData();

    // payload_json에 content만
    const payload = {
      username: "아크그리드 문의봇",
      content: contentText
      // embeds/attachments 안 씀
    };
    out.append("payload_json", JSON.stringify(payload));

    // 파일이 있으면 첨부
    files.forEach((f, i) => {
      out.append(`files[${i}]`, f, f.name);
    });

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
