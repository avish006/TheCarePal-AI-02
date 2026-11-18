"use strict";

const fields = {
  systolic_mmhg: ["Systolic BP", "mmHg"],
  diastolic_mmhg: ["Diastolic BP", "mmHg"],
  pulse_bpm: ["Pulse", "bpm"],
  spo2_pct: ["Oxygen saturation", "%"],
  fasting_glucose_mg_dl: ["Fasting glucose", "mg/dL"],
  oral_temperature_c: ["Oral temperature", "°C"],
};
const icons = {
  Review: '<path d="m12 3 9 16H3L12 3z M12 9v4m0 3v.3"/>',
  Watch: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  Routine: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 3 3 5-6"/>',
  Incomplete: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 9h6m-6 4h4"/>',
};
const levels = Object.keys(icons);
const byId = id => document.getElementById(id);
const dateFormat = options => new Intl.DateTimeFormat("en-GB", options);
const longDate = dateFormat({weekday: "long", day: "numeric", month: "long", year: "numeric"});
const shortDate = dateFormat({day: "numeric", month: "short"});
const inputDate = dateFormat({day: "numeric", month: "short", year: "numeric"});
const parseDay = day => new Date(day + "T12:00:00");
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
let dataset = null;
let selectedId = null;
let selectedVital = "systolic_mmhg";
let lookback = 14;
let pendingRequest = null;

function displayValue(field, value) {
  if (!Number.isFinite(value)) return "—";
  return field === "oral_temperature_c" ? value.toFixed(1) : String(value);
}

function badge(level) {
  const safeLevel = levels.includes(level) ? level : "Incomplete";
  return '<span class="badge ' + safeLevel.toLowerCase() + '">' + safeLevel + '</span>';
}

function prioritySummary() {
  const counts = Object.fromEntries(levels.map(level => [level, 0]));
  for (const patient of dataset.patients) counts[patient.level]++;
  byId("summary").innerHTML = levels.map(level => {
    const active = byId("level").value === level;
    return `<button class="stat ${level.toLowerCase()}" data-level="${level}" aria-pressed="${active}" aria-label="Filter ${level}, ${counts[level]} patients">
      <span class="stat-label"><span class="stat-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[level]}</svg></span>${level}</span>
      <span class="stat-value">${counts[level]}</span></button>`;
  }).join("");
}

function drawQueue() {
  const query = byId("search").value.trim().toLowerCase();
  const level = byId("level").value;
  const patients = dataset.patients.filter(patient =>
    patient.patient_id.toLowerCase().includes(query) && (!level || patient.level === level));
  if (!patients.some(patient => patient.patient_id === selectedId)) {
    selectedId = patients[0]?.patient_id ?? null;
  }
  byId("queue-count").textContent = patients.length;
  byId("patient-rows").innerHTML = patients.map(patient => {
    const id = escapeHTML(patient.patient_id);
    return `<button class="patient" data-patient="${id}" aria-pressed="${patient.patient_id === selectedId}">
      <span><strong>${id}</strong><span class="age">Age ${escapeHTML(patient.age)}</span></span>
      <span>${badge(patient.level)}<span class="reason">${escapeHTML(patient.reason)}</span></span>
      <span class="risk">${patient.score ?? "—"}</span></button>`;
  }).join("") || '<p class="empty">No patients match these filters.</p>';
  prioritySummary();
  drawDetails();
}

function drawChart(history) {
  const data = history.slice(-lookback);
  const numbers = data.map(point => point.values[selectedVital]);
  const available = numbers.filter(Number.isFinite);
  if (!available.length) return '<p class="empty">No readings were recorded in this period.</p>';
  const minimum = Math.min(...available);
  const maximum = Math.max(...available);
  const padding = Math.max((maximum - minimum) * 0.16, selectedVital === "oral_temperature_c" ? 0.15 : 1);
  const low = minimum - padding;
  const high = maximum + padding;
  const x = i => data.length === 1 ? 220 : 42 + i * 374 / (data.length - 1);
  const y = v => 9 + (high - v) * 101 / (high - low);
  let grid = "";
  for (let i = 0; i < 3; i++) {
    const tick = low + (high - low) * i / 2;
    grid += `<line class="grid" x1="42" x2="416" y1="${y(tick)}" y2="${y(tick)}"/>
      <text x="36" y="${y(tick) + 3}" text-anchor="end">${tick.toFixed(selectedVital === "oral_temperature_c" ? 1 : 0)}</text>`;
  }
  let path = "";
  let previousMeasured = false;
  let points = "";
  numbers.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      previousMeasured = false;
      return;
    }
    path += (previousMeasured ? " L" : " M") + x(index) + " " + y(value);
    previousMeasured = true;
    points += `<circle class="point" r="3.4" cx="${x(index)}" cy="${y(value)}"><title>${escapeHTML(data[index].date)} · ${displayValue(selectedVital, value)} ${fields[selectedVital][1]}</title></circle>`;
  });
  const first = shortDate.format(parseDay(data[0].date));
  const last = shortDate.format(parseDay(data.at(-1).date));
  return `<svg class="chart" viewBox="0 0 430 137" role="img" aria-label="${fields[selectedVital][0]} trend from ${first} to ${last}, range ${minimum} to ${maximum} ${fields[selectedVital][1]}.">
    ${grid}<path class="line" d="${path}"/>${points}
    <text x="42" y="132">${first}</text><text x="416" y="132" text-anchor="end">${last}</text></svg>`;
}

