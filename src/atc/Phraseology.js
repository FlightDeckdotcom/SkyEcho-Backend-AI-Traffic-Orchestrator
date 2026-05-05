function runwayPhrase(rwy) { return `runway ${String(rwy || '07').padStart(2, '0').split('').map(d => ({0:'zero',1:'one',2:'two',3:'three',4:'four',5:'five',6:'six',7:'seven',8:'eight',9:'nine'}[d])).join(' ')}`; }
function taxiOut(ac, runway = '07', via = 'Alpha') { return `${ac.spokenCallsign}, taxi to ${runwayPhrase(runway)} via ${via}, hold short ${runwayPhrase(runway)}.`; }
function takeoff(ac, runway = '07') { return `${ac.spokenCallsign}, ${runwayPhrase(runway)}, cleared for takeoff, fly runway heading.`; }
function holdShort(ac, runway = '07', reason = 'traffic ahead') { return `${ac.spokenCallsign}, hold short ${runwayPhrase(runway)}. ${reason}. Expect departure in about sixty seconds.`; }
function land(ac, runway = '07') { return `${ac.spokenCallsign}, ${runwayPhrase(runway)}, wind zero nine zero at one five, cleared to land.`; }
function continueFinal(ac, runway = '07', reason = 'departure traffic') { return `${ac.spokenCallsign}, continue ${runwayPhrase(runway)}, ${reason} will depart prior to your arrival.`; }
function taxiIn(ac, dest = 'ramp', via = 'Alpha') { return `${ac.spokenCallsign}, taxi to the ${dest} via ${via}. Hold short of all active runways.`; }
function clearance(ac, route, runway, altitude, squawk) { return `${ac.spokenCallsign}, cleared to ${ac.dest} via ${route.join(' ') || 'as filed'}, depart ${runwayPhrase(runway)}, climb initially ${altitude}, squawk ${String(squawk).split('').join(' ')}.`; }
module.exports = { runwayPhrase, taxiOut, takeoff, holdShort, land, continueFinal, taxiIn, clearance };
