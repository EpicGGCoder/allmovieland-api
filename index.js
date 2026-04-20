const express = require("express");
const app = express();

const BASE_URL = "https://allmovieland.one";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const BULK_COUNT = 10;

// ─── Bulk POST: send multiple parallel requests, return first success ──────

async function bulkPost(url, headers) {
  const fetchOpts = { method: "POST", headers };
  const promises = Array.from({ length: BULK_COUNT }, () =>
    fetch(url, fetchOpts)
      .then(r => r.text())
      .then(text => ({ text, isRateLimit: /^\d+$/.test(text.trim()) || text.includes("404 Not Found") }))
      .catch(() => ({ text: "", isRateLimit: true }))
  );
  const results = await Promise.all(promises);
  const success = results.find(r => !r.isRateLimit && r.text.length > 0);
  return success ? success.text : null;
}

// ─── Step 1: Get session ────────────────────────────────────────────────────

async function getSession() {
  const res = await fetch(BASE_URL + "/", { headers: { "User-Agent": UA }, redirect: "follow" });
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/PHPSESSID=([^;]+)/);
  return match ? match[1] : "";
}

// ─── Step 2: Search ──────────────────────────────────────────────────────────

async function search(query, sessionId) {
  const body = `do=search&subaction=search&search_start=0&full_search=0&result_from=1&story=${encodeURIComponent(query)}`;
  const res = await fetch(BASE_URL + "/index.php?do=search", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Referer": BASE_URL + "/", "Cookie": `PHPSESSID=${sessionId}` },
    body, redirect: "follow",
  });
  const html = await res.text();
  const results = [];
  const articleRegex = /<article[^>]*class="[^"]*short-mid[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"/i);
    const href = linkMatch ? linkMatch[1] : "";
    const catsMatch = block.match(/<span[^>]*class="[^"]*new-short__cats[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const cats = catsMatch ? catsMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase() : "";
    const type = cats.includes("series") ? "tvseries" : cats.includes("films") ? "movie" : "cartoon";
    if (title && href) results.push({ title, href, type });
  }
  return results;
}

// ─── Step 3: Load detail page ───────────────────────────────────────────────

async function loadDetail(url, sessionId) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html", "Referer": BASE_URL + "/", "Cookie": `PHPSESSID=${sessionId}` },
    redirect: "follow",
  });
  const html = await res.text();
  const titleMatch = html.match(/<h1[^>]*class="[^"]*fs__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
  const yearMatch = rawTitle.match(/\((\d{4})\)/);
  const year = yearMatch ? parseInt(yearMatch[1]) : undefined;
  const posterMatch = html.match(/<img[^>]*class="[^"]*fs__poster-img[^"]*"[^>]*src="([^"]+)"/i);
  const poster = posterMatch ? (posterMatch[1].startsWith("http") ? posterMatch[1] : BASE_URL + posterMatch[1]) : undefined;
  const tagsMatch = html.match(/<div[^>]*itemprop="genre"[^>]*>([\s\S]*?)<\/div>/i);
  const tags = tagsMatch ? tagsMatch[1].toLowerCase() : "";
  const type = tags.includes("series") ? "tvseries" : tags.includes("films") ? "movie" : "cartoon";
  const domainMatch = html.match(/const\s+AwsIndStreamDomain\s*=\s*'([^']+)'/);
  if (!domainMatch) throw new Error("Could not extract player domain");
  const playerDomain = domainMatch[1].replace(/\/+$/, "");
  const srcMatch = html.match(/src:\s*'([^']+)'/);
  if (!srcMatch) throw new Error("Could not extract stream ID");
  const streamId = srcMatch[1];
  return { title: rawTitle, year, type, poster, playerDomain, streamId, detailUrl: url };
}

// ─── Step 4: Get stream payload from embed ──────────────────────────────────

