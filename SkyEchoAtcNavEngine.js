// SkyEchoCabin ATC Engine v7.1.0 — full flow rebuild
// Replace: src/atc/SkyEchoAtcNavEngine.js
//
// This version removes the broken loop behavior by using ONE backend state machine.
// Do not use frontend readback guards. The frontend must send every pilot transmission
// to /api/atc/respond and let this backend decide the phase.
//
// Covered flow:
// IFR clearance -> clearance readback -> push/start -> push/start readback
// -> ready taxi -> clear taxi route -> taxi readback -> holding short
// -> tower takeoff clearance -> takeoff readback -> departure/enroute
// -> route fixes/airways -> descent -> approach -> tower -> landing.
//
// Navigation:
// - N0472F320 / K0830M084 discarded.
// - Airways not used as report fixes.
// - SID/STAR not treated as direct-to fixes.
// - RBV -> Q430 -> COPES progression retained.

const SPEED_LEVEL_RE = /^(N|K)\d{4}(F|M)\d{3}$/i;
const AIRWAY_RE = /^[A-Z]{1,2}\d{1,4}[A-Z]?$/;
const PROC_RE = /^[A-Z]{2,6}\d[A-Z]?$/;
const FIX_RE = /^[A-Z]{3,6}$/;
const ICAO_RE = /^[A-Z]{4}$/;

function up(v){ return String(v ?? "").trim().toUpperCase(); }
function low(v){ return String(v ?? "").trim().toLowerCase(); }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function bool(v){ if(typeof v==="boolean") return v; if(v==null) return false; return /^(true|1|yes|ground|onground)$/i.test(String(v)); }
function cleanCallsign(v){ return up(v).replace(/\s+/g,""); }

function wordDigits(s){
  const m={"0":"zero","1":"one","2":"two","3":"three","4":"four","5":"five","6":"six","7":"seven","8":"eight","9":"niner"};
  return String(s).split("").map(x=>m[x]||x).join(" ");
}
function spokenAltitude(a){
  const raw=up(a);
  if(/^FL\d{2,3}$/.test(raw)) return "flight level "+wordDigits(raw.replace("FL",""));
  const n=num(String(a).replace(/[^\d.-]/g,""));
  if(n==null) return raw||"";
  if(n>=18000) return "flight level "+wordDigits(String(Math.round(n/100)).padStart(3,"0"));
  if(n%1000===0) return wordDigits(String(n/1000))+" thousand";
  if(n%100===0) return wordDigits(String(Math.floor(n/1000)))+" thousand "+wordDigits(String((n%1000)/100))+" hundred";
  return String(Math.round(n));
}
function heading3(h){ const n=((Math.round(num(h)??0)%360)+360)%360 || 360; return String(n).padStart(3,"0"); }
function spokenHeading(h){ return "heading "+wordDigits(heading3(h)); }
function spokenRunway(r){
  const raw=up(r).replace(/^RWY\s*/,"").replace(/^RUNWAY\s*/,"");
  const m=raw.match(/^(\d{1,2})([LCR])?$/);
  if(!m) return raw ? "runway "+raw : "runway";
  const side={L:" left",C:" center",R:" right"}[m[2]||""]||"";
  return "runway "+wordDigits(m[1].padStart(2,"0"))+side;
}
function formatCallsign(cs){
  const c=cleanCallsign(cs);
  const m=c.match(/^([A-Z]{3})(\d+)$/);
  if(!m) return c || "Aircraft";
  const airline={UAL:"United",AAL:"American",DAL:"Delta",JBU:"JetBlue",BAW:"Speedbird",SWA:"Southwest",ASA:"Alaska",SKW:"SkyWest"}[m[1]]||m[1];
  return airline+" "+wordDigits(m[2]);
}
function normalizeText(x){
  return low(x)
    .replace(/\bsilver\s*wings\b/g,"silverwings")
    .replace(/\bcivil\s+wings\b/g,"silverwings")
    .replace(/\bafi\b/g,"ifr")
    .replace(/\bappearance\b/g,"clearance")
    .replace(/\bclear ants\b/g,"clearance")
    .replace(/\bclarence\b/g,"clearance")
    .replace(/\bwhen we eat\b/g,"runway eight")
    .replace(/\bzero\s+seven\b/g,"07")
    .replace(/\bzero\s+eight\b/g,"08")
    .replace(/\brunway\s+seven\b/g,"runway 07")
    .replace(/\brunway\s+eight\b/g,"runway 08")
    .replace(/\bone\s+two\s+seven\b/g,"0127")
    .replace(/\s+/g," ")
    .trim();
}

