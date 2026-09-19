import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createPortal, IDLE_MS, MAX_FILE_SIZE } from '../server.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bushrakom-test-'));
  let now = Date.now();
  const app = await createPortal({ dataDir: dir, now: () => now });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const request = async (path, { method='GET', cookie='', data, raw, headers={} }={}) => {
    const response = await fetch(base+path,{method,headers:{Origin:'http://localhost:3000',Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},body:data===undefined?raw:JSON.stringify(data)});
    const content = await response.text(); let body; try{body=JSON.parse(content);}catch{body=content;}
    return {status:response.status,body,headers:response.headers};
  };
  const admin = await app.createUser({name:'المسؤول',username:'admin',password:'1234',role:'admin'});
  const employee = await app.createUser({name:'موظف',username:'12345',password:'abcd',role:'user'});
  const other = await app.createUser({name:'موظف آخر',username:'أحمد',password:'    ',role:'user'});
  const login = async (username,password) => { const r=await request('/api/login',{method:'POST',data:{username,password}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);return r.headers.get('set-cookie').split(';')[0]; };
  const adminCookie=await login('admin','1234'),employeeCookie=await login('12345','abcd'),otherCookie=await login('أحمد','    ');
  const folder=app.db.prepare('SELECT id FROM folders LIMIT 1').get().id;
  const upload=async(cookie=employeeCookie,folderId=folder,raw='file contents')=>request(`/api/files?folderId=${folderId}`,{method:'POST',cookie,raw,headers:{'X-File-Name':encodeURIComponent('ملف.txt'),'Content-Type':'application/octet-stream'}});
  return {app,dir,base,request,login,admin,employee,other,adminCookie,employeeCookie,otherCookie,folder,upload,advance:delta=>now+=delta};
}

