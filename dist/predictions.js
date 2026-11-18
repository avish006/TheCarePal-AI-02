(() => {
  "use strict";

  const episodeLabels = {
    hypertension: "High blood pressure",
    low_sugar: "Low blood sugar",
    fever: "Fever",
    oxygen_drop: "Oxygen drop",
  };
  const splitLabels = { train: "Training", validation: "Validation", test: "Held-out test" };
  const scoreLabels = {
    ensemble: "Maximum member score-to-threshold ratio",
    xgboost: "Classifier output",
    gru_autoencoder: "Largest squared standardized reconstruction gap",
    clinical_rules: "Highest clinical rule level (0–2)",
    statistical_baseline: "Personal-baseline deviation",
  };
  const count = new Intl.NumberFormat("en-GB");
  const score = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 });
  const safe = value => String(value ?? "").replace(/[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

  function options(values, label) {
    return values.map(value => `<option value="${safe(value)}">${safe(label(value))}</option>`).join("");
  }

  function thresholdGuide(bundle, methods) {
    const display = value => Number.isFinite(value) ? score.format(value) : "Disabled";
    return Object.entries(methods).map(([id, label]) => {
      const threshold = id === "ensemble" ? 1 : bundle.thresholds[id];
      const ensembleThresholds = id === "ensemble"
        ? ` · OR across XGBoost ${display(bundle.ensemble.thresholds.xgboost)} and GRU ${display(bundle.ensemble.thresholds.gru_autoencoder)}`
        : "";
      return `<li><strong>${safe(label)}</strong> · ${scoreLabels[id]} · Threshold ${display(threshold)}${ensembleThresholds}</li>`;
    }).join("");
  }

  function scoreCell(result) {
    if (!Number.isFinite(result.score)) {
      return '<td><span class="tech-score-state">Unavailable</span></td>';
    }
    const status = result.alert ? "Alert" : Number.isFinite(result.threshold) ? "No alert" : "Disabled";
    return `<td><strong class="tech-score">${score.format(result.score)}</strong>
      <span class="tech-score-state${result.alert ? " is-alert" : ""}">${status}</span></td>`;
  }

  function mount(container, { cohort, bundle, benchmark, methods }) {
    const patients = cohort.patients;
    const dates = cohort.dates.slice().reverse();
    const byId = new Map(patients.map(patient => [patient.patient_id, patient]));
    const episodesByPatient = new Map();
    for (const event of benchmark.events) {
      if (!episodesByPatient.has(event.patient_id)) episodesByPatient.set(event.patient_id, []);
      episodesByPatient.get(event.patient_id).push(event);
    }
    const cache = new Map();
    let page = 0;

    container.innerHTML = `
      <header class="tech-pred-intro">
        <h2 id="prediction-title">Patient-day predictions</h2>
        <p>${count.format(patients.length)} patients · ${count.format(dates.length)} dates · ${count.format(patients.length * dates.length)} patient-days</p>
        <p>Scores use readings through the selected date and each approach’s own alert threshold.</p>
      </header>
      <div class="tech-toolbar">
        <label><span id="tech-pred-patient-label">Patient</span>
          <select data-pred-filter="patient" aria-labelledby="tech-pred-patient-label">
            <option value="">All patients</option>
            ${options(patients.map(patient => patient.patient_id), id => id)}
          </select>
        </label>
        <label><span id="tech-pred-date-label">Date</span>
          <select data-pred-filter="date" aria-labelledby="tech-pred-date-label"><option value="">All dates</option>${options(dates, date => date)}</select>
        </label>
        <label><span id="tech-pred-size-label">Rows per page</span>
          <select data-pred-filter="size" aria-labelledby="tech-pred-size-label"><option value="50">50</option><option value="25">25</option></select>
        </label>
      </div>
      <details class="tech-pred-thresholds">
        <summary>Score scales and thresholds</summary>
        <ul>${thresholdGuide(bundle, methods)}</ul>
        <p>Displayed scores are rounded. Alert decisions use the full score. Unavailable indicates missing measurements or insufficient history for the approach.</p>
      </details>
      <div class="tech-table-wrap" tabindex="0" role="region" aria-labelledby="prediction-title">
        <table class="tech-table tech-pred-table">
          <thead><tr><th scope="col">Patient / split</th><th scope="col">Date</th><th scope="col">Injected episode</th>
            ${Object.values(methods).map(label => `<th scope="col">${safe(label)}</th>`).join("")}</tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="tech-pagination">
        <p class="tech-pred-count" role="status"></p>
        <button type="button" data-pred-page="previous">Previous</button>
        <button type="button" data-pred-page="next">Next</button>
      </div>`;

    const select = name => container.querySelector(`[data-pred-filter="${name}"]`);
    const tbody = container.querySelector("tbody");
    const previous = container.querySelector('[data-pred-page="previous"]');
    const next = container.querySelector('[data-pred-page="next"]');
    const range = container.querySelector(".tech-pred-count");

    function patientDateScores(patient, date) {
      const key = patient.patient_id + "/" + date;
      if (!cache.has(key)) {
        const history = patient.readings.filter(reading => reading.date <= date);
        if (!history.some(reading => reading.date === date)) history.push({ date });
        cache.set(key, globalThis.CareModels.scorePatient(history, bundle, { explain: false }));
      }
      return cache.get(key);
    }

    function row(patient, date) {
      const id = patient.patient_id;
      const split = splitLabels[benchmark.patient_splits[id]] ?? "Unassigned";
      const scores = patientDateScores(patient, date);
      const active = (episodesByPatient.get(id) ?? [])
        .filter(event => event.onset_date <= date && date <= event.end_date)
        .map(event => episodeLabels[event.event_type] ?? event.event_type);
      return `<tr>
        <th scope="row">${safe(id)}<span class="tech-pred-split">${safe(split)}</span></th>
        <td><time datetime="${safe(date)}">${safe(date)}</time></td>
        <td>${active.length ? safe([...new Set(active)].join(", ")) : "None"}</td>
        ${Object.keys(methods).map(method => scoreCell(scores[method])).join("")}
      </tr>`;
    }

    function render() {
      const patientId = select("patient").value;
      const date = select("date").value;
      const pageSize = Number(select("size").value);
      const visiblePatients = patientId ? [byId.get(patientId)] : patients;
      const visibleDates = date ? [date] : dates;
      const patientCount = visiblePatients.length;
      const total = patientCount * visibleDates.length;
      const start = page * pageSize;
      const end = Math.min(start + pageSize, total);
      const rows = [];
      for (let index = start; index < end; index++) {
        rows.push(row(visiblePatients[index % patientCount], visibleDates[Math.floor(index / patientCount)]));
      }
      tbody.innerHTML = rows.join("");
      range.textContent = total ? `Showing ${count.format(start + 1)}–${count.format(end)} of ${count.format(total)} patient-days`
        : "No patient-days";
      previous.disabled = page === 0;
      next.disabled = end >= total;
    }

    for (const name of ["patient", "date", "size"]) {
      select(name).addEventListener("change", () => {
        page = 0;
        render();
      });
    }
    previous.addEventListener("click", () => {
      page -= 1;
      render();
      if (previous.disabled) next.focus();
    });
    next.addEventListener("click", () => {
      page += 1;
      render();
      if (next.disabled) previous.focus();
    });
    render();
  }

  globalThis.CarePredictions = { mount };
})();
