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
        headers: {
          "Access-Control-Allow-Origin": okOrigin ? origin : "*",
          "Access-Control-Allow-Methods": "POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method Not Allowed" }, okOrigin ? origin : "*", 405);
    }

    // 간단 토큰(선택)
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || url.searchParams.get("api_key") || "";
    if (env.API_KEY && key !== env.API_KEY) {
      return json({ ok: false, error: "Unauthorized" }, okOrigin ? origin : "*", 401);
    }

    // 본문
    let body;
    try { body = await request.json(); }
    catch { return json({ ok:false, error:"Invalid JSON"}, okOrigin ? origin : "*", 400); }

    // 이미지 없는 경우(단순 embed)
    const baseEmbed = {
      title: `문의: ${(body.title||"").toString().slice(0,80)}`,
      description: (body.content||"").toString().slice(0,4000),
      color: 0xa399f2,
      fields: [],
      timestamp: new Date().toISOString()
    };
    const meta = body.meta || {};
    Object.keys(meta).forEach(k => {
      const v = String(meta[k] ?? "");
      if (v) baseEmbed.fields.push({ name: k, value: v.slice(0,160), inline: true });
    });

    let resp;
    const images = Array.isArray(body.images) ? body.images : [];
    if (!images.length) {
      resp = await fetch(env.WEBHOOK, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ username: "아크그리드 문의봇", content: "", embeds: [baseEmbed] })
      });
    } else {
      // multipart + attachments
      const MAX_FILES = 4, PER_FILE = 4 * 1024 * 1024, TOTAL = 16 * 1024 * 1024;
      const okTypes = new Set(["image/png","image/jpeg","image/webp","image/gif"]);
      const chosen = images.filter(im => im && im.data && im.name && im.type && okTypes.has(im.type)).slice(0, MAX_FILES);

      let total = 0;
      const form = new FormData();
      const embeds = [baseEmbed];
      const attachments = [];

      chosen.forEach((im, i) => {
        const bin = Uint8Array.from(atob(im.data), c => c.charCodeAt(0));
        total += bin.length;
        if (bin.length > PER_FILE) throw new Error("Image too large (per-file)");
        if (total > TOTAL) throw new Error("Images too large (total)");
        const file = new File([bin], im.name, { type: im.type });
        form.append(`files[${i}]`, file);
        attachments.push({ id: i, filename: im.name });
        if (i === 0) baseEmbed.image = { url: `attachment://${im.name}` };
        else embeds.push({ image: { url: `attachment://${im.name}` } });
      });

      form.append("payload_json", JSON.stringify({
        username: "ArcGrid 문의봇",
        content: "",
        embeds,
        attachments
      }));

      resp = await fetch(env.WEBHOOK, { method: "POST", body: form });
    }

    const ok = resp.ok;
    return json({ ok }, okOrigin ? origin : "*", ok ? 200 : 500);
  }
};

function json(obj, origin = "*", status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
  });
}
