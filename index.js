const express = require("express");
const app = express();

const BASE_URL = "https://allmovieland.one";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

// ─── Step 1: Get session ────────────────────────────────────────────────────

async function getSession() {
  const res = await fetch(BASE_URL + "/", {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/PHPSESSID=([^;]+)/);
  return match ? match[1] : "";
}

// ─── Step 2: Search ──────────────────────────────────────────────────────────

async function search(query, sessionId) {
  const body = `do=search&subaction=search&search_start=0&full_search=0&result_from=1&story=${encodeURIComponent(query)}`;

  const res = await fetch(BASE_URL + "/index.php?do=search", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BASE_URL + "/",
      Cookie: `PHPSESSID=${sessionId}`,
    },
    body,
    redirect: "follow",
  });

  const html = await res.text();
  const results = [];

  const articleRegex =
    /<article[^>]*class="[^"]*short-mid[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"/i);
    const href = linkMatch ? linkMatch[1] : "";
    const catsMatch = block.match(
      /<span[^>]*class="[^"]*new-short__cats[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const cats = catsMatch
      ? catsMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase()
      : "";
    const type = cats.includes("series")
      ? "tvseries"
      : cats.includes("films")
      ? "movie"
      : "cartoon";

    if (title && href) results.push({ title, href, type });
  }
  return results;
}

// ─── Step 3: Load detail page ───────────────────────────────────────────────

async function loadDetail(url, sessionId) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: BASE_URL + "/",
      Cookie: `PHPSESSID=${sessionId}`,
    },
    redirect: "follow",
  });
  const html = await res.text();

  const titleMatch = html.match(
    /<h1[^>]*class="[^"]*fs__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i
  );
  const rawTitle = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
    : "";

  const yearMatch = rawTitle.match(/\((\d{4})\)/);
  const year = yearMatch ? parseInt(yearMatch[1]) : undefined;

  const posterMatch = html.match(
    /<img[^>]*class="[^"]*fs__poster-img[^"]*"[^>]*src="([^"]+)"/i
  );
  const poster = posterMatch
    ? posterMatch[1].startsWith("http")
      ? posterMatch[1]
      : BASE_URL + posterMatch[1]
    : undefined;

  const tagsMatch = html.match(
    /<div[^>]*itemprop="genre"[^>]*>([\s\S]*?)<\/div>/i
  );
  const tags = tagsMatch ? tagsMatch[1].toLowerCase() : "";
  const type = tags.includes("series")
    ? "tvseries"
    : tags.includes("films")
    ? "movie"
    : "cartoon";

  const domainMatch = html.match(
    /const\s+AwsIndStreamDomain\s*=\s*'([^']+)'/
  );
  if (!domainMatch) throw new Error("Could not extract player domain");
  const playerDomain = domainMatch[1].replace(/\/+$/, "");

  const srcMatch = html.match(/src:\s*'([^']+)'/);
  if (!srcMatch) throw new Error("Could not extract stream ID");
  const streamId = srcMatch[1];

  return { title: rawTitle, year, type, poster, playerDomain, streamId, detailUrl: url };
}

// ─── Step 4: Get stream payload from embed ──────────────────────────────────

