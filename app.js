/* =========================================================================
   Performance Dashboard
   Đọc dữ liệu từ Google Sheet (export CSV) và vẽ 5 biểu đồ + 4 KPI card.

   Cột dữ liệu nguồn (theo tên header, KHÔNG theo vị trí cố định — sheet gốc
   có 1 cột trống/ẩn giữa "Task Name" và "Processed Quantity" nên không thể
   đọc theo A,B,C,D,E cứng):
     Working Day | Task Name | (có thể có cột trống) | Processed Quantity |
     Process Time (minute) | Avg. Process Time (minute)
   ========================================================================= */

const CONFIG = {
  // Google Sheet ID lấy từ URL chia sẻ. Sheet phải để chế độ chia sẻ
  // "Anyone with the link" (Viewer) thì export CSV mới truy cập được.
  sheetId: "18CXE1LS_CgRL6jOm-Uib5jk4WrhXs4IA",
  gid: "2073632175", // tab cụ thể lấy từ URL &gid=...; để trống = tab đầu tiên

  // Tên các task dùng để tính "Daily Process Time per Docket (Mins)"
  // = SUM(Avg. Process Time) cho các task này, theo từng ngày/kỳ.
  avgTimeTaskList: [
    "Download submitted dockets",
    "Process BOOKING Timeline & charges",
    "Update Focus Timesheet file",
    "Approve timesheets - Dockets",
  ],

  // Task đại diện cho "dockets đã xử lý" (chart 1 cột + KPI Total Dockets Completed)
  docketTaskName: "Download submitted dockets",

  // Task đại diện cho downtime (chart 2 + KPI Total Downtime)
  downtimeTaskName: "Downtime",

  // Danh sách category dùng cho chart 3 (Avg Process Time by Category)
  chart3TaskList: [
    "Approve timesheets - Dockets",
    "Invoice charges",
    "Publish daily working schedule",
    "Update Focus Timesheet file",
    "Update Jordan Access Timesheet file",
  ],

};

CONFIG.csvUrl = CONFIG.gid
  ? `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/export?format=csv&gid=${CONFIG.gid}`
  : `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/export?format=csv`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let RAW_ROWS = [];      // parsed rows: {date: Date, task, qty, time, avg}
let BASIS = "daily";    // daily | monthly | yearly
let charts = {};        // Chart.js instances keyed by canvas id
let SELECTED_TASKS = null; // Set of normalized task keys shown in chart4/5; null = all
const taskColorMap = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeTaskName(s) {
  return (s || "")
    .replace(/[\u2012\u2013\u2014\u2015]/g, "-") // en/em dash -> hyphen
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function colorForTask(taskName) {
  const key = normalizeTaskName(taskName);
  if (!taskColorMap.has(key)) {
    const i = taskColorMap.size;
    const hue = (i * 137.508) % 360;           // golden angle -> max hue spread
    const sat = 62 + (i % 3) * 8;              // 62 / 70 / 78, cycling
    const light = 46 + ((i + 1) % 3) * 7;      // 46 / 53 / 60, cycling
    taskColorMap.set(key, `hsl(${hue.toFixed(1)} ${sat}% ${light}%)`);
  }
  return taskColorMap.get(key);
}

function pad2(n) { return String(n).padStart(2, "0"); }

// Parse a date value coming from the sheet. Handles ISO (YYYY-MM-DD),
// US numeric format (M/D/YYYY) and text formats like "Nov 26, 2025"
// (native Date parser handles the latter directly).
function parseSheetDate(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;

  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]); // M/D/Y

  const d = new Date(v); // handles "Nov 26, 2025", "2025-11-26T00:00:00", etc.
  return isNaN(d) ? null : d;
}

// Find the real column indices by matching header TEXT instead of a fixed
// A/B/C/D/E position — the source sheet has a blank/hidden column between
// "Task Name" and "Processed Quantity", which would otherwise shift every
// numeric column by one.
function buildColumnMap(headerRow) {
  const norm = (s) => (s || "").toString().trim().toLowerCase();
  const findIdx = (must, mustNot = []) =>
    headerRow.findIndex((h) => {
      const n = norm(h);
      return n && must.every((p) => n.includes(p)) && !mustNot.some((p) => n.includes(p));
    });

  const byHeader = {
    date: findIdx(["working day"]),
    task: findIdx(["task name"]),
    qty: findIdx(["processed quantity"]),
    avg: findIdx(["avg"]),
    time: findIdx(["process time"], ["avg"]),
  };

  if (Object.values(byHeader).every((i) => i !== -1)) return byHeader;

  // Fallback: assume column ORDER date, task, qty, time, avg among the
  // non-blank header cells (skips hidden/blank spacer columns automatically).
  const nonEmpty = headerRow
    .map((h, i) => ({ h: norm(h), i }))
    .filter((c) => c.h);
  const [date, task, qty, time, avg] = nonEmpty.map((c) => c.i);
  return { date, task, qty, time, avg };
}

