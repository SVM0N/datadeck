// Habit-tracker dashboard renderer (+ per-habit timeline). Extracted from
// CardView; reached members are public. Type-only CardView import → no runtime
// cycle. Chart.js is lazy-loaded here (only paid on first dashboard render).
// Covered by test-view-smoke.mjs (with a chart.js stub).

import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { titleCase } from "../utils";

// Lazy-load Chart.js + register the bits we use. Only paid when the dashboard
// view first renders. Sessions that only touch books/movies/quotes/dictionary
// never load Chart.js at all.
type ChartModule = typeof import("chart.js");
let chartModule: ChartModule | null = null;
async function loadChart(): Promise<ChartModule> {
  if (chartModule) return chartModule;
  const mod = await import("chart.js");
  mod.Chart.register(mod.LineController, mod.LineElement, mod.PointElement, mod.LinearScale, mod.CategoryScale, mod.Filler, mod.Tooltip);
  chartModule = mod;
  return mod;
}

export async function renderDashboard(view: CardView, container: HTMLElement): Promise<void> {
  const dateCol = view.getDateCol();
  if (!dateCol) {
    container.createEl("p", { text: "No date column detected.", cls: "csv-empty-state" });
    return;
  }

  const habitCols = view.getBooleanColumns();
  const notesCol = view.getNotesCol();
  const today = view.formatDate(new Date());

  // Sort rows by date
  const sortedRows = [...view.rows].sort((a, b) => {
    return (a[dateCol] ?? "").localeCompare(b[dateCol] ?? "");
  });

  // Find or initialize selected date
  if (!view.selectedDate) view.selectedDate = today;
  let currentRow = sortedRows.find(r => r[dateCol] === view.selectedDate);
  const isToday = view.selectedDate === today;

  container.addClass("csv-dashboard");

  // ── Date Navigator ────────────────────────────────────────────────────────
  // Compute all dates first (includes today even if no entry exists)
  const allDates = [...new Set([...sortedRows.map(r => r[dateCol]), today])].filter(Boolean).sort();

  const nav = container.createDiv({ cls: "csv-dash-nav" });

  const prevBtn = nav.createEl("button", { cls: "csv-dash-nav-btn csv-dash-back-btn", text: "◀" });
  prevBtn.addEventListener("click", () => {
    const idx = allDates.indexOf(view.selectedDate!);
    if (idx > 0) {
      view.selectedDate = allDates[idx - 1];
      view.renderView();
    } else if (idx === -1 && allDates.length > 0) {
      // Selected date not in list, go to most recent existing
      const earlier = allDates.filter(d => d < view.selectedDate!);
      if (earlier.length > 0) {
        view.selectedDate = earlier[earlier.length - 1];
        view.renderView();
      }
    }
  });

  const dateDisplay = nav.createDiv({ cls: "csv-dash-date" });

  // Green dot indicator if it's today
  if (isToday) {
    dateDisplay.createSpan({ cls: "csv-dash-today-dot" });
  }

  const dateSelect = dateDisplay.createEl("select", { cls: "csv-dash-date-select" });

  allDates.forEach(d => {
    const opt = dateSelect.createEl("option", { text: d, value: d });
    if (d === view.selectedDate) opt.selected = true;
  });
  dateSelect.addEventListener("change", () => {
    view.selectedDate = dateSelect.value;
    view.renderView();
  });

  const nextBtn = nav.createEl("button", { cls: "csv-dash-nav-btn", text: "▶" });
  nextBtn.addEventListener("click", () => {
    const idx = allDates.indexOf(view.selectedDate!);
    if (idx >= 0 && idx < allDates.length - 1) {
      view.selectedDate = allDates[idx + 1];
      view.renderView();
    } else if (idx === -1) {
      // Selected date not in list, go to next available
      const later = allDates.filter(d => d > view.selectedDate!);
      if (later.length > 0) {
        view.selectedDate = later[0];
        view.renderView();
      }
    }
  });

  // Only show "Today" button if not already on today
  if (!isToday) {
    const todayBtn = nav.createEl("button", { cls: "csv-dash-today-btn", text: "Today" });
    todayBtn.addEventListener("click", () => {
      view.selectedDate = today;
      view.renderView();
    });
  }

  // ── Add new date if not exists ────────────────────────────────────────────
  if (!currentRow) {
    const addSection = container.createDiv({ cls: "csv-dash-add-section" });
    addSection.createEl("p", { text: `No entry for ${view.selectedDate}` });
    const addBtn = addSection.createEl("button", { cls: "csv-dash-add-btn", text: `+ Add entry for ${view.selectedDate}` });
    addBtn.addEventListener("click", () => {
      const newRow: CSVRow = {};
      view.headers.forEach(h => newRow[h] = "");
      newRow[dateCol] = view.selectedDate!;
      view.rows.push(newRow);
      view.scheduleSave();
      view.renderView();
    });
    // Still show chart and stats below
  }

  // ── Today's Habits ────────────────────────────────────────────────────────
  if (currentRow) {
    const habitsSection = container.createDiv({ cls: "csv-dash-habits" });
    habitsSection.createEl("h3", { text: view.selectedDate === today ? "Today" : view.selectedDate!, cls: "csv-dash-section-title" });

    const habitsGrid = habitsSection.createDiv({ cls: "csv-dash-habits-grid" });

    habitCols.forEach(h => {
      const isChecked = view.isTruthy(currentRow![h]);
      const habitEl = habitsGrid.createDiv({ cls: `csv-dash-habit ${isChecked ? "checked" : ""}` });
      const checkbox = habitEl.createEl("button", { cls: "csv-dash-habit-check", text: isChecked ? "●" : "○" });
      habitEl.createSpan({ cls: "csv-dash-habit-label", text: h });

      checkbox.addEventListener("click", () => {
        currentRow![h] = isChecked ? "0" : "1";
        view.scheduleSave();
        // Toggling a habit on the current day shouldn't reset dashboard
        // scroll — the user may have been looking at habit stats below
        // the fold.
        view.renderViewPreservingScroll();
      });
    });

    // Habits done count
    const doneCount = habitCols.filter(h => view.isTruthy(currentRow![h])).length;
    habitsSection.createDiv({ cls: "csv-dash-habits-count", text: `${doneCount} of ${habitCols.length} complete` });

    // Notes preview
    if (notesCol && currentRow[notesCol]?.trim()) {
      const notesPreview = habitsSection.createDiv({ cls: "csv-dash-notes-preview" });
      notesPreview.createEl("strong", { text: "Notes: " });
      notesPreview.createSpan({ text: currentRow[notesCol].slice(0, 200) + (currentRow[notesCol].length > 200 ? "…" : "") });
    }
  }

  // ── Chart ─────────────────────────────────────────────────────────────────
  const chartSection = container.createDiv({ cls: "csv-dash-chart-section" });
  chartSection.createEl("h3", { text: "Progress", cls: "csv-dash-section-title" });
  const chartWrap = chartSection.createDiv({ cls: "csv-dash-chart-wrap" });
  const canvas = chartWrap.createEl("canvas", { cls: "csv-dash-chart" });

  // Prepare chart data
  const chartLabels = sortedRows.map(r => {
    const d = r[dateCol] ?? "";
    return d.slice(5); // MM-DD format
  });
  const chartData = sortedRows.map(r => {
    return habitCols.filter(h => view.isTruthy(r[h])).length;
  });

  // Destroy previous chart if exists
  if (view.chartInstance) {
    view.chartInstance.destroy();
    view.chartInstance = null;
  }

  // Lazy-load Chart.js — first visit to a habit-tracker file pays the
  // ~200KB Chart.js init; subsequent renders are cached. The dashboard's
  // habit grid + stats render synchronously above, so the page is usable
  // before the chart paints.
  const { Chart } = await loadChart();
  // The view may have been navigated away from while we were loading.
  if (!canvas.isConnected) return;
  view.chartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [{
        label: "Habits done",
        data: chartData,
        borderColor: "#378ADD",
        backgroundColor: "rgba(55,138,221,0.08)",
        borderWidth: 1.5,
        pointRadius: 3,
        tension: 0.3,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: habitCols.length || 8, ticks: { stepSize: 1 } }
      },
      plugins: { tooltip: { enabled: true } }
    }
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  const statsSection = container.createDiv({ cls: "csv-dash-stats-section" });
  statsSection.createEl("h3", { text: "Stats", cls: "csv-dash-section-title" });

  const totalDays = sortedRows.length;
  const totalHabitsDone = sortedRows.reduce((acc, r) => {
    return acc + habitCols.filter(h => view.isTruthy(r[h])).length;
  }, 0);
  const avgPerDay = totalDays > 0 ? (totalHabitsDone / totalDays).toFixed(1) : "0";
  const perfectDays = sortedRows.filter(r => {
    return habitCols.every(h => view.isTruthy(r[h]));
  }).length;

  // Streaks - must account for missing days (gaps break the streak)
  let bestStreak = 0, streak = 0;
  let prevDate: Date | null = null;
  for (const r of sortedRows) {
    const done = habitCols.filter(h => view.isTruthy(r[h])).length;
    const currentDate = view.parseDate(r[dateCol] ?? "");

    // Check if this is a consecutive day (no gap)
    let isConsecutive = true;
    if (prevDate && currentDate) {
      const dayDiff = Math.round((currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
      if (dayDiff !== 1) isConsecutive = false;
    }

    if (done >= 1 && (isConsecutive || prevDate === null)) {
      streak++;
      if (streak > bestStreak) bestStreak = streak;
    } else if (done >= 1) {
      // Had a gap, start new streak
      streak = 1;
      if (streak > bestStreak) bestStreak = streak;
    } else {
      streak = 0;
    }
    prevDate = currentDate;
  }

  // Current streak - check backwards from today, accounting for gaps
  let currentStreak = 0;
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  let expectedDate = todayDate;

  for (let i = sortedRows.length - 1; i >= 0; i--) {
    const rowDate = view.parseDate(sortedRows[i][dateCol] ?? "");
    if (!rowDate) break;

    const dayDiff = Math.round((expectedDate.getTime() - rowDate.getTime()) / (1000 * 60 * 60 * 24));

    // Allow today or yesterday as starting point, then must be consecutive
    if (currentStreak === 0 && dayDiff > 1) break; // Too old to start current streak
    if (currentStreak > 0 && dayDiff !== 1) break; // Gap in streak

    const done = habitCols.filter(h => view.isTruthy(sortedRows[i][h])).length;
    if (done >= 1) {
      currentStreak++;
      expectedDate = rowDate;
    } else {
      break;
    }
  }

  // Format stats like Dataview: "105 days logged · 2.0 avg/day · 0 perfect days · current streak 8d · best streak 90d"
  const statsBar = statsSection.createDiv({ cls: "csv-dash-stats-bar" });
  statsBar.innerHTML = `<strong>${totalDays}</strong> days logged · <strong>${avgPerDay}</strong> avg/day · <strong>${perfectDays}</strong> perfect days · current streak <strong>${currentStreak}d</strong> · best streak <strong>${bestStreak}d</strong>`;

  // ── Per-habit cards ───────────────────────────────────────────────────────
  const cardsSection = container.createDiv({ cls: "csv-dash-cards-section" });
  const cardsGrid = cardsSection.createDiv({ cls: "csv-dash-cards-grid" });

  // Get current year for "this year" stats
  const currentYear = new Date().getFullYear();

  // Habit icons - customize per habit name (fallback to ○)
  const habitIcons: { [key: string]: string } = {
    "language": "○", "read": "≡", "gym": "⊞", "vitamins": "⊙",
    "cardio": "↑", "meditate": "◎", "challenge": "✿", "journal": "✎",
    "exercise": "⊞", "water": "💧", "sleep": "🌙", "study": "📚",
  };

  const habitStats = habitCols.map(h => {
    const doneDays = sortedRows.filter(r => view.isTruthy(r[h]));
    const lastDone = doneDays.length > 0 ? doneDays[doneDays.length - 1][dateCol] : null;

    // Get years with data for this habit
    const yearsWithData = new Set<number>();
    doneDays.forEach(r => {
      const d = view.parseDate(r[dateCol] ?? "");
      if (d) yearsWithData.add(d.getFullYear());
    });

    // Count this year
    const thisYearRows = sortedRows.filter(r => {
      const d = view.parseDate(r[dateCol] ?? "");
      return d && d.getFullYear() === currentYear;
    });
    const doneThisYear = thisYearRows.filter(r => view.isTruthy(r[h])).length;

    return {
      habit: h,
      doneCount: doneDays.length,
      doneThisYear,
      totalThisYear: thisYearRows.length,
      lastDone,
      years: Array.from(yearsWithData).sort()
    };
  }).sort((a, b) => {
    // Sort by last done date (most recent first)
    if (!a.lastDone && !b.lastDone) return 0;
    if (!a.lastDone) return 1;
    if (!b.lastDone) return -1;
    return b.lastDone.localeCompare(a.lastDone);
  });

  habitStats.forEach(({ habit, doneCount, doneThisYear, totalThisYear, lastDone, years }) => {
    const card = cardsGrid.createDiv({ cls: "csv-dash-habit-card" });

    // Header with icon and name
    const icon = habitIcons[habit.toLowerCase()] ?? "○";
    const header = card.createDiv({ cls: "csv-dash-habit-card-header" });
    header.createSpan({ cls: "csv-dash-habit-icon", text: icon });
    header.createSpan({ cls: "csv-dash-habit-card-name", text: titleCase(habit) });

    // Year badges
    if (years.length > 0) {
      const yearBadges = card.createDiv({ cls: "csv-dash-habit-years" });
      yearBadges.setText(years.join(" · "));
    }

    // Stats
    card.createDiv({ cls: "csv-dash-habit-card-thisyear", text: `${doneThisYear} of ${totalThisYear} complete this year` });
    card.createDiv({ cls: "csv-dash-habit-card-alltime", text: `${doneCount} of ${totalDays} all time` });

    // Last logged with formatted date
    if (lastDone) {
      const d = view.parseDate(lastDone);
      const formatted = d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : lastDone;
      card.createDiv({ cls: "csv-dash-habit-card-last", text: `Last logged: ${formatted}` });
    } else {
      card.createDiv({ cls: "csv-dash-habit-card-last", text: "Never logged" });
    }

    // Progress bar
    const pct = totalDays > 0 ? (doneCount / totalDays) * 100 : 0;
    const progressWrap = card.createDiv({ cls: "csv-dash-habit-progress" });
    const progressBar = progressWrap.createDiv({ cls: "csv-dash-habit-progress-bar" });
    progressBar.style.width = `${pct}%`;

    // Click to show per-habit timeline. Re-renders the whole dashboard,
    // which without scroll-preservation would yank the user back to (0,0)
    // — they'd have to scroll down to the same card again to see the
    // timeline that just appeared.
    card.addEventListener("click", () => {
      view.selectedHabit = view.selectedHabit === habit ? null : habit;
      view.renderViewPreservingScroll();
    });
    if (view.selectedHabit === habit) {
      card.addClass("selected");
    }
  });

  // ── Per-habit timeline (if a habit is selected) ───────────────────────────
  if (view.selectedHabit && habitCols.includes(view.selectedHabit)) {
    renderHabitTimeline(view, container, sortedRows, dateCol, view.selectedHabit);
  }
}

function renderHabitTimeline(view: CardView, container: HTMLElement, sortedRows: CSVRow[], dateCol: string, habit: string): void {
  const timelineSection = container.createDiv({ cls: "csv-dash-timeline-section" });
  const header = timelineSection.createDiv({ cls: "csv-dash-timeline-header" });
  header.createEl("h3", { text: `${titleCase(habit)} Timeline`, cls: "csv-dash-section-title" });

  // Year selector
  const yearSelect = header.createEl("select", { cls: "csv-dash-year-select" });
  const availableYears = new Set<number>();
  sortedRows.forEach(r => {
    const d = view.parseDate(r[dateCol] ?? "");
    if (d) availableYears.add(d.getFullYear());
  });
  availableYears.add(new Date().getFullYear());
  Array.from(availableYears).sort().reverse().forEach(y => {
    const opt = yearSelect.createEl("option", { text: String(y), value: String(y) });
    if (y === view.timelineYear) opt.selected = true;
  });
  yearSelect.addEventListener("change", () => {
    view.timelineYear = parseInt(yearSelect.value);
    view.renderViewPreservingScroll();
  });

  const closeBtn = header.createEl("button", { cls: "csv-dash-timeline-close", text: "✕" });
  closeBtn.addEventListener("click", () => {
    view.selectedHabit = null;
    view.renderViewPreservingScroll();
  });

  // Build a map of date -> done status
  const dateMap = new Map<string, boolean>();
  sortedRows.forEach(r => {
    dateMap.set(r[dateCol] ?? "", view.isTruthy(r[habit]));
  });

  // Create calendar-style grid (like GitHub contribution graph)
  const gridWrap = timelineSection.createDiv({ cls: "csv-dash-timeline-grid-wrap" });

  // Month labels row
  const monthRow = gridWrap.createDiv({ cls: "csv-dash-timeline-months" });
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  months.forEach(m => monthRow.createSpan({ cls: "csv-dash-timeline-month-label", text: m }));

  // Grid of days (12 months x ~31 days)
  const grid = gridWrap.createDiv({ cls: "csv-dash-timeline-calendar" });

  // Day labels (1-31)
  const dayLabels = grid.createDiv({ cls: "csv-dash-timeline-day-labels" });
  for (let d = 1; d <= 31; d++) {
    dayLabels.createDiv({ cls: "csv-dash-timeline-day-label", text: d % 5 === 0 || d === 1 ? String(d) : "" });
  }

  // Each month column
  for (let month = 0; month < 12; month++) {
    const monthCol = grid.createDiv({ cls: "csv-dash-timeline-month-col" });
    const daysInMonth = new Date(view.timelineYear, month + 1, 0).getDate();

    for (let day = 1; day <= 31; day++) {
      if (day > daysInMonth) {
        monthCol.createDiv({ cls: "csv-dash-timeline-cell empty" });
        continue;
      }

      const dateStr = `${view.timelineYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const isDone = dateMap.get(dateStr) ?? false;
      const hasEntry = dateMap.has(dateStr);
      const isFuture = new Date(view.timelineYear, month, day) > new Date();

      const cell = monthCol.createDiv({
        cls: `csv-dash-timeline-cell ${isFuture ? "future" : ""} ${isDone ? "done" : ""} ${hasEntry && !isDone ? "missed" : ""} ${!hasEntry && !isFuture ? "no-entry" : ""}`
      });
      cell.title = `${dateStr}: ${isFuture ? "Future" : isDone ? "✓ Done" : hasEntry ? "✗ Missed" : "No entry"}`;
    }
  }

  // Stats for this habit (filtered by selected year)
  const yearRows = sortedRows.filter(r => {
    const d = view.parseDate(r[dateCol] ?? "");
    return d && d.getFullYear() === view.timelineYear;
  });
  const doneDays = yearRows.filter(r => view.isTruthy(r[habit])).length;
  const totalEntries = yearRows.length;

  // Calculate streak for this specific habit
  let habitStreak = 0, habitBestStreak = 0, tempStreak = 0;
  let prevDate: Date | null = null;
  for (const r of sortedRows) {
    const done = view.isTruthy(r[habit]);
    const currentDateParsed = view.parseDate(r[dateCol] ?? "");
    let isConsecutive = true;
    if (prevDate && currentDateParsed) {
      const dayDiff = Math.round((currentDateParsed.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
      if (dayDiff !== 1) isConsecutive = false;
    }
    if (done && (isConsecutive || prevDate === null)) {
      tempStreak++;
      if (tempStreak > habitBestStreak) habitBestStreak = tempStreak;
    } else if (done) {
      tempStreak = 1;
    } else {
      tempStreak = 0;
    }
    prevDate = currentDateParsed;
  }

  // Current streak for this habit
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  let expectedDate = todayDate;
  for (let i = sortedRows.length - 1; i >= 0; i--) {
    const rowDate = view.parseDate(sortedRows[i][dateCol] ?? "");
    if (!rowDate) break;
    const dayDiff = Math.round((expectedDate.getTime() - rowDate.getTime()) / (1000 * 60 * 60 * 24));
    if (habitStreak === 0 && dayDiff > 1) break;
    if (habitStreak > 0 && dayDiff !== 1) break;
    if (view.isTruthy(sortedRows[i][habit])) {
      habitStreak++;
      expectedDate = rowDate;
    } else {
      break;
    }
  }

  const statsEl = timelineSection.createDiv({ cls: "csv-dash-timeline-stats" });
  statsEl.innerHTML = `<strong>${doneDays}</strong> of ${totalEntries} in ${view.timelineYear} · current streak <strong>${habitStreak}d</strong> · best streak <strong>${habitBestStreak}d</strong>`;
}
