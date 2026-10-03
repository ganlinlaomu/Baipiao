export function adminHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay Admin</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#151515;background:#f5f5f2}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1100px;margin:auto;padding:28px}.card{background:#fff;border:1px solid #ddd;border-radius:14px;padding:18px;margin:14px 0}h1,h2{margin:0 0 12px}input,select,button,textarea{font:inherit;border:1px solid #bbb;border-radius:9px;padding:9px 11px}button{cursor:pointer;background:#151515;color:#fff;border-color:#151515}button:disabled{cursor:default;opacity:.55}button.secondary{background:#fff;color:#151515}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:#6b6b6b;font-size:13px}.item{padding:11px 0;border-top:1px solid #eee}.hidden{display:none}.token{word-break:break-all;background:#f1f1ee;padding:10px;border-radius:8px;font-family:ui-monospace,monospace}label{display:grid;gap:5px;font-size:13px;font-weight:600}.status{padding:8px 10px;border-radius:8px;margin-top:10px;background:#f1f1ee}.status.error{background:#fff0f0;color:#8b1b1b}.status.ok{background:#eef9ef;color:#185b20}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.stat{background:#f7f7f4;border:1px solid #e5e5df;border-radius:10px;padding:12px}.stat-label{font-size:12px;color:#6b6b6b}.stat-value{font-size:24px;font-weight:700;margin-top:4px}.activity-head{justify-content:space-between}.activity-meta{margin:12px 0}.table-wrap{overflow:auto}.activity-table{width:100%;border-collapse:collapse;font-size:13px}.activity-table th,.activity-table td{text-align:left;padding:8px;border-top:1px solid #eee;white-space:nowrap}.activity-table td.mono{font-family:ui-monospace,monospace;font-size:12px}
</style>
</head>
<body><div class="wrap">
<h1>Cloudflare Nostr Relay</h1><p class="muted">Applications, users and access policy are controlled by the relay owner.</p>
<div id="bootStatus" class="status">Loading admin interface…</div>
<div id="login" class="card hidden"><h2>Admin login</h2><div class="row"><input id="adminToken" type="password" placeholder="ADMIN_TOKEN" style="min-width:300px" autocomplete="current-password"><button id="openAdminButton" type="button">Open admin</button></div><div id="loginStatus" class="status hidden" role="status"></div></div>
<div id="panel" class="hidden">
<div id="pageStatus" class="status hidden" role="status"></div>
<div class="card">
  <div class="row activity-head"><h2>Relay activity / 读写状态</h2><button id="refreshStatsButton" class="secondary" type="button">Refresh</button></div>
  <div id="stats" class="stats"></div>
  <div id="activityMeta" class="muted activity-meta"></div>
  <h3>Recent stored writes / 最近写入</h3>
  <div class="table-wrap"><table class="activity-table"><thead><tr><th>Time</th><th>Kind</th><th>Pubkey</th><th>Event ID</th></tr></thead><tbody id="recentWrites"></tbody></table></div>
</div>
<div class="card"><h2>Relay policy</h2><div class="grid">
<label>Name<input id="relay_name"></label><label>Description<input id="relay_description"></label>
<label>Read policy<select id="read_policy"></select></label><label>Write policy<select id="write_policy"></select></label>
<label>Default query limit<input id="default_limit" type="number"></label><label>Max query limit<input id="max_limit" type="number"></label>
<label>Max filters / REQ<input id="max_filters" type="number"></label><label>Max subscriptions / connection<input id="max_subscriptions" type="number"></label>
<label>Max event bytes<input id="max_event_bytes" type="number"></label><label>Default write rate / min<input id="default_rate_limit" type="number"></label>
</div><p class="muted">Policies: public, approved app, approved NIP-42 user, app OR user, or app AND user.</p><button id="savePolicyButton" type="button">Save policy</button></div>
<div class="card"><h2>Applications</h2><div class="grid">
<label>Name<input id="app_name" placeholder="My App"></label><label>Type<select id="app_type"><option>web</option><option>native</option><option>service</option></select></label>
<label>Allowed origins (web)<input id="app_origins" placeholder="https://app.example.com"></label><label>Kinds (optional)<input id="app_kinds" placeholder="0,1,7,1059"></label>
<label>Rate/min<input id="app_rate" type="number" value="120"></label><label>Permissions<select id="app_perm"><option value="rw">read + write</option><option value="r">read only</option><option value="w">write only</option></select></label>
</div><button id="createAppButton" type="button">Create app token</button><div id="newToken"></div><div id="apps"></div></div>
<div class="card"><h2>Users</h2><div class="grid"><label>npub or hex pubkey<input id="user_pubkey"></label><label>Name<input id="user_name" placeholder="Optional label"></label><label>Kinds (optional)<input id="user_kinds" placeholder="0,1,7,1059"></label><label>Permissions<select id="user_perm"><option value="rw">read + write</option><option value="r">read only</option><option value="w">write only</option></select></label></div><button id="createUserButton" type="button">Add user</button><div id="users"></div></div>
</div></div>
<script src="/admin.js" defer></script>
</body></html>`;
}

export function adminScript(): string {
  return `(function(){
'use strict';
var token='';
var statsTimer=null;
var $=function(id){return document.getElementById(id)};

function safeStorageGet(key){try{return window.sessionStorage?window.sessionStorage.getItem(key):null}catch(_){return null}}
function safeStorageSet(key,value){try{if(window.sessionStorage)window.sessionStorage.setItem(key,value)}catch(_){}}
function setStatus(id,message,isError,isOk){var el=$(id);if(!el)return;el.textContent=message||'';el.classList.toggle('hidden',!message);el.classList.toggle('error',Boolean(isError));el.classList.toggle('ok',Boolean(isOk))}
function showPageError(error){setStatus('pageStatus',error instanceof Error?error.message:String(error),true,false)}
function csv(value){return String(value||'').split(',').map(function(x){return x.trim()}).filter(Boolean)}
function nums(value){return csv(value).map(Number).filter(Number.isInteger)}

async function api(path,opt){
  opt=opt||{};
  var headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token},opt.headers||{});
  var response=await fetch(path,Object.assign({},opt,{headers:headers,cache:'no-store'}));
  var body=null;
  try{body=await response.json()}catch(_){}
  if(!response.ok)throw new Error(body&&body.error?body.error:'HTTP '+response.status);
  return body;
}