async function getStreamPayload(embedLink, refererUrl, playerDomain) {
  const res = await fetch(embedLink, {
    headers: { "User-Agent": UA, "Accept": "text/html", "Referer": refererUrl },
    redirect: "follow",
  });
  const html = await res.text();
  if (!html.includes("HDVBPlayer")) {
    throw new Error("Could not load embed page");
  }

  let config;
  const hdvbIdx = html.indexOf("new HDVBPlayer");
  if (hdvbIdx !== -1) {
    const startIdx = html.indexOf("{", hdvbIdx);
    if (startIdx !== -1) {
      let depth = 0, endIdx = startIdx;
      for (let i = startIdx; i < html.length; i++) {
        if (html[i] === "{") depth++;
        if (html[i] === "}") depth--;
        if (depth === 0) { endIdx = i; break; }
      }
      try { config = JSON.parse(html.substring(startIdx, endIdx + 1)); } catch {}
    }
  }
  if (!config) {
    const varMatch = html.match(/(?:let|var|const)\s+\w+\s*=\s*/);
    if (varMatch) {
      const startIdx = html.indexOf("{", varMatch.index);
      if (startIdx !== -1) {
        let depth = 0, endIdx = startIdx;
        for (let i = startIdx; i < html.length; i++) {
          if (html[i] === "{") depth++;
          if (html[i] === "}") depth--;
          if (depth === 0) { endIdx = i; break; }
        }
        try { config = JSON.parse(html.substring(startIdx, endIdx + 1)); } catch {}
      }
    }
  }
  if (!config) {
    const scriptTags = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = scriptRegex.exec(html)) !== null) scriptTags.push(sm[1]);
    const lastScript = scriptTags.length > 0 ? scriptTags[scriptTags.length - 1] : "";
    const start = lastScript.indexOf("{");
    const end = lastScript.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { config = JSON.parse(lastScript.substring(start, end + 1)); } catch {}
    }
  }

  if (!config || !config.key) {
    return { playerDomain, tokenKey: "", items: [], raw: "" };
  }

  const tokenKey = config.key;
  const jsonfile = config.file.startsWith("http") ? config.file : `${playerDomain}/playlist/${config.file}`;

  // Bulk POST to beat rate limiting
  const raw = await bulkPost(jsonfile, {
    "User-Agent": UA,
    "X-CSRF-TOKEN": tokenKey,
    "Referer": embedLink,
    "Content-Type": "application/x-www-form-urlencoded",
  });

  if (!raw) {
    throw new Error("Playlist request failed (all rate limited)");
  }

  const cleanedRaw = raw.replace(/,\s*\[\]/g, "");
  let items;
  try {
    const parsed = JSON.parse(cleanedRaw);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error(`Failed to parse stream items. Raw: ${cleanedRaw.substring(0, 300)}`);
  }

  return { playerDomain, tokenKey, items, raw: cleanedRaw };
}

// ─── Step 5: Get m3u8 from file ID ──────────────────────────────────────────

async function getM3u8Url(playerDomain, tokenKey, file, embedLink) {
  const fileId = file.startsWith("~") ? file.substring(1) : file;
  const url = `${playerDomain}/playlist/${fileId}.txt`;

  const text = await bulkPost(url, {
    "User-Agent": UA,
    "X-CSRF-TOKEN": tokenKey,
    "Referer": BASE_URL + "/",
    "Origin": playerDomain,
    "Content-Type": "application/x-www-form-urlencoded",
  });

  if (!text) throw new Error("m3u8 request failed (all rate limited)");
  const trimmed = text.trim();
  if (trimmed.startsWith("http")) return trimmed;
  throw new Error("Unexpected m3u8 response: " + trimmed.substring(0, 100));
}

// ─── Step 5b: Parse m3u8 for qualities ──────────────────────────────────────

async function parseM3u8Qualities(m3u8Url, playerDomain) {
  try {
    const res = await fetch(m3u8Url, {
      headers: { "User-Agent": UA, "Referer": playerDomain, "Origin": playerDomain },
      redirect: "follow",
    });
    const body = await res.text();
    const qualities = [];
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && bwMatch) {
          const url = nextLine.startsWith("http") ? nextLine : baseUrl + nextLine;
          qualities.push({ resolution: resMatch ? resMatch[1] : "unknown", bandwidth: parseInt(bwMatch[1]), url });
        }
      }
    }
    return qualities;
  } catch {
    return [];
  }
}

// ─── TMDB Lookup ─────────────────────────────────────────────────────────────

