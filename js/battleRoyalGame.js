/* eslint-disable no-undef */
export class BattleRoyaleGame {
  constructor() {
    this.city_coord = [49.01578, 8.39137];
    this.map = L.map("map").setView(this.city_coord, 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(this.map);

    this.players = {};
    this.controlledPlayerId = 1;
    this.gameState = {
      status: "SETUP",
      safeZoneCenter: this.city_coord,
      currentRadius: 6000,
      objectiveTypes: [],
      lastShrinkTimestamp: Date.now(),
    };

    this.currentCircle = null;
    this.objectiveClusterLayer = null;
    this.allObjectivesGeoJSON = null;

    this.hpInterval = null;
    this.shrinkTimeout = null;

    this.SHRINK_INTERVAL_MS = 60000;
    this.SHRINK_RADIUS = 500;
    this.OBJECTIVE_GRAB_RANGE = 30;

    this.setupIcons();
    this.setupEventListeners();
    this.loadFullStateFromServer();
  }

  setupIcons() {
    const icon_size = 25;
    this.icons = {
      bar: L.icon({
        iconUrl: "./assets/bar.png",
        iconSize: [icon_size, icon_size],
      }),
      cafe: L.icon({
        iconUrl: "./assets/cafe.png",
        iconSize: [icon_size, icon_size],
      }),
      post_office: L.icon({
        iconUrl: "./assets/post_office.png",
        iconSize: [icon_size, icon_size],
      }),
      pub: L.icon({
        iconUrl: "./assets/pub.png",
        iconSize: [icon_size, icon_size],
      }),
      restaurant: L.icon({
        iconUrl: "./assets/restaurant.png",
        iconSize: [icon_size, icon_size],
      }),
      player1: L.divIcon({
        html: '<div style="background:#007bff;color:white;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:1.2em; border: 3px solid #fff; box-shadow: 0 0 5px rgba(0,0,0,0.5);">P1</div>',
        iconSize: [46, 46],
        className: "",
      }),
      player2: L.divIcon({
        html: '<div style="background:#dc3545;color:white;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:1.2em; border: 3px solid #fff; box-shadow: 0 0 5px rgba(0,0,0,0.5);">P2</div>',
        iconSize: [46, 46],
        className: "",
      }),
    };
  }

  startCountdown(durationMs, initialRemainingMs = durationMs) {
    const targetTime = Date.now() + initialRemainingMs;
    const timerEl = document.getElementById("timer");
    if (window.countdownInterval) clearInterval(window.countdownInterval);

    const update = () => {
      const remainingMs = Math.max(0, targetTime - Date.now());
      if (remainingMs > 0) {
        const remaining = Math.floor(remainingMs / 1000);
        const mins = String(Math.floor(remaining / 60)).padStart(2, "0");
        const secs = String(remaining % 60).padStart(2, "0");
        timerEl.textContent = `Next shrink in: ${mins}:${secs}`;
      } else {
        timerEl.textContent = "SHRINKING NOW!";
        clearInterval(window.countdownInterval);
      }
    };
    update();
    if (targetTime > Date.now())
      window.countdownInterval = setInterval(update, 1000);
  }

  async loadFullStateFromServer() {
    try {
      const res = await fetch("http://localhost:3000/api/state");
      if (!res.ok) throw new Error("Server not reachable");
      const data = await res.json();

      this.gameState = { ...this.gameState, ...(data.gameState || {}) };
      this.city_coord = this.gameState.safeZoneCenter;
      this.map.flyTo(this.city_coord, 12);

      if (data.players?.length > 0) {
        data.players.forEach((p) => {
          if (!this.players[p.id]) this.addPlayerMarker(p);
          else {
            const pl = this.players[p.id];
            pl.lat = p.lat;
            pl.lon = p.lon;
            pl.hp = p.hp;
            pl.score = p.score;
            pl.visitedObjectives = new Set(p.visitedObjectives || []);
            pl.marker.setLatLng([p.lat, p.lon]).setOpacity(p.hp > 0 ? 1 : 0.4);
          }
        });
      } else {
        await this.createAndSavePlayers();
      }

      this.renderHUD();
      this.applyActivePlayerUI();
      this.updateDraggable();
      this.updateCircle();

      if (this.gameState.status === "ACTIVE") {
        document.getElementById("configPanel").classList.add("game-active");
        document.getElementById("endGameButton").style.display = "inline-block";
        document.getElementById("configPanel").style.display = "none";
        await this.loadAllObjectivesOnce();
        this.filterObjectivesInZone();
        const remaining = Math.max(
          0,
          this.SHRINK_INTERVAL_MS -
            (Date.now() - (this.gameState.lastShrinkTimestamp || Date.now()))
        );
        this.startCountdown(this.SHRINK_INTERVAL_MS, remaining);
        this.startHPMonitor();
        this.startShrinkMonitor(remaining);
      } else {
        document.getElementById("timer").textContent = "Next shrink in: --:--";
      }
    } catch (e) {
      console.warn("Server failed, starting fresh", e);
      await this.createAndSavePlayers();
    }
  }

  //Load ALL objectives once at game start
  async loadAllObjectivesOnce() {
    if (this.allObjectivesGeoJSON) return;

    const { objectiveTypes, safeZoneCenter } = this.gameState;
    if (!objectiveTypes?.length) return;

    const [lat, lon] = safeZoneCenter;
    const BIG_RADIUS = 9000;

    document.getElementById("loadingOverlay").style.display = "flex";
    document.getElementById("loadingOverlay").querySelector("p").textContent =
      "Loading all objectives...";

    try {
      const url = `http://localhost:3000/geojson?types=${objectiveTypes.join(
        ","
      )}&lat=${lat}&lon=${lon}&radius=${BIG_RADIUS}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed");
      this.allObjectivesGeoJSON = await res.json();

      if (!this.objectiveClusterLayer) {
        this.objectiveClusterLayer = new L.markerClusterGroup({
          disableClusteringAtZoom: 18,
          spiderfyOnMaxZoom: false,
        });
        this.map.addLayer(this.objectiveClusterLayer);
      }
      this.objectiveClusterLayer.clearLayers();

      const players = Object.values(this.players);
      L.geoJSON(this.allObjectivesGeoJSON, {
        pointToLayer: (f, latlng) => {
          const type = f.properties.amenity;
          const icon = this.icons[type];
          const marker = L.marker(latlng, { icon });
          const key = `${latlng.lat.toFixed(6)},${latlng.lng.toFixed(
            6
          )},${type}`;
          if (players.some((p) => p.visitedObjectives?.has(key)))
            marker.setOpacity(0.5);
          return marker;
        },
        onEachFeature: (f, l) => {
          const name = f.properties.name || f.properties.brand || "Unnamed";
          l.bindPopup(
            `<h3>${name}</h3><p>${f.properties.amenity || "Place"}</p>`
          );
        },
      }).eachLayer((l) => this.objectiveClusterLayer.addLayer(l));

      console.log(
        `Loaded ${this.allObjectivesGeoJSON.features.length} objectives!`
      );
    } catch (e) {
      console.error("Failed to load objectives", e);
      alert("Could not load objectives. Check internet/server.");
    } finally {
      document.getElementById("loadingOverlay").style.display = "none";
    }
  }

  filterObjectivesInZone() {
    if (
      !this.objectiveClusterLayer ||
      !this.currentCircle ||
      !this.allObjectivesGeoJSON
    )
      return;

    const center = this.currentCircle.getLatLng();
    const radius = this.currentCircle.getRadius();

    this.objectiveClusterLayer.eachLayer((marker) => {
      const dist = this.map.distance(marker.getLatLng(), center);

      if (dist <= radius) {
        if (!this.objectiveClusterLayer.hasLayer(marker)) {
          this.objectiveClusterLayer.addLayer(marker);
        }
      } else {
        if (this.objectiveClusterLayer.hasLayer(marker)) {
          this.objectiveClusterLayer.removeLayer(marker);
        }
      }
    });

    this.objectiveClusterLayer.refreshClusters();
  }

  async savePlayerToServer(id) {
    const p = this.players[id];
    if (!p) return;
    fetch(`http://localhost:3000/api/players/update/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: p.lat,
        lon: p.lon,
        hp: p.hp,
        score: p.score,
        visitedObjectives: Array.from(p.visitedObjectives),
      }),
    }).catch(() => {});
  }

  async handlePlayerMove(pos, id) {
    const player = this.players[id];
    let scored = false;
    if (this.objectiveClusterLayer) {
      this.objectiveClusterLayer.eachLayer((m) => {
        if (this.checkObjective(m, player)) {
          scored = true;
        }
      });
    }

    player.lat = pos.lat;
    player.lon = pos.lng;
    player.marker.setLatLng(pos);

    if (scored) this.renderHUD();

    await this.savePlayerToServer(id);
  }

  checkObjective(layer, player) {
    const f = layer.feature;
    if (!f?.geometry?.coordinates) return false;

    const [lng, lat] = f.geometry.coordinates;
    const type = f.properties.amenity;
    const key = `${lat.toFixed(6)},${lng.toFixed(6)},${type}`;

    // already taken by ANYONE
    if (player.visitedObjectives.has(key)) return false;

    const dist = this.map.distance(player.marker.getLatLng(), [lat, lng]);
    if (dist > this.OBJECTIVE_GRAB_RANGE) return false;

    player.visitedObjectives.add(key);
    player.score += 1;

    L.popup({ closeButton: false, autoClose: true })
      .setLatLng([lat, lng])
      .setContent("✅ Earned Point!")
      .openOn(this.map);

    if (this.objectiveClusterLayer?.hasLayer(layer)) {
      this.objectiveClusterLayer.removeLayer(layer);
    }

    return true;
  }

  updateCircle() {
    const center = this.gameState.safeZoneCenter;
    const radius = this.gameState.currentRadius;

    if (!this.currentCircle) {
      this.currentCircle = L.circle(center, {
        radius,
        color: "#3498db",
        weight: 3,
        opacity: 0.8,
        fillOpacity: 0.1,
      }).addTo(this.map);
      this.currentCircle
        .bindTooltip("", { permanent: true, direction: "center" })
        .openTooltip();
    } else {
      this.currentCircle.setLatLng(center).setRadius(radius);
    }
    const km = (radius / 1000).toFixed(1);
    this.currentCircle.getTooltip().setContent(`Safe Zone (${km} km)`);

    this.filterObjectivesInZone();
  }

  async startGame() {
    const selected = Array.from(
      document.querySelectorAll("#checkboxes input:checked")
    ).map((c) => c.value);
    if (!selected.length) return alert("Select at least one objective type");

    const radius = parseInt(document.getElementById("radiusRange").value, 10);
    document.getElementById("startGameButton").disabled = true;
    document.getElementById("loadingOverlay").style.display = "flex";
    document.getElementById("configPanel").style.display = "none";

    for (let id = 1; id <= 2; id++) {
      const p = this.players[id];
      p.hp = 100;
      p.score = 0;
      p.visitedObjectives = new Set();
      p.marker.setOpacity(1);
      await this.savePlayerToServer(id);
    }

    this.gameState = {
      status: "ACTIVE",
      safeZoneCenter: this.city_coord,
      currentRadius: radius,
      objectiveTypes: selected,
      lastShrinkTimestamp: Date.now(),
    };

    await fetch("http://localhost:3000/api/game/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameState: this.gameState }),
    });

    await this.loadAllObjectivesOnce();
    this.updateCircle();
    document.getElementById("configPanel").classList.add("game-active");
    document.getElementById("endGameButton").style.display = "inline-block";
    this.startCountdown(this.SHRINK_INTERVAL_MS, this.SHRINK_INTERVAL_MS);
    this.startHPMonitor();
    this.startShrinkMonitor(this.SHRINK_INTERVAL_MS);
    this.renderHUD();
    this.updateDraggable();

    document.getElementById("loadingOverlay").style.display = "none";
  }

  startShrinkMonitor(remainingMs = this.SHRINK_INTERVAL_MS) {
    if (this.shrinkTimeout) clearTimeout(this.shrinkTimeout);
    this.shrinkTimeout = setTimeout(() => {
      this.gameState.currentRadius = Math.max(
        0,
        this.gameState.currentRadius - this.SHRINK_RADIUS
      );
      if (this.gameState.currentRadius <= 0) return this.handleGameOver();

      this.gameState.lastShrinkTimestamp = Date.now();

      fetch("http://localhost:3000/api/game/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentRadius: this.gameState.currentRadius,
          lastShrinkTimestamp: this.gameState.lastShrinkTimestamp,
        }),
      });

      this.updateCircle();
      this.startCountdown(this.SHRINK_INTERVAL_MS, this.SHRINK_INTERVAL_MS);
      this.startShrinkMonitor(this.SHRINK_INTERVAL_MS);
    }, remainingMs);
  }

  startHPMonitor() {
    if (this.hpInterval) clearInterval(this.hpInterval);
    this.hpInterval = setInterval(() => {
      if (this.gameState.status !== "ACTIVE") return;

      let changed = false;
      for (const p of Object.values(this.players)) {
        if (p.hp <= 0) continue;
        const dist = this.map.distance(
          p.marker.getLatLng(),
          this.currentCircle.getLatLng()
        );
        if (dist > this.currentCircle.getRadius()) {
          p.hp = Math.max(0, p.hp - 5);
          p.marker.setPopupContent(`Player ${p.id} (HP: ${p.hp})`);
          if (p.hp <= 0) {
            p.marker.setOpacity(0.4);
            this.updateDraggable();
          }
          changed = true;
        }
      }
      if (changed) this.renderHUD();

      if (Object.values(this.players).filter((p) => p.hp > 0).length <= 1)
        this.handleGameOver();
    }, 1000);
  }

  async createAndSavePlayers() {
    for (let id = 1; id <= 2; id++) {
      const offsetLat = (Math.random() - 0.5) * 0.005;
      const offsetLon = (Math.random() - 0.5) * 0.005;
      const p = {
        id,
        lat: this.city_coord[0] + offsetLat,
        lon: this.city_coord[1] + offsetLon,
        hp: 100,
        score: 0,
        visitedObjectives: [],
      };
      this.addPlayerMarker(p);
      await this.savePlayerToServer(id);
    }
    this.renderHUD();
    this.applyActivePlayerUI();
    this.updateDraggable();
  }

  addPlayerMarker(p) {
    const icon = this.icons[`player${p.id}`] || this.icons.player1;
    const marker = L.marker([p.lat, p.lon], {
      draggable: true,
      icon,
      autoPan: true,
      autoPanPadding: [80, 80],
      autoPanSpeed: 20,
    }).addTo(this.map);

    marker.playerId = p.id;

    marker.on("dragend", (e) => {
      const newPos = e.target.getLatLng();
      this.handlePlayerMove(newPos, p.id);
    });
    this.players[p.id] = {
      id: p.id,
      marker,
      lat: p.lat,
      lon: p.lon,
      hp: p.hp ?? 100,
      score: p.score ?? 0,
      visitedObjectives: new Set(p.visitedObjectives || []),
    };
  }

  renderHUD() {
    const hudsEl = document.getElementById("player-huds");
    hudsEl.innerHTML = "";
    Object.values(this.players)
      .sort((a, b) => a.id - b.id)
      .forEach((p) => {
        const isControlled = p.id === this.controlledPlayerId;
        const color = p.id === 1 ? "#007bff" : "#dc3545";
        const hp = Math.max(0, p.hp ?? 0);
        const hud = document.createElement("div");
        hud.className = "player-hud";
        hud.style.border = isControlled
          ? `3px solid ${color}`
          : "1px solid #eee";
        hud.innerHTML = `
                        <div class="player-info"><span style="font-weight:bold;color:${color}">Player ${
          p.id
        }</span><span>Score: ${p.score || 0}</span></div>
                        <progress class="player-health-bar" value="${hp}" max="100"></progress>
                        <div style="font-size:0.9em;color:${
                          hp > 50 ? "#4caf50" : hp > 20 ? "#ffc107" : "#f44336"
                        };font-weight:bold">HP: ${hp}/100</div>
                    `;
        hudsEl.appendChild(hud);
      });
  }

  applyActivePlayerUI() {
    document
      .getElementById("selectP1")
      .classList.toggle("active", this.controlledPlayerId === 1);
    document
      .getElementById("selectP2")
      .classList.toggle("active", this.controlledPlayerId === 2);
  }

  updateDraggable() {
    Object.values(this.players).forEach((p) => {
      const allowed = p.id === this.controlledPlayerId && p.hp > 0;
      if (allowed) p.marker.dragging.enable();
      else p.marker.dragging.disable();
    });
    this.applyActivePlayerUI();
  }

  async handleGameReset() {
    clearInterval(this.hpInterval);
    if (this.shrinkTimeout) clearTimeout(this.shrinkTimeout);
    clearInterval(window.countdownInterval);
    this.gameState.status = "SETUP";
    this.gameState.currentRadius = 6000;
    this.allObjectivesGeoJSON = null;

    if (this.objectiveClusterLayer) {
      this.map.removeLayer(this.objectiveClusterLayer);
      this.objectiveClusterLayer = null;
    }
    document.getElementById("configPanel").style.display = "block";
    document.getElementById("configPanel").classList.remove("game-active");
    document.getElementById("endGameButton").style.display = "none";
    document.getElementById("timer").textContent = "Next shrink in: --:--";
    document.getElementById("startGameButton").disabled = false;

    for (const p of Object.values(this.players)) {
      p.hp = 100;
      p.score = 0;
      p.visitedObjectives = new Set();
      p.marker.setOpacity(1);
      await this.savePlayerToServer(p.id);
    }
    this.renderHUD();
    this.updateCircle();
    this.updateDraggable();
    alert("Game reset!");
  }

  handleGameOver() {
    if (this.gameState.status !== "ACTIVE") return;
    clearInterval(this.hpInterval);
    if (this.shrinkTimeout) clearTimeout(this.shrinkTimeout);
    clearInterval(window.countdownInterval);

    const playersSorted = Object.values(this.players).sort(
      (a, b) => b.score - a.score
    );

    const contentEl = document.getElementById("scoreboardContent");
    contentEl.innerHTML = playersSorted
      .map(
        (p) => `
        <div style="margin:5px 0;">
            <strong>Player ${p.id}</strong>: ${p.score} points ${
          p.hp > 0 ? "(Alive)" : "(Eliminated)"
        }
        </div>
    `
      )
      .join("");

    document.getElementById("scoreboardOverlay").style.display = "flex";

    document.getElementById("restartButton").onclick = () => {
      document.getElementById("scoreboardOverlay").style.display = "none";
      this.handleGameReset();
    };
  }

  async handleSearch() {
    const q = document.getElementById("searchBox").value.trim();
    if (!q) return;
    const btn = document.getElementById("searchButton");
    btn.disabled = true;
    btn.textContent = "...";
    try {
      const res = await fetch(
        `http://localhost:3000/geocode?q=${encodeURIComponent(q)}`
      );
      const data = await res.json();
      if (!data.length) return alert("Not found");
      this.city_coord = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
      this.map.flyTo(this.city_coord, 14);
      for (let id = 1; id <= 2; id++) {
        const offsetLat = (Math.random() - 0.5) * 0.005;
        const offsetLon = (Math.random() - 0.5) * 0.005;
        const pos = [
          this.city_coord[0] + offsetLat,
          this.city_coord[1] + offsetLon,
        ];
        this.players[id].marker.setLatLng(pos);
        this.players[id].lat = pos[0];
        this.players[id].lon = pos[1];
        await this.savePlayerToServer(id);
      }
      this.updateCircle();
    } catch (e) {
      console.log(e);
      alert("Search failed");
    } finally {
      btn.disabled = false;
      btn.textContent = "Search";
    }
  }

  setupEventListeners() {
    document.getElementById("startGameButton").onclick = () => this.startGame();
    document.getElementById("searchButton").onclick = () => this.handleSearch();
    document.getElementById("endGameButton").onclick = () =>
      this.handleGameReset();
    document.getElementById("selectP1").onclick = () => {
      this.controlledPlayerId = 1;
      this.updateDraggable();
    };
    document.getElementById("selectP2").onclick = () => {
      this.controlledPlayerId = 2;
      this.updateDraggable();
    };
    document.getElementById("radiusRange").oninput = (e) => {
      document.getElementById("radiusValue").textContent = e.target.value;
      if (this.currentCircle) this.currentCircle.setRadius(e.target.value);
    };
  }
}
