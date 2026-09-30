// Vercel serverless function: GET /api/pinterest  (optional ?board=board-name, ?debug=1)
// Pinterest blocks browsers (CORS), so the server fetches the pins and returns clean JSON.
// It tries four public sources in order and returns the first that works:
//   1. RSS feed  2. Pinterest's public JSON endpoint  3. profile page HTML
const USER = "Toufikmahata20";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : "";
};
const big = (u) => (u || "").replace(/\/(60x60|170x|236x|474x)\//, "/736x/");

async function get(url, attempts, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers } });
    attempts.push({ url: url.slice(0, 90), status: r.status });
    return r.ok ? await r.text() : "";
  } catch (e) {
    attempts.push({ url: url.slice(0, 90), error: String(e.name || e) });
    return "";
  } finally { clearTimeout(timer); }
}

function fromRss(xml) {
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((item) => {
    const desc = tag(item, "description");
    const img = (desc.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || "";
    const text = desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const link = tag(item, "link");
    return { id: link || img, link, title: (tag(item, "title") || text).slice(0, 90), image: big(img), date: tag(item, "pubDate") };
  });
}

function fromResource(text) {
  let list = [];
  try { list = JSON.parse(text).resource_response.data || []; } catch (e) { return []; }
  return list.filter((p) => p && p.id && p.images).map((p) => {
    const img = (p.images.orig || p.images["736x"] || p.images["474x"] || {}).url || "";
    return {
      id: String(p.id), link: `https://www.pinterest.com/pin/${p.id}/`,
      title: String(p.grid_title || p.title || p.description || "").replace(/\s+/g, " ").trim().slice(0, 90),
      image: img.replace("/originals/", "/736x/"), date: p.created_at || "",
    };
  });
}

function fromHtml(html) {
  const imgs = [...new Set(html.match(/https:\/\/i\.pinimg\.com\/(?:236x|474x|736x)\/[A-Za-z0-9\/_-]+\.(?:jpg|png|webp)/g) || [])];
  return imgs.map((u) => ({ id: u, link: `https://www.pinterest.com/${USER}/`, title: "", image: big(u), date: "" }));
}

module.exports = async (req, res) => {
  const board = /^[A-Za-z0-9_-]+$/.test((req.query && req.query.board) || "") ? req.query.board : "";
  const path = board ? `${USER}/${board}` : USER;
  const attempts = [];
  let pins = [], source = "";

  const tryList = async (name, fn) => {
    if (pins.length) return;
    const found = (await fn()).filter((p) => p.image && p.link);
    if (found.length) { pins = found; source = name; }
  };

  await tryList("rss", async () => {
    for (const host of ["www.pinterest.com", "in.pinterest.com"]) {
      const xml = await get(`https://${host}/${path}/feed.rss`, attempts, { Accept: "application/rss+xml,text/xml,*/*" });
      const p = fromRss(xml);
      if (p.length) return p;
    }
    return [];
  });

  if (!board) {
    await tryList("json", async () => {
      const data = JSON.stringify({ options: { username: USER, field_set_key: "grid_item", page_size: 25, bookmarks: [] }, context: {} });
      const url = `https://www.pinterest.com/resource/UserPinsResource/get/?source_url=${encodeURIComponent(`/${USER}/pins/`)}&data=${encodeURIComponent(data)}`;
      return fromResource(await get(url, attempts, { Accept: "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest", "X-Pinterest-AppState": "active" }));
    });
  }

  await tryList("html", async () => fromHtml(await get(`https://www.pinterest.com/${path}/`, attempts)));

  const seen = new Set();
  pins = pins.filter((p) => !seen.has(p.image) && seen.add(p.image)).slice(0, 24);

  const debug = req.query && req.query.debug;
  if (!pins.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Pinterest unavailable from the server", attempts, pins: [] });
  }
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
  res.status(200).json({ user: USER, source, updated: new Date().toISOString(), pins, ...(debug ? { attempts } : {}) });
};
