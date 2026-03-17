const XLSX = require('xlsx');
const path = require('path');
const { getDb, saveDb } = require('./db');
const { normalizeCompany, findBestMatch } = require('./matching');

// Default file paths
const DEFAULT_LEADS_FILE = path.resolve('G:/My Drive/Administration/Forecast/QBR/QualifiedLeads_20260316_v2.xls.xlsx');
const DEFAULT_TASKS_FILE = path.resolve('G:/My Drive/Administration/Forecast/QBR/Tasks_20260316.xlsx');

/**
 * Convert Excel serial date to ISO string (YYYY-MM-DD).
 */
function excelDateToISO(serial) {
  if (!serial) return null;
  if (typeof serial === 'string') {
    // Already a date string
    if (/^\d{4}-\d{2}-\d{2}/.test(serial)) return serial.substring(0, 10);
    return serial;
  }
  // Excel serial date: days since 1900-01-01 (with the 1900 leap year bug)
  const epoch = new Date(1899, 11, 30); // Dec 30, 1899
  const date = new Date(epoch.getTime() + serial * 86400000);
  return date.toISOString().substring(0, 10);
}

/**
 * Check if a task subject indicates a lemlist automated email.
 */
function isLemlist(subject) {
  if (!subject) return false;
  return subject.trim().startsWith('[lemlist]');
}

/**
 * Import leads and tasks from Excel files into SQLite.
 */
async function runImport(leadsFile, tasksFile) {
  leadsFile = leadsFile || DEFAULT_LEADS_FILE;
  tasksFile = tasksFile || DEFAULT_TASKS_FILE;

  const db = await getDb();

  // Parse Excel files
  const leadsWb = XLSX.readFile(leadsFile, { cellDates: false });
  const tasksWb = XLSX.readFile(tasksFile, { cellDates: false });

  const leadsSheet = leadsWb.Sheets[leadsWb.SheetNames[0]];
  const tasksSheet = tasksWb.Sheets[tasksWb.SheetNames[0]];

  const leadsData = XLSX.utils.sheet_to_json(leadsSheet);
  const tasksData = XLSX.utils.sheet_to_json(tasksSheet);

  // Begin transaction
  db.run('BEGIN TRANSACTION');

  try {
    // --- UPSERT LEADS ---
    const insertLead = db.prepare(`
      INSERT OR REPLACE INTO leads
        (lead_id, first_name, last_name, title, company, email,
         lead_source, street, rating, lead_owner, lead_status,
         converted, create_date, last_activity, company_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let leadCount = 0;
    for (const row of leadsData) {
      const company = row['Company / Account'] || '';
      insertLead.run([
        row['Lead ID'] || '',
        row['First Name'] || '',
        row['Last Name'] || '',
        row['Title'] || '',
        company,
        row['Email'] || '',
        row['Lead Source'] || '',
        row['Street'] || '',
        row['Rating'] || '',
        row['Lead Owner'] || '',
        row['Lead Status'] || '',
        row['Converted'] || '',
        excelDateToISO(row['Create Date']),
        excelDateToISO(row['Last Activity']),
        normalizeCompany(company),
      ]);
      leadCount++;
    }
    insertLead.free();

    // --- UPSERT TASKS ---
    const insertTask = db.prepare(`
      INSERT OR REPLACE INTO tasks
        (activity_id, date, company, opportunity, contact, lead,
         subject, assigned, priority, status, task, comments,
         company_norm, is_lemlist)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let taskCount = 0;
    for (const row of tasksData) {
      const company = row['Company / Account'] || '';
      const subject = row['Subject'] || '';
      insertTask.run([
        row['Activity ID'] || '',
        excelDateToISO(row['Date']),
        company,
        row['Opportunity'] || '',
        row['Contact'] || '',
        row['Lead'] || '',
        subject,
        row['Assigned'] || '',
        row['Priority'] || '',
        row['Status'] || '',
        row['Task'] || '',
        row['Comments'] || '',
        normalizeCompany(company),
        isLemlist(subject) ? 1 : 0,
      ]);
      taskCount++;
    }
    insertTask.free();

    // --- REBUILD LEAD_TASK_LINKS ---
    // Delete auto-matches but preserve manual overrides
    db.run("DELETE FROM lead_task_links WHERE match_type != 'manual'");

    // Build a map of lead company_norm -> lead_id
    const leadRows = db.exec('SELECT lead_id, company_norm FROM leads');
    const leadMap = new Map();
    if (leadRows.length > 0) {
      for (const row of leadRows[0].values) {
        // Allow multiple leads per company; store first one
        if (!leadMap.has(row[1])) {
          leadMap.set(row[1], row[0]);
        }
      }
    }

    // Get existing manual links to skip
    const manualLinks = new Set();
    const manualRows = db.exec("SELECT lead_id, company_norm FROM lead_task_links WHERE match_type = 'manual'");
    if (manualRows.length > 0) {
      for (const row of manualRows[0].values) {
        manualLinks.add(`${row[0]}|${row[1]}`);
      }
    }

    // Get distinct task company_norms
    const taskCompanyRows = db.exec('SELECT DISTINCT company_norm FROM tasks WHERE company_norm != ""');
    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO lead_task_links (lead_id, company_norm, match_type, confidence)
      VALUES (?, ?, ?, ?)
    `);

    let matchedCount = 0;
    const unmatchedCompanies = [];

    if (taskCompanyRows.length > 0) {
      for (const row of taskCompanyRows[0].values) {
        const taskNorm = row[0];

        // Skip if manual link exists for this company
        let hasManual = false;
        for (const mk of manualLinks) {
          if (mk.endsWith(`|${taskNorm}`)) { hasManual = true; break; }
        }
        if (hasManual) continue;

        const match = findBestMatch(taskNorm, leadMap);
        if (match) {
          insertLink.run([match.leadId, taskNorm, match.matchType, match.confidence]);
          matchedCount++;
        } else {
          // Find original company name for this norm
          const origResult = db.exec(`SELECT DISTINCT company FROM tasks WHERE company_norm = '${taskNorm.replace(/'/g, "''")}'`);
          const origName = origResult.length > 0 ? origResult[0].values[0][0] : taskNorm;
          unmatchedCompanies.push(origName);
        }
      }
    }
    insertLink.free();

    db.run('COMMIT');
    saveDb();

    const summary = {
      leads: leadCount,
      tasks: taskCount,
      matched: matchedCount,
      unmatched: unmatchedCompanies,
    };

    console.log(`Import complete:`);
    console.log(`  Leads:   ${leadCount}`);
    console.log(`  Tasks:   ${taskCount}`);
    console.log(`  Matched: ${matchedCount} task companies → leads`);
    if (unmatchedCompanies.length > 0) {
      console.log(`  Unmatched (${unmatchedCompanies.length}):`);
      for (const c of unmatchedCompanies) {
        console.log(`    - ${c}`);
      }
    }

    return summary;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// Run directly if called from CLI
if (require.main === module) {
  runImport().then(() => {
    console.log('Done.');
  }).catch(err => {
    console.error('Import failed:', err);
    process.exit(1);
  });
}

module.exports = { runImport, DEFAULT_LEADS_FILE, DEFAULT_TASKS_FILE };
