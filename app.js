const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let currentUser = null, folders = [], files = [], users = [], sharedUsers = [];
let sharingEnabled = true, lastActivity = 0, idleMs = 900000, activityPending = false, heartbeatBusy = false;
let activeUpload = null, currentView = 'files', lastHeartbeat = 0;
let loginIntroSequence = 0;
let loginIntroTimer;
let loginArtworkReady;
let maxFileSize = 5 * 1024 ** 3, auditEntries = [], pendingBackup = null;
let entrySequence = 0, entryTimer, entryResolve, itemMenu = null, itemMenuTrigger = null;
const permissionLabels = { upload: 'رفع الملفات', download: 'تنزيل الملفات', rename: 'إعادة تسمية ملفاته', move: 'نقل ملفاته', delete: 'حذف ملفاته إلى السلة', share: 'مشاركة ملفاته' };
const can = permission => currentUser?.role === 'admin' || !!currentUser?.permissions?.[permission];
const dateTime = new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', dateStyle: 'medium', timeStyle: 'short' });
// Each tab has its own demo login so different accounts can be compared.
const channel = null;
const arabicDate = new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', year: 'numeric', month: 'short', day: 'numeric' });
const formatNumber = n => new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 1 }).format(n);
function sizeLabel(bytes) { const units = ['بايت', 'ك.ب', 'م.ب', 'ج.ب']; let i = 0; while (bytes >= 1024 && i < 3) { bytes /= 1024; i++; } return `${formatNumber(bytes)} ${units[i]}`; }
function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; }
function action(label, callback, className = 'text-button') { const b = node('button', label, className); b.type = 'button'; b.addEventListener('click', () => Promise.resolve(callback()).catch(showError)); return b; }
function notice(message, isError = false) { const el = $('#notice'); el.textContent = message; el.className = isError ? 'notice error' : 'notice'; el.hidden = false; }
function showError(error) { if (currentUser) notice(error.message || 'تعذّر إكمال العملية.', true); }
function cancelLoginIntro() {
  loginIntroSequence++;
  clearTimeout(loginIntroTimer);
}
function completeLoginIntro(sequence) {
  if (sequence !== loginIntroSequence || currentUser || $('#login-screen').hidden) return;
  $('#login-screen').dataset.introState = 'ready';
  $('.login-fields').inert = false;
  clearTimeout(loginIntroTimer);
  window.PortalStartup?.complete();
}
function positionLoginIntro() {
  const screen = $('#login-screen');
  if (screen.hidden || !['preparing', 'running'].includes(screen.dataset.introState)) return;
  // Measure the stationary slot so a resize cannot measure the moving logo.
  const box = $('.login-brand-slot').getBoundingClientRect();
  screen.style.setProperty('--intro-x', `${window.innerWidth / 2 - box.left - box.width / 2}px`);
  screen.style.setProperty('--intro-y', `${window.innerHeight / 2 - box.top - box.height / 2}px`);
  screen.style.setProperty('--intro-scale', Math.max(1, Math.min(1.35, (window.innerWidth - 40) / box.width)));
}
function prepareLoginArtwork() {
  if (!loginArtworkReady) {
    const picture = new Image(); picture.src = 'background.png';
    const imageReady = picture.decode ? picture.decode().catch(() => {}) : Promise.resolve();
    const fontsReady = document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve();
    loginArtworkReady = new Promise(resolve => {
      const fallback = setTimeout(resolve, 2000);
      Promise.all([imageReady, fontsReady]).then(() => { clearTimeout(fallback); resolve(); });
    });
  }
  return loginArtworkReady;
}
async function revealLoginControls() {
  const screen = $('#login-screen');
  if (screen.hidden || ['preparing', 'running', 'ready'].includes(screen.dataset.introState)) return;
  cancelLoginIntro();
  const sequence = loginIntroSequence;
  screen.dataset.introState = 'preparing';
  $('.login-fields').inert = true;
  try { await prepareLoginArtwork(); }
  catch { completeLoginIntro(sequence); return; }
  if (sequence !== loginIntroSequence || currentUser || screen.hidden || screen.dataset.introState !== 'preparing') return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { completeLoginIntro(sequence); return; }
  positionLoginIntro();
  screen.dataset.introState = 'running';
  // CSS runs a 2.6s logo sequence, followed by a 0.65s form reveal.
  // Keep the timing independent of Animation.finished and viewport resize events.
  loginIntroTimer = setTimeout(() => completeLoginIntro(sequence), 3350);
}
window.addEventListener('resize', positionLoginIntro, { passive: true });
// Only transform and opacity animate; the form stays hidden and inert until the end.
void revealLoginControls();

