class RunwaySequencer {
  constructor(eventBus) { this.eventBus = eventBus; this.reservations = new Map(); }
  key(airport, runway) { return `${airport}:${runway}`; }
  cleanup(now = Date.now()) { for (const [k, r] of this.reservations) if (r.expiresAt <= now || r.released) this.reservations.delete(k); }
  reserve({ airport, runway, aircraftId, callsign, type, ttlMs }) {
    this.cleanup(); const k = this.key(airport, runway);
    const existing = this.reservations.get(k);
    if (existing && existing.aircraftId !== aircraftId) return { ok: false, existing };
    const res = { airport, runway, aircraftId, callsign, type, startedAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.reservations.set(k, res); return { ok: true, reservation: res };
  }
  canUseRunway(airport, runway, aircraftId) { this.cleanup(); const r = this.reservations.get(this.key(airport, runway)); return !r || r.aircraftId === aircraftId ? { ok: true } : { ok: false, existing: r }; }
  release(airport, runway, aircraftId) { const k = this.key(airport, runway); const r = this.reservations.get(k); if (r && (!aircraftId || r.aircraftId === aircraftId)) this.reservations.delete(k); }
  snapshot() { this.cleanup(); return Array.from(this.reservations.values()); }
}
module.exports = { RunwaySequencer };
