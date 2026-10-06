(() => {
  const status = document.getElementById('status');
  const controls = document.getElementById('controls');
  const list = document.getElementById('reports');
  const filter = document.getElementById('filter');
  const next = document.getElementById('next');
  let generation = 0, nextPage = null, busy = false;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  async function api(query, body) {
    const token = await window.ljtFirebase.getCurrentUserIdToken();
    const response = await fetch('/.netlify/functions/moderate-reports' + query, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request failed.');
    return data;
  }
  function reportCard(report, enabled, ticket) {
    const card = element('article');
    card.append(element('h2', report.reason + ' — ' + report.memberName));
    card.append(element('p', 'Reported member: ' + report.targetId, 'meta'));
    card.append(element('p', 'Reporter: ' + report.reporterId + ' • Report: ' + report.id, 'meta'));
    card.append(element('p', report.createdAt ? new Date(report.createdAt).toLocaleString() : 'Date unavailable', 'meta'));
    card.append(element('pre', report.details || 'No additional details.'));
    if (report.deleted) card.append(element('p', 'Account deleted or deletion in progress.', 'notice'));
    else if (report.suspended) card.append(element('p', 'Account suspended. Restoring access leaves the profile hidden until the member republishes it.', 'notice'));
    const noteId = 'note-' + report.id;
    const label = element('label', 'Review note (required; private to administrators)'); label.htmlFor = noteId;
    const note = element('textarea'); note.id = noteId; note.maxLength = 1000; note.value = report.note;
    card.append(label, note);
    const actions = element('div', undefined, 'actions');
    const buttons = [];
    async function save(action, reportStatus, confirmation) {
      if (busy || ticket !== generation) return;
      if (!note.value.trim()) { status.textContent = 'Add a review note before saving.'; note.focus(); return; }
      busy = true; buttons.forEach(button => button.disabled = true);
      status.textContent = 'Saving…';
      try {
        await api('', {action, reportId:report.id, version:report.version, note:note.value,
          ...(reportStatus ? {status:reportStatus} : {}), ...(confirmation ? {confirmation} : {})});
        if (ticket !== generation) return;
        busy = false;
        await load();
        status.textContent = action === 'suspend' ? 'Member suspended. The action has been recorded.'
          : action === 'restore' ? 'Access restored. The member can republish their profile.' : 'Report updated.';
      } catch (error) {
        if (ticket === generation) { status.textContent = error.message; buttons.forEach(button => button.disabled = false); }
      } finally { busy = false; }
    }
    for (const [value, title] of [['new','Mark new'],['under_review','Under review'],['resolved','Resolve']]) {
      const button = element('button', title); button.type = 'button';
      button.onclick = () => save('status', value); buttons.push(button); actions.append(button);
    }
    card.append(actions);
    if (enabled && !report.deleted && !report.protected) {
      const word = report.suspended ? 'RESTORE' : 'SUSPEND';
      const confirmLabel = element('label', `Type ${word} to ${report.suspended ? 'restore access for' : 'suspend'} this member`);
      const input = element('input'); input.id = 'confirm-' + report.id; input.autocomplete = 'off'; confirmLabel.htmlFor = input.id;
      const button = element('button', report.suspended ? 'Restore Member Access' : 'Suspend Member', 'danger');
      button.type = 'button'; buttons.push(button);
      button.onclick = () => {
        if (input.value !== word) { status.textContent = `Type ${word} to confirm.`; input.focus(); return; }
        if (!window.confirm(`${word === 'SUSPEND' ? 'Suspend' : 'Restore access for'} ${report.memberName} (${report.targetId})?`)) return;
        save(report.suspended ? 'restore' : 'suspend', null, word);
      };
      card.append(confirmLabel, input, button);
    }
    return card;
  }
  async function load(after = '') {
    const ticket = ++generation;
    busy = false; list.replaceChildren(); next.hidden = true; status.textContent = 'Loading reports…';
    try {
      const data = await api(`?status=${encodeURIComponent(filter.value)}${after ? '&after=' + encodeURIComponent(after) : ''}`);
      if (ticket !== generation) return;
      document.getElementById('suspensionNotice').hidden = data.suspensionEnabled;
      for (const report of data.reports) list.append(reportCard(report, data.suspensionEnabled, ticket));
      nextPage = data.next; next.hidden = !nextPage;
      status.textContent = data.reports.length ? `${data.reports.length} reports on this page.` : 'No reports with this status.';
    } catch (error) { if (ticket === generation) status.textContent = error.message; }
  }
  async function checkAccess() {
    const ticket = ++generation; controls.hidden = true; list.replaceChildren(); nextPage = null;
    if (!window.ljtFirebase?.currentUser()) { status.textContent = 'Sign in from the home page with your administrator account.'; return; }
    try {
      const access = await api('?action=access');
      if (ticket !== generation) return;
      if (!access.allowed) { status.textContent = 'Administrator access is required. This account has no access to reports.'; return; }
      controls.hidden = false; await load();
    } catch (error) { if (ticket === generation) status.textContent = error.message; }
  }
  filter.onchange = () => load();
  document.getElementById('refresh').onclick = () => load();
  next.onclick = () => { if (nextPage) load(nextPage); };
  window.addEventListener('ljt-auth-change', checkAccess);
  window.addEventListener('ljt-firebase-ready', checkAccess);
  checkAccess();
})();
