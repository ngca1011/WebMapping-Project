import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

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
};

function readDB() {
  try {
    const data = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(data);

    return {
      players: parsed.players || [],
      gameState: {
        ...DEFAULT_GAME_STATE,
        ...(parsed.gameState || {}),
      },
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Error reading database file:", error.message);
    }
    return {
      players: [],
      gameState: DEFAULT_GAME_STATE,
    };
  }
}

function writeDB(data) {
  try {
    const dataToSave = {
      players: data.players,
      gameState: data.gameState,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing to database file:", error.message);
  }
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

// GET current full state
app.get("/api/state", (req, res) => {
  const db = readDB();
  res.json(db);
});

// Start game
app.post("/api/game/start", (req, res) => {
  const db = readDB();
  db.gameState = {
    ...db.gameState,
    ...req.body.gameState,
    status: "ACTIVE",
  };
  if (db.gameState.lastShrinkTimestamp === null) {
    db.gameState.lastShrinkTimestamp = Date.now();
  }
  writeDB(db);
  res.json({ message: "Game started", gameState: db.gameState });
});

// General game state update
app.post("/api/game/update", (req, res) => {
  const db = readDB();

  // Incoming updates, including new radius and timestamp
  const incomingUpdates = req.body;

  db.gameState = {
    ...db.gameState,
    ...incomingUpdates,
  };

  if (incomingUpdates.currentRadius !== undefined) {
    if (db.gameState.status.toUpperCase().includes("SHRINK")) {
      db.gameState.status = "ACTIVE";
      console.log(
        `[Game Update] Auto-transitioned game status to ACTIVE after radius update.`
      );
    }
  }

  writeDB(db);
  res.json({ message: "Game state updated", gameState: db.gameState });
});

// Reset game state and players
app.post("/api/game/reset", (req, res) => {
  const db = {
    players: [],
    gameState: DEFAULT_GAME_STATE,
  };
  writeDB(db);
  res.json({
    message: "Game successfully reset to initial state.",
    gameState: db.gameState,
  });
});

// Create a new player
app.post("/api/players/create", (req, res) => {
  const { name, lat, lon, id } = req.body;
  let db = readDB();

  if (!id) {
    return res.status(400).json({ error: "Missing required player ID." });
  }

  if (db.players.some((p) => p.id === id)) {
    return res
      .status(409)
      .json({
        error: `Player with ID ${id} already exists. Use update endpoint.`,
      });
  }

  const newPlayer = {
    id: id,
    name: name || `Player ${id}`,
    lat: lat || DEFAULT_GAME_STATE.safeZoneCenter[0],
    lon: lon || DEFAULT_GAME_STATE.safeZoneCenter[1],
    score: 0,
    hp: 100,
    isAlive: true,
  };
  db.players.push(newPlayer);
  writeDB(db);

  res.status(201).json({ message: `Player ${id} created`, player: newPlayer });
});

// Update player position, score, hp, etc.
app.post("/api/players/update/:id", (req, res) => {
  const playerId = parseInt(req.params.id);
  const updates = req.body;
  let db = readDB();

  const playerIndex = db.players.findIndex((p) => p.id === playerId);

  if (playerIndex !== -1) {
    db.players[playerIndex] = {
      ...db.players[playerIndex],
      ...updates,
    };
  } else {
    return res
      .status(404)
      .json({
        error: `Player with ID ${playerId} not found. Please create the player first.`,
      });
  }

  writeDB(db);
  res.json({
    message: `Player ${playerId} updated`,
    player: db.players[playerIndex],
  });
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
      const errorText = await response.text();
      console.error(`Overpass API error (${response.status}): ${errorText}`);
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
  readDB();
});
