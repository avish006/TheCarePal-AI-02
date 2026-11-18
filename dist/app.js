(() => {
  "use strict";

  const fields = {
    systolic_mmhg: ["Systolic BP", "mmHg"],
    diastolic_mmhg: ["Diastolic BP", "mmHg"],
    pulse_bpm: ["Pulse", "bpm"],
    spo2_pct: ["Oxygen saturation", "%"],
    fasting_glucose_mg_dl: ["Fasting glucose", "mg/dL"],
    oral_temperature_c: ["Oral temperature", "°C"]
  };
  const methods = {
    ensemble: {
      name: "Ensemble",
      description: "Review when either model crosses its ensemble threshold. Scores of 1 and above trigger review.",
      unit: "Threshold ratio"
    },
    xgboost: {
      name: "XGBoost",
      description: "A supervised tree model using current readings and recent trends. Its 0–1 output is a model score.",
      unit: "Model score"
    },
    gru_autoencoder: {
      name: "GRU autoencoder",
      description: "Compares the latest readings with a reconstruction of the recent sequence. A larger error raises the score.",
      unit: "Reconstruction error"
    },
    clinical_rules: {
      name: "Clinical rules",
      description: "Checks measured vitals against fixed clinical thresholds. A score of 1 or 2 triggers review.",
      unit: "Rule level"
    },
    statistical_baseline: {
      name: "Statistical baseline",
      description: "Compares each reading with the patient's own history and increases the score for persistent changes.",
      unit: "Deviation score"
    }
  };
  const statuses = {
    Review: { style: "review", caption: "At or above the alert threshold" },
    "Below threshold": { style: "routine", caption: "Score available, no alert" },
    Incomplete: { style: "incomplete", caption: "Too little data for a score" }
  };
  const cohorts = { train: "Training", validation: "Validation", test: "Held-out test" };
  const kinds = { fever: "Fever", hypertension: "High blood pressure", low_sugar: "Low blood sugar", oxygen_drop: "Oxygen drop" };
  const byId = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatDate = options => new Intl.DateTimeFormat("en-GB", options);
  const fullDate = formatDate({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dateLabel = formatDate({ day: "numeric", month: "short", year: "numeric" });
  const shortDate = formatDate({ day: "numeric", month: "short" });
  const parseDate = day => new Date(day + "T12:00:00");
  const numberText = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });
  const percentText = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
  const views = ["monitoring", "intake", "evaluation"];
  const state = {
    cohort: null, bundle: null, date: null, method: "ensemble", selected: null,
    vital: "systolic_mmhg", lookback: 14, patients: [], explanations: new Map(),
    evaluation: null, evalSplit: "test", evalMethod: "ensemble"
  };

  async function readJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Asset unavailable");
    return response.json();
  }

  function noScore() {
    return { score: null, threshold: null, alert: false, reason: "No vital readings were recorded for this date." };
  }

  function statusOf(result) {
    if (!Number.isFinite(result.score)) return "Incomplete";
    return result.alert ? "Review" : "Below threshold";
  }

  function badge(status) {
    return `<span class="badge ${statuses[status].style}">${status}</span>`;
  }

  function scoreText(value) {
    return Number.isFinite(value) ? numberText.format(value) : "—";
  }

  function displayVital(field, value) {
    if (!Number.isFinite(value)) return "—";
    return field === "oral_temperature_c" ? value.toFixed(1) : String(value);
  }

  function isPanelVisible(view) {
    return !byId(view + "-panel").hidden;
  }

  function changeView() {
    const hash = location.hash.slice(1);
    if (hash && !views.includes(hash)) return;
    const active = views.includes(hash) ? hash : "monitoring";
    for (const view of views) {
      const selected = view === active;
      byId(view + "-panel").hidden = !selected;
      const link = document.querySelector(`[data-view="${view}"]`);
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (active === "evaluation") loadEvaluation();
  }

  function drawModelTabs() {
    byId("model-tabs").innerHTML = Object.entries(methods).map(([id, method]) => {
      const active = id === state.method;
      return `<button type="button" role="tab" id="tab-${id}" data-method="${id}" aria-controls="model-panel"
        aria-selected="${active}" tabindex="${active ? 0 : -1}">${method.name}</button>`;
    }).join("");
    byId("model-description").textContent = methods[state.method].description;
    byId("model-panel").setAttribute("aria-labelledby", "tab-" + state.method);
  }

  function setMethod(method, focus = false) {
    if (!(method in methods)) return;
    state.method = method;
    drawModelTabs();
    drawQueue();
    if (focus) byId("tab-" + method).focus();
  }

  function computeDay(date) {
    state.date = date;
    state.explanations.clear();
    state.patients = state.cohort.patients.map(patient => {
      const history = patient.readings.filter(point => point.date <= date);
      const latest = history.at(-1);
      const values = latest?.date === date ? latest : { date };
      const days = latest?.date === date ? history : [...history, values];
      const results = history.length ? globalThis.CareModels.scorePatient(days, state.bundle, { explain: false })
        : Object.fromEntries(Object.keys(methods).map(key => [key, noScore()]));
      return { ...patient, history: days, values, results };
    });
    byId("day-caption").textContent = fullDate.format(parseDate(date)) + " · " +
      numberText.format(state.patients.length) + " synthetic patients";
    drawQueue();
  }

  function drawSummary() {
    const counts = Object.fromEntries(Object.keys(statuses).map(status => [status, 0]));
    for (const patient of state.patients) counts[statusOf(patient.results[state.method])]++;
    byId("summary").innerHTML = Object.entries(statuses).map(([status, meta]) => {
      const active = byId("level").value === status;
      return `<button type="button" class="stat ${meta.style}" data-level="${status}" aria-pressed="${active}">
        <span class="stat-copy"><span class="stat-label"><span aria-hidden="true"></span>${status}</span>
        <span class="stat-caption">${meta.caption}</span></span><strong class="stat-value">${counts[status]}</strong></button>`;
    }).join("");
  }

  function drawQueue() {
    const query = byId("search").value.trim().toLowerCase();
    const level = byId("level").value;
    const visible = state.patients.map(patient => ({ patient, result: patient.results[state.method] }))
      .filter(({ patient, result }) =>
        patient.patient_id.toLowerCase().includes(query) && (!level || statusOf(result) === level))
      .sort((a, b) => Number(b.result.alert) - Number(a.result.alert)
        || (b.result.score ?? -Infinity) - (a.result.score ?? -Infinity)
        || a.patient.patient_id.localeCompare(b.patient.patient_id));
    if (!visible.some(({ patient }) => patient.patient_id === state.selected)) {
      state.selected = visible[0]?.patient.patient_id ?? null;
    }
    byId("queue-count").textContent = visible.length;
    byId("patient-rows").innerHTML = visible.map(({ patient, result }) => {
      const patientId = escapeHTML(patient.patient_id);
      return `<button type="button" class="patient" data-patient="${patientId}" aria-pressed="${patient.patient_id === state.selected}">
        <span><strong>${patientId}</strong><span class="age">Age ${escapeHTML(patient.age)}</span></span>
        <span>${badge(statusOf(result))}<span class="reason">${escapeHTML(result.reason)}</span></span>
        <span class="risk">${scoreText(result.score)}</span></button>`;
    }).join("") || '<p class="empty">No patients match your search and status filter.</p>';
    drawSummary();
    drawDetails();
  }

  function drawChart(history) {
    const points = history.slice(-state.lookback);
    const readings = points.map(point => point[state.vital]);
    const values = readings.filter(Number.isFinite);
    if (!values.length) return '<p class="empty inline-empty">No readings were recorded in this period.</p>';
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const margin = Math.max((maximum - minimum) * 0.14, state.vital === "oral_temperature_c" ? 0.15 : 1);
    const low = minimum - margin;
    const high = maximum + margin;
    const x = index => points.length === 1 ? 220 : 42 + index * 374 / (points.length - 1);
    const y = value => 11 + (high - value) * 103 / (high - low);
    let grid = "";
    for (let index = 0; index < 3; index++) {
      const tick = low + (high - low) * index / 2;
      grid += `<line class="grid" x1="42" x2="416" y1="${y(tick)}" y2="${y(tick)}"/>
        <text x="36" y="${y(tick) + 3}" text-anchor="end">${tick.toFixed(state.vital === "oral_temperature_c" ? 1 : 0)}</text>`;
    }
    let path = "";
    let consecutive = false;
    let markers = "";
    readings.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        consecutive = false;
        return;
      }
      path += (consecutive ? " L" : " M") + x(index) + " " + y(value);
      consecutive = true;
      markers += `<circle class="point" r="3.6" cx="${x(index)}" cy="${y(value)}">
        <title>${escapeHTML(points[index].date)} · ${displayVital(state.vital, value)} ${fields[state.vital][1]}</title></circle>`;
    });
    const first = shortDate.format(parseDate(points[0].date));
    const last = shortDate.format(parseDate(points.at(-1).date));
    const [label, unit] = fields[state.vital];
    const endLabel = points.length > 1 ? `<text x="416" y="138" text-anchor="end">${last}</text>` : "";
    return `<svg class="chart" viewBox="0 0 430 142" role="img" aria-label="${label} trend from ${first} to ${last}, range ${minimum} to ${maximum} ${unit}.">
       ${grid}<path class="line" d="${path}"/>${markers}<text x="42" y="138">${first}</text>${endLabel}</svg>`;
  }

  function drawDetails() {
    const patient = state.patients.find(item => item.patient_id === state.selected);
    if (!patient) {
      byId("details").innerHTML = '<p class="empty">Select a patient to view readings and history.</p>';
      return;
    }
    let results = state.explanations.get(patient.patient_id);
    if (!results) {
      results = patient.history.length
        ? globalThis.CareModels.scorePatient(patient.history, state.bundle)
        : patient.results;
      state.explanations.set(patient.patient_id, results);
    }
    const result = results[state.method];
    const stateLabel = statusOf(result);
    const currentMethod = methods[state.method];
    const vitalButtons = Object.entries(fields).map(([key, [label, unit]]) => {
      const value = displayVital(key, patient.values[key]);
      return `<button type="button" class="vital" data-field="${key}" aria-pressed="${key === state.vital}" aria-label="Show ${label} history, current reading ${value} ${unit}">
        <span class="vital-name">${label}</span><span class="vital-value">${value}</span><span class="vital-unit">${unit}</span></button>`;
    }).join("");
    const missing = Object.entries(fields).filter(([key]) => !Number.isFinite(patient.values[key]))
      .map(([, [label]]) => label);
    const contextIds = state.method === "ensemble"
      ? ["xgboost", "gru_autoencoder", "clinical_rules", "statistical_baseline"]
      : ["clinical_rules", "statistical_baseline"].filter(id => id !== state.method);
    const contexts = contextIds.map(id => {
      const context = results[id];
      let label = statusOf(context);
      if (state.method === "ensemble" && (id === "xgboost" || id === "gru_autoencoder")) {
        const threshold = state.bundle.ensemble.thresholds[id];
        label = Number.isFinite(threshold) && Number.isFinite(context.score)
          ? context.score >= threshold ? "Review" : "Below threshold"
          : "Incomplete";
      }
      return `<div><span>${methods[id].name}</span>${badge(label)}</div>`;
    }).join("");
    byId("details").innerHTML = `
      <div class="detail-head ${statuses[stateLabel].style}">
        <div class="detail-kicker"><span>${escapeHTML(cohorts[patient.split] ?? "Synthetic cohort")}</span>
        <button type="button" class="back" id="back-queue">Back to queue</button></div>
        <div class="detail-identity"><h2>${escapeHTML(patient.patient_id)}</h2><span class="detail-age">Age ${escapeHTML(patient.age)}</span>${badge(stateLabel)}</div>
        <div class="assessment-score"><strong>${scoreText(result.score)}</strong>
          <span>${currentMethod.unit}${Number.isFinite(result.threshold) ? " · Threshold " + scoreText(result.threshold) : ""}</span></div>
        <h3 class="why-title">Assessment details</h3>
        <p class="assessment">${escapeHTML(result.reason)}</p>
      </div>
      <div class="detail-section"><div class="section-heading"><h3>Current vitals</h3><span class="section-note">Select a vital to see its trend</span></div>
        <div class="vitals">${vitalButtons}</div>
        ${missing.length ? '<p class="missing">Missing readings · ' + missing.join(", ") + "</p>" : ""}</div>
      <div class="detail-section"><div class="section-heading"><h3>Vital history</h3>
        <select class="chart-select" id="lookback" aria-label="History period">${[7, 14].map(days =>
          `<option value="${days}"${state.lookback === days ? " selected" : ""}>Last ${days} days</option>`).join("")}</select></div>
        <p class="chart-summary">${fields[state.vital].join(" · ")}</p>${drawChart(patient.history)}</div>
      <div class="detail-section context-section"><h3>${state.method === "ensemble" ? "Model and clinical context" : "Clinical context"}</h3>
        <div class="clinical-context">${contexts}</div></div>`;
  }

  function showRetry(container, message, retry) {
    container.replaceChildren();
    const title = document.createElement("span");
    title.textContent = message;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Try again";
    button.addEventListener("click", retry);
    container.append(title, button);
  }

  async function loadDashboard() {
    const status = byId("status");
    status.hidden = false;
    status.textContent = "Loading patient readings and trained models…";
    try {
      [state.cohort, state.bundle] = await Promise.all([readJSON("./data/cohort.json"), globalThis.CareModels.load()]);
      const selector = byId("review-date");
      selector.innerHTML = state.cohort.dates.slice().reverse().map(date =>
        `<option value="${escapeHTML(date)}">${dateLabel.format(parseDate(date))}</option>`).join("");
      selector.disabled = false;
      drawModelTabs();
      computeDay(selector.value);
      status.hidden = true;
      byId("workspace").hidden = false;
    } catch (error) {
      console.error(error);
      showRetry(status, "The readings or trained models could not be loaded.", loadDashboard);
    }
  }

  function drawEvaluation() {
    const evaluation = state.evaluation;
    const rows = evaluation.metrics.filter(row => row.split === state.evalSplit);
    const combined = rows.find(row => row.model === "ensemble");
    if (!combined) return;
    const grouped = evaluation.by_type.filter(row => row.split === state.evalSplit && row.model === state.evalMethod);
    const range = state.evalSplit === "test" ? "Held-out test" : "Validation";
    const splitTabs = [ ["test", "Held-out test"], ["validation", "Validation"] ].map(([name, label]) =>
      `<button type="button" data-eval-split="${name}" aria-pressed="${state.evalSplit === name}">${label}</button>`).join("");
    const table = Object.keys(methods).map(key => {
      const row = rows.find(item => item.model === key);
      if (!row) return "";
      return `<tr class="${key === "ensemble" ? "highlight" : ""}">
        <th scope="row">${methods[key].name}</th>
        <td><strong>${row.episodes_detected}/${row.episodes}</strong></td>
        <td>${row.early_gradual_episodes}/${row.gradual_episodes}</td>
        <td>${percentText.format(row.day_recall)}</td>
        <td>${percentText.format(row.precision)}</td>
        <td>${row.false_positive_days}</td></tr>`;
    }).join("");
    byId("evaluation-content").innerHTML = `<div class="evaluation-top">
      <div class="segmented" aria-label="Evaluation split">${splitTabs}</div>
      <span>${range} · Days ${evaluation.calibration_days + 1} onward</span></div>
      <div class="evaluation-stats" aria-label="Evaluation sample">
        <div><span>Patients</span><strong>${evaluation.split_counts[state.evalSplit]}</strong></div>
        <div><span>Patient-days</span><strong>${numberText.format(combined.patient_days)}</strong></div>
        <div><span>Injected episodes</span><strong>${combined.episodes}</strong></div>
      </div>
      <section class="panel evaluation-card" aria-labelledby="comparison-title">
        <div class="evaluation-section"><h2 id="comparison-title">Model comparison</h2>
          <p>An episode is caught when a model alerts at least once during its labeled window. Early alerts precede the planned peak of a gradual episode.</p></div>
        <div class="table-scroll" tabindex="0" aria-label="Scroll model metrics horizontally"><table class="metrics-table">
          <thead><tr><th scope="col">Scoring method</th><th scope="col">Episodes caught</th><th scope="col">Gradual episodes flagged early</th>
          <th scope="col">Daily recall</th><th scope="col">Precision</th><th scope="col">False-alert days</th></tr></thead>
          <tbody>${table}</tbody></table></div>
      </section>
      <section class="panel evaluation-card" aria-labelledby="episode-title">
        <div class="evaluation-section event-heading"><div><h2 id="episode-title">Episode breakdown</h2>
          <p>Alerts within each type of simulated episode.</p></div>
          <label class="date-wrap" for="episode-model">Scoring method<select id="episode-model">
          ${Object.entries(methods).map(([id, method]) => `<option value="${id}"${id === state.evalMethod ? " selected" : ""}>${method.name}</option>`).join("")}</select></label></div>
        <div class="table-scroll" tabindex="0" aria-label="Scroll episode breakdown horizontally"><table class="metrics-table breakdown-table">
          <thead><tr><th scope="col">Episode type</th><th scope="col">Episodes caught</th><th scope="col">Gradual episodes flagged early</th></tr></thead>
          <tbody>${grouped.map(row => `<tr><th scope="row">${escapeHTML(kinds[row.event_type] ?? row.event_type)}</th>
            <td>${row.detected}/${row.episodes}</td><td>${row.gradual_episodes ? row.detected_before_peak + "/" + row.gradual_episodes : "—"}</td></tr>`).join("")}</tbody></table></div>
      </section>
      <p class="evaluation-note">Training used ${evaluation.split_counts.train} separate patients. Learned alert thresholds were tuned on validation patients
       with a budget of ${evaluation.false_alert_budget} false alerts per patient-week. Test results describe this synthetic split.</p>`;
  }

  let evaluationPending = false;
  async function loadEvaluation() {
    if (state.evaluation || evaluationPending) return;
    evaluationPending = true;
    const panel = byId("evaluation-content");
    panel.textContent = "Loading evaluation…";
    try {
      state.evaluation = await readJSON("./data/evaluation.json");
      drawEvaluation();
    } catch (error) {
      console.error(error);
      state.evaluation = null;
      showRetry(panel, "The evaluation results could not be loaded.", loadEvaluation);
    } finally {
      evaluationPending = false;
    }
  }

  addEventListener("hashchange", changeView);
  byId("review-date").addEventListener("change", event => computeDay(event.target.value));
  byId("search").addEventListener("input", drawQueue);
  byId("level").addEventListener("change", drawQueue);
  byId("model-tabs").addEventListener("click", event => {
    const tab = event.target.closest("[data-method]");
    if (tab) setMethod(tab.dataset.method, true);
  });
  byId("model-tabs").addEventListener("keydown", event => {
    const keys = Object.keys(methods);
    const index = keys.indexOf(state.method);
    const destinations = { ArrowLeft: (index + keys.length - 1) % keys.length,
      ArrowRight: (index + 1) % keys.length, Home: 0, End: keys.length - 1 };
    if (Object.hasOwn(destinations, event.key)) {
      event.preventDefault();
      setMethod(keys[destinations[event.key]], true);
    }
  });
  byId("summary").addEventListener("click", event => {
    const tile = event.target.closest("[data-level]");
    if (!tile) return;
    const select = byId("level");
    const status = tile.dataset.level;
    select.value = select.value === status ? "" : status;
    drawQueue();
    Array.from(byId("summary").children).find(button => button.dataset.level === status)?.focus();
  });
  byId("patient-rows").addEventListener("click", event => {
    const item = event.target.closest("[data-patient]");
    if (!item) return;
    state.selected = item.dataset.patient;
    for (const row of byId("patient-rows").children) row.setAttribute("aria-pressed", String(row === item));
    drawDetails();
    if (matchMedia("(max-width: 760px)").matches) byId("details").focus();
  });
  byId("details").addEventListener("click", event => {
    if (event.target.id === "back-queue") {
      byId("patient-rows").querySelector('[aria-pressed="true"]')?.focus();
      return;
    }
    const button = event.target.closest("[data-field]");
    if (!button) return;
    state.vital = button.dataset.field;
    drawDetails();
    byId("details").querySelector(`[data-field="${state.vital}"]`).focus({ preventScroll: true });
  });
  byId("details").addEventListener("change", event => {
    if (event.target.id !== "lookback") return;
    state.lookback = Number(event.target.value);
    drawDetails();
    byId("lookback").focus({ preventScroll: true });
  });
  byId("evaluation-content").addEventListener("click", event => {
    const button = event.target.closest("[data-eval-split]");
    if (!button) return;
    state.evalSplit = button.dataset.evalSplit;
    drawEvaluation();
    byId("evaluation-content").querySelector(`[data-eval-split="${state.evalSplit}"]`).focus({ preventScroll: true });
  });
  byId("evaluation-content").addEventListener("change", event => {
    if (event.target.id !== "episode-model") return;
    state.evalMethod = event.target.value;
    drawEvaluation();
    byId("episode-model").focus({ preventScroll: true });
  });
  changeView();
  if (isPanelVisible("monitoring")) loadDashboard();
  else addEventListener("hashchange", () => {
    if (isPanelVisible("monitoring") && !state.cohort) loadDashboard();
  });
})();
