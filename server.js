const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb, saveDb } = require('./db');
const { deriveStage, getStages } = require('./sales-stage');
const { runImport, DEFAULT_LEADS_FILE, DEFAULT_TASKS_FILE } = require('./import');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Helper: get tasks for a lead via lead_id FK
function getLeadTasks(db, leadId, includeLemlist = false) {
  const lemlistFilter = includeLemlist ? '' : 'AND t.is_lemlist = 0';
  const stmt = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.lead_id = ?
    ${lemlistFilter}
    ORDER BY t.date DESC
  `);
  stmt.bind([leadId]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: run a query and return array of objects
function queryAll(db, sql) {
  const result = db.exec(sql);
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

// Helper: run a parameterized query and return array of objects
function queryAllParams(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Compute attention flags
function computeAttention(lead, tasks, stage) {
  const flags = [];
  const now = new Date();
  const lastActivity = lead.last_activity ? new Date(lead.last_activity) : null;

  if (lastActivity) {
    const daysSince = Math.floor((now - lastActivity) / 86400000);
    const threshold = lead.rating === 'Hot' ? 14 : 30;
    if (daysSince >= threshold) {
      flags.push({ type: 'stale', message: `No activity in ${daysSince} days`, days: daysSince });
    }
  }

  if (tasks.length === 0) {
    flags.push({ type: 'no_activity', message: 'No recorded activities' });
  }

  const openTasks = tasks.filter(t => t.status && t.status.toLowerCase().includes('open'));
  if (openTasks.length > 0) {
    flags.push({ type: 'open_tasks', message: `${openTasks.length} open task(s)` });
  }

  // Overdue open tasks (date in the past)
  const overdueTasks = openTasks.filter(t => t.date && new Date(t.date) < now);
  if (overdueTasks.length > 0) {
    const oldest = overdueTasks[overdueTasks.length - 1].date; // tasks sorted DESC, last = oldest
    const daysOverdue = Math.floor((now - new Date(oldest)) / 86400000);
    flags.push({ type: 'overdue', message: `${overdueTasks.length} overdue task(s) — oldest ${daysOverdue}d ago` });
  }

  // No open tasks — needs next step
  if (tasks.length > 0 && openTasks.length === 0) {
    flags.push({ type: 'no_open_task', message: 'No open task — needs next step' });
  }

  // Negative outcome on last interaction
  if (tasks.length > 0) {
    const lastTask = tasks[0]; // already sorted DESC
    if (lastTask.status && lastTask.status.toLowerCase().includes('negative')) {
      flags.push({ type: 'negative', message: 'Last interaction had negative outcome' });
    }
  }

  // Stuck in early stage for 60+ days
  if (stage.id <= 2 && lastActivity) {
    const createDate = lead.create_date ? new Date(lead.create_date) : null;
    if (createDate) {
      const daysSinceCreate = Math.floor((now - createDate) / 86400000);
      if (daysSinceCreate >= 60) {
        flags.push({ type: 'stuck', message: `In ${stage.name} stage for ${daysSinceCreate} days` });
      }
    }
  }

  return flags;
}

// GET /api/leads
app.get('/api/leads', async (req, res) => {
  try {
    const db = await getDb();
    const leads = queryAll(db, 'SELECT * FROM leads ORDER BY company');

    const enriched = leads.map(lead => {
      const tasks = getLeadTasks(db, lead.lead_id);
      const stage = deriveStage(tasks);
      const attention = computeAttention(lead, tasks, stage);
      const daysSinceActivity = lead.last_activity
        ? Math.floor((new Date() - new Date(lead.last_activity)) / 86400000)
        : null;

      const openTasks = tasks.filter(t => t.status && t.status.toLowerCase().includes('open'));
      const nextStep = openTasks.length > 0 ? openTasks[0].subject : null;

      return {
        ...lead,
        task_count: tasks.length,
        stage,
        attention,
        days_since_activity: daysSinceActivity,
        needs_attention: attention.length > 0,
        open_tasks: openTasks.length,
        has_open_task: openTasks.length > 0,
        next_step: nextStep,
      };
    });

    // Apply filters
    let filtered = enriched;
    if (req.query.owner) {
      filtered = filtered.filter(l => l.lead_owner === req.query.owner);
    }
    if (req.query.rating) {
      filtered = filtered.filter(l => l.rating === req.query.rating);
    }
    if (req.query.stage) {
      const stageId = parseInt(req.query.stage);
      filtered = filtered.filter(l => l.stage.id === stageId);
    }
    if (req.query.stale === 'true') {
      filtered = filtered.filter(l => l.attention.some(a => a.type === 'stale'));
    }

    // Sort: needs attention first, then by staleness
    filtered.sort((a, b) => {
      if (a.needs_attention !== b.needs_attention) return a.needs_attention ? -1 : 1;
      return (b.days_since_activity || 0) - (a.days_since_activity || 0);
    });

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id/timeline
app.get('/api/leads/:id/timeline', async (req, res) => {
  try {
    const db = await getDb();
    const leadId = req.params.id;

    const leads = queryAllParams(db, 'SELECT * FROM leads WHERE lead_id = ?', [leadId]);
    if (leads.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const lead = leads[0];
    const tasks = getLeadTasks(db, leadId, true); // include lemlist for full view
    const stage = deriveStage(tasks.filter(t => !t.is_lemlist));
    const attention = computeAttention(lead, tasks.filter(t => !t.is_lemlist), stage);

    // Next steps = open tasks
    const nextSteps = tasks.filter(t => t.status && t.status.toLowerCase().includes('open'));

    res.json({
      lead,
      tasks,
      stage,
      stages: getStages(),
      attention,
      nextSteps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/next-steps — creates an open task (a "next step" is an open task with a future date)
app.post('/api/leads/:id/next-steps', async (req, res) => {
  try {
    const db = await getDb();
    const leadId = req.params.id;
    const { subject, owner, due_date, comments } = req.body;

    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const activityId = `manual-${Date.now()}`;
    const stmt = db.prepare(`
      INSERT INTO tasks (activity_id, date, subject, assigned, status, comments, lead_id, is_lemlist)
      VALUES (?, ?, ?, ?, 'Open', ?, ?, 0)
    `);
    stmt.run([
      activityId,
      due_date || null,
      subject,
      owner || null,
      comments || null,
      leadId,
    ]);
    stmt.free();
    saveDb();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/next-steps/:id — deletes a task by activity_id
app.delete('/api/next-steps/:id', async (req, res) => {
  try {
    const db = await getDb();
    const stmt = db.prepare('DELETE FROM tasks WHERE activity_id = ?');
    stmt.run([req.params.id]);
    stmt.free();
    saveDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summary
app.get('/api/summary', async (req, res) => {
  try {
    const db = await getDb();
    const leads = queryAll(db, 'SELECT * FROM leads');

    const byOwner = {};
    const byStage = {};
    const byRating = {};
    let needsAttention = 0;

    for (const lead of leads) {
      const tasks = getLeadTasks(db, lead.lead_id);
      const stage = deriveStage(tasks);
      const attention = computeAttention(lead, tasks, stage);

      byOwner[lead.lead_owner] = (byOwner[lead.lead_owner] || 0) + 1;
      byStage[stage.name] = (byStage[stage.name] || 0) + 1;
      byRating[lead.rating || 'None'] = (byRating[lead.rating || 'None'] || 0) + 1;
      if (attention.length > 0) needsAttention++;
    }

    res.json({
      total: leads.length,
      needs_attention: needsAttention,
      by_owner: byOwner,
      by_stage: byStage,
      by_rating: byRating,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import
app.post('/api/import', async (req, res) => {
  try {
    const leadsFile = req.body.leadsFile || DEFAULT_LEADS_FILE;
    const tasksFile = req.body.tasksFile || DEFAULT_TASKS_FILE;
    const summary = await runImport(leadsFile, tasksFile);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sf-config — Salesforce team config for task creation
app.get('/api/sf-config', (req, res) => {
  const sfPath = path.join(__dirname, 'sf-team.json');
  try {
    const data = JSON.parse(fs.readFileSync(sfPath, 'utf8'));
    res.json(data);
  } catch (err) {
    res.json({ sfInstance: '', owners: {} });
  }
});

// GET /api/owners — distinct lead owners for filter dropdown
app.get('/api/owners', async (req, res) => {
  try {
    const db = await getDb();
    const owners = queryAll(db, "SELECT DISTINCT lead_owner FROM leads WHERE lead_owner != '' ORDER BY lead_owner");
    res.json(owners.map(o => o.lead_owner));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await getDb(); // Initialize DB
  app.listen(PORT, () => {
    console.log(`QBR Dashboard running at http://localhost:${PORT}`);
  });
}

start();
