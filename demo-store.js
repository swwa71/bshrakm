/* Offline demonstration only. Browser-side roles are not a security boundary. */
(() => {
  'use strict';
  const DB_NAME = 'bushrakom-html-demo-v1';
  const SESSION_KEY = 'bushrakom-html-session-v1';
  const IDLE_MS = 15 * 60 * 1000;
  const MAX_FILE_SIZE = 1024 ** 3;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const userView = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });
  const keyOf = value => value.trim().normalize('NFKC').toLowerCase();
  let database;
  let startup;
  let queue = Promise.resolve();
  const id = () => crypto.randomUUID();

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('state');
        request.result.createObjectStore('files');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(fail(503, 'المتصفح يمنع التخزين المحلي. افتح الملف في Chrome أو Edge واسمح بتخزين بيانات الموقع.'));
      request.onblocked = () => reject(fail(503, 'أغلق النوافذ الأخرى للنسخة التجريبية ثم أعد فتحها.'));
    });
  }
  function read(store, key) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function save(state, fileOperation, signal) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['state', 'files'], 'readwrite');
      const abort = () => { try { tx.abort(); } catch {} };
      signal?.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(); };
      tx.onabort = () => {
        signal?.removeEventListener('abort', abort);
        reject(signal?.aborted ? fail(499, 'تم إلغاء الحفظ.') : fail(507, 'تعذّر حفظ البيانات. قد لا تكفي مساحة المتصفح؛ جرّب ملفًا أصغر أو وفّر مساحة على الجهاز.'));
      };
      tx.onerror = () => {};
      if (signal?.aborted) { tx.abort(); return; }
      tx.objectStore('state').put(state, 'portal');
      if (fileOperation?.blob !== undefined) tx.objectStore('files').put(fileOperation.blob, fileOperation.id);
      if (fileOperation?.remove) tx.objectStore('files').delete(fileOperation.remove);
    });
  }
  function passwordLength(value) {
    if (typeof value !== 'string' || [...value].length < 4 || [...value].length > 20) throw fail(400, 'كلمة المرور يجب أن تكون من ٤ إلى ٢٠ خانة بأي نوع من الأحرف.');
  }
  async function passwordHash(value, salt) {
    passwordLength(value);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
    const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(salt) }, key, 256);
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function init() {
    if (!crypto?.subtle || !crypto?.randomUUID || !window.indexedDB) throw fail(503, 'هذه التجربة تحتاج متصفحًا حديثًا. افتح index.html مباشرة في Chrome أو Edge، أو استخدم رابط HTTPS عند نشرها.');
    database = await openDatabase();
    const existing = await read('state', 'portal');
    if (existing) {
      // Add per-file grants without recreating accounts, files or existing permissions.
      if (!Array.isArray(existing.fileShares)) { existing.fileShares = []; await save(existing); }
      return;
    }
    const definitions = [
      ['admin', 'مسؤول النظام التجريبي', 'admin', '1234'],
      ['1001', 'موظف تجريبي', 'user', '1234'],
      ['ahmad', 'أحمد — حساب تجريبي', 'user', 'abcd']
    ];
    const users = [];
    for (const [username, name, role, password] of definitions) {
      const salt = id();
      users.push({ id: id(), username, name, role, revision: 1, salt, passwordHash: await passwordHash(password, salt) });
    }
    await save({ users, folders: ['المستندات العامة', 'التقارير', 'النماذج'].map(name => ({ id: id(), name })), files: [], shares: [], fileShares: [], sharingEnabled: true });
  }
  function lock(operation) {
    const execute = async () => { if (!startup) startup = init(); await startup; return operation(); };
    if (navigator.locks) return navigator.locks.request(DB_NAME, execute);
    const pending = queue.then(execute, execute); queue = pending.catch(() => {}); return pending;
  }
  function readSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
  function session(state) {
    const data = readSession();
    const user = data && state.users.find(u => u.id === data.userId && u.revision === data.revision);
    if (!user || Date.now() - data.lastActive >= IDLE_MS) { sessionStorage.removeItem(SESSION_KEY); throw fail(401, 'سجّل الدخول مجددًا. تنتهي الجلسة بعد ١٥ دقيقة من عدم النشاط.'); }
    return { user, data };
  }
  function requireAdmin(state) { const s = session(state); if (s.user.role !== 'admin') throw fail(403, 'هذه العملية لمسؤول النظام.'); return s; }
  function canRead(state, userId, file) {
    return file.owner_id === userId || (state.sharingEnabled && (
      state.shares.some(s => s.ownerId === file.owner_id && s.viewerId === userId) ||
      (state.fileShares || []).some(s => s.fileId === file.id && s.viewerId === userId)
    ));
  }
  function validateUser(input) {
    const username = typeof input.username === 'string' ? input.username.trim().normalize('NFC') : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!username || [...username].length > 64 || /[\p{C}\s]/u.test(username)) throw fail(400, 'أدخل اسم مستخدم حتى ٦٤ خانة دون مسافات.');
    if (!name || [...name].length > 100) throw fail(400, 'الاسم مطلوب، حتى ١٠٠ خانة.');
    if (!['admin', 'user'].includes(input.role)) throw fail(400, 'الصلاحية غير صحيحة.');
    return { username, name, role: input.role };
  }
  function validateFilename(name) { if (typeof name !== 'string' || !name.trim() || [...name].length > 240 || /[\p{C}\/\\]/u.test(name) || ['.', '..'].includes(name)) throw fail(400, 'اسم الملف غير صالح أو طويل جدًا.'); }
  async function request(path, { method = 'GET', data = {} } = {}) {
    return lock(async () => {
      const state = await read('state', 'portal');
      if (path === '/api/logout' && method === 'POST') { sessionStorage.removeItem(SESSION_KEY); return { ok: true }; }
      if (path === '/api/login' && method === 'POST') {
        const user = typeof data.username === 'string' && state.users.find(u => keyOf(u.username) === keyOf(data.username));
        let valid = false;
        if (user) { try { valid = await passwordHash(data.password, user.salt) === user.passwordHash; } catch {} }
        if (!valid) throw fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة. جرّب admin وكلمة المرور 1234 إذا لم تعدّل الحساب.');
        const lastActive = Date.now();
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id, revision: user.revision, lastActive }));
        return { user: userView(user), lastActive, idleMs: IDLE_MS };
      }
      const { user, data: currentSession } = session(state);
      if (path === '/api/me' && method === 'GET') return { user: userView(user), lastActive: currentSession.lastActive, idleMs: IDLE_MS, sharingEnabled: state.sharingEnabled, maxFileSize: MAX_FILE_SIZE };
      if (path === '/api/activity' && method === 'POST') { currentSession.lastActive = Date.now(); sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession)); return { lastActive: currentSession.lastActive }; }
      if (path === '/api/folders' && method === 'GET') return { folders: state.folders };
      if ((path === '/api/folders' && method === 'POST') || (path.startsWith('/api/folders/') && method === 'PATCH')) {
        requireAdmin(state); const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || [...name].length > 80) throw fail(400, 'اسم المجلد مطلوب، حتى ٨٠ خانة.');
        const folderId = path.split('/').at(-1);
        if (state.folders.some(f => f.name === name && f.id !== folderId)) throw fail(409, 'اسم المجلد موجود بالفعل.');
        let folder;
        if (method === 'POST') { folder = { id: id(), name }; state.folders.push(folder); }
        else { folder = state.folders.find(f => f.id === folderId); if (!folder) throw fail(404, 'المجلد غير موجود.'); folder.name = name; }
        await save(state); return folder;
      }
      if (path === '/api/users' && method === 'GET') { requireAdmin(state); return { users: state.users.map(userView) }; }
      if ((path === '/api/users' && method === 'POST') || (path.startsWith('/api/users/') && method === 'PATCH')) {
        requireAdmin(state); const c = validateUser(data), userId = method === 'POST' ? id() : path.split('/').at(-1);
        if (state.users.some(u => u.id !== userId && keyOf(u.username) === keyOf(c.username))) throw fail(409, 'اسم المستخدم مستخدم بالفعل.');
        let updated, relogin = false;
        if (method === 'POST') {
          const salt = id(); updated = { id: userId, ...c, salt, revision: 1, passwordHash: await passwordHash(data.password, salt) }; state.users.push(updated);
        } else {
          updated = state.users.find(u => u.id === userId); if (!updated) throw fail(404, 'المستخدم غير موجود.');
          if (updated.role === 'admin' && c.role !== 'admin' && state.users.filter(u => u.role === 'admin').length === 1) throw fail(409, 'يجب أن يبقى مسؤول نظام واحد على الأقل.');
          const changed = updated.role !== c.role || updated.username !== c.username || !!data.password;
          if (data.password) { updated.salt = id(); updated.passwordHash = await passwordHash(data.password, updated.salt); }
          if (changed) updated.revision++;
          relogin = changed && userId === user.id; Object.assign(updated, c);
        }
        if (Date.now() - currentSession.lastActive >= IDLE_MS) throw fail(401, 'انتهت الجلسة. سجّل الدخول مجددًا.');
        await save(state); return { user: userView(updated), relogin };
      }
      if (path === '/api/settings' && method === 'PATCH') { requireAdmin(state); if (typeof data.sharingEnabled !== 'boolean') throw fail(400, 'قيمة المشاركة غير صحيحة.'); state.sharingEnabled = data.sharingEnabled; await save(state); return { sharingEnabled: state.sharingEnabled }; }
      if (path === '/api/shares' && method === 'GET') return { sharingEnabled: state.sharingEnabled, users: state.users.filter(u => u.id !== user.id).map(userView), viewerIds: state.shares.filter(s => s.ownerId === user.id).map(s => s.viewerId) };
      if (path === '/api/shares' && method === 'POST') {
        if (!state.sharingEnabled) throw fail(403, 'المشاركة مغلقة حاليًا بقرار مسؤول النظام.');
        if (data.viewerId === user.id || !state.users.some(u => u.id === data.viewerId)) throw fail(400, 'اختر مستخدمًا آخر.');
        if (!state.shares.some(s => s.ownerId === user.id && s.viewerId === data.viewerId)) state.shares.push({ ownerId: user.id, viewerId: data.viewerId });
        await save(state); return { ok: true };
      }
      if (path.startsWith('/api/shares/') && method === 'DELETE') { state.shares = state.shares.filter(s => !(s.ownerId === user.id && s.viewerId === path.split('/').at(-1))); await save(state); return { ok: true }; }
      if (path === '/api/files' && method === 'GET') return { sharingEnabled: state.sharingEnabled, files: state.files.filter(f => canRead(state, user.id, f)).map(f => ({ ...f, owner_name: state.users.find(u => u.id === f.owner_id)?.name || '', folder_name: state.folders.find(d => d.id === f.folder_id)?.name || '' })).sort((a, b) => b.created_at - a.created_at) };
      const fileShareRoute = /^\/api\/files\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(path);
      if (fileShareRoute) {
        const [, fileId, viewerId] = fileShareRoute;
        const file = state.files.find(f => f.id === fileId);
        if (!file || file.owner_id !== user.id) throw fail(403, 'صاحب الملف وحده يستطيع إدارة مشاركته.');
        state.fileShares ||= [];
        if (method === 'GET' && !viewerId) return {
          file: { id: file.id, name: file.name }, sharingEnabled: state.sharingEnabled,
          users: state.users.filter(u => u.id !== user.id).map(userView),
          viewerIds: state.fileShares.filter(s => s.fileId === fileId).map(s => s.viewerId),
          allFilesViewerIds: state.shares.filter(s => s.ownerId === user.id).map(s => s.viewerId)
        };
        if (method === 'POST' && !viewerId) {
          if (!state.sharingEnabled) throw fail(403, 'المشاركة مغلقة حاليًا بقرار مسؤول النظام.');
          if (data.viewerId === user.id || !state.users.some(u => u.id === data.viewerId)) throw fail(400, 'اختر مستخدمًا آخر.');
          if (!state.fileShares.some(s => s.fileId === fileId && s.viewerId === data.viewerId)) state.fileShares.push({ fileId, viewerId: data.viewerId });
          await save(state); return { ok: true };
        }
        if (method === 'DELETE' && viewerId) {
          state.fileShares = state.fileShares.filter(s => !(s.fileId === fileId && s.viewerId === viewerId));
          await save(state); return { ok: true };
        }
        throw fail(404, 'عملية المشاركة غير متاحة.');
      }
      if (path.startsWith('/api/files/')) {
        const file = state.files.find(f => f.id === path.split('/')[3]);
        if (!file || !canRead(state, user.id, file)) throw fail(404, 'الملف غير موجود أو ليس لديك إذن الاطلاع.');
        if (path.endsWith('/download') && method === 'GET') { const blob = await read('files', file.id); if (!blob) throw fail(404, 'لم يعد محتوى الملف موجودًا في المتصفح.'); return { name: file.name, blob }; }
        if (file.owner_id !== user.id) throw fail(403, 'إذن المشاركة يسمح بالاطلاع والتنزيل فقط.');
        if (method === 'PATCH') {
          validateFilename(data.name); if (!state.folders.some(f => f.id === data.folderId)) throw fail(400, 'اختر مجلدًا صحيحًا.');
          file.name = data.name; file.folder_id = data.folderId; await save(state); return { ok: true };
        }
        if (method === 'DELETE') { state.files = state.files.filter(f => f.id !== file.id); state.fileShares = (state.fileShares || []).filter(s => s.fileId !== file.id); await save(state, { remove: file.id }); return { ok: true }; }
      }
      throw fail(404, 'هذه العملية غير متاحة. حذف الحسابات غير مسموح.');
    });
  }
  async function upload(file, folderId, signal) {
    return lock(async () => {
      const state = await read('state', 'portal'); const { user } = session(state);
      if (!state.folders.some(f => f.id === folderId)) throw fail(400, 'اختر مجلدًا قبل رفع الملف.');
      if (!(file instanceof Blob)) throw fail(400, 'اختر ملفًا صحيحًا.');
      if (file.size > MAX_FILE_SIZE) throw fail(413, 'الحد الأقصى للملف الواحد ١ جيجابايت.');
      validateFilename(file.name);
      const entry = { id: id(), owner_id: user.id, folder_id: folderId, name: file.name, size: file.size, created_at: Date.now() };
      state.files.push(entry); await save(state, { id: entry.id, blob: file }, signal); return entry;
    });
  }
  window.DemoPortal = { request, upload };
})();
