import {createAmenityPopup} from './helper.js';

const coord_ka = [49.01578, 8.39137];
const zoom_level = 12;
const map_url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const map = L.map("map", { center: coord_ka, zoom: zoom_level });
L.tileLayer(map_url, {
  attribution:
    '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const icon_size = 30;

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

let currentCircle = null;
let currentRadius = 6000;
let shrinkInterval = null;
let countdownInterval = null;
let objectiveLayer = null;
const SHRINK_INTERVAL_MS = 60 * 1000; // 60s (for demo)
const SHRINK_RADIUS = 1000;

function onMapDoubleClick(e) {
  const marker = L.marker(e.latlng).addTo(map);
  marker.on("dblclick", () => map.removeLayer(marker));
}
map.on("dblclick", onMapDoubleClick);

function startCountdown(durationMs) {
  const timerEl = document.getElementById("timer");
  let remaining = durationMs / 1000;
  if (countdownInterval) clearInterval(countdownInterval);

  function updateTimer() {
    const mins = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
    const secs = String(Math.floor(remaining % 60)).padStart(2, "0");
    timerEl.textContent = `Next shrink in: ${mins}:${secs}`;
    if (remaining <= 0) clearInterval(countdownInterval);
    remaining--;
  }

  updateTimer();
  countdownInterval = setInterval(updateTimer, 1000);
}

async function loadObjectives(selectedTypes, radius) {
  const url = `http://localhost:3000/geojson?types=${selectedTypes.join(
    ","
  )}&lat=${coord_ka[0]}&lon=${coord_ka[1]}&radius=${radius}`;
  const res = await fetch(url);
  const geojson = await res.json();

  // Remove old objectives
  if (objectiveLayer) {
    map.removeLayer(objectiveLayer);
  }

  // Add new ones
  objectiveLayer = L.geoJSON(geojson, {
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
    onEachFeature: function (feature, layer) {
      const popupContent = createAmenityPopup(feature);
      layer.bindPopup(popupContent);
    },
  }).addTo(map);
}

async function gameStart() {

  // show Loading
  document.getElementById("loadingOverlay").style.display = "flex";

  const selected = Array.from(
    document.querySelectorAll("#checkboxes input:checked")
  ).map((cb) => cb.value);

  if (selected.length === 0) {
    alert("No objective types have been selected yet!");
    return;
  }

  // Reset state
  if (currentCircle) map.removeLayer(currentCircle);
  currentRadius = 6000;

  // Draw initial circle
  currentCircle = L.circle(coord_ka, {
    radius: currentRadius,
    color: "#6495ED",
  }).addTo(map);

  if (shrinkInterval) clearInterval(shrinkInterval);
  if (countdownInterval) clearInterval(countdownInterval);

  // Load initial objectives
  if (objectiveLayer) map.removeLayer(objectiveLayer);
  await loadObjectives(selected, currentRadius);

  document.getElementById("loadingOverlay").style.display = "none";

  alert(
    `Game started!\nSelected objectives: ${selected.join(
      ", "
    )}\nSafe zone will shrink every 60 seconds.`
  );

  startCountdown(SHRINK_INTERVAL_MS);

  // Shrink circle every interval
  shrinkInterval = setInterval(async () => {
    currentRadius -= SHRINK_RADIUS;

    if (currentRadius <= 0) {
      map.removeLayer(objectiveLayer);
      map.removeLayer(currentCircle);
      clearInterval(shrinkInterval);
      alert("The safe zone has fully closed!");
      return;
    }

    map.removeLayer(currentCircle);

    currentCircle = L.circle(coord_ka, {
      radius: currentRadius,
      color: "#6495ED",
    }).addTo(map);

    // Reload objectives for new radius
    await loadObjectives(selected, currentRadius);

    startCountdown(SHRINK_INTERVAL_MS);
  }, SHRINK_INTERVAL_MS);
}

document.getElementById("startGameButton").onclick = gameStart;