function periodKey(date, basis) {
  const y = date.getFullYear(), m = pad2(date.getMonth() + 1), d = pad2(date.getDate());
  if (basis === "yearly") return `${y}`;
  if (basis === "monthly") return `${y}-${m}`;
  return `${y}-${m}-${d}`;
}

function periodLabel(key, basis) {
  if (basis === "yearly") return key;
  if (basis === "monthly") {
    const [y, m] = key.split("-");
    return `${m}/${y}`;
  }
  const [y, m, d] = key.split("-");
  return `${d}/${m}`;
}

function sortedPeriodKeys(keys) {
  return Array.from(keys).sort();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData() {
  const statusEl = document.getElementById("statusLine");
  statusEl.textContent = "Đang tải dữ liệu…";

  if (typeof Chart !== "undefined" && !Chart._fontConfigured) {
    Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
    if (typeof ChartDataLabels !== "undefined") {
      Chart.register(ChartDataLabels);
      Chart.defaults.set("plugins.datalabels", { display: false });
    }
    Chart._fontConfigured = true;
  }

  if (typeof Papa === "undefined" || typeof Chart === "undefined") {
    statusEl.innerHTML =
      "Trình duyệt/tiện ích mở rộng đang chặn thư viện Chart.js hoặc PapaParse tải từ CDN " +
      "(ví dụ: Tracking Prevention, AdBlock). Hãy tắt chặn cho trang này rồi bấm Reload data, " +
      "hoặc thử trình duyệt/chế độ khác.";
    return;
  }

  try {
    const res = await fetch(CONFIG.csvUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csvText = await res.text();

    const parsed = Papa.parse(csvText, { skipEmptyLines: true });
    const rows = parsed.data;
    if (rows.length < 2) throw new Error("Sheet không có dữ liệu.");

    const colMap = buildColumnMap(rows[0]);
    if (Object.values(colMap).some((i) => i === undefined || i === -1)) {
      throw new Error("Không xác định được cột dữ liệu — kiểm tra lại header của sheet.");
    }

    RAW_ROWS = rows.slice(1)
      .map((r) => ({
        date: parseSheetDate(r[colMap.date]),
        task: (r[colMap.task] || "").trim(),
        qty: parseFloat(r[colMap.qty]) || 0,
        time: parseFloat(r[colMap.time]) || 0,
        avg: parseFloat(r[colMap.avg]) || 0,
      }))
      .filter((r) => r.date && r.task);

    if (RAW_ROWS.length === 0) throw new Error("Không đọc được dòng dữ liệu hợp lệ nào từ sheet.");

    initDateRangeInputs();
    buildCategoryFilterUI();
    statusEl.textContent = `Đã tải ${RAW_ROWS.length} dòng · cập nhật lúc ${new Date().toLocaleTimeString()}`;
    renderAll();
  } catch (err) {
    console.error(err);
    statusEl.innerHTML =
      `Lỗi tải dữ liệu: ${err.message}. Kiểm tra sheet đã bật chia sẻ "Anyone with the link", ` +
      `<code>CONFIG.sheetId</code>/<code>CONFIG.gid</code> trong app.js, và console (F12) để xem chi tiết.`;
  }
}

function initDateRangeInputs() {
  const startEl = document.getElementById("startDate");
  const endEl = document.getElementById("endDate");
  if (startEl.value && endEl.value) return; // already set by user

  const dates = RAW_ROWS.map((r) => r.date).sort((a, b) => a - b);
  const min = dates[0], max = dates[dates.length - 1];
  startEl.value = toInputDate(min);
  endEl.value = toInputDate(max);
}

function toInputDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getSelectedRange() {
  const startEl = document.getElementById("startDate");
  const endEl = document.getElementById("endDate");
  const start = startEl.value ? new Date(startEl.value + "T00:00:00") : null;
  const end = endEl.value ? new Date(endEl.value + "T23:59:59") : null;
  return { start, end };
}

function filteredRows() {
  const { start, end } = getSelectedRange();
  return RAW_ROWS.filter((r) => (!start || r.date >= start) && (!end || r.date <= end));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function aggregate(rows, basis) {
  const periods = new Map();

  rows.forEach((r) => {
    const key = periodKey(r.date, basis);
    if (!periods.has(key)) {
      periods.set(key, { avgByTask: new Map(), qtyByTask: new Map(), timeByTask: new Map() });
    }
    const bucket = periods.get(key);
    const tkey = normalizeTaskName(r.task);

    bucket.avgByTask.set(tkey, (bucket.avgByTask.get(tkey) || 0) + r.avg);
    bucket.qtyByTask.set(tkey, (bucket.qtyByTask.get(tkey) || 0) + r.qty);
    bucket.timeByTask.set(tkey, (bucket.timeByTask.get(tkey) || 0) + r.time);
  });

  return periods;
}

function sumForTaskList(bucketMap, taskList) {
  const target = new Set(taskList.map(normalizeTaskName));
  let sum = 0;
  bucketMap.forEach((val, key) => { if (target.has(key)) sum += val; });
  return sum;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------
function renderKPIs(rows, periods, keys) {
  const perPeriodDocketTime = keys.map((k) => sumForTaskList(periods.get(k).avgByTask, CONFIG.avgTimeTaskList));
  const avgMins = perPeriodDocketTime.length
    ? perPeriodDocketTime.reduce((a, b) => a + b, 0) / perPeriodDocketTime.length
    : 0;

  const docketKey = normalizeTaskName(CONFIG.docketTaskName);
  const totalDockets = rows
    .filter((r) => normalizeTaskName(r.task) === docketKey)
    .reduce((a, r) => a + r.qty, 0);

  const downtimeKey = normalizeTaskName(CONFIG.downtimeTaskName);
  const totalTimeMins = rows
    .filter((r) => normalizeTaskName(r.task) !== downtimeKey)
    .reduce((a, r) => a + r.time, 0);

  const totalDowntimeMins = rows
    .filter((r) => normalizeTaskName(r.task) === downtimeKey)
    .reduce((a, r) => a + r.time, 0);

  document.getElementById("kpiAvgMins").textContent = avgMins.toFixed(2);
  document.getElementById("kpiDockets").textContent = totalDockets.toLocaleString();
  document.getElementById("kpiTimeTaken").textContent = (totalTimeMins / 60).toFixed(2);
  document.getElementById("kpiDowntime").textContent = (totalDowntimeMins / 60).toFixed(2);
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function baseOptions(extra = {}) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } } },
    scales: { x: { grid: { display: false } } },
  }, extra);
}