async function getStreamPayload(embedLink, refererUrl, playerDomain, sessionId) {
  const baseUrl = getBaseUrl(embedLink);

  const res = await fetch(embedLink, {
    headers: {
      "User-Agent": UA,
      Referer: refererUrl,
      Cookie: `PHPSESSID=${sessionId}`,
    },
    redirect: "follow",
  });
  const html = await res.text();

  // Extract player config JSON from embed page
  // Pattern 1: let p3 = {...}; ... new HDVBPlayer(p3)  (variable assignment, then HDVBPlayer call)
  // Pattern 2: var pl = new HDVBPlayer({...})           (inline JSON in HDVBPlayer call)
  // Pattern 3: fallback to last script tag JSON extraction (Kotlin's method)
  let config;

  // Pattern 2 first: new HDVBPlayer({...}) with inline JSON
  // This is the most reliable pattern - the JSON is between the parens
  const hdvbInlineMatch = html.match(/new\s+HDVBPlayer\(\s*(\{[\s\S]*?"key"\s*:)/);
  if (hdvbInlineMatch) {
    // Find the matching closing brace
    const startIdx = html.indexOf("{", html.indexOf("new HDVBPlayer"));
    if (startIdx !== -1) {
      let depth = 0;
      let endIdx = startIdx;
      for (let i = startIdx; i < html.length; i++) {
        if (html[i] === "{") depth++;
        if (html[i] === "}") depth--;
        if (depth === 0) { endIdx = i; break; }
      }
      const jsonStr = html.substring(startIdx, endIdx + 1);
      try {
        config = JSON.parse(jsonStr);
      } catch {
        // continue to next pattern
      }
    }
  }

  if (!config) {
    // Pattern 1: let/var/const p3 = {...}; variable assignment
    const varMatch = html.match(/(?:let|var|const)\s+\w+\s*=\s*(\{[\s\S]*?"key"\s*:)/);
    if (varMatch) {
      // Find the full JSON by matching braces from the start of the object
      const startIdx = html.indexOf("{", html.match(/(?:let|var|const)\s+\w+\s*=\s*/).index);
      if (startIdx !== -1) {
        let depth = 0;
        let endIdx = startIdx;
        for (let i = startIdx; i < html.length; i++) {
          if (html[i] === "{") depth++;
          if (html[i] === "}") depth--;
          if (depth === 0) { endIdx = i; break; }
        }
        const jsonStr = html.substring(startIdx, endIdx + 1);
        try {
          config = JSON.parse(jsonStr);
        } catch {
          // continue to fallback
        }
      }
    }
  }

  if (!config) {
    // Fallback: extract JSON from last script tag (Kotlin's method)
    const scriptTags = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = scriptRegex.exec(html)) !== null) scriptTags.push(sm[1]);
    const lastScript = scriptTags.length > 0 ? scriptTags[scriptTags.length - 1] : "";
    const start = lastScript.indexOf("{");
    const end = lastScript.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { playerDomain, tokenKey: "", items: [], raw: "" };
    }
    try {
      config = JSON.parse(lastScript.substring(start, end + 1));
    } catch {
      throw new Error("Failed to parse player config from any pattern");
    }
  }

  const tokenKey = config.key || "";

  // Extract the file ID from config.file
  // config.file may be:
  //   - Full URL: "https://cdn.example.com/playlist/FILEID.txt"
  //   - Relative: "/playlist/FILEID.txt"
  //   - Bare ID:  "FILEID.txt"
  // We need just the file ID portion for the playerDomain endpoint.
  let fileId;
  if (config.file.startsWith("http")) {
    const parts = config.file.split("/playlist/");
    fileId = parts.length > 1 ? parts[1] : config.file;
  } else if (config.file.startsWith("/playlist/")) {
    fileId = config.file.substring("/playlist/".length);
  } else {
    fileId = config.file;
  }

  // POST to playerDomain/playlist/{fileId} with CSRF token
  const playlistUrl = `${playerDomain}/playlist/${fileId}`;
  const postRes = await fetch(playlistUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": BASE_URL + "/",
      "X-CSRF-TOKEN": tokenKey,
      "Origin": playerDomain,
    },
    redirect: "follow",
  });

  let raw = await postRes.text();
  raw = raw.replace(/,\s*\[\]/g, "");

  let items;
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error(`Failed to parse stream items. Raw: ${raw.substring(0, 300)}`);
  }

  return { playerDomain, tokenKey, items, raw };
}

// ─── Step 5: Get m3u8 from file ID ──────────────────────────────────────────

async function getM3u8Url(playerDomain, tokenKey, file) {
  const fileId = file.startsWith("~") ? file.substring(1) : file;
  const url = `${playerDomain}/playlist/${fileId}.txt`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "X-CSRF-TOKEN": tokenKey,
      Referer: BASE_URL + "/",
      Origin: playerDomain,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    redirect: "follow",
  });

  const text = (await res.text()).trim();
  if (text.startsWith("http")) return text;
  throw new Error("Unexpected m3u8 response");
}

// ─── Step 5b: Parse m3u8 for qualities ──────────────────────────────────────

