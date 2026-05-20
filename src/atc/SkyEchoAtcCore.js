// SkyEcho ATC Core v6.9.53 UltraStrict
// Backend-first parser + state machine. No synthetic traffic dependency.
// Design rule: STT text can suggest intent, but state/telemetry/expected-readback decide outcome.

export const PHASES = Object.freeze([
  'preflight', 'clearance', 'ground', 'tower_departure', 'departure',
  'enroute', 'descent', 'approach', 'tower_arrival', 'ground_arrival', 'complete'
]);

export function makeInitialAtcState(overrides = {}) {
  return {
    callsign: 'AAL318',
    spokenCallsign: 'American 318',
    aircraft: 'B738',
    origin: 'KMIA',
    destination: 'TKPK',
    route: ['FLPGA3', 'FLPGA', 'BR53V', 'RACHL', 'A511', 'ANU', 'ANU1'],
    cruiseAltitude: 37000,
    phase: 'clearance',
    controller: 'Miami Clearance',
    frequency: null,
    expectedReadback: null,
    lastInstruction: null,
    clearedAltitude: null,
    currentAirway: null,
    approachType: null,
    approachRunway: null,
    telemetry: { altitude: 0, airborne: false, groundSpeed: 0, distanceToDestinationNm: 1150 },
    history: [],
    ...overrides
  };
}

