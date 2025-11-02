import express from "express";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

/**
 * GET /geojson?types=pub,bar,cafe&lat=49.01578&lon=8.39137&radius=3000
 */
app.get("/geojson", async (req, res) => {
  const { types, lat, lon, radius } = req.query;

  if (!types || !lat || !lon || !radius) {
    return res.status(400).json({
      error:
        "Missing query parameters. Required: types (comma-separated), lat, lon, radius (in meters)",
    });
  }

  const amenities = types.split(",").map((t) => t.trim()).filter(Boolean);
  if (amenities.length === 0) {
    return res.status(400).json({ error: "No valid types provided" });
  }

  // Build Overpass query for all given amenities
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
      throw new Error(`Overpass API error: ${response.statusText}`);
    }

    const json = await response.json();
    const geojson = overpassToGeoJSON(json);

    res.json(geojson);
  } catch (err) {
    console.error("❌ Error fetching Overpass data:", err);
    res.status(500).json({ error: "Failed to fetch GeoJSON data" });
  }
});

/**
 * Convert Overpass JSON → GeoJSON
 */
function overpassToGeoJSON(overpassData) {
  return {
    type: "FeatureCollection",
    features: overpassData.elements
      .filter((el) => el.type === "node" || el.center)
      .map((el) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates:
            el.type === "node"
              ? [el.lon, el.lat]
              : [el.center.lon, el.center.lat],
        },
        properties: el.tags ? el.tags : {},
        id: el.id,
      })),
  };
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
