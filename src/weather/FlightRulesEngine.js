function flightRulesFromMetar(metar='') {
  const ceiling = /BKN(\d{3})|OVC(\d{3})/.exec(metar || '');
  const vis = /(\d+)SM/.exec(metar || '');
  const c = ceiling ? Number(ceiling[1] || ceiling[2]) * 100 : 99999;
  const v = vis ? Number(vis[1]) : 10;
  if (c < 1000 || v < 3) return 'IFR';
  if (c < 3000 || v < 5) return 'MVFR';
  return 'VFR';
}
module.exports = { flightRulesFromMetar };
