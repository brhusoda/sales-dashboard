const express = require('express');
const path = require('path');
const { getDb, saveDb } = require('./db');
const { deriveStage, getStages } = require('./sales-stage');
const { runImport, DEFAULT_LEADS_FILE, DEFAULT_TASKS_FILE } = require('./import');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Helper: get tasks for a lead via lead_task_links
function getLeadTasks(db, leadId, includeLemlist = false) {
  const lemlistFilter = includeLemlist ? '' : 'AND t.is_lemlist = 0';
  const result = db.exec(`
    SELECT t.* FROM tasks t
    INNER JOIN lead_task_links ltl ON t.company_norm = ltl.company_norm
    WHERE ltl.lead_id = '${leadId.replace(/'/g, "''")}'
    ${lemlistFilter}
    ORDER BY t.date DESC
  `);
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
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

      return {
        ...lead,
        task_count: tasks.length,
        stage,
        attention,
        days_since_activity: daysSinceActivity,
        needs_attention: attention.length > 0,
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

    const leads = queryAll(db, `SELECT * FROM leads WHERE lead_id = '${leadId.replace(/'/g, "''")}'`);
    if (leads.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const lead = leads[0];
    const tasks = getLeadTasks(db, leadId, true); // include lemlist for full view
    const stage = deriveStage(tasks.filter(t => !t.is_lemlist));
    const attention = computeAttention(lead, tasks.filter(t => !t.is_lemlist), stage);

    // Get linked companies
    const links = queryAll(db, `
      SELECT company_norm, match_type, confidence FROM lead_task_links
      WHERE lead_id = '${leadId.replace(/'/g, "''")}'
    `);

    res.json({
      lead,
      tasks,
      stage,
      stages: getStages(),
      attention,
      links,
    });
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

// GET /api/unmatched
app.get('/api/unmatched', async (req, res) => {
  try {
    const db = await getDb();
    const unmatched = queryAll(db, `
      SELECT DISTINCT t.company, t.company_norm, COUNT(*) as task_count
      FROM tasks t
      WHERE t.company_norm != ''
        AND t.company_norm NOT IN (SELECT company_norm FROM lead_task_links)
      GROUP BY t.company_norm
      ORDER BY task_count DESC
    `);
    res.json(unmatched);
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

// POST /api/links — manually link a lead to a task company
app.post('/api/links', async (req, res) => {
  try {
    const db = await getDb();
    const { leadId, companyNorm } = req.body;
    if (!leadId || !companyNorm) return res.status(400).json({ error: 'leadId and companyNorm required' });

    db.run(`
      INSERT OR REPLACE INTO lead_task_links (lead_id, company_norm, match_type, confidence)
      VALUES ('${leadId.replace(/'/g, "''")}', '${companyNorm.replace(/'/g, "''")}', 'manual', 1.0)
    `);
    saveDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/links — remove a manual link
app.delete('/api/links', async (req, res) => {
  try {
    const db = await getDb();
    const { leadId, companyNorm } = req.body;
    if (!leadId || !companyNorm) return res.status(400).json({ error: 'leadId and companyNorm required' });

    db.run(`
      DELETE FROM lead_task_links
      WHERE lead_id = '${leadId.replace(/'/g, "''")}'
        AND company_norm = '${companyNorm.replace(/'/g, "''")}'
    `);
    saveDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
