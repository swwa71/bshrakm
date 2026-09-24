(() => {
  'use strict';

  const VERSION = '20260924-correspondence-v1';
  const TYPE_LABELS = { internal: 'داخلي', incoming: 'وارد', outgoing: 'صادر' };
  const STATUS_LABELS = { draft: 'مسودة', pending: 'بانتظار إجراء', returned: 'معادة للاستكمال', approved: 'معتمدة', sent: 'تم الإرسال', completed: 'مكتملة', archived: 'مؤرشفة' };
  const PRIORITY_LABELS = { normal: 'عادية', urgent: 'عاجلة', very_urgent: 'عاجلة جدًا' };
  const CONF_LABELS = { normal: 'عادية', confidential: 'سري', secret: 'سري جدًا' };
  const ACTION_LABELS = {
    created: 'إنشاء المراسلة', route_up: 'إحالة للمستوى الأعلى', approve_and_route: 'اعتماد وإحالة للأعلى',
    resubmit: 'استكمال وإعادة الرفع', return_down: 'إعادة للمرسل', approve_final: 'اعتماد نهائي',
    complete: 'إغلاق الإجراء', mark_sent: 'تأكيد الإرسال', archive: 'أرشفة', comment: 'ملاحظة',
    edited: 'تعديل بيانات المراسلة', attachment_added: 'إضافة مرفق'
  };

  const state = { me: null, orgMe: null, items: [], selected: null, box: 'inbox', loading: false };
  const q = (s, root = document) => root.querySelector(s);
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const fmtDate = value => value ? new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const fmtSize = bytes => { let n = Number(bytes) || 0, i = 0; const units = ['بايت','ك.ب','م.ب','ج.ب']; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${new Intl.NumberFormat('ar-SA',{maximumFractionDigits:1}).format(n)} ${units[i]}`; };
  const safeBase = () => {
    const raw = window.BushrakomServer?.baseUrl;
    if (!raw) throw new Error('رابط السيرفر غير معد في server-config.js');
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new Error('يجب استخدام رابط HTTPS للسيرفر.');
    return url.href.replace(/\/+$/, '');
  };

  function actorParams() {
    if (!state.me?.user) throw new Error('سجّل الدخول أولًا.');
    const u = state.me.user;
    return {
      actor_username: u.username,
      actor_role: u.role,
      actor_name: u.name,
      actor_job_title: u.jobTitle || ''
    };
  }

  async function server(path, options = {}) {
    const url = new URL(safeBase() + path);
    for (const [key, value] of Object.entries(actorParams())) url.searchParams.set(key, value ?? '');
    const init = { method: options.method || 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' };
    if (options.form) {
      init.body = options.form;
    } else if (options.data !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.data);
    }
    let response;
    try { response = await fetch(url, init); }
    catch (error) { throw new Error('تعذر الاتصال بخدمة المراسلات. تحقق من Tailscale Funnel ثم أعد المحاولة.'); }
    if (options.blob) {
      if (!response.ok) {
        let data = {}; try { data = await response.json(); } catch {}
        throw new Error(data.error || `تعذر تنزيل المرفق (${response.status}).`);
      }
      return response.blob();
    }
    let data = {}; try { data = await response.json(); } catch {}
    if (!response.ok || data.success === false) throw new Error(data.error || `تعذر إكمال العملية (${response.status}).`);
    return data;
  }

  function injectStyle() {
    if (q('link[data-correspondence-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = `correspondence.css?v=${VERSION}`; link.dataset.correspondenceStyle = '1';
    document.head.append(link);
  }

  function iconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6"/><path d="M8 3h8"/></svg>';
  }

  function injectUi() {
    if (q('#correspondence-view')) return;
    injectStyle();
    const nav = q('.sidebar nav');
    const button = document.createElement('button');
    button.className = 'nav-item correspondence-nav'; button.type = 'button'; button.dataset.view = 'correspondence';
    button.innerHTML = `${iconSvg()} المراسلات الإدارية`;
    const adminItem = nav?.querySelector('.admin-only');
    if (nav) nav.insertBefore(button, adminItem || null);

    const main = q('#main-content');
    const section = document.createElement('section');
    section.id = 'correspondence-view'; section.hidden = true;
    section.innerHTML = `
      <div class="page-heading correspondence-heading">
        <div><span class="eyebrow">مسار إداري موحّد</span><h1>المراسلات الإدارية</h1><p class="muted">إنشاء المراسلات وإحالتها وفق التسلسل الإداري، مع سجل إجراءات ومرفقات.</p></div>
        <div class="corr-heading-actions"><button id="corr-org-btn" class="quiet" type="button" hidden>التسلسل الإداري</button><button id="corr-new-btn" class="primary" type="button">+ مراسلة جديدة</button></div>
      </div>
      <div id="corr-alert" class="notice" hidden role="status"></div>
      <div id="corr-stats" class="corr-stat-grid" aria-label="ملخص المراسلات"></div>
      <section class="panel corr-workspace">
        <div class="corr-tabs" role="tablist" aria-label="صناديق المراسلات">
          <button type="button" data-box="inbox" class="active">الوارد لي</button>
          <button type="button" data-box="outbox">ما أنشأته</button>
          <button type="button" data-box="all">المتابعة</button>
          <button type="button" data-box="archive">الأرشيف</button>
        </div>
        <div class="corr-filters">
          <input id="corr-search" type="search" placeholder="بحث بالرقم أو الموضوع أو الجهة…">
          <select id="corr-type"><option value="">كل الأنواع</option><option value="internal">داخلي</option><option value="incoming">وارد</option><option value="outgoing">صادر</option></select>
          <select id="corr-status"><option value="">كل الحالات</option><option value="draft">مسودة</option><option value="pending">بانتظار إجراء</option><option value="returned">معادة للاستكمال</option><option value="approved">معتمدة</option><option value="sent">تم الإرسال</option><option value="completed">مكتملة</option><option value="archived">مؤرشفة</option></select>
          <button id="corr-refresh" class="quiet" type="button">تحديث</button>
        </div>
        <div class="table-wrap"><table class="corr-table"><thead><tr><th>الرقم</th><th>الموضوع</th><th>النوع</th><th>الحالة</th><th>المحال إليه</th><th>الأولوية</th><th>آخر تحديث</th><th></th></tr></thead><tbody id="corr-body"></tbody></table></div>
        <p id="corr-empty" class="empty-state" hidden>لا توجد مراسلات في هذا العرض.</p>
      </section>`;
    main?.append(section);

    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="corr-new-dialog" class="corr-dialog"><form id="corr-new-form">
        <div class="dialog-heading"><h2>مراسلة إدارية جديدة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <div class="corr-form-grid"><div><label for="corr-new-type">النوع</label><select id="corr-new-type"><option value="internal">داخلي</option><option value="incoming">وارد</option><option value="outgoing">صادر</option></select></div><div><label for="corr-new-priority">الأولوية</label><select id="corr-new-priority"><option value="normal">عادية</option><option value="urgent">عاجلة</option><option value="very_urgent">عاجلة جدًا</option></select></div><div><label for="corr-new-conf">السرية</label><select id="corr-new-conf"><option value="normal">عادية</option><option value="confidential">سري</option><option value="secret">سري جدًا</option></select></div><div><label for="corr-new-due">المهلة</label><input id="corr-new-due" type="date"></div></div>
        <label for="corr-new-subject">الموضوع</label><input id="corr-new-subject" maxlength="240" required>
        <label for="corr-new-party">الجهة الخارجية <span class="muted">(للوارد أو الصادر)</span></label><input id="corr-new-party" maxlength="240">
        <label for="corr-new-body">البيان / نص المراسلة</label><textarea id="corr-new-body" rows="6" maxlength="12000"></textarea>
        <label class="check-label corr-submit-up"><input id="corr-new-submit-up" type="checkbox" checked> إحالة مباشرة للمستوى الإداري الأعلى بعد الإنشاء</label>
        <p class="field-hint">المسار المعتمد: الموظف ← مدير الإدارة ← المدير التنفيذي/المدير العام ← رئيس المجلس.</p>
        <p id="corr-new-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary">إنشاء المراسلة</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-edit-dialog" class="corr-dialog"><form id="corr-edit-form">
        <div class="dialog-heading"><h2>تعديل المراسلة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <input id="corr-edit-id" type="hidden">
        <div class="corr-form-grid"><div><label for="corr-edit-priority">الأولوية</label><select id="corr-edit-priority"><option value="normal">عادية</option><option value="urgent">عاجلة</option><option value="very_urgent">عاجلة جدًا</option></select></div><div><label for="corr-edit-conf">السرية</label><select id="corr-edit-conf"><option value="normal">عادية</option><option value="confidential">سري</option><option value="secret">سري جدًا</option></select></div><div><label for="corr-edit-due">المهلة</label><input id="corr-edit-due" type="date"></div></div>
        <label for="corr-edit-subject">الموضوع</label><input id="corr-edit-subject" maxlength="240" required>
        <label for="corr-edit-party">الجهة الخارجية</label><input id="corr-edit-party" maxlength="240">
        <label for="corr-edit-body">البيان / نص المراسلة</label><textarea id="corr-edit-body" rows="6" maxlength="12000"></textarea>
        <p id="corr-edit-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary">حفظ التعديل</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-detail-dialog" class="corr-dialog corr-detail-dialog"><div class="dialog-heading"><div><h2 id="corr-detail-title">تفاصيل المراسلة</h2><p id="corr-detail-ref" class="muted"></p></div><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div><div id="corr-detail-content"></div><div class="dialog-actions"><button type="button" class="quiet corr-close">إغلاق</button></div></dialog>

      <dialog id="corr-org-dialog" class="corr-dialog corr-org-dialog"><div class="dialog-heading"><div><h2>التسلسل الإداري</h2><p class="muted">اضبط المستوى والمدير المباشر لكل مستخدم. الإحالة للأعلى تعتمد على هذا التسلسل فقط.</p></div><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div><div class="corr-org-toolbar"><button id="corr-sync-users" type="button" class="quiet">مزامنة مستخدمي البوابة</button><span class="muted">المستويات: 1 موظف · 2 مدير إدارة · 3 تنفيذي/عام · 4 رئيس المجلس</span></div><div class="table-wrap"><table><thead><tr><th>المستخدم</th><th>المسمى</th><th>المستوى</th><th>المدير المباشر</th><th></th></tr></thead><tbody id="corr-org-body"></tbody></table></div><p id="corr-org-error" class="error" role="alert"></p><div class="dialog-actions"><button type="button" class="quiet corr-close">إغلاق</button></div></dialog>`);
  }

  function alertMessage(message, error = false) {
    const box = q('#corr-alert'); if (!box) return;
    box.textContent = message; box.className = error ? 'notice error' : 'notice'; box.hidden = false;
  }

  function clearAlert() { const box = q('#corr-alert'); if (box) box.hidden = true; }

  function hideView() {
    const view = q('#correspondence-view'); if (view) view.hidden = true;
    q('.correspondence-nav')?.classList.remove('active');
    q('.correspondence-nav')?.removeAttribute('aria-current');
  }

  async function openView() {
    try {
      state.me = await api('/api/me');
    } catch (error) { return; }
    qa('#main-content > section').forEach(s => { s.hidden = s.id !== 'correspondence-view'; });
    qa('.nav-item').forEach(b => { const active = b.classList.contains('correspondence-nav'); b.classList.toggle('active', active); if (active) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
    q('#correspondence-view').hidden = false;
    q('#corr-org-btn').hidden = state.me.user.role !== 'admin';
    clearAlert();
    await loadAll();
    q('#main-content')?.focus({ preventScroll: true });
  }

  function renderStats(counts) {
    const wrap = q('#corr-stats'); wrap.replaceChildren();
    const cards = [
      ['الوارد لي', counts.inbox || 0, 'المراسلات المحالة لك الآن'],
      ['بانتظار إجراء', counts.pending || 0, 'تحتاج متابعة أو قرار'],
      ['ما أنشأته', counts.outbox || 0, 'مراسلات أنشأتها'],
      ['الأرشيف', counts.archived || 0, 'مراسلات مؤرشفة']
    ];
    for (const [title, value, hint] of cards) {
      const card = el('div', undefined, 'corr-stat-card'); card.append(el('span', title), el('strong', new Intl.NumberFormat('ar-SA').format(value)), el('small', hint)); wrap.append(card);
    }
  }

  function statusBadge(status) { const b = el('span', STATUS_LABELS[status] || status, `corr-badge status-${status}`); return b; }
  function priorityBadge(priority) { return el('span', PRIORITY_LABELS[priority] || priority, `corr-badge priority-${priority}`); }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    q('#corr-refresh').disabled = true;
    try {
      const bootstrap = await server('/api/correspondence/bootstrap');
      state.orgMe = bootstrap.me;
      renderStats(bootstrap.counts || {});
      await loadList();
      if (!state.orgMe?.manager_username && Number(state.orgMe?.level || 1) < 4) {
        alertMessage(state.me.user.role === 'admin' ? 'التسلسل الإداري يحتاج ضبط المدير المباشر للمستخدمين قبل استخدام الإحالة للأعلى.' : 'لم يُضبط المدير المباشر لحسابك بعد. تواصل مع مسؤول النظام.', true);
      }
    } catch (error) {
      alertMessage(error.message, true);
      q('#corr-body').replaceChildren(); q('#corr-empty').hidden = false;
    } finally { state.loading = false; q('#corr-refresh').disabled = false; }
  }

  async function loadList() {
    const params = new URLSearchParams({ box: state.box });
    const search = q('#corr-search').value.trim(); if (search) params.set('q', search);
    const type = q('#corr-type').value; if (type) params.set('type', type);
    const status = q('#corr-status').value; if (status) params.set('status', status);
    const data = await server(`/api/correspondence?${params}`);
    state.items = data.items || [];
    renderList();
  }

  function renderList() {
    const body = q('#corr-body'); body.replaceChildren();
    q('#corr-empty').hidden = state.items.length > 0;
    for (const item of state.items) {
      const row = document.createElement('tr');
      const ref = el('td'); const refStrong = el('strong', item.reference_no, 'corr-ref'); ref.append(refStrong);
      const subject = el('td'); subject.append(el('strong', item.subject)); if (item.external_party) subject.append(el('small', item.external_party, 'muted corr-line'));
      row.append(ref, subject, el('td', TYPE_LABELS[item.type] || item.type));
      const status = el('td'); status.append(statusBadge(item.status)); row.append(status);
      row.append(el('td', item.current_assignee_name || item.current_assignee));
      const priority = el('td'); priority.append(priorityBadge(item.priority)); row.append(priority);
      row.append(el('td', fmtDate(item.updated_at)));
      const actions = el('td'); const open = el('button', 'فتح', 'text-button'); open.type = 'button'; open.addEventListener('click', () => openDetail(item.id).catch(e => alertMessage(e.message,true))); actions.append(open); row.append(actions);
      body.append(row);
    }
  }

  async function createCorrespondence(event) {
    event.preventDefault();
    const button = event.submitter; button.disabled = true; q('#corr-new-error').textContent = '';
    try {
      const data = await server('/api/correspondence', { method: 'POST', data: {
        type: q('#corr-new-type').value,
        subject: q('#corr-new-subject').value,
        body: q('#corr-new-body').value,
        external_party: q('#corr-new-party').value,
        priority: q('#corr-new-priority').value,
        confidentiality: q('#corr-new-conf').value,
        due_at: q('#corr-new-due').value || null,
        submit_up: q('#corr-new-submit-up').checked
      }});
      q('#corr-new-dialog').close(); q('#corr-new-form').reset(); q('#corr-new-submit-up').checked = true;
      alertMessage(`تم إنشاء المراسلة ${data.correspondence.reference_no}.`);
      await loadAll(); await openDetail(data.correspondence.id);
    } catch (error) { q('#corr-new-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  function actionButton(label, actionName, cls = 'quiet') {
    const b = el('button', label, cls); b.type = 'button'; b.addEventListener('click', async () => {
      const note = actionName === 'comment' ? prompt('اكتب الملاحظة:') : prompt('ملاحظة الإجراء (اختياري):', '');
      if (note === null) return;
      b.disabled = true;
      try { await server(`/api/correspondence/${state.selected.id}/actions`, { method: 'POST', data: { action: actionName, note } }); await openDetail(state.selected.id); await loadAll(); }
      catch (error) { alert(error.message); }
      finally { b.disabled = false; }
    }); return b;
  }

  async function openDetail(id) {
    const data = await server(`/api/correspondence/${id}`);
    const item = data.correspondence; state.selected = item;
    q('#corr-detail-title').textContent = item.subject; q('#corr-detail-ref').textContent = item.reference_no;
    const root = q('#corr-detail-content'); root.replaceChildren();

    const meta = el('div', undefined, 'corr-meta-grid');
    const fields = [
      ['النوع', TYPE_LABELS[item.type]], ['الحالة', STATUS_LABELS[item.status]], ['الأولوية', PRIORITY_LABELS[item.priority]], ['السرية', CONF_LABELS[item.confidentiality]],
      ['المنشئ', item.creator_name], ['المحال إليه', item.current_assignee_name], ['الجهة الخارجية', item.external_party || '—'], ['المهلة', item.due_at ? fmtDate(item.due_at) : '—']
    ];
    for (const [k,v] of fields) { const box=el('div',undefined,'corr-meta'); box.append(el('span',k),el('strong',v||'—')); meta.append(box); }
    root.append(meta);
    const bodyCard = el('section',undefined,'corr-detail-card'); bodyCard.append(el('h3','البيان'),el('p',item.body||'لا يوجد بيان.','corr-body-text')); root.append(bodyCard);

    const attachCard = el('section',undefined,'corr-detail-card'); attachCard.append(el('h3','المرفقات'));
    const list = el('div',undefined,'corr-attachments');
    for (const a of item.attachments || []) {
      const line=el('div',undefined,'corr-attachment'); const info=el('div'); info.append(el('strong',a.original_name),el('small',`${fmtSize(a.size)} · ${fmtDate(a.created_at)}`,'muted corr-line'));
      const d=el('button','تنزيل','text-button'); d.type='button'; d.addEventListener('click',()=>downloadAttachment(a)); line.append(info,d); list.append(line);
    }
    if (!(item.attachments||[]).length) list.append(el('p','لا توجد مرفقات.','muted'));
    attachCard.append(list);
    if (item.permissions?.can_act || item.creator_username === state.me.user.username || state.me.user.role === 'admin') {
      const form=el('form',undefined,'corr-attachment-form'); const input=document.createElement('input'); input.type='file'; input.required=true; input.accept='.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.csv,.zip';
      const btn=el('button','إضافة مرفق','quiet'); btn.type='submit'; form.append(input,btn); form.addEventListener('submit',e=>uploadAttachment(e,input,btn)); attachCard.append(form);
    }
    root.append(attachCard);

    const actionCard = el('section',undefined,'corr-detail-card'); actionCard.append(el('h3','الإجراءات'));
    const buttons = el('div',undefined,'corr-action-buttons'); const p=item.permissions||{};
    if (p.can_edit) { const edit=el('button','تعديل البيانات','quiet'); edit.type='button'; edit.addEventListener('click',()=>openEdit(item)); buttons.append(edit); }
    if (p.can_act && item.status !== 'archived') {
      if (p.can_route_up) buttons.append(actionButton(item.status==='returned'?'استكمال وإعادة الرفع':'إحالة للأعلى', item.status==='returned'?'resubmit':'route_up','primary'));
      if (p.can_route_up && item.status==='pending') buttons.append(actionButton('اعتماد ورفع للأعلى','approve_and_route','primary'));
      if (p.can_return) buttons.append(actionButton('إعادة للمرسل','return_down','quiet'));
      if (p.can_final_approve && !['approved','sent','completed'].includes(item.status)) buttons.append(actionButton('اعتماد نهائي','approve_final','primary'));
      if (!['completed','archived','sent'].includes(item.status)) buttons.append(actionButton('إنهاء الإجراء','complete','quiet'));
      if (item.type==='outgoing' && item.status==='approved') buttons.append(actionButton('تأكيد الإرسال','mark_sent','primary'));
    }
    if (!p.can_act && item.type==='outgoing' && item.status==='approved' && (item.creator_username===state.me.user.username || state.me.user.role==='admin')) buttons.append(actionButton('تأكيد الإرسال','mark_sent','primary'));
    buttons.append(actionButton('إضافة ملاحظة','comment','quiet'));
    if (p.can_archive && ['approved','sent','completed'].includes(item.status)) buttons.append(actionButton('أرشفة','archive','quiet'));
    if (!buttons.children.length) buttons.append(el('p','لا توجد إجراءات متاحة في الحالة الحالية.','muted'));
    actionCard.append(buttons); root.append(actionCard);

    const timelineCard = el('section',undefined,'corr-detail-card'); timelineCard.append(el('h3','سجل المسار'));
    const timeline=el('div',undefined,'corr-timeline');
    for (const a of item.actions || []) {
      const entry=el('div',undefined,'corr-timeline-item'); const dot=el('span',undefined,'corr-timeline-dot'); const copy=el('div');
      const title = ACTION_LABELS[a.action] || a.action; copy.append(el('strong',title));
      const route = [a.from_name, a.to_name].filter(Boolean).join(' ← '); if (route) copy.append(el('span',route,'corr-line'));
      if (a.note) copy.append(el('p',a.note)); copy.append(el('small',`${a.actor_name || a.actor_username} · ${fmtDate(a.created_at)}`,'muted'));
      entry.append(dot,copy); timeline.append(entry);
    }
    timelineCard.append(timeline); root.append(timelineCard);
    q('#corr-detail-dialog').showModal();
  }

  function openEdit(item) {
    q('#corr-edit-id').value=item.id; q('#corr-edit-subject').value=item.subject||''; q('#corr-edit-party').value=item.external_party||''; q('#corr-edit-body').value=item.body||''; q('#corr-edit-priority').value=item.priority||'normal'; q('#corr-edit-conf').value=item.confidentiality||'normal'; q('#corr-edit-due').value=item.due_at ? String(item.due_at).slice(0,10) : ''; q('#corr-edit-error').textContent=''; q('#corr-edit-dialog').showModal();
  }

  async function saveEdit(event) {
    event.preventDefault(); const button=event.submitter; button.disabled=true; q('#corr-edit-error').textContent='';
    try {
      const id=q('#corr-edit-id').value; await server(`/api/correspondence/${id}`,{method:'PATCH',data:{subject:q('#corr-edit-subject').value,external_party:q('#corr-edit-party').value,body:q('#corr-edit-body').value,priority:q('#corr-edit-priority').value,confidentiality:q('#corr-edit-conf').value,due_at:q('#corr-edit-due').value||null}}); q('#corr-edit-dialog').close(); await openDetail(id); await loadAll();
    } catch(error){q('#corr-edit-error').textContent=error.message;} finally{button.disabled=false;}
  }

  async function uploadAttachment(event, input, button) {
    event.preventDefault(); if (!input.files[0]) return;
    button.disabled=true;
    try {
      const form=new FormData(); form.append('file',input.files[0]);
      await server(`/api/correspondence/${state.selected.id}/attachments`,{method:'POST',form});
      await openDetail(state.selected.id); await loadAll();
    } catch (error) { alert(error.message); }
    finally { button.disabled=false; }
  }

  async function downloadAttachment(a) {
    const blob=await server(`/api/correspondence/attachments/${a.id}`,{blob:true});
    const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=a.original_name; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
  }

  async function openOrg() {
    q('#corr-org-error').textContent=''; q('#corr-org-dialog').showModal(); await loadOrg();
  }

  async function syncUsers() {
    q('#corr-org-error').textContent='';
    try {
      const local = await api('/api/users');
      await server('/api/correspondence/org/sync',{method:'POST',data:{users:local.users}});
      await loadOrg();
    } catch(error){ q('#corr-org-error').textContent=error.message; }
  }

  async function loadOrg() {
    const data=await server('/api/correspondence/org'); renderOrg(data.people||[],data.levels||{});
  }

  function renderOrg(people, levels) {
    const body=q('#corr-org-body'); body.replaceChildren();
    for (const person of people) {
      const row=document.createElement('tr'); row.append(el('td',person.display_name),el('td',person.job_title||'—'));
      const levelCell=el('td'); const level=document.createElement('select'); level.className='corr-level-select';
      for(const [value,label] of Object.entries(levels)){const o=el('option',`${value} — ${label}`);o.value=value;level.append(o);} level.value=String(person.level); levelCell.append(level); row.append(levelCell);
      const managerCell=el('td'); const manager=document.createElement('select'); manager.append(Object.assign(document.createElement('option'),{value:'',textContent:'بدون مدير مباشر'})); managerCell.append(manager); row.append(managerCell);
      const fillManagers=()=>{const current=manager.value||person.manager_username||''; manager.replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'بدون مدير مباشر'})); const targetLevel=Number(level.value)+1; for(const p of people.filter(p=>p.active&&p.username!==person.username&&p.level===targetLevel)){const o=el('option',p.display_name);o.value=p.username;manager.append(o);} if([...manager.options].some(o=>o.value===current))manager.value=current; manager.disabled=Number(level.value)===4;}; fillManagers(); level.addEventListener('change',fillManagers);
      const actionCell=el('td'); const save=el('button','حفظ','text-button'); save.type='button'; save.addEventListener('click',async()=>{save.disabled=true;q('#corr-org-error').textContent='';try{await server(`/api/correspondence/org/${encodeURIComponent(person.username)}`,{method:'PATCH',data:{level:Number(level.value),manager_username:manager.value||null}});await loadOrg();await loadAll();}catch(error){q('#corr-org-error').textContent=error.message;}finally{save.disabled=false;}}); actionCell.append(save); row.append(actionCell); body.append(row);
    }
  }

  function bind() {
    q('.correspondence-nav')?.addEventListener('click',()=>openView().catch(e=>alertMessage(e.message,true)));
    document.addEventListener('click',event=>{const nav=event.target.closest?.('.nav-item'); if(nav&&!nav.classList.contains('correspondence-nav'))hideView();});
    q('#corr-new-btn').addEventListener('click',()=>{q('#corr-new-error').textContent='';q('#corr-new-dialog').showModal();});
    q('#corr-new-form').addEventListener('submit',createCorrespondence);
    q('#corr-edit-form').addEventListener('submit',saveEdit);
    q('#corr-org-btn').addEventListener('click',()=>openOrg().catch(e=>alertMessage(e.message,true)));
    q('#corr-sync-users').addEventListener('click',syncUsers);
    qa('.corr-close').forEach(b=>b.addEventListener('click',()=>b.closest('dialog')?.close()));
    qa('.corr-tabs button').forEach(b=>b.addEventListener('click',async()=>{state.box=b.dataset.box;qa('.corr-tabs button').forEach(x=>x.classList.toggle('active',x===b));await loadList();}));
    q('#corr-refresh').addEventListener('click',()=>loadAll());
    q('#corr-type').addEventListener('change',()=>loadList().catch(e=>alertMessage(e.message,true)));
    q('#corr-status').addEventListener('change',()=>loadList().catch(e=>alertMessage(e.message,true)));
    let timer; q('#corr-search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>loadList().catch(e=>alertMessage(e.message,true)),300);});
  }

  function start() {
    injectUi(); bind();
    window.CorrespondenceModule = { open: openView, refresh: loadAll, version: VERSION };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
