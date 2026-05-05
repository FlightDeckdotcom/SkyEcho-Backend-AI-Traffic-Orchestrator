function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/rwy/g, 'runway')
    .replace(/flight label/g, 'flight level')
    .replace(/\btree\b/g, 'three')
    .replace(/\bown course\b/g, 'on course')
    .replace(/\bdecent\b/g, 'descent')
    .replace(/\s+/g, ' ').trim();
}
function resolveIntent(raw) {
  const t = normalize(raw);
  if (/established.*(airway|route|radial|course|sid|star|g\d+|j\d+|v\d+|y\d+)/.test(t)) return { intent: 'established_on_route', text: t };
  if (/(established|intercepted).*(ils|localizer|final|glide|approach course|runway)/.test(t) || /\bfinal\b/.test(t)) return { intent: 'established_final_or_ils', text: t };
  if (/(clear of|cleared of).*(runway)/.test(t) && /(taxi|ramp|gate|stand|fbo|parking)/.test(t)) return { intent: 'request_taxi_in', text: t };
  if (/request.*(taxi).*(ramp|gate|stand|fbo|parking|customs|fuel)/.test(t)) return { intent: 'request_taxi_in', text: t };
  if (/holding short|ready for departure|ready for takeoff/.test(t)) return { intent: 'ready_for_takeoff', text: t };
  if (/request taxi|ready to taxi/.test(t)) return { intent: 'request_taxi_out', text: t };
  if (/request.*visual|runway in sight|airport in sight/.test(t)) return { intent: 'request_visual_approach', text: t };
  if (/with you|passing|radar/.test(t)) return { intent: 'check_in', text: t };
  if (/ready.*descent|request descent|higher|lower/.test(t)) return { intent: 'request_descent_or_altitude', text: t };
  return { intent: 'unknown', text: t };
}
module.exports = { normalize, resolveIntent };
