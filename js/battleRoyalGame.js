/* eslint-disable no-undef */

import { Player } from "./player.js";
import {
  createAmenityPopup,
  setupIcons,
  sleep,
  getUrlParams,
} from "./helper.js";
export class BattleRoyaleGame {
  constructor() {
    this.city_coord = [49.01578, 8.39137];
    this.map = L.map("map").setView(this.city_coord, 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(this.map);

    const { gameId, playerId } = getUrlParams();

    this.gameId = gameId;
    this.controlledPlayerId = playerId || 1;

    this.players = {};
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

    this.icons = setupIcons();
    this.setupEventListeners();
    this.loadFullStateFromServer();

    this.isLoadingObjectives = false;
  }

  async store() {
    // Joined as player 2
    if (this.gameId) {
      //await this.createAndSavePlayers();
      await this.loadFullStateFromServer();
      return;
    }
    // 1. Create game on server
    const res = await fetch("http://localhost:3000/api/game/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameState: {
          safeZoneCenter: this.city_coord,
          currentRadius: 6000,
          status: "SETUP",
        },
      }),
    });

    if (!res.ok) {
      alert("Failed to create game");
      return;
    }

    const { gameId } = await res.json();

    // 2. Save locally
    this.gameId = gameId;
    this.controlledPlayerId = 1;

    // 3. Update URL (host = player 1)
    const newUrl = `${window.location.pathname}?gameId=${gameId}&playerId=1`;
    window.history.replaceState({}, "", newUrl);

    // 4. Create players in DB
    await this.createAndSavePlayers();

    // 5. Show invite link
    const inviteLink = `${window.location.origin}${window.location.pathname}?gameId=${gameId}&playerId=2`;

    const box = document.getElementById("inviteBox");
    const link = document.getElementById("inviteLink");

    link.href = inviteLink;
    link.textContent = inviteLink;

    box.style.display = "block";

    // 6. Load game normally
    await this.loadFullStateFromServer();
  }

  async updateShrinkTimerFromServer() {
    if (!this.gameState.lastShrinkTimestamp) return;

    const elapsed = Date.now() - this.gameState.lastShrinkTimestamp;
    const remaining = Math.max(0, this.SHRINK_INTERVAL_MS - elapsed);

    await this.startCountdown(this.SHRINK_INTERVAL_MS, remaining);
  }

  async startCountdown(durationMs, initialRemainingMs = durationMs) {
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
    if (!this.gameId) return;
    try {
      const res = await fetch(`http://localhost:3000/api/game/${this.gameId}`);
      if (!res.ok) throw new Error("Server not reachable");
      const data = await res.json();

      this.gameState = { ...this.gameState, ...(data.gameState || {}) };
      this.city_coord = this.gameState.safeZoneCenter;
      this.map.flyTo(this.city_coord, 12);

      data.players.forEach((p) => {
        if (!this.players[p.id]) this.addPlayer(p);
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

      this.renderHUD();
      this.updateDraggable();
      await this.updateCircle();

      if (this.gameState.status === "ACTIVE") {
        if (!data.gameState) return;
        document.getElementById("configPanel").classList.add("game-active");
        document.getElementById("endGameButton").style.display = "inline-block";
        document.getElementById("configPanel").style.display = "none";
        await this.loadAllObjectivesOnce();
        await this.updateShrinkTimerFromServer();
        if (this.controlledPlayerId === 1) {
          this.startHPMonitor();
          await this.startShrinkMonitor(remaining);
        }
      } else {
        document.getElementById("timer").textContent = "Next shrink in: --:--";
      }

      // START POLLING FOR UPDATES
      this.startPolling();
    } catch (e) {
      console.warn("Server failed, starting fresh", e);
    }
  }

  startPolling() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);

    this.pollingInterval = setInterval(async () => {
      if (!this.gameId) return;

      try {
        const res = await fetch(
          `http://localhost:3000/api/game/${this.gameId}`
        );
        if (!res.ok) return;

        const data = await res.json();

        const newCenter = data.gameState.safeZoneCenter;
        if (
          this.city_coord[0] !== newCenter[0] ||
          this.city_coord[1] !== newCenter[1]
        ) {
          this.gameState.safeZoneCenter = newCenter
          this.city_coord = newCenter;
          this.map.flyTo(this.city_coord, 12);
          await this.updateCircle();
        }

        // Change of state from setup to active
        if (
          this.gameState.status == "SETUP" &&
          data.gameState.status == "ACTIVE"
        ) {
          document.getElementById("configPanel").style.display = "none";
        }
        if (
          data.gameState.status == "SETUP" &&
          this.gameState.status == "ACTIVE"
        ) {
          await this.handleGameOver();
        }

        const prevShrinkTs = this.gameState.lastShrinkTimestamp;
        this.gameState = { ...this.gameState, ...(data.gameState || {}) };

        // Update players from server
        data.players.forEach((serverPlayer) => {
          const localPlayer = this.players[serverPlayer.id];

          if (!localPlayer) {
            this.addPlayer(serverPlayer);
            return;
          }

          // Only update if it's not the controlled player or the game is still in SETUP
          if (localPlayer.id !== this.controlledPlayerId || this.gameState.status === "SETUP") {
            localPlayer.lat = serverPlayer.lat;
            localPlayer.lon = serverPlayer.lon;
            localPlayer.marker.setLatLng([serverPlayer.lat, serverPlayer.lon]);
          }

          // --- STATS (always sync) ---
          localPlayer.hp = serverPlayer.hp;
          localPlayer.score = serverPlayer.score;
          localPlayer.visitedObjectives = new Set(
            serverPlayer.visitedObjectives || []
          );
          localPlayer.marker.setOpacity(serverPlayer.hp > 0 ? 1 : 0.4);
        });

        // Update circle if radius changed
        if (
          this.currentCircle &&
          this.gameState.currentRadius !== this.currentCircle.getRadius()
        ) {
          await this.updateCircle();
        }

        // Refresh objectives display
        if (this.gameState.status === "ACTIVE") {
          if (!this.allObjectivesGeoJSON && !this.objectiveClusterLayer) {
            console.log("HELLOOOOOO");
            await this.loadAllObjectivesOnce();
          } else if (!this.objectiveClusterLayer)
            await this.buildObjectiveLayer();

          if (
            data.gameState?.lastShrinkTimestamp &&
            data.gameState.lastShrinkTimestamp !== prevShrinkTs
          ) {
            await this.updateShrinkTimerFromServer();
          }
        }

        // Update UI
        this.renderHUD();
        this.updateDraggable();
      } catch (e) {
        console.warn("Polling error:", e);
      }
    }, 500); // Poll every 500ms
  }

  addPlayer(p) {
    const player = new Player(
      this,
      p.id,
      p.lat,
      p.lon,
      p.hp ?? 100,
      p.score ?? 0,
      p.visitedObjectives ?? []
    );
    this.players[p.id] = player;
  }

  async createAndSavePlayers() {
    for (let id = 1; id <= 2; id++) {
      const offsetLat = (Math.random() - 0.5) * 0.005;
      const offsetLon = (Math.random() - 0.5) * 0.005;
      const player = new Player(
        this,
        id,
        this.city_coord[0] + offsetLat,
        this.city_coord[1] + offsetLon
      );
      this.players[id] = player;
      await player.create();
    }
    this.renderHUD();
    this.updateDraggable();
  }

  updateDraggable() {
    Object.values(this.players).forEach((p) => {
      const allowed = p.id === this.controlledPlayerId && p.hp > 0;
      p.setDraggable(allowed);
    });
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

  async buildObjectiveLayer() {
    if (!this.objectiveClusterLayer) {
      this.objectiveClusterLayer = new L.markerClusterGroup({
        disableClusteringAtZoom: 18,
        spiderfyOnMaxZoom: false,
      });
      this.map.addLayer(this.objectiveClusterLayer);
    }

    this.objectiveClusterLayer.clearLayers();

    L.geoJSON(this.allObjectivesGeoJSON, {
      pointToLayer: (f, latlng) => {
        const type = f.properties.amenity;
        const icon = this.icons[type];
        const marker = L.marker(latlng, { icon });
        return marker;
      },
      onEachFeature: (f, l) => l.bindPopup(createAmenityPopup(f)),
    }).eachLayer((l) => this.objectiveClusterLayer.addLayer(l));

    await this.filterObjectivesInZone();
  }

  //Load ALL objectives once at game start
  async loadAllObjectivesOnce(maxRetries = 3, retryDelay = 2000) {
    if (this.allObjectivesGeoJSON || this.isLoadingObjectives) return;

    this.isLoadingObjectives = true;

    const { objectiveTypes, safeZoneCenter } = this.gameState;
    if (!objectiveTypes?.length) return;

    const [lat, lon] = safeZoneCenter;

    document.getElementById("loadingOverlay").style.display = "flex";
    document.getElementById("loadingOverlay").querySelector("p").textContent =
      "Loading all objectives...";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = `http://localhost:3000/geojson?types=${objectiveTypes.join(
          ","
        )}&lat=${lat}&lon=${lon}&radius=${this.gameState.currentRadius}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        this.allObjectivesGeoJSON = await res.json();
        await this.buildObjectiveLayer();
        console.log(
          `Loaded ${this.allObjectivesGeoJSON.features.length} objectives!`
        );
        break;
      } catch (e) {
        console.warn(`Load attempt ${attempt} failed`, e);

        if (attempt === maxRetries) {
          break;
        }

        await sleep(retryDelay);
      } finally {
        this.isLoadingObjectives = false;
      }
    }

    document.getElementById("loadingOverlay").style.display = "none";
  }

  async filterObjectivesInZone() {
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

  async updateCircle() {
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

    await this.filterObjectivesInZone();
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
    document.getElementById("inviteBox").style.display = "none";

    for (let id = 1; id <= 2; id++) {
      const p = this.players[id];
      p.hp = 100;
      p.score = 0;
      p.visitedObjectives = new Set();
      p.marker.setOpacity(1);
      await p.save();
    }

    this.gameState = {
      status: "ACTIVE",
      safeZoneCenter: this.city_coord,
      currentRadius: radius,
      objectiveTypes: selected,
      lastShrinkTimestamp: Date.now(),
    };

    await fetch(`http://localhost:3000/api/game/${this.gameId}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ACTIVE",
        safeZoneCenter: this.city_coord,
        currentRadius: radius,
        objectiveTypes: selected,
        lastShrinkTimestamp: Date.now(),
      }),
    });

    await this.loadAllObjectivesOnce();
    await this.updateCircle();
    document.getElementById("configPanel").classList.add("game-active");
    document.getElementById("endGameButton").style.display = "inline-block";
    await this.startCountdown(this.SHRINK_INTERVAL_MS, this.SHRINK_INTERVAL_MS);
    if (this.controlledPlayerId === 1) {
      this.startHPMonitor();
      await this.startShrinkMonitor(this.SHRINK_INTERVAL_MS);
    }
    this.renderHUD();
    this.updateDraggable();

    document.getElementById("loadingOverlay").style.display = "none";
  }

  async startShrinkMonitor(remainingMs = this.SHRINK_INTERVAL_MS) {
    if (!this.gameId) return;
    if (this.shrinkTimeout) clearTimeout(this.shrinkTimeout);
    this.shrinkTimeout = setTimeout(async () => {
      this.gameState.currentRadius = Math.max(
        0,
        this.gameState.currentRadius - this.SHRINK_RADIUS
      );
      if (this.gameState.currentRadius <= 0) return await this.handleGameOver();

      this.gameState.lastShrinkTimestamp = Date.now();

      fetch(`http://localhost:3000/api/game/${this.gameId}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentRadius: this.gameState.currentRadius,
          lastShrinkTimestamp: this.gameState.lastShrinkTimestamp,
        }),
      });

      await this.updateCircle();
      await this.updateShrinkTimerFromServer();
      await this.startShrinkMonitor(this.SHRINK_INTERVAL_MS);
    }, remainingMs);
  }

  startHPMonitor() {
    if (this.controlledPlayerId !== 1) return;
    if (this.hpInterval) clearInterval(this.hpInterval);
    this.hpInterval = setInterval(async () => {
      if (this.gameState.status !== "ACTIVE") return;

      let changed = false;
      for (const p of Object.values(this.players)) {
        if (p.hp <= 0) continue;
        const dist = this.map.distance(
          [p.lat, p.lon],
          this.currentCircle.getLatLng()
        );
        if (dist > this.currentCircle.getRadius()) {
          p.hp = Math.max(0, p.hp - 10);
          p.marker.setPopupContent(`Player ${p.id} (HP: ${p.hp})`);
          if (p.hp <= 0) {
            p.marker.setOpacity(0.4);
            this.updateDraggable();
          }
          changed = true;
          await p.save(true);
        }
      }
      if (changed) this.renderHUD();

      if (Object.values(this.players).filter((p) => p.hp > 0).length == 0)
        await this.handleGameOver();
    }, 1000);
  }

  async handleGameReset() {
    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    clearInterval(this.hpInterval);
    if (this.shrinkTimeout) clearTimeout(this.shrinkTimeout);
    clearInterval(window.countdownInterval);

    this.gameState = {
      ...this.gameState,
      status: "SETUP",
      currentRadius: 6000,
      objectiveTypes: [],
      lastShrinkTimestamp: Date.now(),
    };
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
      await p.save();
    }

    this.renderHUD();
    await this.updateCircle();
    this.updateDraggable();

    await fetch(`http://localhost:3000/api/game/${this.gameId}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "SETUP",
        currentRadius: 6000,
        objectiveTypes: [],
        lastShrinkTimestamp: Date.now(),
      }),
    });

    // Restart polling
    this.startPolling();
  }

  async handleGameOver() {
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

    document.getElementById("restartButton").onclick = async () => {
      document.getElementById("scoreboardOverlay").style.display = "none";
      await this.handleGameReset();
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
        await this.players[id].save();
      }
      this.gameState.safeZoneCenter = this.city_coord;
      await fetch(`http://localhost:3000/api/game/${this.gameId}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          safeZoneCenter: this.city_coord,
        }),
      });
      await this.updateCircle();
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
    document.getElementById("endGameButton").onclick = async () =>
      await this.handleGameOver();
    document.getElementById("radiusRange").oninput = async (e) => {
      const newRadius = parseInt(e.target.value, 10);
      document.getElementById("radiusValue").textContent = newRadius;

      this.gameState.currentRadius = newRadius;
      await this.updateCircle();

      if (this.gameId) {
        await fetch(`http://localhost:3000/api/game/${this.gameId}/state`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentRadius: newRadius,
          }),
        });
      }
    };
  }
}
