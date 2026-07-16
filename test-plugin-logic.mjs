/**
 * Comprehensive tests for CSV Card View plugin logic
 * Run with: node test-plugin-logic.mjs
 */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = "") {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${msg}\n    Expected: ${expectedStr}\n    Got: ${actualStr}`);
  }
}

function assertThrows(fn, msg = "") {
  try {
    fn();
    throw new Error(`${msg} - Expected function to throw but it didn't`);
  } catch (e) {
    if (e.message.includes("Expected function to throw")) throw e;
    // Expected to throw, test passes
  }
}

// ============================================================================
// Copy of functions from main.ts for testing
// ============================================================================

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

// Copy of tagify from src/utils.ts — turns a project value into a valid
// Obsidian tag body for the project-tag injection in openOrCreateNotes.
function tagify(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Copy of formatRatingForDisplay from src/utils.ts — used by the Library
// card render to turn a Rating cell value into a star string (or "" to skip).
function formatRatingForDisplay(raw, columnName) {
  const v = (raw ?? "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "unrated" || v === "—" || v === "-") return "";
  if (/[★⭐☆]/.test(v)) return v;
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (n >= 1 && n <= 5) return "★".repeat(n);
  }
  const col = columnName.toLowerCase();
  if (!["rating", "score", "score /5"].includes(col)) return "";
  const map = {
    "excellent": "★★★★★", "great": "★★★★★", "good": "★★★★☆",
    "fair": "★★★☆☆", "poor": "★★☆☆☆", "bad": "★☆☆☆☆",
  };
  return map[lower] ?? "";
}

// Copy of resolvePath from src/utils.ts — used by the csv-add code block to
// turn `file: ../data.xlsx` into a real vault path.
function resolvePath(input, baseFolder) {
  if (!input) return input;
  const isRelative = input.startsWith("./") || input.startsWith("../") || input === "." || input === "..";
  if (!isRelative && input.includes("/")) return input;
  if (!isRelative) return baseFolder ? `${baseFolder}/${input}` : input;
  const stack = baseFolder ? baseFolder.split("/").filter(Boolean) : [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  return stack.join("/");
}

// Mirror of src/utils.ts → parseCSV (Papa-backed). Kept as a JS copy because
// these tests run plain `node`, not the bundled plugin. Behaviour must match
// the production wrapper one-for-one — when the wrapper changes, change this.
import Papa from "papaparse";
function parseCSV(raw) {
  if (!raw || !raw.trim()) return { headers: [], rows: [] };
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const headers = (result.meta.fields ?? []).map(String);
  const rows = (result.data ?? []).map(r => {
    const row = {};
    headers.forEach(h => { row[h] = r[h] != null ? String(r[h]) : ""; });
    return row;
  });
  return { headers, rows };
}

// Simulates resolveCol from CardView
function resolveCol(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find(h => h.toLowerCase() === c.toLowerCase());
    if (found) return found;
  }
  return null;
}

// CSV serialization (escape function from doSave)
function escapeCSV(v) {
  return (v.includes(",") || v.includes('"') || v.includes("\n"))
    ? `"${v.replace(/"/g, '""')}"`
    : v;
}

function serializeCSV(headers, rows) {
  return [
    headers.map(escapeCSV).join(","),
    ...rows.map(r => headers.map(h => escapeCSV(r[h] ?? "")).join(","))
  ].join("\n");
}

// ============================================================================
// Tests
// ============================================================================

console.log("=== Filename Sanitization ===\n");

test("sanitizeFilename: removes illegal characters", () => {
  assertEqual(sanitizeFilename('file:name'), "filename");
  assertEqual(sanitizeFilename('file/name'), "filename");
  assertEqual(sanitizeFilename('file\\name'), "filename");
  assertEqual(sanitizeFilename('file*name'), "filename");
  assertEqual(sanitizeFilename('file?name'), "filename");
  assertEqual(sanitizeFilename('file"name'), "filename");
  assertEqual(sanitizeFilename('file<name'), "filename");
  assertEqual(sanitizeFilename('file>name'), "filename");
  assertEqual(sanitizeFilename('file|name'), "filename");
  assertEqual(sanitizeFilename('file#name'), "filename");
  assertEqual(sanitizeFilename('file^name'), "filename");
  assertEqual(sanitizeFilename('file[name]'), "filename");
});

test("sanitizeFilename: collapses whitespace", () => {
  assertEqual(sanitizeFilename('hello   world'), "hello world");
  assertEqual(sanitizeFilename('hello\t\tworld'), "hello world");
  assertEqual(sanitizeFilename('  leading'), "leading");
  assertEqual(sanitizeFilename('trailing  '), "trailing");
});

test("sanitizeFilename: truncates to 100 chars", () => {
  const longName = "a".repeat(150);
  assertEqual(sanitizeFilename(longName).length, 100);
});

test("sanitizeFilename: handles empty string", () => {
  assertEqual(sanitizeFilename(''), "");
  assertEqual(sanitizeFilename('   '), "");
});

test("sanitizeFilename: preserves valid characters", () => {
  assertEqual(sanitizeFilename('Hello World 2024'), "Hello World 2024");
  assertEqual(sanitizeFilename('日本語タイトル'), "日本語タイトル");
  assertEqual(sanitizeFilename('Émile Zola - Germinal'), "Émile Zola - Germinal");
});

test("tagify: lowercases and hyphenates project names", () => {
  assertEqual(tagify('Kitchen Reno'), "kitchen-reno");
  assertEqual(tagify('Q3 Launch!'), "q3-launch");
  assertEqual(tagify('  Side  Project  '), "side-project");
});

test("tagify: keeps unicode letters and nested-tag slashes", () => {
  assertEqual(tagify('Café/Refit'), "café/refit");
  assertEqual(tagify('日本語'), "日本語");
});

test("tagify: returns empty when nothing usable survives", () => {
  assertEqual(tagify('!!!'), "");
  assertEqual(tagify('   '), "");
});

console.log("\n=== CSV Parsing ===\n");

test("parseCSV: handles Windows line endings (CRLF)", () => {
  const csv = "Name,Age\r\nJohn,25\r\nJane,30";
  const result = parseCSV(csv);
  assertEqual(result.headers, ["Name", "Age"]);
  assertEqual(result.rows.length, 2);
});

test("parseCSV: handles mixed line endings", () => {
  const csv = "A,B\nRow1,Val1\r\nRow2,Val2";
  const result = parseCSV(csv);
  assertEqual(result.rows.length, 2);
});

test("parseCSV: handles trailing newlines", () => {
  const csv = "A,B\nRow1,Val1\n\n\n";
  const result = parseCSV(csv);
  assertEqual(result.rows.length, 1);
});

test("parseCSV: handles headers only (no data rows)", () => {
  const csv = "Name,Age,City";
  const result = parseCSV(csv);
  assertEqual(result.headers, ["Name", "Age", "City"]);
  assertEqual(result.rows, []);
});

test("parseCSV: preserves newlines inside quoted fields", () => {
  // Regression: the old hand-rolled parser split on \n before parsing quotes,
  // so a multi-line cell silently truncated. The Papa-backed wrapper keeps
  // the embedded newlines intact — important for long-form Notes / Quote
  // cells in data.xlsx and data.xlsx.
  const csv = `Title,Content
"Post 1","Line 1
Line 2
Line 3"`;
  const result = parseCSV(csv);
  assertEqual(result.headers, ["Title", "Content"]);
  assertEqual(result.rows.length, 1);
  assertEqual(result.rows[0].Title, "Post 1");
  assertEqual(result.rows[0].Content, "Line 1\nLine 2\nLine 3");
});

test("parseCSV: handles fields with only quotes", () => {
  const csv = 'A,B\n"",""';
  const result = parseCSV(csv);
  assertEqual(result.rows[0], { A: "", B: "" });
});

test("parseCSV: handles very long fields", () => {
  const longValue = "x".repeat(10000);
  const csv = `Name,Data\nTest,"${longValue}"`;
  const result = parseCSV(csv);
  assertEqual(result.rows[0].Data, longValue);
});

test("parseCSV: handles single column", () => {
  const csv = "Name\nAlice\nBob";
  const result = parseCSV(csv);
  assertEqual(result.headers, ["Name"]);
  assertEqual(result.rows, [{ Name: "Alice" }, { Name: "Bob" }]);
});

test("parseCSV: handles rows with fewer fields than headers", () => {
  const csv = "A,B,C\n1,2\n3";
  const result = parseCSV(csv);
  assertEqual(result.rows[0], { A: "1", B: "2", C: "" });
  assertEqual(result.rows[1], { A: "3", B: "", C: "" });
});

test("parseCSV: handles rows with more fields than headers", () => {
  const csv = "A,B\n1,2,3,4";
  const result = parseCSV(csv);
  // Extra fields are ignored
  assertEqual(result.rows[0], { A: "1", B: "2" });
});

test("parseCSV: handles special characters in unquoted fields", () => {
  const csv = "Name,Symbol\nAlpha,α\nBeta,β";
  const result = parseCSV(csv);
  assertEqual(result.rows[0].Symbol, "α");
  assertEqual(result.rows[1].Symbol, "β");
});

test("parseCSV: handles duplicate headers", () => {
  // Papa renames duplicate headers with _N suffix rather than letting
  // assignments override each other (which was the prior behaviour). Pinning
  // the new behaviour here so a future regression is visible. Real data
  // doesn't have duplicate headers — this is just for robustness.
  const csv = "Name,Name,Name\nA,B,C";
  const result = parseCSV(csv);
  assertEqual(result.headers, ["Name", "Name_1", "Name_2"]);
  assertEqual(result.rows[0].Name, "A");
  assertEqual(result.rows[0].Name_1, "B");
  assertEqual(result.rows[0].Name_2, "C");
});

console.log("\n=== Column Resolution ===\n");

test("resolveCol: finds exact match", () => {
  const headers = ["Title", "Author", "Notes"];
  assertEqual(resolveCol(headers, ["Notes"]), "Notes");
});

test("resolveCol: case-insensitive matching", () => {
  const headers = ["TITLE", "author", "NoTeS"];
  assertEqual(resolveCol(headers, ["title"]), "TITLE");
  assertEqual(resolveCol(headers, ["AUTHOR"]), "author");
  assertEqual(resolveCol(headers, ["notes"]), "NoTeS");
});

test("resolveCol: returns first match from candidates", () => {
  const headers = ["Summary", "Notes", "Description"];
  assertEqual(resolveCol(headers, ["Notes", "Summary", "Description"]), "Notes");
  assertEqual(resolveCol(headers, ["Review", "Summary", "Notes"]), "Summary");
});

test("resolveCol: returns null when no match", () => {
  const headers = ["Title", "Author"];
  assertEqual(resolveCol(headers, ["Notes", "Description"]), null);
});

test("resolveCol: handles empty headers", () => {
  assertEqual(resolveCol([], ["Notes"]), null);
});

test("resolveCol: handles empty candidates", () => {
  const headers = ["Title", "Notes"];
  assertEqual(resolveCol(headers, []), null);
});

test("resolveCol: notes column fallback chain", () => {
  const notesCandidates = [
    "Notes", "notes", "Note", "note",
    "Summary", "summary",
    "Review", "review",
    "Quote", "quote", "Quotes", "quotes",
    "Comment", "comment", "Comments", "comments",
    "Description", "description",
    "Annotation", "annotation",
  ];

  assertEqual(resolveCol(["Review", "Data"], notesCandidates), "Review");
  assertEqual(resolveCol(["Data", "summary"], notesCandidates), "summary");
  assertEqual(resolveCol(["Annotation", "Quote"], notesCandidates), "Quote");
});

test("resolveCol: category column fallback chain", () => {
  const categoryCandidates = [
    "Category", "category",
    "Categories", "categories",
    "Genre", "genre", "Genres", "genres",
    "Type", "type", "Types", "types",
    "Tag", "tag", "Tags", "tags",
  ];

  assertEqual(resolveCol(["Genre", "Type"], categoryCandidates), "Genre");
  assertEqual(resolveCol(["tags", "section"], categoryCandidates), "tags");
});

test("resolveCol: status column fallback chain", () => {
  const statusCandidates = [
    "Status", "status",
    "State", "state",
    "Progress", "progress",
    "Stage", "stage",
    "Read", "read",
  ];

  // Candidate order determines priority - "State" comes before "Progress" in candidates
  assertEqual(resolveCol(["Progress", "State"], statusCandidates), "State");
  assertEqual(resolveCol(["Progress", "Stage"], statusCandidates), "Progress");
  assertEqual(resolveCol(["read", "done"], statusCandidates), "read");
});

console.log("\n=== CSV Serialization (Round-trip) ===\n");

test("serializeCSV: basic round-trip", () => {
  const original = "Name,Age\nJohn,25\nJane,30";
  const parsed = parseCSV(original);
  const serialized = serializeCSV(parsed.headers, parsed.rows);
  const reparsed = parseCSV(serialized);
  assertEqual(reparsed.headers, parsed.headers);
  assertEqual(reparsed.rows, parsed.rows);
});

test("serializeCSV: preserves quoted fields", () => {
  const headers = ["Name", "Bio"];
  const rows = [{ Name: "John", Bio: "Hello, World" }];
  const serialized = serializeCSV(headers, rows);
  assertEqual(serialized, 'Name,Bio\nJohn,"Hello, World"');
});

test("serializeCSV: escapes quotes in values", () => {
  const headers = ["Name", "Quote"];
  const rows = [{ Name: "John", Quote: 'He said "Hello"' }];
  const serialized = serializeCSV(headers, rows);
  assertEqual(serialized, 'Name,Quote\nJohn,"He said ""Hello"""');
});

test("serializeCSV: handles empty values", () => {
  const headers = ["A", "B", "C"];
  const rows = [{ A: "1", B: "", C: "3" }];
  const serialized = serializeCSV(headers, rows);
  assertEqual(serialized, "A,B,C\n1,,3");
});

test("serializeCSV: handles newlines in values", () => {
  const headers = ["Name", "Notes"];
  const rows = [{ Name: "Test", Notes: "Line1\nLine2" }];
  const serialized = serializeCSV(headers, rows);
  assertEqual(serialized, 'Name,Notes\nTest,"Line1\nLine2"');
});

console.log("\n=== Edge Cases & Error Handling ===\n");

test("parseCSV: handles null-ish input gracefully", () => {
  assertEqual(parseCSV(""), { headers: [], rows: [] });
  assertEqual(parseCSV("   "), { headers: [], rows: [] });
  assertEqual(parseCSV("\n\n\n"), { headers: [], rows: [] });
});

test("sanitizeFilename: handles all illegal chars at once", () => {
  const nasty = '\\/:*?"<>|#^[]';
  assertEqual(sanitizeFilename(nasty), "");
});

test("sanitizeFilename: handles filename with only spaces and illegal chars", () => {
  assertEqual(sanitizeFilename('  :  :  '), "");
});

test("parseCSV: handles comma-only row", () => {
  const csv = "A,B,C\n,,";
  const result = parseCSV(csv);
  assertEqual(result.rows[0], { A: "", B: "", C: "" });
});

test("parseCSV: handles field that is just escaped quotes", () => {
  const csv = 'A\n""""';
  const result = parseCSV(csv);
  assertEqual(result.rows[0].A, '"');
});

test("parseCSV: handles multiple consecutive quotes", () => {
  const csv = 'A\n""""""';
  const result = parseCSV(csv);
  assertEqual(result.rows[0].A, '""');
});

test("parseCSV: handles unclosed quote at end of field", () => {
  // This is malformed CSV - document current behavior
  const csv = 'A,B\n"unclosed,next';
  const result = parseCSV(csv);
  // Current parser treats everything after opening quote as part of field
  // until closing quote or end of line
});

test("resolveCol: handles headers with leading/trailing spaces", () => {
  // This tests that the match is exact (spaces matter)
  const headers = [" Notes ", "Notes"];
  assertEqual(resolveCol(headers, ["Notes"]), "Notes");
  // " Notes " won't match "Notes" due to spaces
  assertEqual(resolveCol([" Notes "], ["Notes"]), null);
});

test("escapeCSV: handles various special cases", () => {
  assertEqual(escapeCSV("normal"), "normal");
  assertEqual(escapeCSV("with,comma"), '"with,comma"');
  assertEqual(escapeCSV('with"quote'), '"with""quote"');
  assertEqual(escapeCSV("with\nnewline"), '"with\nnewline"');
  assertEqual(escapeCSV(""), "");
  assertEqual(escapeCSV(","), '","');
});

// ============================================================================
// New Feature Tests
// ============================================================================

console.log("\n=== Title Case Function ===\n");

function titleCase(str) {
  return str.split(/[\s_-]+/).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

test("titleCase: basic words", () => {
  assertEqual(titleCase("hello"), "Hello");
  assertEqual(titleCase("WORLD"), "World");
  assertEqual(titleCase("hello world"), "Hello World");
});

test("titleCase: handles underscores and dashes", () => {
  assertEqual(titleCase("first_name"), "First Name");
  assertEqual(titleCase("last-name"), "Last Name");
  assertEqual(titleCase("user_first_name"), "User First Name");
});

test("titleCase: handles mixed case", () => {
  assertEqual(titleCase("hELLO wORLD"), "Hello World");
  assertEqual(titleCase("VITAMINS"), "Vitamins");
  assertEqual(titleCase("cardio"), "Cardio");
});

console.log("\n=== Binary Column Detection ===\n");

function isBinaryColumn(values) {
  const binaryPatterns = ["0", "1", "true", "false", "yes", "no", ""];
  const normalized = values.map(v => (v ?? "").toLowerCase().trim());
  return normalized.length > 0 && normalized.every(v => binaryPatterns.includes(v));
}

test("isBinaryColumn: detects 0/1 columns", () => {
  assertEqual(isBinaryColumn(["0", "1", "1", "0"]), true);
  assertEqual(isBinaryColumn(["0", "1", "", "0"]), true);
});

test("isBinaryColumn: detects true/false columns", () => {
  assertEqual(isBinaryColumn(["true", "false", "true"]), true);
  assertEqual(isBinaryColumn(["TRUE", "FALSE"]), true);
});

test("isBinaryColumn: detects yes/no columns", () => {
  assertEqual(isBinaryColumn(["yes", "no", "yes"]), true);
  assertEqual(isBinaryColumn(["YES", "NO", ""]), true);
});

test("isBinaryColumn: rejects non-binary columns", () => {
  assertEqual(isBinaryColumn(["apple", "banana"]), false);
  assertEqual(isBinaryColumn(["0", "1", "2"]), false);
  assertEqual(isBinaryColumn(["yes", "no", "maybe"]), false);
});

console.log("\n=== Date Column Detection ===\n");

function isDateColumn(headerName, sampleValues) {
  const hLower = headerName.toLowerCase();
  if (["date", "day", "datum"].includes(hLower)) return true;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  return sampleValues.length > 0 && sampleValues.every(v => datePattern.test(v));
}

test("isDateColumn: detects by name", () => {
  assertEqual(isDateColumn("date", []), true);
  assertEqual(isDateColumn("Date", []), true);
  assertEqual(isDateColumn("DAY", []), true);
  assertEqual(isDateColumn("datum", []), true);
});

test("isDateColumn: detects by value pattern", () => {
  assertEqual(isDateColumn("created", ["2024-01-15", "2024-02-20"]), true);
  assertEqual(isDateColumn("timestamp", ["2024-01-01", "2024-12-31"]), true);
});

test("isDateColumn: rejects non-date columns", () => {
  assertEqual(isDateColumn("name", ["John", "Jane"]), false);
  assertEqual(isDateColumn("year", ["2024", "2025"]), false);
  assertEqual(isDateColumn("time", ["10:30", "14:45"]), false);
});

console.log("\n=== Search Filtering ===\n");

function filterRows(rows, headers, query) {
  if (!query.trim()) return rows;
  const q = query.toLowerCase().trim();
  return rows.filter(row => {
    return headers.some(h => {
      const val = row[h] ?? "";
      return val.toLowerCase().includes(q);
    });
  });
}

test("filterRows: empty query returns all rows", () => {
  const rows = [{ Name: "John" }, { Name: "Jane" }];
  assertEqual(filterRows(rows, ["Name"], ""), rows);
  assertEqual(filterRows(rows, ["Name"], "   "), rows);
});

test("filterRows: filters by partial match", () => {
  const rows = [
    { Name: "John Doe", City: "NYC" },
    { Name: "Jane Smith", City: "LA" },
    { Name: "Bob Johnson", City: "NYC" }
  ];
  assertEqual(filterRows(rows, ["Name", "City"], "john").length, 2); // John Doe, Bob Johnson
  assertEqual(filterRows(rows, ["Name", "City"], "NYC").length, 2);
  assertEqual(filterRows(rows, ["Name", "City"], "jane").length, 1);
});

test("filterRows: case insensitive", () => {
  const rows = [{ Name: "JOHN" }, { Name: "john" }, { Name: "Jane" }];
  assertEqual(filterRows(rows, ["Name"], "john").length, 2);
  assertEqual(filterRows(rows, ["Name"], "JOHN").length, 2);
});

test("filterRows: searches across all specified columns", () => {
  const rows = [
    { Title: "Book A", Author: "Smith" },
    { Title: "Book B", Author: "Jones" }
  ];
  assertEqual(filterRows(rows, ["Title", "Author"], "smith").length, 1);
  assertEqual(filterRows(rows, ["Title"], "smith").length, 0); // Only searching Title
});

console.log("\n=== Date String Conversion ===\n");

// Simulates the pattern used in mobile dashboard for safe date conversion
function toDateString(dateVal) {
  return dateVal?.toString?.() ?? String(dateVal ?? "");
}

test("toDateString: handles string dates", () => {
  assertEqual(toDateString("2025-05-22"), "2025-05-22");
  assertEqual(toDateString("2025-01-01"), "2025-01-01");
});

test("toDateString: handles null/undefined", () => {
  assertEqual(toDateString(null), "");
  assertEqual(toDateString(undefined), "");
});

test("toDateString: handles objects with toString", () => {
  const luxonLike = { toString: () => "2025-05-22" };
  assertEqual(toDateString(luxonLike), "2025-05-22");
});

test("toDateString: handles Date objects", () => {
  const date = new Date("2025-05-22T00:00:00Z");
  const result = toDateString(date);
  // Date.toString() returns something like "Thu May 22 2025..."
  assertEqual(result.includes("2025"), true);
});

test("toDateString: slice for MM-DD works after conversion", () => {
  assertEqual(toDateString("2025-05-22").slice(5), "05-22");
  assertEqual(toDateString("2025-01-15").slice(5), "01-15");
  // Even if object, after toString and slice
  const luxonLike = { toString: () => "2025-12-31" };
  assertEqual(toDateString(luxonLike).slice(5), "12-31");
});

console.log("\n=== Duplicate Entry Detection ===\n");

// Simulates the duplicate detection logic from csv-add form
function findExistingRowByDate(rows, dateCol, dateVal) {
  return rows.findIndex(r => r[dateCol] === dateVal);
}

function mergeHabitEntry(existingRow, newRow, headers, binaryCols) {
  headers.forEach(h => {
    if (binaryCols.includes(h)) {
      // For binary cols, always use the new toggle state
      existingRow[h] = newRow[h];
    } else if ((newRow[h] ?? "").trim()) {
      // For other cols, only update if new value is non-empty
      existingRow[h] = newRow[h];
    }
  });
  return existingRow;
}

test("findExistingRowByDate: finds matching date", () => {
  const rows = [
    { date: "2025-05-20", vitamins: "1" },
    { date: "2025-05-21", vitamins: "0" },
    { date: "2025-05-22", vitamins: "1" }
  ];
  assertEqual(findExistingRowByDate(rows, "date", "2025-05-21"), 1);
  assertEqual(findExistingRowByDate(rows, "date", "2025-05-22"), 2);
});

test("findExistingRowByDate: returns -1 for no match", () => {
  const rows = [
    { date: "2025-05-20", vitamins: "1" },
    { date: "2025-05-21", vitamins: "0" }
  ];
  assertEqual(findExistingRowByDate(rows, "date", "2025-05-25"), -1);
  assertEqual(findExistingRowByDate(rows, "date", ""), -1);
});

test("mergeHabitEntry: updates binary cols with new values", () => {
  const existing = { date: "2025-05-22", vitamins: "0", gym: "0", notes: "old note" };
  const newRow = { date: "2025-05-22", vitamins: "1", gym: "1", notes: "" };
  const headers = ["date", "vitamins", "gym", "notes"];
  const binaryCols = ["vitamins", "gym"];

  const result = mergeHabitEntry(existing, newRow, headers, binaryCols);
  assertEqual(result.vitamins, "1");
  assertEqual(result.gym, "1");
  assertEqual(result.notes, "old note"); // Preserved because new value is empty
});

test("mergeHabitEntry: preserves existing non-empty values when new is empty", () => {
  const existing = { date: "2025-05-22", vitamins: "1", notes: "important note" };
  const newRow = { date: "2025-05-22", vitamins: "0", notes: "" };
  const headers = ["date", "vitamins", "notes"];
  const binaryCols = ["vitamins"];

  const result = mergeHabitEntry(existing, newRow, headers, binaryCols);
  assertEqual(result.vitamins, "0"); // Binary col updated
  assertEqual(result.notes, "important note"); // Non-binary preserved
});

test("mergeHabitEntry: updates non-binary with new non-empty value", () => {
  const existing = { date: "2025-05-22", notes: "old" };
  const newRow = { date: "2025-05-22", notes: "new note" };
  const headers = ["date", "notes"];
  const binaryCols = [];

  const result = mergeHabitEntry(existing, newRow, headers, binaryCols);
  assertEqual(result.notes, "new note");
});

console.log("\n=== Sort Order ===\n");

function sortByDate(rows, dateCol, newestFirst) {
  return [...rows].sort((a, b) => {
    const dateA = a[dateCol] ?? "";
    const dateB = b[dateCol] ?? "";
    const cmp = dateA.localeCompare(dateB);
    return newestFirst ? -cmp : cmp;
  });
}

test("sortByDate: newest first", () => {
  const rows = [
    { date: "2025-05-20" },
    { date: "2025-05-22" },
    { date: "2025-05-21" }
  ];
  const sorted = sortByDate(rows, "date", true);
  assertEqual(sorted[0].date, "2025-05-22");
  assertEqual(sorted[1].date, "2025-05-21");
  assertEqual(sorted[2].date, "2025-05-20");
});

test("sortByDate: oldest first", () => {
  const rows = [
    { date: "2025-05-22" },
    { date: "2025-05-20" },
    { date: "2025-05-21" }
  ];
  const sorted = sortByDate(rows, "date", false);
  assertEqual(sorted[0].date, "2025-05-20");
  assertEqual(sorted[1].date, "2025-05-21");
  assertEqual(sorted[2].date, "2025-05-22");
});

// ============================================================================
// Rating display
// ============================================================================

console.log("\n=== formatRatingForDisplay ===\n");

test("rating: empty value → blank (skipped)", () => {
  assertEqual(formatRatingForDisplay("", "Rating"), "");
  assertEqual(formatRatingForDisplay("   ", "Rating"), "");
});

test("rating: 'unrated' / em-dash / hyphen → blank", () => {
  assertEqual(formatRatingForDisplay("unrated", "Rating"), "");
  assertEqual(formatRatingForDisplay("Unrated", "Rating"), "");
  assertEqual(formatRatingForDisplay("—", "Rating"), "");
  assertEqual(formatRatingForDisplay("-", "Rating"), "");
});

test("rating: already-star glyphs pass through (★)", () => {
  assertEqual(formatRatingForDisplay("★★★★", "Rating"), "★★★★");
  assertEqual(formatRatingForDisplay("★★★☆☆", "Rating"), "★★★☆☆");
});

test("rating: already-star glyphs pass through (⭐ legacy)", () => {
  assertEqual(formatRatingForDisplay("⭐⭐⭐", "Rating"), "⭐⭐⭐");
});

test("rating: numeric 1–5 → ★ repeated", () => {
  assertEqual(formatRatingForDisplay("3", "Rating"), "★★★");
  assertEqual(formatRatingForDisplay("5", "Rating"), "★★★★★");
});

test("rating: numeric out of range → blank", () => {
  assertEqual(formatRatingForDisplay("0", "Rating"), "");
  assertEqual(formatRatingForDisplay("6", "Rating"), "");
});

test("rating: text labels map via formatRating", () => {
  assertEqual(formatRatingForDisplay("excellent", "Rating"), "★★★★★");
  assertEqual(formatRatingForDisplay("Good", "Rating"), "★★★★☆");
});

test("rating: unknown text on Rating column → blank", () => {
  assertEqual(formatRatingForDisplay("amazing", "Rating"), "");
});

test("rating: non-Rating column with unknown text → blank", () => {
  assertEqual(formatRatingForDisplay("anything", "Notes"), "");
});

// ============================================================================
// Path resolution (csv-add file:)
// ============================================================================

console.log("\n=== resolvePath ===\n");

test("resolvePath: sibling file (no slash)", () => {
  assertEqual(resolvePath("data.xlsx", "Library/Data"), "Library/Data/data.xlsx");
});

test("resolvePath: sibling file with empty baseFolder (vault root note)", () => {
  assertEqual(resolvePath("data.xlsx", ""), "data.xlsx");
});

test("resolvePath: vault-relative (slash, no leading dot)", () => {
  assertEqual(resolvePath("Library/Data/data.xlsx", "anywhere/else"), "Library/Data/data.xlsx");
});

test("resolvePath: ../ walks up one folder", () => {
  assertEqual(resolvePath("../data.xlsx", "Library/Data/Mobile"), "Library/Data/data.xlsx");
});

test("resolvePath: ../../ walks up two folders", () => {
  assertEqual(resolvePath("../../shared.xlsx", "a/b/c/d"), "a/b/shared.xlsx");
});

test("resolvePath: ./ resolves to sibling", () => {
  assertEqual(resolvePath("./data.xlsx", "Library/Data"), "Library/Data/data.xlsx");
});

test("resolvePath: mixed segments (../sub/file.xlsx)", () => {
  assertEqual(resolvePath("../Other/file.xlsx", "Library/Data/Mobile"), "Library/Data/Other/file.xlsx");
});

test("resolvePath: walking past vault root clamps at root", () => {
  assertEqual(resolvePath("../../../data.xlsx", "Library"), "data.xlsx");
});

test("resolvePath: empty input passes through", () => {
  assertEqual(resolvePath("", "Library/Data"), "");
});

console.log("\n=== migrateFileConfigKey ===\n");

// Mirror of src/utils.ts → migrateFileConfigKey. Backs the vault.on("rename")
// hook in main.ts so per-file config (cardFields, defaultMode, etc.) follows
// the file when the user moves or renames it inside Obsidian.
function migrateFileConfigKey(configs, oldPath, newPath) {
  if (!configs[oldPath]) return configs;
  if (oldPath === newPath) return configs;
  if (!configs[newPath]) configs[newPath] = configs[oldPath];
  delete configs[oldPath];
  return configs;
}

test("migrateFileConfigKey: moves entry from old key to new", () => {
  const configs = { "Library/old.xlsx": { defaultMode: "library" } };
  migrateFileConfigKey(configs, "Library/old.xlsx", "Library/new.xlsx");
  assertEqual(configs, { "Library/new.xlsx": { defaultMode: "library" } });
});

test("migrateFileConfigKey: no-op if old key absent", () => {
  const configs = { "Library/other.xlsx": { defaultMode: "table" } };
  migrateFileConfigKey(configs, "Library/missing.xlsx", "Library/new.xlsx");
  assertEqual(configs, { "Library/other.xlsx": { defaultMode: "table" } });
});

test("migrateFileConfigKey: no-op if old and new path are equal", () => {
  const configs = { "Library/same.xlsx": { defaultMode: "library" } };
  migrateFileConfigKey(configs, "Library/same.xlsx", "Library/same.xlsx");
  assertEqual(configs, { "Library/same.xlsx": { defaultMode: "library" } });
});

test("migrateFileConfigKey: caller-set new entry wins, old still cleared", () => {
  // If somehow the new path already has a config (shouldn't happen via
  // a real rename, but defensive), prefer the existing entry and drop
  // the orphan rather than silently overwrite the user's later choice.
  const configs = {
    "Library/old.xlsx": { defaultMode: "library" },
    "Library/new.xlsx": { defaultMode: "table" },
  };
  migrateFileConfigKey(configs, "Library/old.xlsx", "Library/new.xlsx");
  assertEqual(configs, { "Library/new.xlsx": { defaultMode: "table" } });
});

// ============================================================================
// Travel view analysis (src/travel-data.ts)
// ============================================================================
// Guards the overlap/dedup rules behind the "travel" view against a synthetic
// fixture (sample-data/travel_flat.csv — no personal data). Builds the real TS
// module with esbuild so the assertions exercise shipping code, not a copy.
{
  const esbuild = (await import("esbuild")).default;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  const entry = fileURLToPath(new URL("./src/travel-data.ts", import.meta.url));
  const out = path.join(os.tmpdir(), `travel-data.${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, logLevel: "error" });
  const { analyzeTravel, currentStay } = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });

  // Inlined synthetic fixture (was sample-data/travel_flat.csv) — the repo
  // ships no data files; tests carry their own fixtures.
  const csv = `date_entered,date_left,country,city,visa_status,notes,source,resolved
2020-01-01,2020-01-11,FR,Paris,Tourist,,confirmed,
2020-02-01,2020-02-01,JP,Tokyo,Tourist,,confirmed,
2021-06-01,2021-09-01,US,"New York, NY",F-1,School,confirmed,
,,BR,,Tourist,Carnival someday,confirmed,
2019-05-??,2019-05-??,DE,,Tourist,,confirmed,
2020-01-05,2020-01-07,FR,Lyon,,photo-inferred,inferred,
2022-03-01,2022-03-10,IT,Rome,,photo-inferred,inferred,
2021-07-01,2021-07-05,GB,London,,photo-inferred,inferred,
2021-07-01,2021-07-05,GB,London,,CONFLICT: photos say GB but confirmed says US,conflict,
`;
  const rows = Papa.parse(csv, { header: true, skipEmptyLines: true }).data;
  const m = analyzeTravel(rows);

  test("travel: source filtering — confirmed/inferred/conflict row counts", () => {
    assertEqual([m.confirmed.length, m.inferred.length, m.conflicts.length], [5, 3, 1]);
  });
  test("travel: confirmed country set (gold) size", () => {
    assertEqual(m.confirmedCountries.size, 5);
  });
  test("travel: inferred-only (blue) excludes confirmed, keeps overlap-masked GB", () => {
    // FR is confirmed → not blue. GB's only inferred row overlaps a confirmed
    // US range (so it's masked from the timeline) but GB is still photo-only → blue.
    assertEqual([...m.inferredOnlyCountries].sort(), ["GB", "IT"]);
  });
  test("travel: all countries = confirmed ∪ inferred", () => {
    assertEqual(m.allCountries.size, 7);
  });
  test("travel: day totals — min-1 same-day, undated=0, partial-date=0", () => {
    // FR 10 + JP 1 + US 92 + BR 0 (undated) + DE 0 (2019-05-?? partial) = 103
    assertEqual([m.totalConfirmedDays, m.countryDays.find(c => c.iso === "US").days], [103, 92]);
  });
  test("travel: continents spanned (EU, AS, NA, SA)", () => {
    assertEqual(m.visitedContinents.size, 4);
  });
  test("travel: inferredVisible masks inferred overlapping any confirmed range", () => {
    // IT (2022, no overlap) kept; FR (overlaps confirmed FR) + GB (overlaps confirmed US) dropped.
    assertEqual([m.inferredVisible.length, m.inferredVisible[0].country], [1, "IT"]);
  });
  test("travel: world percentage (5 / 195)", () => {
    assertEqual(m.worldPct, 3);
  });

  // currentStay — synthetic rows with a fixed "today" (2024-06-15)
  const today = new Date("2024-06-15T12:00:00Z");
  const trip = (entered, left, country = "XA") =>
    ({ date_entered: entered, date_left: left, country, city: "", visa_status: "", notes: "", source: "confirmed", resolved: "", _src: {} });

  test("travel: currentStay — inside a confirmed range", () => {
    const stays = [trip("2024-06-01", "2024-07-01")];
    assertEqual(currentStay(stays, today)?.country, "XA");
  });
  test("travel: currentStay — blank date_left counts as ongoing", () => {
    const stays = [trip("2024-05-20", "")];
    assertEqual(currentStay(stays, today)?.country, "XA");
  });
  test("travel: currentStay — partial date_left is NOT ongoing", () => {
    // Historic visited-but-undated row must not read as "still there".
    const stays = [trip("2022-06-01", "2022-06-??")];
    assertEqual(currentStay(stays, today), null);
  });
  test("travel: currentStay — past and future trips don't match", () => {
    const stays = [trip("2024-01-01", "2024-01-10"), trip("2024-08-01", "2024-08-10")];
    assertEqual(currentStay(stays, today), null);
  });
  test("travel: currentStay — overlapping ranges pick the latest entry", () => {
    const stays = [trip("2024-01-01", "2024-12-31", "XA"), trip("2024-06-10", "2024-06-20", "XB")];
    assertEqual(currentStay(stays, today)?.country, "XB");
  });
}

// ============================================================================
// Field-type heuristics (src/field-types.ts)
// ============================================================================
// Locks the column-name rules behind the modal date pickers + dropdowns —
// especially that "date" matches as a whole word and NOT inside update/mandate.
{
  const esbuild = (await import("esbuild")).default;
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  const entry = fileURLToPath(new URL("./src/field-types.ts", import.meta.url));
  const out = path.join(os.tmpdir(), `field-types.${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, logLevel: "error" });
  const { isDateCol, suggestionsFor, ISO_DATE } = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });

  test("field-types: isDateCol matches date/due/deadline as a whole word", () => {
    for (const h of ["date", "Date", "date_entered", "date_left", "Release Date", "Watched Date", "start-date", "date-start", "Due", "due", "Due Date", "Deadline", "deadline"]) {
      assertEqual(isDateCol(h), true, `expected ${h} to be a date column`);
    }
  });
  test("field-types: isDateCol rejects substrings & non-dates", () => {
    for (const h of ["update", "update_at", "mandate", "candidate", "validate", "dateline", "Year", "country", "city", "overdue", "subdue"]) {
      assertEqual(isDateCol(h), false, `expected ${h} NOT to be a date column`);
    }
  });
  test("field-types: suggestionsFor is case-insensitive for known columns", () => {
    assertEqual(suggestionsFor("source"), ["confirmed", "inferred", "conflict"]);
    assertEqual(suggestionsFor("Source"), ["confirmed", "inferred", "conflict"]);
    assertEqual(suggestionsFor("resolved"), ["yes", "no"]);
  });
  test("field-types: suggestionsFor returns null for plain columns", () => {
    assertEqual([suggestionsFor("country"), suggestionsFor("notes")], [null, null]);
  });
  test("field-types: ISO_DATE guard accepts only clean yyyy-mm-dd", () => {
    assertEqual([ISO_DATE.test("2024-01-15"), ISO_DATE.test("2024-06-??"), ISO_DATE.test("")], [true, false, false]);
  });
}

