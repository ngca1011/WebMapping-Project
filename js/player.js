/* eslint-disable no-undef */
export class Player {
  constructor(game, id, lat, lon, hp = 100, score = 0, visitedObjectives = []) {
    this.game = game;
    this.id = id;
    this.lat = lat;
    this.lon = lon;
    this.hp = hp;
    this.score = score;
    this.visitedObjectives = new Set(visitedObjectives);
    this.marker = this.createMarker();
    this.isDragging = false;

    this.marker.on("dragstart", () => (this.isDragging = true));
    this.marker.on("dragend", () => (this.isDragging = false));
  }

  createMarker() {
    const icon = this.game.icons[`player${this.id}`] || this.game.icons.player1;

    const marker = L.marker([this.lat, this.lon], {
      draggable: true,
      icon,
      autoPan: true,
      autoPanPadding: [80, 80],
      autoPanSpeed: 20,
    }).addTo(this.game.map);

    marker.playerId = this.id;

    marker.on("dragend", (e) => {
      const newPos = e.target.getLatLng();
      this.move(newPos);
    });

    return marker;
  }

  async move(pos) {
    this.lat = pos.lat;
    this.lon = pos.lng;
    this.marker.setLatLng(pos);

    let scored = false;
    if (this.game.objectiveClusterLayer) {
      this.game.objectiveClusterLayer.eachLayer((layer) => {
        if (this.checkObjective(layer)) scored = true;
      });
    }

    if (scored) this.game.renderHUD();
    await this.save();
  }

  checkObjective(layer) {
    const f = layer.feature;
    if (!f?.geometry?.coordinates) return false;

    const [lng, lat] = f.geometry.coordinates;
    const type = f.properties.amenity;
    const key = `${lat.toFixed(6)},${lng.toFixed(6)},${type}`;

    if (this.visitedObjectives.has(key)) return false;

    const dist = this.game.map.distance(this.marker.getLatLng(), [lat, lng]);
    if (dist > this.game.OBJECTIVE_GRAB_RANGE) return false;

    this.visitedObjectives.add(key);
    this.score += 1;

    L.popup({ closeButton: false, autoClose: true })
      .setLatLng([lat, lng])
      .setContent("✅ Earned Point!")
      .openOn(this.game.map);

    if (this.game.objectiveClusterLayer?.hasLayer(layer)) {
      this.game.objectiveClusterLayer.removeLayer(layer);
    }

    return true;
  }

  async create() {
    try {
      await fetch(`http://localhost:3000/api/players/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: this.game.gameId,
          id: this.id,
          lat: this.lat,
          lon: this.lon,
        }),
      });
    } catch (e) {
      console.warn("Failed to create player", e);
    }
  }

  async save(hpUpdate = false) {
    if (!this.game.gameId) {
      console.warn("No gameId provided to save()");
      return;
    }
    try {
      let payload = {
        gameId: this.game.gameId,
        hp: this.hp,
        id: this.id,
      };
      if (!hpUpdate)
        payload = {
          ...payload,
          lat: this.lat,
          lon: this.lon,
          score: this.score,
          visitedObjectives: Array.from(this.visitedObjectives),
        };
      await fetch(`http://localhost:3000/api/players/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn("Failed to save player", e);
    }
  }

  setDraggable(allowed) {
    if (allowed) this.marker.dragging.enable();
    else this.marker.dragging.disable();
  }
}
