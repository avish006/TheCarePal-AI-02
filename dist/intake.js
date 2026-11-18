(() => {
  "use strict";

  const root = document.getElementById("intake-root");
  if (!root) return;

  const vitals = [
    ["systolic_mmhg", "Systolic BP", "mmHg"],
    ["diastolic_mmhg", "Diastolic BP", "mmHg"],
    ["pulse_bpm", "Pulse", "bpm"],
    ["spo2_pct", "SpO₂", "%"],
    ["fasting_glucose_mg_dl", "Fasting glucose", "mg/dL"],
    ["oral_temperature_c", "Oral temperature", "°C"],
  ];
  const methods = [
    ["ensemble", "Ensemble"],
    ["xgboost", "XGBoost"],
    ["gru_autoencoder", "GRU autoencoder"],
    ["clinical_rules", "Clinical rules"],
    ["statistical_baseline", "Statistical baseline"],
  ];
  const form = document.createElement("form");
  form.className = "intake-form";
  form.innerHTML = `
    <section class="intake-card">
      <div class="intake-heading">
        <div>
          <h2>Patient readings</h2>
          <p>Enter one row per day. Leave unavailable measurements blank.</p>
        </div>
        <button type="button" class="intake-secondary" data-action="sample">Load example</button>
      </div>
      <label class="intake-id">Synthetic patient ID
        <input name="patient_id" placeholder="e.g. DEMO-001" maxlength="40" required>
      </label>
      <div class="intake-rows"></div>
      <div class="intake-actions">
        <button type="button" class="intake-secondary" data-action="add">Add day</button>
        <button type="submit" class="intake-primary">Score latest day</button>
      </div>
      <p class="intake-status" role="status"></p>
    </section>
    <section class="intake-output" aria-live="polite" hidden></section>`;
  root.append(form);

  const rows = form.querySelector(".intake-rows");
  const status = form.querySelector(".intake-status");
  const output = form.querySelector(".intake-output");
  const submit = form.querySelector("[type=submit]");
  let draftVersion = 0;

  function addDay(date = "", values = []) {
    const row = document.createElement("fieldset");
    row.className = "intake-day";
    row.innerHTML = `
      <legend>Reading</legend>
      <div class="intake-fields">
        <label>Date<input type="date" name="date"></label>
        ${vitals.map(([key, label, unit]) => `
          <label>${label} <small>${unit}</small>
            <input type="number" inputmode="decimal" step="any" min="0.01"
                   name="${key}" ${key === "spo2_pct" ? 'max="100"' : ""}>
          </label>`).join("")}
        <button type="button" class="intake-remove" data-action="remove">Remove</button>
      </div>`;
    row.querySelector("[name=date]").value = date;
    vitals.forEach(([key], index) => {
      row.querySelector(`[name=${key}]`).value = values[index] ?? "";
    });
    rows.append(row);
    syncRows();
    return row;
  }

  function syncRows() {
    const children = Array.from(rows.children);
    children.forEach((row, index) => {
      row.querySelector("legend").textContent = `Day ${index + 1}`;
      const remove = row.querySelector("[data-action=remove]");
      remove.disabled = children.length === 1;
      remove.setAttribute("aria-label", `Remove day ${index + 1}`);
    });
  }

  function loadExample() {
    form.elements.patient_id.value = "DEMO-001";
    rows.replaceChildren();
    addDay("2026-11-15", [125, 78, 72, 97, 113, 36.5]);
    addDay("2026-11-16", [128, 78, 76, 96, 110, 36.6]);
    addDay("2026-11-17", [126, 77, 82, 93, null, 36.7]);
    addDay("2026-11-18", [130, 80, 91, 89, 107, 37.1]);
    status.textContent = "Example loaded. You can edit any reading.";
  }

  function readForm() {
    const readings = [];
    const dates = new Set();
    for (const row of rows.children) {
      const date = row.querySelector("[name=date]").value;
      const values = Object.fromEntries(vitals.map(([key]) => {
        const input = row.querySelector(`[name=${key}]`);
        return [key, input.value === "" ? null : input.valueAsNumber];
      }));
      if (!date && Object.values(values).every(value => value === null)) continue;
      if (!date) throw new Error("Add a date to every row with a measurement.");
      if (dates.has(date)) throw new Error(`Date ${date} appears twice. Keep one row per day.`);
      if (values.systolic_mmhg !== null && values.diastolic_mmhg !== null
          && values.systolic_mmhg <= values.diastolic_mmhg) {
        throw new Error(`On ${date}, systolic BP must be higher than diastolic BP.`);
      }
      dates.add(date);
      readings.push({date, ...values});
    }
    if (!readings.length) throw new Error("Enter at least one dated reading.");
    return readings.sort((left, right) => left.date.localeCompare(right.date));
  }

  function showScores(patientId, readings, scores) {
    const title = document.createElement("h2");
    title.textContent = `${patientId} · ${readings.at(-1).date}`;
    const notes = document.createElement("p");
    notes.textContent = `${readings.length} dated ${readings.length === 1 ? "row" : "rows"}. Each model uses its own score scale and alert threshold.`;
    const grid = document.createElement("div");
    grid.className = "intake-results";
    for (const [key, label] of methods) {
      const result = scores[key];
      const card = document.createElement("article");
      card.className = "intake-result";
      card.dataset.alert = String(result.alert);
      const heading = document.createElement("h3");
      heading.textContent = label;
      const verdict = document.createElement("p");
      verdict.className = "intake-verdict";
      verdict.textContent = result.score === null ? "Unavailable" : result.alert ? "Review" : "Below threshold";
      const score = document.createElement("p");
      if (Number.isFinite(result.score)) {
        score.textContent = `Score ${result.score.toFixed(key === "clinical_rules" ? 0 : 3)}`;
        if (Number.isFinite(result.threshold)) score.textContent += ` · Threshold ${Number(result.threshold.toFixed(3))}`;
      }
      const reason = document.createElement("p");
      reason.textContent = result.reason;
      card.append(heading, verdict, score, reason);
      grid.append(card);
    }
    output.replaceChildren(title, notes, grid);
    output.hidden = false;
    output.scrollIntoView({block: "nearest"});
  }

  function clearScore() {
    draftVersion += 1;
    output.hidden = true;
    status.classList.remove("intake-error");
    status.textContent = "";
  }

  form.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    clearScore();
    if (button.dataset.action === "sample") loadExample();
    if (button.dataset.action === "add") addDay().querySelector("[name=date]").focus();
    if (button.dataset.action === "remove" && rows.children.length > 1) {
      button.closest(".intake-day").remove();
      syncRows();
    }
  });
  form.addEventListener("input", clearScore);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submittedVersion = draftVersion;
    output.hidden = true;
    status.classList.remove("intake-error");
    submit.disabled = true;
    try {
      const readings = readForm();
      const patientId = form.elements.patient_id.value.trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(patientId)) {
        throw new Error("Use letters, numbers, hyphens, or underscores for the synthetic patient ID.");
      }
      status.textContent = "Scoring the latest day…";
      const bundle = await window.CareModels.load();
      if (draftVersion !== submittedVersion) return;
      const scores = window.CareModels.scorePatient(readings, bundle);
      showScores(patientId, readings, scores);
      status.textContent = "Scoring complete. Readings were processed in this browser.";
    } catch (error) {
      if (draftVersion !== submittedVersion) return;
      status.classList.add("intake-error");
      status.textContent = error.message || "Could not score the readings.";
    } finally {
      submit.disabled = false;
    }
  });

  addDay();
})();
