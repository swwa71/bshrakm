/* Demo accounts stay local; uploads also go to the configured server.
   Browser-side roles are not a server security boundary. */
(() => {
  'use strict';
  const DB_NAME = 'bushrakom-html-demo-v1', SESSION_KEY = 'bushrakom-html-session-v1';
  const IDLE_MS = 900000, MAX_FILE_SIZE = 5 * 1024 ** 3, LOCK_MS = 900000;
  const UPLOAD_URL = 'http://192.168.91.133:3000/upload';
  const STORAGE_INFO_URL = 'http://192.168.91.133:3000/storage-info';
  const PERMISSIONS = ['upload', 'download', 'rename', 'move', 'delete', 'share'];
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const id = () => crypto.randomUUID();
  const keyOf = value => value.trim().normalize('NFKC').toLowerCase();
  const defaults = () => Object.fromEntries(PERMISSIONS.map(p => [p, true]));
  let database, startup, queue = Promise.resolve();

  function migrate(state) {
    state.fileShares ||= []; state.folderShares ||= []; state.audit ||= [];
    // Convert old whole-account grants into grants for existing folders only.
    for (const grant of state.shares || []) for (const folder of state.folders) {
      if (!state.folderShares.some(s => s.ownerId === grant.ownerId && s.viewerId === grant.viewerId && s.folderId === folder.id)) state.folderShares.push({ ...grant, folderId: folder.id });
    }
    state.shares = [];
    // Upgrade the previous 1 GiB ceiling once; retain smaller administrator limits.
    if ((state.version || 0) < 4 && state.settings?.maxFileSize === 1024 ** 3) state.settings.maxFileSize = MAX_FILE_SIZE;
    state.settings ||= { maxFileSize: MAX_FILE_SIZE, extensions: [] };
    for (const u of state.users) {
      u.active ??= true; u.permissions = { ...defaults(), ...u.permissions };
      u.allFolders ??= true; u.folderIds ||= []; u.quotaBytes ??= 2 * MAX_FILE_SIZE;
      u.failedAttempts ??= 0; u.lockedUntil ??= 0;
      u.jobTitle ??= u.role === 'admin' ? 'مسؤول النظام' : ''; u.email ??= ''; u.phone ??= '';
    }
    for (const f of state.files) { f.deleted_at ??= null; f.updated_at ??= f.created_at; }
    state.version = 4; return state;
  }
  const usedBytes = (state, ownerId) => state.files.filter(f => f.owner_id === ownerId).reduce((n, f) => n + f.size, 0);
  const userView = (u, state) => ({ id: u.id, username: u.username, name: u.name, role: u.role, jobTitle: u.jobTitle, email: u.email, phone: u.phone,
    active: u.active, permissions: { ...u.permissions }, allFolders: u.allFolders, folderIds: [...u.folderIds],
    quotaBytes: u.quotaBytes, usedBytes: state ? usedBytes(state, u.id) : 0, lockedUntil: u.lockedUntil });
  const publicUser = u => ({ id: u.id, username: u.username, name: u.name, jobTitle: u.jobTitle });
  const allowed = (user, permission) => user.role === 'admin' || user.permissions[permission];
  const folderAllowed = (user, folderId) => user.role === 'admin' || user.allFolders || user.folderIds.includes(folderId);
  function requirePermission(user, permission) { if (!allowed(user, permission)) throw fail(403, 'هذه العملية غير مسموحة لحسابك.'); }
  function audit(state, user, action, target = '', details = '') {
    state.audit.push({ id: id(), at: Date.now(), actorId: user?.id || null, actor: user?.name || 'حساب غير معروف', action, target, details });
  }
  function decorate(state, f) { return { ...f, owner_name: state.users.find(u => u.id === f.owner_id)?.name || '', folder_name: state.folders.find(d => d.id === f.folder_id)?.name || '' }; }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('state'); request.result.createObjectStore('files'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(fail(503, 'تعذّر فتح التخزين المحلي. اسمح للمتصفح بتخزين بيانات الموقع.'));
      request.onblocked = () => reject(fail(503, 'أغلق النوافذ الأخرى للتجربة ثم أعد فتحها.'));
    });
  }
  function read(store, key) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  function save(state, operation = {}, signal) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['state', 'files'], 'readwrite');
      const abort = () => { try { tx.abort(); } catch {} };
      signal?.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(); };
      tx.onabort = () => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? fail(499, 'تم إلغاء الحفظ.') : fail(507, 'تعذّر الحفظ. قد لا تكفي مساحة المتصفح. لم تُحفظ التغييرات.')); };
      tx.onerror = () => {};
      if (signal?.aborted) { tx.abort(); return; }
      tx.objectStore('state').put(state, 'portal');
      const blobs = tx.objectStore('files');
      if (operation.replace) { blobs.clear(); for (const f of operation.replace) blobs.put(f.blob, f.id); }
      if (operation.blob !== undefined) blobs.put(operation.blob, operation.id);
    });
  }
  function passwordLength(value) { if (typeof value !== 'string' || [...value].length < 4 || [...value].length > 20) throw fail(400, 'كلمة المرور يجب أن تكون من ٤ إلى ٢٠ خانة بأي نوع من الأحرف.'); }
  async function passwordHash(value, salt) {
    passwordLength(value);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
    const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(salt) }, key, 256);
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function init() {
    if (!crypto?.subtle || !crypto?.randomUUID || !window.indexedDB) throw fail(503, 'استخدم متصفحًا حديثًا ورابط HTTPS، أو افتح ملف التجربة في Chrome أو Edge.');
    database = await openDatabase(); const existing = await read('state', 'portal');
    if (existing) { if (existing.version !== 4) await save(migrate(existing)); return; }
    const users = [];
    for (const [username, name, role, password] of [['admin', 'مسؤول النظام', 'admin', '1234']]) {
      const salt = id(); users.push({ id: id(), username, name, role, revision: 1, salt, passwordHash: await passwordHash(password, salt) });
    }
    await save(migrate({ users, folders: ['المستندات العامة', 'التقارير', 'النماذج'].map(name => ({ id: id(), name })), files: [], shares: [], sharingEnabled: true }));
  }
  function lock(operation) {
    const execute = async () => { if (!startup) startup = init(); await startup; return operation(); };
    if (navigator.locks) return navigator.locks.request(DB_NAME, execute);
    const pending = queue.then(execute, execute); queue = pending.catch(() => {}); return pending;
  }
  function session(state) {
    let data; try { data = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    const user = data && state.users.find(u => u.id === data.userId && u.revision === data.revision && u.active);
    if (!user || !Number.isFinite(data.lastActive) || Date.now() - data.lastActive >= IDLE_MS) { sessionStorage.removeItem(SESSION_KEY); throw fail(401, 'انتهت الجلسة أو أوقفها المسؤول. سجّل الدخول مجددًا.'); }
    return { user, data };
  }
  function requireAdmin(state) { const s = session(state); if (s.user.role !== 'admin') throw fail(403, 'هذه العملية لمسؤول النظام.'); return s; }
  function canRead(state, user, file) {
    if (file.deleted_at !== null || !folderAllowed(user, file.folder_id)) return false;
    return user.role === 'admin' || file.owner_id === user.id || (state.sharingEnabled && (
      state.folderShares.some(s => s.ownerId === file.owner_id && s.folderId === file.folder_id && s.viewerId === user.id) || state.fileShares.some(s => s.fileId === file.id && s.viewerId === user.id)));
  }
  function validateUser(input, previous, state) {
    const username = typeof input.username === 'string' ? input.username.trim().normalize('NFC') : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const jobTitle = input.jobTitle ?? previous?.jobTitle ?? '', email = input.email ?? previous?.email ?? '', phone = input.phone ?? previous?.phone ?? '';
    if (typeof jobTitle !== 'string' || [...jobTitle].length > 100 || /[\p{C}]/u.test(jobTitle)) throw fail(400, 'المسمى الوظيفي يجب ألا يتجاوز ١٠٠ خانة.');
    validateContact(email, phone);
    if (!username || [...username].length > 64 || /[\p{C}\s]/u.test(username)) throw fail(400, 'أدخل اسم مستخدم حتى ٦٤ خانة دون مسافات.');
    if (!name || [...name].length > 100 || !['admin', 'user'].includes(input.role)) throw fail(400, 'تحقق من الاسم والصلاحية.');
    const active = input.active ?? previous?.active ?? true, allFolders = input.allFolders ?? previous?.allFolders ?? true;
    const folderIds = input.folderIds ?? previous?.folderIds ?? [], quotaBytes = input.quotaBytes ?? previous?.quotaBytes ?? 2 * MAX_FILE_SIZE;
    const permissions = input.permissions ?? previous?.permissions ?? defaults();
    if (typeof active !== 'boolean' || typeof allFolders !== 'boolean' || !Array.isArray(folderIds) || folderIds.some(f => !state.folders.some(d => d.id === f))) throw fail(400, 'إعدادات المجلدات أو حالة الحساب غير صحيحة.');
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0 || quotaBytes > 1024 * 1024 ** 3) throw fail(400, 'حدد مساحة من صفر إلى ١٠٢٤ جيجابايت.');
    if (!permissions || PERMISSIONS.some(p => typeof permissions[p] !== 'boolean')) throw fail(400, 'الصلاحيات غير صحيحة.');
    return { username, name, jobTitle: jobTitle.trim(), email: email.trim(), phone: phone.trim(), role: input.role, active, allFolders, folderIds: [...new Set(folderIds)], quotaBytes, permissions: Object.fromEntries(PERMISSIONS.map(p => [p, permissions[p]])) };
  }
  function validateContact(email, phone) {
    if (typeof email !== 'string' || email.length > 254 || (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) throw fail(400, 'البريد الإلكتروني غير صحيح.');
    if (typeof phone !== 'string' || phone.length > 30 || (phone.trim() && !/^[+()\d\s-]+$/.test(phone.trim()))) throw fail(400, 'رقم الجوال غير صحيح.');
  }
  function validateFilename(name) { if (typeof name !== 'string' || !name.trim() || [...name].length > 240 || /[\p{C}\/\\]/u.test(name) || ['.', '..'].includes(name)) throw fail(400, 'اسم الملف غير صالح أو طويل جدًا.'); }
  function validateExtension(state, name) {
    const ext = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
    if (state.settings.extensions.length && !state.settings.extensions.includes(ext)) throw fail(415, 'امتداد الملف غير مسموح حسب إعدادات النظام.');
  }
  function validateSettings(data, current) {
    const maxFileSize = data.maxFileSize ?? current.maxFileSize, extensions = data.extensions ?? current.extensions;
    if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 1 || maxFileSize > MAX_FILE_SIZE) throw fail(400, 'حجم الملف يجب أن يكون أكبر من صفر ولا يتجاوز ٥ جيجابايت.');
    if (!Array.isArray(extensions) || extensions.length > 100 || extensions.some(e => typeof e !== 'string' || !/^[a-z0-9]{1,15}$/.test(e))) throw fail(400, 'اكتب الامتدادات مثل pdf و docx دون نقطة.');
    return { maxFileSize, extensions: [...new Set(extensions)] };
  }
  async function request(path, { method = 'GET', data = {} } = {}) {
    return lock(async () => {
      const state = await read('state', 'portal');
      if (path === '/api/logout' && method === 'POST') {
        try { const { user } = session(state); audit(state, user, 'تسجيل خروج'); await save(state); } catch (e) { if (e.status !== 401) throw e; }
        sessionStorage.removeItem(SESSION_KEY); return { ok: true };
      }
      if (path === '/api/login' && method === 'POST') {
        const user = typeof data.username === 'string' && state.users.find(u => keyOf(u.username) === keyOf(data.username));
        if (user?.lockedUntil > Date.now()) throw fail(423, 'الحساب مقفل مؤقتًا. حاول بعد ١٥ دقيقة من آخر قفل، أو راجع المسؤول.');
        if (user && user.lockedUntil) { user.failedAttempts = 0; user.lockedUntil = 0; }
        let valid = false; if (user) { try { valid = await passwordHash(data.password, user.salt) === user.passwordHash; } catch {} }
        if (!valid) {
          if (user) { user.failedAttempts++; if (user.failedAttempts >= 5) user.lockedUntil = Date.now() + LOCK_MS; }
          audit(state, user, user?.lockedUntil ? 'قفل مؤقت' : 'دخول فاشل'); await save(state);
          throw fail(user?.lockedUntil ? 423 : 401, user?.lockedUntil ? 'تم قفل الحساب ١٥ دقيقة بعد ٥ محاولات فاشلة.' : 'اسم المستخدم أو كلمة المرور غير صحيحة.');
        }
        if (!user.active) throw fail(403, 'الحساب موقوف. راجع مسؤول النظام.');
        user.failedAttempts = 0; user.lockedUntil = 0;
        const lastActive = Date.now(); audit(state, user, 'تسجيل دخول'); await save(state);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id, revision: user.revision, lastActive }));
        return { user: userView(user, state), lastActive, idleMs: IDLE_MS };
      }
      const { user, data: currentSession } = session(state);
      if (path === '/api/me' && method === 'GET') return { user: userView(user, state), lastActive: currentSession.lastActive, idleMs: IDLE_MS, sharingEnabled: state.sharingEnabled, ...state.settings };
      if (path === '/api/profile' && method === 'PATCH') {
        const editable = user.role === 'admin' ? ['username', 'email', 'phone'] : ['email', 'phone'];
        if (Object.keys(data).some(k => !editable.includes(k))) throw fail(403, 'يمكن للمستخدم تعديل البريد والجوال فقط. بيانات الهوية يحددها مسؤول النظام.');
        const updated = validateUser({ ...user, ...data }, user, state);
        if (state.users.some(u => u.id !== user.id && keyOf(u.username) === keyOf(updated.username))) throw fail(409, 'اسم المستخدم مستخدم بالفعل.');
        const changed = user.username !== updated.username;
        user.username = updated.username; user.email = updated.email; user.phone = updated.phone;
        if (changed) user.revision++;
        audit(state, user, 'تعديل الملف الشخصي'); await save(state);
        if (changed) { currentSession.revision = user.revision; sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession)); }
        return { user: userView(user, state) };
      }
      if (path === '/api/activity' && method === 'POST') { currentSession.lastActive = Date.now(); sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession)); return { lastActive: currentSession.lastActive }; }
      if (path === '/api/password' && method === 'POST') {
        if (await passwordHash(data.currentPassword, user.salt) !== user.passwordHash) throw fail(400, 'كلمة المرور الحالية غير صحيحة.');
        const salt = id(), hash = await passwordHash(data.password, salt); user.salt = salt; user.passwordHash = hash; user.revision++;
        audit(state, user, 'تغيير كلمة المرور'); await save(state); sessionStorage.removeItem(SESSION_KEY); return { ok: true, relogin: true };
      }
      if (path === '/api/folders' && method === 'GET') return { folders: state.folders.filter(f => folderAllowed(user, f.id)) };
      if ((path === '/api/folders' && method === 'POST') || (/^\/api\/folders\/[^/]+$/.test(path) && method === 'PATCH')) {
        requireAdmin(state); const name = typeof data.name === 'string' ? data.name.trim() : '', folderId = path.split('/').at(-1);
        if (!name || [...name].length > 80) throw fail(400, 'اسم المجلد مطلوب، حتى ٨٠ خانة.');
        if (state.folders.some(f => f.name === name && f.id !== folderId)) throw fail(409, 'اسم المجلد موجود بالفعل.');
        let folder;
        if (method === 'POST') { folder = { id: id(), name }; state.folders.push(folder); }
        else { folder = state.folders.find(f => f.id === folderId); if (!folder) throw fail(404, 'المجلد غير موجود.'); folder.name = name; }
        audit(state, user, method === 'POST' ? 'إنشاء مجلد' : 'تعديل مجلد', name); await save(state); return folder;
      }
      if (path === '/api/users' && method === 'GET') { requireAdmin(state); return { users: state.users.map(u => userView(u, state)) }; }
      const userAction = /^\/api\/users\/([^/]+)\/(sessions|unlock)$/.exec(path);
      if (userAction && method === 'POST') {
        requireAdmin(state); const target = state.users.find(u => u.id === userAction[1]); if (!target) throw fail(404, 'المستخدم غير موجود.');
        if (userAction[2] === 'sessions') target.revision++; else { target.lockedUntil = 0; target.failedAttempts = 0; }
        audit(state, user, userAction[2] === 'sessions' ? 'إنهاء الجلسات' : 'فك قفل الحساب', target.name); await save(state);
        return { ok: true, relogin: target.id === user.id && userAction[2] === 'sessions' };
      }
      if ((path === '/api/users' && method === 'POST') || (/^\/api\/users\/[^/]+$/.test(path) && method === 'PATCH')) {
        requireAdmin(state); const userId = method === 'POST' ? id() : path.split('/').at(-1);
        let updated = state.users.find(u => u.id === userId);
        if (method === 'PATCH' && !updated) throw fail(404, 'المستخدم غير موجود.');
        const c = validateUser(data, updated, state);
        if (method === 'POST' && !c.jobTitle) throw fail(400, 'أدخل المسمى الوظيفي للمستخدم.');
        if (state.users.some(u => u.id !== userId && keyOf(u.username) === keyOf(c.username))) throw fail(409, 'اسم المستخدم مستخدم بالفعل.');
        if (updated?.active && updated.role === 'admin' && (!c.active || c.role !== 'admin') && state.users.filter(u => u.active && u.role === 'admin').length === 1) throw fail(409, 'يجب أن يبقى مسؤول نظام مفعّل واحد على الأقل.');
        let changed = false;
        if (!updated) { const salt = id(); updated = { id: userId, ...c, salt, revision: 1, failedAttempts: 0, lockedUntil: 0, passwordHash: await passwordHash(data.password, salt) }; state.users.push(updated); }
        else {
          changed = !!data.password || ['role', 'username', 'active', 'allFolders', 'folderIds', 'permissions'].some(k => JSON.stringify(updated[k]) !== JSON.stringify(c[k]));
          if (data.password) { const salt = id(), hash = await passwordHash(data.password, salt); updated.salt = salt; updated.passwordHash = hash; updated.failedAttempts = 0; updated.lockedUntil = 0; }
          if (changed) updated.revision++; Object.assign(updated, c);
        }
        if (Date.now() - currentSession.lastActive >= IDLE_MS) throw fail(401, 'انتهت الجلسة. سجّل الدخول مجددًا.');
        audit(state, user, method === 'POST' ? 'إنشاء حساب' : 'تعديل حساب وصلاحيات', updated.name); await save(state);
        return { user: userView(updated, state), relogin: changed && userId === user.id };
      }
      if (path === '/api/settings' && method === 'GET') { requireAdmin(state); return { ...state.settings, sharingEnabled: state.sharingEnabled }; }
      if (path === '/api/settings' && method === 'PATCH') {
        requireAdmin(state);
        if (data.sharingEnabled !== undefined && typeof data.sharingEnabled !== 'boolean') throw fail(400, 'قيمة المشاركة غير صحيحة.');
        state.settings = validateSettings(data, state.settings); state.sharingEnabled = data.sharingEnabled ?? state.sharingEnabled;
        audit(state, user, 'تعديل إعدادات النظام'); await save(state); return { ...state.settings, sharingEnabled: state.sharingEnabled };
      }
      if (path === '/api/dashboard' && method === 'GET') {
        requireAdmin(state); return { users: state.users.length, activeUsers: state.users.filter(u => u.active).length,
          files: state.files.filter(f => f.deleted_at === null).length, trash: state.files.filter(f => f.deleted_at !== null).length,
          bytes: state.files.reduce((n, f) => n + f.size, 0), folders: state.folders.length };
      }
      if (path === '/api/audit' && method === 'GET') { requireAdmin(state); return { entries: [...state.audit].reverse() }; }
      if (path === '/api/trash' && method === 'GET') { requireAdmin(state); return { files: state.files.filter(f => f.deleted_at !== null).map(f => decorate(state, f)).sort((a, b) => b.deleted_at - a.deleted_at) }; }
      if (path === '/api/shares' && method === 'GET') {
        const recipients = state.users.filter(u => u.id !== user.id && u.active);
        const eligible = folderId => recipients.filter(u => folderAllowed(u, folderId)).map(u => u.id);
        const ownFiles = state.files.filter(f => f.owner_id === user.id && canRead(state, user, f));
        const grants = [
          ...state.folderShares.filter(s => s.ownerId === user.id).map(s => ({ kind: 'folder', targetId: s.folderId, viewerId: s.viewerId, name: state.folders.find(f => f.id === s.folderId)?.name || 'مجلد' })),
          ...state.fileShares.filter(s => state.files.some(f => f.id === s.fileId && f.owner_id === user.id)).map(s => ({ kind: 'file', targetId: s.fileId, viewerId: s.viewerId, name: state.files.find(f => f.id === s.fileId)?.name || 'ملف' }))
        ];
        return { sharingEnabled: state.sharingEnabled && allowed(user, 'share'), users: state.users.filter(u => u.id !== user.id).map(publicUser),
          folders: state.folders.filter(f => folderAllowed(user, f.id)).map(f => ({ ...f, viewerIds: eligible(f.id) })),
          files: ownFiles.map(f => ({ id: f.id, name: f.name, folder_name: state.folders.find(d => d.id === f.folder_id)?.name || '', viewerIds: eligible(f.folder_id) })), grants };
      }
      if (path === '/api/shares' && method === 'POST') {
        requirePermission(user, 'share'); if (!state.sharingEnabled) throw fail(403, 'المشاركة مغلقة حاليًا بقرار مسؤول النظام.');
        if (!['file', 'folder'].includes(data.kind)) throw fail(400, 'حدد مشاركة ملف أو مجلد فقط.');
        const target = data.kind === 'folder' ? state.folders.find(f => f.id === data.targetId && folderAllowed(user, f.id)) : state.files.find(f => f.id === data.targetId && f.owner_id === user.id && canRead(state, user, f));
        if (!target) throw fail(403, 'العنصر غير موجود أو ليس لديك إذن مشاركته.');
        const folderId = data.kind === 'folder' ? target.id : target.folder_id;
        const viewer = state.users.find(u => u.id === data.viewerId && u.id !== user.id && u.active && folderAllowed(u, folderId));
        if (!viewer) throw fail(400, 'اختر مستخدمًا مفعّلًا لديه صلاحية المجلد.');
        if (data.kind === 'folder') {
          if (!state.folderShares.some(s => s.ownerId === user.id && s.folderId === target.id && s.viewerId === viewer.id)) state.folderShares.push({ ownerId: user.id, folderId: target.id, viewerId: viewer.id });
        } else if (!state.fileShares.some(s => s.fileId === target.id && s.viewerId === viewer.id)) state.fileShares.push({ fileId: target.id, viewerId: viewer.id });
        audit(state, user, data.kind === 'folder' ? 'مشاركة مجلد' : 'مشاركة ملف', target.name, viewer.name); await save(state); return { ok: true };
      }
      const revokeShare = /^\/api\/shares\/(file|folder)\/([^/]+)\/([^/]+)$/.exec(path);
      if (revokeShare && method === 'DELETE') {
        const [, kind, targetId, viewerId] = revokeShare;
        if (kind === 'folder') state.folderShares = state.folderShares.filter(s => !(s.ownerId === user.id && s.folderId === targetId && s.viewerId === viewerId));
        else {
          if (!state.files.some(f => f.id === targetId && f.owner_id === user.id)) throw fail(403, 'لا يمكنك إلغاء مشاركة ملف مستخدم آخر.');
          state.fileShares = state.fileShares.filter(s => !(s.fileId === targetId && s.viewerId === viewerId));
        }
        audit(state, user, kind === 'folder' ? 'إلغاء مشاركة مجلد' : 'إلغاء مشاركة ملف'); await save(state); return { ok: true };
      }
      if (path === '/api/files' && method === 'GET') return { sharingEnabled: state.sharingEnabled, files: state.files.filter(f => canRead(state, user, f)).map(f => decorate(state, f)).sort((a, b) => b.created_at - a.created_at) };
      const fileShareRoute = /^\/api\/files\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(path);
      if (fileShareRoute) {
        const [, fileId, viewerId] = fileShareRoute, file = state.files.find(f => f.id === fileId);
        if (!file || file.owner_id !== user.id || !canRead(state, user, file)) throw fail(403, 'صاحب الملف المصرح له وحده يستطيع إدارة مشاركته.');
        const candidates = state.users.filter(u => u.id !== user.id && folderAllowed(u, file.folder_id));
        if (method === 'GET' && !viewerId) return { file: { id: file.id, name: file.name }, sharingEnabled: state.sharingEnabled && allowed(user, 'share'),
          users: state.users.filter(u => u.id !== user.id).map(u => ({ ...publicUser(u), eligible: u.active && folderAllowed(u, file.folder_id) })),
          viewerIds: state.fileShares.filter(s => s.fileId === fileId).map(s => s.viewerId), folderViewerIds: state.folderShares.filter(s => s.ownerId === user.id && s.folderId === file.folder_id).map(s => s.viewerId) };
        if (method === 'POST' && !viewerId) {
          requirePermission(user, 'share'); if (!state.sharingEnabled) throw fail(403, 'المشاركة مغلقة حاليًا بقرار مسؤول النظام.');
          if (!candidates.some(u => u.id === data.viewerId && u.active)) throw fail(400, 'اختر مستخدمًا مفعّلًا لديه صلاحية المجلد.');
          if (!state.fileShares.some(s => s.fileId === fileId && s.viewerId === data.viewerId)) state.fileShares.push({ fileId, viewerId: data.viewerId });
          audit(state, user, 'مشاركة ملف', file.name, state.users.find(u => u.id === data.viewerId).name); await save(state); return { ok: true };
        }
        if (method === 'DELETE' && viewerId) { state.fileShares = state.fileShares.filter(s => !(s.fileId === fileId && s.viewerId === viewerId)); audit(state, user, 'إلغاء مشاركة ملف', file.name); await save(state); return { ok: true }; }
        throw fail(404, 'عملية المشاركة غير متاحة.');
      }
      const route = /^\/api\/files\/([^/]+)(?:\/(download|restore))?$/.exec(path);
      if (route) {
        const file = state.files.find(f => f.id === route[1]);
        if (route[2] === 'restore' && method === 'POST') {
          requireAdmin(state); if (!file || file.deleted_at === null) throw fail(404, 'الملف غير موجود في سلة المحذوفات.');
          file.deleted_at = null; file.updated_at = Date.now(); audit(state, user, 'استعادة ملف', file.name); await save(state); return { ok: true };
        }
        if (!file || !canRead(state, user, file)) throw fail(404, 'الملف غير موجود أو ليس لديك إذن الاطلاع.');
        if (route[2] === 'download' && method === 'GET') {
          requirePermission(user, 'download'); const blob = await read('files', file.id); if (!blob) throw fail(404, 'محتوى الملف غير موجود في المتصفح.');
          audit(state, user, 'تنزيل ملف', file.name); await save(state); return { name: file.name, blob };
        }
        if (file.owner_id !== user.id && user.role !== 'admin') throw fail(403, 'إذن المشاركة يسمح بالاطلاع والتنزيل فقط.');
        if (!route[2] && method === 'PATCH') {
          validateFilename(data.name);
          if (!state.folders.some(f => f.id === data.folderId) || !folderAllowed(user, data.folderId)) throw fail(403, 'المجلد غير مصرح لك به.');
          const renamed = data.name !== file.name, moved = data.folderId !== file.folder_id;
          if (renamed) { requirePermission(user, 'rename'); validateExtension(state, data.name); }
          if (moved) requirePermission(user, 'move');
          const oldName = file.name; file.name = data.name; file.folder_id = data.folderId; file.updated_at = Date.now();
          audit(state, user, moved ? 'نقل ملف' : 'تعديل ملف', file.name, renamed ? `الاسم السابق: ${oldName}` : ''); await save(state); return { ok: true };
        }
        if (!route[2] && method === 'DELETE') {
          requirePermission(user, 'delete'); file.deleted_at = Date.now();
          // Remove file-specific grants; the owner's folder grants still apply after restore.
          state.fileShares = state.fileShares.filter(s => s.fileId !== file.id);
          audit(state, user, 'حذف إلى السلة', file.name); await save(state); return { ok: true };
        }
      }
      throw fail(404, 'هذه العملية غير متاحة. حذف الحسابات غير مسموح.');
    });
  }
  function validateUpload(state, file, folderId) {
    const { user } = session(state); requirePermission(user, 'upload');
    if (!state.folders.some(f => f.id === folderId)) throw fail(400, 'اختر مجلدًا قبل رفع الملف.');
    if (!folderAllowed(user, folderId)) throw fail(403, 'المجلد غير مصرح لك به.');
    if (!(file instanceof Blob)) throw fail(400, 'اختر ملفًا صحيحًا.');
    if (file.size > MAX_FILE_SIZE || file.size > state.settings.maxFileSize) throw fail(413, 'حجم الملف يتجاوز الحد الذي حدده المسؤول. الحد المطلق ٥ جيجابايت.');
    validateFilename(file.name); validateExtension(state, file.name);
    if (usedBytes(state, user.id) + file.size > user.quotaBytes) throw fail(413, 'لا تكفي المساحة المخصصة لحسابك. تشمل المساحة الملفات الموجودة في السلة.');
    return user;
  }
  async function checkServerSpace(file, signal) {
    const canceled = () => fail(499, 'أُلغي الرفع قبل إرسال الملف.');
    if (signal?.aborted) throw canceled();
    let response;
    try {
      response = await fetch(STORAGE_INFO_URL, { method: 'GET', signal, cache: 'no-store', mode: 'cors', credentials: 'omit', redirect: 'error' });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw canceled();
      throw fail(502, 'تعذّر الاتصال بالسيرفر لتفقد المساحة. لم يُرسل الملف. تحقق من الاتصال والسماح بالوصول للشبكة المحلية ثم حاول مجددًا.');
    }
    if (signal?.aborted) throw canceled();
    if (!response.ok) throw fail(502, `تعذّر تفقد مساحة السيرفر (HTTP ${response.status}). لم يُرسل الملف.`);
    let data;
    try { data = await response.json(); }
    catch {
      if (signal?.aborted) throw canceled();
      throw fail(502, 'رد مساحة السيرفر غير صالح. لم يُرسل الملف.');
    }
    if (signal?.aborted) throw canceled();
    const value = data?.freeGB;
    const numeric = typeof value === 'number' || (typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()));
    const freeGB = numeric ? Number(value) : NaN;
    const freeBytes = Math.floor(freeGB * 1024 ** 3);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.success === false || data.ok === false || data.error || !Number.isSafeInteger(freeBytes) || freeBytes < 0) throw fail(502, 'تعذّر تحديد المساحة الحرة من رد السيرفر. لم يُرسل الملف.');
    if (file.size > freeBytes) throw fail(507, `المساحة المتبقية بالسيرفر (${freeGB} جيجابايت) غير كافية لرفع هذا الملف. لم يُرسل الملف.`);
  }
  async function upload(file, folderId, signal) {
    const canceled = () => fail(499, 'أُلغي طلب الرفع. إذا كان الإرسال قد بدأ فتحقق من السيرفر قبل إعادة المحاولة.');
    if (signal?.aborted) throw canceled();
    const ticket = await lock(async () => {
      const user = validateUpload(await read('state', 'portal'), file, folderId);
      return { userId: user.id, revision: user.revision };
    });
    if (signal?.aborted) throw canceled();
    // Check fresh server capacity without blocking local sessions or admin actions.
    await checkServerSpace(file, signal);
    await lock(async () => {
      const user = validateUpload(await read('state', 'portal'), file, folderId);
      if (user.id !== ticket.userId || user.revision !== ticket.revision) throw fail(401, 'تغيرت جلسة الدخول أثناء تفقد المساحة. لم يُرسل الملف.');
    });
    if (signal?.aborted) throw fail(499, 'أُلغي الرفع قبل إرسال الملف.');
    const formData = new FormData();
    formData.append('file', file, file.name);
    let response;
    // Do not hold the local database lock while transferring a large file.
    // Heartbeats, logout and administrator actions must remain responsive.
    try {
      response = await fetch(UPLOAD_URL, { method: 'POST', body: formData, signal, mode: 'cors', credentials: 'omit', redirect: 'error' });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw canceled();
      throw fail(502, 'تعذّر تأكيد الرفع. تحقق من اتصالك بشبكة السيرفر والسماح بالوصول للشبكة المحلية. قد يكون السبب إعدادات CORS أو HTTP/HTTPS. راجع السيرفر قبل إعادة المحاولة.');
    }
    if (!response.ok) throw fail(502, `لم يؤكد السيرفر الرفع (HTTP ${response.status}). تحقق من إعداداته وحجم الملف المسموح.`);
    let receipt;
    try { receipt = await response.json(); }
    catch {
      if (signal?.aborted) throw canceled();
      throw fail(502, 'وصل رد ناجح من السيرفر، لكن صيغة الرد ليست JSON صالحًا. تحقق من وجود الملف في السيرفر قبل إعادة المحاولة.');
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.success === false || receipt.ok === false || receipt.error) throw fail(502, 'لم يؤكد رد السيرفر نجاح الرفع. تحقق من وجود الملف قبل إعادة المحاولة.');
    try {
      return await lock(async () => {
        if (signal?.aborted) throw canceled();
        const state = await read('state', 'portal'), user = validateUpload(state, file, folderId);
        if (user.id !== ticket.userId || user.revision !== ticket.revision) throw fail(401, 'تغيرت جلسة الدخول أثناء الرفع. سجّل الدخول مجددًا.');
        const now = Date.now();
        const entry = { id: id(), owner_id: user.id, folder_id: folderId, name: file.name, size: file.size, created_at: now, updated_at: now, deleted_at: null,
          remote_uploaded_at: now, remote_filename: typeof receipt.fileName === 'string' ? receipt.fileName.slice(0, 500) : null };
        state.files.push(entry); audit(state, user, 'رفع ملف', file.name, 'رُفع إلى السيرفر مع حفظ نسخة محلية للتجربة.');
        await save(state, { id: entry.id, blob: file }, signal); return entry;
      });
    } catch (error) {
      // A local save failure must not be reported as a remote upload failure.
      error.serverUploaded = true;
      error.message = `نجح رفع «${file.name}» إلى السيرفر، لكن لم تُحفظ نسخته في البوابة: ${error.message} لا تكرر الرفع لنفس الملف.`;
      throw error;
    }
  }

  // A binary container avoids converting large files to base64 strings.
  const BACKUP_MAGIC = 'BSHRKM02';
  async function exportBackup() {
    return lock(async () => {
      const state = await read('state', 'portal'), { user } = requireAdmin(state), blobs = [];
      for (const f of state.files) { const blob = await read('files', f.id); if (!blob || blob.size !== f.size) throw fail(409, `تعذّر نسخ الملف: ${f.name}`); blobs.push(blob); }
      audit(state, user, 'تصدير نسخة احتياطية'); await save(state);
      const header = new TextEncoder().encode(JSON.stringify({ format: BACKUP_MAGIC, state }));
      if (header.length > 10 * 1024 ** 2) throw fail(413, 'بيانات النسخة أكبر من الحد المدعوم في هذه التجربة.');
      const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, header.length);
      return new Blob([BACKUP_MAGIC, length, header, ...blobs], { type: 'application/octet-stream' });
    });
  }
  function validateBackupState(s) {
    const invalid = () => { throw fail(400, 'ملف النسخة الاحتياطية غير صالح.'); };
    if (!s || ![2, 3, 4].includes(s.version) || typeof s.sharingEnabled !== 'boolean' || ['users', 'folders', 'files', 'shares', 'fileShares', 'audit'].some(k => !Array.isArray(s[k]))) invalid();
    if (s.version >= 3 && !Array.isArray(s.folderShares)) invalid();
    if (s.version < 4) migrate(s);
    const unique = list => { const keys = new Set(); for (const x of list) { if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 100 || keys.has(x.id)) invalid(); keys.add(x.id); } return keys; };
    const userIds = unique(s.users), folderIds = unique(s.folders), fileIds = unique(s.files); unique(s.audit);
    for (const f of s.folders) if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 160) invalid();
    const names = new Set();
    for (const u of s.users) {
      validateUser(u, undefined, s);
      if (typeof u.active !== 'boolean' || typeof u.allFolders !== 'boolean' || !Array.isArray(u.folderIds) || !u.permissions || PERMISSIONS.some(p=>typeof u.permissions[p]!=='boolean') || !Number.isSafeInteger(u.quotaBytes)) invalid();
      if (typeof u.salt !== 'string' || u.salt.length > 100 || !/^[0-9a-f]{64}$/.test(u.passwordHash) || !Number.isSafeInteger(u.revision) || u.revision < 1 || u.revision > Number.MAX_SAFE_INTEGER-1000 || !Number.isSafeInteger(u.failedAttempts) || u.failedAttempts < 0 || !Number.isFinite(u.lockedUntil)) invalid();
      const name = keyOf(u.username); if (names.has(name)) invalid(); names.add(name);
    }
    if (!s.users.some(u => u.active && u.role === 'admin')) invalid();
    for (const f of s.files) {
      validateFilename(f.name);
      if (!userIds.has(f.owner_id) || !folderIds.has(f.folder_id) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_SIZE || !Number.isFinite(f.created_at) || !Number.isFinite(f.updated_at) || (f.deleted_at !== null && !Number.isFinite(f.deleted_at))) invalid();
    }
    for (const grant of s.shares) if (!userIds.has(grant.ownerId) || !userIds.has(grant.viewerId) || grant.ownerId === grant.viewerId) invalid();
    for (const grant of s.folderShares) if (!userIds.has(grant.ownerId) || !userIds.has(grant.viewerId) || !folderIds.has(grant.folderId) || grant.ownerId === grant.viewerId) invalid();
    for (const grant of s.fileShares) if (!fileIds.has(grant.fileId) || !userIds.has(grant.viewerId)) invalid();
    for (const event of s.audit) if (!Number.isFinite(event.at) || ['actor', 'action', 'target', 'details'].some(k => typeof event[k] !== 'string') || (event.actorId !== null && !userIds.has(event.actorId))) invalid();
    s.settings = validateSettings(s.settings, s.settings); return s;
  }
  async function parseBackup(file) {
    if (!(file instanceof Blob) || file.size < 13) throw fail(400, 'اختر نسخة احتياطية صحيحة بامتداد bshbak.');
    const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (new TextDecoder().decode(prefix.slice(0, 8)) !== BACKUP_MAGIC) throw fail(400, 'صيغة النسخة غير مدعومة.');
    const length = new DataView(prefix.buffer).getUint32(8);
    if (length < 1 || length > 10 * 1024 ** 2 || length + 12 > file.size) throw fail(400, 'النسخة غير مكتملة.');
    let header; try { header = JSON.parse(await file.slice(12, 12 + length).text()); } catch { throw fail(400, 'بيانات النسخة تالفة.'); }
    if (header.format !== BACKUP_MAGIC) throw fail(400, 'صيغة النسخة غير صحيحة.');
    let state; try { state = validateBackupState(header.state); } catch { throw fail(400, 'بيانات النسخة غير صالحة أو غير متوافقة.'); }
    let offset = 12 + length; const blobs = [];
    for (const f of state.files) { blobs.push({ id: f.id, blob: file.slice(offset, offset + f.size) }); offset += f.size; }
    if (offset !== file.size) throw fail(400, 'محتوى الملفات في النسخة غير مكتمل.');
    return { state, blobs };
  }
  async function inspectBackup(file) {
    return lock(async () => { requireAdmin(await read('state', 'portal')); const { state } = await parseBackup(file);
      return { users: state.users.length, files: state.files.length, bytes: state.files.reduce((n, f) => n + f.size, 0) }; });
  }
  async function restoreBackup(file) {
    return lock(async () => {
      const oldState = await read('state', 'portal'), { user } = requireAdmin(oldState), { state, blobs } = await parseBackup(file);
      session(oldState);
      for (const u of state.users) u.revision = Math.max(u.revision, oldState.users.find(x => x.id === u.id)?.revision || 0) + 1;
      audit(state, null, 'استعادة نسخة احتياطية', '', `بواسطة ${user.name}`);
      await save(state, { replace: blobs }); sessionStorage.removeItem(SESSION_KEY); return { ok: true };
    });
  }
  window.DemoPortal = { request, upload, exportBackup, inspectBackup, restoreBackup };
})();
