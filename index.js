import express from "express";
import { fetch as undiciFetch } from "undici";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --------------------
// Root / Health
// --------------------
app.get("/", (req, res) => {
  res.status(200).send("OK - usa /health o /gamepasses-by-place/:placeId");
});

app.get("/health", (req, res) => res.json({ ok: true }));

// --------------------
// Cache simple
// --------------------
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

// --------------------
// Fetch JSON robusto
// --------------------
async function fetchJson(url) {
  // usamos undiciFetch (más estable en servidores)
  let res;
  try {
    res = await undiciFetch(url, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    // error de red, DNS, TLS, etc.
    throw new Error(`fetch failed for ${url} :: ${e?.message || e}`);
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { ok: res.ok, status: res.status, json, text };
}

// --------------------
// 1) PlaceId -> UniverseId (legacy estable)
// --------------------
async function getUniverseIdFromPlace(placeId) {
  const url = `https://api.roblox.com/universes/get-universe-containing-place?placeid=${placeId}`;
  const r = await fetchJson(url);
  if (!r.ok) throw new Error(`Universe lookup error ${r.status}: ${r.text?.slice(0, 200)}`);

  const u = r.json?.UniverseId ?? r.json?.universeId;
  if (!u) throw new Error("UniverseId not found");
  return Number(u);
}

// --------------------
// 2A) Universe -> Gamepasses (API nueva)
// --------------------
async function listUniverseGamepassesNew(universeId) {
  const all = [];
  let pageToken = "";
  const pageSize = 100;
  const passView = "Full";

  for (let guard = 0; guard < 30; guard++) {
    const url =
      `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes` +
      `?passView=${passView}&pageSize=${pageSize}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const r = await fetchJson(url);
    if (!r.ok) throw new Error(`NEW gamepasses error ${r.status}: ${r.text?.slice(0, 200)}`);

    const items = r.json?.gamePasses || r.json?.data || r.json?.items || [];
    if (Array.isArray(items) && items.length) all.push(...items);

    const next = r.json?.nextPageToken || r.json?.nextPageCursor || null;
    if (!next) break;
    pageToken = String(next);
  }

  return all.map((p) => ({
    id: p.id ?? p.gamePassId ?? null,
    name: p.name ?? null,
    price: p.priceInRobux ?? p.price ?? null,
    iconAssetId: p.iconImageAssetId ?? p.iconAssetId ?? null,
    isForSale: p.isForSale ?? null,
    description: p.description ?? null,
  })).filter(x => x.id);
}

// --------------------
// 2B) Universe -> Gamepasses (LEGACY fallback)
// --------------------
// Nota: este endpoint legacy devuelve una lista simple.
// En algunos universos no devuelve todo, pero sirve como fallback.
async function listUniverseGamepassesLegacy(universeId) {
  // endpoint legacy (suele ser más accesible desde hosts)
  const url = `https://api.roblox.com/universes/${universeId}/gamepasses?limit=100`;
  const r = await fetchJson(url);
  if (!r.ok) throw new Error(`LEGACY gamepasses error ${r.status}: ${r.text?.slice(0, 200)}`);

  // a veces devuelve [] directamente
  const arr = Array.isArray(r.json) ? r.json : [];
  return arr.map((p) => ({
    id: p.GamePassId ?? p.gamePassId ?? null,
    name: p.Name ?? p.name ?? null,
    price: p.PriceInRobux ?? p.priceInRobux ?? null,
    iconAssetId: p.IconImageAssetId ?? p.iconImageAssetId ?? null,
    isForSale: p.IsForSale ?? p.isForSale ?? null,
    description: p.Description ?? p.description ?? null,
  })).filter(x => x.id);
}

// --------------------
// 2) Función final: intenta NEW y si falla usa LEGACY
// --------------------
async function listUniverseGamepasses(universeId) {
  try {
    return await listUniverseGamepassesNew(universeId);
  } catch (e) {
    // fallback legacy
    return await listUniverseGamepassesLegacy(universeId);
  }
}

// --------------------
// Endpoints API
// --------------------
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
    const payload = { universeId, count: gamepasses.length, gamepasses };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// El endpoint más útil: PlaceId -> UniverseId -> Gamepasses
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

    const payload = { placeId, universeId, count: gamepasses.length, gamepasses };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --------------------
// Start
// --------------------
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
