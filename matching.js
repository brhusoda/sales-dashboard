/**
 * Company name normalization and fuzzy matching.
 */

// Common suffixes/words to strip for better matching
const STRIP_WORDS = [
  'pvt', 'private', 'limited', 'ltd', 'inc', 'corp', 'corporation',
  'llc', 'llp', 'gmbh', 'sa', 'sas', 'sarl', 'ag', 'bv', 'nv',
  'co', 'company', 'group', 'global', 'international', 'intl',
  'holdings', 'enterprises', 'solutions', 'services', 'technologies',
  'technology', 'tech', 'industries', 'the'
];

/**
 * Normalize a company name for matching:
 * - Strip diacritics (é→e, ö→o, etc.)
 * - Lowercase
 * - Remove punctuation
 * - Remove common suffixes
 * - Collapse whitespace
 */
function normalizeCompany(name) {
  if (!name) return '';

  let n = name
    // NFD decompose then strip combining marks (diacritics)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Lowercase
    .toLowerCase()
    // Remove punctuation except spaces
    .replace(/[^a-z0-9\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // Remove common suffixes
  const words = n.split(' ').filter(w => !STRIP_WORDS.includes(w));
  return words.join(' ').trim() || n;
}

module.exports = { normalizeCompany };
