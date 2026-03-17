# Global Rule Sections

Rules and standards for AI-assisted development on this repository.

---

## Core Principles

- **Type safety is non-negotiable.** Every function signature, return value, and data structure must have explicit types. No `any`, no implicit coercion, no untyped boundaries.
- **KISS — Keep It Simple and Stupid.** Prefer the simplest solution that works. Three similar lines are better than a premature abstraction.
- **YAGNI — You Aren't Gonna Need It.** Do not build for hypothetical future requirements. No feature flags, no extensibility hooks, no configurability beyond what is currently needed. If it's not requested, don't build it.

---

## Tech Stack Decisions

| Layer | Choice | Rationale |
|---|---|---|
| **Runtime** | Node.js v24.12 | Available on system, no Python runtime |
| **Database** | SQLite via `sql.js` (WASM) | `better-sqlite3` requires native compilation (node-gyp), which fails without Visual C++ Build Tools. `sql.js` is pure JS/WASM — zero native dependencies. |
| **Excel parsing** | `xlsx` | Reads `.xls` and `.xlsx`, handles cell date serials, no native deps |
| **Web server** | Express | Minimal, well-known, sufficient for local dashboard |
| **Frontend** | Vanilla HTML/CSS/JS | No framework. No build step. No bundler. Direct `<script>` includes. Keeps iteration fast and dependency-free. |
| **Hosting** | Local only (`localhost:3000`) | This is a personal productivity tool, not a deployed service |
| **Project location** | Local disk (`C:\Users\BrunoHuys\sales-dashboard`) | npm/node_modules fail on Google Drive's virtual filesystem (TAR_ENTRY_ERROR). Source Excel files are read from Google Drive at import time. |

---

## Architecture Patterns

### Data flow
```
Excel files (Google Drive) → import.js → SQLite (local) → Express API → Vanilla JS frontend
```

### Company name matching (matching.js)
Custom fuzzy matching at import time, not a SQL feature. Four-stage strategy:
1. **Exact** match on normalized names
2. **Spaceless exact** — collapse all spaces then compare (handles "TotalEnergies" vs "TOTAL ENERGIES GLOBAL")
3. **Contains** — substring match (handles "TAP" in "TAP Air Portugal")
4. **Token overlap** — Jaccard similarity on word tokens

Results are precomputed and stored in `lead_task_links` table. SQL only joins on this table at query time.

### Normalization (normalizeCompany)
Strip diacritics (NFD decompose), lowercase, remove punctuation, remove common business suffixes (Ltd, GmbH, Group, SA, etc.), collapse whitespace.

### Pipeline stage detection (sales-stage.js)
6 stages derived from task Subject keyword patterns. Only tasks with status `Completed - positive outcome` advance a stage. The highest detected stage wins. Stages can be skipped (a lead can go from Demo straight to Commercial).

### Known limitations to address
- **Duplicate company leads**: When multiple leads share the same company name, only the first gets linked to tasks. `lead_task_links` needs one-to-many support.
- **Pipeline visualization**: Currently fills all intermediate stage dots up to the current stage, implying linear progression. Should only fill stages actually detected in task history.

---

## Documentation Standards

### Code docstrings
Use **Google-style docstrings**, optimized for AI agent consumption:

```javascript
/**
 * Brief one-line description of what the function does.
 *
 * Args:
 *   paramName (type): Description of parameter.
 *   paramName (type): Description of parameter.
 *
 * Returns:
 *   type: Description of return value.
 *
 * Performance:
 *   Token usage: ~N tokens per call (if applicable)
 *   Execution time: O(n) / ~Xms typical (if applicable)
 *
 * Example:
 *   const result = myFunction('input');
 *   // => expected output
 */
```

### Tool docstrings (LLM-optimized)
When documenting tools/APIs meant to be called by LLMs, use this format:

```
TOOL: tool_name
DESCRIPTION: What it does in one sentence.
WHEN TO USE: Conditions under which this tool is the right choice.
WHEN NOT TO USE: Common mistakes / wrong tool for the job.
INPUTS:
  - param (type, required/optional): Description. Constraints.
OUTPUTS: Description of return shape.
PERFORMANCE: Token cost, latency, rate limits.
EXAMPLE: Minimal working call.
```

---

## Logging Rules

All logging must be **structured** with keyword arguments only. No string interpolation in log messages.

### Required fields
| Field | Description |
|---|---|
| `source` | Module or function name emitting the log |
| `correlationId` | Request/operation ID for tracing across calls |
| `duration_ms` | Execution time in milliseconds |
| `level` | `debug`, `info`, `warn`, `error` |

### Format
```javascript
logger.info('import completed', {
  source: 'import.runImport',
  correlationId: reqId,
  duration_ms: 1423,
  leads: 38,
  tasks: 720,
  matched: 38
});
```

### Exception logging
Always include full stack trace. Never swallow exceptions silently.

```javascript
logger.error('import failed', {
  source: 'import.runImport',
  correlationId: reqId,
  duration_ms: 230,
  error: err.message,
  stack: err.stack
});
```

### Rules
- No `console.log` in production code — use structured logger
- AI-readable context: every log entry must be parseable without surrounding code
- Correlation IDs must propagate through the full request lifecycle

---

## Testing Patterns

### Structure
Tests live **near the source** they test:

```
matching.js
matching.test.js        ← unit test, right next to source

sales-stage.js
sales-stage.test.js     ← unit test, right next to source

test/
  integration/          ← integration tests only
    import.test.js
    api.test.js
```

### Unit tests
- Marked with `@pytest.mark.unit` (Python) or described in a `describe('unit:')` block (JS)
- No I/O, no database, no network
- Fast: each test < 100ms
- Test one behavior per test case

### Integration tests
- Live in `test/integration/`
- May use real database, real file I/O
- Marked with `@pytest.mark.integration` (Python) or `describe('integration:')` (JS)
- Must clean up after themselves

### Naming convention
```
test_<what>_<condition>_<expected>
```
Example: `test_normalizeCompany_withDiacritics_stripsAccents`