// ============================================================================
// Residency evaluation (src/residency.ts)
// ============================================================================
// Deterministic with a fixed `today` and synthetic trips (no personal data).
// Covers calendar-year clamping, exemption, rolling lookback, all-time, status.
{
  const esbuild = (await import("esbuild")).default;
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  const entry = fileURLToPath(new URL("./src/residency.ts", import.meta.url));
  const out = path.join(os.tmpdir(), `residency.${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, logLevel: "error" });
  const { evaluateResidency } = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });

  const today = Date.UTC(2021, 5, 15); // 2021-06-15
  const trip = (date_entered, date_left, country, visa_status = "") => ({ date_entered, date_left, country, visa_status });

  test("residency: calendar-year clamps + counts left-exclusive (a year-spanning trip)", () => {
    const rule = { label: "X", scope: { country: "XA" }, window: { type: "calendar-year" }, threshold: 183 };
    // 2020-11-01 → 2021-03-01: only 2021-01-01..2021-03-01 counts = 59 days.
    assertEqual(evaluateResidency(rule, [trip("2020-11-01", "2021-03-01", "XA")], today).used, 59);
  });
  test("residency: exempt visa rows contribute 0", () => {
    const rule = { label: "X", scope: { country: "XA" }, window: { type: "calendar-year" }, threshold: 183, exempt: { visa_status: ["student"] } };
    assertEqual(evaluateResidency(rule, [trip("2021-01-01", "2021-04-01", "XA", "student")], today).used, 0);
  });
  test("residency: scope can be a country set; out-of-scope ignored", () => {
    const rule = { label: "X", scope: { countries: ["XA", "XB"] }, window: { type: "calendar-year" }, threshold: 183 };
    const trips = [trip("2021-01-01", "2021-01-11", "XA"), trip("2021-02-01", "2021-02-11", "XB"), trip("2021-03-01", "2021-03-31", "ZZ")];
    assertEqual(evaluateResidency(rule, trips, today).used, 20); // 10 + 10, ZZ excluded
  });
  test("residency: all-time sums every in-scope day", () => {
    const rule = { label: "X", scope: { country: "XA" }, window: { type: "all-time" }, threshold: 1825 };
    const trips = [trip("2019-01-01", "2019-02-01", "XA"), trip("2020-01-01", "2020-01-11", "XA")];
    const r = evaluateResidency(rule, trips, today);
    assertEqual([r.used, r.remaining, r.status], [41, 1784, "ok"]);
  });
  test("residency: rolling window excludes trips outside the lookback", () => {
    const rule = { label: "X", scope: { country: "XA" }, window: { type: "rolling", days: 180 }, threshold: 90 };
    const trips = [trip("2021-05-01", "2021-05-21", "XA"), trip("2019-01-01", "2019-02-01", "XA")];
    assertEqual(evaluateResidency(rule, trips, today).used, 20);
  });
  test("residency: status warn at >=80% and over past threshold", () => {
    const base = { label: "x", scope: { country: "XA" }, window: { type: "all-time" } };
    const warn = evaluateResidency({ ...base, threshold: 10 }, [trip("2020-01-01", "2020-01-10", "XA")], today);
    const over = evaluateResidency({ ...base, threshold: 10 }, [trip("2020-01-01", "2020-01-16", "XA")], today);
    assertEqual([warn.status, over.status, over.remaining], ["warn", "over", -5]);
  });
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${"=".repeat(50)}`);
console.log(`Tests complete: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