function closeProfileMenu(returnFocus = false) {
  $('#profile-menu').hidden = true; $('#profile-toggle').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('#profile-toggle').focus();
}
function renderProfile() {
  if (!currentUser) return;
  $('#account-name').textContent = currentUser.name;
  $('#account-job-title').textContent = currentUser.jobTitle || 'لم يُحدد المسمى الوظيفي';
  $('#account-role').textContent = currentUser.role === 'admin' ? 'مسؤول نظام' : 'مستخدم';
  $('#profile-toggle').setAttribute('aria-label', `الملف الشخصي: ${currentUser.name}`);
}
function cancelEntryAnimation() {
  entrySequence++; clearTimeout(entryTimer);
  if (entryResolve) { entryResolve(false); entryResolve = null; }
  $('#welcome-screen').hidden = true; $('#welcome-screen').removeAttribute('data-phase');
  $('#login-screen').classList.remove('login-leaving'); document.body.classList.remove('entry-running');
  $('#portal').inert = false; closeProfileMenu();
}
function entryPause(ms, sequence) {
  return new Promise(resolve => {
    entryResolve = resolve;
    entryTimer = setTimeout(() => { entryResolve = null; resolve(sequence === entrySequence && !!currentUser); }, ms);
  });
}
function positionWelcomeIcon() {
  if ($('#welcome-screen').hidden) return;
  const target = $('.profile-avatar').getBoundingClientRect();
  // The welcome avatar is 88px wide and centered 32px above the viewport midpoint.
  const stage = $('#welcome-screen');
  stage.style.setProperty('--profile-dx', `${target.left + target.width / 2 - window.innerWidth / 2}px`);
  stage.style.setProperty('--profile-dy', `${target.top + target.height / 2 - (window.innerHeight / 2 - 32)}px`);
  stage.style.setProperty('--profile-scale', String(target.width / 88));
}
window.addEventListener('resize', positionWelcomeIcon, { passive: true });
async function playEntryAnimation(sequence) {
  const firstName = currentUser.name.trim().split(/\s+/u)[0];
  $('#welcome-name').textContent = firstName;
  $('#welcome-screen').dataset.phase = 'waiting'; $('#welcome-screen').hidden = false;
  $('#login-screen').classList.add('login-leaving');
  if (!await entryPause(650, sequence)) return;
  $('#login-screen').hidden = true;
  $('#welcome-name').textContent = firstName;
  $('#welcome-screen').hidden = false; $('#welcome-screen').dataset.phase = 'greeting';
  if (!await entryPause(1200, sequence)) return;
  positionWelcomeIcon(); $('#welcome-screen').dataset.phase = 'docking';
  if (!await entryPause(940, sequence)) return;
  cancelEntryAnimation(); $('#main-content').focus({ preventScroll: true });
}

async function api(path, options = {}) {
  try { return await window.DemoPortal.request(path, options); }
  catch (error) {
    if (error.status === 401 && path !== '/api/login') showLogin(error.message);
    throw error;
  }
}

function showLogin(message = '') {
  const returningToLogin = $('#login-screen').hidden;
  cancelEntryAnimation();
  currentUser = null; activityPending = false; folders = []; files = []; users = []; sharedUsers = [];
  activeUpload?.abort(); activeUpload = null;
  $('#upload-progress-wrap').hidden = true;
  $$('dialog[open]').forEach(d => d.close());
  $('#portal').hidden = true; $('#login-screen').hidden = false; $('#login-password').value = '';
  if (returningToLogin) $('#login-screen').dataset.introState = 'idle';
  $('#login-error').textContent = message; $('#notice').hidden = true;
  for (const id of ['files-body','users-body','shares-list','folders-list']) $('#' + id).replaceChildren();
  $('#user-password').value = ''; $('#upload-file').value = ''; pendingBackup = null;
  $('#password-form').reset(); $('#profile-form').reset(); $('#backup-file').value = ''; closeItemMenu(); revealLoginControls();
}
async function logout(message = '', broadcast = true) {
  activeUpload?.abort();
  showLogin(message); if (broadcast) channel?.postMessage({ type: 'logout', message });
  try { await api('/api/logout', { method: 'POST' }); } catch { /* Local view is still locked if the network is unavailable. */ }
}
async function heartbeat() {
  if (!currentUser || !activityPending || heartbeatBusy) return;
  heartbeatBusy = true; activityPending = false;
  try { await api('/api/activity', { method: 'POST' }); lastHeartbeat = Date.now(); }
  catch (e) { if (currentUser) { activityPending = true; notice('تعذّر تحديث الجلسة التجريبية. أعد فتح الصفحة.', true); } }
  finally { heartbeatBusy = false; }
}
function activity(event) {
  if (!currentUser || !event.isTrusted) return;
  if (event.type === 'pointermove' && Date.now() - lastActivity < 1000) return;
  if (Date.now() - lastActivity >= idleMs) { void logout('انتهت الجلسة. سجّل الدخول مجددًا.'); return; }
  lastActivity = Date.now(); activityPending = true;
  channel?.postMessage({ type: 'activity', at: lastActivity });
  if (Date.now() - lastHeartbeat > 30000) void heartbeat();
}
for (const type of ['pointerdown','pointermove','keydown','input','wheel','touchstart']) document.addEventListener(type, activity, { passive: true });
setInterval(async () => {
  if (!currentUser) return;
  if (Date.now() - lastActivity >= idleMs) void logout('انتهت الجلسة. سجّل الدخول مجددًا.');
  else {
    void heartbeat();
    try { await api('/api/me'); } catch (error) { showError(error); }
  }
}, 5000);
if (channel) channel.onmessage = event => {
  if (event.data.type === 'logout') showLogin(event.data.message || 'تم تسجيل الخروج.');
  if (event.data.type === 'activity' && currentUser) lastActivity = Math.max(lastActivity, event.data.at);
};
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !currentUser) return;
  try { const data = await api('/api/me'); lastActivity = Math.max(lastActivity, data.lastActive); sharingEnabled = data.sharingEnabled; await showView(currentView, false); }
  catch (e) { showError(e); }
});

