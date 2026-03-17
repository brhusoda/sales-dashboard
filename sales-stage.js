/**
 * Derive pipeline stage from task subjects.
 *
 * 6 stages (ordered):
 *   0: New Lead (no tasks)
 *   1: Intro Meeting
 *   2: Demo
 *   3: In-depth Demo
 *   4: POC Discussion
 *   5: POC Active
 *   6: Commercial
 */

const STAGES = [
  { id: 0, name: 'New Lead', patterns: [] },
  { id: 1, name: 'Intro Meeting', patterns: ['intro meeting', 'introductory meeting', 'introduction meeting', 'first meeting'] },
  { id: 2, name: 'Demo', patterns: ['demo', 'on site demo', 'soda demo', 'on-site demo'] },
  { id: 3, name: 'In-depth Demo', patterns: ['in-depth demo', 'in depth demo', 'deep dive', 'deepdive'] },
  { id: 4, name: 'POC Discussion', patterns: ['discuss poc', 'poc discussion', 'sandbox', 'poc scope'] },
  { id: 5, name: 'POC Active', patterns: ['poc kick-off', 'poc kickoff', 'training session', 'workshop', 'poc follow'] },
  { id: 6, name: 'Commercial', patterns: ['pricing', 'proposal', 'contract', 'budget', 'commercial', 'negotiation'] },
];

const POSITIVE_STATUS = 'completed - positive outcome';

/**
 * Given an array of tasks (with subject, status fields),
 * return the highest stage reached.
 */
function deriveStage(tasks) {
  if (!tasks || tasks.length === 0) return STAGES[0];

  let maxStage = 0;

  for (const task of tasks) {
    if (!task.subject) continue;
    const subject = task.subject.toLowerCase();
    const isPositive = task.status && task.status.toLowerCase() === POSITIVE_STATUS;

    // Only advance stage on positive-outcome tasks
    if (!isPositive) continue;

    for (let i = STAGES.length - 1; i >= 1; i--) {
      const stage = STAGES[i];
      if (stage.patterns.some(p => subject.includes(p))) {
        if (i > maxStage) maxStage = i;
        break;
      }
    }
  }

  return STAGES[maxStage];
}

/**
 * Return all stage definitions (for frontend rendering).
 */
function getStages() {
  return STAGES;
}

module.exports = { deriveStage, getStages, STAGES };
