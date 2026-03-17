// ── State ──
let leads = [];
let selectedLeadId = null;
let showLemlist = false;
let sfConfig = { sfInstance: '', owners: {} };

// ── DOM refs ──
const leadListContent = document.getElementById('lead-list-content');
const detailPlaceholder = document.getElementById('detail-placeholder');
const detailContent = document.getElementById('detail-content');
const filterCompany = document.getElementById('filter-company');
const filterOwner = document.getElementById('filter-owner');
const filterRating = document.getElementById('filter-rating');
const filterStage = document.getElementById('filter-stage');
const filterTasks = document.getElementById('filter-tasks');
const filterStale = document.getElementById('filter-stale');
const filterOverdue = document.getElementById('filter-overdue');
const filterNoNextStep = document.getElementById('filter-no-next-step');
const sortBy = document.getElementById('sort-by');
const btnClearFilters = document.getElementById('btn-clear-filters');
const toggleLemlist = document.getElementById('toggle-lemlist');
const btnReimport = document.getElementById('btn-reimport');
const importModal = document.getElementById('import-modal');
const btnRunImport = document.getElementById('btn-run-import');
const btnCloseModal = document.getElementById('btn-close-modal');
const importResult = document.getElementById('import-result');

// ── Init ──
async function init() {
  await Promise.all([loadOwners(), loadStages(), loadSfConfig()]);
  await loadLeads();
  await loadSummary();

  filterCompany.addEventListener('input', applyClientFilters);
  filterOwner.addEventListener('change', loadLeads);
  filterRating.addEventListener('change', loadLeads);
  filterStage.addEventListener('change', loadLeads);
  filterTasks.addEventListener('change', applyClientFilters);
  sortBy.addEventListener('change', applyClientFilters);
  filterStale.addEventListener('change', loadLeads);
  filterOverdue.addEventListener('change', applyClientFilters);
  filterNoNextStep.addEventListener('change', applyClientFilters);
  btnClearFilters.addEventListener('click', clearAllFilters);
  toggleLemlist.addEventListener('change', () => {
    showLemlist = toggleLemlist.checked;
    if (selectedLeadId) loadDetail(selectedLeadId);
  });
  btnReimport.addEventListener('click', openImportModal);
  btnCloseModal.addEventListener('click', closeImportModal);
  btnRunImport.addEventListener('click', runImport);

  // Next step form buttons
  document.getElementById('btn-add-next-step').addEventListener('click', () => {
    document.getElementById('next-step-form').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-next-step').addEventListener('click', () => {
    document.getElementById('next-step-form').classList.add('hidden');
  });
  document.getElementById('btn-save-next-step').addEventListener('click', saveNextStep);

  // Quick due date buttons
  document.querySelectorAll('.ns-due-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = new Date();
      if (btn.dataset.days) d.setDate(d.getDate() + parseInt(btn.dataset.days));
      if (btn.dataset.months) d.setMonth(d.getMonth() + parseInt(btn.dataset.months));
      document.getElementById('ns-due').value = d.toISOString().split('T')[0];
    });
  });
}

// ── Data Loading ──
async function loadOwners() {
  const owners = await fetch('/api/owners').then(r => r.json());
  for (const o of owners) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    filterOwner.appendChild(opt);
  }
}

async function loadSfConfig() {
  try {
    sfConfig = await fetch('/api/sf-config').then(r => r.json());
  } catch (err) {
    sfConfig = { sfInstance: '', owners: {} };
  }
  const select = document.getElementById('ns-owner');
  select.innerHTML = '';
  for (const name of Object.keys(sfConfig.owners)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.dataset.sfId = sfConfig.owners[name];
    opt.textContent = name;
    select.appendChild(opt);
  }
}

async function loadStages() {
  // Stages are 0-6
  const names = ['New Lead', 'Intro Meeting', 'Demo', 'In-depth Demo', 'POC Discussion', 'POC Active', 'Commercial'];
  for (let i = 0; i < names.length; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = names[i];
    filterStage.appendChild(opt);
  }
}

async function loadSummary() {
  const data = await fetch('/api/summary').then(r => r.json());
  document.querySelector('#card-total .card-number').textContent = data.total;
  document.querySelector('#card-hot .card-number').textContent = data.by_rating['Hot'] || 0;
  document.querySelector('#card-attention .card-number').textContent = data.needs_attention;

  // Count stale leads (those with stale attention flag)
  const staleCount = leads.filter(l => l.attention.some(a => a.type === 'stale')).length;
  document.querySelector('#card-stale .card-number').textContent = staleCount;
}