function fillFolders(select, placeholder, preserve = true) {
  const value = preserve ? select.value : '';
  select.replaceChildren();
  if (placeholder !== null) { const o = node('option', placeholder); o.value = ''; select.append(o); }
  for (const f of folders) { const o = node('option', f.name); o.value = f.id; select.append(o); }
  if (folders.some(f => f.id === value)) select.value = value;
}
async function loadFolders() {
  folders = (await api('/api/folders')).folders;
  fillFolders($('#upload-folder'), 'اختر مجلدًا'); fillFolders($('#file-folder'), 'جميع المجلدات'); fillFolders($('#edit-file-folder'), null);
  renderFolderCards();
  updateUpload();
}
function updateUpload() {
  const selected = !!$('#upload-folder').value;
  $('#upload-file').disabled = !selected || !!activeUpload || !can('upload');
  $('#upload-button').disabled = !selected || !$('#upload-file').files.length || !!activeUpload || !can('upload');
  $('#upload-folder').disabled = !!activeUpload;
  $('#file-hint').textContent = !can('upload') ? 'صلاحية رفع الملفات غير مفعلة لحسابك.' : selected ? 'اختر الملف الذي تريد رفعه إلى هذا المجلد.' : 'حدد المجلد لتتمكن من اختيار الملف.';
}
async function loadFiles() {
  const [data, me] = await Promise.all([api('/api/files'), api('/api/me')]);
  files = data.files; sharingEnabled = data.sharingEnabled; currentUser = me.user; maxFileSize = me.maxFileSize;
  $('#upload-file').accept = me.extensions.map(e => '.' + e).join(',');
  renderProfile();
  updateUpload(); renderFolderCards(); renderFiles();
}
function searchKey(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/[٠-٩]/g,n=>String(n.charCodeAt(0)-1632));
}
function fileMatches(file, query) {
  return !query || searchKey([file.name,file.owner_name,file.folder_name,sizeLabel(file.size),arabicDate.format(new Date(file.created_at))].join(' ')).includes(query);
}
function closeItemMenu(returnFocus=false) {
  const trigger=itemMenuTrigger;
  itemMenu?.remove();itemMenu=null;itemMenuTrigger=null;
  trigger?.setAttribute('aria-expanded','false');
  if(returnFocus&&trigger?.isConnected)trigger.focus();
}
function itemMenuButton(name,options) {
  const trigger=action('⋯',()=>{
    if(itemMenuTrigger===trigger){closeItemMenu(true);return;}
    closeItemMenu();closeProfileMenu();itemMenuTrigger=trigger;
    itemMenu=node('div',undefined,'item-menu');itemMenu.id='active-item-menu';
    itemMenu.setAttribute('role','menu');itemMenu.setAttribute('aria-label','إجراءات '+name);
    trigger.setAttribute('aria-expanded','true');
    for(const option of options){
      const button=action(option.label,()=>{closeItemMenu(true);return option.run?.();},option.danger?'menu-danger':'');
      button.setAttribute('role','menuitem');button.disabled=!!option.disabled;itemMenu.append(button);
    }
    document.body.append(itemMenu);
    const anchor=trigger.getBoundingClientRect(),box=itemMenu.getBoundingClientRect();
    itemMenu.style.left=Math.max(12,Math.min(anchor.right-box.width,window.innerWidth-box.width-12))+'px';
    itemMenu.style.top=Math.max(12,anchor.bottom+box.height+8>window.innerHeight?anchor.top-box.height-8:anchor.bottom+8)+'px';
    itemMenu.querySelector('button:not(:disabled)')?.focus();
  },'item-more');
  trigger.setAttribute('aria-label','إجراءات '+name);trigger.setAttribute('aria-haspopup','menu');
  trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls','active-item-menu');
  return trigger;
}
document.addEventListener('click',event=>{if(itemMenu&&!itemMenu.contains(event.target)&&!itemMenuTrigger?.contains(event.target))closeItemMenu();});
document.addEventListener('keydown',event=>{
  if(!itemMenu)return;
  if(event.key==='Escape'){event.preventDefault();closeItemMenu(true);return;}
  if(event.key==='Tab'){closeItemMenu(true);return;}
  const buttons=[...itemMenu.querySelectorAll('button:not(:disabled)')];
  if(!buttons.length||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const index=buttons.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
  buttons[next].focus();
});
window.addEventListener('resize',()=>closeItemMenu());
document.addEventListener('scroll',event=>{if(itemMenu&&!itemMenu.contains(event.target))closeItemMenu();},true);
function renderFolderCards() {
  closeItemMenu();
  const list=$('#folder-cards'),query=searchKey($('#file-search').value.trim());list.replaceChildren();
  const visible=folders.filter(folder=>!query||searchKey(folder.name).includes(query)||files.some(file=>file.folder_id===folder.id&&fileMatches(file,query)));
  for(const folder of visible){
    const card=node('div',undefined,'folder-card');card.dataset.folderId=folder.id;
    const selected=$('#file-folder').value===folder.id;card.classList.toggle('selected',selected);
    const open=action('',()=>{$('#file-folder').value=folder.id;$('#upload-folder').value=folder.id;updateUpload();renderFolderCards();renderFiles();},'folder-open');
    open.setAttribute('aria-pressed',String(selected));open.setAttribute('aria-label','فتح مجلد '+folder.name);
    const icon=node('span',undefined,'folder-symbol');icon.setAttribute('aria-hidden','true');
    icon.innerHTML='<svg viewBox="0 0 64 52" fill="none"><path d="M5 15V10a6 6 0 0 1 6-6h13l7 7h22a6 6 0 0 1 6 6v24a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7V15Z" fill="currentColor" opacity=".24"/><path d="M5 21a6 6 0 0 1 6-6h42a6 6 0 0 1 6 6v20a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7V21Z" fill="currentColor"/><path d="M15 25h20" stroke="white" stroke-width="3" stroke-linecap="round" opacity=".7"/></svg>';
    open.append(icon,node('strong',folder.name));
    card.append(open,itemMenuButton(folder.name,[{label:'أذونات الاطلاع',run:()=>openTargetShare('folder',folder)}]));list.append(card);
  }
  if(!visible.length)list.append(node('p',folders.length?'لا توجد مجلدات مطابقة للبحث.':'لم يخصص المسؤول أي مجلد لحسابك بعد.','muted folder-empty'));
}
async function downloadFile(file) {
  const result=await api(`/api/files/${file.id}/download`),url=URL.createObjectURL(result.blob);
  const link=node('a');link.href=url;link.download=result.name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function renderFiles() {
  closeItemMenu();
  const scope=$('#file-scope').value,folder=$('#file-folder').value,query=searchKey($('#file-search').value.trim());
  const visible=files.filter(f=>(scope==='all'||(scope==='own'?f.owner_id===currentUser.id:f.owner_id!==currentUser.id))&&(!folder||f.folder_id===folder)&&fileMatches(f,query));
  const body=$('#files-body');body.replaceChildren();
  $('#file-count').textContent=`${formatNumber(visible.length)} ملف`;
  $('#search-summary').textContent=query?`${formatNumber(visible.length)} ملف في العرض الحالي · ${formatNumber($('#folder-cards').querySelectorAll('.folder-card').length)} مجلد مطابق`:'ابحث ضمن الملفات والمجلدات المصرح لك بها.';
  $('#files-empty').hidden=visible.length>0;
  $('#empty-title').textContent=query?'لا توجد ملفات مطابقة للبحث':scope==='shared'?'لا توجد ملفات مشتركة للعرض':'لا توجد ملفات في هذا العرض';
  $('#empty-description').textContent=query?'جرّب اسمًا آخر أو غيّر تصفية المجلد ونوع الملفات.':scope==='shared'?(sharingEnabled?'تظهر هنا الملفات التي مُنحت إذن الاطلاع عليها.':'أغلق مسؤول النظام المشاركة بين المستخدمين حاليًا.'):'اختر مجلدًا وارفع أول ملف لك.';
  for(const f of visible){
    const row=node('tr'),nameCell=node('td'),name=node('div',undefined,'file-name'),mark=node('span','▤','file-mark');
    mark.setAttribute('aria-hidden','true');name.append(mark,node('span',f.name));nameCell.append(name);row.append(nameCell);
    row.append(node('td',f.folder_name),node('td',f.owner_id===currentUser.id?'أنت':f.owner_name),node('td',sizeLabel(f.size)),node('td',arabicDate.format(new Date(f.created_at))));
    const controls=node('td'),actions=node('div',undefined,'row-actions');
    if(can('download')){const button=action('تنزيل',()=>downloadFile(f),'download');button.setAttribute('aria-label','تنزيل '+f.name);actions.append(button);}
    const own=f.owner_id===currentUser.id,editable=own||currentUser.role==='admin';
    const options=[{label:'أذونات الاطلاع',run:()=>openTargetShare('file',f),disabled:!own}];
    if(editable&&(can('rename')||can('move')))options.push({label:'تعديل',run:()=>openFile(f)});
    if(editable&&can('delete'))options.push({label:'حذف',danger:true,run:()=>deleteFile(f)});
    if(!own)options.push({label:'إدارة الإذن متاحة لصاحب الملف',disabled:true});
    actions.append(itemMenuButton(f.name,options));controls.append(actions);row.append(controls);body.append(row);
  }
}

async function showView(view, focus = true) {
  if (!currentUser || !['files','upload','shares','admin','trash','audit'].includes(view) || (['admin','trash','audit'].includes(view) && currentUser.role !== 'admin')) return;
  closeItemMenu(); closeProfileMenu(); currentView = view; $('#notice').hidden = true;
  for (const name of ['files','upload','shares','admin','trash','audit']) $('#' + name + '-view').hidden = name !== view;   $$('.nav-item').forEach(b => { const active = b.dataset.view === view; b.classList.toggle('active',active); if (active) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  if (focus) $('#main-content').focus({ preventScroll: true });   if (view === 'files' || view === 'upload') { await loadFolders(); await loadFiles(); }   else if (view === 'shares') await loadShares();   else if (view === 'admin') await loadAdmin();   else if (view === 'trash') await loadTrash();   else await loadAudit(); } async function enterPortal(data, animate = false) {   cancelLoginIntro(); cancelEntryAnimation();   const sequence = entrySequence;   const withMotion = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches;   currentUser = data.user; lastActivity = data.lastActive; idleMs = data.idleMs; lastHeartbeat = Date.now();   renderProfile();   $$('.admin-only').forEach(el => el.hidden = currentUser.role !== 'admin');$('#portal').hidden = false; $('#portal').inert = withMotion; $('#login-password').value = '';
  if (withMotion) document.body.classList.add('entry-running');
  else $('#login-screen').hidden = true;
  $('#all-files-option').hidden = currentUser.role !== 'admin';
  $('#file-scope').value = currentUser.role === 'admin' ? 'all' : 'own'; $('#file-folder').value = ''; $('#upload-folder').value = ''; $('#file-search').value = ''; $('#audit-search').value = '';
  try {
    await showView('files',false);
    if (sequence !== entrySequence || !currentUser) return;
    if (withMotion) await playEntryAnimation(sequence);
  } catch (error) {
    if (sequence === entrySequence) { cancelEntryAnimation(); if (currentUser) $('#login-screen').hidden = true; }
    throw error;
  }
}
$('#login-form').addEventListener('submit',async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { const data = await api('/api/login',{method:'POST',data:{username:$('#login-username').value,password:$('#login-password').value}}); await enterPortal(data, true); }
  catch(e) { if (currentUser) showError(e); else $('#login-error').textContent = e.message; }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click',()=>void logout());
$('#profile-toggle').addEventListener('click',()=>{
  const expanded = $('#profile-menu').hidden; $('#profile-menu').hidden = !expanded;
  $('#profile-toggle').setAttribute('aria-expanded', String(expanded));
});
document.addEventListener('click',event=>{if(!event.target.closest?.('.profile-account'))closeProfileMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#profile-menu').hidden){closeProfileMenu(true);}});
$('#edit-profile').addEventListener('click',()=>{
  closeProfileMenu(); $('#profile-name').value=currentUser.name;$('#profile-job-title').value=currentUser.jobTitle||'';
  $('#profile-username').value=currentUser.username;$('#profile-username').readOnly=currentUser.role!=='admin';$('#profile-email').value=currentUser.email||'';$('#profile-phone').value=currentUser.phone||'';
  $('#profile-error').textContent='';$('#profile-dialog').showModal();
});
$('#profile-form').addEventListener('submit',async event=>{
  event.preventDefault();event.submitter.disabled=true;
  try{const result=await api('/api/profile',{method:'PATCH',data:{...(currentUser.role==='admin'?{username:$('#profile-username').value}:{}),email:$('#profile-email').value,phone:$('#profile-phone').value}});currentUser=result.user;renderProfile();$('#profile-dialog').close();notice('تم حفظ بياناتك الشخصية.');}
  catch(error){$('#profile-error').textContent=error.message;}finally{event.submitter.disabled=false;} }); $$('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view).catch(showError)));
$('#upload-folder').addEventListener('change',updateUpload); $('#upload-file').addEventListener('change',updateUpload);
$('#file-scope').addEventListener('change',()=>loadFiles().catch(showError)); $('#file-folder').addEventListener('change',()=>{renderFiles();renderFolderCards();});
$('#file-search').addEventListener('input',()=>{renderFolderCards();renderFiles();});
$('#clear-folder').addEventListener('click',()=>{$('#file-folder').value='';renderFolderCards();renderFiles();});
$('#refresh-files').addEventListener('click',()=>loadFiles().catch(showError));
$('#cancel-upload').addEventListener('click',()=>activeUpload?.abort());
$('#upload-form').addEventListener('submit',async event=>{
  event.preventDefault(); if (activeUpload) return;
  const file = $('#upload-file').files[0], folder = $('#upload-folder').value;
  if (!folder || !file) return notice('اختر المجلد والملف أولًا.',true);
  if (file.size > maxFileSize) return notice(`الحد الأقصى للملف الواحد ${sizeLabel(maxFileSize)}.`,true);
  const controller = new AbortController(); activeUpload = controller; updateUpload();
  $('#upload-progress-wrap').hidden = false; $('#upload-progress').removeAttribute('value'); $('#upload-status').textContent = 'جارٍ تفقد مساحة السيرفر ثم رفع الملف…';
  try {
    await window.DemoPortal.upload(file, folder, controller.signal);
    if (!currentUser) return;
    $('#upload-file').value = ''; notice(`تم رفع «${file.name}» إلى السيرفر وحفظ نسخة محلية لعرضه في البوابة.`); await loadFiles();
  } catch (error) {
    if (error.status === 401) showLogin(error.message);
    else if (currentUser) notice(error.message || 'تعذّر حفظ الملف في المتصفح.', error.status !== 499);
  } finally { if (activeUpload === controller) { activeUpload = null; $('#upload-progress-wrap').hidden = true; updateUpload(); } }
});

function openFile(f) { $('#edit-file-id').value=f.id;$('#edit-file-name').value=f.name;$('#edit-file-name').disabled=!can('rename');fillFolders($('#edit-file-folder'),null);$('#edit-file-folder').value=f.folder_id;$('#edit-file-folder').disabled=!can('move');$('#file-error').textContent='';$('#file-dialog').showModal(); }
async function openTargetShare(kind,target) {
  $('#share-file-id').value=target.id;$('#share-target-kind').value=kind;$('#file-share-error').textContent='';
  if(await loadTargetShare() && currentUser)$('#file-share-dialog').showModal();
}
async function loadTargetShare() {
  const kind=$('#share-target-kind').value,targetId=$('#share-file-id').value;
  const data=await api('/api/shares'),target=(kind==='folder'?data.folders:data.files).find(item=>item.id===targetId);
  if(!target)throw new Error('هذا العنصر غير متاح لإدارة أذوناته.');
  const direct=data.grants.filter(g=>g.kind===kind&&g.targetId===targetId).map(g=>g.viewerId);
  const inherited=kind==='file'?(await api(`/api/files/${targetId}/shares`)).folderViewerIds:[];
  if(!currentUser || $('#share-file-id').value!==targetId || $('#share-target-kind').value!==kind)return false;
  $('#file-share-title').textContent='أذونات الاطلاع · '+(kind==='folder'?'مجلد':'ملف');
  $('#file-share-name').textContent=target.name;
  $('#target-share-help').textContent=kind==='folder'?'يشمل الإذن ملفاتك الحالية والجديدة داخل هذا المجلد، ولا يشمل ملفات الآخرين أو المجلدات الأخرى.':'يشمل الإذن هذا الملف فقط. الإذن الموروث من المجلد يُدار من قائمة المجلد.';
  const message=$('#file-share-state');message.textContent=data.sharingEnabled?'اختر مستخدمًا لمنحه إذن الاطلاع.':'منح الأذونات غير متاح حاليًا. يمكنك إلغاء الأذونات المحفوظة.';
  message.className=data.sharingEnabled?'notice':'notice warning';
  const select=$('#file-share-user');select.replaceChildren();const placeholder=node('option','اختر مستخدمًا');placeholder.value='';select.append(placeholder);
  for(const user of data.users.filter(u=>target.viewerIds.includes(u.id)&&!direct.includes(u.id)&&!inherited.includes(u.id))){const option=node('option',`${user.name} (${user.username})`);option.value=user.id;select.append(option);}
  select.disabled=!data.sharingEnabled||select.options.length===1;
  $('#file-share-submit').disabled=select.disabled;
  if(data.sharingEnabled && select.options.length===1)message.textContent='لا يوجد مستخدم متاح لمنحه إذن جديد لهذا العنصر.';
  const viewerIds=[...new Set([...direct,...inherited])],list=$('#file-share-list');list.replaceChildren();$('#file-share-empty').hidden=viewerIds.length>0;
  for(const viewerId of viewerIds){
    const user=data.users.find(u=>u.id===viewerId);if(!user)continue;
    const item=node('div',undefined,'list-item'),label=node('div');label.append(node('strong',user.name),node('small',user.username));
    if(inherited.includes(viewerId))label.append(node('small','إذن موروث من المجلد؛ يمكنك إلغاؤه من قائمة المجلد.'));
    item.append(label);
    if(direct.includes(viewerId))item.append(action('إلغاء الإذن',async()=>{
      try{
        await api(`/api/shares/${kind}/${targetId}/${viewerId}`,{method:'DELETE'});await loadTargetShare();
        $('#file-share-error').textContent='';$('#file-share-state').textContent=inherited.includes(viewerId)?'أُلغي إذن الملف. ما زال إذن المجلد ساريًا ويمكن إلغاؤه من قائمة المجلد.':'تم إلغاء الإذن.';
      }catch(error){$('#file-share-error').textContent=error.message;}
    },'quiet'));
    else item.append(node('span','إذن للمجلد','role-badge'));
    list.append(item);
  }
  return true;
}
$('#file-share-form').addEventListener('submit',async event=>{
  event.preventDefault();const viewerId=$('#file-share-user').value;if(!viewerId)return;
  $('#file-share-submit').disabled=true;$('#file-share-error').textContent='';
  try{
    await api('/api/shares',{method:'POST',data:{kind:$('#share-target-kind').value,targetId:$('#share-file-id').value,viewerId}});
    await loadTargetShare();$('#file-share-state').textContent='تم منح إذن الاطلاع.';
  }catch(error){if(currentUser){await loadTargetShare().catch(()=>{});$('#file-share-error').textContent=error.message;}}
});

async function deleteFile(file) {
  const dialog=$('#confirm-dialog'); $('#confirm-message').textContent=`هل تريد حذف «${file.name}»؟`; dialog.returnValue=''; dialog.showModal();
  const result = await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));
  if(result!=='confirm')return;
  await api(`/api/files/${file.id}`,{method:'DELETE'}); await loadFiles(); notice('نُقل الملف إلى سلة المحذوفات. يستطيع مسؤول النظام استعادته.');
}
$('#file-edit-form').addEventListener('submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{await api(`/api/files/${$('#edit-file-id').value}`,{method:'PATCH',data:{name:$('#edit-file-name').value,folderId:$('#edit-file-folder').value}});$('#file-dialog').close();await loadFiles();notice('تم حفظ تعديلات الملف.');}catch(e){$('#file-error').textContent=e.message;}finally{event.submitter.disabled=false;}});

async function loadShares() {
  const data=await api('/api/shares');
  $('#sharing-state').textContent=data.sharingEnabled?'لمنح إذن أو إلغائه، استخدم قائمة الثلاث نقاط بجانب الملف أو المجلد في صفحة الملفات.':'منح الأذونات متوقف حاليًا. يمكنك إلغاء إذن محفوظ من قائمة العنصر.';
  $('#sharing-state').className=data.sharingEnabled?'notice':'notice warning';
  const list=$('#shares-list');list.replaceChildren();$('#shares-empty').hidden=data.grants.length>0;
  for(const grant of data.grants){
    const viewer=data.users.find(u=>u.id===grant.viewerId);if(!viewer)continue;
    const item=node('div',undefined,'list-item'),label=node('div');
    label.append(node('strong',grant.name),node('small',viewer.name+' ('+viewer.username+')'));
    item.append(label,node('span',grant.kind==='folder'?'مجلد':'ملف','role-badge'));list.append(item);
  }
}

async function loadAdmin() {
  const [data,settings,stats]=await Promise.all([api('/api/users'),api('/api/settings'),api('/api/dashboard')]); users=data.users;sharingEnabled=settings.sharingEnabled;await loadFolders();
  $('#setting-max-mb').value = settings.maxFileSize / 1024 ** 2; $('#setting-extensions').value = settings.extensions.join(', ');
  const statCards = $('#admin-stats'); statCards.replaceChildren();
  for (const [value,label] of [[formatNumber(stats.users),`مستخدم · ${formatNumber(stats.activeUsers)} مفعّل`],[formatNumber(stats.files),'ملف حالي'],[sizeLabel(stats.bytes),'مساحة الملفات والسلة'],[formatNumber(stats.trash),'ملف في السلة']]) { const card=node('div',undefined,'stat-card');card.append(node('strong',value),node('span',label));statCards.append(card); }
  const toggle=$('#toggle-sharing');toggle.setAttribute('aria-checked',String(sharingEnabled));toggle.textContent=sharingEnabled?'المشاركة مفتوحة · إغلاق':'المشاركة مغلقة · فتح';
  const body=$('#users-body');body.replaceChildren();
  for(const u of users){
    const row=node('tr');row.append(node('td',u.name),node('td',u.username),node('td',u.jobTitle||'—'));const role=node('td');
    role.append(node('span',u.role==='admin'?'مسؤول نظام':'مستخدم عادي','role-badge'),node('span',!u.active?'موقوف':u.lockedUntil>Date.now()?'مقفل مؤقتًا':'مفعّل',!u.active||u.lockedUntil>Date.now()?'status-off':'status-on'));
    const edit=node('td'),actions=node('div',undefined,'admin-user-actions');
    actions.append(action('تعديل',()=>openUser(u)),action(u.active?'إيقاف الحساب':'تفعيل الحساب',async()=>{const result=await api(`/api/users/${u.id}`,{method:'PATCH',data:{...u,active:!u.active}});if(result.relogin)return logout('تم إيقاف حسابك.');await loadAdmin();notice(u.active?'تم إيقاف الحساب وإنهاء جلساته.':'تم تفعيل الحساب.');}),action('إنهاء الجلسات',async()=>{const result=await api(`/api/users/${u.id}/sessions`,{method:'POST'});if(result.relogin)return logout('تم إنهاء جلساتك.');await loadAdmin();notice('تم إنهاء جلسات المستخدم في هذه النسخة.');}));
    if(u.lockedUntil>Date.now())actions.append(action('فك القفل',async()=>{await api(`/api/users/${u.id}/unlock`,{method:'POST'});await loadAdmin();notice('تم فك القفل المؤقت.');}));
    edit.append(actions);row.append(role,edit);body.append(row);
  }
  const list=$('#folders-list');list.replaceChildren();for(const f of folders){const item=node('div',undefined,'list-item');item.append(node('strong',f.name),action('تغيير الاسم',()=>{$('#edit-folder-id').value=f.id;$('#edit-folder-name').value=f.name;$('#folder-error').textContent='';$('#folder-dialog').showModal();},'quiet'));list.append(item);}
}
function openUser(user) {
  $('#user-form').reset();$('#edit-user-id').value=user?.id||'';$('#user-name').value=user?.name||'';$('#user-username').value=user?.username||'';$('#user-role').value=user?.role||'user';
  $('#user-job-title').value=user?.jobTitle||'';$('#user-password').required=!user;$('#user-dialog-title').textContent=user?'تعديل بيانات المستخدم':'إنشاء مستخدم';
  $('#password-hint').textContent=user?'اتركها فارغة للإبقاء عليها، أو أدخل كلمة جديدة من ٤ إلى ٢٠ خانة.':'من ٤ إلى ٢٠ خانة، دون اشتراط نوع معين.';
  $('#user-active').checked=user?.active??true;$('#user-quota-gb').value=(user?.quotaBytes??10*1024**3)/1024**3;$('#user-all-folders').checked=user?.allFolders??true;
  const options=$('#permission-options');options.replaceChildren();
  for(const [key,label] of Object.entries(permissionLabels)){const wrap=node('label',undefined,'check-label'),input=node('input');input.type='checkbox';input.dataset.permission=key;input.checked=user?.permissions?.[key]??true;wrap.append(input,document.createTextNode(label));options.append(wrap);}
  const folderOptions=$('#user-folder-options');folderOptions.replaceChildren();
  for(const f of folders){const wrap=node('label',undefined,'check-label'),input=node('input');input.type='checkbox';input.value=f.id;input.checked=user?.folderIds?.includes(f.id)??false;wrap.append(input,document.createTextNode(f.name));folderOptions.append(wrap);}
  updateAccessFields();
  $('#user-error').textContent='';$('#user-dialog').showModal();
}
$('#new-user').addEventListener('click',()=>openUser());
$('#user-form').addEventListener('submit',async event=>{
  event.preventDefault();const id=$('#edit-user-id').value;const password=$('#user-password').value;
  if((!id||password!=='')&&([...password].length<4||[...password].length>20)){$('#user-error').textContent='كلمة المرور يجب أن تكون من ٤ إلى ٢٠ خانة.';return;}
  event.submitter.disabled=true;
  try{const result=await api(id?`/api/users/${id}`:'/api/users',{method:id?'PATCH':'POST',data:{name:$('#user-name').value,jobTitle:$('#user-job-title').value,username:$('#user-username').value,password,role:$('#user-role').value,active:$('#user-active').checked,quotaBytes:Math.round(Number($('#user-quota-gb').value)*1024**3),allFolders:$('#user-all-folders').checked,folderIds:$$('#user-folder-options input:checked').map(el=>el.value),permissions:Object.fromEntries($$('#permission-options input').map(el=>[el.dataset.permission,el.checked]))}});$('#user-dialog').close();$('#user-password').value='';if(result.relogin){await logout('تم تعديل بيانات دخولك أو صلاحياتك. سجّل الدخول مجددًا.');return;}if(id===currentUser.id){currentUser=result.user;renderProfile();}await loadAdmin();notice(id?'تم تحديث المستخدم وصلاحياته.':'تم إنشاء المستخدم.');}
  catch(e){$('#user-error').textContent=e.message;}finally{event.submitter.disabled=false;}
});
$('#toggle-sharing').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await api('/api/settings',{method:'PATCH',data:{sharingEnabled:!sharingEnabled}});await loadAdmin();notice(sharingEnabled?'تم فتح المشاركة والاطلاع بين المستخدمين.':'تم إغلاق المشاركة والاطلاع بين المستخدمين.');}catch(e){showError(e);}finally{$('#toggle-sharing').disabled=false;}});
$('#folder-form').addEventListener('submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{await api('/api/folders',{method:'POST',data:{name:$('#folder-name').value}});$('#folder-name').value='';await loadAdmin();notice('تم إنشاء المجلد.');}catch(e){showError(e);}finally{event.submitter.disabled=false;}});
$('#folder-edit-form').addEventListener('submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{await api(`/api/folders/${$('#edit-folder-id').value}`,{method:'PATCH',data:{name:$('#edit-folder-name').value}});$('#folder-dialog').close();await loadAdmin();notice('تم تغيير اسم المجلد.');}catch(e){$('#folder-error').textContent=e.message;}finally{event.submitter.disabled=false;}});
function updateAccessFields(){ $('#user-access-fields').disabled=$('#user-role').value==='admin';$('#user-folder-options').hidden=$('#user-all-folders').checked; }
$('#user-role').addEventListener('change',updateAccessFields);$('#user-all-folders').addEventListener('change',updateAccessFields);
$('#settings-form').addEventListener('submit',async event=>{
  event.preventDefault();event.submitter.disabled=true;
  try{const extensions=$('#setting-extensions').value.split(/[,،\s]+/).map(e=>e.replace(/^\./,'').toLowerCase()).filter(Boolean);await api('/api/settings',{method:'PATCH',data:{maxFileSize:Math.round(Number($('#setting-max-mb').value)*1024**2),extensions}});await loadAdmin();notice('تم حفظ حدود الملفات. تطبق على عمليات الرفع التالية.');}catch(e){showError(e);}finally{event.submitter.disabled=false;}
});
async function loadTrash(){
  const data=await api('/api/trash'),body=$('#trash-body');body.replaceChildren();$('#trash-empty').hidden=data.files.length>0;
  for(const file of data.files){const row=node('tr'),controls=node('td');row.append(node('td',file.name),node('td',file.owner_name),node('td',file.folder_name),node('td',sizeLabel(file.size)),node('td',dateTime.format(new Date(file.deleted_at))));controls.append(action('استعادة',async()=>{await api(`/api/files/${file.id}/restore`,{method:'POST'});await loadTrash();notice('تمت استعادة الملف إلى مجلده الأصلي.');},'quiet'));row.append(controls);body.append(row);}
}
async function loadAudit(){auditEntries=(await api('/api/audit')).entries;renderAudit();}
function renderAudit(){
  const query=$('#audit-search').value.trim().normalize('NFKC').toLocaleLowerCase(),body=$('#audit-body');body.replaceChildren();
  const entries=auditEntries.filter(e=>!query||`${e.actor} ${e.action} ${e.target} ${e.details}`.normalize('NFKC').toLocaleLowerCase().includes(query));$('#audit-empty').hidden=entries.length>0;
  for(const e of entries){const row=node('tr');row.append(node('td',dateTime.format(new Date(e.at))),node('td',e.actor),node('td',e.action),node('td',e.target||'—'),node('td',e.details||'—'));body.append(row);}
}
$('#refresh-trash').addEventListener('click',()=>loadTrash().catch(showError));$('#refresh-audit').addEventListener('click',()=>loadAudit().catch(showError));$('#audit-search').addEventListener('input',renderAudit);
$('#change-password').addEventListener('click',()=>{closeProfileMenu();$('#password-form').reset();$('#password-error').textContent='';$('#password-dialog').showModal();});
$('#password-form').addEventListener('submit',async event=>{
  event.preventDefault();const password=$('#new-password').value;
  if(password!==$('#confirm-password').value){$('#password-error').textContent='تأكيد كلمة المرور غير مطابق.';return;}
  event.submitter.disabled=true;try{await api('/api/password',{method:'POST',data:{currentPassword:$('#current-password').value,password}});$('#password-dialog').close();showLogin('تم تغيير كلمة المرور وإنهاء الجلسات. سجّل الدخول بكلمة المرور الجديدة.');}catch(e){$('#password-error').textContent=e.message;}finally{event.submitter.disabled=false;}
});
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('#backup-export').addEventListener('click',async()=>{
  const button=$('#backup-export');button.disabled=true;$('#backup-status').textContent='جارٍ تجهيز النسخة…';
  try{downloadBlob(await window.DemoPortal.exportBackup(),`bushrakom-${new Date().toISOString().slice(0,10)}.bshbak`);$('#backup-status').textContent='تم تجهيز النسخة وتنزيلها.';}catch(e){if(e.status===401)showLogin(e.message);else $('#backup-status').textContent=e.message;}finally{button.disabled=false;}
});
$('#backup-file').addEventListener('change',()=>{pendingBackup=null;$('#backup-status').textContent='';});
$('#backup-inspect').addEventListener('click',async()=>{
  const file=$('#backup-file').files[0];if(!file){$('#backup-status').textContent='اختر ملف النسخة أولًا.';return;}$('#backup-inspect').disabled=true;$('#backup-status').textContent='جارٍ فحص النسخة…';
  try{const info=await window.DemoPortal.inspectBackup(file);pendingBackup=file;$('#restore-summary').textContent=`تحتوي النسخة على ${formatNumber(info.users)} مستخدم و${formatNumber(info.files)} ملف، بمساحة ${sizeLabel(info.bytes)}.`;$('#restore-confirm').checked=false;$('#restore-error').textContent='';$('#restore-dialog').showModal();$('#backup-status').textContent='النسخة صالحة للاستعادة.';}catch(e){if(e.status===401)showLogin(e.message);else $('#backup-status').textContent=e.message;}finally{$('#backup-inspect').disabled=false;}
});
$('#restore-form').addEventListener('submit',async event=>{   event.preventDefault();if(!pendingBackup||!$('#restore-confirm').checked)return;event.submitter.disabled=true;
  try{await window.DemoPortal.restoreBackup(pendingBackup);pendingBackup=null;$('#restore-dialog').close();showLogin('تمت استعادة النسخة. سجّل الدخول بأحد حساباتها.');}catch(e){if(e.status===401)showLogin(e.message);else $('#restore-error').textContent=e.message;}finally{event.submitter.disabled=false;} }); $$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('#user-dialog').addEventListener('close',()=>$('#user-password').value='');
$('#password-dialog').addEventListener('close',()=>$('#password-form').reset());
$('#restore-dialog').addEventListener('close',()=>{pendingBackup=null;});

// Enable credentials only after all login handlers are installed.
if (typeof window.DemoPortal?.request !== 'function') {
  $('#login-screen').dataset.introState = 'ready';
  $('.login-fields').inert = false;
  $('#startup-recovery').hidden = false;
  window.PortalStartup?.failed();
} else {
$('#login-controls').disabled = false;
$('#login-form button[type="submit"]').disabled = false;
window.PortalStartup?.ready();

// Demo accounts and permissions remain local; the upload operation also contacts the server.
(async()=>{
  try { await enterPortal(await api('/api/me')); }
  catch(error) {
    if(currentUser) showError(error);
    else showLogin(error.status === 401 ? '' : (error.message || 'تعذّر تهيئة التخزين المحلي.'));
  }
})();
}