function sanitizeRouteToken(tok){
  const t=up(tok).replace(/[(),]/g,"");
  if(!t || t==="DCT") return null;
  if(SPEED_LEVEL_RE.test(t)) return null;
  if(/^FL\d{2,3}$/.test(t)) return null;
  if(/^\d+$/.test(t)) return null;
  return t;
}
function classifyRouteToken(tok, fp={}){
  const t=sanitizeRouteToken(tok);
  if(!t) return {token:up(tok),type:"discard"};
  const sid=up(fp.sid||fp.departureProcedure), star=up(fp.star||fp.arrivalProcedure);
  const origin=up(fp.origin||fp.departure), dest=up(fp.destination||fp.arrival);
  if(t===sid && sid) return {token:t,type:"sid"};
  if(t===star && star) return {token:t,type:"star"};
  if(ICAO_RE.test(t) && (t===origin||t===dest)) return {token:t,type:"airport"};
  if(PROC_RE.test(t)) return {token:t,type:"procedure"};
  if(AIRWAY_RE.test(t)) return {token:t,type:"airway"};
  if(FIX_RE.test(t)) return {token:t,type:"fix"};
  return {token:t,type:"other"};
}
function parseFlightPlan(input={}){
  const routeRaw=String(input.routeRaw||input.route||"");
  const sid=up(input.sid||input.departureProcedure||"");
  const star=up(input.star||input.arrivalProcedure||"");
  const origin=up(input.origin||input.departure||"");
  const destination=up(input.destination||input.arrival||"");
  const tokens=routeRaw.split(/\s+/).map(sanitizeRouteToken).filter(Boolean);
  const cls=tokens.map(t=>classifyRouteToken(t,{...input,sid,star,origin,destination}));
  return {
    callsign:cleanCallsign(input.callsign||""),
    aircraft:up(input.aircraft||""),
    origin,destination,sid,star,routeRaw,
    routeTokens:cls.filter(x=>x.type!=="discard").map(x=>x.token),
    routeClassified:cls,
    routeFixes:cls.filter(x=>x.type==="fix").map(x=>x.token),
    routeAirways:cls.filter(x=>x.type==="airway").map(x=>x.token),
    procedures:[...new Set([sid,...cls.filter(x=>["sid","star","procedure"].includes(x.type)).map(x=>x.token),star].filter(Boolean))],
    requestedApproach:up(input.requestedApproach||input.approach||""),
    arrRunway:up(input.arrRunway||input.runway||input.assignedRunway||""),
    depRunway:up(input.depRunway||input.departureRunway||input.runway||""),
    cruiseAltitude:up(input.cruiseAltitude||input.cruise||""),
    initialAltitude:up(input.initialAltitude||""),
    assignedSquawk:String(input.assignedSquawk||input.squawk||"")
  };
}
function normalizeTelemetry(t={}){
  return {
    source:t.source||"unknown",
    timestamp:t.timestamp||new Date().toISOString(),
    callsign:cleanCallsign(t.callsign),
    latitude:num(t.latitude), longitude:num(t.longitude),
    altitude:num(t.altitude), heading:num(t.heading),
    groundSpeed:num(t.groundSpeed), indicatedAirspeed:num(t.indicatedAirspeed),
    verticalSpeed:num(t.verticalSpeed),
    distanceToDestination:num(t.distanceToDestination),
    distanceFromOrigin:num(t.distanceFromOrigin),
    onGround:bool(t.onGround),
    com1:t.com1||null,
    transponder:t.transponder||null,
    raw:t.raw||t
  };
}

