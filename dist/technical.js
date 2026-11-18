(() => {
  "use strict";

  const methods = {
    ensemble: "Ensemble",
    xgboost: "XGBoost",
    gru_autoencoder: "GRU autoencoder",
    clinical_rules: "Clinical rules",
    statistical_baseline: "Statistical baseline",
  };
  const eventLabels = {
    fever: "Fever", hypertension: "High blood pressure", low_sugar: "Low blood sugar",
    oxygen_drop: "Oxygen drop",
  };
  const percent = new Intl.NumberFormat("en-GB", {style: "percent", maximumFractionDigits: 1});
  const count = new Intl.NumberFormat("en-GB");
  let loaded = false;
  let loading = false;

  function renderMetrics(panel, benchmark) {
    panel.innerHTML = `
      <div class="tech-section-head">
        <div><h2 id="technical-metrics-title">Model performance</h2>
          <p>Compare final detector metrics on validation and held-out test patients.</p></div>
        <label class="date-wrap" for="technical-split"><span id="technical-split-label">Evaluation split</span>
          <select id="technical-split" aria-labelledby="technical-split-label">
            <option value="test">Held-out test</option><option value="validation">Validation</option>
          </select></label>
      </div>
      <dl class="tech-sample" aria-live="polite"></dl>
      <div class="tech-table-wrap" tabindex="0" aria-label="Scroll model performance table">
        <table class="tech-table">
          <thead><tr>
            <th scope="col">Approach</th><th scope="col">Precision</th><th scope="col">Daily recall</th>
            <th scope="col">F1</th><th scope="col">Episode recall</th><th scope="col">Early gradual alerts</th>
            <th scope="col">Missed event-days</th><th scope="col">False-alert days</th>
            <th scope="col">False alerts per patient-week</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="tech-note">Metrics use days ${benchmark.calibration_days + 1} onward. Episode recall counts an episode if an alert falls anywhere in its labeled window. An early alert precedes the planned peak of a gradual episode. Learned thresholds use a validation budget of ${benchmark.false_alert_budget} false alerts per patient-week.</p>
      <details class="tech-breakdown">
        <summary>Episode breakdown by type</summary>
        <div class="tech-breakdown-content">
          <label class="date-wrap" for="technical-approach"><span id="technical-approach-label">Approach</span>
            <select id="technical-approach" aria-labelledby="technical-approach-label">${Object.entries(methods).map(([id, label]) =>
              `<option value="${id}">${label}</option>`).join("")}</select></label>
          <div class="tech-table-wrap" tabindex="0" aria-label="Scroll episode breakdown table">
            <table class="tech-table">
              <thead><tr><th scope="col">Episode type</th><th scope="col">Detected</th>
                <th scope="col">Early gradual alerts</th></tr></thead><tbody></tbody>
            </table>
          </div>
        </div>
      </details>`;

    const split = panel.querySelector("#technical-split");
    const approach = panel.querySelector("#technical-approach");
    const breakdown = panel.querySelector(".tech-breakdown tbody");

    function drawBreakdown() {
      const rows = benchmark.by_type.filter(row => row.split === split.value && row.model === approach.value);
      breakdown.innerHTML = rows.map(row => `
        <tr><th scope="row">${eventLabels[row.event_type] ?? "Other"}</th>
          <td>${row.detected}/${row.episodes}</td>
          <td>${row.gradual_episodes ? row.detected_before_peak + "/" + row.gradual_episodes : "—"}</td></tr>`
      ).join("");
    }

    function drawMetrics() {
      const rows = benchmark.metrics.filter(row => row.split === split.value);
      const sample = rows[0];
      panel.querySelector(".tech-sample").innerHTML = [
        ["Patients", benchmark.split_counts[split.value]],
        ["Patient-days", sample.patient_days],
        ["Labeled episodes", sample.episodes],
      ].map(([label, value]) => `<div><dt>${label}</dt><dd>${count.format(value)}</dd></div>`).join("");
      panel.querySelector(".tech-table tbody").innerHTML = Object.entries(methods).map(([id, label]) => {
        const row = rows.find(item => item.model === id);
        if (!row) return "";
        const total = row.precision + row.day_recall;
        const f1 = total ? 2 * row.precision * row.day_recall / total : 0;
        return `<tr><th scope="row">${label}</th><td>${percent.format(row.precision)}</td>
          <td>${percent.format(row.day_recall)}</td><td>${percent.format(f1)}</td>
          <td>${percent.format(row.episode_recall)} <span class="tech-muted">(${row.episodes_detected}/${row.episodes})</span></td>
          <td>${row.early_gradual_episodes}/${row.gradual_episodes}</td>
          <td>${row.missed_event_days}</td><td>${row.false_positive_days}</td>
          <td>${row.false_alerts_per_patient_week.toFixed(2)}</td></tr>`;
      }).join("");
      drawBreakdown();
    }

    split.addEventListener("change", drawMetrics);
    approach.addEventListener("change", drawBreakdown);
    drawMetrics();
  }

  async function open(loadCohort) {
    if (loaded || loading) return;
    loading = true;
    const status = document.getElementById("technical-status");
    status.textContent = "Loading predictions and benchmark data…";
    try {
      const [cohort, bundle, benchmark] = await Promise.all([
        loadCohort(), globalThis.CareModels.load(),
        fetch("./data/evaluation.json").then(response => {
          if (!response.ok) throw new Error("Benchmark data unavailable.");
          return response.json();
        }),
      ]);
      renderMetrics(document.getElementById("technical-metrics"), benchmark);
      globalThis.CarePredictions.mount(document.getElementById("technical-predictions"), {
        cohort, bundle, benchmark, methods,
      });
      status.hidden = true;
      document.getElementById("technical-content").hidden = false;
      loaded = true;
    } catch (error) {
      console.error(error);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => open(loadCohort));
      status.replaceChildren("The technical dashboard could not be loaded. ", retry);
    } finally {
      loading = false;
    }
  }

  globalThis.CareTechnical = {open};
})();
