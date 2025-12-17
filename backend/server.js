import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = 3000;

const __dirname = path.resolve();
const DB_FILE = path.join(__dirname, "../database/db.json");

app.use(cors());
app.use(express.json());

// --- Utility Functions ---

const DEFAULT_GAME_STATE = {
  status: "SETUP",
  safeZoneCenter: [49.01578, 8.39137], // Default to Karlsruhe
  currentRadius: 6000,
  objectiveTypes: [],
  lastShrinkTimestamp: null,
  shrinkAmountMeters: 500,
};

async function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { games: {} };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function overpassToGeoJSON(overpassJson) {
  const features = overpassJson.elements
    .map((el) => {
      let lat, lon, properties;

      if (el.type === "node" && el.lat && el.lon) {
        lat = el.lat;
        lon = el.lon;
        properties = el.tags || {};
      } else if (el.center) {
        lat = el.center.lat;
        lon = el.center.lon;
        properties = el.tags || {};
      } else {
        return null;
      }

      properties.osm_id = el.id;
      properties.osm_type = el.type;

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [lon, lat],
        },
        properties: properties,
      };
    })
    .filter((f) => f !== null);

  return {
    type: "FeatureCollection",
    features: features,
  };
}

// --- API Endpoints ---


app.post("/api/game/create", async (req, res) => {
  const db = await readDB();

  const gameId = crypto.randomUUID();

  db.games[gameId] = {
    gameState: {
      ...DEFAULT_GAME_STATE,
      ...(req.body.gameState || {}),
    },
    players: [],
  };

  writeDB(db);

  res.json({ gameId });
});

// GET current full state
app.get("/api/game/:gameId", async (req, res) => {
  const db = await readDB();
  const game = db.games[req.params.gameId];

  if (!game) return res.status(404).json({ error: "Game not found" });

  res.json(game);
});

// Start game
app.post("/api/game/start/:gameId", async (req, res) => {
  const db = await readDB();
  const game = db.games[req.params.gameId];

  game.gameState = {
    ...game.gameState,
    ...req.body,
    status: "ACTIVE",
    lastShrinkTimestamp: Date.now(),
  };

  writeDB(db);
  res.json(game.gameState);
});

// General game state update
app.patch("/api/game/:gameId/state", async (req, res) => {
  const db = await readDB();
  const game = db.games[req.params.gameId];

  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }

  // Only allow known fields
  const allowedFields = [
    "status",
    "currentRadius",
    "safeZoneCenter",
    "objectiveTypes",
    "shrinkInterval",
    "shrinkAmount",
    "lastShrinkTimestamp",
    "shrinkAmountMeters"
  ];

  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      game.gameState[key] = req.body[key];
    }
  }

  writeDB(db);
  res.json(game.gameState);
});

// Reset game state and players
app.post("/api/game/reset/:gameId", async (req, res) => {
  const db = await readDB();
  const game = db.games[req.params.gameId];

  game.gameState = DEFAULT_GAME_STATE;
  game.players.forEach(p => {
    p.hp = 100;
    p.score = 0;
    p.visitedObjectives = [];
  });

  writeDB(db);
  res.json({ ok: true });
});

// Create a new player
app.post("/api/players/create", async (req, res) => {
  const { gameId, id, lat, lon } = req.body;
  const db = await readDB();

  const game = db.games[gameId];
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (game.players.some(p => p.id === id)) {
    return res.status(409).json({ error: "Player exists" });
  }

  const player = {
    id,
    lat,
    lon,
    hp: 100,
    score: 0,
    visitedObjectives: [],
    ready: false
  };

  game.players.push(player);
  writeDB(db);

  res.json(player);
});

// Update player position, score, hp, etc.
app.post("/api/players/update", async (req, res) => {
  const { gameId, id, lat, lon, hp, score, visitedObjectives, ready } = req.body;
  const db = await readDB();

  const game = db.games[gameId];
  if (!game) return res.status(404).json({ error: "Game not found" });

  const player = game.players.find((p) => p.id === id);
  if (!player) return res.status(404).json({ error: "Player not found" });

  // Update only the fields that were provided
  if (lat !== undefined) player.lat = lat;
  if (lon !== undefined) player.lon = lon;
  if (hp !== undefined) player.hp = hp;
  if (score !== undefined) player.score = score;
  if (ready !== undefined) player.ready = ready
  if (visitedObjectives !== undefined)
    player.visitedObjectives = visitedObjectives;

  await writeDB(db);
  res.json({ ok: true, player });
});

// GeoJSON objectives
app.get("/geojson", async (req, res) => {
  const { types, lat, lon, radius } = req.query;

  if (!types || !lat || !lon || !radius) {
    return res.status(400).json({
      error:
        "Missing query parameters. Required: types (comma-separated), lat, lon, radius (in meters)",
    });
  }

  const amenities = types
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (amenities.length === 0) {
    return res.status(400).json({ error: "No valid types provided" });
  }

  const query = `
        [out:json][timeout:25];
        (
            ${amenities
              .map(
                (type) => `
                node["amenity"="${type}"](around:${radius},${lat},${lon});
                way["amenity"="${type}"](around:${radius},${lat},${lon});
                relation["amenity"="${type}"](around:${radius},${lat},${lon});
            `
              )
              .join("\n")}
        );
        out center;
    `;

  const url = "https://overpass-api.de/api/interpreter";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    });

    if (!response.ok) {
      console.error(`Overpass API error ${response.status}`);
      throw new Error(`Overpass API error: ${response.statusText}`);
    }

    const json = await response.json();
    const geojson = overpassToGeoJSON(json);

    res.json(geojson);
  } catch (err) {
    console.error("Error fetching Overpass data:", err);
    res.status(500).json({ error: "Failed to fetch GeoJSON data" });
  }
});

// Geocoding
app.get("/geocode", async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: "Missing query parameter 'q'" });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      q
    )}`;

    const response = await fetch(url, {
      headers: {
        "Accept-Language": "en",
        Referer: "https://example.com/page?q=123",
      },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Nominatim error ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Geocoding error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
