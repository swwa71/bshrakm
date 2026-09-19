import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const MAX_FILE_SIZE = 1024 ** 3;
export const IDLE_MS = 15 * 60 * 1000;
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });

function credentials(input) {
  const username = typeof input.username === 'string' ? input.username.trim().normalize('NFC') : '';
  if (!username || [...username].length > 64 || /[\p{C}\s]/u.test(username)) throw fail(400, 'اسم المستخدم مطلوب، حتى ٦٤ خانة وبدون مسافات.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || [...name].length > 100) throw fail(400, 'الاسم مطلوب، حتى ١٠٠ خانة.');
  if (!['admin', 'user'].includes(input.role)) throw fail(400, 'نوع المستخدم غير صحيح.');
  return { username, usernameKey: username.normalize('NFKC').toLowerCase(), name, role: input.role };
}
function checkPassword(password) {
  if (typeof password !== 'string' || [...password].length < 4 || [...password].length > 20) throw fail(400, 'كلمة المرور يجب أن تكون من ٤ إلى ٢٠ خانة، بأي نوع من الأحرف.');
}
async function hashPassword(password) {
  checkPassword(password);
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await derive(password, salt, 64)).toString('hex');
}
async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || [...password].length > 20) return false;
  const [salt, key] = hash.split(':');
  return timingSafeEqual(await derive(password, salt, 64), Buffer.from(key, 'hex'));
}

