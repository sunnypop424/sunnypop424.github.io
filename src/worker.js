export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allow = (env.ALLOW_ORIGINS || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allow.includes(origin);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(okOrigin ? origin : "*"),
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method Not Allowed" }, okOrigin ? origin : "*", 405);
    }

    // 간단 토큰 체크 (?key=... or ?api_key=...)
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || url.searchParams.get("api_key") || "";
    if (env.API_KEY && key !== env.API_KEY) {
      return json({ ok: false, error: "Unauthorized" }, okOrigin ? origin : "*", 401);
    }

    const ctype = (request.headers.get("content-type") || "").toLowerCase();

    try {
      // 공통 제한
      const MAX_FILES = 4;
      const PER_FILE  = 4 * 1024 * 1024;   // 4MB
      const TOTAL     = 16 * 1024 * 1024;  // 16MB
      const okTypes   = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

      // 공통 임베드 생성기
      const makeBaseEmbed = (title, content, meta) => {
        const embed = {
          title: `문의: ${String(title || "").slice(0, 80)}`,
          description: String(content || "").slice(0, 4000),
          color: 0xa399f2,
          fields: [],
          timestamp: new Date().toISOString(),
        };
        const m = meta || {};
        Object.keys(m).forEach(k => {
          const v = String(m[k] ?? "");
          if (v) embed.fields.push({ name: k, value: v.slice(0, 160), inline: true });
        });
        return embed;
      };

      let resp;

      // ===== 1) 프런트(FormData)에서 직접 파일 전송하는 경우 =====
      if (ctype.includes("multipart/form-data")) {
        const form = await request.formData();
        const title = form.get("title");
        const content = form.get("content");
        const metaRaw = form.get("meta");
        let meta = {};
        try { if (typeof metaRaw === "string") meta = JSON.parse(metaRaw); } catch {}

        // files[] 또는 files 키로 올라올 수 있으니 모두 수집
        const filesArr = [];
        for (const [k, v] of form.entries()) {
          if ((k === "files[]" || k === "files") && v instanceof File) {
            filesArr.push(v);
          }
        }

        // 검증 + 제한
        const files = filesArr.slice(0, MAX_FILES).filter(f => okTypes.has((f.type||"").toLowerCase()));
        let total = 0;
        for (const f of files) {
          total += f.size || 0;
          if ((f.size || 0) > PER_FILE) return json({ ok:false, error:"Image too large (per-file)" }, okOrigin? origin:"*");
          if (total > TOTAL)            return json({ ok:false, error:"Images too large (total)"    }, okOrigin? origin:"*");
        }

        if (!title || !content) {
          return json({ ok:false, error:"Missing title/content" }, okOrigin ? origin : "*", 400);
        }

        // Discord multipart 구성
        const baseEmbed = makeBaseEmbed(title, content, meta);
        const embeds = [baseEmbed];
        const attachments = [];
        const out = new FormData();

        files.forEach((f, i) => {
          out.append(`files[${i}]`, f, f.name);
          attachments.push({ id: i, filename: f.name });
          if (i === 0) baseEmbed.image = { url: `attachment://${f.name}` };
          else embeds.push({ image: { url: `attachment://${f.name}` } });
        });

        const payload = {
          username: "ArcGrid 문의봇",
          content: "",
          embeds,
          attachments,
        };
        out.append("payload_json", JSON.stringify(payload));

        resp = await fetch(env.WEBHOOK, { method: "POST", body: out });
      }

      // ===== 2) JSON(base64) 방식 (예전 클라이언트 호환) =====
      else if (ctype.includes("application/json")) {
        const body = await request.json();
        const baseEmbed = makeBaseEmbed(body.title, body.content, body.meta);

        const images = Array.isArray(body.images) ? body.images : [];
        if (!images.length) {
          resp = await fetch(env.WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "ArcGrid 문의봇", content: "", embeds: [baseEmbed] }),
          });
        } else {
          const embeds = [baseEmbed];
          const attachments = [];
          const out = new FormData();

          let total = 0;
          const list = images.filter(im => im && im.data && im.name && im.type && okTypes.has(im.type)).slice(0, MAX_FILES);
          list.forEach((im, i) => {
            const bin = Uint8Array.from(atob(im.data), c => c.charCodeAt(0));
            total += bin.length;
            if (bin.length > PER_FILE) throw new Error("Image too large (per-file)");
            if (total > TOTAL) throw new Error("Images too large (total)");

            const file = new File([bin], im.name, { type: im.type });
            out.append(`files[${i}]`, file);
            attachments.push({ id: i, filename: im.name });

            if (i === 0) baseEmbed.image = { url: `attachment://${im.name}` };
            else embeds.push({ image: { url: `attachment://${im.name}` } });
          });

          out.append("payload_json", JSON.stringify({
            username: "ArcGrid 문의봇",
            content: "",
            embeds,
            attachments,
          }));

          resp = await fetch(env.WEBHOOK, { method: "POST", body: out });
        }
      }

      // ===== 3) 그 외 Content-Type =====
      else {
        return json({ ok:false, error:"Unsupported Content-Type" }, okOrigin ? origin : "*", 415);
      }

      return json({ ok: resp.ok }, okOrigin ? origin : "*", resp.ok ? 200 : 500);

    } catch (err) {
      return json({ ok:false, error:String(err) }, okOrigin ? origin : "*", 500);
    }
  }
};

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
    headers: {
      "content-type": "application/json",
      ...corsHeaders(origin),
    },
  });
}
