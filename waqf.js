(() => {
  'use strict';

  const STORAGE_KEY = 'bshrakm_waqf_properties_v1';
  const section = () => document.getElementById('waqf-view');
  const content = () => document.getElementById('waqf-content');
  const tabs = () => [...document.querySelectorAll('[data-waqf-tab]')];
  const fmt = new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 });
  const money = value => `${fmt.format(Number(value || 0))} ر.س`;
  const dateFmt = new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', year: 'numeric', month: 'short', day: 'numeric' });
  const todayISO = () => new Date().toISOString().slice(0, 10);
  let activeTab = 'dashboard';
  let searchText = '';

  const emptyState = () => ({
    version: 1,
    properties: [], units: [], tenants: [], contracts: [], collections: [], maintenance: [], expenses: [], documents: [], activities: []
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      const parsed = JSON.parse(raw);
      return Object.assign(emptyState(), parsed || {});
    } catch { return emptyState(); }
  }

  let state = load();

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function id() {
    return (globalThis.crypto?.randomUUID?.() || `wqf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function num(value) { return Number(value || 0) || 0; }
  function byId(list, value) { return list.find(item => item.id === value); }
  function propertyName(pid) { return byId(state.properties, pid)?.name || '—'; }
  function unitName(uid) { const u = byId(state.units, uid); return u ? `${u.unitNo || u.name || 'وحدة'} · ${propertyName(u.propertyId)}` : '—'; }
  function tenantName(tid) { return byId(state.tenants, tid)?.name || '—'; }
  function contractName(cid) { const c = byId(state.contracts, cid); return c ? `${c.contractNo || 'عقد'} · ${tenantName(c.tenantId)}` : '—'; }
  function filterText(...values) { return values.join(' ').toLowerCase().includes(searchText.trim().toLowerCase()); }

  function recordActivity(text) {
    state.activities.unshift({ id: id(), text, at: new Date().toISOString() });
    state.activities = state.activities.slice(0, 40);
  }

  function removeItem(collection, itemId, label) {
    if (!confirm(`حذف ${label}؟`)) return;
    state[collection] = state[collection].filter(x => x.id !== itemId);
    recordActivity(`تم حذف ${label}`); save(); render();
  }

  function badge(text, tone='') { return `<span class="waqf-badge ${tone}">${esc(text)}</span>`; }
  function empty(message='لا توجد بيانات حتى الآن.') { return `<div class="waqf-empty">${esc(message)}</div>`; }

  function stats() {
    const occupied = state.units.filter(u => u.status === 'مؤجرة').length;
    const vacant = state.units.filter(u => u.status === 'شاغرة').length;
    const activeContracts = state.contracts.filter(c => c.status === 'ساري');
    const expected = activeContracts.reduce((s,c) => s + num(c.annualRent), 0);
    const collected = state.collections.filter(c => c.status === 'مسدد').reduce((s,c) => s + num(c.amount), 0);
    const expenses = state.expenses.reduce((s,e) => s + num(e.amount), 0) + state.maintenance.reduce((s,m) => s + num(m.cost), 0);
    return { occupied, vacant, expected, collected, outstanding: Math.max(expected-collected,0), expenses, net: collected-expenses };
  }

  function alerts() {
    const out = [];
    const now = new Date(); now.setHours(0,0,0,0);
    const sixty = new Date(now); sixty.setDate(sixty.getDate()+60);
    state.contracts.filter(c => c.status === 'ساري' && c.endDate).forEach(c => {
      const d = new Date(`${c.endDate}T00:00:00`);
      if (d >= now && d <= sixty) out.push({title:`عقد يقترب من الانتهاء: ${c.contractNo || tenantName(c.tenantId)}`, meta:`ينتهي ${dateFmt.format(d)}`, tone:'warn'});
    });
    state.collections.filter(c => c.status !== 'مسدد' && c.dueDate).forEach(c => {
      const d = new Date(`${c.dueDate}T00:00:00`);
      if (d < now) out.push({title:`دفعة متأخرة: ${contractName(c.contractId)}`, meta:`${money(c.amount)} · استحقاق ${dateFmt.format(d)}`, tone:'danger'});
    });
    state.units.filter(u => u.status === 'شاغرة').slice(0,6).forEach(u => out.push({title:`وحدة شاغرة: ${unitName(u.id)}`, meta:`الإيجار السنوي المستهدف ${money(u.annualRent)}`, tone:'warn'}));
    state.maintenance.filter(m => m.status !== 'مغلق').slice(0,6).forEach(m => out.push({title:`صيانة مفتوحة: ${m.issueType || m.description}`, meta:propertyName(m.propertyId), tone:'warn'}));
    return out.slice(0,10);
  }

  function renderDashboard() {
    const s = stats();
    const alertRows = alerts();
    const recent = state.activities.slice(0,8);
    content().innerHTML = `
      <div class="waqf-dashboard-grid">
        <div class="waqf-stat"><strong>${fmt.format(state.properties.length)}</strong><span>إجمالي الأوقاف والأملاك</span></div>
        <div class="waqf-stat"><strong>${fmt.format(state.units.length)}</strong><span>إجمالي الوحدات</span></div>
        <div class="waqf-stat"><strong>${fmt.format(s.occupied)}</strong><span>وحدات مؤجرة</span></div>
        <div class="waqf-stat"><strong>${fmt.format(s.vacant)}</strong><span>وحدات شاغرة</span></div>
        <div class="waqf-stat"><strong>${money(s.expected)}</strong><span>الإيراد السنوي المتوقع</span></div>
        <div class="waqf-stat"><strong>${money(s.collected)}</strong><span>المحصل</span></div>
        <div class="waqf-stat"><strong>${money(s.outstanding)}</strong><span>المتبقي</span></div>
        <div class="waqf-stat"><strong>${money(s.net)}</strong><span>صافي التدفق المسجل</span></div>
      </div>
      <div class="waqf-quick">
        <button class="primary" data-waqf-action="add-property">+ إضافة أصل</button>
        <button class="quiet" data-waqf-action="add-contract">+ إضافة عقد</button>
        <button class="quiet" data-waqf-action="add-collection">+ تسجيل دفعة</button>
        <button class="quiet" data-waqf-action="add-maintenance">+ طلب صيانة</button>
      </div>
      <div class="waqf-grid-2">
        <section class="waqf-panel"><div class="waqf-panel-head"><h2>التنبيهات</h2>${badge(`${alertRows.length} تنبيه`,alertRows.length?'warn':'ok')}</div>
          <div class="waqf-list">${alertRows.length ? alertRows.map(a=>`<div class="waqf-list-item"><div><strong>${esc(a.title)}</strong><small>${esc(a.meta)}</small></div>${badge(a.tone==='danger'?'متأخر':'تنبيه',a.tone)}</div>`).join('') : empty('لا توجد تنبيهات حالياً.')}</div>
        </section>
        <section class="waqf-panel"><div class="waqf-panel-head"><h2>آخر العمليات</h2></div>
          <div class="waqf-list">${recent.length ? recent.map(a=>`<div class="waqf-list-item"><div><strong>${esc(a.text)}</strong><small>${esc(dateFmt.format(new Date(a.at)))} · ${new Date(a.at).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'})}</small></div></div>`).join('') : empty('لا توجد عمليات مسجلة بعد.')}</div>
        </section>
      </div>`;
  }

  function tableShell(title, buttonLabel, buttonAction, headers, rows, emptyMessage) {
    return `<section class="waqf-panel"><div class="waqf-panel-head waqf-toolbar"><div><h2>${esc(title)}</h2></div><div class="waqf-actions"><input id="waqf-search" type="search" placeholder="بحث…" value="${esc(searchText)}"><button class="primary" data-waqf-action="${esc(buttonAction)}">${esc(buttonLabel)}</button></div></div>
      <div class="waqf-table-wrap"><table class="waqf-table"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">${empty(emptyMessage)}</td></tr>`}</tbody></table></div></section>`;
  }

  function actions(editAction, idValue, deleteCollection, deleteLabel) {
    return `<div class="waqf-actions"><button class="quiet" data-waqf-action="${editAction}" data-id="${esc(idValue)}">تعديل</button><button class="text-button waqf-danger-link" data-waqf-delete="${deleteCollection}" data-id="${esc(idValue)}" data-label="${esc(deleteLabel)}">حذف</button></div>`;
  }

  function renderProperties() {
    const items = state.properties.filter(p=>filterText(p.name,p.assetCategory,p.propertyType,p.deedNo,p.address,p.status));
    const rows = items.map(p=>`<tr><td><strong>${esc(p.name)}</strong><br><small class="muted">${esc(p.code || '')}</small></td><td>${esc(p.assetCategory)}</td><td>${esc(p.propertyType)}</td><td>${esc(p.deedNo||'—')}</td><td>${esc(p.address||'—')}</td><td>${money(p.estimatedValue)}</td><td>${badge(p.status||'نشط',p.status==='نشط'?'ok':'')}</td><td>${actions('edit-property',p.id,'properties',`الأصل «${p.name}»`)}</td></tr>`).join('');
    content().innerHTML = tableShell('الأوقاف والأملاك','+ إضافة أصل','add-property',['الأصل','التصنيف','النوع','رقم الصك','الموقع','القيمة التقديرية','الحالة','الإجراءات'],rows,'لم تتم إضافة أي أصل بعد.');
  }

  function renderUnits() {
    const items = state.units.filter(u=>filterText(propertyName(u.propertyId),u.unitNo,u.type,u.floor,u.status));
    const rows = items.map(u=>`<tr><td>${esc(propertyName(u.propertyId))}</td><td><strong>${esc(u.unitNo||'—')}</strong></td><td>${esc(u.type||'—')}</td><td>${esc(u.floor||'—')}</td><td>${badge(u.status||'شاغرة',u.status==='مؤجرة'?'ok':u.status==='شاغرة'?'warn':'')}</td><td>${money(u.annualRent)}</td><td>${actions('edit-unit',u.id,'units',`الوحدة «${u.unitNo}»`)}</td></tr>`).join('');
    content().innerHTML = tableShell('الوحدات','+ إضافة وحدة','add-unit',['العقار','الوحدة','النوع','الدور','الحالة','الإيجار السنوي','الإجراءات'],rows,'لا توجد وحدات مسجلة.');
  }

  function renderTenants() {
    const items = state.tenants.filter(t=>filterText(t.name,t.type,t.phone,t.email,t.idNumber));
    const rows = items.map(t=>`<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.type||'—')}</td><td>${esc(t.idNumber||'—')}</td><td>${esc(t.phone||'—')}</td><td>${esc(t.email||'—')}</td><td>${actions('edit-tenant',t.id,'tenants',`المستأجر «${t.name}»`)}</td></tr>`).join('');
    content().innerHTML = tableShell('المستأجرون','+ إضافة مستأجر','add-tenant',['الاسم','النوع','الهوية/السجل','الجوال','البريد','الإجراءات'],rows,'لا يوجد مستأجرون مسجلون.');
  }

  function renderContracts() {
    const items = state.contracts.filter(c=>filterText(c.contractNo,propertyName(c.propertyId),unitName(c.unitId),tenantName(c.tenantId),c.status));
    const rows = items.map(c=>`<tr><td><strong>${esc(c.contractNo||'—')}</strong></td><td>${esc(propertyName(c.propertyId))}</td><td>${esc(unitName(c.unitId))}</td><td>${esc(tenantName(c.tenantId))}</td><td>${esc(c.startDate||'—')} → ${esc(c.endDate||'—')}</td><td>${money(c.annualRent)}</td><td>${badge(c.status||'ساري',c.status==='ساري'?'ok':c.status==='منتهي'?'danger':'')}</td><td>${actions('edit-contract',c.id,'contracts',`العقد «${c.contractNo||''}»`)}</td></tr>`).join('');
    content().innerHTML = tableShell('العقود','+ إضافة عقد','add-contract',['رقم العقد','العقار','الوحدة','المستأجر','المدة','القيمة السنوية','الحالة','الإجراءات'],rows,'لا توجد عقود مسجلة.');
  }

  function renderCollections() {
    const items = state.collections.filter(c=>filterText(contractName(c.contractId),c.status,c.reference,c.dueDate,c.paidDate));
    const rows = items.map(c=>`<tr><td>${esc(contractName(c.contractId))}</td><td>${money(c.amount)}</td><td>${esc(c.dueDate||'—')}</td><td>${esc(c.paidDate||'—')}</td><td>${badge(c.status||'مستحق',c.status==='مسدد'?'ok':c.status==='متأخر'?'danger':'warn')}</td><td>${esc(c.reference||'—')}</td><td>${actions('edit-collection',c.id,'collections','الدفعة')}</td></tr>`).join('');
    content().innerHTML = tableShell('التحصيل','+ تسجيل دفعة','add-collection',['العقد','المبلغ','الاستحقاق','السداد','الحالة','المرجع','الإجراءات'],rows,'لا توجد دفعات مسجلة.');
  }

  function renderMaintenance() {
    const items = state.maintenance.filter(m=>filterText(propertyName(m.propertyId),unitName(m.unitId),m.issueType,m.description,m.responsible,m.status));
    const rows = items.map(m=>`<tr><td>${esc(propertyName(m.propertyId))}</td><td>${m.unitId?esc(unitName(m.unitId)):'—'}</td><td><strong>${esc(m.issueType||'صيانة')}</strong><br><small class="muted">${esc(m.description||'')}</small></td><td>${esc(m.responsible||'—')}</td><td>${money(m.cost)}</td><td>${badge(m.status||'مفتوح',m.status==='مغلق'?'ok':'warn')}</td><td>${actions('edit-maintenance',m.id,'maintenance','طلب الصيانة')}</td></tr>`).join('');
    content().innerHTML = tableShell('الصيانة','+ طلب صيانة','add-maintenance',['العقار','الوحدة','الطلب','المسؤول','التكلفة','الحالة','الإجراءات'],rows,'لا توجد طلبات صيانة.');
  }

  function renderExpenses() {
    const items = state.expenses.filter(e=>filterText(propertyName(e.propertyId),e.category,e.reference,e.note,e.date));
    const rows = items.map(e=>`<tr><td>${esc(propertyName(e.propertyId))}</td><td>${esc(e.category||'—')}</td><td>${money(e.amount)}</td><td>${esc(e.date||'—')}</td><td>${esc(e.reference||'—')}</td><td>${esc(e.note||'—')}</td><td>${actions('edit-expense',e.id,'expenses','المصروف')}</td></tr>`).join('');
    content().innerHTML = tableShell('المصروفات','+ إضافة مصروف','add-expense',['العقار','التصنيف','المبلغ','التاريخ','المرجع','البيان','الإجراءات'],rows,'لا توجد مصروفات مسجلة.');
  }

  function renderDocuments() {
    const items = state.documents.filter(d=>filterText(propertyName(d.propertyId),d.category,d.title,d.docNo,d.fileName,d.expiryDate));
    const rows = items.map(d=>`<tr><td>${d.propertyId?esc(propertyName(d.propertyId)):'عام'}</td><td>${esc(d.category||'—')}</td><td><strong>${esc(d.title)}</strong><br><small class="muted">${esc(d.fileName||'بدون ملف مرفق')}</small></td><td>${esc(d.docNo||'—')}</td><td>${esc(d.expiryDate||'—')}</td><td>${actions('edit-document',d.id,'documents',`المستند «${d.title}»`)}</td></tr>`).join('');
    content().innerHTML = tableShell('المستندات','+ إضافة مستند','add-document',['العقار','التصنيف','المستند','الرقم','تاريخ الانتهاء','الإجراءات'],rows,'لا توجد مستندات مسجلة.');
  }

  function renderReports() {
    const rows = state.properties.map(p => {
      const units = state.units.filter(u=>u.propertyId===p.id);
      const occupied = units.filter(u=>u.status==='مؤجرة').length;
      const contracts = state.contracts.filter(c=>c.propertyId===p.id&&c.status==='ساري');
      const expected = contracts.reduce((s,c)=>s+num(c.annualRent),0);
      const contractIds = new Set(contracts.map(c=>c.id));
      const collected = state.collections.filter(c=>contractIds.has(c.contractId)&&c.status==='مسدد').reduce((s,c)=>s+num(c.amount),0);
      const expense = state.expenses.filter(e=>e.propertyId===p.id).reduce((s,e)=>s+num(e.amount),0) + state.maintenance.filter(m=>m.propertyId===p.id).reduce((s,m)=>s+num(m.cost),0);
      const net = collected-expense;
      const yieldPct = num(p.estimatedValue)>0 ? (expected/num(p.estimatedValue))*100 : 0;
      return `<tr><td><strong>${esc(p.name)}</strong></td><td>${fmt.format(units.length)}</td><td>${fmt.format(occupied)}</td><td>${money(expected)}</td><td>${money(collected)}</td><td>${money(expense)}</td><td class="waqf-report-value">${money(net)}</td><td>${fmt.format(yieldPct)}٪</td></tr>`;
    }).join('');
    content().innerHTML = `<section class="waqf-panel"><div class="waqf-panel-head"><div><h2>التقارير</h2><p class="muted">ملخص مالي وتشغيلي حسب كل أصل.</p></div></div><div class="waqf-table-wrap"><table class="waqf-table"><thead><tr><th>الأصل</th><th>الوحدات</th><th>المؤجرة</th><th>الإيراد المتوقع</th><th>المحصل</th><th>المصروف</th><th>الصافي</th><th>العائد على القيمة</th></tr></thead><tbody>${rows||`<tr><td colspan="8">${empty('أضف أصلًا لعرض التقرير.')}</td></tr>`}</tbody></table></div></section>`;
  }

  const renderers = { dashboard:renderDashboard, properties:renderProperties, units:renderUnits, contracts:renderContracts, tenants:renderTenants, collections:renderCollections, maintenance:renderMaintenance, expenses:renderExpenses, documents:renderDocuments, reports:renderReports };

  function render() {
    if (!section() || section().hidden) return;
    tabs().forEach(b => b.classList.toggle('active', b.dataset.waqfTab === activeTab));
    (renderers[activeTab] || renderDashboard)();
  }

  function setTab(tab) { activeTab = tab; searchText=''; render(); }

  function options(list, getLabel, selected='', includeBlank=true, blankLabel='اختر') {
    return `${includeBlank?`<option value="">${esc(blankLabel)}</option>`:''}${list.map(x=>`<option value="${esc(x.id)}" ${x.id===selected?'selected':''}>${esc(getLabel(x))}</option>`).join('')}`;
  }

  function dialog(title, fields, onSubmit) {
    document.getElementById('waqf-dialog')?.remove();
    const d = document.createElement('dialog'); d.id='waqf-dialog'; d.className='waqf-dialog';
    d.innerHTML = `<form class="waqf-form"><div class="dialog-heading"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-close aria-label="إغلاق">×</button></div>${fields}<p class="error" data-error role="alert"></p><div class="dialog-actions"><button class="primary" type="submit">حفظ</button><button class="quiet" type="button" data-close>إلغاء</button></div></form>`;
    document.body.append(d);
    d.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>d.close()));
    d.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();try{await onSubmit(new FormData(e.currentTarget),d);d.close();d.remove();save();render();}catch(err){d.querySelector('[data-error]').textContent=err.message||String(err);}});
    d.addEventListener('close',()=>{ if(d.isConnected) d.remove(); },{once:true}); d.showModal();
  }

  function field(label,name,value='',opts={}) {
    const req=opts.required?'required':''; const type=opts.type||'text';
    if(opts.select) return `<label>${esc(label)}${opts.required?' <span class="required">*</span>':''}</label><select name="${esc(name)}" ${req}>${opts.select}</select>`;
    if(opts.textarea) return `<label>${esc(label)}</label><textarea name="${esc(name)}" ${req}>${esc(value)}</textarea>`;
    return `<label>${esc(label)}${opts.required?' <span class="required">*</span>':''}</label><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${req} ${opts.min!=null?`min="${esc(opts.min)}"`:''} ${opts.step?`step="${esc(opts.step)}"`:''}>`;
  }

  const grid = (...parts) => `<div class="waqf-form-grid">${parts.join('')}</div>`;
  function value(fd,key){return String(fd.get(key)||'').trim();}
  function requireValue(fd,key,label){const v=value(fd,key);if(!v)throw new Error(`أدخل ${label}.`);return v;}
  function upsert(collection,item,label){const i=state[collection].findIndex(x=>x.id===item.id);if(i>=0)state[collection][i]=item;else state[collection].push(item);recordActivity(`${i>=0?'تم تحديث':'تمت إضافة'} ${label}`);}

  function openProperty(item={}) {
    dialog(item.id?'تعديل الأصل':'إضافة أصل',
      field('اسم الأصل','name',item.name,{required:true})+
      grid(field('رمز الأصل','code',item.code),field('التصنيف','assetCategory',item.assetCategory||'وقف',{select:`<option>وقف</option><option>ملك للجمعية</option><option>استثمار</option>`}))+
      grid(field('نوع العقار','propertyType',item.propertyType||'عمارة',{select:`<option>عمارة</option><option>أرض</option><option>شقة</option><option>محل</option><option>مكتب</option><option>مجمع</option><option>أخرى</option>`}),field('الحالة','status',item.status||'نشط',{select:`<option>نشط</option><option>قيد التطوير</option><option>متوقف</option>`}))+
      grid(field('رقم الصك','deedNo',item.deedNo),field('المساحة م²','area',item.area,{type:'number',min:0,step:'0.01'}))+
      field('العنوان / الموقع','address',item.address)+
      grid(field('القيمة التقديرية','estimatedValue',item.estimatedValue,{type:'number',min:0,step:'0.01'}),field('عدد الأدوار','floors',item.floors,{type:'number',min:0,step:'1'}))+
      field('ملاحظات','notes',item.notes,{textarea:true}),
      fd=>{const obj={...item,id:item.id||id(),name:requireValue(fd,'name','اسم الأصل'),code:value(fd,'code'),assetCategory:value(fd,'assetCategory'),propertyType:value(fd,'propertyType'),status:value(fd,'status'),deedNo:value(fd,'deedNo'),area:num(fd.get('area')),address:value(fd,'address'),estimatedValue:num(fd.get('estimatedValue')),floors:num(fd.get('floors')),notes:value(fd,'notes')};upsert('properties',obj,`الأصل «${obj.name}»`);}
    );
  }

  function openUnit(item={}) {
    if(!state.properties.length) return alert('أضف أصلًا أولًا.');
    dialog(item.id?'تعديل الوحدة':'إضافة وحدة',
      field('العقار','propertyId',item.propertyId,{select:options(state.properties,p=>p.name,item.propertyId,true,'اختر العقار'),required:true})+
      grid(field('رقم / اسم الوحدة','unitNo',item.unitNo,{required:true}),field('نوع الوحدة','type',item.type||'شقة',{select:`<option>شقة</option><option>محل</option><option>مكتب</option><option>مستودع</option><option>أرض</option><option>أخرى</option>`}))+
      grid(field('الدور','floor',item.floor),field('الحالة','status',item.status||'شاغرة',{select:`<option>شاغرة</option><option>مؤجرة</option><option>صيانة</option><option>موقوفة</option>`}))+
      field('الإيجار السنوي المستهدف','annualRent',item.annualRent,{type:'number',min:0,step:'0.01'}),
      fd=>{const obj={...item,id:item.id||id(),propertyId:requireValue(fd,'propertyId','العقار'),unitNo:requireValue(fd,'unitNo','رقم الوحدة'),type:value(fd,'type'),floor:value(fd,'floor'),status:value(fd,'status'),annualRent:num(fd.get('annualRent'))};upsert('units',obj,`الوحدة «${obj.unitNo}»`);}
    );
  }

  function openTenant(item={}) {
    dialog(item.id?'تعديل المستأجر':'إضافة مستأجر',field('اسم المستأجر','name',item.name,{required:true})+grid(field('النوع','type',item.type||'فرد',{select:`<option>فرد</option><option>منشأة</option>`}),field('الهوية / السجل التجاري','idNumber',item.idNumber))+grid(field('رقم الجوال','phone',item.phone,{type:'tel'}),field('البريد الإلكتروني','email',item.email,{type:'email'}))+field('ملاحظات','notes',item.notes,{textarea:true}),fd=>{const obj={...item,id:item.id||id(),name:requireValue(fd,'name','اسم المستأجر'),type:value(fd,'type'),idNumber:value(fd,'idNumber'),phone:value(fd,'phone'),email:value(fd,'email'),notes:value(fd,'notes')};upsert('tenants',obj,`المستأجر «${obj.name}»`);});
  }

  function openContract(item={}) {
    if(!state.properties.length||!state.units.length||!state.tenants.length)return alert('أضف العقار والوحدة والمستأجر أولًا.');
    dialog(item.id?'تعديل العقد':'إضافة عقد',grid(field('رقم العقد','contractNo',item.contractNo,{required:true}),field('الحالة','status',item.status||'ساري',{select:`<option>ساري</option><option>قيد التجهيز</option><option>منتهي</option><option>ملغي</option>`}))+field('العقار','propertyId',item.propertyId,{select:options(state.properties,p=>p.name,item.propertyId,true,'اختر العقار'),required:true})+field('الوحدة','unitId',item.unitId,{select:options(state.units,u=>unitName(u.id),item.unitId,true,'اختر الوحدة'),required:true})+field('المستأجر','tenantId',item.tenantId,{select:options(state.tenants,t=>t.name,item.tenantId,true,'اختر المستأجر'),required:true})+grid(field('بداية العقد','startDate',item.startDate,{type:'date',required:true}),field('نهاية العقد','endDate',item.endDate,{type:'date',required:true}))+grid(field('القيمة السنوية','annualRent',item.annualRent,{type:'number',min:0,step:'0.01',required:true}),field('عدد الدفعات','paymentCount',item.paymentCount||1,{type:'number',min:1,step:'1'})),fd=>{const obj={...item,id:item.id||id(),contractNo:requireValue(fd,'contractNo','رقم العقد'),status:value(fd,'status'),propertyId:requireValue(fd,'propertyId','العقار'),unitId:requireValue(fd,'unitId','الوحدة'),tenantId:requireValue(fd,'tenantId','المستأجر'),startDate:requireValue(fd,'startDate','بداية العقد'),endDate:requireValue(fd,'endDate','نهاية العقد'),annualRent:num(fd.get('annualRent')),paymentCount:num(fd.get('paymentCount'))||1};upsert('contracts',obj,`العقد «${obj.contractNo}»`);const u=byId(state.units,obj.unitId);if(u&&obj.status==='ساري')u.status='مؤجرة';});
  }

  function openCollection(item={}) {
    if(!state.contracts.length)return alert('أضف عقدًا أولًا.');
    dialog(item.id?'تعديل الدفعة':'تسجيل دفعة',field('العقد','contractId',item.contractId,{select:options(state.contracts,c=>contractName(c.id),item.contractId,true,'اختر العقد'),required:true})+grid(field('المبلغ','amount',item.amount,{type:'number',min:0,step:'0.01',required:true}),field('الحالة','status',item.status||'مسدد',{select:`<option>مسدد</option><option>مستحق</option><option>متأخر</option>`}))+grid(field('تاريخ الاستحقاق','dueDate',item.dueDate,{type:'date'}),field('تاريخ السداد','paidDate',item.paidDate||todayISO(),{type:'date'}))+field('رقم السند / المرجع','reference',item.reference),fd=>{const obj={...item,id:item.id||id(),contractId:requireValue(fd,'contractId','العقد'),amount:num(fd.get('amount')),status:value(fd,'status'),dueDate:value(fd,'dueDate'),paidDate:value(fd,'paidDate'),reference:value(fd,'reference')};upsert('collections',obj,'دفعة تحصيل');});
  }

  function openMaintenance(item={}) {
    if(!state.properties.length)return alert('أضف أصلًا أولًا.');
    dialog(item.id?'تعديل طلب الصيانة':'طلب صيانة',field('العقار','propertyId',item.propertyId,{select:options(state.properties,p=>p.name,item.propertyId,true,'اختر العقار'),required:true})+field('الوحدة (اختياري)','unitId',item.unitId,{select:options(state.units,u=>unitName(u.id),item.unitId,true,'بدون وحدة محددة')})+grid(field('نوع المشكلة','issueType',item.issueType||'صيانة عامة',{required:true}),field('الحالة','status',item.status||'مفتوح',{select:`<option>مفتوح</option><option>قيد التنفيذ</option><option>مغلق</option>`}))+field('الوصف','description',item.description,{textarea:true})+grid(field('المسؤول / المورد','responsible',item.responsible),field('التكلفة','cost',item.cost,{type:'number',min:0,step:'0.01'}))+field('تاريخ البلاغ','openedDate',item.openedDate||todayISO(),{type:'date'}),fd=>{const obj={...item,id:item.id||id(),propertyId:requireValue(fd,'propertyId','العقار'),unitId:value(fd,'unitId'),issueType:requireValue(fd,'issueType','نوع المشكلة'),status:value(fd,'status'),description:value(fd,'description'),responsible:value(fd,'responsible'),cost:num(fd.get('cost')),openedDate:value(fd,'openedDate')};upsert('maintenance',obj,'طلب صيانة');});
  }

  function openExpense(item={}) {
    if(!state.properties.length)return alert('أضف أصلًا أولًا.');
    dialog(item.id?'تعديل المصروف':'إضافة مصروف',field('العقار','propertyId',item.propertyId,{select:options(state.properties,p=>p.name,item.propertyId,true,'اختر العقار'),required:true})+grid(field('التصنيف','category',item.category||'صيانة',{select:`<option>صيانة</option><option>كهرباء</option><option>مياه</option><option>تأمين</option><option>رسوم خدمات</option><option>أخرى</option>`}),field('المبلغ','amount',item.amount,{type:'number',min:0,step:'0.01',required:true}))+grid(field('التاريخ','date',item.date||todayISO(),{type:'date',required:true}),field('المرجع','reference',item.reference))+field('البيان','note',item.note,{textarea:true}),fd=>{const obj={...item,id:item.id||id(),propertyId:requireValue(fd,'propertyId','العقار'),category:value(fd,'category'),amount:num(fd.get('amount')),date:requireValue(fd,'date','التاريخ'),reference:value(fd,'reference'),note:value(fd,'note')};upsert('expenses',obj,'مصروف');});
  }

  function openDocument(item={}) {
    dialog(item.id?'تعديل المستند':'إضافة مستند',field('العقار (اختياري)','propertyId',item.propertyId,{select:options(state.properties,p=>p.name,item.propertyId,true,'مستند عام')})+grid(field('التصنيف','category',item.category||'صك',{select:`<option>صك</option><option>عقد</option><option>رخصة</option><option>فاتورة</option><option>تقرير</option><option>صورة</option><option>أخرى</option>`}),field('رقم المستند','docNo',item.docNo))+field('اسم / وصف المستند','title',item.title,{required:true})+grid(field('تاريخ الانتهاء','expiryDate',item.expiryDate,{type:'date'}),`<div><label>ملف مرجعي</label><input name="file" type="file"><p class="field-hint">للتجربة على GitHub يحفظ اسم الملف فقط، وليس محتواه.</p></div>`),fd=>{const file=fd.get('file');const obj={...item,id:item.id||id(),propertyId:value(fd,'propertyId'),category:value(fd,'category'),docNo:value(fd,'docNo'),title:requireValue(fd,'title','اسم المستند'),expiryDate:value(fd,'expiryDate'),fileName:file&&file.name?file.name:(item.fileName||''),fileSize:file&&file.size?file.size:(item.fileSize||0)};upsert('documents',obj,`المستند «${obj.title}»`);});
  }

  const editors = {
    'add-property':()=>openProperty(), 'edit-property':item=>openProperty(item),
    'add-unit':()=>openUnit(), 'edit-unit':item=>openUnit(item),
    'add-tenant':()=>openTenant(), 'edit-tenant':item=>openTenant(item),
    'add-contract':()=>openContract(), 'edit-contract':item=>openContract(item),
    'add-collection':()=>openCollection(), 'edit-collection':item=>openCollection(item),
    'add-maintenance':()=>openMaintenance(), 'edit-maintenance':item=>openMaintenance(item),
    'add-expense':()=>openExpense(), 'edit-expense':item=>openExpense(item),
    'add-document':()=>openDocument(), 'edit-document':item=>openDocument(item)
  };
  const actionCollection = action => ({property:'properties',unit:'units',tenant:'tenants',contract:'contracts',collection:'collections',maintenance:'maintenance',expense:'expenses',document:'documents'})[action.replace(/^edit-/,'')];

  function handleAction(button) {
    const action=button.dataset.waqfAction; if(!action)return;
    const editor=editors[action]; if(!editor)return;
    if(action.startsWith('edit-')) { const collection=actionCollection(action); const item=state[collection]?.find(x=>x.id===button.dataset.id); if(item)editor(item); }
    else editor();
  }

  function init() {
    const view=section(); if(!view)return;
    tabs().forEach(btn=>btn.addEventListener('click',()=>setTab(btn.dataset.waqfTab)));
    view.addEventListener('click',event=>{
      const action=event.target.closest('[data-waqf-action]'); if(action){handleAction(action);return;}
      const del=event.target.closest('[data-waqf-delete]'); if(del){removeItem(del.dataset.waqfDelete,del.dataset.id,del.dataset.label||'العنصر');}
    });
    view.addEventListener('input',event=>{if(event.target.id==='waqf-search'){searchText=event.target.value;render();requestAnimationFrame(()=>{const s=document.getElementById('waqf-search');if(s){s.focus();s.setSelectionRange(s.value.length,s.value.length);}});}});
  }

  window.WaqfModule = { render, setTab };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