function renderChart1(periods, keys, labels) {
  const docketKey = normalizeTaskName(CONFIG.docketTaskName);
  const qty = keys.map((k) => periods.get(k).qtyByTask.get(docketKey) || 0);
  const mins = keys.map((k) => sumForTaskList(periods.get(k).avgByTask, CONFIG.avgTimeTaskList));

  destroyChart("chart1");
  charts.chart1 = new Chart(document.getElementById("chart1"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Daily Processed Dockets",
          data: qty,
          backgroundColor: "#f59e0b",
          borderRadius: 6,
          yAxisID: "y",
          order: 2,
        },
        {
          type: "line",
          label: "Daily Process Time per Docket (Mins)",
          data: mins,
          borderColor: "#10b981",
          backgroundColor: "#10b981",
          pointRadius: 4,
          pointBackgroundColor: "#10b981",
          tension: 0.3,
          yAxisID: "y1",
          order: 1,
        },
      ],
    },
    options: baseOptions({
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, position: "left" },
        y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false } },
      },
    }),
  });
}

function renderChart2(periods, keys, labels) {
  const downtimeKey = normalizeTaskName(CONFIG.downtimeTaskName);
  const mins = keys.map((k) => periods.get(k).timeByTask.get(downtimeKey) || 0);

  destroyChart("chart2");
  charts.chart2 = new Chart(document.getElementById("chart2"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Downtime (mins)",
        data: mins,
        borderColor: "#f43f5e",
        backgroundColor: "rgba(244,63,94,0.18)",
        pointRadius: 4,
        pointBackgroundColor: "#f43f5e",
        fill: true,
        tension: 0.35,
      }],
    },
    options: baseOptions({ scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } }),
  });
}

function renderChart3(periods, keys, labels) {
  destroyChart("chart3");
  const datasets = CONFIG.chart3TaskList.map((taskName) => {
    const tkey = normalizeTaskName(taskName);
    const color = colorForTask(taskName);
    return {
      label: taskName,
      data: keys.map((k) => periods.get(k).avgByTask.get(tkey) || 0),
      backgroundColor: color,
      borderRadius: 4,
    };
  });

  charts.chart3 = new Chart(document.getElementById("chart3"), {
    type: "bar",
    data: { labels, datasets },
    options: baseOptions({
      scales: {
        x: { stacked: false, grid: { display: false } },
        y: { stacked: false, beginAtZero: true },
      },
    }),
  });
}

