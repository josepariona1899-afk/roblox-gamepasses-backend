import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// cache simple
const cache = new Map();
const CACHE_MS = 60000;

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
  const res = await fetch(url, {
    headers: { "Accept": "application/json" }
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function listUserGamepasses(userId) {
  let all = [];
  let cursor = "";

  for (let i = 0; i < 20; i++) {
    const url =
      `https://apis.roblox.com/game-passes/v1/users/${userId}/game-passes?count=100` +
      (cursor ? `&exclusiveStartId=${cursor}` : "");

    const r = await fetchJson(url);
    if (!r.ok) throw new Error("Roblox error " + r.status);

    const items = r.json?.gamePasses || r.json?.data || [];
    if (!items.length) break;

    all.push(...items);

    const last = items[items.length - 1];
    cursor = last.id || last.gamePassId;
    if (!cursor || items.length < 100) break;
  }

  return [...new Set(all.map(p => p.id || p.gamePassId))];
}

async function getGamepassInfo(id) {
  const r = await fetchJson(
    `https://apis.roblox.com/game-passes/v1/game-passes/${id}/product-info`
  );

  if (!r.ok) return { id, ok: false };

  return {
    id,
    ok: true,
    name: r.json.name,
    price: r.json.priceInRobux,
    iconAssetId: r.json.iconImageAssetId
  };
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/user-gamepasses/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!userId) return res.status(400).json({ error: "Invalid userId" });

    const cached = getCache(userId);
    if (cached) return res.json(cached);

    const ids = await listUserGamepasses(userId);
    const infos = await Promise.all(ids.slice(0, 50).map(getGamepassInfo));

    const payload = {
      userId,
      count: infos.length,
      gamepasses: infos.filter(g => g.ok)
    };

    setCache(userId, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