async function loadLeads() {
  const params = new URLSearchParams();
  if (filterOwner.value) params.set('owner', filterOwner.value);
  if (filterRating.value) params.set('rating', filterRating.value);
  if (filterStage.value) params.set('stage', filterStage.value);
  if (filterStale.checked) params.set('stale', 'true');

  leads = await fetch(`/api/leads?${params}`).then(r => r.json());
  renderLeadList();
  loadSummary();
}

// ── Client-side Filters ──
function applyClientFilters() {
  renderLeadList();
}

function clearAllFilters() {
  filterCompany.value = '';
  filterOwner.value = '';
  filterRating.value = '';
  filterStage.value = '';
  filterTasks.value = '';
  sortBy.value = 'attention';
  filterStale.checked = false;
  filterOverdue.checked = false;
  filterNoNextStep.checked = false;
  loadLeads();
}

function getFilteredLeads() {
  let filtered = leads;

  // Company search
  const companyQuery = filterCompany.value.trim().toLowerCase();
  if (companyQuery) {
    filtered = filtered.filter(l => l.company.toLowerCase().includes(companyQuery));
  }

  // Task count
  const taskRange = filterTasks.value;
  if (taskRange) {
    filtered = filtered.filter(l => {
      const c = l.task_count;
      if (taskRange === '0') return c === 0;
      if (taskRange === '1-5') return c >= 1 && c <= 5;
      if (taskRange === '6-10') return c >= 6 && c <= 10;
      if (taskRange === '11+') return c >= 11;
      return true;
    });
  }

  // Overdue filter
  if (filterOverdue.checked) {
    filtered = filtered.filter(l => l.attention.some(a => a.type === 'overdue'));
  }

  // No next step filter
  if (filterNoNextStep.checked) {
    filtered = filtered.filter(l => !l.next_step);
  }

  // Sort
  const sort = sortBy.value;
  filtered.sort((a, b) => {
    switch (sort) {
      case 'company-asc':
        return a.company.localeCompare(b.company);
      case 'company-desc':
        return b.company.localeCompare(a.company);
      case 'tasks-desc':
        return b.task_count - a.task_count;
      case 'tasks-asc':
        return a.task_count - b.task_count;
      case 'stage-desc':
        return b.stage.id - a.stage.id;
      case 'stage-asc':
        return a.stage.id - b.stage.id;
      case 'activity-recent':
        return (b.last_activity || '').localeCompare(a.last_activity || '');
      case 'activity-oldest':
        return (a.last_activity || '').localeCompare(b.last_activity || '');
      case 'attention':
      default:
        if (a.needs_attention !== b.needs_attention) return a.needs_attention ? -1 : 1;
        return (b.days_since_activity || 0) - (a.days_since_activity || 0);
    }
  });

  return filtered;
}

// ── Render Lead List ──
function renderLeadList() {
  leadListContent.innerHTML = '';

  const filtered = getFilteredLeads();

  if (filtered.length === 0) {
    leadListContent.innerHTML = '<div class="loading">No leads found</div>';
    return;
  }

  for (const lead of filtered) {
    const isOverdue = lead.attention.some(a => a.type === 'overdue');

    const card = document.createElement('div');
    card.className = 'lead-card' +
      (lead.lead_id === selectedLeadId ? ' selected' : '') +
      (isOverdue ? ' has-overdue' : (lead.needs_attention ? ' has-attention' : ''));
    card.dataset.id = lead.lead_id;

    const ratingClass = lead.rating ? `rating-${lead.rating.toLowerCase()}` : '';

    let nextStepHtml = '';
    if (lead.next_step) {
      nextStepHtml = `<div class="next-step-preview ok">Next: ${esc(lead.next_step)}</div>`;
    } else if (lead.task_count > 0) {
      nextStepHtml = `<div class="next-step-preview warning">No next step</div>`;
    }

    card.innerHTML = `
      <div class="lead-card-header">
        <span class="lead-card-company">${esc(lead.company)}</span>
        ${lead.rating ? `<span class="lead-card-rating ${ratingClass}">${esc(lead.rating)}</span>` : ''}
      </div>
      <div class="lead-card-contact">
        ${esc(lead.first_name)} ${esc(lead.last_name)}${lead.title ? ' - ' + esc(lead.title) : ''}
      </div>
      <div class="lead-card-footer">
        <span class="owner">${esc(lead.lead_owner)}</span>
        <div class="stage-dots">${renderStageDots(lead.stage.id)}</div>
        ${lead.days_since_activity !== null ? `<span class="days-badge">${lead.days_since_activity}d</span>` : ''}
        ${isOverdue ? '<span class="overdue-badge">OVERDUE</span>' : (lead.needs_attention ? '<span class="attention-icon">!</span>' : '')}
        <span class="days-badge">${lead.task_count} tasks</span>
      </div>
      ${nextStepHtml}
    `;

    card.addEventListener('click', () => {
      selectedLeadId = lead.lead_id;
      renderLeadList(); // re-render for selection highlight
      loadDetail(lead.lead_id);
    });

    leadListContent.appendChild(card);
  }
}

