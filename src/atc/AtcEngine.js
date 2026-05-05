const { resolveIntent } = require('./IntentResolver');
const Phrase = require('./Phraseology');
class AtcEngine {
  constructor({ runwaySequencer, airlineRegistry }) { this.runwaySequencer = runwaySequencer; this.airlineRegistry = airlineRegistry; }
  handlePilotEvent({ aircraft, text, airport='TKPK', runway='07' }) {
    const r = resolveIntent(text);
    if (r.intent === 'established_on_route') return { intent:r.intent, response:`${aircraft.spokenCallsign}, roger, route established. Continue present course and report the next fix.` };
    if (r.intent === 'established_final_or_ils') return { intent:r.intent, response:`${aircraft.spokenCallsign}, roger, continue final ${Phrase.runwayPhrase(runway)}.` };
    if (r.intent === 'request_taxi_in') return { intent:r.intent, response:Phrase.taxiIn(aircraft, destinationFromText(r.text), 'Alpha') };
    if (r.intent === 'ready_for_takeoff') {
      const can = this.runwaySequencer.canUseRunway(airport, runway, aircraft.id || 'user');
      if (!can.ok) return { intent:r.intent, response:Phrase.holdShort(aircraft, runway, `Traffic ${can.existing.callsign} using the runway`) };
      this.runwaySequencer.reserve({ airport, runway, aircraftId: aircraft.id || 'user', callsign: aircraft.callsign, type:'departure', ttlMs:90000 });
      return { intent:r.intent, response:Phrase.takeoff(aircraft, runway) };
    }
    return { intent:r.intent, response:`${aircraft.spokenCallsign}, say again request.` };
  }
}
function destinationFromText(t) { if (/fbo/.test(t)) return 'FBO'; if (/gate/.test(t)) return 'gate'; if (/stand/.test(t)) return 'stand'; if (/customs/.test(t)) return 'customs ramp'; if (/fuel/.test(t)) return 'fuel'; return 'ramp'; }
module.exports = { AtcEngine };