function hasCallsign(text, callsign){
  const cs=cleanCallsign(callsign);
  if(!cs) return true;
  const compact=cleanCallsign(text);
  const digits=(cs.match(/\d+/)||[""])[0];
  return compact.includes(cs) || (digits && compact.includes(digits));
}
function isClearanceRequest(text){
  const t=normalizeText(text);
  return /\b(ifr|instrument)\b.{0,45}\b(clearance|clear)\b/.test(t) ||
         /\b(request|ready|like|need|copy|pick up)\b.{0,45}\b(ifr|clearance)\b/.test(t) ||
         /\b(clearance delivery|delivery)\b/.test(t);
}
function isPushStartRequest(text){
  const t=normalizeText(text);
  return /\b(request|ready|need|approved)?\s*(push|pushback|push back|startup|start up|engine start|start engines|request start)\b/.test(t) &&
         !isReadbackLikePush(text);
}
function isReadbackLikePush(text){
  const t=normalizeText(text);
  return /\b(pushback|push back)\b/.test(t) && /\b(startup|start up|start)\b/.test(t) && /\b(approved|roger|wilco|copy)\b/.test(t);
}
function isTaxiRequest(text){
  const t=normalizeText(text);
  return /\bready to taxi\b|\brequest taxi\b/.test(t);
}
function isTaxiReadback(text){
  const t=normalizeText(text);
  return (/\btaxi\b/.test(t) || /\brunway\b/.test(t)) && (/\bhold short\b|\bholding short\b|\bshort\b/.test(t));
}
function isHoldingShortReport(text){
  const t=normalizeText(text);
  return /\bholding short\b/.test(t) || (/\bhold short\b/.test(t) && !/\btaxi\b/.test(t));
}
function isReadyDeparture(text){
  const t=normalizeText(text);
  return /\bready\b.{0,20}\b(departure|takeoff|take off)\b/.test(t) || isHoldingShortReport(text);
}
function isTakeoffReadback(text){
  const t=normalizeText(text);
  return /\b(cleared for takeoff|cleared takeoff|takeoff)\b/.test(t) && !/\bready\b/.test(t);
}
function isActualEstablished(text){
  const t=up(text);
  if(/\bUNTIL\s+ESTABLISHED\b/.test(t)) return false;
  return /\b(ESTABLISHED|ON FINAL|FINAL APPROACH|LOCALIZER CAPTURED|GLIDESLOPE CAPTURED|ON THE LOCALIZER)\b/.test(t);
}
function transcriptIntent(transcript="", fp={}){
  const text=up(transcript), n=normalizeText(transcript);
  const wantsDescent=/\b(request|ready|like|need).{0,35}\b(lower|descent|descend)\b/.test(n)||/\bdescending\b|\btop of descent\b/.test(n);
  const onArrival=/\b(star|arrival|descending|descend|lower|tod|top of descent)\b/.test(n)||(fp.star&&text.includes(fp.star));
  const approach=/\b(ILS|RNAV|RNP|VOR|LOCALIZER|LOC|VISUAL|APPROACH|FINAL|GLIDESLOPE|GLIDEPATH)\b/.test(text)||isActualEstablished(text);
  const routeReport=/\b(PASSING|OVER|ABEAM|CROSSING|ESTABLISHED ON|TRACKING|ON THE|JOINING|DIRECT)\b/.test(text);
  const checkin=/\b(WITH YOU|CHECKING IN|PASSING|LEVEL|CLIMBING|DESCENDING|MAINTAINING)\b/.test(text);
  let intent="unknown";
  if(isClearanceRequest(transcript)) intent="clearance_request";
  else if(isPushStartRequest(transcript)) intent="push_start_request";
  else if(isTaxiRequest(transcript)) intent="taxi_request";
  else if(isHoldingShortReport(transcript)) intent="holding_short";
  else if(isTakeoffReadback(transcript)) intent="takeoff_readback";
  else if(approach) intent="approach_or_established";
  else if(wantsDescent||onArrival) intent="arrival_descent";
  else if(routeReport) intent="route_position_report";
  else if(checkin) intent="checkin";
  return {
    text, norm:n, wantsDescent,onArrival,approach,routeReport,checkin,intent,
    clearanceRequest:isClearanceRequest(transcript),
    pushStartRequest:isPushStartRequest(transcript),
    taxiRequest:isTaxiRequest(transcript),
    taxiReadback:isTaxiReadback(transcript),
    holdingShort:isHoldingShortReport(transcript),
    takeoffReadback:isTakeoffReadback(transcript)
  };
}
function deriveTelemetryPhase(flightPlan={}, telemetry={}, transcript="", state={}){
  const fp=parseFlightPlan(flightPlan), t=normalizeTelemetry(telemetry), i=transcriptIntent(transcript,fp);
  const gs=t.groundSpeed??t.indicatedAirspeed??0, alt=t.altitude, vs=t.verticalSpeed??0, dd=t.distanceToDestination;
  let phase=state.phase||"preflight", controller=state.controller||"Clearance", reason="previous";
  if(i.clearanceRequest){ phase="clearance"; controller="Clearance"; reason="explicit_clearance_request"; }
  else if(i.pushStartRequest){ phase="push_start"; controller="Ground"; reason="explicit_push_start_request"; }
  else if(i.taxiRequest || i.taxiReadback){ phase="taxi"; controller="Ground"; reason="taxi_intent"; }
  else if(i.holdingShort){ phase="holding_short"; controller="Tower"; reason="holding_short_report"; }
  else if(t.onGround && gs<5){ phase=state.phase||"ground"; controller=state.controller||"Ground"; reason="on_ground"; }
  else if(t.onGround){ phase="taxi"; controller="Ground"; reason="taxi_speed"; }
  else if(i.onArrival||i.wantsDescent){ phase=dd!=null&&dd<=45?"approach":"arrival"; controller=phase==="approach"?"Approach":"Center"; reason="arrival_intent"; }
  else if(dd!=null&&dd<=45){ phase="approach"; controller="Approach"; reason="within_approach"; }
  else if(!t.onGround && alt!=null && alt<18000 && (vs??0)>100){ phase="climb"; controller="Departure"; reason="climb"; }
  else if(!t.onGround && alt!=null){ phase="enroute"; controller="Center"; reason="airborne"; }
  if(["arrival","approach","approach_pending","approach_cleared","tower_final"].includes(state.phase||"") && ["climb","departure"].includes(phase) && !t.onGround){
    phase=(state.phase==="approach_pending"||state.phase==="approach_cleared")?"approach":state.phase;
    controller=phase==="tower_final"?"Tower":phase==="approach"?"Approach":"Center";
    reason="protected_no_arrival_regression";
  }
  return {phase,controller,reason,flightPlan:fp,telemetry:t,intent:i.intent,intentFlags:i};
}