function renderStageDots(stageId) {
  let html = '';
  for (let i = 1; i <= 6; i++) {
    html += `<span class="stage-dot${i <= stageId ? ' filled' : ''}"></span>`;
  }
  return html;
}

// ── Render Lead Detail ──
async function loadDetail(leadId) {
  const data = await fetch(`/api/leads/${leadId}/timeline`).then(r => r.json());

  detailPlaceholder.classList.add('hidden');
  detailContent.classList.remove('hidden');

  const lead = data.lead;

  // Header
  const sfLeadUrl = `https://${sfConfig.sfInstance}.lightning.force.com/lightning/r/Lead/${lead.lead_id}/view`;
  document.getElementById('detail-company').innerHTML = sfConfig.sfInstance
    ? `<a href="${sfLeadUrl}" target="_blank" title="Open in Salesforce">${esc(lead.company)}</a>`
    : esc(lead.company);
  document.getElementById('detail-contact').innerHTML =
    `${esc(lead.first_name)} ${esc(lead.last_name)}` +
    (lead.title ? ` &mdash; ${esc(lead.title)}` : '') +
    (lead.email ? ` &mdash; <a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : '');

  document.getElementById('detail-meta').innerHTML = `
    <span class="meta-item"><span class="meta-label">Owner:</span> ${esc(lead.lead_owner)}</span>
    <span class="meta-item"><span class="meta-label">Status:</span> ${esc(lead.lead_status)}</span>
    <span class="meta-item"><span class="meta-label">Source:</span> ${esc(lead.lead_source)}</span>
    <span class="meta-item"><span class="meta-label">Rating:</span> ${esc(lead.rating)}</span>
    <span class="meta-item"><span class="meta-label">Created:</span> ${esc(lead.create_date || 'N/A')}</span>
    <span class="meta-item"><span class="meta-label">Last Activity:</span> ${esc(lead.last_activity || 'N/A')}</span>
    ${lead.converted ? `<span class="meta-item"><span class="meta-label">Converted:</span> ${esc(lead.converted)}</span>` : ''}
  `;

  // Alerts
  const alertsEl = document.getElementById('detail-alerts');
  if (data.attention.length > 0) {
    alertsEl.classList.remove('hidden');
    alertsEl.innerHTML = data.attention.map(a => {
      const cls = (a.type === 'negative' || a.type === 'stuck' || a.type === 'overdue') ? 'alert-danger' : 'alert-warn';
      return `<div class="alert ${cls}"><span class="alert-icon">!</span> ${esc(a.message)}</div>`;
    }).join('');
  } else {
    alertsEl.classList.add('hidden');
  }

  // Pipeline
  renderPipeline(data.stage, data.stages);

  // Next Steps
  renderNextSteps(data.nextSteps || []);

  // Timeline
  renderTimeline(data.tasks);
}

function renderPipeline(currentStage, stages) {
  const el = document.getElementById('pipeline-dots');
  el.innerHTML = '';

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isReached = i <= currentStage.id;
    const isCurrent = i === currentStage.id;

    const stageEl = document.createElement('div');
    stageEl.className = 'pipeline-stage' + (isReached ? ' reached' : '') + (isCurrent ? ' current' : '');
    stageEl.innerHTML = `
      <div class="dot">${i}</div>
      <span class="stage-label">${esc(stage.name)}</span>
    `;
    el.appendChild(stageEl);

    if (i < stages.length - 1) {
      const conn = document.createElement('div');
      conn.className = 'pipeline-connector' + (i < currentStage.id ? ' filled' : '');
      el.appendChild(conn);
    }
  }
}

// ── Next Steps (open tasks) ──
function renderNextSteps(nextSteps) {
  const el = document.getElementById('next-steps-list');
  el.innerHTML = '';

  // Reset form
  document.getElementById('next-step-form').classList.add('hidden');

  if (nextSteps.length === 0) {
    el.innerHTML = '<div class="next-step-empty">No open tasks — consider adding one.</div>';
    return;
  }

  for (const task of nextSteps) {
    const item = document.createElement('div');
    item.className = 'next-step-item';

    const metaParts = [];
    if (task.assigned) metaParts.push(`Owner: ${esc(task.assigned)}`);
    if (task.date) metaParts.push(`Due: ${esc(task.date)}`);
    if (task.comments) metaParts.push(esc(task.comments));

    item.innerHTML = `
      <div class="ns-content">
        <div class="ns-title">${esc(task.subject)}</div>
        ${metaParts.length > 0 ? `<div class="ns-meta">${metaParts.join(' &middot; ')}</div>` : ''}
      </div>
      <button class="ns-delete" data-id="${esc(task.activity_id)}" title="Delete">&times;</button>
    `;

    item.querySelector('.ns-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/next-steps/${task.activity_id}`, { method: 'DELETE' });
      if (selectedLeadId) loadDetail(selectedLeadId);
    });

    el.appendChild(item);
  }
}

