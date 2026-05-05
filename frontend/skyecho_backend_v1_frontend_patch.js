/* SkyEcho Backend v1 frontend connector patch
   Add before </body> in your working SkyEchoCabin index.html, or paste in a custom script panel if available.
   It connects the UI to the new backend AI traffic orchestrator.
*/
(function(){
  if (window.__SKYECHO_BACKEND_V1_PATCH__) return;
  window.__SKYECHO_BACKEND_V1_PATCH__ = true;
  const state = { ws:null, connected:false, url:localStorage.getItem('skyecho_backend_url')||'', secret:localStorage.getItem('skyecho_backend_secret')||'', logs:[] };
  function addLog(type, text){
    const line = `${new Date().toLocaleTimeString()} — ${type}: ${text}`;
    state.logs.unshift(line); state.logs = state.logs.slice(0,80);
    render();
    try { window.dispatchEvent(new CustomEvent('skyecho:backend-log', { detail:{ type, text } })); } catch {}
  }
  function api(path, body){
    if (!state.url) { addLog('SYSTEM','Backend URL missing'); return Promise.reject(new Error('Backend URL missing')); }
    return fetch(state.url.replace(/\/$/,'') + path, { method:'POST', headers:{ 'Content-Type':'application/json','x-bridge-secret':state.secret }, body:JSON.stringify(body||{}) }).then(r=>r.json());
  }
  function connect(){
    if (!state.url) return addLog('SYSTEM','Backend URL missing');
    if (state.ws) try { state.ws.close(); } catch {}
    const wsUrl = state.url.replace(/^http/,'ws').replace(/\/$/,'') + '/ws';
    state.ws = new WebSocket(wsUrl);
    state.ws.onopen = () => { state.connected = true; addLog('NETWORK','Backend websocket connected'); render(); };
    state.ws.onclose = () => { state.connected = false; addLog('NETWORK','Backend websocket closed'); render(); };
    state.ws.onerror = () => { addLog('NETWORK','Backend websocket error'); };
    state.ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'radio') addLog(msg.event.role === 'atc' ? 'ATC' : 'AI TRAFFIC', msg.event.text);
        else if (msg.type === 'adsb_update') addLog('ADSB', `${msg.aircraft.length} aircraft updating`);
        else if (msg.type === 'log') addLog(msg.entry.type, msg.entry.text);
      } catch { addLog('NETWORK', ev.data.slice(0,120)); }
    };
  }
  function startTraffic(){ api('/traffic/start',{ airport:document.getElementById('sebe-airport')?.value||'TKPK', density:Number(document.getElementById('sebe-density')?.value||3) }).then(()=>addLog('SYSTEM','Backend traffic start requested')).catch(e=>addLog('ERROR',e.message)); }
  function stopTraffic(){ api('/traffic/stop',{}).then(()=>addLog('SYSTEM','Backend traffic stop requested')).catch(e=>addLog('ERROR',e.message)); }
  function testPilot(){ const text = document.getElementById('sebe-test')?.value || 'tower BWA268 holding short runway 07 ready for departure'; api('/traffic/pilot-event',{ callsign:'BWA268', text, airport:document.getElementById('sebe-airport')?.value||'TKPK', runway:'07' }).then(r=>addLog('ATC',r.result.response)).catch(e=>addLog('ERROR',e.message)); }
  function render(){
    let el = document.getElementById('skyecho-backend-engine-panel');
    if (!el) {
      el = document.createElement('div'); el.id = 'skyecho-backend-engine-panel';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:360px;max-width:calc(100vw - 32px);background:rgba(6,12,35,.94);color:white;border:1px solid rgba(125,200,255,.25);border-radius:18px;padding:14px;font-family:Inter,system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.45)';
      document.body.appendChild(el);
    }
    const minimized = localStorage.getItem('sebe_min') === '1';
    el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>SkyEcho Backend AI Engine</b><button id="sebe-min" style="border:0;border-radius:10px;padding:6px 10px;background:#334155;color:white">${minimized?'+':'–'}</button></div>` + (minimized?'':`
      <div style="font-size:12px;color:#bfdbfe;margin:4px 0 8px">${state.connected?'Connected':'Offline'} · Backend owns AI traffic/sequencing</div>
      <input id="sebe-url" placeholder="Backend URL" value="${state.url}" style="width:100%;margin:4px 0;padding:10px;border-radius:10px;background:#0f172a;color:white;border:1px solid #334155">
      <input id="sebe-secret" placeholder="BRIDGE_SECRET" value="${state.secret}" style="width:100%;margin:4px 0;padding:10px;border-radius:10px;background:#0f172a;color:white;border:1px solid #334155">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0"><input id="sebe-airport" value="TKPK" style="padding:10px;border-radius:10px;background:#0f172a;color:white;border:1px solid #334155"><input id="sebe-density" type="number" min="1" max="5" value="3" style="padding:10px;border-radius:10px;background:#0f172a;color:white;border:1px solid #334155"></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0"><button id="sebe-save">Save + Connect</button><button id="sebe-start">Start Backend Traffic</button><button id="sebe-stop">Stop Traffic</button></div>
      <input id="sebe-test" value="clear of runway 07 request taxi to the FBO" style="width:100%;margin:4px 0;padding:10px;border-radius:10px;background:#0f172a;color:white;border:1px solid #334155"><button id="sebe-testbtn">Test Pilot Event</button>
      <div style="max-height:170px;overflow:auto;margin-top:10px;font-size:12px;line-height:1.35;background:#020617;border-radius:12px;padding:8px">${state.logs.slice(0,25).map(l=>`<div>${l.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>`).join('') || 'No backend logs yet.'}</div>
      <style>#skyecho-backend-engine-panel button{border:0;border-radius:10px;padding:8px 10px;background:linear-gradient(135deg,#7c3aed,#06b6d4);color:white;font-weight:800}</style>`);
    document.getElementById('sebe-min')?.addEventListener('click',()=>{ localStorage.setItem('sebe_min', minimized?'0':'1'); render(); });
    document.getElementById('sebe-save')?.addEventListener('click',()=>{ state.url=document.getElementById('sebe-url').value.trim(); state.secret=document.getElementById('sebe-secret').value.trim(); localStorage.setItem('skyecho_backend_url',state.url); localStorage.setItem('skyecho_backend_secret',state.secret); connect(); });
    document.getElementById('sebe-start')?.addEventListener('click',startTraffic);
    document.getElementById('sebe-stop')?.addEventListener('click',stopTraffic);
    document.getElementById('sebe-testbtn')?.addEventListener('click',testPilot);
  }
  window.SkyEchoBackendV1 = { connect, startTraffic, stopTraffic, testPilot, state };
  render();
})();
