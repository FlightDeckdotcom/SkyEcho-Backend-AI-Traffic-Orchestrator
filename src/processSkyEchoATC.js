
/* SkyEchoCabin v6.9.62 — Procedure-Aware 4D ATC Synthesis Engine
   Safe install: no React DOM rewriting, no MutationObserver text replacement.
   Exposes: window.processSkyEchoATC(transcript, flightPlan, liveTelemetry, priorState)
*/
(function(){
  "use strict";
  if (window.__SkyEchoProcedureAwareEngineV6962) return;
  window.__SkyEchoProcedureAwareEngineV6962 = true;

  const WORD_NUM = {
    0:"zero",1:"one",2:"two",3:"three",4:"four",5:"five",6:"six",7:"seven",8:"eight",9:"niner"
  };

  const AIRWAY_RE = /^(?:Q|J|V|Y|A|B|G|L|M|N|P|R|T|UL|UM|UN|UP|UR|UT|UW|BR)\d{1,4}[A-Z]?$/i;
  const SPEED_LEVEL_RE = /^(?:N\d{4}F\d{2,3}|K\d{4}F\d{2,3}|M\d{3}F\d{2,3}|N\d{4}A\d{3}|K\d{4}A\d{3}|M\d{3}A\d{3}|F\d{2,3}|FL\d{2,3}|\d{3,4}KT?)$/i;
  const FIX_RE = /^[A-Z]{2,5}$/;
  const PROC_RE = /^[A-Z]{2,6}\d[A-Z]?$/;

  const state = window.__skyechoProcedureAwareStateV6962 = window.__skyechoProcedureAwareStateV6962 || {
    phase: "unknown",
    controller: "Center",
    lastInstruction: null,
    lastPilotTranscript: "",
    lastAtcText: "",
    activeLeg: "auto",
    routeProgressIndex: -1,
    established: null,
    lastFix: null,
    nextFix: null,
    lastRunway: null,
    lastApproach: null,
    history: []
  };

  function digitWords(value){
    return String(value ?? "").replace(/[^0-9]/g,"").split("").map(d => WORD_NUM[d] || d).join(" ");
  }

  function headingWords(value){
    const n = Math.round(Number(value) || 0);
    const s = String(((n % 360) + 360) % 360).padStart(3,"0");
    return "heading " + s.split("").map(d => WORD_NUM[d] || d).join(" ");
  }

  function altitudeWords(value){
    const raw = String(value ?? "").trim().toUpperCase();
    if (!raw) return "";
    if (raw.startsWith("FL")) return "flight level " + digitWords(raw);
    let n = Number(raw.replace(/[^0-9.-]/g,""));
    if (!Number.isFinite(n)) return raw.toLowerCase();
    if (n >= 18000) return "flight level " + digitWords(Math.round(n/100));
    if (n === 0) return "zero";
    if (n % 1000 === 0) return WORD_NUM[Math.floor(n/1000)] + " thousand";
    if (n % 500 === 0) return WORD_NUM[Math.floor(n/1000)] + " thousand five hundred";
    return digitWords(Math.round(n));
  }

  function speedWords(value){
    const n = String(value ?? "").replace(/[^0-9]/g,"");
    return digitWords(n) + " knots";
  }

  function runwayWords(rwy){
    const s = String(rwy || "").toUpperCase().replace(/^RWY/,"").padStart(2,"0");
    const side = s.endsWith("L") ? " left" : s.endsWith("R") ? " right" : s.endsWith("C") ? " center" : "";
    const nums = s.replace(/[LRC]$/,"");
    return nums.split("").map(d => WORD_NUM[d] || d).join(" ") + side;
  }

  function freqWords(freq){
    const s = String(freq || "").trim();
    if (!s) return "";
    return s.replace(".", " decimal ").split("").map(ch => ch === " " ? " " : (WORD_NUM[ch] || ch)).join(" ").replace(/\s+/g," ");
  }

  function callsignWords(callsign){
    let c = String(callsign || "Aircraft").toUpperCase().replace(/\s+/g,"");
    const m = c.match(/^([A-Z]{2,3})(\d{1,4}[A-Z]?)$/);
    if (!m) return c;
    const airline = {
      UAL:"United", AAL:"American", DAL:"Delta", BWA:"Caribbean", JBU:"JetBlue",
      BAW:"Speedbird", SWA:"Southwest", FFT:"Frontier", NKS:"Spirit"
    }[m[1]] || m[1];
    return airline + " " + m[2].split("").map(d => WORD_NUM[d] || d).join(" ");
  }

  function normalizeTranscript(raw){
    let t = String(raw || "").toLowerCase().trim();
    const repl = [
      [/quebec\s+four\s+three\s+zero/g,"q430"],
      [/quebec\s+430/g,"q430"],
      [/romeo\s+bravo\s+victor/g,"rbv"],
      [/charlie\s+oscar\s+papa\s+echo\s+sierra/g,"copes"],
      [/alpha\s+india\s+romeo\s+oscar\s+whiskey/g,"airow"],
      [/charlie\s+hotel\s+sierra\s+lima\s+yankee\s+seven/g,"chsly7"],
      [/charlie\s+hotel\s+sierra\s+lima\s+yankee\s+7/g,"chsly7"],
      [/alpha\s+november\s+uniform/g,"anu"],
      [/flight\s+level/g,"fl"],
      [/runway\s+zero\s+niner/g,"runway 09"],
      [/runway\s+zero\s+seven/g,"runway 07"],
      [/one\s+eight\s+zero/g,"180"],
      [/two\s+one\s+zero/g,"210"],
      [/two\s+five\s+zero/g,"250"],
      [/three\s+thousand/g,"3000"],
      [/two\s+thousand\s+five\s+hundred/g,"2500"]
    ];
    for (const [a,b] of repl) t = t.replace(a,b);
    return t.replace(/[-,.;]/g," ").replace(/\s+/g," ").trim();
  }

  function tokenizeRoute(route){
    return String(route || "")
      .toUpperCase()
      .split(/[\s,]+/)
      .map(t => t.replace(/[^A-Z0-9]/g,""))
      .filter(Boolean)
      .filter(t => !SPEED_LEVEL_RE.test(t) && t !== "DCT");
  }

  function isAirway(t){ return AIRWAY_RE.test(String(t||"").toUpperCase()); }
  function isProc(t){ return PROC_RE.test(String(t||"").toUpperCase()); }
  function isFix(t){ return FIX_RE.test(String(t||"").toUpperCase()) && !isAirway(t) && !isProc(t) && !SPEED_LEVEL_RE.test(t); }

  function buildRouteModel(flightPlan){
    const routeTokens = tokenizeRoute(flightPlan.route || "");
    const sid = String(flightPlan.sid || "").toUpperCase() || routeTokens.find(t => isProc(t)) || "";
    const star = String(flightPlan.star || "").toUpperCase() || [...routeTokens].reverse().find(t => isProc(t) && t !== sid) || "";
    const segments = routeTokens.map((token, idx) => ({
      token,
      index: idx,
      type: isAirway(token) ? "airway" : isProc(token) ? "procedure" : isFix(token) ? "fix" : "other",
      isSid: sid && token === sid,
      isStar: star && token === star
    }));
    const fixes = segments.filter(s => s.type === "fix");
    const starIndex = star ? routeTokens.indexOf(star) : -1;
    const fixBeforeStar = starIndex > 0 ? [...segments.slice(0, starIndex)].reverse().find(s => s.type === "fix")?.token || "" : "";
    const fixesAfterStar = starIndex >= 0 ? segments.slice(starIndex + 1).filter(s => s.type === "fix").map(s => s.token) : [];
    return { raw: flightPlan.route || "", routeTokens, sid, star, segments, fixes, fixBeforeStar, fixesAfterStar, starIndex };
  }

  function extractMentionedToken(transcript, model){
    const txt = normalizeTranscript(transcript).toUpperCase();
    const mentioned = model.segments.find(seg => new RegExp("\\b" + seg.token + "\\b","i").test(txt));
    const airway = (txt.match(/\b(?:Q|J|V|Y|A|B|G|L|M|N|P|R|T|UL|UM|UN|UP|UR|UT|UW|BR)\d{1,4}[A-Z]?\b/i)||[])[0];
    return { mentioned: mentioned || null, airway: airway ? airway.toUpperCase() : "" };
  }

  function deriveController(flightPlan, telemetry, transcript, model, prior){
    const dist = Number(telemetry.distanceToDestination ?? telemetry.distance_nm_dest ?? telemetry.distance ?? 999);
    const gs = Number(telemetry.groundSpeed ?? telemetry.groundspeed ?? 0);
    const alt = Number(telemetry.altitude ?? 0);
    const vs = Number(telemetry.verticalSpeed ?? telemetry.vs ?? 0);
    const txt = normalizeTranscript(transcript);

    if (gs < 30 && alt < 2000 && !/airborne|passing|climbing|departure/i.test(txt)) return "Ground";
    if (alt <= 2500 && /holding short|ready for departure|cleared for takeoff|runway/i.test(txt)) return "Tower";
    if (alt > 500 && alt < 18000 && /passing|climbing|departure|with you/i.test(txt) && dist > 40) return "Departure";
    if (dist <= 45 || vs < -300 || /descending|arrival|star|approach|ils|rnav|localizer|established|final/i.test(txt)) return "Approach";
    return "Center";
  }

  function deriveIntent(transcript, model){
    const txt = normalizeTranscript(transcript);
    const upper = txt.toUpperCase();
    const found = extractMentionedToken(transcript, model);
    const hasApproachType = /\b(ils|rnav|vor|ndb|visual|localizer|loc)\b/i.test(txt);
    const hasRunway = /\brunway\s+\d{1,2}[lrc]?\b/i.test(txt);
    const established = /\bestablished\b/i.test(txt);
    const holding = /\b(hold|holding)\b/i.test(txt);
    const descent = /\b(descend|descending|descent|lower|ready for lower)\b/i.test(txt);
    const checkin = /\b(with you|checking in|passing|level|maintaining|climbing|descending)\b/i.test(txt);
    const report = /\b(passing|over|abeam|crossing|report|established on)\b/i.test(txt);

    if (established && holding) return { intent:"hold_established", found };
    if (established && found.airway && !hasApproachType && !hasRunway) return { intent:"airway_established", airway: found.airway, found };
    if (established && (hasApproachType || hasRunway || /\bfinal|localizer|glideslope|glidepath\b/i.test(txt))) return { intent:"approach_established", found };
    if (/\brequest\b.*\b(ils|rnav|visual|approach)\b/i.test(txt)) return { intent:"request_approach", found };
    if (descent) return { intent:"descent_request", found };
    if (report && found.mentioned && found.mentioned.type === "fix") return { intent:"fix_report", found };
    if (report && found.airway) return { intent:"airway_report", airway: found.airway, found };
    if (checkin) return { intent:"checkin", found };
    if (/\bcleared|climb|descend|maintain|heading|direct|squawk|hold|taxi|takeoff|land|approved|wilco|roger|copy\b/i.test(txt)) return { intent:"readback", found };
    return { intent:"unknown", found };
  }

  function currentRoutePosition(intent, model){
    const seg = intent?.found?.mentioned;
    if (seg) {
      state.routeProgressIndex = Math.max(state.routeProgressIndex || -1, seg.index);
      if (seg.type === "fix") state.lastFix = seg.token;
    }
    const idx = state.routeProgressIndex || -1;
    const nextSeg = model.segments.slice(idx + 1).find(s => s.type === "fix" || s.isStar);
    return { currentIndex: idx, nextSeg };
  }

  function derivePhase(controller, flightPlan, telemetry, intent, model){
    const dist = Number(telemetry.distanceToDestination ?? 999);
    const alt = Number(telemetry.altitude ?? 0);
    const vs = Number(telemetry.verticalSpeed ?? 0);

    if (controller === "Ground") return "ground";
    if (controller === "Tower" && alt < 2500) return "tower";
    if (controller === "Departure") return "sid_departure";

    if (intent.intent === "approach_established") return "final_approach";
    if (intent.intent === "hold_established") return "holding";
    if (intent.intent === "request_approach") return "approach_requested";

    if (controller === "Approach") {
      if (dist <= 8 && alt <= 3000) return "final_vector_or_tower_handoff";
      if (dist <= 25) return "approach_vectoring";
      return "star_arrival";
    }

    if (model.star && (dist <= 90 || vs < -200 || intent.intent === "descent_request")) return "star_arrival";
    return "enroute";
  }

  function runwayHeading(runway){
    const n = Number(String(runway || "").replace(/[^0-9]/g,""));
    return Number.isFinite(n) && n > 0 ? (n * 10) % 360 : 90;
  }

  function angularDiff(a,b){
    a = Number(a)||0; b = Number(b)||0;
    let d = Math.abs((((a-b)%360)+540)%360-180);
    return d;
  }

  function vectorPlan(flightPlan, telemetry, phase){
    const rwy = String(flightPlan.arrRunway || flightPlan.runway || state.lastRunway || "09").toUpperCase().replace(/^RWY/,"");
    const final = runwayHeading(rwy);
    const hdg = Number(telemetry.heading ?? final);
    const dist = Number(telemetry.distanceToDestination ?? 999);

    const downwind = (final + 180) % 360;
    const baseLeft = (final + 90) % 360;
    const baseRight = (final + 270) % 360;
    const base = angularDiff(hdg, baseLeft) < angularDiff(hdg, baseRight) ? baseLeft : baseRight;
    const intercept = (final + (angularDiff(hdg, (final+30)%360) < angularDiff(hdg, (final+330)%360) ? 30 : -30) + 360) % 360;

    if (phase === "approach_vectoring" && dist > 18) return { leg:"downwind", heading:downwind, altitude:3000, speed:210 };
    if (phase === "approach_vectoring" && dist > 10) return { leg:"base", heading:base, altitude:3000, speed:180 };
    return { leg:"intercept", heading:intercept, altitude:2500, speed:180 };
  }

  function cleanProcedureName(name, fallback){
    return String(name || fallback || "").toUpperCase().replace(/[^A-Z0-9]/g,"");
  }

  function outputFor(transcript, flightPlan, telemetry, priorState){
    const fp = {
      callsign: flightPlan.callsign || flightPlan.flight || flightPlan.callSign || priorState?.callsign || "Aircraft",
      departure: flightPlan.departure || flightPlan.origin || "",
      arrival: flightPlan.arrival || flightPlan.destination || flightPlan.dest || "",
      sid: flightPlan.sid || "",
      star: flightPlan.star || "",
      route: flightPlan.route || "",
      requestedApproach: flightPlan.requestedApproach || flightPlan.approach || "ILS",
      arrRunway: flightPlan.arrRunway || flightPlan.runway || priorState?.lastRunway || "09",
      cruiseAltitude: flightPlan.cruiseAltitude || flightPlan.cruise || "",
      assignedSquawk: flightPlan.assignedSquawk || flightPlan.squawk || ""
    };
    const tel = {
      altitude: Number(telemetry.altitude ?? telemetry.alt ?? 0),
      heading: Number(telemetry.heading ?? telemetry.hdg ?? 0),
      groundSpeed: Number(telemetry.groundSpeed ?? telemetry.gs ?? 0),
      verticalSpeed: Number(telemetry.verticalSpeed ?? telemetry.vs ?? 0),
      distanceToDestination: Number(telemetry.distanceToDestination ?? telemetry.distToDest ?? telemetry.distance ?? 999),
      currentLatitude: Number(telemetry.currentLatitude ?? telemetry.latitude ?? telemetry.lat ?? 0),
      currentLongitude: Number(telemetry.currentLongitude ?? telemetry.longitude ?? telemetry.lon ?? 0),
      headingToNextFix: Number(telemetry.headingToNextFix ?? telemetry.nextFixHeading ?? telemetry.heading ?? 0)
    };

    const model = buildRouteModel(fp);
    const intent = deriveIntent(transcript, model);
    const controller = deriveController(fp, tel, transcript, model, priorState || state);
    const phase = derivePhase(controller, fp, tel, intent, model);
    const routePos = currentRoutePosition(intent, model);
    const cs = callsignWords(fp.callsign);
    const star = cleanProcedureName(fp.star || model.star, "arrival");
    const sid = cleanProcedureName(fp.sid || model.sid, "SID");
    const app = String(fp.requestedApproach || "ILS").toUpperCase();
    const rwy = String(fp.arrRunway || "09").toUpperCase().replace(/^RWY/,"");
    const rwyText = runwayWords(rwy);
    const airportAltimeter = fp.arrival === "TKPK" ? "three zero zero two" : "two niner niner two";

    let atc = "";
    const expected = [];

    if (phase === "ground") {
      atc = `${cs}, go ahead.`;
    }

    else if (phase === "sid_departure") {
      if (intent.intent === "checkin" || intent.intent === "fix_report") {
        atc = `${cs}, radar contact. Climb via the ${sid}, maintain ${altitudeWords(fp.cruiseAltitude || 23000)}.`;
        expected.push(fp.cruiseAltitude || "FL230");
      } else {
        atc = `${cs}, continue the ${sid}.`;
      }
    }

    else if (intent.intent === "fix_report") {
      const reported = intent.found.mentioned.token;
      const next = routePos.nextSeg;
      if (model.star && reported === model.fixBeforeStar) {
        if (tel.distanceToDestination <= 120 || tel.verticalSpeed < -200 || controller === "Approach") {
          atc = `${cs}, ${reported} copied. Descend via the ${star} arrival. ${fp.arrival || "Destination"} altimeter ${airportAltimeter}.`;
          expected.push(star);
        } else {
          atc = `${cs}, ${reported} copied. Continue present routing, expect the ${star} arrival.`;
        }
      } else if (next && next.isStar) {
        atc = `${cs}, ${reported} copied. Continue present routing, expect the ${star} arrival.`;
      } else if (next && next.type === "fix") {
        atc = `${cs}, ${reported} copied. Continue present routing, report ${next.token}.`;
        expected.push(next.token);
      } else if (model.star) {
        atc = `${cs}, ${reported} copied. Continue via the ${star} arrival.`;
      } else {
        atc = `${cs}, ${reported} copied. Continue present routing.`;
      }
    }

    else if (intent.intent === "airway_report" || intent.intent === "airway_established") {
      const airway = intent.airway || intent.found.airway;
      atc = `${cs}, roger, established on airway ${airway}. Continue present routing.`;
      if (routePos.nextSeg && routePos.nextSeg.type === "fix") {
        atc = `${cs}, roger, established on airway ${airway}. Continue present routing, report ${routePos.nextSeg.token}.`;
      }
    }

    else if (intent.intent === "hold_established") {
      atc = `${cs}, roger, established in the hold. Maintain holding as published, expect further clearance.`;
    }

    else if (phase === "star_arrival" || intent.intent === "descent_request") {
      if (star && star !== "ARRIVAL") {
        atc = `${cs}, descend via the ${star} arrival. ${fp.arrival || "Destination"} altimeter ${airportAltimeter}.`;
        expected.push(star);
      } else {
        atc = `${cs}, descend and maintain ${altitudeWords(11000)}. Expect ${app} runway ${rwyText} approach.`;
        expected.push("11000");
      }
    }

    else if (phase === "approach_vectoring" || intent.intent === "request_approach") {
      const v = vectorPlan(fp, tel, "approach_vectoring");
      if (v.leg === "downwind") {
        atc = `${cs}, reduce speed to ${speedWords(v.speed)}, fly ${headingWords(v.heading)} for downwind, descend and maintain ${altitudeWords(v.altitude)}. Expect ${app} runway ${rwyText} approach.`;
        expected.push(String(v.heading).padStart(3,"0"), String(v.altitude), String(v.speed));
      } else if (v.leg === "base") {
        atc = `${cs}, turn ${angularDiff(tel.heading, v.heading) > 120 ? "right" : "left"} ${headingWords(v.heading)}, descend and maintain ${altitudeWords(v.altitude)}.`;
        expected.push(String(v.heading).padStart(3,"0"), String(v.altitude));
      } else {
        atc = `${cs}, turn ${angularDiff(tel.heading, v.heading) > 120 ? "right" : "left"} ${headingWords(v.heading)}, maintain ${altitudeWords(v.altitude)} until established on the localizer, cleared ${app} runway ${rwyText} approach.`;
        expected.push(String(v.heading).padStart(3,"0"), String(v.altitude), app, rwy);
      }
    }

    else if (intent.intent === "approach_established" || phase === "final_vector_or_tower_handoff") {
      const headingOk = angularDiff(tel.heading, runwayHeading(rwy)) <= 25 || /established|localizer|final/i.test(normalizeTranscript(transcript));
      if (headingOk) {
        atc = `${cs}, contact tower on ${freqWords("118.20")}.`;
        expected.push("118.20");
      } else {
        const v = vectorPlan(fp, tel, "approach_vectoring");
        atc = `${cs}, fly ${headingWords(v.heading)}, maintain ${altitudeWords(v.altitude)} until established on the localizer, cleared ${app} runway ${rwyText} approach.`;
        expected.push(String(v.heading).padStart(3,"0"), String(v.altitude), app, rwy);
      }
    }

    else if (phase === "enroute" || controller === "Center") {
      if (model.star && tel.distanceToDestination <= 120) {
        atc = `${cs}, expect the ${star} arrival. Descend at pilot discretion to ${altitudeWords(24000)}.`;
        expected.push("FL240", star);
      } else {
        atc = `${cs}, roger. Maintain ${altitudeWords(fp.cruiseAltitude || tel.altitude || 30000)}.`;
      }
    }

    else {
      atc = `${cs}, roger.`;
    }

    // Absolute guardrails:
    atc = atc
      .replace(/\breport\s+([A-Z]{2,6}\d[A-Z]?)\b/g, (m,p) => p === star || p === sid ? `continue via the ${p}` : m)
      .replace(/\breport\s+(ILS|RNAV|VOR|NDB|LOCALIZER|VISUAL)\b/gi, `report established on the final approach course`)
      .replace(/\bdirect\s+([A-Z]{2,6}\d[A-Z]?)\b/g, (m,p) => p === star || p === sid ? `via the ${p}` : m)
      .replace(/\s+/g," ")
      .trim();

    const updatedState = {
      ...state,
      ...priorState,
      callsign: fp.callsign,
      phase,
      controller,
      intent: intent.intent,
      activeSid: sid,
      activeStar: star,
      requestedApproach: app,
      arrRunway: rwy,
      routeProgressIndex: state.routeProgressIndex,
      lastFix: state.lastFix,
      nextFix: routePos.nextSeg?.token || null,
      established: intent.intent.includes("established") ? intent.intent : state.established,
      lastInstruction: { text: atc, expected },
      lastPilotTranscript: transcript,
      lastAtcText: atc,
      lastTelemetry: tel,
      routeModel: {
        tokens: model.routeTokens,
        sid,
        star,
        fixBeforeStar: model.fixBeforeStar,
        fixesAfterStar: model.fixesAfterStar
      }
    };
    Object.assign(state, updatedState);
    state.history.push({ t: Date.now(), transcript, atc, phase, controller, intent: intent.intent });
    state.history = state.history.slice(-80);

    return { atcResponseText: atc, updatedState, expectedReadback: expected, debug: { model, intent, controller, phase, telemetry: tel } };
  }

  function extractNumbers(text){
    const words = {zero:"0",oh:"0",one:"1",two:"2",three:"3",four:"4",five:"5",six:"6",seven:"7",eight:"8",nine:"9",niner:"9"};
    let s = String(text || "").toLowerCase().replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|niner)\b/g, m => words[m]);
    return (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  }

  function validateReadback(transcript, instruction){
    const targets = instruction?.expected || [];
    const nums = extractNumbers(transcript);
    const missing = [];
    for (const t of targets) {
      const raw = String(t).toUpperCase();
      if (/^\d{3}$/.test(raw)) {
        const n = Number(raw);
        if (!nums.some(x => Math.abs(x - n) <= 5)) missing.push(raw);
      } else if (/^\d{4,5}$/.test(raw) || /^FL\d{2,3}$/.test(raw)) {
        const n = raw.startsWith("FL") ? Number(raw.replace(/\D/g,"")) : Number(raw);
        if (!nums.some(x => x === n || x === n/100)) missing.push(raw);
      } else if (!new RegExp("\\b" + raw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + "\\b","i").test(transcript)) {
        missing.push(raw);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  function getFlightPlanFromPage(){
    const textFields = Array.from(document.querySelectorAll("input,textarea,select")).map(x => x.value || "").join(" ");
    return {
      callsign: window.__skyechoFlightPlan?.callsign || localStorage.getItem("skyecho_callsign") || (textFields.match(/\b(?:UAL|AAL|DAL|BWA)\s?\d{1,4}\b/i)||["UAL2324"])[0].replace(/\s+/g,""),
      departure: window.__skyechoFlightPlan?.departure || localStorage.getItem("skyecho_departure") || (textFields.match(/\bK[A-Z]{3}\b/)||[""])[0],
      arrival: window.__skyechoFlightPlan?.arrival || localStorage.getItem("skyecho_arrival") || "",
      sid: window.__skyechoFlightPlan?.sid || localStorage.getItem("skyecho_sid") || "",
      star: window.__skyechoFlightPlan?.star || localStorage.getItem("skyecho_star") || "",
      route: window.__skyechoFlightPlan?.route || localStorage.getItem("skyecho_route") || textFields,
      requestedApproach: window.__skyechoFlightPlan?.requestedApproach || localStorage.getItem("skyecho_requested_approach") || "ILS",
      arrRunway: window.__skyechoFlightPlan?.arrRunway || localStorage.getItem("skyecho_arr_runway") || "09",
      cruiseAltitude: window.__skyechoFlightPlan?.cruiseAltitude || localStorage.getItem("skyecho_cruise") || "FL370",
      assignedSquawk: window.__skyechoFlightPlan?.assignedSquawk || localStorage.getItem("skyecho_squawk") || ""
    };
  }

  function getTelemetryFromPage(){
    const t = window.__skyechoTelemetryState || window.__skyechoLastKnownTelemetry || {};
    return {
      latitude: t.latitude ?? t.lat ?? 0,
      longitude: t.longitude ?? t.lon ?? 0,
      altitude: t.altitude ?? t.alt ?? 0,
      heading: t.heading ?? t.hdg ?? 0,
      groundSpeed: t.groundSpeed ?? t.gs ?? 0,
      verticalSpeed: t.verticalSpeed ?? t.vs ?? 0,
      distanceToDestination: t.distanceToDestination ?? t.distToDest ?? t.distance ?? 999,
      headingToNextFix: t.headingToNextFix ?? t.nextFixHeading ?? t.heading ?? 0
    };
  }

  window.processSkyEchoATC = function processSkyEchoATC(transcript, flightPlan, liveTelemetry, priorState){
    return outputFor(transcript, flightPlan || getFlightPlanFromPage(), liveTelemetry || getTelemetryFromPage(), priorState || state);
  };
  window.processSkyEchoReadback = validateReadback;

  function rememberPilot(text){
    const s = String(text || "");
    if (/\b(with you|passing|established|arrival|approach|ils|rnav|hold|holding|request|descend|lower|report|Q430|RBV|COPES|AIROW|CHSLY7|ANU)\b/i.test(s)) {
      state.lastPilotTranscript = s;
    }
  }

  // Safe integration: only modify outbound TTS payloads. Do NOT rewrite React DOM.
  if (window.fetch && !window.fetch.__skyechoProcedureAwareV6962) {
    const oldFetch = window.fetch.bind(window);
    window.fetch = async function(input, init){
      try {
        const url = String((input && input.url) || input || "");
        if (init && typeof init.body === "string") {
          rememberPilot(init.body);
          if (/piper|tts|voice|speak/i.test(url)) {
            const body = JSON.parse(init.body);
            if (body && typeof body.text === "string") {
              const pilot = state.lastPilotTranscript || "";
              const generated = window.processSkyEchoATC(pilot || body.text, getFlightPlanFromPage(), getTelemetryFromPage(), state);
              if (pilot && generated?.atcResponseText) {
                body.text = generated.atcResponseText;
                init = { ...init, body: JSON.stringify(body) };
              }
            }
          }
        }
      } catch {}
      return oldFetch(input, init);
    };
    window.fetch.__skyechoProcedureAwareV6962 = true;
  }

  if (window.SpeechSynthesisUtterance && !window.SpeechSynthesisUtterance.__skyechoProcedureAwareV6962) {
    const Old = window.SpeechSynthesisUtterance;
    function PatchedUtterance(text){
      try {
        const pilot = state.lastPilotTranscript || "";
        if (pilot) {
          const generated = window.processSkyEchoATC(pilot, getFlightPlanFromPage(), getTelemetryFromPage(), state);
          return new Old(generated.atcResponseText || text);
        }
      } catch {}
      return new Old(text);
    }
    PatchedUtterance.prototype = Old.prototype;
    PatchedUtterance.__skyechoProcedureAwareV6962 = true;
    window.SpeechSynthesisUtterance = PatchedUtterance;
  }

  document.addEventListener("input", e => {
    const el = e.target;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) rememberPilot(el.value || "");
  }, true);

  function addPanel(){
    if (document.getElementById("skyechoProcedureAwareBtn")) return;
    const css = document.createElement("style");
    css.id = "skyecho-procedure-aware-css";
    css.textContent = `
      #skyechoProcedureAwareBtn{position:fixed;left:18px;top:18px;z-index:2147483647;border:1px solid rgba(103,232,249,.55);background:linear-gradient(135deg,#0f766e,#2563eb);color:#fff;border-radius:999px;padding:10px 14px;font-weight:950;box-shadow:0 16px 42px rgba(0,0,0,.45)}
      #skyechoProcedureAwarePanel{position:fixed;left:18px;top:70px;z-index:2147483646;width:min(430px,calc(100vw - 36px));max-height:70vh;overflow:auto;background:rgba(2,6,23,.97);color:#f8fafc;border:1px solid rgba(103,232,249,.4);border-radius:20px;padding:14px;box-shadow:0 24px 70px rgba(0,0,0,.6);font-family:Inter,system-ui,sans-serif}
      #skyechoProcedureAwarePanel[hidden]{display:none!important}
      #skyechoProcedureAwareLog{white-space:pre-wrap;background:#0f172a;border:1px solid rgba(148,163,184,.22);border-radius:12px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:.74rem;max-height:220px;overflow:auto}
      #skyechoProcedureAwarePanel button{border:0;border-radius:12px;padding:8px 10px;background:#1e293b;color:#fff;font-weight:800}
    `;
    document.head.appendChild(css);
    const b = document.createElement("button");
    b.id = "skyechoProcedureAwareBtn";
    b.textContent = "4D ATC Engine";
    const p = document.createElement("div");
    p.id = "skyechoProcedureAwarePanel";
    p.hidden = true;
    p.innerHTML = '<h3 style="margin:0 0 8px">SkyEcho 4D Procedure-Aware ATC v6.9.62</h3><p style="color:#bfdbfe;margin-top:0">SIDs/STARs are tracked as procedures, not waypoints. ILS/RNAV are approaches, not reportable fixes. Safe mode: no React DOM rewriting.</p><button id="skyechoProcedureAwareTest">Run test phrase</button><div id="skyechoProcedureAwareLog">Loaded.</div>';
    document.body.appendChild(b);
    document.body.appendChild(p);
    b.onclick = () => { p.hidden = !p.hidden; };
    document.getElementById("skyechoProcedureAwareTest").onclick = () => {
      const result = window.processSkyEchoATC("UAL2324 passing the last fix before CHSLY7, request lower", {
        callsign:"UAL2324", departure:"KJFK", arrival:"KCLT", route:"RBV Q430 COPES Q75 GVE AIROW CHSLY7", star:"CHSLY7", requestedApproach:"ILS", arrRunway:"09", cruiseAltitude:"FL370"
      }, { altitude:14000, heading:210, groundSpeed:290, verticalSpeed:-900, distanceToDestination:65 });
      document.getElementById("skyechoProcedureAwareLog").textContent = JSON.stringify(result, null, 2);
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addPanel);
  else addPanel();
})();

