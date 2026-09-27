(() => {
  'use strict';

  const VERSION = '20260927-correspondence-v15';
  const TYPE_LABELS = { internal: 'داخلي', incoming: 'وارد', outgoing: 'صادر' };
  const STATUS_LABELS = { draft: 'مسودة', pending: 'بانتظار إجراء', returned: 'معادة للاستكمال', approved: 'معتمدة', sent: 'مصدّرة', completed: 'مكتملة', archived: 'مؤرشفة' };
  const PRIORITY_LABELS = { normal: 'عادية', urgent: 'عاجلة', very_urgent: 'عاجلة جدًا' };
  const CONF_LABELS = { normal: 'عادية', confidential: 'سري', secret: 'سري جدًا' };
  const ACTION_LABELS = {
    created: 'إنشاء المعاملة', route_up: 'إحالة للأعلى', approve_and_route: 'اعتماد وإحالة للأعلى',
    resubmit: 'استكمال وإعادة الرفع', return_down: 'إعادة للمرسل', approve_final: 'اعتماد نهائي',
    complete: 'إغلاق الإجراء', mark_sent: 'تأكيد الإرسال', archive: 'أرشفة', comment: 'ملاحظة',
    edited: 'تعديل بيانات المعاملة', attachment_added: 'إضافة مرفق', attachment_removed: 'حذف مرفق', export_prepared: 'إصدار رقم الصادر', exported: 'إرسال الصادر نهائيًا', route_outgoing: 'توجيه الصادر داخليًا', forward: 'إحالة', reply: 'رد'
  };

  const state = { me: null, orgMe: null, orgPeople: [], items: [], selected: null, box: 'inbox', loading: false, exportDraftId: null, exportScope: 'internal', routeMode: null, notificationTimer: null };
  const FILE_ACCEPT = '.pdf,.doc,.docx,.rtf,.xls,.xlsx,.csv,.ppt,.pptx,.pps,.ppsx,.jpg,.jpeg,.jfif,.png,.gif,.webp,.bmp,.tif,.tiff,.heic,.heif,.avif,.ico,.mp4,.mov,.avi,.mkv,.webm,.mpeg,.mpg,.m4v,.3gp,.3g2,.wmv,.flv,.ogv,.mts,.m2ts,.vob,.txt,.xml,.ofx,.qfx,.qif,.sta,.mt940,.940,.bai,.bai2,.sif,.ach';
  const hasPermission = permission => state.me?.user?.role === 'admin' || !!state.me?.user?.permissions?.[permission];
  const q = (s, root = document) => root.querySelector(s);
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const fmtDate = value => value ? new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory', dateStyle: 'medium', timeStyle: String(value).length > 10 ? 'short' : undefined }).format(new Date(String(value).length === 10 ? `${value}T12:00:00` : value)) : '—';
  const fmtSize = bytes => { let n = Number(bytes) || 0, i = 0; const units = ['بايت','ك.ب','م.ب','ج.ب']; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${new Intl.NumberFormat('ar-SA',{maximumFractionDigits:1}).format(n)} ${units[i]}`; };
  const fmtRouteWhen = value => { if (!value) return ''; const d=new Date(value), now=new Date(); const same=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate(); const time=new Intl.DateTimeFormat('ar-SA',{hour:'numeric',minute:'2-digit'}).format(d); return same ? `اليوم ${time}` : new Intl.DateTimeFormat('ar-SA',{calendar:'gregory',dateStyle:'short',timeStyle:'short'}).format(d); };
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
    return { actor_username: u.username, actor_role: u.role, actor_name: u.name, actor_job_title: u.jobTitle || '', actor_permissions: Object.entries(u.permissions || {}).filter(([,enabled]) => enabled).map(([key]) => key).join(',') };
  }

  async function server(path, options = {}) {
    const url = new URL(safeBase() + path);
    const authorization = window.DemoPortal?.authorization?.() || '';
    const init = { method: options.method || 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', headers: authorization ? { Authorization: authorization } : {} };
    if (options.form) init.body = options.form;
    else if (options.data !== undefined) { init.headers = { ...init.headers, 'Content-Type': 'application/json' }; init.body = JSON.stringify(options.data); }
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
    button.className = 'nav-item correspondence-nav'; button.type = 'button'; button.dataset.view = 'correspondence'; button.hidden = true;
    button.innerHTML = `${iconSvg()} <span class="corr-nav-label">المراسلات الإدارية</span><span id="corr-nav-badge" class="corr-nav-badge" hidden>0</span>`;
    if (nav) nav.prepend(button);

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
        <label for="corr-new-files">المرفقات</label><input id="corr-new-files" type="file" multiple accept="${FILE_ACCEPT}">
        <p class="muted">يمكنك إرفاق ملف واحد أو عدة ملفات مع تسجيل الوارد.</p>
        <label class="check-label corr-submit-up"><input id="corr-new-submit-up" type="checkbox"> إحالة مباشرة للمدير بعد التسجيل</label>
        <p id="corr-new-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary">تسجيل الوارد</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-export-dialog" class="corr-dialog"><form id="corr-export-form">
        <div class="dialog-heading"><h2>تصدير معاملة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <section id="corr-export-step-one" class="corr-export-step">
          <label for="corr-export-scope">نوع التصدير</label>
          <select id="corr-export-scope"><option value="internal">تصدير داخلي</option><option value="external">صادر خارجي</option><option value="archive">الأرشيف</option></select>
          <div id="corr-export-internal-fields" class="corr-export-conditional">
            <label>التوجيه الداخلي للصادر</label><div id="corr-export-route" class="corr-route-checks" role="group" aria-label="المستلمون"></div>
            <p id="corr-export-route-hint" class="muted">يمكن اختيار أكثر من مستلم حسب الهيكل الإداري المتاح لك. إذا لم تختر أحدًا تبقى المعاملة لديك.</p>
          </div>
          <div id="corr-export-external-fields" class="corr-export-conditional" hidden>
            <label for="corr-export-party">الجهة الخارجية</label><input id="corr-export-party" maxlength="240">
          </div>
          <label for="corr-export-description">وصف الصادر</label><textarea id="corr-export-description" rows="5" maxlength="12000" required></textarea>
          <p id="corr-export-step-hint" class="muted">عند إصدار الرقم تُحفظ المعاملة مباشرة في صندوق الصادر بحالة قيد الاستكمال.</p>
          <div class="dialog-actions"><button id="corr-export-prepare" type="button" class="primary">إصدار رقم الصادر</button><button type="button" class="quiet corr-close">إلغاء</button></div>
        </section>
        <section id="corr-export-step-two" class="corr-export-step" hidden>
          <div class="corr-dispatch-card"><div><span id="corr-export-number-label">رقم الصادر</span><strong id="corr-export-generated-no">—</strong></div><div><span id="corr-export-date-label">تاريخ إصدار الرقم</span><strong id="corr-export-issued-at">—</strong></div></div>
          <div class="corr-export-draft-fields">
            <div id="corr-export-party-edit-wrap" hidden><label for="corr-export-party-edit">الجهة الخارجية</label><input id="corr-export-party-edit" maxlength="240"></div>
            <label for="corr-export-description-edit">وصف الصادر</label><textarea id="corr-export-description-edit" rows="5" maxlength="12000" required></textarea>
            <button id="corr-export-save" type="button" class="quiet">حفظ التعديلات</button>
          </div>
          <div class="corr-export-attachments">
            <label for="corr-export-file">إرفاق المعاملة / إضافة مرفق</label>
            <div class="corr-export-file-row"><input id="corr-export-file" type="file" accept="${FILE_ACCEPT}"><button id="corr-export-upload" type="button" class="quiet">إضافة المرفق</button></div>
            <div id="corr-export-attachment-list" class="corr-attachments"></div>
          </div>
          <p id="corr-export-archive-hint" class="muted" hidden>الصادر الخارجي يُحفظ تلقائيًا في الأرشيف بعد الإرسال النهائي.</p>
          <p class="muted">يمكنك إغلاق النافذة والعودة لاحقًا من صندوق الصادر. رقم الصادر يبقى محفوظًا ولا يتغير.</p>
          <p id="corr-export-error" class="error" role="alert"></p>
          <div class="dialog-actions"><button id="corr-export-send" type="button" class="primary">إرسال نهائي</button><button id="corr-export-close-draft" type="button" class="quiet">إغلاق وحفظ</button></div>
        </section>
        <p id="corr-export-step-error" class="error" role="alert"></p>
      </form></dialog>

      <dialog id="corr-edit-dialog" class="corr-dialog"><form id="corr-edit-form">
        <div class="dialog-heading"><h2>تعديل المعاملة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <input id="corr-edit-id" type="hidden">
        <div class="corr-form-grid"><div><label for="corr-edit-priority">الأولوية</label><select id="corr-edit-priority"><option value="normal">عادية</option><option value="urgent">عاجلة</option><option value="very_urgent">عاجلة جدًا</option></select></div><div><label for="corr-edit-conf">السرية</label><select id="corr-edit-conf"><option value="normal">عادية</option><option value="confidential">سري</option><option value="secret">سري جدًا</option></select></div></div>
        <label for="corr-edit-subject">الموضوع</label><input id="corr-edit-subject" maxlength="240" required>
        <div id="corr-edit-party-wrap"><label id="corr-edit-party-label" for="corr-edit-party">الجهة الخارجية</label><input id="corr-edit-party" maxlength="240"></div>
        <label for="corr-edit-body">البيان / نص المعاملة</label><textarea id="corr-edit-body" rows="6" maxlength="12000"></textarea>
        <p id="corr-edit-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary">حفظ التعديل</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-detail-dialog" class="corr-dialog corr-detail-dialog"><div class="dialog-heading"><div><h2 id="corr-detail-title">تفاصيل المعاملة</h2><p id="corr-detail-ref" class="muted"></p></div><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div><div id="corr-detail-content"></div><div class="dialog-actions"><button type="button" class="quiet corr-close">إغلاق</button></div></dialog>

      <dialog id="corr-route-dialog" class="corr-dialog"><form id="corr-route-form">
        <div class="dialog-heading"><h2 id="corr-route-title">إحالة المعاملة</h2><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div>
        <div id="corr-route-target-wrap"><label for="corr-route-target">إحالة إلى</label><select id="corr-route-target"></select></div>
        <div id="corr-reply-target-wrap" class="corr-route-recipient" hidden><span>الرد إلى</span><strong id="corr-reply-target-name">—</strong></div>
        <label for="corr-route-note">البيان / الملاحظة</label><textarea id="corr-route-note" rows="5" maxlength="2000"></textarea>
        <label for="corr-route-files">المرفقات</label><input id="corr-route-files" type="file" multiple accept="${FILE_ACCEPT}">
        <p id="corr-route-error" class="error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary" id="corr-route-submit">تنفيذ</button><button type="button" class="quiet corr-close">إلغاء</button></div>
      </form></dialog>

      <dialog id="corr-org-dialog" class="corr-dialog corr-org-dialog"><div class="dialog-heading"><div><h2>إعداد مسار الإحالة</h2><p class="muted">اربط كل مستخدم بمديره المباشر ليعمل الرفع والإعادة تلقائيًا.</p></div><button type="button" class="icon-button corr-close" aria-label="إغلاق">×</button></div><div class="corr-org-toolbar"><button id="corr-sync-users" type="button" class="quiet">مزامنة مستخدمي البوابة</button></div><div class="table-wrap"><table><thead><tr><th>المستخدم</th><th>المسمى</th><th>المستوى</th><th>المدير المباشر</th><th></th></tr></thead><tbody id="corr-org-body"></tbody></table></div><p id="corr-org-error" class="error" role="alert"></p><div class="dialog-actions"><button type="button" class="quiet corr-close">إغلاق</button></div></dialog>`);
  }

  function alertMessage(message, error = false) { const box = q('#corr-alert'); if (!box) return; box.textContent = message; box.className = error ? 'notice error' : 'notice'; box.hidden = false; }
  function clearAlert() { const box = q('#corr-alert'); if (box) box.hidden = true; }
  function setNotificationBadge(count = 0) {
    const badge = q('#corr-nav-badge'); if (!badge) return;
    const value = Math.max(0, Number(count) || 0);
    badge.textContent = value > 99 ? '99+' : String(value);
    badge.hidden = value < 1;
    const nav = q('.correspondence-nav');
    if (nav) nav.setAttribute('aria-label', value ? `المراسلات الإدارية، ${value} وارد جديد` : 'المراسلات الإدارية');
  }
  async function refreshNotificationBadge() {
    try {
      const me = await api('/api/me'); state.me = me;
      if (!hasPermission('correspondence_view')) { q('.correspondence-nav').hidden = true; setNotificationBadge(0); return; }
      q('.correspondence-nav').hidden = false;
      const bootstrap = await server('/api/correspondence/bootstrap'); state.orgMe = bootstrap.me;
      setNotificationBadge(bootstrap.counts?.unread_inbox || 0);
    } catch { setNotificationBadge(0); }
  }
  function startNotificationPolling() {
    if (state.notificationTimer) clearInterval(state.notificationTimer);
    const tick = () => { const portal=q('#portal'); if (portal && !portal.hidden) refreshNotificationBadge(); };
    setTimeout(tick, 1200);
    state.notificationTimer = setInterval(tick, 60000);
    const portal = q('#portal');
    if (portal) new MutationObserver(() => { if (!portal.hidden) refreshNotificationBadge(); }).observe(portal,{attributes:true,attributeFilter:['hidden']});
  }
  function hideView() { const view = q('#correspondence-view'); if (view) view.hidden = true; q('.correspondence-nav')?.classList.remove('active'); q('.correspondence-nav')?.removeAttribute('aria-current'); }

  async function openView() {
    try { state.me = await api('/api/me'); } catch { return; }
    if (!hasPermission('correspondence_view')) { q('.correspondence-nav').hidden = true; return; }
    q('.correspondence-nav').hidden = false;
    qa('#main-content > section').forEach(s => { s.hidden = s.id !== 'correspondence-view'; });
    qa('.nav-item').forEach(b => { const active = b.classList.contains('correspondence-nav'); b.classList.toggle('active', active); if (active) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
    q('#correspondence-view').hidden = false;
    q('#corr-new-btn').hidden = !hasPermission('correspondence_incoming');
    q('#corr-export-tab').hidden = !hasPermission('correspondence_outgoing');
    q('#corr-org-btn').hidden = !hasPermission('correspondence_manage_org');
    clearAlert(); await loadAll(); q('#main-content')?.focus({ preventScroll: true });
  }

  function renderStats(counts) {
    const wrap = q('#corr-stats'); wrap.replaceChildren();
    const cards = [
      ['صندوق الوارد', counts.inbox || 0, 'المعاملات الواردة المتاحة لك'],
      ['صندوق الصادر', counts.outbox || 0, 'الصادر المرسل وقيد الاستكمال']
    ];
    for (const [title, value, hint] of cards) { const card = el('div', undefined, 'corr-stat-card'); card.append(el('span', title), el('strong', new Intl.NumberFormat('ar-SA').format(value)), el('small', hint)); wrap.append(card); }
  }

  function statusBadge(status, item = null) {
    const label = item?.type === 'outgoing' && status === 'draft' ? 'قيد الاستكمال' : (STATUS_LABELS[status] || status);
    return el('span', label, `corr-badge status-${status}`);
  }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true; q('#corr-refresh').disabled = true;
    try {
      const bootstrap = await server('/api/correspondence/bootstrap');
      state.orgMe = bootstrap.me; renderStats(bootstrap.counts || {}); setNotificationBadge(bootstrap.counts?.unread_inbox || 0); await loadList();
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

  function internalDeleteMenu(item) {
    if (!item?.can_delete_internal_outgoing) return null;
    const more = document.createElement('details'); more.className = 'corr-more-menu';
    const summary = document.createElement('summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label','المزيد من الإجراءات');
    const menu = el('div', undefined, 'corr-more-menu-popover');
    const remove = el('button', 'حذف الصادر الداخلي', 'corr-more-delete'); remove.type = 'button';
    remove.addEventListener('click', async event => {
      event.preventDefault(); more.open = false;
      if (!confirm('حذف الصادر الداخلي قبل أن يفتحه المستلم؟')) return;
      try {
        await server(`/api/correspondence/outgoing/${item.id}`, { method:'DELETE' });
        q('#corr-detail-dialog')?.close();
        alertMessage('تم حذف الصادر الداخلي.');
        await loadAll();
      } catch (error) { alertMessage(error.message, true); }
    });
    menu.append(remove); more.append(summary, menu); return more;
  }

  function renderList() {
    const body = q('#corr-body'); body.replaceChildren(); q('#corr-empty').hidden = state.items.length > 0;
    for (const item of state.items) {
      const row = document.createElement('tr');
      const number = item.type === 'outgoing' ? (item.dispatch_no || item.reference_no) : item.reference_no;
      const ref = el('td'); ref.append(el('strong', number, 'corr-ref'));
      const subject = el('td'); subject.append(el('strong', item.subject));
      if (item.unread) { row.classList.add('corr-unread-row'); subject.append(el('span','جديد','corr-new-badge')); }
      const partyText = item.type === 'incoming' ? (item.external_party || '—') : (item.outgoing_scope === 'archive' ? 'الأرشيف' : (item.outgoing_scope === 'external' ? (item.external_party || '—') : (state.box === 'inbox' ? (item.creator_name || item.creator_username || 'داخلي') : (item.current_assignee_name || item.current_assignee || 'داخلي'))));
      const party = el('td', partyText);
      const status = el('td'); status.append(statusBadge(item.status, item));
      const assignee = el('td', item.current_assignee_name || item.current_assignee);
      const date = el('td', fmtDate(item.type === 'outgoing' ? (item.sent_at || item.dispatch_issued_at || item.created_at) : item.created_at));
      const updated = el('td', fmtDate(item.updated_at));
      const actions = el('td'); actions.className='corr-row-actions'; const open = el('button', 'فتح', 'text-button'); open.type = 'button'; open.addEventListener('click', () => openDetail(item.id).catch(e => alertMessage(e.message,true))); actions.append(open); const more = internalDeleteMenu(item); if (more) actions.append(more);
      row.append(ref, subject, party, status, assignee, date, updated, actions); body.append(row);
    }
  }

  async function createCorrespondence(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true; q('#corr-new-error').textContent = '';
    try {
      const files = [...(q('#corr-new-files').files || [])];
      const data = await server('/api/correspondence', { method: 'POST', data: {
        type: 'incoming', subject: q('#corr-new-subject').value, body: q('#corr-new-body').value,
        external_party: q('#corr-new-party').value, priority: q('#corr-new-priority').value,
        confidentiality: q('#corr-new-conf').value, submit_up: q('#corr-new-submit-up').checked
      }});
      const failed = [];
      for (const file of files) {
        try {
          const form = new FormData(); form.append('file', file);
          await server(`/api/correspondence/${data.correspondence.id}/attachments`, { method:'POST', form });
        } catch (error) { failed.push(`${file.name}: ${error.message}`); }
      }
      q('#corr-new-dialog').close(); q('#corr-new-form').reset();
      if (failed.length) alertMessage(`تم تسجيل الوارد ${data.correspondence.reference_no}، لكن تعذر رفع ${failed.length} من المرفقات: ${failed.join(' | ')}`, true);
      else alertMessage(`تم تسجيل الوارد ${data.correspondence.reference_no}${files.length ? ` مع ${files.length} مرفق` : ''}.`);
      await loadAll(); await openDetail(data.correspondence.id);
    } catch (error) { q('#corr-new-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  function subordinateUsers(people, username) {
    const byManager = new Map();
    for (const person of people.filter(p => p.active)) {
      const manager = person.manager_username || '';
      if (!byManager.has(manager)) byManager.set(manager, []);
      byManager.get(manager).push(person);
    }
    const result = []; const seen = new Set([username]); const queue = [...(byManager.get(username) || [])];
    while (queue.length) {
      const person = queue.shift();
      if (!person || seen.has(person.username)) continue;
      seen.add(person.username); result.push(person);
      queue.push(...(byManager.get(person.username) || []));
    }
    return result;
  }

  async function loadExportRouteTargets(selected = []) {
    const wrap = q('#corr-export-route'); wrap.replaceChildren();
    const selectedSet = new Set(Array.isArray(selected) ? selected : (selected ? [selected] : []));
    const data = await server('/api/correspondence/org');
    state.orgPeople = data.people || [];
    const me = state.orgPeople.find(p => p.username === state.me?.user?.username) || state.orgMe;
    const manager = me?.manager_username ? state.orgPeople.find(p => p.username === me.manager_username && p.active) : null;
    const subs = subordinateUsers(state.orgPeople, state.me?.user?.username || '');
    const used = new Set();
    const addSection = (title, people) => {
      const clean = people.filter(person => person && !used.has(person.username));
      if (!clean.length) return;
      const section = el('fieldset', undefined, 'corr-route-group'); section.append(el('legend', title));
      for (const person of clean) {
        used.add(person.username);
        const label = el('label', undefined, 'check-label');
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = person.username; input.checked = selectedSet.has(person.username);
        label.append(input, document.createTextNode(`${person.display_name}${person.job_title ? ` — ${person.job_title}` : ''}`));
        section.append(label);
      }
      wrap.append(section);
    };
    addSection('المدير المباشر', manager ? [manager] : []);
    addSection('التابعون لك', subs);
    if (!wrap.children.length) wrap.append(el('p','لا يوجد مستخدمون متاحون للتوجيه حسب الهيكل الحالي.','muted'));
    const hint = q('#corr-export-route-hint');
    hint.textContent = manager || subs.length ? 'يمكن اختيار شخص واحد أو أكثر. إذا لم تختر أحدًا تبقى المعاملة لديك.' : 'لا يوجد مدير مباشر أو تابعون مرتبطون بحسابك؛ ستبقى المعاملة لديك.';
  }

  function selectedExportTargets() {
    return qa('#corr-export-route input[type="checkbox"]:checked').map(input => input.value).filter(Boolean);
  }

  function updateExportScopeUi(scope = state.exportScope) {
    state.exportScope = ['internal','external','archive'].includes(scope) ? scope : 'internal';
    const internal = state.exportScope === 'internal';
    const external = state.exportScope === 'external';
    const archive = state.exportScope === 'archive';
    q('#corr-export-scope').value = state.exportScope;
    q('#corr-export-internal-fields').hidden = !internal;
    q('#corr-export-external-fields').hidden = !external;
    q('#corr-export-party-edit-wrap').hidden = !external;
    q('#corr-export-archive-hint').hidden = internal;
    q('#corr-export-archive-hint').textContent = archive ? 'سيتم حفظ المعاملة في الأرشيف دون إرسال داخلي أو خارجي.' : 'الصادر الخارجي يُحفظ تلقائيًا في الأرشيف بعد الإرسال النهائي.';
    q('#corr-export-party').required = external;
    q('#corr-export-party-edit').required = external;
    q('#corr-export-prepare').textContent = archive ? 'متابعة الأرشفة' : 'إصدار رقم الصادر';
    q('#corr-export-step-hint').textContent = archive ? 'سيتم إنشاء مسودة أرشيفية لتتمكن من إضافة المرفقات قبل الحفظ النهائي.' : 'عند إصدار الرقم تُحفظ المعاملة مباشرة في صندوق الصادر بحالة قيد الاستكمال.';
    q('#corr-export-number-label').textContent = archive ? 'رقم الأرشيف' : 'رقم الصادر';
    q('#corr-export-date-label').textContent = archive ? 'تاريخ إنشاء الأرشيف' : 'تاريخ إصدار الرقم';
    q('#corr-export-send').textContent = archive ? 'حفظ في الأرشيف' : 'إرسال نهائي';
  }

  function resetExportDialog() {
    state.exportDraftId = null; state.exportScope = 'internal';
    q('#corr-export-step-one').hidden = false;
    q('#corr-export-step-two').hidden = true;
    q('#corr-export-generated-no').textContent = '—';
    q('#corr-export-issued-at').textContent = '—';
    q('#corr-export-party').value = '';
    q('#corr-export-description').value = '';
    q('#corr-export-route').replaceChildren();
    q('#corr-export-party-edit').value = '';
    q('#corr-export-description-edit').value = '';
    q('#corr-export-file').value = '';
    q('#corr-export-attachment-list').replaceChildren();
    q('#corr-export-step-error').textContent = '';
    q('#corr-export-error').textContent = '';
    updateExportScopeUi('internal');
  }

  async function openExport(draftId = '') {
    resetExportDialog();
    q('#corr-export-dialog').showModal();
    await loadExportRouteTargets();
    if (draftId) await resumeExportDraft(draftId);
  }

  async function resumeExportDraft(draftId) {
    const data = await server(`/api/correspondence/${draftId}`);
    const item = data.correspondence;
    if (item.type !== 'outgoing' || item.status !== 'draft') throw new Error('هذه المعاملة ليست صادرة قيد الاستكمال.');
    state.exportDraftId = item.id;
    updateExportScopeUi(item.outgoing_scope || 'external');
    q('#corr-export-generated-no').textContent = item.dispatch_no || item.reference_no;
    q('#corr-export-issued-at').textContent = fmtDate(item.dispatch_issued_at || item.created_at);
    q('#corr-export-party-edit').value = item.external_party || '';
    q('#corr-export-description-edit').value = item.body || item.subject || '';
    await loadExportRouteTargets((item.recipients || []).map(person => person.username));
    q('#corr-export-step-one').hidden = true;
    q('#corr-export-step-two').hidden = false;
    renderExportAttachments(item.attachments || [], true);
  }

  function renderExportAttachments(attachments = [], canDelete = true) {
    const list = q('#corr-export-attachment-list'); list.replaceChildren();
    if (!attachments.length) { list.append(el('p', state.exportScope === 'archive' ? 'لا توجد مرفقات مضافة.' : 'لا توجد مرفقات مضافة. أرفق ملف المعاملة قبل الإرسال النهائي.','muted')); return; }
    for (const attachment of attachments) {
      const row = el('div', undefined, 'corr-attachment');
      const info = el('div'); info.append(el('strong', attachment.original_name), el('small', fmtSize(attachment.size), 'muted corr-line'));
      row.append(info);
      if (canDelete) {
        const remove = el('button', 'حذف', 'text-button delete'); remove.type = 'button';
        remove.addEventListener('click', () => deleteExportAttachment(attachment.id, remove));
        row.append(remove);
      }
      list.append(row);
    }
  }

  async function prepareExport() {
    const button = q('#corr-export-prepare'); button.disabled = true; q('#corr-export-step-error').textContent = '';
    try {
      const requestedScope = q('#corr-export-scope').value;
      const outgoingScope = ['internal','external','archive'].includes(requestedScope) ? requestedScope : 'internal';
      const externalParty = outgoingScope === 'external' ? q('#corr-export-party').value.trim() : '';
      const description = q('#corr-export-description').value.trim();
      if (outgoingScope === 'external' && !externalParty) throw new Error('اكتب اسم الجهة الخارجية.');
      if (!description) throw new Error(outgoingScope === 'archive' ? 'اكتب وصف المعاملة.' : 'اكتب وصف الصادر.');
      const data = await server('/api/correspondence/outgoing/prepare', { method: 'POST', data: { outgoing_scope: outgoingScope, external_party: externalParty, description, route_targets: outgoingScope === 'internal' ? selectedExportTargets() : [] } });
      state.exportDraftId = data.correspondence.id;
      updateExportScopeUi(data.correspondence.outgoing_scope || outgoingScope);
      q('#corr-export-generated-no').textContent = data.correspondence.dispatch_no || data.correspondence.reference_no;
      q('#corr-export-issued-at').textContent = fmtDate(data.correspondence.dispatch_issued_at || data.correspondence.created_at);
      q('#corr-export-party-edit').value = data.correspondence.external_party || externalParty;
      q('#corr-export-description-edit').value = data.correspondence.body || description;
      q('#corr-export-step-one').hidden = true; q('#corr-export-step-two').hidden = false;
      renderExportAttachments(data.correspondence.attachments || [], true);
      await loadAll();
    } catch (error) { q('#corr-export-step-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function saveExportDraft(silent = false) {
    if (!state.exportDraftId) throw new Error('لم يتم إصدار رقم الصادر بعد.');
    const externalParty = state.exportScope === 'external' ? q('#corr-export-party-edit').value.trim() : '';
    const description = q('#corr-export-description-edit').value.trim();
    if (state.exportScope === 'external' && !externalParty) throw new Error('اكتب اسم الجهة الخارجية.');
    if (!description) throw new Error('اكتب وصف الصادر.');
    const data = await server(`/api/correspondence/${state.exportDraftId}`, { method:'PATCH', data:{ external_party: externalParty, body: description } });
    if (!silent) q('#corr-export-error').textContent = 'تم حفظ التعديلات.';
    await loadAll();
    return data.correspondence;
  }

  async function uploadExportAttachment() {
    const button = q('#corr-export-upload'); const input = q('#corr-export-file');
    if (!state.exportDraftId) return;
    if (!input.files[0]) { q('#corr-export-error').textContent = 'اختر ملفًا لإضافته.'; return; }
    button.disabled = true; q('#corr-export-error').textContent = '';
    try {
      await saveExportDraft(true);
      const form = new FormData(); form.append('file', input.files[0]);
      await server(`/api/correspondence/${state.exportDraftId}/attachments`, { method:'POST', form });
      const detail = await server(`/api/correspondence/${state.exportDraftId}`);
      renderExportAttachments(detail.correspondence.attachments || [], true); input.value = '';
      await loadAll();
    } catch (error) { q('#corr-export-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function deleteExportAttachment(attachmentId, button) {
    if (!state.exportDraftId) return;
    if (!confirm('حذف هذا المرفق من المعاملة الصادرة؟')) return;
    button.disabled = true; q('#corr-export-error').textContent = '';
    try {
      await server(`/api/correspondence/attachments/${attachmentId}`, { method:'DELETE' });
      const detail = await server(`/api/correspondence/${state.exportDraftId}`);
      renderExportAttachments(detail.correspondence.attachments || [], true);
      await loadAll();
    } catch (error) { q('#corr-export-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function sendExport() {
    const button = q('#corr-export-send'); button.disabled = true; q('#corr-export-error').textContent = '';
    try {
      if (!state.exportDraftId) throw new Error('لم يتم إصدار رقم الصادر بعد.');
      await saveExportDraft(true);
      const detail = await server(`/api/correspondence/${state.exportDraftId}`);
      if (state.exportScope !== 'archive' && !(detail.correspondence.attachments || []).length) throw new Error('أرفق ملف المعاملة قبل الإرسال النهائي.');
      const destination = state.exportScope === 'internal' ? 'outbox' : 'archive';
      const data = await server(`/api/correspondence/${state.exportDraftId}/send`, { method:'POST', data:{ destination } });
      q('#corr-export-dialog').close(); state.exportDraftId = null; state.box = 'outbox';
      qa('.corr-tabs [data-box]').forEach(b => b.classList.toggle('active', b.dataset.box === 'outbox'));
      if (state.exportScope === 'archive') alertMessage(`تم حفظ المعاملة في الأرشيف برقم ${data.correspondence.reference_no}.`);
      else alertMessage(`تم إرسال المعاملة نهائيًا برقم ${data.correspondence.dispatch_no}.`);
      await loadAll();
      if (data.correspondence.status !== 'archived') await openDetail(data.correspondence.id);
    } catch (error) { q('#corr-export-error').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function closeExportDraft() {
    try {
      if (state.exportDraftId) await saveExportDraft(true);
      q('#corr-export-dialog').close();
      state.exportDraftId = null;
      state.box = 'outbox';
      qa('.corr-tabs [data-box]').forEach(b => b.classList.toggle('active', b.dataset.box === 'outbox'));
      await loadAll();
    } catch (error) { q('#corr-export-error').textContent = error.message; }
  }

  function fillForwardTargets(item) {
    const select = q('#corr-route-target'); select.replaceChildren();
    const targets = item.routing?.forward_targets || [];
    const me = state.orgMe;
    const directManager = me?.manager_username ? targets.find(p => p.username === me.manager_username) : null;
    const used = new Set();
    const appendGroup = (label, people) => {
      const clean = people.filter(p => p && !used.has(p.username)); if (!clean.length) return;
      const group = document.createElement('optgroup'); group.label = label;
      for (const person of clean) { used.add(person.username); const o=el('option',`${person.display_name}${person.job_title ? ` — ${person.job_title}` : ''}`); o.value=person.username; group.append(o); }
      select.append(group);
    };
    appendGroup('المدير المباشر', directManager ? [directManager] : []);
    appendGroup('المدير العام / الإدارة العليا', targets.filter(p => Number(p.level) >= 3));
    appendGroup('فريق الإدارة والتابعون', targets.filter(p => Number(p.level) < 3 || p.username !== directManager?.username));
  }

  function openIncomingAction(mode, item) {
    state.routeMode = mode;
    q('#corr-route-error').textContent = '';
    q('#corr-route-note').value = '';
    q('#corr-route-files').value = '';
    const reply = mode === 'reply';
    q('#corr-route-title').textContent = reply ? 'الرد على المعاملة' : 'إحالة المعاملة';
    q('#corr-route-target-wrap').hidden = reply;
    q('#corr-reply-target-wrap').hidden = !reply;
    q('#corr-route-submit').textContent = reply ? 'إرسال الرد' : 'إحالة';
    if (reply) {
      const target = item.routing?.reply_target;
      if (!target) return alert('لا يوجد مرسل سابق يمكن الرد إليه.');
      q('#corr-reply-target-name').textContent = `${target.display_name}${target.job_title ? ` — ${target.job_title}` : ''}`;
    } else {
      fillForwardTargets(item);
      if (!q('#corr-route-target').options.length) return alert('لا يوجد مستخدم متاح للإحالة حسب الهيكل الحالي.');
    }
    q('#corr-route-dialog').showModal();
  }

  async function submitIncomingAction(event) {
    event.preventDefault();
    const button = event.submitter || q('#corr-route-submit'); button.disabled = true; q('#corr-route-error').textContent = '';
    try {
      if (!state.selected?.id) throw new Error('المعاملة غير محددة.');
      const files = [...(q('#corr-route-files').files || [])];
      for (const file of files) {
        const form = new FormData(); form.append('file', file);
        await server(`/api/correspondence/${state.selected.id}/attachments`, { method:'POST', form });
      }
      const data = { action: state.routeMode === 'reply' ? 'reply' : 'forward', note: q('#corr-route-note').value.trim() };
      if (data.action === 'forward') data.target_username = q('#corr-route-target').value;
      await server(`/api/correspondence/${state.selected.id}/actions`, { method:'POST', data });
      q('#corr-route-dialog').close();
      await openDetail(state.selected.id); await loadAll();
    } catch (error) { q('#corr-route-error').textContent = error.message; }
    finally { button.disabled = false; }
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
    const internalRecipientNames = item.type === 'outgoing' && item.outgoing_scope === 'internal' ? (item.recipients || []).map(person => person.display_name || person.username).join('، ') : '';
    const fields = [
      ['النوع', item.type === 'outgoing' && item.outgoing_scope === 'internal' ? 'صادر داخلي' : (item.type === 'outgoing' && item.outgoing_scope === 'archive' ? 'الأرشيف' : (item.type === 'outgoing' ? 'صادر خارجي' : TYPE_LABELS[item.type]))], ['الحالة', STATUS_LABELS[item.status]], ['الأولوية', PRIORITY_LABELS[item.priority]], ['السرية', CONF_LABELS[item.confidentiality]],
      ['المنشئ', item.creator_name], [item.type === 'outgoing' && item.outgoing_scope === 'internal' ? 'المستلمون' : 'المحال إليه', internalRecipientNames || item.current_assignee_name]
    ];
    if (item.type === 'incoming') fields.push(['الجهة الواردة منها', item.external_party || '—']);
    if (item.type === 'outgoing' && item.outgoing_scope === 'external') fields.push(['الجهة الخارجية', item.external_party || '—']);
    if (item.type === 'outgoing' && item.outgoing_scope === 'archive') { fields.push(['رقم الأرشيف', item.reference_no || '—'], ['تاريخ الأرشفة', fmtDate(item.archived_at || item.created_at)]); }
    else if (item.type === 'outgoing') { fields.push(['رقم الصادر', item.dispatch_no || '—'], ['تاريخ إصدار الرقم', fmtDate(item.dispatch_issued_at || item.created_at)], ['تاريخ الإرسال', item.sent_at ? fmtDate(item.sent_at) : 'لم يتم الإرسال بعد']); }
    for (const [k,v] of fields) { const box=el('div',undefined,'corr-meta'); box.append(el('span',k),el('strong',v||'—')); meta.append(box); }
    root.append(meta);
    if (item.type === 'incoming' || (item.type === 'outgoing' && item.outgoing_scope === 'internal')) { const holder=el('div',undefined,'corr-current-holder'); holder.append(el('span','المعاملة حاليًا لدى:'),el('strong',item.current_assignee_name || item.current_assignee)); root.append(holder); }
    const bodyCard = el('section',undefined,'corr-detail-card'); bodyCard.append(el('h3','البيان'),el('p',item.body||'لا يوجد بيان.','corr-body-text')); root.append(bodyCard);

    const attachCard = el('section',undefined,'corr-detail-card'); attachCard.append(el('h3','المرفقات')); const list = el('div',undefined,'corr-attachments');
    for (const a of item.attachments || []) { const line=el('div',undefined,'corr-attachment'); const info=el('div'); info.append(el('strong',a.original_name),el('small',`${fmtSize(a.size)} · ${fmtDate(a.created_at)}`,'muted corr-line')); const d=el('button','تنزيل','text-button'); d.type='button'; d.addEventListener('click',()=>downloadAttachment(a)); line.append(info,d); list.append(line); }
    if (!(item.attachments||[]).length) list.append(el('p','لا توجد مرفقات.','muted')); attachCard.append(list);
    if ((item.type !== 'outgoing' || item.status === 'draft') && (item.permissions?.can_act || item.creator_username === state.me.user.username || state.me.user.role === 'admin')) {
      const form=el('form',undefined,'corr-attachment-form'); const input=document.createElement('input'); input.type='file'; input.required=true; input.accept=FILE_ACCEPT; const btn=el('button','إضافة مرفق','quiet'); btn.type='submit'; form.append(input,btn); form.addEventListener('submit',e=>uploadAttachment(e,input,btn)); attachCard.append(form);
    }
    root.append(attachCard);

    const actionCard = el('section',undefined,'corr-detail-card'); actionCard.append(el('h3','الإجراءات')); const buttons = el('div',undefined,'corr-action-buttons'); const p=item.permissions||{};
    if (p.can_edit && !(item.type === 'outgoing' && item.status === 'draft')) { const edit=el('button','تعديل البيانات','quiet'); edit.type='button'; edit.addEventListener('click',()=>openEdit(item)); buttons.append(edit); }
    const internalRoutable = item.type === 'outgoing' && item.outgoing_scope === 'internal';
    if (p.can_act && (item.type === 'incoming' || internalRoutable) && item.status !== 'archived') {
      if (item.routing?.reply_target) { const reply=el('button','رد','primary'); reply.type='button'; reply.addEventListener('click',()=>openIncomingAction('reply',item)); buttons.append(reply); }
      if ((item.routing?.forward_targets||[]).length) { const forward=el('button','إحالة','primary'); forward.type='button'; forward.addEventListener('click',()=>openIncomingAction('forward',item)); buttons.append(forward); }
    }
    if (p.can_act && item.status !== 'archived' && item.type !== 'outgoing') {
      if (p.can_route_up) buttons.append(actionButton(item.status==='returned'?'استكمال وإعادة الرفع':'إحالة للأعلى', item.status==='returned'?'resubmit':'route_up','primary'));
      if (p.can_route_up && item.status==='pending') buttons.append(actionButton('اعتماد ورفع للأعلى','approve_and_route','primary'));
      if (p.can_return) buttons.append(actionButton('إعادة للمرسل','return_down','quiet'));
      if (p.can_final_approve && !['approved','completed'].includes(item.status)) buttons.append(actionButton('اعتماد نهائي','approve_final','primary'));
      if (!['completed','approved'].includes(item.status)) buttons.append(actionButton('إنهاء الإجراء','complete','quiet'));
    }
    if (p.can_resume_outgoing) { const resumeBtn=el('button', item.outgoing_scope === 'archive' ? 'استكمال الأرشفة' : 'استكمال الصادر','primary'); resumeBtn.type='button'; resumeBtn.addEventListener('click',()=>{q('#corr-detail-dialog').close();openExport(item.id).catch(e=>alertMessage(e.message,true));}); buttons.append(resumeBtn); }
    const moreMenu = internalDeleteMenu(item); if (moreMenu) buttons.append(moreMenu);
    buttons.append(actionButton('إضافة ملاحظة','comment','quiet'));
    actionCard.append(buttons); root.append(actionCard);

    const timelineCard = el('section',undefined,'corr-detail-card'); timelineCard.append(el('h3','مسار المعاملة')); const timeline=el('div',undefined,'corr-timeline');
    const movementActions = new Set(['route_up','approve_and_route','resubmit','return_down','route_outgoing','forward','reply']);
    const moves = (item.actions || []).filter(a => movementActions.has(a.action) && a.from_name && a.to_name && a.from_username !== a.to_username);
    for (const a of moves) { const entry=el('div',undefined,'corr-timeline-item'); const dot=el('span',undefined,'corr-timeline-dot'); const copy=el('div'); copy.append(el('strong',`${fmtRouteWhen(a.created_at)} | ${a.from_name} > ${a.to_name}`)); if (a.note) copy.append(el('p',a.note,'corr-route-note')); entry.append(dot,copy); timeline.append(entry); }
    if (!moves.length) timeline.append(el('p','لم تُحل المعاملة إلى مستخدم آخر حتى الآن.','muted'));
    timelineCard.append(timeline); root.append(timelineCard); q('#corr-detail-dialog').showModal();
    if (item.type === 'incoming') { const local=state.items.find(x=>x.id===item.id); if(local)local.unread=false; renderList(); refreshNotificationBadge(); }
  }

  function openEdit(item) { q('#corr-edit-id').value=item.id; q('#corr-edit-subject').value=item.subject||''; q('#corr-edit-party').value=item.external_party||''; q('#corr-edit-body').value=item.body||''; q('#corr-edit-priority').value=item.priority||'normal'; q('#corr-edit-conf').value=item.confidentiality||'normal'; const showParty=item.type==='incoming'||(item.type==='outgoing'&&item.outgoing_scope==='external'); q('#corr-edit-party-wrap').hidden=!showParty; q('#corr-edit-party-label').textContent=item.type==='incoming'?'الجهة الواردة منها':'الجهة الخارجية'; q('#corr-edit-error').textContent=''; q('#corr-edit-dialog').showModal(); }
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
    q('#corr-new-btn').addEventListener('click',()=>{if(!hasPermission('correspondence_incoming'))return;q('#corr-new-error').textContent='';q('#corr-new-dialog').showModal();});
    q('#corr-new-form').addEventListener('submit',createCorrespondence); q('#corr-export-form').addEventListener('submit',e=>e.preventDefault()); q('#corr-edit-form').addEventListener('submit',saveEdit); q('#corr-route-form').addEventListener('submit',submitIncomingAction); q('#corr-export-scope').addEventListener('change',e=>updateExportScopeUi(e.target.value));
    q('#corr-export-prepare').addEventListener('click',()=>prepareExport()); q('#corr-export-save').addEventListener('click',()=>saveExportDraft().catch(e=>{q('#corr-export-error').textContent=e.message;})); q('#corr-export-upload').addEventListener('click',()=>uploadExportAttachment()); q('#corr-export-send').addEventListener('click',()=>sendExport()); q('#corr-export-close-draft').addEventListener('click',()=>closeExportDraft());
    q('#corr-org-btn').addEventListener('click',()=>{if(hasPermission('correspondence_manage_org'))openOrg().catch(e=>alertMessage(e.message,true));}); q('#corr-sync-users').addEventListener('click',syncUsers);
    q('#corr-export-tab').addEventListener('click',()=>{if(hasPermission('correspondence_outgoing'))openExport().catch(e=>alertMessage(e.message,true));});
    qa('.corr-close').forEach(b=>b.addEventListener('click',()=>{ const dialog=b.closest('dialog'); if(dialog?.id==='corr-export-dialog'&&state.exportDraftId){ closeExportDraft(); } else dialog?.close(); }));
    qa('.corr-tabs [data-box]').forEach(b=>b.addEventListener('click',async()=>{state.box=b.dataset.box;qa('.corr-tabs [data-box]').forEach(x=>x.classList.toggle('active',x===b));await loadList();}));
    q('#corr-refresh').addEventListener('click',()=>loadAll()); q('#corr-status').addEventListener('change',()=>loadList().catch(e=>alertMessage(e.message,true))); q('#corr-include-archived').addEventListener('change',()=>loadList().catch(e=>alertMessage(e.message,true)));
    let timer; q('#corr-search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>loadList().catch(e=>alertMessage(e.message,true)),300);});
  }

  function start() { injectUi(); bind(); startNotificationPolling(); window.CorrespondenceModule = { open: openView, refresh: loadAll, version: VERSION }; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