export async function createPortal({ dataDir = resolve(ROOT, process.env.DATA_DIR || 'data'), origin = process.env.APP_ORIGIN || 'http://localhost:3000', now = Date.now } = {}) {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || (parsedOrigin.protocol !== 'https:' && !(parsedOrigin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)))) throw new Error('APP_ORIGIN must be an exact HTTPS origin, or HTTP localhost for local use.');
  const secure = parsedOrigin.protocol === 'https:';
  const storage = resolve(dataDir);
  const publicDir = join(ROOT, 'public');
  if (storage === ROOT || storage === publicDir || storage.startsWith(publicDir + '/') || storage.startsWith(publicDir + '\\')) throw new Error('DATA_DIR must be outside public/.');
  await mkdir(join(storage, 'files'), { recursive: true, mode: 0o700 });
  await mkdir(join(storage, 'tmp'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(storage, 'portal.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), last_active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), folder_id TEXT NOT NULL REFERENCES folders(id), name TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shares(owner_id TEXT NOT NULL REFERENCES users(id), viewer_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(owner_id,viewer_id), CHECK(owner_id != viewer_id));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES('sharing_enabled','1');
    CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
  if (!db.prepare('SELECT 1 FROM folders LIMIT 1').get()) {
    for (const name of ['المستندات العامة', 'التقارير', 'النماذج']) db.prepare('INSERT INTO folders VALUES(?,?)').run(randomUUID(), name);
  }
  const sharingEnabled = () => db.prepare("SELECT value FROM settings WHERE key='sharing_enabled'").get().value === '1';
  const dummyHash = await hashPassword(randomBytes(8).toString('hex'));
  const loginAttempts = new Map();
  let uploads = 0;
  const cookie = (token, clear = false) => `portal_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const tokenOf = req => /(?:^|;\s*)portal_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  function session(req) {
    const token = tokenOf(req);
    if (!token) throw fail(401, 'يرجى تسجيل الدخول.');
    const hash = digest(token);
    const result = db.prepare('SELECT u.*, s.last_active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(hash);
    if (!result || now() - result.last_active >= IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(hash);
      throw fail(401, 'انتهت الجلسة بعد ١٥ دقيقة من عدم النشاط. سجّل الدخول مجددًا.');
    }
    return { user: result, token: hash, lastActive: result.last_active };
  }
  function admin(req) { const s = session(req); if (s.user.role !== 'admin') throw fail(403, 'هذه الصلاحية لمسؤول النظام.'); return s; }
  function canRead(userId, file) { return file.owner_id === userId || (sharingEnabled() && !!db.prepare('SELECT 1 FROM shares WHERE owner_id=? AND viewer_id=?').get(file.owner_id, userId)); }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'نوع الطلب غير صحيح.');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail(413, 'الطلب أكبر من الحد المسموح.'); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw fail(400, 'بيانات الطلب غير صحيحة.'); }
  }
  async function createUser(input) {
    const c = credentials(input);
    const hash = await hashPassword(input.password);
    const id = randomUUID();
    try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, c.username, c.usernameKey, c.name, c.role, hash); }
    catch (e) { if (e.code?.startsWith('ERR_SQLITE') && db.prepare('SELECT 1 FROM users WHERE username_key=?').get(c.usernameKey)) throw fail(409, 'اسم المستخدم مستخدم بالفعل.'); throw e; }
    return publicUser({ id, ...c });
  }
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/background.png': ['background.png', 'image/png'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw fail(403, 'مصدر الطلب غير مسموح. أعد فتح البوابة من رابطها الأساسي.');
      if (assets[path] && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = assets[path]; res.setHeader('Content-Type', type);
        if (req.method === 'HEAD') return res.end();
        await pipeline(createReadStream(join(publicDir, file)), res); return;
      }
      if (path === '/api/login' && req.method === 'POST') {
        const input = await body(req);
        const ip = req.socket.remoteAddress || 'local';
        const key = typeof input.username === 'string' ? input.username.trim().normalize('NFKC').toLowerCase() : '';
        const keys = ['ip:' + ip, 'user:' + key];
        for (const k of keys) {
          const rate = loginAttempts.get(k);
          if (rate && rate.until > now() && rate.count >= 10) throw fail(429, 'محاولات كثيرة. حاول مرة أخرى بعد ١٥ دقيقة.');
        }
        if (loginAttempts.size > 10000) for (const [k, v] of loginAttempts) if (v.until <= now()) loginAttempts.delete(k);
        if (loginAttempts.size > 10000) throw fail(429, 'حاول مرة أخرى لاحقًا.');
        for (const k of keys) { const rate = loginAttempts.get(k); loginAttempts.set(k, { count: rate && rate.until > now() ? rate.count + 1 : 1, until: rate && rate.until > now() ? rate.until : now() + IDLE_MS }); }
        const u = db.prepare('SELECT * FROM users WHERE username_key=?').get(key);
        const valid = await verifyPassword(input.password, u?.password_hash || dummyHash);
        if (!u || !valid) throw fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
        // A concurrent administrator password reset must win over a pending login.
        if (db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id)?.password_hash !== u.password_hash) throw fail(401, 'تغيّرت بيانات الحساب. سجّل الدخول مجددًا.');
        for (const k of keys) loginAttempts.delete(k);
        db.prepare('DELETE FROM sessions WHERE last_active <= ?').run(now() - IDLE_MS);
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), u.id, now());
        res.setHeader('Set-Cookie', cookie(token)); return json(res, 200, { user: publicUser(u), lastActive: now(), idleMs: IDLE_MS });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        const token = tokenOf(req); if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
        res.setHeader('Set-Cookie', cookie('', true)); return json(res, 200, { ok: true });
      }
      const s = session(req); const user = s.user;
      if (path === '/api/me' && req.method === 'GET') return json(res, 200, { user: publicUser(user), lastActive: s.lastActive, idleMs: IDLE_MS, sharingEnabled: sharingEnabled(), maxFileSize: MAX_FILE_SIZE });
      if (path === '/api/activity' && req.method === 'POST') { db.prepare('UPDATE sessions SET last_active=? WHERE token=?').run(now(), s.token); return json(res, 200, { lastActive: now() }); }
      if (path === '/api/folders' && req.method === 'GET') return json(res, 200, { folders: db.prepare('SELECT * FROM folders ORDER BY rowid').all() });
      if ((path === '/api/folders' && req.method === 'POST') || (/^\/api\/folders\/[^/]+$/.test(path) && req.method === 'PATCH')) {
        admin(req); const input = await body(req); admin(req);
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || [...name].length > 80) throw fail(400, 'اسم المجلد مطلوب، حتى ٨٠ خانة.');
        if (db.prepare('SELECT 1 FROM folders WHERE name=?').get(name)) throw fail(409, 'اسم المجلد موجود بالفعل.');
        const id = req.method === 'POST' ? randomUUID() : path.split('/').at(-1);
        if (req.method === 'POST') db.prepare('INSERT INTO folders VALUES(?,?)').run(id, name);
        else if (!db.prepare('UPDATE folders SET name=? WHERE id=?').run(name, id).changes) throw fail(404, 'المجلد غير موجود.');
        return json(res, 200, { id, name });
      }
      if (path === '/api/users' && req.method === 'GET') { admin(req); return json(res, 200, { users: db.prepare('SELECT id,username,name,role FROM users ORDER BY rowid').all() }); }
      if (path === '/api/users' && req.method === 'POST') { admin(req); const input = await body(req); admin(req); const c = credentials(input); const hash = await hashPassword(input.password); admin(req); const id = randomUUID(); if (db.prepare('SELECT 1 FROM users WHERE username_key=?').get(c.usernameKey)) throw fail(409, 'اسم المستخدم مستخدم بالفعل.'); db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,c.username,c.usernameKey,c.name,c.role,hash); return json(res, 201, { user: publicUser({ id,...c }) }); }
      if (/^\/api\/users\/[^/]+$/.test(path) && req.method === 'PATCH') {
        admin(req); const input = await body(req); const id = path.split('/').at(-1);
        const c = credentials(input); const hash = input.password === '' || input.password === undefined ? null : await hashPassword(input.password);
        admin(req); const old = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!old) throw fail(404, 'المستخدم غير موجود.');
        if (old.role === 'admin' && c.role !== 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n <= 1) throw fail(409, 'يجب أن يبقى مسؤول نظام واحد على الأقل.');
        if (db.prepare('SELECT 1 FROM users WHERE username_key=? AND id<>?').get(c.usernameKey, id)) throw fail(409, 'اسم المستخدم مستخدم بالفعل.');
        db.prepare('UPDATE users SET username=?,username_key=?,name=?,role=?,password_hash=? WHERE id=?').run(c.username,c.usernameKey,c.name,c.role,hash || old.password_hash,id);
        if (hash || old.role !== c.role || old.username !== c.username) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        return json(res, 200, { user: publicUser({id,...c}), relogin: id === user.id && !!(hash || old.role !== c.role || old.username !== c.username) });
      }
      if (path === '/api/settings' && req.method === 'PATCH') {
        admin(req); const input = await body(req); admin(req);
        if (typeof input.sharingEnabled !== 'boolean') throw fail(400, 'قيمة المشاركة غير صحيحة.');
        db.prepare("UPDATE settings SET value=? WHERE key='sharing_enabled'").run(input.sharingEnabled ? '1' : '0');
        return json(res, 200, { sharingEnabled: sharingEnabled() });
      }
      if (path === '/api/shares' && req.method === 'GET') return json(res, 200, { sharingEnabled: sharingEnabled(), users: db.prepare('SELECT id,username,name FROM users WHERE id<>? ORDER BY name').all(user.id), viewerIds: db.prepare('SELECT viewer_id FROM shares WHERE owner_id=?').all(user.id).map(r => r.viewer_id) });
      if (path === '/api/shares' && req.method === 'POST') {
        const input = await body(req); session(req);
        if (!sharingEnabled()) throw fail(403, 'المشاركة مغلقة حاليًا بقرار مسؤول النظام.');
        if (typeof input.viewerId !== 'string' || input.viewerId === user.id || !db.prepare('SELECT 1 FROM users WHERE id=?').get(input.viewerId)) throw fail(400, 'اختر مستخدمًا آخر.');
        db.prepare('INSERT OR IGNORE INTO shares VALUES(?,?)').run(user.id,input.viewerId); return json(res, 200, { ok: true });
      }
      if (/^\/api\/shares\/[^/]+$/.test(path) && req.method === 'DELETE') { db.prepare('DELETE FROM shares WHERE owner_id=? AND viewer_id=?').run(user.id,path.split('/').at(-1)); return json(res,200,{ok:true}); }
      if (path === '/api/files' && req.method === 'GET') {
        const rows = db.prepare('SELECT f.id,f.owner_id,f.folder_id,f.name,f.size,f.created_at,u.name AS owner_name,d.name AS folder_name FROM files f JOIN users u ON u.id=f.owner_id JOIN folders d ON d.id=f.folder_id WHERE f.owner_id=? OR (?=1 AND EXISTS(SELECT 1 FROM shares s WHERE s.owner_id=f.owner_id AND s.viewer_id=?)) ORDER BY f.created_at DESC').all(user.id,sharingEnabled()?1:0,user.id);
        return json(res,200,{files:rows,sharingEnabled:sharingEnabled()});
      }
      if (path === '/api/files' && req.method === 'POST') {
        const folder = url.searchParams.get('folderId');
        if (!folder || !db.prepare('SELECT 1 FROM folders WHERE id=?').get(folder)) throw fail(400, 'يجب اختيار مجلد صحيح قبل رفع الملف.');
        let name; try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw fail(400,'اسم الملف غير صحيح.'); }
        if (!name || [...name].length > 240 || /[\p{C}\/\\]/u.test(name) || ['.','..'].includes(name)) throw fail(400,'اسم الملف غير صحيح أو طويل جدًا.');
        if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > MAX_FILE_SIZE) throw fail(413,'الحد الأقصى للملف الواحد ١ جيجابايت.');
        if (uploads >= 4) throw fail(429, 'الخادم مشغول برفع ملفات. حاول مجددًا بعد قليل.');
        const id = randomUUID(); const temporary = join(storage,'tmp',id); const destination = join(storage,'files',id);
        let size = 0; let saved = false; uploads++;
        try {
          const counter = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > MAX_FILE_SIZE ? fail(413,'الحد الأقصى للملف الواحد ١ جيجابايت.') : null,chunk); } });
          await pipeline(req,counter,createWriteStream(temporary,{flags:'wx',mode:0o600}));
          session(req);
          await rename(temporary,destination); saved = true;
          session(req);
          db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?)').run(id,user.id,folder,name,size,now());
          return json(res,201,{id,name,size});
        } catch (e) { await unlink(saved?destination:temporary).catch(()=>{}); throw e; }
        finally { uploads--; }
      }
      const match = /^\/api\/files\/([a-f0-9-]+)(\/download)?$/.exec(path);
      if (match) {
        const file = db.prepare('SELECT * FROM files WHERE id=?').get(match[1]);
        if (!file || !canRead(user.id,file)) throw fail(404,'الملف غير موجود أو ليس لديك إذن للاطلاع عليه.');
        if (match[2] && req.method === 'GET') {
          const location = join(storage,'files',file.id); const info = await stat(location);
          res.setHeader('Content-Type','application/octet-stream'); res.setHeader('Content-Length',info.size);
          res.setHeader('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);
          await pipeline(createReadStream(location),res); return;
        }
        if (file.owner_id !== user.id) throw fail(403,'الإذن الممنوح للاطلاع والتنزيل فقط.');
        if (!match[2] && req.method === 'PATCH') {
          const input = await body(req); session(req);
          const name = typeof input.name === 'string' ? input.name.trim() : file.name;
          if (!name || [...name].length>240 || /[\p{C}\/\\]/u.test(name) || ['.','..'].includes(name)) throw fail(400,'اسم الملف غير صحيح.');
          const folder = input.folderId || file.folder_id;
          if (typeof folder !== 'string' || !db.prepare('SELECT 1 FROM folders WHERE id=?').get(folder)) throw fail(400,'المجلد غير موجود.');
          db.prepare('UPDATE files SET name=?,folder_id=? WHERE id=?').run(name,folder,file.id); return json(res,200,{ok:true});
        }
        if (!match[2] && req.method === 'DELETE') {
          // Move to trash first so a failed disk operation never silently loses metadata.
          const trash = join(storage,'tmp',file.id+'-deleted');
          await rename(join(storage,'files',file.id),trash);
          try { db.prepare('DELETE FROM files WHERE id=?').run(file.id); }
          catch (e) { await rename(trash,join(storage,'files',file.id)); throw e; }
          await unlink(trash).catch(()=>{}); return json(res,200,{ok:true});
        }
      }
      throw fail(404,'الصفحة غير موجودة.');
    } catch (error) {
      if (!error.status && !['ERR_STREAM_PREMATURE_CLOSE','ECONNRESET'].includes(error.code)) console.error('Request failed:',error.code || error.name);
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (error.status===401) res.setHeader('Set-Cookie',cookie('',true));
      json(res,error.status || 500,{error:error.status?error.message:'تعذّر إكمال العملية. حاول مرة أخرى.'});
    }
  });
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 60000;
  return { server, db, createUser, storage, close: async () => { await new Promise(r=>server.close(r)); db.close(); } };
}

async function main() {
  const portal = await createPortal();
  if (process.argv[2] === 'setup') {
    if (portal.db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('Setup is already complete. Manage accounts from the administrator page.');
    let muted = false;
    const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk,encoding); callback(); } });
    const rl = createInterface({input:process.stdin,output,terminal:!!process.stdin.isTTY});
    try {
      const name = await rl.question('Administrator display name: ');
      const username = await rl.question('Administrator username: ');
      const passwordQuestion = rl.question('Password (4-20 characters, hidden): '); muted = true;
      const password = await passwordQuestion; muted = false; process.stdout.write('\n');
      const repeatQuestion = rl.question('Repeat password (hidden): '); muted = true;
      const repeat = await repeatQuestion; muted = false; process.stdout.write('\n');
      if (password !== repeat) throw new Error('Passwords do not match.');
      await portal.createUser({name,username,password,role:'admin'});
      console.log('Administrator created. Run npm start.');
    } finally { rl.close(); portal.db.close(); }
    return;
  }
  if (!portal.db.prepare('SELECT 1 FROM users LIMIT 1').get()) { portal.db.close(); throw new Error('Run npm run setup first to create the initial administrator.'); }
  const port = Number(process.env.PORT || 3000);
  portal.server.listen(port,process.env.HOST || '127.0.0.1',()=>console.log(`Portal ready: ${process.env.APP_ORIGIN || 'http://localhost:3000'}`));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{ portal.server.close(()=>{portal.db.close(); process.exit(0);}); setTimeout(()=>process.exit(1),10000).unref(); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
