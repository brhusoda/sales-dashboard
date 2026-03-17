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

/**
 * Get tokens from a normalized name (for Jaccard similarity).
 */
function getTokens(norm) {
  return new Set(norm.split(' ').filter(w => w.length > 0));
}

/**
 * Jaccard similarity between two sets.
 */
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Remove all spaces from a string (for spaceless comparison).
 */
function noSpaces(s) {
  return s.replace(/\s/g, '');
}

/**
 * Check if all tokens in smaller set exist in larger set.
 */
function allTokensContained(smaller, larger) {
  for (const t of smaller) {
    if (!larger.has(t)) return false;
  }
  return true;
}

/**
 * Match a task company_norm against all lead company_norms.
 * Returns { leadId, matchType, confidence } or null.
 */
function findBestMatch(taskCompanyNorm, leadMap) {
  // leadMap: Map<company_norm, lead_id>

  // 1. Exact match
  if (leadMap.has(taskCompanyNorm)) {
    return { leadId: leadMap.get(taskCompanyNorm), matchType: 'exact', confidence: 1.0 };
  }

  // 1b. Spaceless exact match (handles "totalenergies" vs "total energies")
  const taskNoSpace = noSpaces(taskCompanyNorm);
  for (const [leadNorm, leadId] of leadMap) {
    if (noSpaces(leadNorm) === taskNoSpace) {
      return { leadId, matchType: 'exact', confidence: 0.95 };
    }
  }

  let bestMatch = null;
  let bestConfidence = 0;
  const taskTokens = getTokens(taskCompanyNorm);

  for (const [leadNorm, leadId] of leadMap) {
    const leadTokens = getTokens(leadNorm);

    // 2. Prefix/contains: one contains the other
    if (taskCompanyNorm.includes(leadNorm) || leadNorm.includes(taskCompanyNorm)) {
      const shorter = Math.min(taskCompanyNorm.length, leadNorm.length);
      const longer = Math.max(taskCompanyNorm.length, leadNorm.length);
      const conf = shorter / longer;
      // Lower threshold for short names (e.g., "tap" in "tap air portugal")
      const threshold = shorter <= 5 ? 0.15 : 0.3;
      if (conf > bestConfidence && conf >= threshold) {
        bestConfidence = conf;
        bestMatch = { leadId, matchType: 'contains', confidence: conf };
      }
      continue;
    }

    // 3. All tokens of shorter name appear in longer name
    // e.g., "bunge" tokens {bunge} all in "bunge india" tokens {bunge, india}
    const smallerSet = taskTokens.size <= leadTokens.size ? taskTokens : leadTokens;
    const largerSet = taskTokens.size <= leadTokens.size ? leadTokens : taskTokens;
    if (smallerSet.size > 0 && allTokensContained(smallerSet, largerSet)) {
      const conf = smallerSet.size / largerSet.size;
      if (conf > bestConfidence && conf >= 0.3) {
        bestConfidence = conf;
        bestMatch = { leadId, matchType: 'token_contains', confidence: conf };
      }
      continue;
    }

    // 4. Token overlap (Jaccard)
    const sim = jaccard(taskTokens, leadTokens);
    if (sim > bestConfidence && sim > 0.4) {
      bestConfidence = sim;
      bestMatch = { leadId, matchType: 'token', confidence: sim };
    }
  }

  return bestMatch;
}

module.exports = { normalizeCompany, findBestMatch, jaccard, getTokens };
