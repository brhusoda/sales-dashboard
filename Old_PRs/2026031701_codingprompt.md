# Coding Prompt: Fix Lead-Task Linking + Add Next Steps Infrastructure

## Goal

Two changes to the QBR Sales Dashboard:

1. **Fix lead-task linking**: Replace the current fuzzy company-name matching with a direct join on the `Lead` column from the Tasks Excel file. This column contains person names (e.g., "Caspar Heusser") that correspond to `first_name + ' ' + last_name` in the leads table.

2. **Add Next Steps feature**: Every lead needs a visible "next step." If the lead has an open task, that IS the next step. If not, that's a red flag. Build the database schema, API, and UI so that next steps can be stored (manually now, via a Claude skill later) with fields: next_step, owner, due_date, comments.

---

## Context: Current Architecture

```
Excel files (Google Drive) → import.js → SQLite (sql.js/WASM) → Express API → Vanilla JS frontend
```

### Key files
| File | Role |
|---|---|
| `db.js` | SQLite init, schema (leads, tasks, lead_task_links tables), save to disk |
| `import.js` | Parses Excel, inserts leads + tasks, rebuilds lead_task_links via fuzzy matching |
| `matching.js` | Company name normalization + 4-stage fuzzy matching (exact, spaceless, contains, Jaccard) |
| `sales-stage.js` | Derives pipeline stage 0-6 from task subject keywords |
| `server.js` | Express API: /api/leads, /api/leads/:id/timeline, /api/summary, /api/unmatched, /api/links, /api/owners, /api/import |
| `public/index.html` | Dashboard HTML: two-panel layout (lead list + detail), import modal, unmatched modal |
| `public/app.js` | Frontend logic: filtering, sorting, rendering lead cards, detail view, timeline |
| `public/style.css` | All styles |

### Current linking (BROKEN — to be replaced)
- `matching.js` fuzzy-matches `tasks.company_norm` to `leads.company_norm`
- Results stored in `lead_task_links(lead_id, company_norm, match_type, confidence)`
- `server.js` joins tasks to leads via this table

### What the data actually looks like
- `tasks.lead` column contains person names: "Caspar Heusser", "Laurent Girardeau-Montaut", etc.
- `leads` table has `first_name` and `last_name` columns
- Joining `LOWER(TRIM(tasks.lead))` to `LOWER(TRIM(leads.first_name || ' ' || leads.last_name))` correctly links 29 of 38 leads to their tasks
- Many tasks reference contacts NOT in the Qualified Leads file — this is expected

---

## Success Criteria

1. Tasks are linked to leads by matching `tasks.lead` (person name) to `leads.first_name + ' ' + leads.last_name` — NOT by company name fuzzy matching
2. Each lead in the list and detail view shows its next step:
   - If the lead has open tasks → the most recent open task is displayed as the next step
   - If the lead has NO open tasks → a clear "No next step" warning is displayed (red flag)
3. A `next_steps` table exists for storing suggested next steps (to be populated later by a Claude skill)
4. Users can manually add a next step from the UI (with fields: next_step, owner, due_date, comments)
5. Users can delete a next step from the UI
6. The "Linked Companies" section and "Unmatched" modal are removed (no longer relevant)
7. The fuzzy matching code in `matching.js` is cleaned up (only `normalizeCompany` retained)
8. The attention system flags leads with no open task as needing attention

---

## Task List

### Task 1: Database schema changes (`db.js`)

**Add columns:**
- `leads` table: add `lead_name_norm TEXT` after `company_norm` — stores `LOWER(TRIM(first_name || ' ' || last_name))`
- `tasks` table: add `lead_name_norm TEXT` after `is_lemlist` — stores `LOWER(TRIM(lead))`

**Add table:**
```sql
CREATE TABLE IF NOT EXISTS next_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  next_step TEXT NOT NULL,
  owner TEXT,
  due_date TEXT,
  comments TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
)
```