function expected(tokens,type){ return {type,tokens:tokens.filter(Boolean).map(String)}; }
function extractNumbers(text=""){
  const t=normalizeText(text), nums=[];
  for(const m of t.matchAll(/\b\d{1,5}\b/g)) nums.push(Number(m[0]));
  if(/\bone two thousand\b|\btwelve thousand\b|\b1 2 thousand\b/.test(t)) nums.push(12000);
  if(/\bflight level one two zero\b|\bfl one two zero\b|\bflight level 120\b|\bfl120\b|\bfl 120\b/.test(t)) nums.push(12000,120);
  if(/\bthree thousand\b|\b3 thousand\b/.test(t)) nums.push(3000);
  if(/\beight thousand\b|\b8 thousand\b/.test(t)) nums.push(8000);
  if(/\bfive thousand\b|\b5 thousand\b/.test(t)) nums.push(5000);
  if(/\brunway 07\b|\brunway seven\b|\brunway zero seven\b/.test(t)) nums.push(7);
  if(/\brunway 08\b|\brunway eight\b|\brunway zero eight\b/.test(t)) nums.push(8);
  return nums;
}
function tokenMatched(tok, text, nums){
  const t=up(tok), ntext=up(text);
  if(!t) return true;
  if(ntext.includes(t)) return true;
  const n=num(t.replace(/[^\d]/g,""));
  if(n!=null){
    if(t.startsWith("FL") && (nums.includes(n) || nums.includes(n*100))) return true;
    if(nums.includes(n)) return true;
    if(n < 10 && (nums.includes(n) || nums.includes(Number("0"+n)))) return true;
  }
  if(t==="HOLD SHORT" && /\bhold(ing)? short\b/i.test(text)) return true;
  if(t==="TAXI" && /\btaxi\b/i.test(text)) return true;
  if(t==="PUSHBACK" && /\bpush(back)?\b/i.test(text)) return true;
  if(t==="STARTUP" && /\b(startup|start up|start)\b/i.test(text)) return true;
  return false;
}
function isReadbackForExpected(transcript="", state={}, fp={}){
  const type=state.expectedReadbackType||"";
  const tokens=(state.expectedReadback||[]).map(up).filter(Boolean);
  const txt=transcript, n=normalizeText(transcript), nums=extractNumbers(transcript);
  if(!type || type==="none" || !tokens.length) return false;
  if(type==="clearance" && isClearanceRequest(txt) && !/\bcleared to\b/.test(n)) return false;
  if(type==="push_start" && isPushStartRequest(txt) && !isReadbackLikePush(txt)) return false;
  if(type==="taxi" && isTaxiRequest(txt)) return false;

  if(type==="clearance"){
    return /\b(cleared to|squawk|climb|maintain|expect)\b/.test(n) && tokens.some(tok=>tokenMatched(tok,txt,nums));
  }
  if(type==="push_start"){
    return isReadbackLikePush(txt) || (/\bpush(back)?\b/.test(n) && /\b(startup|start up|start)\b/.test(n));
  }
  if(type==="taxi"){
    return isTaxiReadback(txt);
  }
  if(type==="takeoff"){
    return isTakeoffReadback(txt);
  }
  if(["descent","star_descent"].includes(type)){
    return /\b(descend|maintain|expect|ils|rnav|approach|arrival)\b/.test(n) && tokens.some(tok=>tokenMatched(tok,txt,nums));
  }
  if(type==="approach_clearance"){
    return /\b(cleared|ils|rnav|approach|localizer|runway|maintain|established)\b/.test(n) && (nums.length>0 || (fp.arrRunway && up(txt).includes(fp.arrRunway)));
  }
  if(type==="tower_handoff") return /\b(tower|contact|over to)\b/.test(n) || tokens.some(tok=>tokenMatched(tok,txt,nums));
  return tokens.some(tok=>tokenMatched(tok,txt,nums));
}
function readbackResponse(callsign, state={}, fp={}){
  const type=state.expectedReadbackType||"";
  let text=`${callsign}, readback correct.`, er=expected([],"none"), upd={expectedReadback:[],expectedReadbackType:"none"};
  if(type==="clearance"){
    text=`${callsign}, readback correct. Contact ground when ready for push and start.`;
    upd.phase="clearance_readback_complete"; upd.controller="Ground";
  } else if(type==="push_start"){
    text=`${callsign}, readback correct. Report ready to taxi.`;
    upd.phase="push_start"; upd.controller="Ground";
  } else if(type==="taxi"){
    const runway=state.departureRunway||fp.depRunway||fp.arrRunway||"";
    text=`${callsign}, readback correct. Taxi to holding point ${runway?spokenRunway(runway):"runway"}, hold short.`;
    upd.phase="taxi_readback_complete"; upd.controller="Ground";
  } else if(type==="takeoff"){
    text=`${callsign}, readback correct. Contact departure airborne.`;
    upd.phase="takeoff_cleared"; upd.controller="Tower";
  } else if(["descent","star_descent"].includes(type)){
    text=`${callsign}, readback correct. Continue descent${fp.star?` via the ${fp.star} arrival`:""}.`;
    upd.phase="arrival"; upd.controller="Center";
  } else if(type==="approach_clearance"){
    text=`${callsign}, readback correct. Report established on final.`;
    upd.phase="approach_cleared"; upd.controller="Approach";
  } else if(type==="tower_handoff"){
    upd.phase="tower_final"; upd.controller="Tower";
  } else if(type.includes("airway")||type.includes("direct")){
    upd.phase="enroute"; upd.controller="Center";
  }
  return {text,er,upd};
}

