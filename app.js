/* eslint-disable no-undef */
import {
  createAmenityPopup,
  startCountdown,
  countdownInterval,
} from "./helper.js";

let city_coord = [49.01578, 8.39137];
const zoom_level = 12;
const map_url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const map = L.map("map", { center: city_coord, zoom: zoom_level });
L.tileLayer(map_url, {
  attribution:
    '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const icon_size = 25;

const bar_icon = L.icon({
  iconUrl: "./assets/bar.png",
  iconSize: [icon_size, icon_size],
});
const cafe_icon = L.icon({
  iconUrl: "./assets/cafe.png",
  iconSize: [icon_size, icon_size],
});

const post_office_icon = L.icon({
  iconUrl: "./assets/post_office.png",
  iconSize: [icon_size, icon_size],
});

const pub_icon = L.icon({
  iconUrl: "./assets/pub.png",
  iconSize: [icon_size, icon_size],
});

const restaurant_icon = L.icon({
  iconUrl: "./assets/restaurant.png",
  iconSize: [icon_size, icon_size],
});

const player_icon = L.icon({
  iconUrl: "./assets/player.png",
  iconSize: [icon_size + 5, icon_size + 5],
});

let currentCircle = null;
let currentRadius = 6000;
let shrinkInterval = null;
let objectiveLayer = null;
let objectiveClusterLayer = null;
let score = 0
const SHRINK_INTERVAL_MS = 60 * 1000; // 60s (for demo)
const SHRINK_RADIUS = 1000;

const radiusSlider = document.getElementById("radiusRange");
const radiusValueLabel = document.getElementById("radiusValue");
const searchBox = document.getElementById("searchBox");
const searchButton = document.getElementById("searchButton");

// Update radius label dynamically
radiusSlider.addEventListener("input", (e) => {
  radiusValueLabel.textContent = e.target.value;
});

// Search location logic
searchButton.addEventListener("click", async () => {
  const query = searchBox.value.trim();
  if (!query) {
    alert("Please enter an address or place name!");
    return;
  }

  const url = `http://localhost:3000/geocode?q=${encodeURIComponent(query)}`;

  searchButton.textContent = "⏳";
  searchButton.disabled = true;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Geocoding failed (${response.status})`);

    const results = await response.json();
    if (results.length === 0) {
      alert(`No results found for "${query}"`);
      return;
    }

    const { lat, lon, display_name } = results[0];
    city_coord = [parseFloat(lat), parseFloat(lon)];

    map.flyTo(city_coord, 14);

    L.marker(city_coord)
      .addTo(map)
      .bindPopup(`<b>${display_name}</b>`)
      .openPopup();
  } catch (err) {
    console.error(err);
    alert("An error occurred while searching. Please try again.");
  } finally {
    searchButton.textContent = "🔍";
    searchButton.disabled = false;
  }
});

// --- Player Logic ---
let playerMarker = null;
export let visitedObjectives = new Set(); // store feature IDs or coordinate strings

// Add player marker
async function addPlayerMarker(latlng) {
  if (playerMarker) map.removeLayer(playerMarker);

  playerMarker = L.marker(latlng, {
    draggable: true,
    icon: player_icon
  })
    .addTo(map)
    .bindPopup("Player")
    .openPopup();

  // Check proximity when dragged
  playerMarker.on("moveend", handlePlayerMove);
}

// Add Player based on double click
map.on("dblclick", async function (event) {
  await addPlayerMarker(event.latlng);
});

async function handlePlayerMove(e) {
  const playerPos = e.target.getLatLng();

  // Loop through objective layers
  if (!objectiveClusterLayer) return;

  objectiveClusterLayer.eachLayer((layer) => {
    const { lat, lng } = layer.getLatLng();

    // Skip if already visited
    const key = `${lat},${lng}`;
    if (visitedObjectives.has(key)) return;

    const dist = map.distance(playerPos, L.latLng(lat, lng));

    if (dist <= 50) {
      // Objective reached
      visitedObjectives.add(key);
      map.removeLayer(layer);
      objectiveClusterLayer.removeLayer(layer);
      score++

      // Optional: small popup or animation
      L.popup({
        closeButton: false,
        autoClose: true,
        offset: [0, -15],
      })
        .setLatLng([lat, lng])
        .setContent(`✅ Objective reached! Current score: ${score}`)
        .openOn(map);
    }
  });
}

async function loadObjectives(selectedTypes, radius) {
  const url = `http://localhost:3000/geojson?types=${selectedTypes.join(
    ","
  )}&lat=${city_coord[0]}&lon=${city_coord[1]}&radius=${radius}`;

  let res = await fetch(url);

  while (res.status != 200) {
    res = await fetch(url);
  }

  let geojson = await res.json();

  // Remove old objectives
  if (objectiveClusterLayer) {
    map.removeLayer(objectiveClusterLayer);
  }

  // Add new ones
  objectiveClusterLayer = new L.markerClusterGroup({
    disableClusteringAtZoom: 18,
    spiderfyOnMaxZoom: false,
  });
  objectiveLayer = L.geoJSON(geojson, {
    filter: function (feature) {
      if (!feature.geometry || !feature.geometry.coordinates) return false;
      const [lng, lat] = feature.geometry.coordinates;
      const key = `${lat},${lng}`;
      return !visitedObjectives.has(key);
    },
    pointToLayer: function (feature, latlng) {
      switch (feature.properties.amenity) {
        case "bar":
          return L.marker(latlng, { icon: bar_icon });
        case "cafe":
          return L.marker(latlng, { icon: cafe_icon });
        case "post_office":
          return L.marker(latlng, { icon: post_office_icon });
        case "pub":
          return L.marker(latlng, { icon: pub_icon });
        case "restaurant":
          return L.marker(latlng, { icon: restaurant_icon });
        default:
          return L.marker(latlng);
      }
    },
    onEachFeature: async function (feature, layer) {
      const popupContent = await createAmenityPopup(feature);
      layer.bindPopup(popupContent);
    },
  });
  objectiveClusterLayer.addLayer(objectiveLayer);
  map.addLayer(objectiveClusterLayer);
}

async function gameStart() {
  const selected = Array.from(
    document.querySelectorAll("#checkboxes input:checked")
  ).map((cb) => cb.value);

  if (selected.length === 0) {
    alert("No objective types have been selected yet!");
    return;
  }

  // show Loading
  document.getElementById("loadingOverlay").style.display = "flex";

  // Reset state
  if (currentCircle) map.removeLayer(currentCircle);
  currentRadius = parseInt(radiusSlider.value, 10);

  // Draw initial circle
  currentCircle = L.circle(city_coord, {
    radius: currentRadius,
    color: "#6495ED",
  }).addTo(map);

  if (shrinkInterval) clearInterval(shrinkInterval);
  if (countdownInterval) clearInterval(countdownInterval);

  // Load initial objectives
  if (objectiveClusterLayer) map.removeLayer(objectiveClusterLayer);
  await loadObjectives(selected, currentRadius);

  document.getElementById("loadingOverlay").style.display = "none";

  alert(
    `Game started!\nSelected objectives: ${selected.join(
      ", "
    )}\nSafe zone will shrink every 60 seconds.`
  );

  await startCountdown(SHRINK_INTERVAL_MS);

  // Shrink circle every interval
  shrinkInterval = setInterval(async () => {
    currentRadius -= SHRINK_RADIUS;

    if (currentRadius <= 0) {
      map.removeLayer(objectiveClusterLayer);
      map.removeLayer(currentCircle);
      clearInterval(shrinkInterval);
      alert("The safe zone has fully closed!");
      return;
    }

    map.removeLayer(currentCircle);

    currentCircle = L.circle(city_coord, {
      radius: currentRadius,
      color: "#6495ED",
    }).addTo(map);

    // Reload objectives for new radius
    await loadObjectives(selected, currentRadius);
    await startCountdown(SHRINK_INTERVAL_MS);
  }, SHRINK_INTERVAL_MS);
}

document.getElementById("startGameButton").onclick = gameStart;
