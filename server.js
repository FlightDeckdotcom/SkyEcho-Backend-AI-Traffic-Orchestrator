// SkyEchoCabin UltraStrict optional backend proxy v6.9.46
// Purpose: keep API keys off the frontend, proxy FS2EFB/SayIntentions data, and expose parser classification tests.
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({limit:'1mb'}));

const PORT = process.env.PORT || 3000;
const FS2EFB_URL = process.env.FS2EFB_URL || '';
const SAYINTENTIONS_TRAFFIC_URL = process.env.SAYINTENTIONS_TRAFFIC_URL || '';
const SAYINTENTIONS_API_KEY = process.env.SAYINTENTIONS_API_KEY || '';

function normalizeTranscript(raw=''){
  let t=String(raw||'').trim().toLowerCase();
  const repl=[[/alpha\s+november\s+uniform/g,'anu'],[/golf\s+six\s+three\s+three/g,'g633'],[/golf\s+633/g,'g633']];
  for(const [a,b] of repl) t=t.replace(a,b);
  return t.replace(/\s+/g,' ').trim();
}
function classify(raw,state={}){
  const text=normalizeTranscript(raw);
  const airwayRe=/\b([a-z]{1,2}\d{1,4}[a-z]?)\b/i;
  const approachRe=/\b(ils|rnav|vor|ndb|visual|localizer|loc|final|established|glideslope|glidepath)\b/i;
  const checkinRe=/\b(with you|checking in|check in|passing|climbing through|descending through|level)\b/i;
  const readbackRe=/\b(cleared|clearance|taxi|hold short|line up|takeoff|land|climb|descend|maintain|turn|heading|direct|proceed|squawk|contact|frequency|expect|altimeter|push|start)\b/i;
  const routeReportRe=/\b(report|passing|abeam|over|crossing|established on|joining|intercepting|tracking)\b/i;
  const hasReadback=readbackRe.test(text), isCheckin=checkinRe.test(text)&&!hasReadback;
  const isRouteReport=routeReportRe.test(text)&&(airwayRe.test(text)||/\banu\b/i.test(text));
  const isApproach=approachRe.test(text);
  let intent='unknown';
  if(isApproach && /established|final|localizer|ils|rnav|visual/.test(text)) intent='approach_established';
  else if(isRouteReport) intent='route_position_report';
  else if(isCheckin) intent='controller_checkin';
  else if(hasReadback) intent='instruction_readback';
  else if(/clearance|ifr/.test(text)) intent='request_clearance';
  return {raw,text,intent,phase:state.phase||'',controller:state.controller||''};
}

app.get('/health',(req,res)=>res.json({ok:true,service:'skyecho-ultrastrict-backend',version:'6.9.46'}));
app.post('/api/intent/classify',(req,res)=>res.json(classify(req.body?.text||'', req.body?.state||{})));
app.get('/api/fs2efb', async (req,res)=>{
  const url=req.query.url || FS2EFB_URL;
  if(!url) return res.status(400).json({error:'Missing FS2EFB_URL or ?url='});
  try{const r=await fetch(url,{cache:'no-store'}); const text=await r.text(); res.type(r.headers.get('content-type')||'application/json').send(text);}
  catch(e){res.status(502).json({error:e.message});}
});
app.get('/api/sayintentions/traffic', async (req,res)=>{
  const url=req.query.url || SAYINTENTIONS_TRAFFIC_URL;
  if(!url) return res.status(400).json({error:'Missing SAYINTENTIONS_TRAFFIC_URL or ?url='});
  try{const headers={}; if(SAYINTENTIONS_API_KEY) headers.Authorization='Bearer '+SAYINTENTIONS_API_KEY; const r=await fetch(url,{headers,cache:'no-store'}); const text=await r.text(); res.type(r.headers.get('content-type')||'application/json').send(text);}
  catch(e){res.status(502).json({error:e.message});}
});
app.listen(PORT,()=>console.log(`SkyEcho UltraStrict backend on ${PORT}`));
