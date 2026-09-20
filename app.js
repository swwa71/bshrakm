const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let currentUser = null, folders = [], files = [], users = [], sharedUsers = [];
let sharingEnabled = true, lastActivity = 0, idleMs = 900000, activityPending = false, heartbeatBusy = false;
let activeUpload = null, currentView = 'files', lastHeartbeat = 0;
let loginIntroSequence = 0;
let loginIntroTimer;
let loginArtworkReady;
let maxFileSize = 1024 ** 3, auditEntries = [], pendingBackup = null;
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
  await prepareLoginArtwork();
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

async function api(path, options = {}) {
  try { return await window.DemoPortal.request(path, options); }
  catch (error) {
    if (error.status === 401 && path !== '/api/login') showLogin(error.message);
    throw error;
  }
}

function showLogin(message = '') {
  const returningToLogin = $('#login-screen').hidden;
  currentUser = null; activityPending = false; folders = []; files = []; users = []; sharedUsers = [];
  activeUpload?.abort(); activeUpload = null;
  $$('dialog[open]').forEach(d => d.close());
  $('#portal').hidden = true; $('#login-screen').hidden = false; $('#login-password').value = '';
  if (returningToLogin) $('#login-screen').dataset.introState = 'idle';
  $('#login-error').textContent = message; $('#notice').hidden = true;
  for (const id of ['files-body','users-body','shares-list','folders-list']) $('#' + id).replaceChildren();
  $('#user-password').value = ''; $('#upload-file').value = ''; pendingBackup = null;
  $('#password-form').reset(); $('#backup-file').value = ''; revealLoginControls();
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
  if (Date.now() - lastActivity >= idleMs) { void logout('انتهت الجلسة بعد ١٥ دقيقة من عدم النشاط. سجّل الدخول مجددًا.'); return; }
  lastActivity = Date.now(); activityPending = true;
  channel?.postMessage({ type: 'activity', at: lastActivity });
  if (Date.now() - lastHeartbeat > 30000) void heartbeat();
}
for (const type of ['pointerdown','pointermove','keydown','input','wheel','touchstart']) document.addEventListener(type, activity, { passive: true });
setInterval(async () => {
  if (!currentUser) return;
  if (Date.now() - lastActivity >= idleMs) void logout('انتهت الجلسة بعد ١٥ دقيقة من عدم النشاط. سجّل الدخول مجددًا.');
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
  $('#file-hint').textContent = !can('upload') ? 'صلاحية رفع الملفات غير مفعلة لحسابك.' : selected ? `حد الملف ${sizeLabel(maxFileSize)}، حسب المساحة المتاحة.` : 'حدد المجلد لتتمكن من اختيار الملف.';
}
async function loadFiles() {
  const [data, me] = await Promise.all([api('/api/files'), api('/api/me')]);
  files = data.files; sharingEnabled = data.sharingEnabled; currentUser = me.user; maxFileSize = me.maxFileSize;
  $('#upload-limit').textContent = `حد الملف: ${sizeLabel(maxFileSize)}`;
  $('#upload-file').accept = me.extensions.map(e => '.' + e).join(',');
  $('#storage-summary').textContent = `المستخدم ${sizeLabel(currentUser.usedBytes)} من ${sizeLabel(currentUser.quotaBytes)} · المتبقي ${sizeLabel(Math.max(0, currentUser.quotaBytes - currentUser.usedBytes))}`;
  $('#storage-progress').value = currentUser.quotaBytes ? Math.min(100, currentUser.usedBytes / currentUser.quotaBytes * 100) : 100;
  updateUpload(); renderFiles();
}
function renderFolderCards() {
  const list = $('#folder-cards'); list.replaceChildren();
  for (const folder of folders) {
    const button = action('', () => { $('#file-folder').value = folder.id; $('#upload-folder').value = folder.id; updateUpload(); renderFolderCards(); renderFiles(); }, 'folder-card');
    button.append(node('span', '▱'), node('strong', folder.name)); button.setAttribute('aria-pressed', String($('#file-folder').value === folder.id)); list.append(button);
  }
  if (!folders.length) list.append(node('p', 'لم يخصص المسؤول أي مجلد لحسابك بعد.', 'muted'));
}
function renderFiles() {
  const scope = $('#file-scope').value, folder = $('#file-folder').value, search = $('#file-search').value.trim().normalize('NFKC').toLocaleLowerCase();
  const visible = files.filter(f => (scope === 'all' || (scope === 'own' ? f.owner_id === currentUser.id : f.owner_id !== currentUser.id)) && (!folder || f.folder_id === folder) && (!search || `${f.name} ${f.owner_name} ${f.folder_name}`.normalize('NFKC').toLocaleLowerCase().includes(search)));
  const body = $('#files-body'); body.replaceChildren();
  $('#file-count').textContent = `${formatNumber(visible.length)} ملف`;
  $('#files-empty').hidden = visible.length > 0;
  $('#empty-title').textContent = scope === 'shared' ? 'لا توجد ملفات مشتركة للعرض' : 'لا توجد ملفات في هذا العرض';
  $('#empty-description').textContent = scope === 'shared' ? (sharingEnabled ? 'تظهر هنا ملفات المستخدمين الذين منحُوك إذن الاطلاع.' : 'أغلق مسؤول النظام المشاركة بين المستخدمين حاليًا.') : 'اختر مجلدًا وارفع أول ملف لك.';
  for (const f of visible) {
    const row = node('tr'); const nameCell = node('td'); const name = node('div', undefined, 'file-name');
    const mark = node('span','▤','file-mark'); mark.setAttribute('aria-hidden','true'); name.append(mark,node('span',f.name)); nameCell.append(name); row.append(nameCell);
    row.append(node('td',f.folder_name),node('td',f.owner_id === currentUser.id ? 'أنت' : f.owner_name),node('td',sizeLabel(f.size)),node('td',arabicDate.format(new Date(f.created_at))));
    const controls = node('td'), actions = node('div', undefined, 'row-actions');
    const download = action('تنزيل', async () => {
      const result = await api(`/api/files/${f.id}/download`);
      const url = URL.createObjectURL(result.blob);
      const link = node('a'); link.href = url; link.download = result.name;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, 'download');
    download.setAttribute('aria-label',`تنزيل ${f.name}`); if (can('download')) actions.append(download);
    if (f.owner_id === currentUser.id || currentUser.role === 'admin') {
      if (f.owner_id === currentUser.id) actions.append(action('مشاركة',()=>openFileShare(f),'share-file-button'));
      if (can('rename') || can('move')) actions.append(action('تعديل',()=>openFile(f)));
      if (can('delete')) actions.append(action('حذف',()=>deleteFile(f),'text-button delete'));
    } else actions.append(node('span','اطلاع فقط','muted'));
    controls.append(actions); row.append(controls); body.append(row);
  }
}
async function showView(view, focus = true) {
  if (!currentUser || !['files','shares','admin','trash','audit'].includes(view) || (['admin','trash','audit'].includes(view) && currentUser.role !== 'admin')) return;
  currentView = view; $('#notice').hidden = true;
  for (const name of ['files','shares','admin','trash','audit']) $('#' + name + '-view').hidden = name !== view;
  $$('.nav-item').forEach(b => { const active = b.dataset.view === view; b.classList.toggle('active',active); if (active) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  if (focus) $('#main-content').focus({ preventScroll: true });
  if (view === 'files') { await loadFolders(); await loadFiles(); }
  else if (view === 'shares') await loadShares();
  else if (view === 'admin') await loadAdmin();
  else if (view === 'trash') await loadTrash();
  else await loadAudit();
}
async function enterPortal(data) {
  cancelLoginIntro();
  currentUser = data.user; lastActivity = data.lastActive; idleMs = data.idleMs; lastHeartbeat = Date.now();
  $('#account-name').textContent = currentUser.name;
  $('#account-role').textContent = currentUser.role === 'admin' ? 'مسؤول نظام' : 'مستخدم عادي';
  $$('.admin-only').forEach(el => el.hidden = currentUser.role !== 'admin');
  $('#login-screen').hidden = true; $('#portal').hidden = false; $('#login-password').value = '';
  $('#all-files-option').hidden = currentUser.role !== 'admin';
  $('#file-scope').value = currentUser.role === 'admin' ? 'all' : 'own'; $('#file-folder').value = ''; $('#upload-folder').value = ''; $('#file-search').value = ''; $('#audit-search').value = '';
  await showView('files',false);
}
$('#login-form').addEventListener('submit',async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { const data = await api('/api/login',{method:'POST',data:{username:$('#login-username').value,password:$('#login-password').value}}); await enterPortal(data); }
  catch(e) { if (currentUser) showError(e); else $('#login-error').textContent = e.message; }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click',()=>void logout());
$$('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view).catch(showError)));
$('#upload-folder').addEventListener('change',updateUpload); $('#upload-file').addEventListener('change',updateUpload);
$('#file-scope').addEventListener('change',()=>loadFiles().catch(showError)); $('#file-folder').addEventListener('change',()=>{renderFiles();renderFolderCards();});
$('#file-search').addEventListener('input', renderFiles);
$('#clear-folder').addEventListener('click',()=>{$('#file-folder').value='';renderFolderCards();renderFiles();});
$('#refresh-files').addEventListener('click',()=>loadFiles().catch(showError));
$('#cancel-upload').addEventListener('click',()=>activeUpload?.abort());
$('#upload-form').addEventListener('submit',async event=>{
  event.preventDefault(); const file = $('#upload-file').files[0], folder = $('#upload-folder').value;
  if (!folder || !file) return notice('اختر المجلد والملف أولًا.',true);
  if (file.size > maxFileSize) return notice(`الحد الأقصى للملف الواحد ${sizeLabel(maxFileSize)}.`,true);
  const controller = new AbortController(); activeUpload = controller; updateUpload();
  $('#upload-progress-wrap').hidden = false; $('#upload-progress').removeAttribute('value'); $('#upload-status').textContent = 'جارٍ حفظ الملف في هذا المتصفح…';
  try {
    await window.DemoPortal.upload(file, folder, controller.signal);
    if (!currentUser) return;
    $('#upload-file').value = ''; notice(`تم حفظ «${file.name}» في هذا المتصفح.`); await loadFiles();
  } catch (error) {
    if (error.status === 401) showLogin(error.message);
    else if (currentUser) notice(error.message || 'تعذّر حفظ الملف في المتصفح.', error.status !== 499);
  } finally { activeUpload = null; $('#upload-progress-wrap').hidden = true; updateUpload(); }
});

function openFile(f) { $('#edit-file-id').value=f.id;$('#edit-file-name').value=f.name;$('#edit-file-name').disabled=!can('rename');fillFolders($('#edit-file-folder'),null);$('#edit-file-folder').value=f.folder_id;$('#edit-file-folder').disabled=!can('move');$('#file-error').textContent='';$('#file-dialog').showModal(); }
async function openFileShare(file) {
  $('#share-file-id').value = file.id;
  $('#file-share-error').textContent = '';
  await loadFileShare(file.id);
  if (currentUser) $('#file-share-dialog').showModal();
}
async function loadFileShare(fileId) {
  const data = await api(`/api/files/${fileId}/shares`);
  $('#file-share-name').textContent = data.file.name;
  const message = $('#file-share-state');
  message.textContent = data.sharingEnabled ? 'هذا الإذن يخص الملف المحدد. يجب أن يكون مجلده مصرحًا للمستلم.' : 'المشاركة غير متاحة لحسابك حاليًا. يمكنك إلغاء الأذونات المحفوظة.';
  message.className = data.sharingEnabled ? 'notice' : 'notice warning';
  const select = $('#file-share-user'); select.replaceChildren();
  const placeholder = node('option', 'اختر مستخدمًا'); placeholder.value = ''; select.append(placeholder);
  for (const u of data.users.filter(u => u.eligible && !data.viewerIds.includes(u.id) && !data.allFilesViewerIds.includes(u.id))) {
    const option = node('option', `${u.name} (${u.username})`); option.value = u.id; select.append(option);
  }
  select.disabled = !data.sharingEnabled;
  $('#file-share-submit').disabled = !data.sharingEnabled || select.options.length === 1;
  const list = $('#file-share-list'); list.replaceChildren();
  const viewerIds = [...new Set([...data.viewerIds, ...data.allFilesViewerIds])];
  $('#file-share-empty').hidden = viewerIds.length > 0;
  for (const viewerId of viewerIds) {
    const u = data.users.find(u => u.id === viewerId); if (!u) continue;
    const item = node('div', undefined, 'list-item'); const label = node('div');
    label.append(node('strong', u.name), node('small', u.username));
    const inherited = data.allFilesViewerIds.includes(viewerId);
    if (inherited) label.append(node('small', 'لديه إذن لجميع ملفاتك من صفحة أذونات الاطلاع.'));
    item.append(label);
    if (data.viewerIds.includes(viewerId)) {
      item.append(action('إلغاء مشاركة الملف', async () => {
        try {
          await api(`/api/files/${fileId}/shares/${viewerId}`, { method: 'DELETE' });
          await loadFileShare(fileId);
          $('#file-share-error').textContent = '';
          $('#file-share-state').textContent = inherited ? 'أُلغي إذن هذا الملف؛ ما زال لدى المستخدم إذن لجميع ملفاتك. لإيقافه، استخدم صفحة أذونات الاطلاع.' : 'تم إلغاء مشاركة هذا الملف مع المستخدم.';
        } catch (error) { $('#file-share-error').textContent = error.message; }
      }, 'quiet'));
    } else if (inherited) item.append(node('span', 'إذن لجميع الملفات', 'role-badge'));
    list.append(item);
  }
}
$('#file-share-form').addEventListener('submit', async event => {
  event.preventDefault(); const fileId = $('#share-file-id').value;
  const viewerId = $('#file-share-user').value; if (!viewerId) return;
  $('#file-share-submit').disabled = true; $('#file-share-error').textContent = '';
  try {
    await api(`/api/files/${fileId}/shares`, { method: 'POST', data: { viewerId } });
    await loadFileShare(fileId); $('#file-share-state').textContent = 'تمت مشاركة الملف. يظهر للمستخدم في «ملفات مشتركة معي».';
  } catch (error) {
    if (currentUser) { await loadFileShare(fileId).catch(() => {}); $('#file-share-error').textContent = error.message; }
  }
});
async function deleteFile(file) {
  const dialog=$('#confirm-dialog'); $('#confirm-message').textContent=`هل تريد حذف «${file.name}»؟`; dialog.returnValue=''; dialog.showModal();
  const result = await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));
  if(result!=='confirm')return;
  await api(`/api/files/${file.id}`,{method:'DELETE'}); await loadFiles(); notice('نُقل الملف إلى سلة المحذوفات. يستطيع مسؤول النظام استعادته.');
}
$('#file-edit-form').addEventListener('submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{await api(`/api/files/${$('#edit-file-id').value}`,{method:'PATCH',data:{name:$('#edit-file-name').value,folderId:$('#edit-file-folder').value}});$('#file-dialog').close();await loadFiles();notice('تم حفظ تعديلات الملف.');}catch(e){$('#file-error').textContent=e.message;}finally{event.submitter.disabled=false;}});

async function loadShares() {
  const data=await api('/api/shares'); sharingEnabled=data.sharingEnabled;sharedUsers=data.users;
  $('#sharing-state').textContent=sharingEnabled?'المشاركة متاحة ضمن المجلدات المسموحة للمستلم. يمكنك منح الأذونات أو إلغاؤها.':'إنشاء المشاركة غير متاح لحسابك حاليًا. يمكنك إلغاء الأذونات المحفوظة.';
  $('#sharing-state').className=sharingEnabled?'notice':'notice warning';
  const select=$('#share-user');select.replaceChildren();const placeholder=node('option','اختر مستخدمًا');placeholder.value='';select.append(placeholder);
  for(const u of data.users.filter(u=>!data.viewerIds.includes(u.id))){const o=node('option',`${u.name} (${u.username})`);o.value=u.id;select.append(o);}
  select.disabled=!sharingEnabled;$('#share-button').disabled=!sharingEnabled||select.options.length===1;
  const list=$('#shares-list');list.replaceChildren();$('#shares-empty').hidden=data.viewerIds.length>0;
  for(const id of data.viewerIds){const u=data.users.find(u=>u.id===id);if(!u)continue;const item=node('div',undefined,'list-item'),label=node('div');label.append(node('strong',u.name),node('small',u.username));item.append(label,action('إلغاء الإذن',async()=>{await api(`/api/shares/${id}`,{method:'DELETE'});await loadShares();notice('تم إلغاء إذن الاطلاع.');},'quiet'));list.append(item);}
}
$('#share-form').addEventListener('submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{await api('/api/shares',{method:'POST',data:{viewerId:$('#share-user').value}});await loadShares();notice('تم منح إذن الاطلاع.');}catch(e){showError(e);await loadShares().catch(()=>{});}finally{if(sharingEnabled&&$('#share-user').options.length>1)event.submitter.disabled=false;}});

async function loadAdmin() {
  const [data,settings,stats]=await Promise.all([api('/api/users'),api('/api/settings'),api('/api/dashboard')]); users=data.users;sharingEnabled=settings.sharingEnabled;await loadFolders();
  $('#setting-max-mb').value = settings.maxFileSize / 1024 ** 2; $('#setting-extensions').value = settings.extensions.join(', ');
  const statCards = $('#admin-stats'); statCards.replaceChildren();
  for (const [value,label] of [[formatNumber(stats.users),`مستخدم · ${formatNumber(stats.activeUsers)} مفعّل`],[formatNumber(stats.files),'ملف حالي'],[sizeLabel(stats.bytes),'مساحة الملفات والسلة'],[formatNumber(stats.trash),'ملف في السلة']]) { const card=node('div',undefined,'stat-card');card.append(node('strong',value),node('span',label));statCards.append(card); }
  const toggle=$('#toggle-sharing');toggle.setAttribute('aria-checked',String(sharingEnabled));toggle.textContent=sharingEnabled?'المشاركة مفتوحة · إغلاق':'المشاركة مغلقة · فتح';
  const body=$('#users-body');body.replaceChildren();
  for(const u of users){
    const row=node('tr');row.append(node('td',u.name),node('td',u.username));const role=node('td');
    role.append(node('span',u.role==='admin'?'مسؤول نظام':'مستخدم عادي','role-badge'),node('span',!u.active?'موقوف':u.lockedUntil>Date.now()?'مقفل مؤقتًا':'مفعّل',!u.active||u.lockedUntil>Date.now()?'status-off':'status-on'));
    const edit=node('td'),actions=node('div',undefined,'admin-user-actions');
    actions.append(action('تعديل',()=>openUser(u)),action(u.active?'إيقاف الحساب':'تفعيل الحساب',async()=>{const result=await api(`/api/users/${u.id}`,{method:'PATCH',data:{...u,active:!u.active}});if(result.relogin)return logout('تم إيقاف حسابك.');await loadAdmin();notice(u.active?'تم إيقاف الحساب وإنهاء جلساته.':'تم تفعيل الحساب.');}),action('إنهاء الجلسات',async()=>{const result=await api(`/api/users/${u.id}/sessions`,{method:'POST'});if(result.relogin)return logout('تم إنهاء جلساتك.');await loadAdmin();notice('تم إنهاء جلسات المستخدم في هذه النسخة.');}));
    if(u.lockedUntil>Date.now())actions.append(action('فك القفل',async()=>{await api(`/api/users/${u.id}/unlock`,{method:'POST'});await loadAdmin();notice('تم فك القفل المؤقت.');}));
    edit.append(actions);row.append(role,node('td',`${sizeLabel(u.usedBytes)} / ${sizeLabel(u.quotaBytes)}`),edit);body.append(row);
  }
  const list=$('#folders-list');list.replaceChildren();for(const f of folders){const item=node('div',undefined,'list-item');item.append(node('strong',f.name),action('تغيير الاسم',()=>{$('#edit-folder-id').value=f.id;$('#edit-folder-name').value=f.name;$('#folder-error').textContent='';$('#folder-dialog').showModal();},'quiet'));list.append(item);}
}
function openUser(user) {
  $('#user-form').reset();$('#edit-user-id').value=user?.id||'';$('#user-name').value=user?.name||'';$('#user-username').value=user?.username||'';$('#user-role').value=user?.role||'user';
  $('#user-password').required=!user;$('#user-dialog-title').textContent=user?'تعديل بيانات المستخدم':'إنشاء مستخدم';
  $('#password-hint').textContent=user?'اتركها فارغة للإبقاء عليها، أو أدخل كلمة جديدة من ٤ إلى ٢٠ خانة.':'من ٤ إلى ٢٠ خانة، دون اشتراط نوع معين.';
  $('#user-active').checked=user?.active??true;$('#user-quota-gb').value=(user?.quotaBytes??2*1024**3)/1024**3;$('#user-all-folders').checked=user?.allFolders??true;
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
  try{const result=await api(id?`/api/users/${id}`:'/api/users',{method:id?'PATCH':'POST',data:{name:$('#user-name').value,username:$('#user-username').value,password,role:$('#user-role').value,active:$('#user-active').checked,quotaBytes:Math.round(Number($('#user-quota-gb').value)*1024**3),allFolders:$('#user-all-folders').checked,folderIds:$$('#user-folder-options input:checked').map(el=>el.value),permissions:Object.fromEntries($$('#permission-options input').map(el=>[el.dataset.permission,el.checked]))}});$('#user-dialog').close();$('#user-password').value='';if(result.relogin){await logout('تم تعديل بيانات دخولك أو صلاحياتك. سجّل الدخول مجددًا.');return;}if(id===currentUser.id){currentUser=result.user;$('#account-name').textContent=currentUser.name;}await loadAdmin();notice(id?'تم تحديث المستخدم وصلاحياته.':'تم إنشاء المستخدم.');}
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
$('#change-password').addEventListener('click',()=>{$('#password-form').reset();$('#password-error').textContent='';$('#password-dialog').showModal();});
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
$('#restore-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!pendingBackup||!$('#restore-confirm').checked)return;event.submitter.disabled=true;
  try{await window.DemoPortal.restoreBackup(pendingBackup);pendingBackup=null;$('#restore-dialog').close();showLogin('تمت استعادة النسخة. سجّل الدخول بأحد حساباتها.');}catch(e){if(e.status===401)showLogin(e.message);else $('#restore-error').textContent=e.message;}finally{event.submitter.disabled=false;}
});
$$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('#user-dialog').addEventListener('close',()=>$('#user-password').value='');
$('#password-dialog').addEventListener('close',()=>$('#password-form').reset());
$('#restore-dialog').addEventListener('close',()=>{pendingBackup=null;});

// Offline demonstration: all data is stored in this browser, with no server calls.
(async()=>{
  try { await enterPortal(await api('/api/me')); }
  catch(error) {
    if(currentUser) showError(error);
    else showLogin(error.status === 401 ? '' : (error.message || 'تعذّر تهيئة التخزين المحلي.'));
  }
})();
