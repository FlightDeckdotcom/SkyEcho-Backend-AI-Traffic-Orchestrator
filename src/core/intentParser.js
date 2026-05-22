import { sanitizeRouteTokens, isSpeedLevelToken, isProcedureToken, isAirwayToken, isFixToken } from "./routeTools.js";
export function normalizeTranscript(raw = "") {
  let t=String(raw||"").toLowerCase().trim();
  [[/alpha\s+november\s+uniform/g,"anu"],[/charlie\s+hotel\s+sierra\s+lima\s+yankee\s+seven/g,"chsly7"],[/charlie\s+hotel\s+sierra\s+lima\s+yankee\s+7/g,"chsly7"],[/golf\s+six\s+three\s+three/g,"g633"],[/gulf\s+six\s+three\s+three/g,"g633"],[/flight\s+level\s+/g,"fl"],[/one\s+five\s+thousand/g,"15000"],[/fifteen\s+thousand/g,"15000"],[/two\s+three\s+zero/g,"230"],[/three\s+two\s+zero/g,"320"],[/three\s+seven\s+zero/g,"370"]].forEach(([a,b])=>t=t.replace(a,b));
  return t.replace(/[.,]/g," ").replace(/\s+/g," ").trim();
}
export function extractTokens(raw = "", context = {}) {
  const text=normalizeTranscript(raw); const route=sanitizeRouteTokens(context.route||[]);
  const cm=text.match(/\b(ual|aal|dal|jbu|bwa|united|american|delta|jetblue|caribbean)\s?(\d{1,4}[a-z]?)\b/i);
  const callsign=cm?`${cm[1].toUpperCase()}${cm[2].toUpperCase()}`:context.callsign||"";
  const fl=text.match(/\bfl\s?(\d{2,3})\b/i); const am=text.match(/\b(?:passing|through|level|maintain|to|at|descending to|climbing to)\s+(\d{4,5})\b/i);
  const altitude=fl?Number(fl[1])*100:am?Number(am[1]):null;
  const hm=text.match(/\bheading\s+(\d{2,3})\b/i); const fm=text.match(/\b(\d{3}\.\d{1,3})\b/); const rm=text.match(/\brunway\s+(\d{1,2}[lrc]?)\b/i);
  const words=text.toUpperCase().split(/\s+/);
  const routeTokens=[...new Set(words.map(w=>w.replace(/[^A-Z0-9]/g,"")).filter(w=>w&&!isSpeedLevelToken(w)).filter(w=>route.includes(w)||isFixToken(w)||isAirwayToken(w)||isProcedureToken(w)))];
  return {raw,text,callsign,altitude,flightLevel:fl?`FL${fl[1]}`:null,heading:hm?hm[1].padStart(3,"0"):null,frequency:fm?fm[1]:null,runway:rm?rm[1].toUpperCase().padStart(2,"0"):null,routeTokens,route};
}
export function classifyIntent(raw = "", context = {}) {
  const tokens=extractTokens(raw,context); const text=tokens.text;
  const isClearance=/\b(clearance|ifr clearance|ready for clearance)\b/i.test(text);
  const isPush=/\b(push|pushback|start)\b/i.test(text); const isTaxi=/\b(taxi|ready to taxi)\b/i.test(text); const isReady=/\b(ready|holding short|ready for departure)\b/i.test(text);
  const isInitial=/\b(with you|checking in|check in|passing|level|maintaining|climbing|descending|request descent)\b/i.test(text);
  const isArrival=/\b(arrival|star|descending|descend|descent|request descent|requesting descent)\b/i.test(text)||tokens.routeTokens.some(t=>isProcedureToken(t)&&/arrival|star|descending|descend|descent/i.test(text));
  const isApproach=/\b(established.*runway|established\s+(ils|rnav|localizer|loc|final)|final runway|glideslope|glidepath)\b/i.test(text);
  const isWeather=/\b(deviation|weather|cell|storm|radar|left of course|right of course)\b/i.test(text); const isRide=/\b(chop|turbulence|ride|higher|lower|smooth)\b/i.test(text);
  const isRouteReport=/\b(report|passing|abeam|over|crossing|established on|joining|tracking|will report)\b/i.test(text)&&tokens.routeTokens.length>0;
  const isReadback=/\b(cleared|climb|descend|maintain|heading|direct|squawk|hold|taxi|takeoff|land|approved|roger|wilco|copy)\b/i.test(text);
  let intent="unknown";
  if(isClearance)intent="request_clearance"; else if(isPush)intent="request_push_start"; else if(isTaxi)intent="request_taxi"; else if(isReady)intent="ready_departure"; else if(isApproach)intent="approach_established"; else if(isWeather)intent="weather_deviation_request"; else if(isRide)intent="ride_request"; else if(isArrival&&isInitial)intent="arrival_checkin"; else if(isInitial)intent="frequency_checkin"; else if(isRouteReport)intent="route_position_report"; else if(isReadback)intent="instruction_readback";
  return {intent,tokens,text};
}
