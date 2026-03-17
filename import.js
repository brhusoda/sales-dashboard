const XLSX = require('xlsx');
const path = require('path');
const { getDb, saveDb } = require('./db');
const { normalizeCompany } = require('./matching');

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
 * Normalize a person name for lead-task matching: lower(trim(name)).
 *
 * Args:
 *   firstName (string): First name.
 *   lastName (string): Last name.
 *
 * Returns:
 *   string: Normalized full name, e.g. "caspar heusser".
 */
function normalizeLeadName(firstName, lastName) {
  return `${(firstName || '').trim()} ${(lastName || '').trim()}`.trim().toLowerCase();
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
         converted, create_date, last_activity, company_norm, lead_name_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let leadCount = 0;
    for (const row of leadsData) {
      const company = row['Company / Account'] || '';
      const firstName = row['First Name'] || '';
      const lastName = row['Last Name'] || '';
      insertLead.run([
        row['Lead ID'] || '',
        firstName,
        lastName,
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
        normalizeLeadName(firstName, lastName),
      ]);
      leadCount++;
    }
    insertLead.free();

    // --- UPSERT TASKS ---
    const insertTask = db.prepare(`
      INSERT OR REPLACE INTO tasks
        (activity_id, date, company, opportunity, contact, lead,
         subject, assigned, priority, status, task, comments,
         company_norm, is_lemlist, lead_name_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let taskCount = 0;
    for (const row of tasksData) {
      const company = row['Company / Account'] || '';
      const subject = row['Subject'] || '';
      const leadName = row['Lead'] || '';
      insertTask.run([
        row['Activity ID'] || '',
        excelDateToISO(row['Date']),
        company,
        row['Opportunity'] || '',
        row['Contact'] || '',
        leadName,
        subject,
        row['Assigned'] || '',
        row['Priority'] || '',
        row['Status'] || '',
        row['Task'] || '',
        row['Comments'] || '',
        normalizeCompany(company),
        isLemlist(subject) ? 1 : 0,
        leadName.trim().toLowerCase(),
      ]);
      taskCount++;
    }
    insertTask.free();

    db.run('COMMIT');
    saveDb();

    const summary = {
      leads: leadCount,
      tasks: taskCount,
    };

    console.log(`Import complete:`);
    console.log(`  Leads: ${leadCount}`);
    console.log(`  Tasks: ${taskCount}`);

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