function taxiRouteForAirport(fp={}, state={}){
  const runway=state.departureRunway || fp.depRunway || fp.arrRunway || "07";
  const airport=fp.origin || "";
  let taxiway = "Alpha";
  if(airport==="TKPK") taxiway = "Alpha, then Bravo";
  if(airport==="KJFK") taxiway = "Alpha, Bravo";
  return { runway, taxiway };
}
function clearanceResponse(callsign, fp, state={}){
  const initial=state.initialAltitude || fp.initialAltitude || "5000";
  const cruise=fp.cruiseAltitude || state.cruiseAltitude || "FL320";
  const squawk=fp.assignedSquawk || state.assignedSquawk || "4660";
  const dest=fp.destination || "destination";
  const routeText=fp.sid ? ` via the ${fp.sid} departure, then as filed` : " as filed";
  return {
    text:`${callsign}, cleared to ${dest}${routeText}. Climb and maintain ${spokenAltitude(initial)}. Expect ${spokenAltitude(cruise)} ten minutes after departure. Squawk ${wordDigits(squawk)}.`,
    er:expected([dest, fp.sid, initial, squawk],"clearance"),
    update:{phase:"clearance_issued",controller:"Clearance",lastAssignedAltitude:initial,assignedSquawk:squawk}
  };
}
function pushStartResponse(callsign){
  return {
    text:`${callsign}, pushback and startup approved. Report ready to taxi.`,
    er:expected(["pushback","startup"],"push_start"),
    update:{phase:"push_start",controller:"Ground"}
  };
}
function taxiResponse(callsign, fp, state={}){
  const {runway,taxiway}=taxiRouteForAirport(fp,state);
  return {
    text:`${callsign}, taxi to holding point ${spokenRunway(runway)} via ${taxiway}, hold short ${spokenRunway(runway)}.`,
    er:expected(["taxi",runway,"hold short"],"taxi"),
    update:{phase:"taxi",controller:"Ground",departureRunway:runway,taxiRoute:taxiway}
  };
}
function takeoffResponse(callsign, fp, state={}){
  const runway=state.departureRunway||fp.depRunway||fp.arrRunway||"07";
  const wind=state.wind||"090 degrees at 8 knots";
  return {
    text:`${callsign}, wind ${wind}, ${spokenRunway(runway)}, cleared for takeoff.`,
    er:expected(["cleared for takeoff",runway],"takeoff"),
    update:{phase:"takeoff_clearance_issued",controller:"Tower"}
  };
}

