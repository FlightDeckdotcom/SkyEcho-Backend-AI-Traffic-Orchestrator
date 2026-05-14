'use strict';
const { squawkFromSeed } = require('./utils');
class SquawkManager{constructor(){this.assigned=new Map();this.used=new Set(['7500','7600','7700','0000']);}assign(callsign){const key=String(callsign||'').toUpperCase();if(this.assigned.has(key))return this.assigned.get(key);let sq=squawkFromSeed(key),guard=0;while(this.used.has(sq)&&guard<512)sq=squawkFromSeed(`${key}-${guard++}`);this.used.add(sq);this.assigned.set(key,sq);return sq;}snapshot(){return Object.fromEntries(this.assigned.entries());}}
module.exports={SquawkManager};
