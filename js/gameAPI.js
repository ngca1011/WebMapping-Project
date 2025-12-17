export class GameAPI {
  static async getGame(gameId) {
    return fetch(`http://localhost:3000/api/game/${gameId}`).then((r) =>
      r.json()
    );
  }

  static async updateGameState(gameId, patch) {
    return fetch(`http://localhost:3000/api/game/${gameId}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  static async createGame(gameState) {
    return fetch("http://localhost:3000/api/game/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameState }),
    });
  }

  static async fetchObjectives(objectiveTypes, lat, lon, currentRadius) {
    const url = `http://localhost:3000/geojson?types=${objectiveTypes.join(
      ","
    )}&lat=${lat}&lon=${lon}&radius=${currentRadius}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  static async geocode(q) {
    return await fetch(
        `http://localhost:3000/geocode?q=${encodeURIComponent(q)}`
      );
  }
}
