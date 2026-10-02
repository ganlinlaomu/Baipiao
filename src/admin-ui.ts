export function adminHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay Admin</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#151515;background:#f5f5f2}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1100px;margin:auto;padding:28px}.card{background:#fff;border:1px solid #ddd;border-radius:14px;padding:18px;margin:14px 0}h1,h2{margin:0 0 12px}input,select,button,textarea{font:inherit;border:1px solid #bbb;border-radius:9px;padding:9px 11px}button{cursor:pointer;background:#151515;color:#fff;border-color:#151515}button.secondary{background:#fff;color:#151515}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:#6b6b6b;font-size:13px}.item{padding:11px 0;border-top:1px solid #eee}.hidden{display:none}.danger{color:#9b1c1c}.token{word-break:break-all;background:#f1f1ee;padding:10px;border-radius:8px;font-family:ui-monospace,monospace}label{display:grid;gap:5px;font-size:13px;font-weight:600}.status{padding:8px 10px;border-radius:8px;margin-top:10px;background:#f1f1ee}
</style>
</head>
<body><div class="wrap">
<h1>Cloudflare Nostr Relay</h1><p class="muted">Applications, users and access policy are controlled by the relay owner.</p>
<div id="login" class="card"><h2>Admin login</h2><div class="row"><input id="adminToken" type="password" placeholder="ADMIN_TOKEN" style="min-width:300px"><button onclick="login()">Open admin</button></div><div id="loginStatus" class="status hidden"></div></div>
<div id="panel" class="hidden">
<div class="card"><h2>Relay policy</h2><div class="grid">
<label>Name<input id="relay_name"></label><label>Description<input id="relay_description"></label>
<label>Read policy<select id="read_policy">${policyOptions()}</select></label><label>Write policy<select id="write_policy">${policyOptions()}</select></label>
<label>Default query limit<input id="default_limit" type="number"></label><label>Max query limit<input id="max_limit" type="number"></label>
<label>Max filters / REQ<input id="max_filters" type="number"></label><label>Max subscriptions / connection<input id="max_subscriptions" type="number"></label>
<label>Max event bytes<input id="max_event_bytes" type="number"></label><label>Default write rate / min<input id="default_rate_limit" type="number"></label>
</div><p class="muted">Policies: public, approved app, approved NIP-42 user, app OR user, or app AND user.</p><button onclick="savePolicy()">Save policy</button></div>
<div class="card"><h2>Applications</h2><div class="grid">
<label>Name<input id="app_name" placeholder="My App"></label><label>Type<select id="app_type"><option>web</option><option>native</option><option>service</option></select></label>
<label>Allowed origins (web)<input id="app_origins" placeholder="https://app.example.com"></label><label>Kinds (optional)<input id="app_kinds" placeholder="0,1,7,1059"></label>
<label>Rate/min<input id="app_rate" type="number" value="120"></label><label>Permissions<select id="app_perm"><option value="rw">read + write</option><option value="r">read only</option><option value="w">write only</option></select></label>
</div><button onclick="createApp()">Create app token</button><div id="newToken"></div><div id="apps"></div></div>
<div class="card"><h2>Users</h2><div class="grid"><label>npub or hex pubkey<input id="user_pubkey"></label><label>Name<input id="user_name" placeholder="Optional label"></label><label>Kinds (optional)<input id="user_kinds" placeholder="0,1,7,1059"></label><label>Permissions<select id="user_perm"><option value="rw">read + write</option><option value="r">read only</option><option value="w">write only</option></select></label></div><button onclick="createUser()">Add user</button><div id="users"></div></div>
</div></div>
<script>
let token=sessionStorage.getItem('relay_admin_token')||'';
const $=id=>document.getElementById(id);
function policyOptions(){return ''}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...(opt.headers||{})}});let body=null;try{body=await r.json()}catch{}if(!r.ok)throw new Error(body?.error||('HTTP '+r.status));return body}
async function login(){token=$('adminToken').value.trim();try{await load();sessionStorage.setItem('relay_admin_token',token);$('login').classList.add('hidden');$('panel').classList.remove('hidden')}catch(e){$('loginStatus').textContent=e.message;$('loginStatus').classList.remove('hidden')}}
function csv(v){return v.split(',').map(x=>x.trim()).filter(Boolean)}
function nums(v){return csv(v).map(Number).filter(Number.isInteger)}
async function load(){const s=await api('/api/admin/state');for(const [k,v] of Object.entries(s.settings))if($(k))$(k).value=String(v);$('apps').innerHTML=s.apps.map(a=>'<div class="item"><b>'+esc(a.name)+'</b> <span class="muted">'+esc(a.type)+' · '+(a.can_read?'R':'')+(a.can_write?'W':'')+' · '+(a.enabled?'enabled':'disabled')+'</span> <button class="secondary" onclick="deleteApp(\''+a.id+'\')">Delete</button><div class="muted">'+a.id+'</div></div>').join('');$('users').innerHTML=s.users.map(u=>'<div class="item"><b>'+esc(u.name||u.pubkey.slice(0,16)+'…')+'</b> <span class="muted">'+(u.can_read?'R':'')+(u.can_write?'W':'')+'</span> <button class="secondary" onclick="deleteUser(\''+u.pubkey+'\')">Delete</button><div class="muted">'+u.pubkey+'</div></div>').join('')}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function savePolicy(){const keys=['relay_name','relay_description','read_policy','write_policy','default_limit','max_limit','max_filters','max_subscriptions','max_event_bytes','default_rate_limit'];const body={};for(const k of keys)body[k]=['default_limit','max_limit','max_filters','max_subscriptions','max_event_bytes','default_rate_limit'].includes(k)?Number($(k).value):$(k).value;await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(body)});await load()}
async function createApp(){const p=$('app_perm').value;const body={name:$('app_name').value,type:$('app_type').value,allowed_origins:csv($('app_origins').value),allowed_kinds:$('app_kinds').value?nums($('app_kinds').value):null,rate_limit:Number($('app_rate').value),can_read:p.includes('r'),can_write:p.includes('w')};const r=await api('/api/admin/apps',{method:'POST',body:JSON.stringify(body)});$('newToken').innerHTML='<p><b>Copy this token now. It is shown only once.</b></p><div class="token">'+esc(r.token)+'</div>';await load()}
async function deleteApp(id){await api('/api/admin/apps/'+encodeURIComponent(id),{method:'DELETE'});await load()}
async function createUser(){const p=$('user_perm').value;await api('/api/admin/users',{method:'POST',body:JSON.stringify({pubkey:$('user_pubkey').value,name:$('user_name').value,allowed_kinds:$('user_kinds').value?nums($('user_kinds').value):null,can_read:p.includes('r'),can_write:p.includes('w')})});await load()}
async function deleteUser(pubkey){await api('/api/admin/users/'+encodeURIComponent(pubkey),{method:'DELETE'});await load()}
for(const s of ['read_policy','write_policy'])$(s).innerHTML='<option value="public">Public</option><option value="app">Approved apps only</option><option value="user">Approved users only</option><option value="app_or_user">Approved apps OR users</option><option value="app_and_user">Approved apps AND users</option>';
if(token){$('adminToken').value=token;login()}
</script></body></html>`;
}

function policyOptions(): string { return ''; }
