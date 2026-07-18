# Personal Branch Policy

This policy file is personal-only: keep it on `personal`; do not add it to customization feature branches or upstream.

- Keep `main` clean and tracking upstream.
- Give each custom change a dedicated, modular feature branch, following existing branch naming conventions, and merge those branches into `personal`.
- Periodically update or rebase customization branches against upstream `main` before rebuilding and merging `personal`.
- Do not implement unrelated customizations directly on `personal`; reserve direct commits there for personal integration policy such as this file.