export function normalizeTranscript(raw = '') {
  let t = String(raw || '').toLowerCase().trim();
  const replacements = [
    [/alpha\s+november\s+uniform/g, 'anu'],
    [/golf\s+six\s+three\s+three/g, 'g633'],
    [/gulf\s+six\s+three\s+three/g, 'g633'],
    [/gulf\s+633/g, 'g633'],
    [/golf\s+633/g, 'g633'],
    [/bravo\s+romeo\s+five\s+three\s+victor/g, 'br53v'],
    [/bravo\s+romeo\s+53\s+victor/g, 'br53v'],
    [/alpha\s+five\s+one\s+one/g, 'a511'],
    [/flight\s+level\s+three\s+seven\s+zero/g, 'fl370'],
    [/flight\s+level\s+three\s+niner\s+zero/g, 'fl390'],
    [/flight\s+level\s+three\s+nine\s+zero/g, 'fl390'],
    [/flight\s+level\s+two\s+three\s+zero/g, 'fl230'],
    [/flight\s+level\s+one\s+five\s+zero/g, 'fl150'],
    [/flight\s+level\s+one\s+two\s+zero/g, 'fl120'],
    [/flight\s+level\s+/g, 'fl'],
    [/five\s+thousand/g, '5000'],
    [/three\s+thousand/g, '3000'],
    [/one\s+thousand\s+two\s+hundred/g, '1200'],
    [/one\s+two\s+hundred/g, '1200'],
    [/one\s+hundred/g, '100'],
    [/zero\s+eight\s+right/g, '08r'],
    [/eight\s+right/g, '08r'],
    [/zero\s+seven/g, '07'],
    [/one\s+one\s+nine\s+point\s+four\s+five/g, '119.45'],
    [/one\s+two\s+one\s+point\s+eight/g, '121.8'],
    [/one\s+one\s+eight\s+point\s+three/g, '118.3'],
    [/one\s+three\s+two\s+point\s+two\s+five/g, '132.25'],
    [/one\s+two\s+eight\s+point\s+one/g, '128.1'],
    [/one\s+one\s+eight\s+point\s+zero/g, '118.0'],
    [/one\s+one\s+eight\s+point\s+nine/g, '118.9'],
    [/two\s+nine\s+point\s+nine\s+five/g, '29.95'],
    [/three\s+zero\s+point\s+zero\s+two/g, '30.02'],
    [/niner/g, 'nine']
  ];
  for (const [pattern, replacement] of replacements) t = t.replace(pattern, replacement);
  return t.replace(/[.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractTokens(raw = '', state = {}) {
  const text = normalizeTranscript(raw);
  const callsignMatch = text.match(/\b(american|aal|delta|dal|united|ual|jetblue|jbu|bwa|caribbean|speedbird|southwest|swa)\s?(\d{1,4}[a-z]?)\b/i);
  const callsign = callsignMatch ? `${callsignMatch[1].toUpperCase()}${callsignMatch[2].toUpperCase()}` : state.callsign || '';
  const flMatch = text.match(/\bfl\s?(\d{2,3})\b/i);
  const altitudeMatch = text.match(/\b(?:level|passing|through|climbing|descending|maintain|to|at)\s+(\d{3,5})\b/i);
  const altitude = flMatch ? Number(flMatch[1]) * 100 : altitudeMatch ? Number(altitudeMatch[1]) : null;
  const airways = [...text.matchAll(/\b([a-z]{1,2}\d{1,4}[a-z]?)\b/gi)]
    .map(m => m[1].toUpperCase())
    .filter(v => !/^FL\d/i.test(v) && !/^D\d+$/i.test(v) && !/^GATE$/i.test(v));
  const knownFixes = ['FLPGA3','FLPGA','BR53V','RACHL','A511','ANU','ANU1','TKPK','KMIA','BRAVO'];
  const fixes = knownFixes.filter(f => new RegExp(`\\b${f.toLowerCase()}\\b`).test(text));
  const runwayMatch = text.match(/\brunway\s+(\d{1,2}[lrc]?|08r|8r)\b/i);
  let runway = runwayMatch ? runwayMatch[1].toUpperCase() : null;
  if (runway === '8R') runway = '08R';
  if (runway === '08R') runway = '08R';
  const headingMatch = text.match(/\bheading\s+(\d{2,3})\b/i);
  const heading = headingMatch ? headingMatch[1].padStart(3, '0') : null;
  const frequencyMatch = text.match(/\b(\d{3}\.\d{1,3})\b/) || text.match(/\b(\d{3})\s+(\d{1,3})\b/);
  const frequency = frequencyMatch ? (frequencyMatch[2] ? `${frequencyMatch[1]}.${frequencyMatch[2]}` : frequencyMatch[1]) : null;
  const squawkMatch = text.match(/\bsquawk\s+(\d{4})\b/i);
  const squawk = squawkMatch ? squawkMatch[1] : null;
  const speedMatch = text.match(/\b(\d{2,3})\s*(?:knots|kts)\b/i);
  const speed = speedMatch ? Number(speedMatch[1]) : null;
  const approachTypeMatch = text.match(/\b(ils|rnav|vor|ndb|visual|localizer|loc)\b/i);
  const approachType = approachTypeMatch ? approachTypeMatch[1].toUpperCase() : null;
  return { raw, text, callsign, altitude, airways, fixes, runway, heading, frequency, squawk, speed, approachType };
}

export function classifyIntent(raw = '', state = {}) {
  const tokens = extractTokens(raw, state);
  const text = tokens.text;
  const hasAirwayOrFix = tokens.airways.length > 0 || tokens.fixes.length > 0;
  const routeReportWords = /\b(report|passing|abeam|over|crossing|established on|joining|intercepting|tracking|level|direct)\b/i.test(text);
  const trueApproach = /\b(established\s+(ils|rnav|localizer|loc|vor|ndb|visual|final|runway)|on\s+(ils|rnav|localizer|loc|vor|ndb|visual)\s+(runway|approach)|glideslope|glidepath|final runway|cleared rnav|cleared ils)\b/i.test(text);
  const checkIn = /\b(with you|checking in|check in|passing|climbing through|descending through|flight level|level|leveling off|fl\s?\d{2,3})\b/i.test(text);
  const readback = /\b(cleared|taxi|hold short|line up|takeoff|land|climb|descend|maintain|turn|heading|direct|proceed|squawk|contact|frequency|expect|altimeter|push|start|deviation|approved|resume|reduce speed|reducing speed|speed restriction|hold at|shutdown|monitor|tower on|ground on|center on|approach on|departure on|over to|holding position|facing|vacating|switching to|gate)\b/i.test(text) || Boolean(tokens.frequency);
  const requestClearance = /\b(clearance|ifr|ready for clearance|trying to get.*clearance|requesting clearance)\b/i.test(text);
  const requestPush = /\b(request push|requesting push|pushback request)\b/i.test(text);
  const requestTaxi = /\b(ready to taxi|request taxi|taxi with)\b/i.test(text);
  const readyDeparture = /\b(holding short|ready for departure)\b/i.test(text);
  const rideRequest = /\b(better rides|smooth ride|ride comfort|requesting flight level|chop|turbulence)\b/i.test(text);
  const weatherDeviation = /\b(deviation|weather|cell|radar|left of course|right of course|clear of the weather)\b/i.test(text);
  const greeting = /\b(how are you|good morning|good afternoon|good evening|hello|hey atc|thanks|appreciate|beach time|catch you later)\b/i.test(text);
  let intent = 'unknown';
  // Protection priority
  if (routeReportWords && hasAirwayOrFix && !trueApproach) intent = 'route_position_report';
  else if (trueApproach) intent = 'approach_established';
  else if (requestClearance) intent = 'request_clearance';
  else if (requestPush) intent = 'request_push_start';
  else if (requestTaxi) intent = 'request_taxi';
  else if (readyDeparture) intent = 'ready_departure';
  else if (rideRequest) intent = 'ride_request';
  else if (weatherDeviation) intent = 'weather_deviation';
  else if (checkIn && !readback) intent = 'controller_checkin';
  else if (readback) intent = 'instruction_readback';
  else if (greeting) intent = 'non_operational_greeting';
  return { intent, tokens, guards: { airwayRouteReportGuard: routeReportWords && hasAirwayOrFix && !trueApproach, trueApproachGuard: trueApproach, readbackGuard: readback, checkinGuard: checkIn } };
}

function requiredFromExpected(expected = {}) {
  const out = [];
  for (const key of ['altitude','heading','frequency','squawk','runway','speed','approachType']) if (expected[key]) out.push({ type:key, value: expected[key] });
  if (expected.route?.length) out.push({ type:'route', value: expected.route });
  return out;
}

export function validateReadback(raw = '', expected = null, state = {}) {
  if (!expected) return { valid: false, reason: 'no_expected_readback', missing: [] };
  const tokens = extractTokens(raw, state);
  const missing = [];
  for (const item of requiredFromExpected(expected)) {
    if (item.type === 'altitude' && tokens.altitude !== item.value) missing.push(item);
    if (item.type === 'heading' && tokens.heading !== item.value) missing.push(item);
    if (item.type === 'frequency' && tokens.frequency !== item.value) missing.push(item);
    if (item.type === 'squawk' && tokens.squawk !== item.value) missing.push(item);
    if (item.type === 'speed' && tokens.speed !== item.value) missing.push(item);
    if (item.type === 'runway' && tokens.runway !== item.value) missing.push(item);
    if (item.type === 'approachType' && tokens.approachType !== item.value) missing.push(item);
    if (item.type === 'route') {
      const hasAll = item.value.every(v => tokens.fixes.includes(v) || tokens.airways.includes(v));
      if (!hasAll) missing.push(item);
    }
  }
  return { valid: missing.length === 0, missing, tokens };
}

export function applyAtcTransmission(state, atcText, meta = {}) {
  const next = { ...state, history: [...state.history] };
  const t = extractTokens(atcText, state);
  const text = t.text;
  const instruction = { type: meta.type || 'instruction' };
  if (/cleared to st kitts|cleared.*flpga3|departure frequency|squawk/.test(text)) {
    next.phase = 'clearance'; next.controller = 'Miami Clearance'; instruction.route = ['FLPGA3','FLPGA']; instruction.altitude = 37000; instruction.frequency = '119.45'; instruction.squawk = '5132';
  } else if (/contact miami ground/.test(text)) { instruction.frequency = '121.8'; next.controller = 'Miami Ground'; next.phase = 'ground'; }
  else if (/hold position/.test(text)) { next.phase = 'ground'; instruction.holdPosition = true; }
  else if (/push and start approved/.test(text)) { next.phase = 'ground'; instruction.pushStart = true; }
  else if (/taxi to runway/.test(text)) { next.phase = 'ground'; instruction.runway = t.runway || '08R'; }
  else if (/contact miami tower/.test(text)) { instruction.frequency = t.frequency || '118.3'; next.controller = 'Miami Tower'; next.phase = 'tower_departure'; }
  else if (/cleared for takeoff/.test(text)) { next.phase = 'tower_departure'; instruction.runway = t.runway || '08R'; }
  else if (/contact miami departure/.test(text)) { next.controller = 'Miami Departure'; next.phase = 'departure'; }
  else if (/stop climb/.test(text)) { next.phase = 'departure'; instruction.altitude = 5000; next.clearedAltitude = 5000; }
  else if (/maintain fl230|maintain flight level 230/.test(text)) { next.phase = 'departure'; instruction.altitude = 23000; next.clearedAltitude = 23000; }
  else if (/reduce speed to 250/.test(text)) { instruction.speed = 250; }
  else if (/contact miami center/.test(text)) { instruction.frequency = '132.25'; next.controller = 'Miami Center'; next.phase = 'enroute'; }
  else if (/maintain fl370|maintain flight level 370/.test(text)) { instruction.altitude = 37000; next.clearedAltitude = 37000; next.phase = 'enroute'; }
  else if (/maintain fl390|maintain flight level 390/.test(text)) { instruction.altitude = 39000; next.clearedAltitude = 39000; next.phase = 'enroute'; }
  else if (/contact san juan center/.test(text)) { instruction.frequency = '128.1'; next.controller = 'San Juan Center'; next.phase = 'enroute'; }
  else if (/deviation 20 degrees right/.test(text)) { instruction.deviation = 'right20'; }
  else if (/proceed direct to anu/.test(text)) { instruction.route = ['ANU']; }
  else if (/descend and maintain fl150|descend and maintain flight level 150/.test(text)) { instruction.altitude = 15000; next.clearedAltitude = 15000; next.phase = 'descent'; }
  else if (/hold at the anu/.test(text)) { instruction.route = ['ANU']; instruction.hold = true; next.phase = 'descent'; }
  else if (/contact st kitts approach/.test(text)) { instruction.frequency = '118.0'; instruction.route = ['ANU']; next.controller = 'St. Kitts Approach'; next.phase = 'approach'; }
  else if (/cleared anu1 arrival/.test(text)) { instruction.route = ['ANU1']; instruction.runway = '07'; instruction.altitude = 3000; next.phase = 'approach'; }
  else if (/heading 100/.test(text)) { instruction.heading = '100'; next.phase = 'approach'; }
  else if (/heading 070/.test(text) && /cleared rnav/.test(text)) { instruction.heading = '070'; instruction.approachType = 'RNAV'; instruction.runway = '07'; instruction.frequency = '118.9'; next.controller = 'St. Kitts Tower'; next.phase = 'approach'; }
  else if (/cleared to land/.test(text)) { instruction.runway = '07'; next.controller = 'St. Kitts Tower'; next.phase = 'tower_arrival'; }
  else if (/vacate.*bravo|taxi to the apron/.test(text)) { instruction.route = ['BRAVO']; next.controller = 'St. Kitts Tower'; next.phase = 'ground_arrival'; }
  else if (/shutdown approved|monitor ground/.test(text)) { instruction.frequency = '121.9'; next.controller = 'St. Kitts Ground'; next.phase = 'complete'; }

  const requiresReadback = Object.keys(instruction).some(k => !['type'].includes(k));
  next.lastInstruction = instruction;
  next.expectedReadback = requiresReadback ? instruction : null;
  next.history.push({ speaker:'ATC', text: atcText, phase: next.phase, expectedReadback: next.expectedReadback });
  return next;
}

export function processPilotTransmission(state, pilotText) {
  const classified = classifyIntent(pilotText, state);
  const next = { ...state, history: [...state.history] };
  const check = state.expectedReadback ? validateReadback(pilotText, state.expectedReadback, state) : null;
  let accepted = true, action = 'logged';

  // Do not allow route airway reports to become approach-established unless phase and runway/approach context agrees.
  if (classified.intent === 'approach_established' && !['approach','tower_arrival'].includes(state.phase)) {
    accepted = false; action = 'blocked_wrong_phase_approach_established';
  } else if (state.expectedReadback && classified.intent !== 'non_operational_greeting') {
    // Readback can be relaxed for conversational phrases, but required tokens remain strict.
    accepted = check.valid || classified.intent === 'route_position_report' || classified.intent === 'controller_checkin';
    action = check.valid ? 'readback_accepted' : (accepted ? 'operational_report_accepted' : 'readback_incomplete');
    if (check.valid) next.expectedReadback = null;
  }

  if (classified.intent === 'route_position_report') {
    if (classified.tokens.airways[0]) next.currentAirway = classified.tokens.airways[0];
    if (classified.tokens.fixes.includes('ANU')) next.currentAirway = 'ANU';
  }
  if (classified.tokens.altitude) next.telemetry = { ...next.telemetry, altitude: classified.tokens.altitude };
  next.history.push({ speaker:'PILOT', text: pilotText, phase: next.phase, classified, accepted, action });
  return { state: next, classified, accepted, action, readbackCheck: check };
}
