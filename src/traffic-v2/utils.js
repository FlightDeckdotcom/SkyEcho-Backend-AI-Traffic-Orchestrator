'use strict';
function now(){return Date.now();}
function clamp(value,min,max){const n=Number(value);if(!Number.isFinite(n))return min;return Math.max(min,Math.min(max,n));}
function normalizeIcao(value,fallback=''){return String(value||fallback||'').trim().toUpperCase();}
function normalizeFrequency(value){const s=String(value||'').trim();const m=s.match(/(\d{3})[.\s]?(\d{1,3})?/);if(!m)return s;return `${m[1]}.${String(m[2]||'').padEnd(2,'0').slice(0,2)}`;}
function sameFrequency(a,b){return normalizeFrequency(a)===normalizeFrequency(b);}
function runwayNumber(runway){const m=String(runway||'').toUpperCase().match(/\d{1,2}/);return m?Number(m[0]):null;}
function runwayFacing(runway){const n=runwayNumber(runway);if(!n)return'as required for taxi';if(n>=32||n<=4)return'north';if(n>=5&&n<=13)return'east';if(n>=14&&n<=22)return'south';return'west';}
function seededHash(input){const s=String(input||'');let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function formatRunway(runway){return String(runway||'').toUpperCase().replace(/^0?(\d)([LRC])?$/,'0$1$2');}
function digitWord(d){return({'0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'niner'})[String(d)]||String(d);}
function spokenRunway(runway){const r=formatRunway(runway);return r.replace(/(\d)(\d)([LRC])?/,(_,a,b,side)=>`${digitWord(a)} ${digitWord(b)}${side==='L'?' left':side==='R'?' right':side==='C'?' center':''}`);}
function altitudePhrase(altitude){const n=Number(altitude);if(!Number.isFinite(n))return String(altitude||'');if(n>=18000&&n%100===0)return`flight level ${Math.round(n/100)}`;if(n%1000===0)return`${Math.round(n/1000)} thousand`;return String(n);}
function squawkFromSeed(seed){const h=seededHash(seed);const d=[];let x=h;for(let i=0;i<4;i++){d.push(String(x%8));x=Math.floor(x/8);}let sq=d.join('');if(['0000','7500','7600','7700'].includes(sq))sq='4621';return sq;}
function makeIcao24(seed){return`SE${seededHash(seed).toString(16).toUpperCase().padStart(6,'0').slice(-4)}`;}
module.exports={now,clamp,normalizeIcao,normalizeFrequency,sameFrequency,runwayFacing,seededHash,formatRunway,spokenRunway,altitudePhrase,squawkFromSeed,makeIcao24};
