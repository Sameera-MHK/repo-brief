# Changelog

All notable changes to this project are documented in this file.

## 0.1.0

Initial release.

- `repobrief generate` writes a Markdown (or `--json`) repository brief.
- `repobrief analyze` prints a concise repository summary.
- Respects `.gitignore`, `.repobriefignore`, `--include` and `--exclude`.
- Built-in exclusions for dependency, build and cache directories, binary files, lockfiles and generated output.
- Secret protection: sensitive files and files containing common key/token patterns are excluded entirely.
- Deterministic, priority-based file selection with `--max-files` and `--max-chars` limits; files are never truncated.
- Output safety: refuses to overwrite repository files, requires `--force` to replace an existing brief.
