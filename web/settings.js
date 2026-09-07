// settings.js — settings screen (reference: AimingData 2.png bottom-right,
// minus the Valorant integration panel, plus the input-translation values the
// DPI/eDPI analysis needs).
const Sett={
  draft:null,

  render(){
    const s=S.settings||{};
    const ok=S.health?.collector?.ok;
    return header('Settings','Configure your data collection, translation and application preferences.',
      `<button class="primary" id="saveSettings">Save Settings</button>`)
    +`<div class="settings-grid">
      <div class="col">
        <section class="panel">
          <div class="panel-head"><h2>Collector Settings</h2>${badge(ok?'● Running':'○ Stopped',ok?'green':'red')}</div>
          <p class="muted">The Python collector runs in the background and captures mouse/keyboard input and the VALORANT log.</p>
          <div class="form-row"><label>Collector Status</label><span class="static">${ok?'Running':'Offline'}</span></div>
          <div class="form-row"><label>Input Buffer Size</label><select id="s_bufferSize">${[10000,100000,1000000].map(v=>`<option value="${v}" ${s.bufferSize==v?'selected':''}>${v.toLocaleString()} events</option>`).join('')}</select></div>
          <div class="form-row"><label>Auto Start (agent select)</label><input type="checkbox" id="s_autoCapture" ${s.autoCapture?'checked':''}></div>
          <div class="form-row"><label>Auto Stop (game end)</label><input type="checkbox" id="s_autoStop" ${s.autoStop?'checked':''}></div>
          <div class="form-row"><label>Skip The Range</label><input type="checkbox" id="s_skipTheRange" ${s.skipTheRange?'checked':''}></div>
          <div class="form-row"><label>Log Level</label><select id="s_logLevel">${['Info','Verbose','Debug'].map(v=>`<option ${s.logLevel===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="btnrow"><button class="ghost" id="cRestart">↻ Restart Collector</button><button class="ghost" id="cStart">▶ Start Collector</button><button class="danger" id="cStop">■ Stop Collector</button></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Display Settings</h2></div>
          <div class="form-row"><label>Theme</label><select id="s_theme">${['Dark'].map(v=>`<option ${s.theme===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="form-row"><label>Language</label><select id="s_language">${['English'].map(v=>`<option ${s.language===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="form-row"><label>Show Notifications</label><input type="checkbox" id="s_showNotifications" ${s.showNotifications?'checked':''}></div>
          <div class="form-row"><label>Minimize to Tray</label><input type="checkbox" id="s_minimizeToTray" ${s.minimizeToTray?'checked':''}></div>
        </section>
      </div>
      <div class="col">
        <section class="panel">
          <div class="panel-head"><h2>Input Translation</h2></div>
          <p class="muted">These values translate raw hardware counts into physical and in-game units for every chart: deg/s = counts/s × 0.022 × sens, cm = counts ÷ DPI × 2.54.</p>
          <div class="form-row"><label>Mouse DPI</label><input type="number" id="s_dpi" value="${s.dpi??800}"></div>
          <div class="form-row"><label>In-game Sensitivity</label><input type="number" step="0.001" id="s_sensitivity" value="${s.sensitivity??0.5}"></div>
          <div class="form-row"><label>Polling Rate (Hz)</label><input type="number" id="s_pollingRate" value="${s.pollingRate??1000}"></div>
          <div class="form-row"><label>Resolution</label><input id="s_resolution" value="${s.resolution??'1920x1080'}"></div>
          <div class="form-row"><label>eDPI (computed)</label><span class="static" id="edpiOut">${An.edpi(s.dpi,s.sensitivity)}</span></div>
          <div class="form-row"><label>cm/360 (computed)</label><span class="static" id="cm360Out">${An.cm360(s.dpi,s.sensitivity).toFixed(1)} cm</span></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Data &amp; Storage</h2></div>
          <div class="form-row"><label>Data Directory</label><input id="s_dataDirectory" value="${esc(s.dataDirectory||'data')}"></div>
          <p class="muted">Applied on next launch of the core server.</p>
          <div class="form-row"><label>Retention Period</label><select id="s_retentionDays">${[30,60,90,180,365].map(v=>`<option value="${v}" ${s.retentionDays==v?'selected':''}>Keep for ${v} days</option>`).join('')}</select></div>
          <div class="form-row"><label>Auto Cleanup</label><input type="checkbox" id="s_autoCleanup" ${s.autoCleanup?'checked':''}></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Advanced</h2></div>
          <div class="form-row"><label>Enable Debug Mode</label><input type="checkbox" id="s_debug" ${s.debug?'checked':''}></div>
          <div class="form-row"><label>Verbose Logging</label><input type="checkbox" id="s_verbose" ${s.verbose?'checked':''}></div>
          <div class="btnrow"><button class="ghost" id="resetDefaults">Reset to Defaults</button><button class="danger" id="clearBuffer">Clear Collector Buffer</button></div>
        </section>
      </div>
    </div>`;
  },

  mount(){
    this.draft={};
    const bindNum=(id,key)=>{$(id).oninput=e=>{this.draft[key]=Number(e.target.value);this.updateComputed()}};
    const bindText=(id,key)=>{$(id).oninput=e=>{this.draft[key]=e.target.value}};
    const bindSel=(id,key,num)=>{$(id).onchange=e=>{this.draft[key]=num?Number(e.target.value):e.target.value}};
    const bindChk=(id,key)=>{$(id).onchange=e=>{this.draft[key]=e.target.checked}};
    bindNum('#s_dpi','dpi');bindNum('#s_sensitivity','sensitivity');bindNum('#s_pollingRate','pollingRate');
    bindText('#s_resolution','resolution');bindText('#s_dataDirectory','dataDirectory');
    bindSel('#s_bufferSize','bufferSize',true);bindSel('#s_logLevel','logLevel');
    bindChk('#s_autoCapture','autoCapture');bindChk('#s_autoStop','autoStop');bindChk('#s_skipTheRange','skipTheRange');
    bindSel('#s_theme','theme');bindSel('#s_language','language');
    bindChk('#s_showNotifications','showNotifications');bindChk('#s_minimizeToTray','minimizeToTray');
    bindSel('#s_retentionDays','retentionDays',true);bindChk('#s_autoCleanup','autoCleanup');
    bindChk('#s_debug','debug');bindChk('#s_verbose','verbose');
    $('#saveSettings').onclick=async()=>{
      await api('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(this.draft)});
      S.settings=null;await refresh();this.toast('Settings saved');
    };
    $('#cRestart').onclick=async()=>{await api('/collector/restart',{method:'POST'});this.toast('Collector restarted')};
    $('#cStop').onclick=async()=>{await api('/collector/stop',{method:'POST'});this.toast('Collector stopped')};
    $('#cStart').onclick=async()=>{await api('/collector/start',{method:'POST'});this.toast('Collector started')};
    $('#resetDefaults').onclick=async()=>{if(!confirm('Reset all settings to defaults?'))return;
      await api('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoCapture:true,autoStop:true,skipTheRange:true,bufferSize:1000000,dpi:800,sensitivity:0.5,pollingRate:1000,debug:false,verbose:false})});
      S.settings=null;render();};
    $('#clearBuffer').onclick=async()=>{await fetch('http://127.0.0.1:8765/clear',{method:'POST'});this.toast('Collector buffer cleared')};
  },

  updateComputed(){
    const dpi=this.draft.dpi??S.settings?.dpi??800;
    const sens=this.draft.sensitivity??S.settings?.sensitivity??0.5;
    const e=$('#edpiOut');if(e)e.textContent=An.edpi(dpi,sens);
    const c=$('#cm360Out');if(c)c.textContent=An.cm360(dpi,sens).toFixed(1)+' cm';
  },

  toast(msg){
    let t=$('.toast');
    if(!t){t=document.createElement('div');t.className='toast';document.body.appendChild(t)}
    t.textContent=msg;t.classList.add('show');
    clearTimeout(this._tt);this._tt=setTimeout(()=>t.classList.remove('show'),2200);
  },

  tick(){}
};
