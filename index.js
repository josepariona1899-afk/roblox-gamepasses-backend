import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --------------------
// Ruta raíz (para que no salga Not Found)
// --------------------
app.get("/", (req, res) => {
  res.status(200).send("OK - usa /health o /user-gamepasses/:userId");
});

// --------------------
// Cache simple (para no spammear Roblox)
// --------------------
const cache = new Map();
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
// Helper fetch -> JSON
// --------------------
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

  return { ok: res.ok, status: res.status, json, text };
}

// --------------------
// Lista gamepasses creados por un userId
// (paginación por exclusiveStartId)
// --------------------
async function listUserGamepasses(userId) {
  const all = [];
  let cursor = "";

  for (let i = 0; i < 25; i++) {
    const url =
      `https://apis.roblox.com/game-passes/v1/users/${userId}/game-passes?count=100` +
      (cursor ? `&exclusiveStartId=${cursor}` : "");

    const r = await fetchJson(url);
    if (!r.ok) throw new Error("Roblox list error " + r.status);

    const items = r.json?.gamePasses || r.json?.data || [];
    if (!Array.isArray(items) || items.length === 0) break;

    all.push(...items);

    const last = items[items.length - 1];
    const next = last?.id || last?.gamePassId;

    if (!next || items.length < 100) break;
    cursor = String(next);
  }

  // Normaliza IDs
  const ids = all
    .map((p) => p?.id || p?.gamePassId)
    .filter((x) => typeof x === "number" || typeof x === "string")
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));

  return [...new Set(ids)];
}

// --------------------
// Info de producto del gamepass
// --------------------
async function getGamepassInfo(id) {
  const r = await fetchJson(
    `https://apis.roblox.com/game-passes/v1/game-passes/${id}/product-info`
  );

  if (!r.ok) return { id, ok: false };

  return {
    id,
    ok: true,
    name: r.json?.name ?? null,
    price: r.json?.priceInRobux ?? null,
    iconAssetId: r.json?.iconImageAssetId ?? null,
    description: r.json?.description ?? null,
    isForSale: r.json?.isForSale ?? null,
  };
}

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// --------------------
// API: gamepasses creados por userId
// --------------------
app.get("/user-gamepasses/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const cached = getCache(userId);
    if (cached) return res.json(cached);

    const ids = await listUserGamepasses(userId);

    // limita a 50 por seguridad
    const infos = await Promise.all(ids.slice(0, 50).map(getGamepassInfo));

    const payload = {
      userId,
      count: infos.filter((g) => g.ok).length,
      gamepasses: infos.filter((g) => g.ok),
    };

    setCache(userId, payload);
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
