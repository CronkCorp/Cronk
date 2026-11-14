# 11: Section edits, Version compare and merging

**What to build:** Agents can replace a single section of a Document, addressed by its heading, so their edits are small and rarely conflict. Users can compare any two Versions. When a User's save is refused because the Document changed underneath them, the editor shows the other edit and merges automatically if the edits touched different sections, otherwise lets the User resolve it.

**Blocked by:** 10 (Documents and Versions)

**Status:** ready-for-agent

- [ ] `documents` MCP tool gains `replace_section`, addressed by heading and based on a Version
- [ ] Replacing a section that doesn't exist, or based on an outdated Version, is refused clearly
- [ ] Side-by-side or inline comparison of two Versions in the UI
- [ ] Refused User save shows the other edit; edits to different sections merge automatically
- [ ] Conflicting edits to the same section let the User choose or combine before saving
- [ ] API tests cover section replace and its refusals