function allTaskNames(periods) {
  const set = new Set();
  periods.forEach((bucket) => {
    bucket.qtyByTask.forEach((_, k) => set.add(k));
    bucket.timeByTask.forEach((_, k) => set.add(k));
  });
  return Array.from(set);
}

function updateCategoryCount(total) {
  const el = document.getElementById("categoryCount");
  if (el && SELECTED_TASKS) el.textContent = `(${SELECTED_TASKS.size}/${total} đang chọn)`;
}

function buildCategoryFilterUI() {
  const taskMap = new Map(); // normalized key -> original display label
  RAW_ROWS.forEach((r) => {
    const key = normalizeTaskName(r.task);
    if (!taskMap.has(key)) taskMap.set(key, r.task);
  });

  if (SELECTED_TASKS === null) {
    SELECTED_TASKS = new Set(taskMap.keys()); // default: everything shown
  }

  const section = document.getElementById("categoryFilterSection");
  const container = document.getElementById("categoryChips");
  container.innerHTML = "";

  taskMap.forEach((label, key) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cat-chip" + (SELECTED_TASKS.has(key) ? " active" : "");
    chip.textContent = label;
    chip.style.setProperty("--chip-color", colorForTask(label));
    chip.addEventListener("click", () => {
      if (SELECTED_TASKS.has(key)) SELECTED_TASKS.delete(key);
      else SELECTED_TASKS.add(key);
      chip.classList.toggle("active");
      updateCategoryCount(taskMap.size);
      renderAll();
    });
    container.appendChild(chip);
  });

  updateCategoryCount(taskMap.size);
  section.style.display = taskMap.size ? "block" : "none";
}

function renderStackedChart(canvasId, periods, keys, labels, field) {
  destroyChart(canvasId);
  let tasks = allTaskNames(periods);
  if (SELECTED_TASKS) tasks = tasks.filter((t) => SELECTED_TASKS.has(t));

  const datasets = tasks.map((tkey, i) => {
    const isTop = i === tasks.length - 1;
    return {
      label: tkey.replace(/\b\w/g, (c) => c.toUpperCase()),
      data: keys.map((k) => periods.get(k)[field].get(tkey) || 0),
      backgroundColor: colorForTask(tkey),
      stack: "stack1",
      borderRadius: 3,
      borderSkipped: false,
      datalabels: isTop
        ? {
            display: true,
            anchor: "end",
            align: "top",
            clamp: true,
            offset: 2,
            color: "#1e2233",
            font: { weight: "700", size: 10 },
            formatter: (_, ctx) =>
              ctx.chart.data.datasets
                .reduce((sum, d) => sum + (d.data[ctx.dataIndex] || 0), 0)
                .toLocaleString(),
          }
        : undefined,
    };
  });

  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: { labels, datasets },
    options: baseOptions({
      layout: { padding: { top: 18 } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, grace: "8%" },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function renderAll() {
  const rows = filteredRows();
  const periods = aggregate(rows, BASIS);
  const keys = sortedPeriodKeys(periods.keys());
  const labels = keys.map((k) => periodLabel(k, BASIS));

  renderKPIs(rows, periods, keys);
  renderChart1(periods, keys, labels);
  renderChart2(periods, keys, labels);
  renderChart3(periods, keys, labels);
  renderStackedChart("chart4", periods, keys, labels, "qtyByTask");
  renderStackedChart("chart5", periods, keys, labels, "timeByTask");
}

function initControls() {
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      BASIS = btn.dataset.basis;
      renderAll();
    });
  });

  document.getElementById("startDate").addEventListener("change", renderAll);
  document.getElementById("endDate").addEventListener("change", renderAll);
  document.getElementById("reloadBtn").addEventListener("click", loadData);

  document.getElementById("selectAllCats").addEventListener("click", () => {
    if (!SELECTED_TASKS) return;
    const chips = document.querySelectorAll(".cat-chip");
    chips.forEach((chip) => {
      SELECTED_TASKS.add(normalizeTaskName(chip.textContent));
      chip.classList.add("active");
    });
    updateCategoryCount(chips.length);
    renderAll();
  });

  document.getElementById("clearAllCats").addEventListener("click", () => {
    if (!SELECTED_TASKS) return;
    SELECTED_TASKS.clear();
    const chips = document.querySelectorAll(".cat-chip");
    chips.forEach((chip) => chip.classList.remove("active"));
    updateCategoryCount(chips.length);
    renderAll();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initControls();
  loadData();
});