function findReportedToken(transcript="", fp={}){
  const text=up(transcript);
  const items=[...(fp.routeClassified||[])].filter(x=>x.type!=="discard").sort((a,b)=>b.token.length-a.token.length);
  for(const it of items) if(it.token && text.includes(it.token)) return it;
  const aliases=[
    {re:/\bROMEO\s+BRAVO\s+VICTOR\b|\bR\s*B\s*V\b|\bRBV\b/, token:"RBV", type:"fix"},
    {re:/\bQUEBEC\s*(FOUR|4)\s*(THREE|3)\s*(ZERO|0|OH)\b|\bQ\s*430\b|\bQ430\b/, token:"Q430", type:"airway"},
    {re:/\bYANKEE\s*(THREE|3)\s*(ZERO|0|OH)\s*(NINER|9)\b|\bY\s*309\b|\bY309\b/, token:"Y309", type:"airway"}
  ];
  for(const a of aliases) if(a.re.test(text)) return {token:a.token,type:a.type};
  return null;
}
function routeIndexOf(fp, token){ return token ? (fp.routeClassified||[]).findIndex(x=>x.token===token) : -1; }
function nextNavItem(fp={}, state={}, reported=null){
  const cls=fp.routeClassified||[];
  let idx=-1;
  if(reported?.token) idx=routeIndexOf(fp, reported.token);
  if(idx<0 && state.lastReportedToken) idx=routeIndexOf(fp, state.lastReportedToken);
  if(idx<0 && Number.isFinite(Number(state.nextRouteIndex))) idx=Number(state.nextRouteIndex)-1;
  for(let i=Math.max(0,idx+1); i<cls.length; i++){
    const it=cls[i];
    if(["fix","airway","star"].includes(it.type)) return {...it,index:i};
  }
  if(fp.star) return {token:fp.star,type:"star",index:cls.length};
  return null;
}
function nextRealFixOrStar(fp={}, state={}, reported=null){
  const cls=fp.routeClassified||[];
  let idx=-1;
  if(reported?.token) idx=routeIndexOf(fp, reported.token);
  if(idx<0 && state.lastReportedToken) idx=routeIndexOf(fp,state.lastReportedToken);
  if(idx<0 && Number.isFinite(Number(state.nextRouteIndex))) idx=Number(state.nextRouteIndex)-1;
  for(let i=Math.max(0,idx+1); i<cls.length; i++){
    const it=cls[i];
    if(["fix","star"].includes(it.type)) return {...it,index:i};
  }
  if(fp.star) return {token:fp.star,type:"star",index:cls.length};
  return null;
}
function routeReportResponse(callsign, fp, state, reported){
  const nextAny=nextNavItem(fp,state,reported);
  const nextFix=nextRealFixOrStar(fp,state,reported);
  const update={lastReportedToken:reported?.token||state.lastReportedToken||null};
  if(reported?.type==="fix"){
    update.nextRouteIndex=(nextAny?.index??routeIndexOf(fp,reported.token)+1)+1;
    if(nextAny?.type==="airway") return {text:`${callsign}, ${reported.token} copied. Join airway ${nextAny.token}${nextFix?.token?` toward ${nextFix.token}`:""}.`, er:expected([nextAny.token],"join_airway"), update};
    if(nextFix?.type==="fix") return {text:`${callsign}, ${reported.token} copied. Proceed direct ${nextFix.token}, then resume own navigation.`, er:expected([nextFix.token],"direct_next_fix"), update};
    if(nextFix?.type==="star") return {text:`${callsign}, ${reported.token} copied. Continue as filed, expect the ${nextFix.token} arrival.`, er:expected([],"arrival_expect"), update};
    return {text:`${callsign}, ${reported.token} copied. Continue as filed.`, er:expected([],"roger"), update};
  }
  if(reported?.type==="airway"){
    update.nextRouteIndex=(nextAny?.index??routeIndexOf(fp,reported.token)+1)+1;
    if(nextFix?.type==="fix") return {text:`${callsign}, roger, established on airway ${reported.token}. Continue via ${reported.token} toward ${nextFix.token}.`, er:expected([],"roger"), update};
    if(nextFix?.type==="star") return {text:`${callsign}, roger, established on airway ${reported.token}. Continue as filed, expect the ${nextFix.token} arrival.`, er:expected([],"roger"), update};
    return {text:`${callsign}, roger, established on airway ${reported.token}. Continue as filed.`, er:expected([],"roger"), update};
  }
  return {text:`${callsign}, roger, position copied.`, er:expected([],"roger"), update};
}
function chooseLowerAltitude(state={}, telemetry={}){
  const alt=telemetry.altitude, last=up(state.lastAssignedAltitude||"");
  if(alt!=null){
    if(alt>13000) return "12000";
    if(alt>9000) return "8000";
    if(alt>5000) return "3000";
    return "3000";
  }
  if(last==="12000") return "8000";
  if(last==="8000") return "3000";
  return state.arrivalAltitude||"12000";
}
function runwayInterceptHeading(runway,current=90){
  const m=up(runway).match(/(\d{1,2})/);
  if(!m) return ((Math.round(num(current)??90)+30)%360)||360;
  return ((Number(m[1])*10+30)%360)||360;
}

