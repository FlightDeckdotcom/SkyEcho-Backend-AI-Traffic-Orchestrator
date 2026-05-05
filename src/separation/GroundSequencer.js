class GroundSequencer {
  constructor() { this.occupied = new Map(); }
  pathClear(pathKey, aircraftId) { const holder = this.occupied.get(pathKey); return !holder || holder === aircraftId; }
  occupy(pathKey, aircraftId) { this.occupied.set(pathKey, aircraftId); }
  release(pathKey, aircraftId) { if (this.occupied.get(pathKey) === aircraftId) this.occupied.delete(pathKey); }
}
module.exports = { GroundSequencer };
