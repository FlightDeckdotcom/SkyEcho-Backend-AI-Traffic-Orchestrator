const DIGITS = { '0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
function digitsToWords(s) { return String(s).split('').map(ch => DIGITS[ch] || ch).join(' '); }
function spokenCallsign(callsign, airlineRegistry) {
  const raw = String(callsign || '').trim().toUpperCase().replace(/\s+/g, '');
  const match = raw.match(/^([A-Z]+)(\d+)$/);
  if (!match) return raw.split('').join(' ');
  const [, prefix, nums] = match;
  if (prefix === 'N') return `November ${digitsToWords(nums)}`;
  const airline = airlineRegistry.get(prefix);
  const name = airline ? airline.callsign : prefix.split('').join(' ');
  return `${name} ${digitsToWords(nums)}`;
}
function normalizeSpokenNumbers(text) {
  return String(text || '').replace(/\b([A-Z]{2,4})(\d{2,5})\b/g, (m, p, n) => `${p} ${digitsToWords(n)}`)
    .replace(/\bzeero\b/gi, 'zero');
}
module.exports = { digitsToWords, spokenCallsign, normalizeSpokenNumbers };