function makeResponse(transcript="", flightPlan={}, telemetry={}, previousState={}){
  const ph=deriveTelemetryPhase(flightPlan,telemetry,transcript,previousState);
  const fp=ph.flightPlan, t=ph.telemetry, flags=ph.intentFlags;
  const callsign=formatCallsign(fp.callsign||t.callsign||previousState.callsign);
  const reported=findReportedToken(transcript,fp);
  const runway=fp.arrRunway||previousState.assignedRunway||"";
  const approach=fp.requestedApproach||previousState.requestedApproach||"approach";
  let text=`${callsign}, say request.`, er=expected([],"none");
  let st={...previousState,callsign:fp.callsign||previousState.callsign||t.callsign,phase:previousState.phase||ph.phase,controller:previousState.controller||ph.controller,lastIntent:ph.intent,lastTelemetry:t,phaseReason:ph.reason};

  // 1. Readbacks always have priority over matching as a new request.
  if(isReadbackForExpected(transcript, previousState, fp)){
    const rb=readbackResponse(callsign, previousState, fp);
    text=rb.text; er=rb.er; st={...st,...rb.upd};
  }
  // 2. Explicit pilot requests by phase.
  else if(flags.clearanceRequest){
    const cr=clearanceResponse(callsign, fp, previousState);
    text=cr.text; er=cr.er; st={...st,...cr.update};
  }
  else if(flags.pushStartRequest){
    const ps=pushStartResponse(callsign);
    text=ps.text; er=ps.er; st={...st,...ps.update};
  }
  else if(flags.taxiRequest){
    const tx=taxiResponse(callsign, fp, previousState);
    text=tx.text; er=tx.er; st={...st,...tx.update};
  }
  else if(flags.holdingShort || isReadyDeparture(transcript)){
    const tk=takeoffResponse(callsign, fp, previousState);
    text=tk.text; er=tk.er; st={...st,...tk.update};
  }
  // 3. Approach established only after actual established, not "until established".
  else if(isActualEstablished(flags.text) && (previousState.phase==="approach_cleared" || ph.phase==="approach")){
    text=`${callsign}, roger, contact tower${previousState.towerFrequency?` ${previousState.towerFrequency}`:""}.`;
    er=expected([previousState.towerFrequency].filter(Boolean),"tower_handoff");
    st.phase="tower_final"; st.controller="Tower";
  }
  // 4. Arrival/descent.
  else if(flags.onArrival||flags.wantsDescent){
    const alt=chooseLowerAltitude(previousState,t);
    if(fp.star){
      text=`${callsign}, descend via the ${fp.star} arrival. Maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([fp.star,alt],"star_descent");
    }else{
      text=`${callsign}, descend and maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([alt,approach],"descent");
    }
    st.phase="arrival"; st.controller="Center"; st.lastAssignedAltitude=alt;
  }
  // 5. Airborne route/navigation.
  else if(ph.phase==="climb"){
    const next=nextNavItem(fp,st,null), target=fp.cruiseAltitude||previousState.cruiseAltitude||"FL320";
    if(next?.type==="airway"){
      text=`${callsign}, climb and maintain ${spokenAltitude(target)}, join airway ${next.token}.`;
      er=expected([target,next.token],"climb_join_airway"); st.nextRouteIndex=next.index+1;
    }else if(next?.type==="fix"){
      text=`${callsign}, climb and maintain ${spokenAltitude(target)}, proceed direct ${next.token}.`;
      er=expected([target,next.token],"climb_direct"); st.nextRouteIndex=next.index+1;
    }else{
      text=`${callsign}, climb and maintain ${spokenAltitude(target)}.`;
      er=expected([target],"climb");
    }
    st.phase="enroute"; st.controller="Departure"; st.lastAssignedAltitude=target;
  }
  else if(ph.phase==="enroute"){
    if(flags.routeReport || reported){
      const rr=routeReportResponse(callsign,fp,st,reported);
      text=rr.text; er=rr.er; st={...st,...rr.update,phase:"enroute",controller:"Center"};
    }else{
      text=`${callsign}, roger.`;
      er=expected([],"roger");
      st.phase="enroute"; st.controller="Center";
    }
  }
  else if(ph.phase==="arrival"){
    const alt=chooseLowerAltitude(previousState,t);
    if(fp.star){
      text=`${callsign}, descend via the ${fp.star} arrival. Maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([fp.star,alt],"star_descent");
    }else{
      text=`${callsign}, descend and maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([alt,approach],"descent");
    }
    st.phase="approach_pending"; st.controller="Approach"; st.lastAssignedAltitude=alt;
  }
  else if(ph.phase==="approach" || ph.phase==="approach_pending" || ph.phase==="approach_cleared"){
    const alt=previousState.approachAltitude||"3000", hdg=previousState.interceptHeading||runwayInterceptHeading(runway,t.heading);
    text=`${callsign}, fly ${spokenHeading(hdg)}, maintain ${spokenAltitude(alt)} until established, cleared ${approach} ${runway?spokenRunway(runway):"approach"}.`;
    er=expected([String(hdg),alt,approach,runway].filter(Boolean),"approach_clearance");
    st.phase="approach_cleared"; st.controller="Approach"; st.lastAssignedAltitude=alt;
  }
  else if(ph.phase==="tower_final"){
    text=`${callsign}, ${runway?spokenRunway(runway):"runway"}, cleared to land.`;
    er=expected(["cleared to land",runway].filter(Boolean),"landing");
    st.phase="tower_final"; st.controller="Tower";
  }

  st.expectedReadback=er.tokens;
  st.expectedReadbackType=er.type;
  st.lastAtcTransmission=text.replace(/\s+/g," ").trim();
  st.updatedAt=new Date().toISOString();

  return {
    ok:true,
    atcResponseText:st.lastAtcTransmission,
    updatedState:st,
    debug:{
      version:"7.1.0",
      phase:st.phase,
      controller:st.controller,
      reason:ph.reason,
      intent:ph.intent,
      expectedReadbackType:st.expectedReadbackType,
      expectedReadback:st.expectedReadback,
      readbackDetected:isReadbackForExpected(transcript,previousState,fp),
      reportedToken:reported,
      route:{routeTokens:fp.routeTokens,routeFixes:fp.routeFixes,routeAirways:fp.routeAirways,procedures:fp.procedures,routeClassified:fp.routeClassified},
      telemetry:t
    }
  };
}
function validateReadback(transcript="", expectedTokens=[]){
  const text=up(transcript), missing=[];
  for(const tok of expectedTokens||[]){
    const t=up(tok);
    if(t && !text.includes(t)) missing.push(t);
  }
  return {ok:missing.length===0,missing};
}

export {
  parseFlightPlan, sanitizeRouteToken, classifyRouteToken, normalizeTelemetry,
  deriveTelemetryPhase, transcriptIntent, makeResponse, validateReadback,
  spokenAltitude, spokenHeading, spokenRunway, findReportedToken,
  isReadbackForExpected, isActualEstablished, isClearanceRequest,
  isTaxiReadback, isHoldingShortReport
};
export default {
  parseFlightPlan, sanitizeRouteToken, classifyRouteToken, normalizeTelemetry,
  deriveTelemetryPhase, transcriptIntent, makeResponse, validateReadback
};
