class ArrivalSequencer {
  constructor() { this.queues = new Map(); }
  key(airport, runway) { return `${airport}:${runway}`; }
  update(aircraft) {
    const groups = new Map();
    for (const ac of aircraft) {
      if (!['DESCENT','APPROACH','FINAL','LANDING'].includes(ac.phase)) continue;
      const k = this.key(ac.dest, ac.assignedRunway || '07');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ac);
    }
    this.queues = groups;
    for (const arr of this.queues.values()) arr.sort((a,b) => (a.distanceToAirportNm||99) - (b.distanceToAirportNm||99));
  }
  getNumber(ac) { const q = this.queues.get(this.key(ac.dest, ac.assignedRunway || '07')) || []; return q.findIndex(x => x.id === ac.id) + 1; }
}
module.exports = { ArrivalSequencer };