test('letters-only, digits-only and mixed usernames; passwords are 4–20 Unicode characters of any type',async t=>{
  const f=await fixture(t);
  for(const [username,password] of [['letters','abcd'],['987654','1234'],['a123','x'.repeat(20)],['رمز123','🔑🔑🔑🔑']]){const r=await f.request('/api/users',{method:'POST',cookie:f.adminCookie,data:{username,password,name:username,role:'user'}});assert.equal(r.status,201);await f.login(username,password);}
  for(const password of ['abc','x'.repeat(21)])assert.equal((await f.request('/api/users',{method:'POST',cookie:f.adminCookie,data:{username:'invalid',password,name:'غير صالح',role:'user'}})).status,400);
});
test('authentication, anti-CSRF and administrator-only access are enforced on the server',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/files')).status,401);
  for(const path of ['/api/users','/api/settings','/api/folders'])assert.equal((await f.request(path,{method:'POST',cookie:f.employeeCookie,data:{}})).status,path==='/api/settings'?404:403);
  assert.equal((await f.request('/api/settings',{method:'PATCH',cookie:f.employeeCookie,data:{sharingEnabled:false}})).status,403);
  assert.equal((await f.request('/api/users',{method:'POST',cookie:f.adminCookie,headers:{Origin:'https://untrusted.example'},data:{}})).status,403);
  const r=await f.request('/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await f.request('/data/portal.sqlite',{cookie:f.adminCookie})).status,404);
});
test('folder selection is mandatory and uploaded bytes are stored outside public assets',async t=>{
  const f=await fixture(t);
  assert.equal((await f.upload(f.employeeCookie,'')).status,400);
  assert.equal((await f.upload(f.employeeCookie,'missing')).status,400);
  const r=await f.upload();assert.equal(r.status,201);
  const rows=(await f.request('/api/files',{cookie:f.employeeCookie})).body.files;
  assert.equal(rows.length,1);assert.equal(rows[0].folder_id,f.folder);assert.equal(rows[0].name,'ملف.txt');
  const download=await f.request(`/api/files/${r.body.id}/download`,{cookie:f.employeeCookie});
  assert.equal(download.body,'file contents');assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.equal((await readdir(join(f.dir,'files'))).length,1);assert.equal((await readdir(join(f.dir,'tmp'))).length,0);
});
test('1 GiB limit rejects oversized Content-Length before reading the body',async t=>{
  const f=await fixture(t);assert.equal(MAX_FILE_SIZE,1073741824);
  const status=await new Promise((resolve,reject)=>{const req=http.request(`${f.base}/api/files?folderId=${f.folder}`,{method:'POST',headers:{Origin:'http://localhost:3000',Cookie:f.employeeCookie,'Content-Length':MAX_FILE_SIZE+1,'X-File-Name':'huge.bin'}},res=>{res.resume();res.on('end',()=>{resolve(res.statusCode);req.destroy();});});req.on('error',reject);req.flushHeaders();});
  assert.equal(status,413);assert.equal((await readdir(join(f.dir,'files'))).length,0);
});
test('private files require explicit sharing, including for administrators; shared access is read only',async t=>{
  const f=await fixture(t);const id=(await f.upload()).body.id;
  for(const cookie of [f.otherCookie,f.adminCookie])assert.equal((await f.request(`/api/files/${id}/download`,{cookie})).status,404);
  assert.equal((await f.request('/api/shares',{method:'POST',cookie:f.employeeCookie,data:{viewerId:f.other.id}})).status,200);
  assert.equal((await f.request(`/api/files/${id}/download`,{cookie:f.otherCookie})).status,200);
  assert.equal((await f.request(`/api/files/${id}`,{method:'PATCH',cookie:f.otherCookie,data:{name:'hijacked'}})).status,403);
  assert.equal((await f.request(`/api/files/${id}`,{method:'DELETE',cookie:f.otherCookie})).status,403);
  await f.request(`/api/shares/${f.other.id}`,{method:'DELETE',cookie:f.employeeCookie});
  assert.equal((await f.request(`/api/files/${id}/download`,{cookie:f.otherCookie})).status,404);
});
test('global sharing toggle immediately gates existing grants and new grants',async t=>{
  const f=await fixture(t);const id=(await f.upload()).body.id;
  await f.request('/api/shares',{method:'POST',cookie:f.employeeCookie,data:{viewerId:f.other.id}});
  await f.request('/api/settings',{method:'PATCH',cookie:f.adminCookie,data:{sharingEnabled:false}});
  assert.equal((await f.request('/api/files',{cookie:f.otherCookie})).body.files.length,0);
  assert.equal((await f.request(`/api/files/${id}/download`,{cookie:f.otherCookie})).status,404);
  assert.equal((await f.request('/api/shares',{method:'POST',cookie:f.employeeCookie,data:{viewerId:f.admin.id}})).status,403);
  assert.equal((await f.request(`/api/files/${id}/download`,{cookie:f.employeeCookie})).status,200);
  await f.request('/api/settings',{method:'PATCH',cookie:f.adminCookie,data:{sharingEnabled:true}});
  assert.equal((await f.request(`/api/files/${id}/download`,{cookie:f.otherCookie})).status,200);
});
test('owners can rename, move and delete files; folder management requires administrator rights',async t=>{
  const f=await fixture(t);const id=(await f.upload()).body.id;
  const folder=(await f.request('/api/folders',{method:'POST',cookie:f.adminCookie,data:{name:'المراسلات'}})).body.id;
  assert.ok(folder);
  assert.equal((await f.request(`/api/files/${id}`,{method:'PATCH',cookie:f.employeeCookie,data:{name:'مراسلة.txt',folderId:folder}})).status,200);
  const rows=(await f.request('/api/files',{cookie:f.employeeCookie})).body.files;assert.equal(rows[0].folder_id,folder);assert.equal(rows[0].name,'مراسلة.txt');
  assert.equal((await f.request(`/api/files/${id}`,{method:'PATCH',cookie:f.employeeCookie,data:{name:'../escape'}})).status,400);
  assert.equal((await f.request(`/api/files/${id}`,{method:'DELETE',cookie:f.employeeCookie})).status,200);
  assert.equal((await f.request('/api/files',{cookie:f.employeeCookie})).body.files.length,0);assert.deepEqual(await readdir(join(f.dir,'files')),[]);
});
test('accounts cannot be deleted, last administrator is protected, other users can be promoted',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(`/api/users/${f.employee.id}`,{method:'DELETE',cookie:f.adminCookie})).status,404);
  assert.equal((await f.request(`/api/users/${f.admin.id}`,{method:'PATCH',cookie:f.adminCookie,data:{...f.admin,role:'user'}})).status,409);
  assert.equal((await f.request(`/api/users/${f.employee.id}`,{method:'PATCH',cookie:f.adminCookie,data:{...f.employee,role:'admin'}})).status,200);
  assert.equal((await f.request('/api/me',{cookie:f.employeeCookie})).status,401);
  const promoted=await f.login('12345','abcd');assert.equal((await f.request('/api/users',{cookie:promoted})).status,200);
});
test('password updates invalidate existing sessions and preserve files',async t=>{
  const f=await fixture(t);await f.upload();
  assert.equal((await f.request(`/api/users/${f.employee.id}`,{method:'PATCH',cookie:f.adminCookie,data:{...f.employee,password:'5678'}})).status,200);
  assert.equal((await f.request('/api/files',{cookie:f.employeeCookie})).status,401);
  assert.equal((await f.request('/api/login',{method:'POST',data:{username:'12345',password:'abcd'}})).status,401);
  const cookie=await f.login('12345','5678');assert.equal((await f.request('/api/files',{cookie})).body.files.length,1);
});
test('server expires sessions at 15 idle minutes; reads do not renew sessions and activity does',async t=>{
  const f=await fixture(t);f.advance(IDLE_MS-1);
  assert.equal((await f.request('/api/me',{cookie:f.employeeCookie})).status,200);
  assert.equal((await f.request('/api/activity',{method:'POST',cookie:f.otherCookie})).status,200);
  f.advance(1);assert.equal((await f.request('/api/files',{cookie:f.employeeCookie})).status,401);
  assert.equal((await f.request('/api/me',{cookie:f.otherCookie})).status,200);
  f.advance(IDLE_MS);assert.equal((await f.request('/api/activity',{method:'POST',cookie:f.otherCookie})).status,401);
});
test('interrupted uploads leave no published file or temporary file',async t=>{
  const f=await fixture(t);
  await new Promise(resolve=>{const req=http.request(`${f.base}/api/files?folderId=${f.folder}`,{method:'POST',headers:{Origin:'http://localhost:3000',Cookie:f.employeeCookie,'Content-Length':100000,'X-File-Name':'partial.bin'}});req.on('error',()=>{});req.write('partial');setTimeout(()=>{req.destroy();resolve();},50);});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n,0);assert.deepEqual(await readdir(join(f.dir,'tmp')),[]);
});
test('repeated incorrect passwords are rate limited',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.request('/api/login',{method:'POST',data:{username:'unknown',password:'bad!'}})).status,401);
  assert.equal((await f.request('/api/login',{method:'POST',data:{username:'unknown',password:'bad!'}})).status,429);
});

test('accounts, folders and file contents survive a server restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bushrakom-restart-'));
  let app=await createPortal({dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  await app.createUser({name:'موظف',username:'persistent',password:'1234',role:'admin'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  let base=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({username:'persistent',password:'1234'})});
  await login.text();const cookie=login.headers.get('set-cookie').split(';')[0];
  const folder=app.db.prepare('SELECT id FROM folders LIMIT 1').get().id;
  const upload=await fetch(base+`/api/files?folderId=${folder}`,{method:'POST',headers:{Origin:'http://localhost:3000',Cookie:cookie,'X-File-Name':'retained.txt'},body:'Retained after restart'});
  const file=await upload.json();assert.equal(upload.status,201);
  await app.close();app=await createPortal({dataDir:dir});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  const download=await fetch(base+`/api/files/${file.id}/download`,{headers:{Cookie:cookie}});
  assert.equal(download.status,200);assert.equal(await download.text(),'Retained after restart');
  assert.equal(app.db.prepare('SELECT folder_id FROM files WHERE id=?').get(file.id).folder_id,folder);
});
