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
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const assessmentStyles = {
    Review: "review",
    "Early warning": "warning",
    Incomplete: "incomplete",
    "No alert": "routine",
  };
  const form = document.createElement("form");
  form.className = "intake-form";
  form.innerHTML = `
    <section class="intake-card">
      <div class="intake-heading">
        <div>
          <h2>Patient readings</h2>
          <p>Use fictional readings and one set per date. Leave any unmeasured vital blank.</p>
        </div>
        <button type="button" class="intake-secondary" data-action="sample">Load example</button>
      </div>
      <label class="intake-id">Synthetic patient ID
        <input name="patient_id" placeholder="e.g. DEMO-001" maxlength="40" required>
      </label>
      <div class="intake-rows"></div>
      <div class="intake-actions">
        <button type="button" class="intake-secondary" data-action="add">Add a day</button>
        <button type="submit" class="intake-primary">Assess latest day</button>
      </div>
      <p class="intake-status" role="status"></p>
    </section>
    <section class="intake-output" aria-labelledby="intake-assessment-title" hidden></section>`;
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Use a four-digit year for each reading date.");
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

  function showAssessment(patientId, latestDate, assessment) {
    output.dataset.status = assessmentStyles[assessment.status];
    const title = document.createElement("h2");
    title.id = "intake-assessment-title";
    title.tabIndex = -1;
    title.textContent = "Latest assessment";
    const patient = document.createElement("p");
    patient.className = "intake-patient";
    patient.textContent = `${patientId} · ${dateLabel.format(new Date(latestDate + "T12:00:00"))}`;
    const verdict = document.createElement("p");
    verdict.className = "intake-verdict";
    verdict.textContent = assessment.status;
    const reason = document.createElement("p");
    reason.className = "intake-reason";
    reason.textContent = assessment.headline;
    output.replaceChildren(title, patient, verdict, reason);

    if (assessment.missing.length) {
      const missing = document.createElement("p");
      missing.className = "intake-missing";
      const label = document.createElement("strong");
      label.textContent = `Missing readings (${assessment.missing.length} of ${vitals.length})`;
      missing.append(label, document.createTextNode(assessment.missing.join(", ")));
      output.append(missing);
    }

    if (assessment.evidence.length) {
      const explanation = document.createElement("details");
      explanation.className = "intake-explanation";
      const summary = document.createElement("summary");
      summary.textContent = "How was this assessment made?";
      const evidence = document.createElement("dl");
      for (const item of assessment.evidence) {
        const label = document.createElement("dt");
        label.textContent = item.title;
        const detail = document.createElement("dd");
        detail.textContent = item.text;
        evidence.append(label, detail);
      }
      explanation.append(summary, evidence);
      output.append(explanation);
    }
    output.hidden = false;
    title.focus();
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
      const row = button.closest(".intake-day");
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      syncRows();
      next.querySelector("[name=date]").focus();
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
      status.textContent = "Checking the latest readings…";
      const bundle = await window.CareModels.load();
      if (draftVersion !== submittedVersion) return;
      const assessment = window.CareTriage.assess(readings, bundle, { explain: true });
      showAssessment(patientId, readings.at(-1).date, assessment);
      status.textContent = "Assessment ready. Your readings were processed in this browser.";
    } catch (error) {
      if (draftVersion !== submittedVersion) return;
      status.classList.add("intake-error");
      status.textContent = error.message || "Could not assess the readings.";
    } finally {
      submit.disabled = false;
    }
  });

  addDay();
})();