function formatNumber(value){return Number(value||0).toLocaleString()}
function formatBytes(value){var n=Number(value||0);if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KiB';return (n/1024/1024).toFixed(2)+' MiB'}
function formatTime(value){var n=Number(value);if(!Number.isFinite(n)||n<=0)return '—';return new Date(n*1000).toLocaleString()}
function shortHex(value){var s=String(value||'');return s.length>18?s.slice(0,10)+'…'+s.slice(-6):s}
function renderStats(stats){
  var cards=[
    ['Online / 在线连接',stats.active_connections],
    ['Subscriptions / 活跃订阅',stats.active_subscriptions],
    ['Stored events / 已存事件',stats.stored_events],
    ['App sessions / App会话',stats.active_app_sessions],
    ['Read REQ / 读取请求',stats.read_requests],
    ['Events returned / 返回事件',stats.read_events],
    ['Read denied / 读取拒绝',stats.read_denied],
    ['Write attempts / 写入请求',stats.write_attempts],
    ['Write accepted / 写入成功',stats.write_accepted],
    ['Write denied / 写入拒绝',stats.write_denied],
    ['Database / 数据库',formatBytes(stats.database_bytes)]
  ];
  var root=$('stats');root.textContent='';
  cards.forEach(function(card){
    var box=document.createElement('div');box.className='stat';
    var label=document.createElement('div');label.className='stat-label';label.textContent=card[0];
    var value=document.createElement('div');value.className='stat-value';value.textContent=typeof card[1]==='number'?formatNumber(card[1]):String(card[1]||0);
    box.appendChild(label);box.appendChild(value);root.appendChild(box);
  });
  $('activityMeta').textContent='Last read / 最后读取: '+formatTime(stats.last_read_at)+'  ·  Last write / 最后写入: '+formatTime(stats.last_write_at);
  var tbody=$('recentWrites');tbody.textContent='';
  (stats.recent_writes||[]).forEach(function(item){
    var tr=document.createElement('tr');
    [formatTime(item.created_at),String(item.kind),shortHex(item.pubkey),shortHex(item.id)].forEach(function(value,index){
      var td=document.createElement('td');td.textContent=value;if(index>=2)td.className='mono';tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  if(!(stats.recent_writes||[]).length){
    var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=4;td.className='muted';td.textContent='No stored writes yet.';tr.appendChild(td);tbody.appendChild(tr);
  }
}

async function loadStats(){
  var stats=await api('/api/admin/stats');
  renderStats(stats||{});
}

function renderApps(apps){
  var root=$('apps');root.textContent='';
  apps.forEach(function(app){
    var item=document.createElement('div');item.className='item';
    var title=document.createElement('b');title.textContent=app.name;item.appendChild(title);
    var meta=document.createElement('span');meta.className='muted';meta.textContent=' '+app.type+' · '+(app.can_read?'R':'')+(app.can_write?'W':'')+' · '+(app.enabled?'enabled':'disabled')+' ';item.appendChild(meta);
    var button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Delete';
    button.addEventListener('click',function(){deleteApp(app.id).catch(showPageError)});item.appendChild(button);
    var id=document.createElement('div');id.className='muted';id.textContent=app.id;item.appendChild(id);
    root.appendChild(item);
  });
}

function renderUsers(users){
  var root=$('users');root.textContent='';
  users.forEach(function(user){
    var item=document.createElement('div');item.className='item';
    var title=document.createElement('b');title.textContent=user.name||user.pubkey.slice(0,16)+'…';item.appendChild(title);
    var meta=document.createElement('span');meta.className='muted';meta.textContent=' '+(user.can_read?'R':'')+(user.can_write?'W':'')+' ';item.appendChild(meta);
    var button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Delete';
    button.addEventListener('click',function(){deleteUser(user.pubkey).catch(showPageError)});item.appendChild(button);
    var key=document.createElement('div');key.className='muted';key.textContent=user.pubkey;item.appendChild(key);
    root.appendChild(item);
  });
}

async function load(){
  var state=await api('/api/admin/state');
  Object.entries(state.settings).forEach(function(entry){var el=$(entry[0]);if(el)el.value=String(entry[1])});
  renderApps(state.apps||[]);
  renderUsers(state.users||[]);
  renderStats(state.stats||{});
}

async function login(){
  token=$('adminToken').value.trim();
  if(!token){setStatus('loginStatus','Enter ADMIN_TOKEN first.',true,false);return}
  var button=$('openAdminButton');button.disabled=true;
  setStatus('loginStatus','Checking admin token…',false,false);
  try{
    await load();
    safeStorageSet('relay_admin_token',token);
    $('login').classList.add('hidden');
    $('panel').classList.remove('hidden');
    setStatus('loginStatus','',false,false);
    setStatus('pageStatus','Admin connected.',false,true);
    if(statsTimer)window.clearInterval(statsTimer);
    statsTimer=window.setInterval(function(){
      if(!document.hidden)loadStats().catch(function(){});
    },30000);
  }catch(error){
    setStatus('loginStatus',error instanceof Error?error.message:String(error),true,false);
  }finally{button.disabled=false}
}

async function savePolicy(){
  var keys=['relay_name','relay_description','read_policy','write_policy','default_limit','max_limit','max_filters','max_subscriptions','max_event_bytes','default_rate_limit'];
  var numeric=['default_limit','max_limit','max_filters','max_subscriptions','max_event_bytes','default_rate_limit'];
  var body={};
  keys.forEach(function(key){body[key]=numeric.includes(key)?Number($(key).value):$(key).value});
  await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(body)});
  await load();
  setStatus('pageStatus','Policy saved.',false,true);
}

async function createApp(){
  var permission=$('app_perm').value;
  var body={
    name:$('app_name').value,
    type:$('app_type').value,
    allowed_origins:csv($('app_origins').value),
    allowed_kinds:$('app_kinds').value?nums($('app_kinds').value):null,
    rate_limit:Number($('app_rate').value),
    can_read:permission.includes('r'),
    can_write:permission.includes('w')
  };
  var result=await api('/api/admin/apps',{method:'POST',body:JSON.stringify(body)});
  var root=$('newToken');root.textContent='';
  var p=document.createElement('p');var strong=document.createElement('b');strong.textContent='Copy this token now. It is shown only once.';p.appendChild(strong);
  var box=document.createElement('div');box.className='token';box.textContent=result.token;
  root.appendChild(p);root.appendChild(box);
  await load();
  setStatus('pageStatus','Application created.',false,true);
}

async function deleteApp(id){await api('/api/admin/apps/'+encodeURIComponent(id),{method:'DELETE'});await load();setStatus('pageStatus','Application deleted.',false,true)}
async function createUser(){
  var permission=$('user_perm').value;
  await api('/api/admin/users',{method:'POST',body:JSON.stringify({
    pubkey:$('user_pubkey').value,
    name:$('user_name').value,
    allowed_kinds:$('user_kinds').value?nums($('user_kinds').value):null,
    can_read:permission.includes('r'),
    can_write:permission.includes('w')
  })});
  await load();setStatus('pageStatus','User added.',false,true);
}
async function deleteUser(pubkey){await api('/api/admin/users/'+encodeURIComponent(pubkey),{method:'DELETE'});await load();setStatus('pageStatus','User deleted.',false,true)}

function bind(){
  var policyHtml='<option value="public">Public</option><option value="app">Approved apps only</option><option value="user">Approved users only</option><option value="app_or_user">Approved apps OR users</option><option value="app_and_user">Approved apps AND users</option>';
  $('read_policy').innerHTML=policyHtml;$('write_policy').innerHTML=policyHtml;
  $('openAdminButton').addEventListener('click',function(){login().catch(function(error){setStatus('loginStatus',String(error),true,false)})});
  $('adminToken').addEventListener('keydown',function(event){if(event.key==='Enter')login().catch(function(error){setStatus('loginStatus',String(error),true,false)})});
  $('refreshStatsButton').addEventListener('click',function(){loadStats().catch(showPageError)});
  $('savePolicyButton').addEventListener('click',function(){savePolicy().catch(showPageError)});
  $('createAppButton').addEventListener('click',function(){createApp().catch(showPageError)});
  $('createUserButton').addEventListener('click',function(){createUser().catch(showPageError)});
}

function init(){
  try{
    bind();
    setStatus('bootStatus','Admin interface ready.',false,true);
    $('login').classList.remove('hidden');
    token=safeStorageGet('relay_admin_token')||'';
    if(token){$('adminToken').value=token;login().catch(function(error){setStatus('loginStatus',String(error),true,false)})}
  }catch(error){
    setStatus('bootStatus','Admin UI failed to initialize: '+(error instanceof Error?error.message:String(error)),true,false);
  }
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();`;
}