function drawDetails() {
  const patient = dataset.patients.find(item => item.patient_id === selectedId);
  if (!patient) {
    byId("details").innerHTML = '<p class="empty">Select a patient to view readings and history.</p>';
    return;
  }
  const vitalButtons = Object.entries(fields).map(([key, [label, unit]]) => {
    const value = displayValue(key, patient.values[key]);
    return `<button class="vital" data-field="${key}" aria-pressed="${key === selectedVital}" aria-label="Show ${label} history, current reading ${value} ${unit}">
      <span class="vital-name">${label}</span><span class="vital-value">${value}</span><span class="vital-unit">${unit}</span></button>`;
  }).join("");
  byId("details").innerHTML = `<div class="detail-head"><div class="detail-kicker"><span>Patient details</span><button class="back" id="back-queue">Back to queue</button></div>
    <div class="detail-identity"><h2>${escapeHTML(patient.patient_id)}</h2><span class="detail-age">Age ${escapeHTML(patient.age)}</span>${badge(patient.level)}</div>
    <p class="assessment">${escapeHTML(patient.reason)}</p></div>
    <div class="detail-section"><div class="section-heading"><h3>Current vitals</h3><span class="section-note">Select a trend</span></div><div class="vitals">${vitalButtons}</div>
    ${patient.missing.length ? '<p class="missing">Missing readings · ' + escapeHTML(patient.missing.join(", ")) + '</p>' : ''}</div>
    <div class="detail-section"><div class="section-heading"><h3>Vital history</h3>
    <select class="chart-select" id="lookback" aria-label="History period">${[7, 14].map(n => '<option value="' + n + '"' + (lookback === n ? ' selected' : '') + '>Last ' + n + ' days</option>').join("")}</select></div>
    <p class="chart-summary">${fields[selectedVital][0]} · ${fields[selectedVital][1]}</p>${drawChart(patient.history)}</div>`;
}

async function loadDashboard(day = "") {
  pendingRequest?.abort();
  const request = new AbortController();
  pendingRequest = request;
  byId("workspace").hidden = true;
  const status = byId("status");
  status.hidden = false;
  status.textContent = "Loading patient observations…";
  try {
    const response = await fetch("/api/dashboard" + (day ? "?date=" + encodeURIComponent(day) : ""), {signal: request.signal});
    if (!response.ok) throw new Error("Unable to load observations.");
    const result = await response.json();
    if (request !== pendingRequest) return;
    dataset = result;
    const selector = byId("review-date");
    selector.innerHTML = dataset.dates.slice().reverse().map(date =>
      `<option value="${escapeHTML(date)}">${inputDate.format(parseDay(date))}</option>`).join("");
    selector.value = dataset.date;
    selector.disabled = false;
    byId("day-caption").textContent = longDate.format(parseDay(dataset.date)) + " · " + dataset.patients.length + " patients";
    drawQueue();
    status.hidden = true;
    byId("workspace").hidden = false;
  } catch (error) {
    if (error.name === "AbortError") return;
    status.textContent = "Patient observations could not be loaded. ";
    const retry = document.createElement("button");
    retry.textContent = "Try again";
    retry.onclick = () => loadDashboard(day);
    status.append(retry);
  }
}

byId("review-date").addEventListener("change", event => loadDashboard(event.target.value));
byId("search").addEventListener("input", drawQueue);
byId("level").addEventListener("change", drawQueue);
byId("summary").addEventListener("click", event => {
  const button = event.target.closest("[data-level]");
  if (!button) return;
  const level = byId("level");
  level.value = level.value === button.dataset.level ? "" : button.dataset.level;
  drawQueue();
  byId("summary").querySelector('[data-level="' + button.dataset.level + '"]').focus();
});
byId("patient-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-patient]");
  if (!button) return;
  selectedId = button.dataset.patient;
  for (const row of byId("patient-rows").querySelectorAll("[data-patient]")) {
    row.setAttribute("aria-pressed", String(row === button));
  }
  drawDetails();
  if (matchMedia("(max-width:760px)").matches) byId("details").focus();
});
byId("details").addEventListener("click", event => {
  if (event.target.id === "back-queue") {
    byId("patient-rows").querySelector('[aria-pressed="true"]')?.focus();
    return;
  }
  const button = event.target.closest("[data-field]");
  if (!button) return;
  selectedVital = button.dataset.field;
  drawDetails();
  byId("details").querySelector('[data-field="' + selectedVital + '"]').focus({preventScroll:true});
});
byId("details").addEventListener("change", event => {
  if (event.target.id === "lookback") {
    lookback = Number(event.target.value);
    drawDetails();
    byId("lookback").focus({preventScroll:true});
  }
});
loadDashboard();
