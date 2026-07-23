# CSS class reference

Reference doc — load when editing `styles.css` or tracing a visual bug to its rule. For the component each class belongs to, see [architecture.md](architecture.md).

| Class | Where | Description |
|---|---|---|
| `.datadeck-root` | Root | Sets CSS vars, flex column layout |
| `.csv-toolbar` | Both | Top toolbar; `flex-wrap: wrap` so controls drop to a second row on narrow viewports |
| `.csv-toolbar-controls` | Both | Right-hand group; also wraps |
| `.csv-toolbar-title` | Both | Filename header; hidden on `max-width: 600px` (redundant with tab) |
| `.csv-mode-group` | Both | Wrapper around the view-mode dropdown (hidden while mobile search is expanded) |
| `.csv-mode-select` | Both | View-mode `<select>` (Travel/Dashboard/Cards/Kanban/Table/Focus/Stats, filtered by `availableModes`) |
| `.csv-cfg-btn` | Both | "⚙ Config", "💾 Backup", "🎴 Anki" buttons |
| `.csv-cfg-btn-secondary` | Both | Modifier on the three secondary buttons above — hidden on `max-width: 600px` (collapsed into ⋯ overflow) |
| `.csv-cfg-btn-overflow` | Both | ⋯ button shown only on `max-width: 600px`; click opens an Obsidian Menu with Columns / Mobile / Backup |
| `.csv-add-btn` | Both | "+ Add" button |
| `.csv-row-count` | Toolbar | Entry-count chip; hidden on mobile |
| `.csv-kanban-groupbar` | Kanban | "Group by" selector row above the board; `-label` for the caption span |
| `.csv-kanban-board` | Kanban | Horizontal flex container |
| `.csv-kanban-col` | Kanban | Single genre column; phone-scoped to `calc(100vw - 60px)` with scroll-snap |
| `.csv-kanban-col-header` | Kanban | Column title + count |
| `.csv-kanban-col-title` | Kanban | Uses `var(--text-accent)` to match Library headers |
| `.csv-kanban-status-group` | Kanban | Status subgroup within column |
| `.csv-kanban-status-label` | Kanban | Colored status pill |
| `.csv-kanban-card` | Kanban | Individual entry card |
| `.csv-kanban-card-btns` | Kanban | Button row (visible on hover) |
| `.csv-kanban-notes-preview` | Kanban | Plain-text note excerpt; `--empty` modifier hides it; itself click-to-edit |
| `.csv-kanban-notes-editor` | Kanban | Inline textarea wrapper (toggled via `display`) |
| `.csv-select-chip` | Both | Clickable dropdown chip; `.empty` = no value |
| `.csv-chip-value` | Both | Value span inside chip; `max-width: 200px`, ellipsis |
| `.csv-select-picker` | Both | Floating dropdown panel (fixed-positioned) |
| `.csv-picker-search` | Both | Picker search input |
| `.csv-picker-item` | Both | List item; `.active`/`--hover` = current; `.csv-picker-add` = new value |
| `.csv-table` | Table | Main table element |
| `.csv-table-notes-cell` | Table | Notes cell (relative-positioned for expand btn) |
| `.csv-table-expand-btn` | Table | "⤢" button, shown on row hover |
| `.csv-col-resize-handle` | Table | Drag handle on `<th>` right edge |
| `.csv-cell--clipped` | Table | Added at render time when a cell's content overflows its clamp; shows the bottom-fade |
| `.csv-content-area` | Both | Scroll container for view content |
| `.csv-content-area--no-yscroll` | Kanban | Modifier that hides outer y-scroll (kanban supplies its own) |
| `.csv-search-wrap` | Toolbar | Search bar container (`flex: 1` on mobile, `min-width: 0` so it can shrink) |
| `.csv-search-input` | Toolbar | Search input; desktop `width: 180px` (220px on focus); mobile `width: 100% !important` to defeat the focus expansion |
| `.csv-search-clear` | Toolbar | Clear search button (×) |
| `.csv-search-results` | Content | "Found X of Y entries" message |
| `.csv-add-modal` | Modal | Add entry modal content |
| `.csv-modal-form` | Modal | Scrollable form area |
| `.csv-modal-row` | Modal | Label + input pair |
| `.csv-modal-select` | Modal | `<select>` dropdown in FileConfigModal |
| `.csv-modal-checkbox-grid` | Modal | Habit column / cardFields selector grid |
| `.csv-modal-checkbox-label` | Modal | Checkbox + label; `.auto-detected` highlights auto-picked defaults |
| `.csv-modal-dup-hint` | Modal | Amber "already in this file" hint under the Add modal's title input (non-blocking) |
| `.csv-note-expander-modal` | Modal | Wide modal override (`min(780px, 90vw)`) |
| `.csv-expander-header` | Modal | Title row |
| `.csv-expander-fields` | Modal | Flex-wrap row of label/value field pairs |
| `.csv-expander-field-row` | Modal | Single label + value pair |
| `.csv-expander-field-label` | Modal | Uppercase faint label |
| `.csv-expander-field-value` | Modal | Clickable editable value; truncated with ellipsis |
| `.csv-expander-divider` | Modal | Notes section header (label only — Edit toggle removed; click-to-edit) |
| `.csv-expander-notes-label` | Modal | "Notes" column name label |
| `.csv-expander-rendered` | Modal | Markdown rendered view (itself click-to-edit) |
| `.csv-expander-editor` | Modal | Textarea editor view (toggled via `display`) |
| `.csv-expander-textarea` | Modal | Raw markdown textarea |
| `.csv-expander-footer` | Modal | Cancel + Save & close buttons |
| `.csv-dashboard` | Dashboard | Root container with max-width |
| `.csv-dash-nav` | Dashboard | Date navigator bar |
| `.csv-dash-nav-btn` | Dashboard | Prev/next arrow buttons |
| `.csv-dash-date-select` | Dashboard | Date dropdown |
| `.csv-dash-today-badge` | Dashboard | "Today" indicator pill |
| `.csv-dash-today-btn` | Dashboard | "Today" quick nav button |
| `.csv-dash-habits` | Dashboard | Habit toggles section |
| `.csv-dash-habits-grid` | Dashboard | Grid of habit toggle buttons |
| `.csv-dash-habit` | Dashboard | Single habit toggle; `.checked` variant |
| `.csv-dash-habit-check` | Dashboard | Clickable ○/● indicator |
| `.csv-dash-chart-section` | Dashboard | Chart container |
| `.csv-dash-stats-bar` | Dashboard | Stats summary row |
| `.csv-dash-cards-grid` | Dashboard | Per-habit stat cards grid |
| `.csv-dash-habit-card` | Dashboard | Individual habit stat card |
| `.csv-dash-habit-card-header` | Dashboard | Icon + name row |
| `.csv-dash-habit-icon` | Dashboard | Emoji icon for habit |
| `.csv-dash-habit-years` | Dashboard | Year badges (2024 · 2025 · 2026) |
| `.csv-dash-habit-progress` | Dashboard | Progress bar container |
| `.csv-dash-timeline-section` | Dashboard | Per-habit timeline container |
| `.csv-dash-timeline-grid` | Dashboard | Heatmap grid of day cells |
| `.csv-dash-timeline-cell` | Dashboard | Single day cell; `.done`, `.missed`, `.no-entry` |
| `.csv-dash-timeline-month` | Dashboard | Month label in timeline |
| `.csv-library-filters` | Library | Filters bar (flex, gap); also reused by Tasks (project/type/done) |
| `.csv-library-filter-select` | Library | Status/genre/sort dropdowns (also reused by the kanban group-by select and the Tasks project/type/done-status filters) |
| `.csv-library-search` | Library | Search input |
| `.csv-library-sections` | Library | Container for genre sections |
| `.csv-library-section` | Library | Collapsible `<details>` element |
| `.csv-library-section-header` | Library | Genre header with arrow + count |
| `.csv-library-grid` | Library | Card grid (auto-fill columns) |
| `.csv-library-card` | Library | Individual entry card |
| `.csv-library-card-title` | Library | Title with green dot |
| `.csv-library-done-dot` | Library | Green dot for watched/read |
| `.csv-library-card-meta` | Library | Author/year text |
| `.csv-library-card-rating` | Library | Star rating display |
| `.csv-library-card-tags` | Library | Tags container |
| `.csv-library-card-tag` | Library | Individual tag chip |
| `.csv-add-form` | Code block | Mobile add entry form container |
| `.csv-add-trigger` | Code block | Collapsed pill (re-opens the card) |
| `.csv-add-card` | Code block | Expanded grouped card; `.is-updating` adds blue accent ring + tinted title when the date matches an existing row |
| `.csv-add-card-header` / `-title` / `-close` | Code block | Header bar with × close |
| `.csv-add-rows` | Code block | Grouped row list with hairline separators |
| `.csv-add-row` | Code block | Single label/control row; variants: `-date`, `-toggle`, `-field`, `-custom`, `-notes` |
| `.csv-add-row-label` | Code block | Left-aligned field label |
| `.csv-add-row-control` | Code block | Right-aligned input/select |
| `.csv-add-row-textarea` | Code block | Notes textarea (stacked, full width) |
| `.csv-add-switch` / `-input` / `-track` | Code block | iOS-style switch for binary toggle rows |
| `.csv-add-submit` | Code block | Submit button (label flips between "Add" / "Update") |
| `.csv-add-error` | Code block | Error message styling |
| `.csv-refresh-btn` | Code block | Mobile `↻ refresh` button (subtle, no background) |
| `.csv-stats-wrap` | Stats | Centered column (max 720px) for all stats sections |
| `.csv-stats-overview` / `-chip` / `-chip-value` / `-chip-label` | Stats | Top row of stat tiles (entries, done %, avg rating…) — same visual family as travel-view stat tiles |
| `.csv-stats-section` / `-section-title` | Stats | One bar-chart block + its accent-colored uppercase title |
| `.csv-stats-bar-row` / `-label` / `-track` / `-fill` / `-count` | Stats | Grid bar row; fill modifiers `.is-done` (green), `.is-progress` (blue), `.is-dropped` (red), `.is-rating` (amber), default accent |
| `.csv-focus-wrap` | Focus | Centered column (max 640px), `tabindex=0` so ←/→ keys work; `outline: none` |
| `.csv-focus-card` | Focus | The single entry card |
| `.csv-focus-position` | Focus | "n / N" indicator |
| `.csv-focus-title` | Focus | Big title; `pre-wrap` so quote line breaks survive; `.is-clickable` when an expander is available |
| `.csv-focus-sub` / `-notes` / `-meta` | Focus | Author line, rendered-markdown notes body, chip row (reuses `.csv-kanban-chip`) |
| `.csv-focus-nav` / `-nav-btn` / `-nav-rand` | Focus | Prev / 🔀 / next button row; full-width touch targets on mobile |
| `.csv-th-sortable` | Table | Modifier on every `<th>`; pointer cursor + accent hover |
| `.csv-th-sort-indicator` | Table | ▲/▼ span inside the sorted column's `<th>` |
| `.csv-clear-filters-btn` | Library/Kanban/Focus/Tasks | "Clear filters"/"Clear search" button in no-results empty states |
| `.csv-tv-now` / `-now-loc` / `-now-sub` | Travel | "📍 Currently in …" banner under the stats (gold-tinted; only when today is inside a confirmed trip) |
| `.cp-selected` | Travel | Accent stroke + brightness on the selected map country; overrides `.cp-tiny`'s transparent halo stroke |
| `.csv-tv-seg.is-dim` | Travel | Timeline segment dimmed to 0.18 opacity while another country is selected |
| `.csv-tv-row-click` / `.is-selected` | Travel | Clickable Countries-table rows; selected row gets the amber tint |
| `.csv-tv-detailwrap` / `.csv-tv-detail` | Travel | Country detail panel slot under the map / the gold-bordered panel card |
| `.csv-tv-detail-head` / `-flag` / `-titles` / `-name` / `-sub` / `-close` | Travel | Panel header: big flag, country name, totals line, ✕ button |
| `.csv-tv-tl-sub` | Travel | Per-year "Nd · M countries" summary next to the timeline year label |
| `.csv-picker-done` | Both | Done button at the bottom of a multi-select picker (raw Obsidian vars — picker mounts on body, outside the root's --csv-* scope) |
| `.csv-random-card` / `-text` / `-sub` / `-foot` / `-src` / `-btn` | Code block | csv-random quote card (also raw Obsidian vars — renders in regular notes) |
| `.csv-stats-bar-row.is-clickable` | Stats | Status/category bars that jump to the filtered library on click |
| `.csv-timeline-row-label` / `-link` | Timeline | Fixed-width entry label column (axis row's is an empty spacer so the two align); click opens the entry expander |
| `.csv-timeline-axis-track` / `-tick` / `-tick-lbl` | Timeline | Month/year gridlines above the rows (`buildTimelineTicks`) |
| `.csv-timeline-today` / `-today-lbl` | Timeline | Dashed "now" line through every row track / its label on the axis, shown only when today falls inside the plotted domain |
| `.csv-timeline-row-track` | Timeline | Per-row percentage-positioned track the bar is absolutely placed within |
| `.csv-timeline-bar` / `-bar-lbl` | Timeline | Arrow-shaped (clip-path) span from Start → End; `.is-ongoing` (no End value) gets a hatched fill and clamps to today |

## Status colors

Status color variants: `.status-{slug}` where slug = value lowercased, spaces → `-`. Palette:

| Value | Color | CSS var |
|---|---|---|
| `finished` / `read` / `watched` / `seen` / `done` | green | `--csv-green`, `--csv-green-bg` |
| `in-progress` / `reading` / `watching` | blue | `--csv-blue`, `--csv-blue-bg` |
| `not-started` / `to-read` / `unwatched` / `unread` / `todo` / `no` | grey | `--background-modifier-border` + `--text-muted` |
| `dropped` | red | `--csv-red`, `--csv-red-bg` |

Theme palette in `:root` (Apple-muted iOS systemGreen/Blue/Red/Orange — confident-but-quiet on both light and dark themes):

```css
--csv-green:    #30A14E;  --csv-green-bg: rgba(52,199,89,0.13);
--csv-blue:     #2E7CE6;  --csv-blue-bg:  rgba(0,122,255,0.13);
--csv-red:      #D5443B;  --csv-red-bg:   rgba(255,59,48,0.12);
--csv-amber:    #C18000;  --csv-amber-bg: rgba(255,149,0,0.13);
```
