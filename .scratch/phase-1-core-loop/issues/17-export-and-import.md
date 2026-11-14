# 17: Export and import

**What to build:** An Admin can export the whole Workspace or one Project as a folder of Markdown files with YAML frontmatter (Tickets, Documents with optional Versions, Reports, Comments, Activities, Guidance, Statuses), and import such an export back. A User can also import a plain folder of Markdown files as Documents, with the folder structure becoming the page tree. This fulfils the no-lock-in promise of ADR 0003.

**Blocked by:** 05 (Custom Statuses), 12 (Reports), 13 (Comments and answering questions), 15 (Guidance)

**Status:** ready-for-agent

- [ ] Export of Workspace or Project as a downloadable folder (archive) of Markdown with frontmatter; relations reference Ticket keys
- [ ] Import of that format recreates the same data
- [ ] Import of a plain Markdown folder creates Documents in a page tree mirroring the folders
- [ ] Round-trip API test: export then import into a fresh installation yields the same data
