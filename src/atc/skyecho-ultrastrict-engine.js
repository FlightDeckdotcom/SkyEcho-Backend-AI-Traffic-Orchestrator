/* SkyEchoCabin UltraStrict ATC Guard v6.9.46
   Safe additive patch: does not replace the app. It adds parser guards, connector plumbing,
   traffic disablement, and a small phase/connectors overlay. */
(function(){
  'use strict';
  if (window.__SKYECHO_ULTRASTRICT_6946__) return;
  window.__SKYECHO_ULTRASTRICT_6946__ = true;

  const CFG_KEY='skyecho_ultrastrict_config_v6946';
  const DEFAULT_CFG={
    fs2efb:{enabled:false,url:'',pollMs:1000},
    sayIntentions:{enabled:false,url:'',apiKey:'',pollMs:2500},
    syntheticTraffic:false,
    strictPhaseLock:true,
    preventRadarContactLoop:true
  };
  const safeJson=(v,fallback)=>{try{return JSON.parse(v)||fallback}catch{return fallback}};
  const loadCfg=()=>Object.assign({}, DEFAULT_CFG, safeJson(localStorage.getItem(CFG_KEY),{}));
  const saveCfg=(cfg)=>localStorage.setItem(CFG_KEY,JSON.stringify(Object.assign({},loadCfg(),cfg)));
  let cfg=loadCfg();

  // Disable old/generated AI traffic without deleting user's code.
  function disableSyntheticTraffic(){
    try{
      window.__skyechoTrafficDensity=0;
      window.__skyechoTrafficState=[];
      window.__skyechoTrafficQueue=[];
      window.__skyechoStrictNoBrowserTraffic=true;
      localStorage.setItem('skyecho_traffic_density','0');
      localStorage.setItem('skyecho_ai_traffic_enabled','false');
    }catch{}
  }
  disableSyntheticTraffic();
  setInterval(disableSyntheticTraffic,5000);

  const FIX_RE=/\b([A-Z]{2,5}|[A-Z][0-9][A-Z0-9]{1,3})\b/g;
  const AIRWAY_RE=/\b([A-Z]{1,2}\d{1,4}[A-Z]?)\b/i; // G633, A555, Q42, UL620
  const APPROACH_RE=/\b(ils|rnav|vor|ndb|visual|localizer|loc|final|established|glideslope|glidepath)\b/i;
  const CHECKIN_RE=/\b(with you|checking in|check in|passing|climbing through|descending through|level)\b/i;
  const READBACK_ACTION_RE=/\b(cleared|clearance|taxi|hold short|line up|takeoff|land|climb|descend|maintain|turn|heading|direct|proceed|squawk|contact|frequency|expect|altimeter|push|start)\b/i;
  const ROUTE_REPORT_RE=/\b(report|passing|abeam|over|crossing|established on|joining|intercepting|tracking)\b/i;

  function normalizeTranscript(raw){
    let t=String(raw||'').trim();
    let l=t.toLowerCase();
    const repl=[
      [/alpha\s+november\s+uniform/g,'ANU'],[/golf\s+six\s+three\s+three/g,'G633'],[/golf\s+633/g,'G633'],
      [/flight\s+level\s+one\s+zero\s+zero/g,'FL100'],[/flight\s+level\s+three\s+four\s+zero/g,'FL340'],
      [/flight\s+level\s+one\s+six\s+zero/g,'FL160'],[/two\s+niner\s+niner\s+niner/g,'2999'],
      [/zero\s+seven/g,'07'],[/zero\s+niner/g,'09'],[/zero\s+four\s+zero/g,'040']
    ];
    for(const [a,b] of repl) l=l.replace(a,b.toLowerCase());
    return l.replace(/\s+/g,' ').trim();
  }

  function classify(raw, state={}){
    const text=normalizeTranscript(raw);
    const hasReadback=READBACK_ACTION_RE.test(text);
    const isCheckin=CHECKIN_RE.test(text) && !hasReadback;
    const isRouteReport=ROUTE_REPORT_RE.test(text) && (AIRWAY_RE.test(text)||/\bANU\b/i.test(raw));
    const isApproach=APPROACH_RE.test(text);
    const airway=(text.match(AIRWAY_RE)||[])[1]||'';
    let intent='unknown';
    if(isApproach && /established|final|localizer|ils|rnav|visual/.test(text)) intent='approach_established';
    else if(isRouteReport) intent='route_position_report';
    else if(isCheckin) intent='controller_checkin';
    else if(hasReadback) intent='instruction_readback';
    else if(/clearance|ifr/.test(text)) intent='request_clearance';
    return {raw,text,intent,isCheckin,isRouteReport,isApproach,airway,hasReadback,phase:state.phase||'',controller:state.controller||'',time:Date.now()};
  }

  function shouldBlockRadarLoop(raw,state={}){
    const r=classify(raw,state);
    if(!cfg.preventRadarContactLoop) return {block:false,reason:'disabled',parsed:r};
    // Never treat a clean check-in as a failed climb/direct readback.
    if(r.intent==='controller_checkin') return {block:true,reason:'checkin_not_readback',parsed:r};
    // Route/airway position reports must not reset departure/climb or generate radar-contact loops.
    if(r.intent==='route_position_report') return {block:true,reason:'route_report_not_departure_reset',parsed:r};
    // Approach established reports are not airway reports and not departure check-ins.
    if(r.intent==='approach_established') return {block:true,reason:'approach_established_not_airway',parsed:r};
    return {block:false,reason:'ok',parsed:r};
  }

  window.SkyEchoUltraStrict={version:'6.9.46',loadCfg,saveCfg,normalizeTranscript,classify,shouldBlockRadarLoop,disableSyntheticTraffic};

  // Connector polling: frontend can connect directly; backend proxy is optional to avoid CORS/key exposure.
  async function pollFs2efb(){
    cfg=loadCfg(); if(!cfg.fs2efb.enabled||!cfg.fs2efb.url) return;
    try{
      const res=await fetch(cfg.fs2efb.url,{cache:'no-store'}); if(!res.ok) throw new Error('HTTP '+res.status);
      const d=await res.json();
      window.__skyechoTelemetryState=Object.assign({}, window.__skyechoTelemetryState||{}, d, {source:'FS2EFB',lastUpdate:Date.now()});
      panelStatus('FS2EFB live');
    }catch(e){panelStatus('FS2EFB offline: '+e.message)}
  }
  async function pollSayIntentions(){
    cfg=loadCfg(); if(!cfg.sayIntentions.enabled||!cfg.sayIntentions.url) return;
    try{
      const headers={}; if(cfg.sayIntentions.apiKey) headers.Authorization='Bearer '+cfg.sayIntentions.apiKey;
      const res=await fetch(cfg.sayIntentions.url,{headers,cache:'no-store'}); if(!res.ok) throw new Error('HTTP '+res.status);
      const d=await res.json();
      const list=Array.isArray(d)?d:(d.traffic||d.aircraft||[]);
      window.__skyechoExternalTrafficState=list.map(x=>Object.assign({},x,{source:'SayIntentions'}));
      window.__skyechoTrafficState=window.__skyechoExternalTrafficState; // replaces synthetic traffic source
      panelStatus('SayIntentions traffic live: '+list.length);
    }catch(e){panelStatus('SayIntentions offline: '+e.message)}
  }
  setInterval(pollFs2efb, Math.max(500, cfg.fs2efb.pollMs||1000));
  setInterval(pollSayIntentions, Math.max(1500, cfg.sayIntentions.pollMs||2500));

  function panelStatus(msg){const el=document.getElementById('skyecho-us-status'); if(el) el.textContent=msg;}
  function buildPanel(){
    if(document.getElementById('skyecho-ultrastrict-panel')) return;
    const box=document.createElement('div'); box.id='skyecho-ultrastrict-panel';
    box.style.cssText='position:fixed;right:14px;bottom:14px;z-index:999999;width:min(420px,calc(100vw - 28px));background:rgba(2,6,23,.94);color:#f8fafc;border:1px solid rgba(103,232,249,.35);border-radius:18px;padding:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:13px system-ui';
    box.innerHTML=`<b style="color:#67e8f9">SkyEcho UltraStrict Guard v6.9.46</b><div id="skyecho-us-status" style="margin:6px 0;color:#cbd5e1">Synthetic AI traffic disabled. Parser guard active.</div>
      <label>FS2EFB JSON URL<input id="us-fs2efb" placeholder="http://device-ip:port/status" style="width:100%;margin:4px 0 8px;background:#0f172a;color:white;border:1px solid #334155;border-radius:8px;padding:8px"></label>
      <label>SayIntentions Traffic/API URL<input id="us-si" placeholder="https://.../traffic" style="width:100%;margin:4px 0 8px;background:#0f172a;color:white;border:1px solid #334155;border-radius:8px;padding:8px"></label>
      <button id="us-save" style="background:#22d3ee;color:#082f49;border:0;border-radius:10px;padding:8px 12px;font-weight:800">Save Connectors</button>
      <button id="us-hide" style="background:#1e293b;color:#fff;border:1px solid #334155;border-radius:10px;padding:8px 12px;margin-left:6px">Hide</button>`;
    document.body.appendChild(box);
    const c=loadCfg(); document.getElementById('us-fs2efb').value=c.fs2efb.url||''; document.getElementById('us-si').value=c.sayIntentions.url||'';
    document.getElementById('us-save').onclick=()=>{saveCfg({fs2efb:{...loadCfg().fs2efb,enabled:!!document.getElementById('us-fs2efb').value,url:document.getElementById('us-fs2efb').value},sayIntentions:{...loadCfg().sayIntentions,enabled:!!document.getElementById('us-si').value,url:document.getElementById('us-si').value},syntheticTraffic:false}); cfg=loadCfg(); panelStatus('Saved. Polling connectors.');};
    document.getElementById('us-hide').onclick=()=>box.remove();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',buildPanel); else buildPanel();
})();
