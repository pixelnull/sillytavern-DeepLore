# Changelog

## 0.7-ALPHA

### Improvements
- **Accurate token counting** -- Uses SillyTavern's built-in tokenizer instead of the rough `length / 3.5` estimate. Token budgets and stats are now much more accurate. Falls back to estimation if the tokenizer is unavailable.
- **Better recursive scanning** -- Recursive matching now only scans content from newly matched entries each step, avoiding redundant work and preventing wasted cycles when entries reference each other.
- **Runtime settings validation** -- Numeric settings are clamped to valid ranges on load and save. Invalid values (e.g., port > 65535, negative scan depth) are corrected automatically.
- **Consistent CSS naming** -- Renamed all CSS classes and HTML IDs from `obsidian_lorebook_` to `deeplore_` to match the extension's branding.
- **Added package.json** -- Provides version tracking and repository metadata.
- **Added unit tests** -- Test coverage for frontmatter parsing, content cleaning, title extraction, keyword matching, and settings validation. Run with `node tests.js`.

### Internal
- Bumped version to 0.7-ALPHA.

## 0.6-ALPHA

- Initial public release.
- Keyword-triggered lorebook injection from Obsidian vault.
- Recursive scanning, token budgets, configurable injection.
- Server installer scripts.
