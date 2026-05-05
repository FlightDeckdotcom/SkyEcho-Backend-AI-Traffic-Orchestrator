const fs = require('fs');
const path = require('path');
function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i+1] === '"') { cur += '"'; i++; continue; }
      quoted = !quoted; continue;
    }
    if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim()); return out;
}
function parseCsvText(text) {
  text = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift()).map(h => h.trim());
  return lines.map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}
function loadCsv(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`CSV not found: ${abs}`);
  return parseCsvText(fs.readFileSync(abs, 'utf8'));
}
async function loadCsvUrl(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`CSV URL failed ${res.status}: ${url}`);
  const text = await res.text();
  return parseCsvText(text);
}
module.exports = { loadCsv, loadCsvUrl, parseCsvText, parseCsvLine };
