# Sales Dashboard

Local web dashboard for reviewing qualified sales leads by cross-referencing them with Salesforce task/activity records. Eliminates the manual process of opening Excel files, filtering by company, and scanning tasks for each lead.

## What it does

- Imports leads and tasks from Salesforce Excel exports into a local SQLite database
- Links tasks to leads by matching person names (the `Lead` column in tasks against `First Name + Last Name` in leads)
- Detects pipeline stage from task subject patterns (Intro Meeting → Demo → POC → Commercial)
- Flags leads needing attention (stale, overdue tasks, no activity, negative outcomes, no next step)
- Tracks next steps per lead (manual entry now, AI-suggested later)
- Provides a filterable, sortable two-panel dashboard with activity timelines

## Quick start

```bash
cd C:\Users\BrunoHuys\sales-dashboard
npm install
node import.js    # imports Excel files into SQLite
node server.js    # starts dashboard
```

Then open **http://localhost:3000**

Or double-click `start.bat` which runs both steps.

## Data sources

The import reads two Excel files from Google Drive:

| File | Contents |
|---|---|
| `QualifiedLeads_*.xlsx` | ~38 qualified leads with contact info, rating, owner, status |
| `Tasks_*.xlsx` | ~720 Salesforce task/activity records |

Default paths are configured in `import.js`. You can also re-import from the dashboard UI with custom file paths.

## Project structure

```
sales-dashboard/
  CLAUDE.md         — AI development rules and standards
  db.js             — SQLite init + schema (leads, tasks, lead_task_links, next_steps)
  matching.js       — Company name normalization (used for company_norm column)
  sales-stage.js    — Pipeline stage detection from task subjects
  import.js         — Excel parsing + upsert into SQLite + lead_name_norm computation
  server.js         — Express API (9 endpoints) + static file serving
  start.bat         — Windows launcher (import + server)
  public/
    index.html      — Single-page dashboard
    style.css       — Layout and theming
    app.js          — Frontend fetch/render/filter/sort logic
  data/
    qbr.db          — SQLite database (auto-created, gitignored)
```

## Features

### Filters
- Company name search (type-ahead)
- Lead owner, rating, stage, task count
- Stale leads only
- Overdue only (leads with open tasks past their date)
- No next step (leads without an open task)

### Sorting
- Company name (A-Z / Z-A)
- Task count (most / fewest)
- Pipeline stage (highest / lowest)
- Last activity (most recent / oldest)
- Attention-first (default)

### Lead detail panel
- Contact info, metadata, rating
- Pipeline stage visualization
- Attention alerts (stale, overdue, open tasks, no next step, negative outcomes, stuck in early stage)
- Next steps section with inline add form (manual entry, AI-suggested source reserved for future use)
- Full activity timeline with expandable comments (individual or expand-all)
- Overdue tasks flagged with red badge and left border in timeline
- Lemlist tasks hidden by default (toggle to show)

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leads` | All leads with computed fields. Filters: `?owner=`, `?rating=`, `?stage=`, `?stale=` |
| GET | `/api/leads/:id/timeline` | Task timeline + stage + next steps for one lead |
| GET | `/api/leads/:id/next-steps` | Next steps for a lead |
| POST | `/api/leads/:id/next-steps` | Add a next step `{ next_step, owner?, due_date?, comments?, source? }` |
| DELETE | `/api/next-steps/:id` | Delete a next step |
| GET | `/api/summary` | Dashboard stats (totals, by-stage, by-owner, needing attention) |
| GET | `/api/owners` | Distinct lead owners for filter dropdown |
| POST | `/api/import` | Re-import from file paths `{ leadsFile, tasksFile }` |

## Tech stack

- **Node.js** v24.12
- **SQLite** via `sql.js` (pure JS/WASM, no native compilation needed)
- **xlsx** for Excel parsing
- **Express** for API server
- **Vanilla HTML/CSS/JS** frontend (no framework, no build step)

## Known limitations

- Pipeline visualization fills all intermediate stages, even if skipped in practice