async function parseM3u8Qualities(m3u8Url, playerDomain) {
  try {
    const res = await fetch(m3u8Url, {
      headers: { "User-Agent": UA, Referer: playerDomain, Origin: playerDomain },
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
          qualities.push({
            resolution: resMatch ? resMatch[1] : "unknown",
            bandwidth: parseInt(bwMatch[1]),
            url,
          });
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
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
  });
  const html = await res.text();

  const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/);
  if (ogMatch) {
    const raw = ogMatch[1].trim();
    const yearMatch = raw.match(/\((\d{4})\)\s*$/);
    return {
      title: raw.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
      year: yearMatch ? parseInt(yearMatch[1]) : undefined,
    };
  }

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const raw = titleMatch[1].split("—")[0].trim();
    const yearMatch = raw.match(/\((\d{4})\)\s*$/);
    return {
      title: raw.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
      year: yearMatch ? parseInt(yearMatch[1]) : undefined,
    };
  }

  throw new Error("Could not extract title from TMDB page");
}

// ─── Main: Movie ─────────────────────────────────────────────────────────────

async function getMovie(tmdbId) {
  const tmdbInfo = await getTmdbInfo(tmdbId, "movie");
  const sessionId = await getSession();
  const results = await search(tmdbInfo.title, sessionId);
  if (!results.length) throw new Error(`No results for "${tmdbInfo.title}"`);

  const best =
    results.find((r) =>
      r.title.toLowerCase().includes(tmdbInfo.title.toLowerCase())
    ) || results[0];

  const detail = await loadDetail(best.href, sessionId);
  const embedLink = `${detail.playerDomain}/play/${detail.streamId}`;
  const payload = await getStreamPayload(embedLink, best.href, detail.playerDomain, sessionId);

  // Extract streams for movies
  const streams = [];
  for (const item of payload.items) {
    try {
      if (!item.file) {
        streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [] });
        continue;
      }
      const m3u8 = await getM3u8Url(payload.playerDomain, payload.tokenKey, item.file);
      const qualities = await parseM3u8Qualities(m3u8, payload.playerDomain);
      streams.push({ language: item.title || "Unknown", m3u8, qualities });
    } catch (e) {
      streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [], error: e.message });
    }
  }

  return {
    title: detail.title,
    year: detail.year,
    poster: detail.poster,
    streams,
  };
}

// ─── Main: TV Show ───────────────────────────────────────────────────────────

async function getTvShow(tmdbId, season, episode) {
  const tmdbInfo = await getTmdbInfo(tmdbId, "tv");
  const sessionId = await getSession();
  const results = await search(tmdbInfo.title, sessionId);
  if (!results.length) throw new Error(`No results for "${tmdbInfo.title}"`);

  const best =
    results.find((r) =>
      r.title.toLowerCase().includes(tmdbInfo.title.toLowerCase())
    ) || results[0];

  const detail = await loadDetail(best.href, sessionId);
  const embedLink = `${detail.playerDomain}/play/${detail.streamId}`;
  const payload = await getStreamPayload(embedLink, best.href, detail.playerDomain, sessionId);

  const allEpisodes = [];

  if (payload.raw.includes("folder")) {
    let seasons;
    try {
      const parsed = JSON.parse(payload.raw);
      seasons = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error("Failed to parse TV show seasons");
    }

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

  // Filter by season/episode if specified
  let filtered = allEpisodes;
  if (season != null) filtered = filtered.filter((e) => e.season === season);
  if (episode != null) filtered = filtered.filter((e) => e.episode === episode);

  if (!filtered.length) {
    throw new Error(`No episodes found for S${season || "?"}E${episode || "?"}`);
  }

  // Get streams for each filtered episode
  const episodeResults = [];
  for (const ep of filtered) {
    const links = (ep.folder || []).map((file) => ({
      title: file.title,
      id: file.id,
      file: file.file,
    }));

    // If no folder items, use payload items (fallback)
    const itemsToProcess = links.length ? links : payload.items;

    const streams = [];
    for (const item of itemsToProcess) {
      try {
        if (!item.file) {
          streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [] });
          continue;
        }
        const m3u8 = await getM3u8Url(payload.playerDomain, payload.tokenKey, item.file);
        const qualities = await parseM3u8Qualities(m3u8, payload.playerDomain);
        streams.push({ language: item.title || "Unknown", m3u8, qualities });
      } catch (e) {
        streams.push({ language: item.title || "Unknown", m3u8: "", qualities: [], error: e.message });
      }
    }

    episodeResults.push({
      season: ep.season,
      episode: ep.episode,
      title: ep.title,
      streams,
    });
  }

  // If single episode, return flat
  if (episodeResults.length === 1 && season != null && episode != null) {
    return {
      title: detail.title,
      year: detail.year,
      poster: detail.poster,
      season: episodeResults[0].season,
      episode: episodeResults[0].episode,
      episodeTitle: episodeResults[0].title,
      streams: episodeResults[0].streams,
    };
  }

  return {
    title: detail.title,
    year: detail.year,
    poster: detail.poster,
    episodes: episodeResults,
  };
}