**Add indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_leads_name_norm ON leads(lead_name_norm)
CREATE INDEX IF NOT EXISTS idx_tasks_lead_name_norm ON tasks(lead_name_norm)
CREATE INDEX IF NOT EXISTS idx_next_steps_lead_id ON next_steps(lead_id)
```

**Keep** `lead_task_links` CREATE TABLE (harmless, avoids errors on existing DBs) but no code should read/write it anymore.

### Task 2: Simplify matching (`matching.js`)

- Keep only `normalizeCompany` and `STRIP_WORDS` (still used for `company_norm` column)
- Remove: `findBestMatch`, `jaccard`, `getTokens`, `noSpaces`, `allTokensContained`
- Update `module.exports` to only export `normalizeCompany`

### Task 3: Update import (`import.js`)

- Remove `findBestMatch` from the `require('./matching')` import
- **Leads insert**: compute `lead_name_norm = ((firstName || '').trim() + ' ' + (lastName || '').trim()).toLowerCase().trim()` and include it as a new column in the INSERT
- **Tasks insert**: compute `lead_name_norm = (row['Lead'] || '').trim().toLowerCase()` and include it as a new column in the INSERT
- **Delete the entire "REBUILD LEAD_TASK_LINKS" block** (lines 123-181 approximately): the leadMap construction, the manual links check, the findBestMatch loop, the insertLink prepared statement — all of it
- **Simplify the summary**: instead of `matched` and `unmatched`, report `linked` (count of leads that have at least one task via name join)
- Update console output accordingly

### Task 4: Update server (`server.js`)

**Rewrite `getLeadTasks` function:**
```javascript
function getLeadTasks(db, leadId, includeLemlist = false) {
  const lemlistFilter = includeLemlist ? '' : 'AND t.is_lemlist = 0';
  const result = db.exec(`
    SELECT t.* FROM tasks t
    INNER JOIN leads l ON t.lead_name_norm = l.lead_name_norm
    WHERE l.lead_id = '${leadId.replace(/'/g, "''")}'
      AND t.lead_name_norm != ''
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
```

**Update `computeAttention`:**
Add a new flag when a lead has tasks but no open ones:
```javascript
if (openTasks.length === 0 && tasks.length > 0) {
  flags.push({ type: 'no_open_task', message: 'No open task — next step needed' });
}
```

**Enrich `GET /api/leads` response:**
For each lead, add to the returned object:
- `open_tasks`: filtered array of tasks where status contains "open" or "not started"
- `has_open_task`: boolean
- `next_step`: the subject of the first (most recent) open task, or null

Also query `next_steps` table for each lead and include:
- `suggested_next_step`: the most recent `next_steps` row (if any), or null

**Update `GET /api/leads/:id/timeline`:**
- Add `nextSteps` to response: query `SELECT * FROM next_steps WHERE lead_id = ? ORDER BY created_at DESC`
- Remove `links` query and `links` from response

**Add new endpoints:**

`POST /api/leads/:id/next-steps` — Create a next step
- Body: `{ next_step, owner, due_date, comments, source? }`
- `source` defaults to `'manual'`
- `created_at` set to `new Date().toISOString()`
- Validate: `next_step` is required
- After insert, `saveDb()`

`DELETE /api/next-steps/:id` — Delete a next step by ID
- `saveDb()` after delete

**Remove endpoints:**
- `GET /api/unmatched`
- `POST /api/links`
- `DELETE /api/links`

### Task 5: Update HTML (`public/index.html`)

**Remove:**
- The `#detail-links` div (Linked Companies section, lines ~98-102)
- The `#unmatched-modal` div (lines ~138-148)

**Add** (between `#detail-alerts` and `#detail-pipeline`):
```html
<div id="detail-next-steps">
  <h3>Next Step</h3>
  <div id="next-steps-content"></div>
  <div id="next-step-form" class="hidden">
    <div class="form-group">
      <label>Next step *</label>
      <input type="text" id="ns-next-step" class="input" placeholder="Describe the next action...">
    </div>
    <div class="form-group">
      <label>Owner</label>
      <input type="text" id="ns-owner" class="input" placeholder="Who is responsible?">
    </div>
    <div class="form-group">
      <label>Due date</label>
      <input type="date" id="ns-due-date" class="input">
    </div>
    <div class="form-group">
      <label>Comments</label>
      <textarea id="ns-comments" class="input" rows="2" placeholder="Additional context..."></textarea>
    </div>
    <div class="form-actions">
      <button id="btn-save-next-step" class="btn btn-primary">Save</button>
      <button id="btn-cancel-next-step" class="btn btn-secondary">Cancel</button>
    </div>
  </div>
  <button id="btn-add-next-step" class="btn btn-secondary">+ Add next step</button>
</div>
```

### Task 6: Update styles (`public/style.css`)

**Add:**
```css
/* Next Steps */
#detail-next-steps { margin-bottom: 24px; }

#detail-next-steps h3 {
  font-size: 14px;
  margin-bottom: 8px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.next-step-item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
  margin-bottom: 6px;
}

.next-step-item.ai-suggested { border-left: 3px solid var(--primary); }

.next-step-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.next-step-text { font-weight: 600; font-size: 13px; flex: 1; }

.next-step-badge {
  font-size: 10px;
  background: var(--primary-light);
  color: var(--primary);
  padding: 2px 8px;
  border-radius: 10px;
}

.next-step-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

.next-step-empty { color: var(--warn); font-size: 13px; padding: 8px 0; }

.no-next-step { color: var(--warn); font-size: 10px; }

.next-step-preview {
  font-size: 10px;
  color: var(--primary);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-delete-next-step {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.form-actions { display: flex; gap: 8px; margin-top: 8px; }

#next-step-form { margin-bottom: 12px; }
```

**Remove:** `.link-chip` and `.link-chip .link-type` rules (no longer used).

### Task 7: Update frontend logic (`public/app.js`)

**Add `renderNextSteps` function:**
- Receives `nextSteps` array and `leadId`
- For each entry, renders: next_step text, owner, due_date, comments, source badge (if `ai_suggested`), delete button
- If `nextSteps` is empty AND lead has no open task, show "No next step defined" warning
- If lead has open tasks, show the most recent open task as the implicit next step (above any DB-stored next steps)
- Wire delete buttons to `DELETE /api/next-steps/:id`, then reload detail

**Add "Add next step" form logic:**
- `#btn-add-next-step` shows the form, hides itself
- `#btn-cancel-next-step` hides form, shows button
- `#btn-save-next-step` POSTs to `/api/leads/:id/next-steps`, reloads detail
- Validate that `ns-next-step` is not empty

**Update lead card rendering (`renderLeadList`):**
In the `.lead-card-footer`, after task count, add:
- If `lead.has_open_task`: show `<span class="next-step-preview">` with truncated next step subject
- If `!lead.has_open_task`: show `<span class="no-next-step">No next step</span>`

**Add utility:**
```javascript
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}
```

**Remove:**
- Links rendering code in `loadDetail` (the `linksEl` block)
- Any unmatched modal code/references

**Update import result display:**
Change from "X companies matched, Y unmatched" to "X leads linked to tasks"

---

## Validation Strategy

### After implementation:
1. **Delete `data/qbr.db`** and re-import: `node import.js`
   - Verify console output shows lead count, task count, and linked count (no more matched/unmatched)
2. **Start server**: `node server.js`, open `http://localhost:3000`
3. **Verify linking correctness**:
   - Click on a lead that has tasks → the timeline should show tasks where `tasks.lead` matches the lead's name
   - Leads without matching tasks should show "No activities recorded"
4. **Verify next step display**:
   - Leads with open tasks → lead card shows next step preview, detail shows open task as next step
   - Leads without open tasks → lead card shows "No next step", detail shows warning, attention flag present
5. **Test manual next step CRUD**:
   - Click "+ Add next step" → fill form → Save → next step appears in detail view
   - Click delete on a next step → it disappears
6. **Verify removed features**:
   - No "Linked Companies" section in detail view
   - No "Unmatched" modal anywhere
   - `/api/unmatched` returns 404
   - `/api/links` POST/DELETE return 404
7. **Verify attention flags**:
   - Leads with no open task show "No open task — next step needed" in alerts
   - Summary card counts reflect the new attention logic

---

## Code Structure Constraints

- **No `any` types, no implicit coercion** — explicit types everywhere
- **KISS** — simplest solution that works
- **YAGNI** — only build what's specified above
- **Vanilla frontend** — no frameworks, no build step
- **sql.js (WASM)** — no native dependencies
- **Structured logging** — use `logger.info(message, { source, ... })` pattern where applicable (current code uses `console.log` — match existing style)
- **Google-style docstrings** on new functions

---

## Future: Claude Skill (NOT in scope now)

A Claude skill will later iterate over leads with no open task, read their task history, call an LLM to determine appropriate next steps, and INSERT rows into the `next_steps` table with `source = 'ai_suggested'`. The schema and UI built now must support this — the `source` field and `ai-suggested` CSS class handle the distinction.