async function getTmdbInfo(tmdbId, type) {
  const url = `https://www.themoviedb.org/${type}/${tmdbId}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
  const html = await res.text();
  const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
  if (ogMatch) {
    const raw = ogMatch[1].trim();
    const yearMatch = raw.match(/\((\d{4})\)\s*$/);
    return { title: raw.replace(/\s*\(\d{4}\)\s*$/, "").trim(), year: yearMatch ? parseInt(yearMatch[1]) : undefined };
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const raw = titleMatch[1].split("—")[0].trim();
    const yearMatch = raw.match(/\((\d{4})\)\s*$/);
    return { title: raw.replace(/\s*\(\d{4}\)\s*$/, "").trim(), year: yearMatch ? parseInt(yearMatch[1]) : undefined };
  }
  throw new Error("Could not extract title from TMDB page");
}

// ─── Main: Movie ─────────────────────────────────────────────────────────────

async function getMovie(tmdbId) {
  const tmdbInfo = await getTmdbInfo(tmdbId, "movie");
  const sessionId = await getSession();
  const results = await search(tmdbInfo.title, sessionId);
  if (!results.length) throw new Error(`No results for "${tmdbInfo.title}"`);
  const best = results.find((r) => r.title.toLowerCase().includes(tmdbInfo.title.toLowerCase())) || results[0];
  const detail = await loadDetail(best.href, sessionId);
  const embedLink = `${detail.playerDomain}/play/${detail.streamId}`;
  const payload = await getStreamPayload(embedLink, best.href, detail.playerDomain);

  const streams = [];
  for (const item of payload.items) {
    try {
      if (!item.file) { streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [] }); continue; }
      const m3u8 = await getM3u8Url(payload.playerDomain, payload.tokenKey, item.file, embedLink);
      const qualities = await parseM3u8Qualities(m3u8, payload.playerDomain);
      streams.push({ language: item.title || "Unknown", m3u8, qualities });
    } catch (e) {
      streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [], error: e.message });
    }
  }
  return { title: detail.title, year: detail.year, poster: detail.poster, streams };
}

// ─── Main: TV Show ───────────────────────────────────────────────────────────

async function getTvShow(tmdbId, season, episode) {
  const tmdbInfo = await getTmdbInfo(tmdbId, "tv");
  const sessionId = await getSession();
  const results = await search(tmdbInfo.title, sessionId);
  if (!results.length) throw new Error(`No results for "${tmdbInfo.title}"`);
  const best = results.find((r) => r.title.toLowerCase().includes(tmdbInfo.title.toLowerCase())) || results[0];
  const detail = await loadDetail(best.href, sessionId);
  const embedLink = `${detail.playerDomain}/play/${detail.streamId}`;
  const payload = await getStreamPayload(embedLink, best.href, detail.playerDomain);

  const allEpisodes = [];
  if (payload.raw.includes("folder")) {
    let seasons;
    try { const parsed = JSON.parse(payload.raw); seasons = Array.isArray(parsed) ? parsed : [parsed]; }
    catch { throw new Error("Failed to parse TV show seasons"); }
    for (const s of seasons) {
      const sNum = parseInt(s.id) || 1;
      for (const ep of s.folder || []) {
        const eNum = parseInt(ep.episode) || 1;
        allEpisodes.push({ season: sNum, episode: eNum, title: ep.title, folder: ep.folder });
      }
    }
  } else {
    allEpisodes.push({ season: 1, episode: 1, title: "1 episode", folder: [] });
  }

  let filtered = allEpisodes;
  if (season != null) filtered = filtered.filter((e) => e.season === season);
  if (episode != null) filtered = filtered.filter((e) => e.episode === episode);
  if (!filtered.length) throw new Error(`No episodes found for S${season || "?"}E${episode || "?"}`);

  const episodeResults = [];
  for (const ep of filtered) {
    const links = (ep.folder || []).map((file) => ({ title: file.title, id: file.id, file: file.file }));
    const itemsToProcess = links.length ? links : payload.items;
    const streams = [];
    for (const item of itemsToProcess) {
      try {
        if (!item.file) { streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [] }); continue; }
        const m3u8 = await getM3u8Url(payload.playerDomain, payload.tokenKey, item.file, embedLink);
        const qualities = await parseM3u8Qualities(m3u8, payload.playerDomain);
        streams.push({ language: item.title || "Unknown", m3u8, qualities });
      } catch (e) {
        streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [], error: e.message });
      }
    }
    episodeResults.push({ season: ep.season, episode: ep.episode, title: ep.title, streams });
  }

  if (episodeResults.length === 1 && season != null && episode != null) {
    return { title: detail.title, year: detail.year, poster: detail.poster, season: episodeResults[0].season, episode: episodeResults[0].episode, episodeTitle: episodeResults[0].title, streams: episodeResults[0].streams };
  }
  return { title: detail.title, year: detail.year, poster: detail.poster, episodes: episodeResults };
}

// ─── Express Routes ──────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    api: "AllMovieLand Stream Scraper",
    endpoints: { movie: "/movie/{tmdb_id}", tv: "/tv/{tmdb_id}/{season}/{episode}" },
    examples: { movie: "/movie/912649", tv: "/tv/71446/1/1" },
  });
});

app.get("/movie/:tmdbId", async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId);
    if (isNaN(tmdbId)) return res.status(400).json({ error: "Invalid TMDB ID" });
    const data = await getMovie(tmdbId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/tv/:tmdbId/:season?/:episode?", async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId);
    const season = req.params.season ? parseInt(req.params.season) : null;
    const episode = req.params.episode ? parseInt(req.params.episode) : null;
    if (isNaN(tmdbId)) return res.status(400).json({ error: "Invalid TMDB ID" });
    const data = await getTvShow(tmdbId, season, episode);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
