// SkyEchoCabin ATC Navigation Engine v7.0.4 Arrival/Approach State Fix
// Replace: src/atc/SkyEchoAtcNavEngine.js
//
// Fixes:
// - Descent readbacks no longer trigger repeated arrival descents.
// - "maintain 3000 until established, cleared ILS..." readback no longer means the aircraft is established.
// - "request descent" while already at/near 12000 gives a lower descent instead of repeating 12000.
// - Approach clearance readback advances state without re-clearing.
// - Route progression RBV -> Q430 -> COPES retained from v7.0.3.
// - Airways are not report points. STAR/SID are not direct-to fixes. N0472F320 is discarded.

const SPEED_LEVEL_RE = /^(N|K)\d{4}(F|M)\d{3}$/i;
const AIRWAY_RE = /^[A-Z]{1,2}\d{1,4}[A-Z]?$/;
const PROC_RE = /^[A-Z]{2,6}\d[A-Z]?$/;
const FIX_RE = /^[A-Z]{3,6}$/;
const ICAO_RE = /^[A-Z]{4}$/;

function up(v){ return String(v ?? "").trim().toUpperCase(); }
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
  if(n==null) return raw || "";
  if(n>=18000) return "flight level "+wordDigits(String(Math.round(n/100)).padStart(3,"0"));
  if(n%1000===0) return wordDigits(n/1000)+" thousand";
  if(n%100===0) return wordDigits(Math.floor(n/1000))+" thousand "+wordDigits((n%1000)/100)+" hundred";
  return String(Math.round(n));
}
function heading3(h){ const n=((Math.round(num(h)??0)%360)+360)%360 || 360; return String(n).padStart(3,"0"); }
function spokenHeading(h){ return "heading "+wordDigits(heading3(h)); }
function spokenRunway(r){
  const raw=up(r).replace(/^RWY\s*/,"").replace(/^RUNWAY\s*/,"");
  const m=raw.match(/^(\d{1,2})([LCR])?$/);
  if(!m) return raw?("runway "+raw):"runway";
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
    cruiseAltitude:up(input.cruiseAltitude||input.cruise||""),
    assignedSquawk:String(input.assignedSquawk||input.squawk||"")
  };
}
function normalizeTelemetry(t={}){
  return {
    source:t.source||"unknown", timestamp:t.timestamp||new Date().toISOString(),
    callsign:cleanCallsign(t.callsign), latitude:num(t.latitude), longitude:num(t.longitude),
    altitude:num(t.altitude), heading:num(t.heading),
    groundSpeed:num(t.groundSpeed), indicatedAirspeed:num(t.indicatedAirspeed),
    verticalSpeed:num(t.verticalSpeed), distanceToDestination:num(t.distanceToDestination),
    distanceFromOrigin:num(t.distanceFromOrigin), onGround:bool(t.onGround),
    com1:t.com1||null, transponder:t.transponder||null, raw:t.raw||t
  };
}
function transcriptIntent(transcript="", fp={}){
  const text=up(transcript);
  const wantsDescent=/\b(REQUEST|READY|LIKE|NEED).{0,35}\b(LOWER|DESCENT|DESCEND)\b/.test(text)||/\bDESCENDING\b/.test(text)||/\bTOP OF DESCENT\b/.test(text);
  const onArrival=/\b(STAR|ARRIVAL|DESCENDING|DESCEND|LOWER|TOD|TOP OF DESCENT)\b/.test(text)||(fp.star&&text.includes(fp.star));
  const approach=/\b(ILS|RNAV|RNP|VOR|LOCALIZER|LOC|VISUAL|APPROACH|FINAL|GLIDESLOPE|GLIDEPATH)\b/.test(text)||isActualEstablished(text);
  const routeReport=/\b(PASSING|OVER|ABEAM|CROSSING|ESTABLISHED ON|TRACKING|ON THE|JOINING|DIRECT)\b/.test(text);
  const checkin=/\b(WITH YOU|CHECKING IN|PASSING|LEVEL|CLIMBING|DESCENDING|MAINTAINING)\b/.test(text);
  let intent="unknown";
  if(approach) intent="approach_or_established";
  else if(wantsDescent||onArrival) intent="arrival_descent";
  else if(routeReport) intent="route_position_report";
  else if(checkin) intent="checkin";
  return {text,wantsDescent,onArrival,approach,routeReport,checkin,intent};
}
function isActualEstablished(text){
  const t=up(text);
  // "maintain 3000 until established" is a readback, not a position report.
  if(/\bUNTIL\s+ESTABLISHED\b/.test(t)) return false;
  return /\b(ESTABLISHED|ON FINAL|FINAL APPROACH|LOCALIZER CAPTURED|GLIDESLOPE CAPTURED|ON THE LOCALIZER)\b/.test(t);
}
function deriveTelemetryPhase(flightPlan={}, telemetry={}, transcript="", state={}){
  const fp=parseFlightPlan(flightPlan), t=normalizeTelemetry(telemetry), i=transcriptIntent(transcript,fp);
  const gs=t.groundSpeed??t.indicatedAirspeed??0, alt=t.altitude, vs=t.verticalSpeed??0, dd=t.distanceToDestination;
  let phase=state.phase||"preflight", controller=state.controller||"Clearance", reason="previous";
  if(t.onGround && gs<5){ phase="ground"; controller="Ground"; reason="on_ground"; }
  else if(t.onGround){ phase="taxi"; controller="Ground"; reason="taxi"; }
  else if(i.onArrival||i.wantsDescent){ phase=dd!=null&&dd<=45?"approach":"arrival"; controller=phase==="approach"?"Approach":"Center"; reason="transcript_arrival"; }
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
function routeIndexOf(fp, token){
  if(!token) return -1;
  return (fp.routeClassified||[]).findIndex(x=>x.token===token);
}
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
function expected(tokens,type){return{type,tokens:tokens.filter(Boolean).map(String)};}

function extractNumbers(text=""){
  const t=up(text);
  const nums=[];
  for(const m of t.matchAll(/\b\d{2,5}\b/g)) nums.push(Number(m[0]));
  const compact=t.replace(/\s+/g," ");
  if(/\bONE TWO THOUSAND\b|\bTWELVE THOUSAND\b|\b1 2 THOUSAND\b/.test(compact)) nums.push(12000);
  if(/\bFLIGHT LEVEL ONE TWO ZERO\b|\bFL ONE TWO ZERO\b|\bFLIGHT LEVEL 120\b|\bFL120\b|\bFL 120\b/.test(compact)) nums.push(12000,120);
  if(/\bTHREE THOUSAND\b|\b3 THOUSAND\b/.test(compact)) nums.push(3000);
  if(/\bEIGHT THOUSAND\b|\b8 THOUSAND\b/.test(compact)) nums.push(8000);
  return nums;
}
function isReadbackForExpected(transcript="", state={}, fp={}){
  const type=state.expectedReadbackType||"";
  const tokens=(state.expectedReadback||[]).map(up).filter(Boolean);
  const text=up(transcript);
  const nums=extractNumbers(text);

  if(!type || type==="none" || !tokens.length) return false;

  let matched=0;
  for(const tok of tokens){
    if(text.includes(tok)) { matched++; continue; }
    const n=num(tok.replace(/[^\d]/g,""));
    if(n!=null){
      if(tok.startsWith("FL") && (nums.includes(n) || nums.includes(n*100))) matched++;
      else if(nums.includes(n)) matched++;
    }
  }

  // Descent/approach clearances often contain runway/approach words and altitude; accept if the key numeric/approach pieces are present.
  if(["descent","star_descent"].includes(type)){
    return matched>0 && (/\bDESCEND|MAINTAIN|EXPECT|ILS|RNAV|APPROACH|ARRIVAL\b/.test(text));
  }
  if(type==="approach_clearance"){
    return /\b(CLEARED|ILS|RNAV|APPROACH|LOCALIZER|RUNWAY|MAINTAIN|ESTABLISHED)\b/.test(text) && (nums.length>0 || (fp.arrRunway && text.includes(fp.arrRunway)));
  }
  if(type==="tower_handoff") return /\b(TOWER|CONTACT|OVER TO)\b/.test(text) || matched>0;
  return matched>=Math.max(1,Math.ceil(tokens.length*0.5));
}
function readbackResponse(callsign, state={}, fp={}, transcript=""){
  const type=state.expectedReadbackType||"";
  let phase=state.phase||"enroute";
  let text=`${callsign}, readback correct.`;
  let er=expected([],"none");
  const upd={expectedReadback:[], expectedReadbackType:"none"};

  if(["descent","star_descent"].includes(type)){
    phase="arrival";
    text=`${callsign}, readback correct. Continue descent${fp.star?` via the ${fp.star} arrival`:""}.`;
  } else if(type==="approach_clearance"){
    phase="approach_cleared";
    text=`${callsign}, readback correct. Report established on final.`;
  } else if(type==="tower_handoff"){
    phase="tower_final";
    text=`${callsign}, readback correct.`;
  } else if(type.includes("airway") || type.includes("direct")){
    phase="enroute";
    text=`${callsign}, readback correct.`;
  }
  upd.phase=phase;
  return {text, er, upd};
}
function chooseLowerAltitude(state={}, telemetry={}){
  const alt=telemetry.altitude;
  const last=up(state.lastAssignedAltitude||"");
  if(alt!=null){
    if(alt>13000) return "12000";
    if(alt>9000) return "8000";
    if(alt>5000) return "3000";
    return "3000";
  }
  if(last==="12000") return "8000";
  if(last==="8000") return "3000";
  return state.arrivalAltitude || "12000";
}

function routeReportResponse(callsign, fp, state, reported){
  const nextAny=nextNavItem(fp,state,reported);
  const nextFix=nextRealFixOrStar(fp,state,reported);
  const update={lastReportedToken:reported?.token||state.lastReportedToken||null};

  if(reported?.type==="fix"){
    update.nextRouteIndex=(nextAny?.index??routeIndexOf(fp,reported.token)+1)+1;
    if(nextAny?.type==="airway"){
      return {text:`${callsign}, ${reported.token} copied. Join airway ${nextAny.token}${nextFix?.token?` toward ${nextFix.token}`:""}.`, expectedReadback:expected([nextAny.token],"join_airway"), update};
    }
    if(nextFix?.type==="fix"){
      return {text:`${callsign}, ${reported.token} copied. Proceed direct ${nextFix.token}, then resume own navigation.`, expectedReadback:expected([nextFix.token],"direct_next_fix"), update};
    }
    if(nextFix?.type==="star"){
      return {text:`${callsign}, ${reported.token} copied. Continue as filed, expect the ${nextFix.token} arrival.`, expectedReadback:expected([],"arrival_expect"), update};
    }
    return {text:`${callsign}, ${reported.token} copied. Continue as filed.`, expectedReadback:expected([],"roger"), update};
  }

  if(reported?.type==="airway"){
    update.nextRouteIndex=(nextAny?.index??routeIndexOf(fp,reported.token)+1)+1;
    if(nextFix?.type==="fix"){
      return {text:`${callsign}, roger, established on airway ${reported.token}. Continue via ${reported.token} toward ${nextFix.token}.`, expectedReadback:expected([],"roger"), update};
    }
    if(nextFix?.type==="star"){
      return {text:`${callsign}, roger, established on airway ${reported.token}. Continue as filed, expect the ${nextFix.token} arrival.`, expectedReadback:expected([],"roger"), update};
    }
    return {text:`${callsign}, roger, established on airway ${reported.token}. Continue as filed.`, expectedReadback:expected([],"roger"), update};
  }

  if(reported?.type==="star"){
    const alt=state.arrivalAltitude||"12000";
    return {text:`${callsign}, roger, continue the ${reported.token} arrival. Descend and maintain ${spokenAltitude(alt)}.`, expectedReadback:expected([alt],"star_descent"), update:{...update,phase:"arrival",lastAssignedAltitude:alt}};
  }

  if(nextAny?.type==="airway"){
    return {text:`${callsign}, roger. Join airway ${nextAny.token}${nextFix?.token?` toward ${nextFix.token}`:""}.`, expectedReadback:expected([nextAny.token],"join_airway"), update:{nextRouteIndex:nextAny.index+1}};
  }
  if(nextFix?.type==="fix"){
    return {text:`${callsign}, roger. Proceed direct ${nextFix.token}, then resume own navigation.`, expectedReadback:expected([nextFix.token],"direct_next_fix"), update:{nextRouteIndex:nextFix.index+1}};
  }
  return {text:`${callsign}, roger, position copied.`, expectedReadback:expected([],"roger"), update};
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

  let text=`${callsign}, say request.`;
  let er=expected([],"none");
  let st={...previousState,callsign:fp.callsign||previousState.callsign||t.callsign,phase:ph.phase,controller:ph.controller,lastIntent:ph.intent,lastTelemetry:t,phaseReason:ph.reason};

  // Highest priority: if the pilot is reading back our last clearance, do not treat it as a new request.
  if(isReadbackForExpected(transcript, previousState, fp)){
    const rb=readbackResponse(callsign, previousState, fp, transcript);
    text=rb.text; er=rb.er; st={...st,...rb.upd};
  }
  // Actual established report only, not "until established" readback.
  else if(isActualEstablished(flags.text) && (previousState.phase==="approach_cleared" || ph.phase==="approach")){
    text=`${callsign}, roger, contact tower${previousState.towerFrequency?` ${previousState.towerFrequency}`:""}.`;
    er=expected([previousState.towerFrequency].filter(Boolean),"tower_handoff");
    st.phase="tower_final";
  }
  else if(flags.onArrival||flags.wantsDescent){
    const alt=chooseLowerAltitude(previousState,t);
    if(fp.star){
      text=`${callsign}, descend via the ${fp.star} arrival. Maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([fp.star,alt],"star_descent");
    }else{
      text=`${callsign}, descend and maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([alt,approach],"descent");
    }
    st.phase="arrival";
    st.lastAssignedAltitude=alt;
  } else if(ph.phase==="ground"){
    if(/\b(IFR|CLEARANCE|CLEAR)\b/.test(flags.text)){
      const initial=previousState.initialAltitude||"5000";
      text=`${callsign}, cleared to ${fp.destination||"destination"}${fp.sid?` via the ${fp.sid} departure`:""}, then as filed. Climb and maintain ${spokenAltitude(initial)}. Expect ${spokenAltitude(fp.cruiseAltitude||"FL320")} ten minutes after departure. Squawk ${wordDigits(fp.assignedSquawk||"4660")}.`;
      er=expected([fp.destination,fp.sid,initial,fp.assignedSquawk||"4660"],"clearance");
      st.phase="clearance_issued";
      st.lastAssignedAltitude=initial;
    }else if(/\b(PUSH|START|ENGINE)\b/.test(flags.text)){
      text=`${callsign}, pushback and startup approved. Report ready to taxi.`;
      er=expected(["pushback","startup"],"push_start");
      st.phase="push_start";
    }
  } else if(ph.phase==="taxi"){
    text=`${callsign}, taxi to ${spokenRunway(runway||previousState.departureRunway||"22R")} via assigned taxi route, hold short.`;
    er=expected(["taxi",runway||previousState.departureRunway||"runway","hold short"],"taxi");
  } else if(ph.phase==="climb"){
    const next=nextNavItem(fp,st,null);
    const target=fp.cruiseAltitude||previousState.cruiseAltitude||"FL320";
    if(next?.type==="airway"){
      text=`${callsign}, climb and maintain ${spokenAltitude(target)}, join airway ${next.token}.`;
      er=expected([target,next.token],"climb_join_airway");
      st.nextRouteIndex=next.index+1;
    }else if(next?.type==="fix"){
      text=`${callsign}, climb and maintain ${spokenAltitude(target)}, proceed direct ${next.token}.`;
      er=expected([target,next.token],"climb_direct");
      st.nextRouteIndex=next.index+1;
    }else{
      text=`${callsign}, climb and maintain ${spokenAltitude(target)}.`;
      er=expected([target],"climb");
    }
    st.phase="enroute";
    st.lastAssignedAltitude=target;
  } else if(ph.phase==="enroute"){
    if(flags.routeReport || reported){
      const rr=routeReportResponse(callsign,fp,st,reported);
      text=rr.text; er=rr.expectedReadback; st={...st,...rr.update};
    }else if(flags.checkin){
      const next=nextNavItem(fp,st,null);
      if(next?.type==="airway"){
        const nextFix=nextRealFixOrStar(fp,st,next);
        text=`${callsign}, radar contact. Join airway ${next.token}${nextFix?.token?` toward ${nextFix.token}`:""}.`;
        er=expected([next.token],"join_airway");
        st.nextRouteIndex=next.index+1;
      }else if(next?.type==="fix"){
        text=`${callsign}, radar contact. Proceed direct ${next.token}, then resume own navigation.`;
        er=expected([next.token],"direct_next_fix");
        st.nextRouteIndex=next.index+1;
      }else{
        text=`${callsign}, radar contact.`;
        er=expected([],"roger");
      }
    }else{
      const next=nextNavItem(fp,st,null);
      if(next?.type==="airway"){
        const nextFix=nextRealFixOrStar(fp,st,next);
        text=`${callsign}, join airway ${next.token}${nextFix?.token?` toward ${nextFix.token}`:""}.`;
        er=expected([next.token],"join_airway");
        st.nextRouteIndex=next.index+1;
      }else if(next?.type==="fix"){
        text=`${callsign}, proceed direct ${next.token}, then resume own navigation.`;
        er=expected([next.token],"direct_next_fix");
        st.nextRouteIndex=next.index+1;
      }else{
        text=`${callsign}, roger.`;
        er=expected([],"roger");
      }
    }
  } else if(ph.phase==="arrival"){
    const alt=chooseLowerAltitude(previousState,t);
    if(fp.star){
      text=`${callsign}, descend via the ${fp.star} arrival. Maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([fp.star,alt],"star_descent");
    }else{
      text=`${callsign}, descend and maintain ${spokenAltitude(alt)}. Expect ${approach} ${runway?spokenRunway(runway):""}.`;
      er=expected([alt,approach],"descent");
    }
    st.phase="approach_pending";
    st.lastAssignedAltitude=alt;
  } else if(ph.phase==="approach" || ph.phase==="approach_pending" || ph.phase==="approach_cleared"){
    const alt=previousState.approachAltitude||"3000";
    const hdg=previousState.interceptHeading||runwayInterceptHeading(runway,t.heading);
    text=`${callsign}, fly ${spokenHeading(hdg)}, maintain ${spokenAltitude(alt)} until established, cleared ${approach} ${runway?spokenRunway(runway):"approach"}.`;
    er=expected([String(hdg),alt,approach,runway].filter(Boolean),"approach_clearance");
    st.phase="approach_cleared";
    st.lastAssignedAltitude=alt;
  } else if(ph.phase==="tower_final"){
    text=`${callsign}, ${runway?spokenRunway(runway):"runway"}, cleared to land.`;
    er=expected(["cleared to land",runway].filter(Boolean),"landing");
  }

  st.expectedReadback=er.tokens;
  st.expectedReadbackType=er.type;
  st.lastAtcTransmission=text.replace(/\s+/g," ").trim();
  st.updatedAt=new Date().toISOString();

  return {
    ok:true,
    atcResponseText:st.lastAtcTransmission,
    updatedState:st,
    debug:{version:"7.0.4",phase:st.phase,controller:st.controller,reason:ph.reason,intent:ph.intent,readbackDetected:isReadbackForExpected(transcript,previousState,fp),reportedToken:reported,route:{routeTokens:fp.routeTokens,routeFixes:fp.routeFixes,routeAirways:fp.routeAirways,procedures:fp.procedures,routeClassified:fp.routeClassified},telemetry:t}
  };
}
function validateReadback(transcript="", expectedTokens=[]){
  const text=up(transcript), missing=[];
  for(const tok of expectedTokens||[]){
    const t=up(tok);
    if(!t) continue;
    if(!text.includes(t)) missing.push(t);
  }
  return {ok:missing.length===0,missing};
}

export {
  parseFlightPlan, sanitizeRouteToken, classifyRouteToken, normalizeTelemetry,
  deriveTelemetryPhase, transcriptIntent, makeResponse, validateReadback,
  spokenAltitude, spokenHeading, spokenRunway, findReportedToken,
  isReadbackForExpected, isActualEstablished
};
export default {
  parseFlightPlan, sanitizeRouteToken, classifyRouteToken, normalizeTelemetry,
  deriveTelemetryPhase, transcriptIntent, makeResponse, validateReadback
};
