export function isSpeedLevelToken(token = "") {
  const t = String(token || "").trim().toUpperCase();
  return /^(?:N\d{4}F\d{1,3}|K\d{4}F\d{1,3}|M\d{3}F\d{1,3}|N\d{4}A\d{1,3}|K\d{4}A\d{1,3}|M\d{3}A\d{1,3}|F\d{2,3}|FL\d{2,3}|\d{3,4}KT?)$/.test(t);
}
export function isProcedureToken(token = "") { return /^[A-Z]{2,6}\d[A-Z]?$/.test(String(token || "").trim().toUpperCase()); }
export function isAirwayToken(token = "") { return /^[A-Z]{1,2}\d{1,4}[A-Z]?$/.test(String(token || "").trim().toUpperCase()); }
export function isFixToken(token = "") { return /^[A-Z]{2,5}$/.test(String(token || "").trim().toUpperCase()); }
export function sanitizeRouteTokens(routeInput = "") {
  const raw = Array.isArray(routeInput) ? routeInput : String(routeInput || "").split(/[\s,]+/);
  return raw.map(t => String(t || "").trim().toUpperCase()).filter(Boolean).filter(t => !isSpeedLevelToken(t)).filter(t => t !== "DCT").filter(t => isFixToken(t) || isAirwayToken(t) || isProcedureToken(t));
}
export function parseSimBriefLikeRoute(route = "") {
  const tokens = sanitizeRouteTokens(route);
  return { raw: route, tokens, procedures: tokens.filter(isProcedureToken), airways: tokens.filter(t => isAirwayToken(t) && !isProcedureToken(t)), fixes: tokens.filter(isFixToken), nextDirectFix: tokens.find(isFixToken) || null };
}
