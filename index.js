import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- Root para que no salga Not Found
app.get("/", (req, res) => {
  res.status(200).send("OK - usa /health o /gamepasses-by-place/:placeId");
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- cache simple
const cache = new Map(); // key -> {t,data}
const CACHE_MS = 60_000;

function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_MS) return null;
  return v.data;
}
function setCache(key, data) {
  cache.set(key, { t: Date.now(), data });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// 1) PlaceId -> UniverseId
async function getUniverseIdFromPlace(placeId) {
  const url = `https://api.roblox.com/universes/get-universe-containing-place?placeid=${placeId}`;
  const r = await fetchJson(url);
  if (!r.ok) throw new Error(`Universe lookup error ${r.status}`);
  const u = r.json?.UniverseId ?? r.json?.universeId;
  if (!u) throw new Error("UniverseId not found in response");
  return Number(u);
}

// 2) Listar gamepasses del Universe (API nueva)
async function listUniverseGamepasses(universeId) {
  const all = [];
  let pageToken = ""; // vacio = primera pagina
  const pageSize = 100;
  const passView = "Full";

  for (let guard = 0; guard < 30; guard++) {
    const url =
      `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes` +
      `?passView=${passView}&pageSize=${pageSize}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const r = await fetchJson(url);
    if (!r.ok) throw new Error(`Universe gamepasses error ${r.status}: ${r.text?.slice(0, 200)}`);

    // En esta API a veces viene como data/gamePasses/items; normalizamos
    const items =
      r.json?.gamePasses ||
      r.json?.data ||
      r.json?.items ||
      [];

    if (Array.isArray(items) && items.length) {
      all.push(...items);
    }

    const next = r.json?.nextPageToken || r.json?.nextPageCursor || null;
    if (!next) break;
    pageToken = String(next);
  }

  // Normaliza campos típicos que vas a usar en Roblox UI
  return all.map((p) => ({
    id: p.id ?? p.gamePassId ?? null,
    name: p.name ?? null,
    price: p.priceInRobux ?? p.price ?? null,
    iconAssetId: p.iconImageAssetId ?? p.iconAssetId ?? null,
    isForSale: p.isForSale ?? null,
    description: p.description ?? null,
  })).filter(x => x.id);
}

// Endpoint: placeId -> universeId
app.get("/universe-from-place/:placeId", async (req, res) => {
  try {
    const placeId = Number(req.params.placeId);
    if (!Number.isFinite(placeId) || placeId <= 0) {
      return res.status(400).json({ error: "Invalid placeId" });
    }

    const cacheKey = `u_from_p:${placeId}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const universeId = await getUniverseIdFromPlace(placeId);
    const payload = { placeId, universeId };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Endpoint: universeId -> gamepasses
app.get("/universe-gamepasses/:universeId", async (req, res) => {
  try {
    const universeId = Number(req.params.universeId);
    if (!Number.isFinite(universeId) || universeId <= 0) {
      return res.status(400).json({ error: "Invalid universeId" });
    }

    const cacheKey = `gp_u:${universeId}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const gamepasses = await listUniverseGamepasses(universeId);

    const payload = {
      universeId,
      count: gamepasses.length,
      gamepasses,
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Endpoint directo: placeId -> gamepasses (el más cómodo)
app.get("/gamepasses-by-place/:placeId", async (req, res) => {
  try {
    const placeId = Number(req.params.placeId);
    if (!Number.isFinite(placeId) || placeId <= 0) {
      return res.status(400).json({ error: "Invalid placeId" });
    }

    const cacheKey = `gp_p:${placeId}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const universeId = await getUniverseIdFromPlace(placeId);
    const gamepasses = await listUniverseGamepasses(universeId);

    const payload = {
      placeId,
      universeId,
      count: gamepasses.length,
      gamepasses,
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