// ─── Express Routes ──────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    api: "AllMovieLand Stream Scraper",
    endpoints: {
      movie: "/movie/{tmdb_id}",
      tv: "/tv/{tmdb_id}/{season}/{episode}",
      debug: "/debug/{tmdb_id}?type=movie|tv",
    },
    examples: {
      movie: "/movie/912649",
      tv: "/tv/71446/1/1",
    },
  });
});

app.get("/debug/:tmdbId", async (req, res) => {
  const steps = [];
  try {
    const tmdbId = parseInt(req.params.tmdbId);
    const type = req.query.type || "movie";

    // Step 1: TMDB
    steps.push({ step: "tmdb", status: "running" });
    const tmdbInfo = await getTmdbInfo(tmdbId, type);
    steps[0].status = "ok";
    steps[0].title = tmdbInfo.title;
    steps[0].year = tmdbInfo.year;

    // Step 2: Session
    steps.push({ step: "session", status: "running" });
    const sessionId = await getSession();
    steps[1].status = sessionId ? "ok" : "failed";
    steps[1].sessionId = sessionId ? sessionId.substring(0, 8) + "..." : "none";

    // Step 3: Search
    steps.push({ step: "search", status: "running" });
    const results = await search(tmdbInfo.title, sessionId);
    steps[2].status = results.length ? "ok" : "failed";
    steps[2].resultCount = results.length;
    steps[2].results = results.slice(0, 3).map(r => ({ title: r.title, href: r.href, type: r.type }));

    if (!results.length) {
      steps[2].status = "no_results";
      return res.json({ steps, error: "No search results" });
    }

    const best = results.find(r => r.title.toLowerCase().includes(tmdbInfo.title.toLowerCase())) || results[0];

    // Step 4: Detail
    steps.push({ step: "detail", status: "running" });
    const detail = await loadDetail(best.href, sessionId);
    steps[3].status = "ok";
    steps[3].title = detail.title;
    steps[3].playerDomain = detail.playerDomain;
    steps[3].streamId = detail.streamId;
    steps[3].type = detail.type;

    // Step 5: Embed
    steps.push({ step: "embed", status: "running" });
    const embedLink = `${detail.playerDomain}/play/${detail.streamId}`;
    steps[4].embedLink = embedLink;

    const embedRes = await fetch(embedLink, {
      headers: { "User-Agent": UA, Referer: best.href, Cookie: `PHPSESSID=${sessionId}` },
      redirect: "follow",
    });
    const embedHtml = await embedRes.text();
    steps[4].embedLength = embedHtml.length;
    steps[4].hasHDVBPlayer = embedHtml.includes("HDVBPlayer");
    steps[4].hasNewHDVB = /new\s+HDVBPlayer\(\s*\{/.test(embedHtml);
    steps[4].hasVarAssign = /(?:let|var|const)\s+\w+\s*=\s*\{/.test(embedHtml);
    steps[4].embedSnippet = embedHtml.substring(embedHtml.indexOf("HDVBPlayer") - 50, embedHtml.indexOf("HDVBPlayer") + 200);

    // Step 6: Get stream payload
    steps.push({ step: "streamPayload", status: "running" });
    const payload = await getStreamPayload(embedLink, best.href, detail.playerDomain, sessionId);
    steps[5].status = payload.items.length ? "ok" : "empty";
    steps[5].itemsCount = payload.items.length;
    steps[5].rawLength = payload.raw.length;
    steps[5].rawPreview = payload.raw.substring(0, 300);
    steps[5].tokenKey = payload.tokenKey ? payload.tokenKey.substring(0, 15) + "..." : "none";

    res.json({ steps });
  } catch (e) {
    res.json({ steps, error: e.message, stack: e.stack?.split("\n").slice(0, 5) });
  }
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
    if (season !== null && isNaN(season))
      return res.status(400).json({ error: "Invalid season number" });
    if (episode !== null && isNaN(episode))
      return res.status(400).json({ error: "Invalid episode number" });

    const data = await getTvShow(tmdbId, season, episode);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