/**
 * Build a pre-filled Salesforce Lightning URL for creating a new Task.
 *
 * Args:
 *   subject (string): SF Subject picklist value (Call, Email, etc.).
 *   dueDate (string): ISO date string (YYYY-MM-DD).
 *   whoId (string): SF Lead/Contact ID (WhoId).
 *   ownerId (string): SF User ID for task owner.
 *
 * Returns:
 *   string: Full Salesforce Lightning URL.
 */
function buildSalesforceTaskUrl(subject, dueDate, whoId, ownerId) {
  const fields = [
    `Subject=${encodeURIComponent(subject)}`,
    `ActivityDate=${encodeURIComponent(dueDate)}`,
    `WhoId=${encodeURIComponent(whoId)}`,
    `OwnerId=${encodeURIComponent(ownerId)}`,
    'Status=Open',
    'Priority=Normal',
    'Type=Other',
  ];
  return `https://${sfConfig.sfInstance}.lightning.force.com/lightning/o/Task/new?defaultFieldValues=${fields.join(',')}`;
}

async function saveNextStep() {
  if (!selectedLeadId) return;

  const subject = document.getElementById('ns-subject').value.trim();
  if (!subject) return;
  const comments = document.getElementById('ns-comments').value.trim();
  const dueDate = document.getElementById('ns-due').value;
  const ownerSelect = document.getElementById('ns-owner');
  const ownerName = ownerSelect.value;
  const ownerOption = ownerSelect.selectedOptions[0];
  const sfOwnerId = ownerOption ? ownerOption.dataset.sfId : '';

  const body = {
    subject,
    owner: ownerName || undefined,
    due_date: dueDate || undefined,
    comments: comments || undefined,
  };

  await fetch(`/api/leads/${selectedLeadId}/next-steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Salesforce task creation
  const createSf = document.getElementById('ns-create-sf').checked;
  if (createSf && sfConfig.sfInstance && sfOwnerId) {
    const sfDueDate = dueDate || new Date().toISOString().split('T')[0];

    // Copy comments to clipboard so user can paste into SF Description field
    if (comments) {
      try {
        await navigator.clipboard.writeText(comments);
      } catch (err) {
        // Clipboard API may fail in non-secure contexts; ignore
      }
    }

    const url = buildSalesforceTaskUrl(subject, sfDueDate, selectedLeadId, sfOwnerId);
    window.open(url, '_blank');
  }

  // Clear form
  document.getElementById('ns-subject').value = '';
  document.getElementById('ns-owner').selectedIndex = 0;
  document.getElementById('ns-due').value = '';
  document.getElementById('ns-comments').value = '';
  document.getElementById('next-step-form').classList.add('hidden');

  // Refresh detail
  loadDetail(selectedLeadId);
}

function renderTimeline(tasks) {
  const el = document.getElementById('timeline-list');
  el.innerHTML = '';

  const filtered = showLemlist ? tasks : tasks.filter(t => !t.is_lemlist);

  if (filtered.length === 0) {
    el.innerHTML = '<div class="loading">No activities recorded</div>';
    return;
  }

  const now = new Date();
  for (const task of filtered) {
    const isOpen = task.status && task.status.toLowerCase().includes('open');
    const isOverdue = isOpen && task.date && new Date(task.date) < now;

    const item = document.createElement('div');
    item.className = 'timeline-item' + (task.is_lemlist ? ' lemlist' : '') + (isOverdue ? ' overdue' : '');

    const statusClass = getStatusClass(task.status);
    const hasComments = task.comments && task.comments.trim();

    item.innerHTML = `
      <div class="timeline-date">${esc(task.date || 'No date')}</div>
      <div class="timeline-body">
        <div class="timeline-subject">
          ${task.activity_id && !task.activity_id.startsWith('manual-') && sfConfig.sfInstance
            ? `<a href="https://${sfConfig.sfInstance}.lightning.force.com/lightning/r/Task/${esc(task.activity_id)}/view" target="_blank" title="Open in Salesforce">${esc(task.subject)}</a>`
            : esc(task.subject)}
          ${isOverdue ? ' <span class="overdue-badge">OVERDUE</span>' : ''}
        </div>
        <div class="timeline-status">
          <span class="${statusClass}">${esc(task.status || 'No status')}</span>
        </div>
        <div class="timeline-meta">
          ${(() => {
            const parts = [];
            if (task.assigned) parts.push('Assigned: ' + esc(task.assigned));
            if (task.opportunity) parts.push('Opp: ' + esc(task.opportunity));
            if (task.contact) parts.push('Contact: ' + esc(task.contact));
            if (task.task) parts.push('Type: ' + esc(task.task));
            return parts.join(' | ');
          })()}
        </div>
        ${hasComments ? `
          <button class="timeline-toggle" onclick="toggleComments(this)">Show comments</button>
          <div class="timeline-comments">${esc(task.comments)}</div>
        ` : ''}
      </div>
    `;

    el.appendChild(item);
  }
}

function getStatusClass(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  if (s.includes('positive')) return 'status-positive';
  if (s.includes('negative')) return 'status-negative';
  if (s.includes('open') || s.includes('not started')) return 'status-open';
  return '';
}

function toggleComments(btn) {
  const comments = btn.nextElementSibling;
  comments.classList.toggle('expanded');
  btn.textContent = comments.classList.contains('expanded') ? 'Hide comments' : 'Show comments';
}

document.getElementById('btn-expand-all').addEventListener('click', function() {
  const allComments = document.querySelectorAll('#timeline-list .timeline-comments');
  const allToggles = document.querySelectorAll('#timeline-list .timeline-toggle');
  const anyCollapsed = [...allComments].some(c => !c.classList.contains('expanded'));

  allComments.forEach(c => anyCollapsed ? c.classList.add('expanded') : c.classList.remove('expanded'));
  allToggles.forEach(b => b.textContent = anyCollapsed ? 'Hide comments' : 'Show comments');
  this.textContent = anyCollapsed ? 'Collapse all comments' : 'Expand all comments';
});

// ── Import Modal ──
function openImportModal() {
  document.getElementById('import-leads-path').value = '';
  document.getElementById('import-tasks-path').value = '';
  importResult.classList.add('hidden');
  importModal.classList.remove('hidden');
}

function closeImportModal() {
  importModal.classList.add('hidden');
}

async function runImport() {
  const leadsFile = document.getElementById('import-leads-path').value.trim();
  const tasksFile = document.getElementById('import-tasks-path').value.trim();

  btnRunImport.disabled = true;
  btnRunImport.textContent = 'Importing...';

  try {
    const body = {};
    if (leadsFile) body.leadsFile = leadsFile;
    if (tasksFile) body.tasksFile = tasksFile;

    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (res.ok) {
      importResult.className = 'success';
      importResult.textContent = `Imported ${data.leads} leads, ${data.tasks} tasks.`;
      importResult.classList.remove('hidden');
      // Reload dashboard
      await loadLeads();
    } else {
      importResult.className = 'error';
      importResult.textContent = data.error;
      importResult.classList.remove('hidden');
    }
  } catch (err) {
    importResult.className = 'error';
    importResult.textContent = err.message;
    importResult.classList.remove('hidden');
  }

  btnRunImport.disabled = false;
  btnRunImport.textContent = 'Import';
}

// ── Utils ──
function esc(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ── Start ──
init();
