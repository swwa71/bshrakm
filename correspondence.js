(() => {
  'use strict';

  const VERSION = '20260925-correspondence-v3';
  const TYPE_LABELS = { internal: 'داخلي', incoming: 'وارد', outgoing: 'صادر' };
  const STATUS_LABELS = { draft: 'مسودة', pending: 'بانتظار إجراء', returned: 'معادة للاستكمال', approved: 'معتمدة', sent: 'مصدّرة', completed: 'مكتملة', archived: 'مؤرشفة' };
  const PRIORITY_LABELS = { normal: 'عادية', urgent: 'عاجلة', very_urgent: 'عاجلة جدًا' };
  const CONF_LABELS = { normal: 'عادية', confidential: 'سري', secret: 'سري جدًا' };
  const ACTION_LABELS = {
    created: 'إنشاء المعاملة', route_up: 'إحالة للأعلى', approve_and_route: 'اعتماد وإحالة للأعلى',
    resubmit: 'استكمال وإعادة الرفع', return_down: 'إعادة للمرسل', approve_final: 'اعتماد نهائي',
    complete: 'إغلاق الإجراء', mark_sent: 'تأكيد الإرسال', archive: 'أرشفة', comment: 'ملاحظة',
    edited: 'تعديل بيانات المعاملة', attachment_added: 'إضافة مرفق', exported: 'تصدير المعاملة'
  };

  const state = { me: null, orgMe: null, items: [], selected: null, box: 'inbox', loading: false };
  const q = (s, root = document) => root.querySelector(s);
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const fmtDate = value => value ? new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', dateStyle: 'medium', timeStyle: String(value).length > 10 ? 'short' : undefined }).format(new Date(String(value).length === 10 ? `${value}T12:00:00` : value)) : '—';
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
    return { actor_username: u.username, actor_role: u.role, actor_name: u.name, actor_job_title: u.jobTitle || '' };
  }

  async function server(path, options = {}) {
    const url = new URL(safeBase() + path);
    for (const [key, value] of Object.entries(actorParams())) url.searchParams.set(key, value ?? '');
    const init = { method: options.method || 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store' };
    if (options.form) init.body = options.form;
    else if (options.data !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(options.data); }
    let response;
    try { response = await fetch(url, init); }
    catch { throw new Error('تعذر الاتصال بخدمة المراسلات. تحقق من Tailscale Funnel ثم أعد المحاولة.'); }
    if (options.blob) {
      if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(data.error || `تعذر تنزيل المرفق (${response.status}).`); }
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
      <div id="corr-alert" class="notice" hidden role="status"></div>
      <div id="corr-stats" class="corr-stat-grid" aria-label="ملخص المراسلات"></div>
      <section class="panel corr-workspace">
        <div class="corr-tabs" role="tablist" aria-label="صناديق المراسلات">
          <button type="button" data-box="inbox" class="active">صندوق الوارد</button>
          <button type="button" data-box="outbox">صندوق الصادر</button>
          <button type="button" id="corr-export-tab" class="corr-export-action">تصدير معاملة</button>
        </div>
        <div class="corr-filters">
          <input id="corr-search" type="search" placeholder="بحث بالرقم أو الموضوع أو الجهة…">
          <select id="corr-status"><option value="">كل الحالات</option><option value="draft">مسودة</option><option value="pending">بانتظار إجراء</option><option value="returned">معادة للاستكمال</option><option value="approved">معتمدة</option><option value="sent">مصدّرة</option><option value="completed">مكتملة</option><option value="archived">مؤرشفة</option></select>
          <label class="check-label corr-archive-toggle"><input id="corr-include-archived" type="checkbox"> إظهار المؤرشف</label>
          <button id="corr-new-btn" class="quiet" type="button">+ تسجيل وارد</button>
          <button id="corr-org-btn" class="quiet" type="button" hidden>إعداد الإحالة</button>
          <button id="corr-refresh" class="quiet" type="button">تحديث</button>
        </div>
        <div class="table-wrap"><table class="corr-table"><thead><tr><th>الرقم</th><th>الموضوع</th><th>الجهة</th><th>الحالة</th><th>المحال إليه</th><th>التاريخ</th><th>آخر تحديث</th><th></th></tr></thead><tbody id="corr-body"></tbody></table></div>
        <p id="corr-empty" class="empty-state" hidden>لا توجد معاملات في هذا الصندوق.</p>
      </section>`;
    main?.append(section);

    document.body.insertAdjacentHTML('beforeend', `
      <dialog id="corr-new-dialog" class="corr-dialog"><form id="corr-new-form">
        <div class="dialog-heading"><h2>تسجيل معاملة واردة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <div class="corr-form-grid"><div><label for="corr-new-priority">الأولوية</label><select id="corr-new-priority"><option value="normal">عادية</option><option value="urgent">عاجلة</option><option value="very_urgent">عاجلة جدًا</option></select></div><div><label for="corr-new-conf">السرية</label><select id="corr-new-conf"><option value="normal">عادية</option><option value="confidential">سري</option><option value="secret">سري جدًا</option></select></div></div>
        <label for="corr-new-subject">الموضوع</label><input id="corr-new-subject" maxlength="240" required>
        <label for="corr-new-party">الجهة الواردة منها</label><input id="corr-new-party" maxlength="240">
        <label for="corr-new-body">البيان / نص المعاملة</label><textarea id="corr-new-body" rows="6" maxlength="12000"></textarea>
        <label class="check-label corr-submit-up"><input id="corr-new-submit-up" type="checkbox"> إحالة مباشرة للمدير بعد التسجيل</label>
        <p id="corr-new-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary">تسجيل الوارد</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-export-dialog" class="corr-dialog"><form id="corr-export-form">
        <div class="dialog-heading"><h2>تصدير معاملة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <section id="corr-export-step-one" class="corr-export-step">
          <label for="corr-export-source">المعاملة المراد تصديرها</label><select id="corr-export-source" required></select>
          <label for="corr-export-party">المصدّر إليه</label><input id="corr-export-party" maxlength="240" required>
          <label for="corr-export-description">وصف الصادر</label><textarea id="corr-export-description" rows="5" maxlength="12000" required></textarea>
          <p class="muted">بعد اعتماد البيانات يصدر النظام رقم الصادر دون إرسال المعاملة.</p>
          <div class="dialog-actions"><button id="corr-export-prepare" type="button" class="primary">إصدار رقم الصادر</button><button type="button" class="quiet corr-close">إلغاء</button></div>
        </section>
        <section id="corr-export-step-two" class="corr-export-step" hidden>
          <div class="corr-dispatch-card"><span>رقم الصادر</span><strong id="corr-export-generated-no">—</strong></div>
          <div class="corr-export-attachments">
            <label for="corr-export-file">إضافة مرفق</label>
            <div class="corr-export-file-row"><input id="corr-export-file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.csv,.zip"><button id="corr-export-upload" type="button" class="quiet">إضافة المرفق</button></div>
            <div id="corr-export-attachment-list" class="corr-attachments"></div>
          </div>
          <label for="corr-export-destination">بعد الإرسال</label><select id="corr-export-destination"><option value="outbox">صندوق الصادر</option><option value="archive">تصدير إلى الأرشيف</option></select>
          <p class="muted">يُسجل تاريخ الإرسال تلقائيًا عند الضغط على إرسال.</p>
          <p id="corr-export-error" class="error" role="alert"></p>
          <div class="dialog-actions"><button id="corr-export-send" type="button" class="primary">إرسال</button><button id="corr-export-cancel" type="button" class="quiet">إلغاء</button></div>
        </section>
        <p id="corr-export-step-error" class="error" role="alert"></p>
      </form></dialog>

      <dialog id="corr-edit-dialog" class="corr-dialog"><form id="corr-edit-form">
        <div class="dialog-heading"><h2>تعديل المعاملة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <input id="corr-edit-id" type="hidden">
        <div class="corr-form-grid"><div><label for="corr-edit-priority">الأولوية</label><select id="corr-edit-priority"><option value="normal">عادية</option><option value="urgent">عاجلة</option><option value="very_urgent">عاجلة جدًا</option></select></div><div><label for="corr-edit-conf">السرية</label><select id="corr-edit-conf"><option value="normal">عادية</option><option value="confidential">سري</option><option value="secret">سري جدًا</option></select></div></div>
        <label for="corr-edit-subject">الموضوع</label><input id="corr-edit-subject" maxlength="240" required>
        <label for="corr-edit-party">الجهة الخارجية</label><input id="corr-edit-party" maxlength="240">
        <label for="corr-edit-body">البيان / نص المعاملة</label><textarea id="corr-edit-body" rows="6" maxlength="12000"></textarea>
        <p id="corr-edit-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary">حفظ التعديل</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-detail-dialog" class="corr-dialog corr-detail-dialog"><div class="dialog-heading"><div><h2 id="corr-detail-title">تفاصيل المعاملة</h2><p id="corr-detail-ref" class="muted"></p></div><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div><div id="corr-detail-content"></div><div class="dialog-actions"><button type="button" class="quiet corr-close">إغلاق</button></div></dialog>

      <dialog id="corr-org-dialog" class="corr-dialog corr-org-dialog"><div class="dialog-heading"><div><h2>إعداد مسار الإحالة</h2><p class="muted">اربط كل مستخدم بمديره المباشر ليعمل الرفع والإعادة تلقائيًا.</p></div><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div><div class="corr-org-toolbar"><button id="corr-sync-users" type="button" class="quiet">مزامنة مستخدمي البوابة</button></div><div class="table-wrap"><table><thead><tr><th>المستخدم</th><th>المسمى</th><th>المستوى</th><th>المدير المباشر</th><th></th></tr></thead><tbody id="corr-org-body"></tbody></table></div><p id="corr-org-error" class="error" role="alert"></p><div class="dialog-actions"><button type="button" class="quiet corr-close">إغلاق</button></div></dialog>`);
  }

  function alertMessage(message, error = false) { const box = q('#corr-alert'); if (!box) return; box.textContent = message; box.className = error ? 'notice error' : 'notice'; box.hidden = false; }
  function clearAlert() { const box = q('#corr-alert'); if (box) box.hidden = true; }
  function hideView() { const view = q('#correspondence-view'); if (view) view.hidden = true; q('.correspondence-nav')?.classList.remove('active'); q('.correspondence-nav')?.removeAttribute('aria-current'); }

  async function openView() {
    try { state.me = await api('/api/me'); } catch { return; }
    qa('#main-content > section').forEach(s => { s.hidden = s.id !== 'correspondence-view'; });
    qa('.nav-item').forEach(b => { const active = b.classList.contains('correspondence-nav'); b.classList.toggle('active', active); if (active) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
    q('#correspondence-view').hidden = false;
    q('#corr-org-btn').hidden = state.me.user.role !== 'admin';
    clearAlert(); await loadAll(); q('#main-content')?.focus({ preventScroll: true });
  }

  function renderStats(counts) {
    const wrap = q('#corr-stats'); wrap.replaceChildren();
    const cards = [
      ['صندوق الوارد', counts.inbox || 0, 'المعاملات الواردة المتاحة لك'],
      ['صندوق الصادر', counts.outbox || 0, 'المعاملات التي تم تصديرها']
    ];
    for (const [title, value, hint] of cards) { const card = el('div', undefined, 'corr-stat-card'); card.append(el('span', title), el('strong', new Intl.NumberFormat('ar-SA').format(value)), el('small', hint)); wrap.append(card); }
  }

  function statusBadge(status) { return el('span', STATUS_LABELS[status] || status, `corr-badge status-${status}`); }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true; q('#corr-refresh').disabled = true;
    try {
      const bootstrap = await server('/api/correspondence/bootstrap');
      state.orgMe = bootstrap.me; renderStats(bootstrap.counts || {}); await loadList();
      if (!state.orgMe?.manager_username && Number(state.orgMe?.level || 1) < 4) {
        alertMessage(state.me.user.role === 'admin' ? 'أكمل ربط المدير المباشر للمستخدمين حتى تعمل الإحالة للأعلى.' : 'لم يُضبط المدير المباشر لحسابك بعد. تواصل مع مسؤول النظام.', true);
      }
    } catch (error) { alertMessage(error.message, true); q('#corr-body').replaceChildren(); q('#corr-empty').hidden = false; }
    finally { state.loading = false; q('#corr-refresh').disabled = false; }
  }

  async function loadList() {
    const params = new URLSearchParams({ box: state.box });
    const search = q('#corr-search').value.trim(); if (search) params.set('q', search);
    const status = q('#corr-status').value; if (status) params.set('status', status);
    if (q('#corr-include-archived').checked) params.set('include_archived', '1');
    const data = await server(`/api/correspondence?${params}`); state.items = data.items || []; renderList();
  }

  function renderList() {
    const body = q('#corr-body'); body.replaceChildren(); q('#corr-empty').hidden = state.items.length > 0;
    for (const item of state.items) {
      const row = document.createElement('tr');
      const number = item.type === 'outgoing' ? (item.dispatch_no || item.reference_no) : item.reference_no;
      const ref = el('td'); ref.append(el('strong', number, 'corr-ref'));
      const subject = el('td'); subject.append(el('strong', item.subject));
      const party = el('td', item.external_party || '—');
      const status = el('td'); status.append(statusBadge(item.status));
      const assignee = el('td', item.current_assignee_name || item.current_assignee);
      const date = el('td', fmtDate(item.type === 'outgoing' ? item.sent_at : item.created_at));
      const updated = el('td', fmtDate(item.updated_at));
      const actions = el('td'); const open = el('button', 'فتح', 'text-button'); open.type = 'button'; open.addEventListener('click', () => openDetail(item.id).catch(e => alertMessage(e.message,true))); actions.append(open);
      row.append(ref, subject, party, status, assignee, date, updated, actions); body.append(row);
    }
  }

  async function createCorrespondence(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true; q('#corr-new-error').textContent = '';
    try {
      const data = await server('/api/correspondence', { method: 'POST', data: {
        type: 'incoming', subject: q('#corr-new-subject').value, body: q('#corr-new-body').value,
        external_party: q('#corr-new-party').value, priority: q('#corr-new-priority').value,
        confidentiality: q('#corr-new-conf').value, submit_up: q('#corr-new-submit-up').checked
      }});
      q('#corr-new-dialog').close(); q('#corr-new-form').reset(); alertMessage(`تم تسجيل الوارد ${data.correspondence.reference_no}.`); await loadAll(); await openDetail(data.correspondence.id);
    } catch (error) { q('#corr-new-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  function resetExportDialog() {
    state.exportDraftId = null;
    q('#corr-export-step-one').hidden = false;
    q('#corr-export-step-two').hidden = true;
    q('#corr-export-generated-no').textContent = '—';
    q('#corr-export-party').disabled = false;
    q('#corr-export-description').disabled = false;
    q('#corr-export-source').disabled = false;
    q('#corr-export-file').value = '';
    q('#corr-export-attachment-list').replaceChildren();
    q('#corr-export-step-error').textContent = '';
    q('#corr-export-error').textContent = '';
    q('#corr-export-destination').value = 'outbox';
  }

  async function openExport(preselectedId = '') {
    resetExportDialog();
    const select = q('#corr-export-source'); select.replaceChildren();
    const data = await server('/api/correspondence/exportable');
    const items = data.items || [];
    if (!items.length) {
      const option = el('option', 'لا توجد معاملات معتمدة جاهزة للتصدير'); option.value = ''; select.append(option); select.disabled = true;
    } else {
      select.disabled = false;
      for (const item of items) { const option = el('option', `${item.reference_no} — ${item.subject}`); option.value = item.id; select.append(option); }
      if (preselectedId && items.some(x => x.id === preselectedId)) select.value = preselectedId;
    }
    q('#corr-export-party').value = '';
    q('#corr-export-description').value = '';
    q('#corr-export-dialog').showModal();
  }

  function renderExportAttachments(attachments = []) {
    const list = q('#corr-export-attachment-list'); list.replaceChildren();
    if (!attachments.length) { list.append(el('p','لا توجد مرفقات مضافة.','muted')); return; }
    for (const attachment of attachments) {
      const row = el('div', undefined, 'corr-attachment');
      const info = el('div'); info.append(el('strong', attachment.original_name), el('small', fmtSize(attachment.size), 'muted corr-line'));
      row.append(info); list.append(row);
    }
  }

  async function prepareExport() {
    const button = q('#corr-export-prepare'); button.disabled = true; q('#corr-export-step-error').textContent = '';
    try {
      const sourceId = q('#corr-export-source').value;
      const externalParty = q('#corr-export-party').value.trim();
      const description = q('#corr-export-description').value.trim();
      if (!sourceId) throw new Error('اختر المعاملة المراد تصديرها.');
      if (!externalParty) throw new Error('حدد المصدّر إليه.');
      if (!description) throw new Error('اكتب وصف الصادر.');
      const data = await server(`/api/correspondence/${sourceId}/export/prepare`, { method: 'POST', data: { external_party: externalParty, description } });
      state.exportDraftId = data.correspondence.id;
      q('#corr-export-generated-no').textContent = data.correspondence.dispatch_no;
      q('#corr-export-source').disabled = true; q('#corr-export-party').disabled = true; q('#corr-export-description').disabled = true;
      q('#corr-export-step-one').hidden = true; q('#corr-export-step-two').hidden = false;
      renderExportAttachments(data.correspondence.attachments || []);
    } catch (error) { q('#corr-export-step-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function uploadExportAttachment() {
    const button = q('#corr-export-upload'); const input = q('#corr-export-file');
    if (!state.exportDraftId) return;
    if (!input.files[0]) { q('#corr-export-error').textContent = 'اختر ملفًا لإضافته.'; return; }
    button.disabled = true; q('#corr-export-error').textContent = '';
    try {
      const form = new FormData(); form.append('file', input.files[0]);
      await server(`/api/correspondence/${state.exportDraftId}/attachments`, { method:'POST', form });
      const detail = await server(`/api/correspondence/${state.exportDraftId}`);
      renderExportAttachments(detail.correspondence.attachments || []); input.value = '';
    } catch (error) { q('#corr-export-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function sendExport() {
    const button = q('#corr-export-send'); button.disabled = true; q('#corr-export-error').textContent = '';
    try {
      if (!state.exportDraftId) throw new Error('لم يتم إصدار رقم الصادر بعد.');
      const data = await server(`/api/correspondence/${state.exportDraftId}/send`, { method:'POST', data:{ destination:q('#corr-export-destination').value } });
      q('#corr-export-dialog').close(); state.exportDraftId = null; state.box = 'outbox';
      qa('.corr-tabs [data-box]').forEach(b => b.classList.toggle('active', b.dataset.box === 'outbox'));
      alertMessage(`تم إرسال المعاملة برقم ${data.correspondence.dispatch_no}.`); await loadAll();
      if (data.correspondence.status !== 'archived') await openDetail(data.correspondence.id);
    } catch (error) { q('#corr-export-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function cancelExportDraft() {
    const draftId = state.exportDraftId;
    if (draftId) {
      try { await server(`/api/correspondence/${draftId}/export-draft`, { method:'DELETE' }); }
      catch (error) { q('#corr-export-error').textContent = error.message; return; }
    }
    state.exportDraftId = null; q('#corr-export-dialog').close();
  }

  function actionButton(label, actionName, cls = 'quiet') {
    const b = el('button', label, cls); b.type = 'button'; b.addEventListener('click', async () => {
      const note = actionName === 'comment' ? prompt('اكتب الملاحظة:') : prompt('ملاحظة الإجراء (اختياري):', ''); if (note === null) return;
      b.disabled = true;
      try { await server(`/api/correspondence/${state.selected.id}/actions`, { method: 'POST', data: { action: actionName, note } }); await openDetail(state.selected.id); await loadAll(); }
      catch (error) { alert(error.message); } finally { b.disabled = false; }
    }); return b;
  }

  async function openDetail(id) {
    const data = await server(`/api/correspondence/${id}`); const item = data.correspondence; state.selected = item;
    q('#corr-detail-title').textContent = item.subject;
    q('#corr-detail-ref').textContent = item.type === 'outgoing' && item.dispatch_no ? `رقم الصادر: ${item.dispatch_no}` : item.reference_no;
    const root = q('#corr-detail-content'); root.replaceChildren();

    const meta = el('div', undefined, 'corr-meta-grid');
    const fields = [
      ['النوع', TYPE_LABELS[item.type]], ['الحالة', STATUS_LABELS[item.status]], ['الأولوية', PRIORITY_LABELS[item.priority]], ['السرية', CONF_LABELS[item.confidentiality]],
      ['المنشئ', item.creator_name], ['المحال إليه', item.current_assignee_name], ['الجهة الخارجية', item.external_party || '—']
    ];
    if (item.type === 'outgoing') { fields.push(['رقم الصادر', item.dispatch_no || '—'], ['تاريخ الإرسال', item.sent_at ? fmtDate(item.sent_at) : '—']); }
    for (const [k,v] of fields) { const box=el('div',undefined,'corr-meta'); box.append(el('span',k),el('strong',v||'—')); meta.append(box); }
    root.append(meta);
    const bodyCard = el('section',undefined,'corr-detail-card'); bodyCard.append(el('h3','البيان'),el('p',item.body||'لا يوجد بيان.','corr-body-text')); root.append(bodyCard);

    const attachCard = el('section',undefined,'corr-detail-card'); attachCard.append(el('h3','المرفقات')); const list = el('div',undefined,'corr-attachments');
    for (const a of item.attachments || []) { const line=el('div',undefined,'corr-attachment'); const info=el('div'); info.append(el('strong',a.original_name),el('small',`${fmtSize(a.size)} · ${fmtDate(a.created_at)}`,'muted corr-line')); const d=el('button','تنزيل','text-button'); d.type='button'; d.addEventListener('click',()=>downloadAttachment(a)); line.append(info,d); list.append(line); }
    if (!(item.attachments||[]).length) list.append(el('p','لا توجد مرفقات.','muted')); attachCard.append(list);
    if (item.permissions?.can_act || item.creator_username === state.me.user.username || state.me.user.role === 'admin') {
      const form=el('form',undefined,'corr-attachment-form'); const input=document.createElement('input'); input.type='file'; input.required=true; input.accept='.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.csv,.zip'; const btn=el('button','إضافة مرفق','quiet'); btn.type='submit'; form.append(input,btn); form.addEventListener('submit',e=>uploadAttachment(e,input,btn)); attachCard.append(form);
    }
    root.append(attachCard);

    const actionCard = el('section',undefined,'corr-detail-card'); actionCard.append(el('h3','الإجراءات')); const buttons = el('div',undefined,'corr-action-buttons'); const p=item.permissions||{};
    if (p.can_edit) { const edit=el('button','تعديل البيانات','quiet'); edit.type='button'; edit.addEventListener('click',()=>openEdit(item)); buttons.append(edit); }
    if (p.can_act && item.status !== 'archived' && item.type !== 'outgoing') {
      if (p.can_route_up) buttons.append(actionButton(item.status==='returned'?'استكمال وإعادة الرفع':'إحالة للأعلى', item.status==='returned'?'resubmit':'route_up','primary'));
      if (p.can_route_up && item.status==='pending') buttons.append(actionButton('اعتماد ورفع للأعلى','approve_and_route','primary'));
      if (p.can_return) buttons.append(actionButton('إعادة للمرسل','return_down','quiet'));
      if (p.can_final_approve && !['approved','completed'].includes(item.status)) buttons.append(actionButton('اعتماد نهائي','approve_final','primary'));
      if (!['completed','approved'].includes(item.status)) buttons.append(actionButton('إنهاء الإجراء','complete','quiet'));
    }
    if (p.can_export) { const exportBtn=el('button','تصدير المعاملة','primary'); exportBtn.type='button'; exportBtn.addEventListener('click',()=>{q('#corr-detail-dialog').close();openExport(item.id).catch(e=>alertMessage(e.message,true));}); buttons.append(exportBtn); }
    buttons.append(actionButton('إضافة ملاحظة','comment','quiet'));
    actionCard.append(buttons); root.append(actionCard);

    const timelineCard = el('section',undefined,'corr-detail-card'); timelineCard.append(el('h3','سجل الإجراءات')); const timeline=el('div',undefined,'corr-timeline');
    for (const a of item.actions || []) { const entry=el('div',undefined,'corr-timeline-item'); const dot=el('span',undefined,'corr-timeline-dot'); const copy=el('div'); const title = ACTION_LABELS[a.action] || a.action; copy.append(el('strong',title)); const route = [a.from_name, a.to_name].filter(Boolean).join(' ← '); if (route) copy.append(el('span',route,'corr-line')); if (a.note) copy.append(el('p',a.note)); copy.append(el('small',`${a.actor_name || a.actor_username} · ${fmtDate(a.created_at)}`,'muted')); entry.append(dot,copy); timeline.append(entry); }
    timelineCard.append(timeline); root.append(timelineCard); q('#corr-detail-dialog').showModal();
  }

  function openEdit(item) { q('#corr-edit-id').value=item.id; q('#corr-edit-subject').value=item.subject||''; q('#corr-edit-party').value=item.external_party||''; q('#corr-edit-body').value=item.body||''; q('#corr-edit-priority').value=item.priority||'normal'; q('#corr-edit-conf').value=item.confidentiality||'normal'; q('#corr-edit-error').textContent=''; q('#corr-edit-dialog').showModal(); }
  async function saveEdit(event) { event.preventDefault(); const button=event.submitter; button.disabled=true; q('#corr-edit-error').textContent=''; try { const id=q('#corr-edit-id').value; await server(`/api/correspondence/${id}`,{method:'PATCH',data:{subject:q('#corr-edit-subject').value,external_party:q('#corr-edit-party').value,body:q('#corr-edit-body').value,priority:q('#corr-edit-priority').value,confidentiality:q('#corr-edit-conf').value}}); q('#corr-edit-dialog').close(); await openDetail(id); await loadAll(); } catch(error){q('#corr-edit-error').textContent=error.message;} finally{button.disabled=false;} }
  async function uploadAttachment(event, input, button) { event.preventDefault(); if (!input.files[0]) return; button.disabled=true; try { const form=new FormData(); form.append('file',input.files[0]); await server(`/api/correspondence/${state.selected.id}/attachments`,{method:'POST',form}); await openDetail(state.selected.id); await loadAll(); } catch (error) { alert(error.message); } finally { button.disabled=false; } }
  async function downloadAttachment(a) { const blob=await server(`/api/correspondence/attachments/${a.id}`,{blob:true}); const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=a.original_name; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000); }

  async function openOrg() { q('#corr-org-error').textContent=''; q('#corr-org-dialog').showModal(); await loadOrg(); }
  async function syncUsers() { q('#corr-org-error').textContent=''; try { const local = await api('/api/users'); await server('/api/correspondence/org/sync',{method:'POST',data:{users:local.users}}); await loadOrg(); } catch(error){ q('#corr-org-error').textContent=error.message; } }
  async function loadOrg() { const data=await server('/api/correspondence/org'); renderOrg(data.people||[],data.levels||{}); }
  function renderOrg(people, levels) {
    const body=q('#corr-org-body'); body.replaceChildren();
    for (const person of people) {
      const row=document.createElement('tr'); row.append(el('td',person.display_name),el('td',person.job_title||'—'));
      const levelCell=el('td'); const level=document.createElement('select'); level.className='corr-level-select'; for(const [value,label] of Object.entries(levels)){const o=el('option',`${value} — ${label}`);o.value=value;level.append(o);} level.value=String(person.level); levelCell.append(level); row.append(levelCell);
      const managerCell=el('td'); const manager=document.createElement('select'); manager.append(Object.assign(document.createElement('option'),{value:'',textContent:'بدون مدير مباشر'})); managerCell.append(manager); row.append(managerCell);
      const fillManagers=()=>{const current=manager.value||person.manager_username||''; manager.replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'بدون مدير مباشر'})); const targetLevel=Number(level.value)+1; for(const p of people.filter(p=>p.active&&p.username!==person.username&&p.level===targetLevel)){const o=el('option',p.display_name);o.value=p.username;manager.append(o);} if([...manager.options].some(o=>o.value===current))manager.value=current; manager.disabled=Number(level.value)===4;}; fillManagers(); level.addEventListener('change',fillManagers);
      const actionCell=el('td'); const save=el('button','حفظ','text-button'); save.type='button'; save.addEventListener('click',async()=>{save.disabled=true;q('#corr-org-error').textContent='';try{await server(`/api/correspondence/org/${encodeURIComponent(person.username)}`,{method:'PATCH',data:{level:Number(level.value),manager_username:manager.value||null}});await loadOrg();await loadAll();}catch(error){q('#corr-org-error').textContent=error.message;}finally{save.disabled=false;}}); actionCell.append(save); row.append(actionCell); body.append(row);
    }
  }

  function bind() {
    q('.correspondence-nav')?.addEventListener('click',()=>openView().catch(e=>alertMessage(e.message,true)));
    document.addEventListener('click',event=>{const nav=event.target.closest?.('.nav-item'); if(nav&&!nav.classList.contains('correspondence-nav'))hideView();});
    q('#corr-new-btn').addEventListener('click',()=>{q('#corr-new-error').textContent='';q('#corr-new-dialog').showModal();});
    q('#corr-new-form').addEventListener('submit',createCorrespondence); q('#corr-export-form').addEventListener('submit',e=>e.preventDefault()); q('#corr-edit-form').addEventListener('submit',saveEdit);
    q('#corr-export-prepare').addEventListener('click',()=>prepareExport()); q('#corr-export-upload').addEventListener('click',()=>uploadExportAttachment()); q('#corr-export-send').addEventListener('click',()=>sendExport()); q('#corr-export-cancel').addEventListener('click',()=>cancelExportDraft());
    q('#corr-org-btn').addEventListener('click',()=>openOrg().catch(e=>alertMessage(e.message,true))); q('#corr-sync-users').addEventListener('click',syncUsers);
    q('#corr-export-tab').addEventListener('click',()=>openExport().catch(e=>alertMessage(e.message,true)));
    qa('.corr-close').forEach(b=>b.addEventListener('click',()=>{ const dialog=b.closest('dialog'); if(dialog?.id==='corr-export-dialog'&&state.exportDraftId){ cancelExportDraft(); } else dialog?.close(); }));
    qa('.corr-tabs [data-box]').forEach(b=>b.addEventListener('click',async()=>{state.box=b.dataset.box;qa('.corr-tabs [data-box]').forEach(x=>x.classList.toggle('active',x===b));await loadList();}));
    q('#corr-refresh').addEventListener('click',()=>loadAll()); q('#corr-status').addEventListener('change',()=>loadList().catch(e=>alertMessage(e.message,true))); q('#corr-include-archived').addEventListener('change',()=>loadList().catch(e=>alertMessage(e.message,true)));
    let timer; q('#corr-search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>loadList().catch(e=>alertMessage(e.message,true)),300);});
  }

  function start() { injectUi(); bind(); window.CorrespondenceModule = { open: openView, refresh: loadAll, version: VERSION }; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
