export const PROCEDURES = {
  KMIA:{departures:{FLPGA3:{type:"SID",transition:"FLPGA"},MZULO3:{type:"SID",transition:"MZULO"}},arrivals:{CHSLY7:{type:"STAR"}}},
  TKPK:{arrivals:{ANU1:{type:"STAR",via:"ANU"}},approaches:{RNAV07:{type:"RNAV",runway:"07"},VOR07:{type:"VOR",runway:"07"}},frequencies:{approach:"118.00",tower:"118.90",ground:"121.90"}},
  KCLT:{arrivals:{CHSLY7:{type:"STAR",runwayHints:["18C","18R","23","36C"]}}}
};
export function routeContainsArrival(routeTokens = [], destination = "") { const ap=PROCEDURES[String(destination||"").toUpperCase()]; if(!ap?.arrivals) return null; return routeTokens.find(t=>ap.arrivals[t]) || null; }
export function routeContainsDeparture(routeTokens = [], origin = "") { const ap=PROCEDURES[String(origin||"").toUpperCase()]; if(!ap?.departures) return null; return routeTokens.find(t=>ap.departures[t]) || null; }
