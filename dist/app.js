(() => {
  "use strict";

  const fields = {
    systolic_mmhg: ["Systolic BP", "mmHg"],
    diastolic_mmhg: ["Diastolic BP", "mmHg"],
    pulse_bpm: ["Pulse", "bpm"],
    spo2_pct: ["Oxygen saturation", "%"],
    fasting_glucose_mg_dl: ["Fasting glucose", "mg/dL"],
    oral_temperature_c: ["Oral temperature", "°C"],
  };
  const statuses = {
    Review: { style: "review", caption: "Check these patients first" },
    "Early warning": { style: "warning", caption: "A reading crossed a clinical limit" },
    Incomplete: { style: "incomplete", caption: "One or more readings are missing" },
    "No alert": { style: "routine", caption: "All readings recorded, no alert" },
  };
  const byId = id => document.getElementById(id);
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const parseDate = day => new Date(day + "T12:00:00");
  const fullDate = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const state = {
    cohort: null, bundle: null, date: null, selected: null, patients: [], loading: false,
    vital: "systolic_mmhg", lookback: 14, daily: new Map(), explanations: new Map(),
  };

  function changeView() {
    const hash = location.hash.slice(1);
    const onIntake = hash === "intake" || (hash === "main" && !byId("intake-panel").hidden);
    const active = onIntake ? "intake" : "monitoring";
    for (const view of ["monitoring", "intake"]) {
      const selected = view === active;
      byId(view + "-panel").hidden = !selected;
      const link = document.querySelector(`[data-view="${view}"]`);
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (active === "monitoring" && !state.cohort) loadDashboard();
  }

  function readingsThrough(patient, date) {
    const history = patient.readings.filter(point => point.date <= date);
    if (history.at(-1)?.date !== date) history.push({ date });
    return history;
  }

  function assessmentFor(patient, date, explain = false) {
    const cache = explain ? state.explanations : state.daily;
    const key = patient.patient_id + "/" + date;
    if (!cache.has(key)) {
      cache.set(key, globalThis.CareTriage.assess(readingsThrough(patient, date), state.bundle, { explain }));
    }
    return cache.get(key);
  }

  function computeDay(date) {
    state.date = date;
    state.patients = state.cohort.patients.map(patient => {
      const values = patient.readings.find(point => point.date === date) ?? { date };
      return { ...patient, values, assessment: assessmentFor(patient, date) };
    });
    byId("day-caption").textContent = fullDate.format(parseDate(date)) + " · " +
      state.patients.length + " synthetic patients";
    drawQueue();
  }

  function matchesStatus(assessment, filter) {
    if (!filter) return true;
    if (filter === "Incomplete") return assessment.missing.length > 0;
    return assessment.status === filter;
  }

  function badges(assessment) {
    const labels = [assessment.status];
    if (assessment.missing.length && assessment.status !== "Incomplete") labels.push("Incomplete");
    return '<span class="badges">' + labels.map(label =>
      `<span class="badge ${statuses[label].style}">${label}</span>`).join("") + "</span>";
  }

  function drawSummary() {
    byId("summary").innerHTML = Object.entries(statuses).map(([label, meta]) => {
      const active = byId("level").value === label;
      const count = state.patients.filter(patient => matchesStatus(patient.assessment, label)).length;
      return `<button type="button" class="stat ${meta.style}" data-level="${label}" aria-pressed="${active}">
        <span class="stat-copy"><span class="stat-label"><span aria-hidden="true"></span>${label}</span>
        <span class="stat-caption">${meta.caption}</span></span><strong class="stat-value">${count}</strong></button>`;
    }).join("");
  }

  function drawQueue() {
    const query = byId("search").value.trim().toLowerCase();
    const filter = byId("level").value;
    const visible = state.patients.filter(patient =>
      patient.patient_id.toLowerCase().includes(query) && matchesStatus(patient.assessment, filter))
      .sort((a, b) => b.assessment.priority - a.assessment.priority
        || Number(b.assessment.highPriorityLimit) - Number(a.assessment.highPriorityLimit)
        || (b.assessment.patternScore ?? 0) - (a.assessment.patternScore ?? 0)
        || a.patient_id.localeCompare(b.patient_id));
    if (!visible.some(patient => patient.patient_id === state.selected)) {
      state.selected = visible[0]?.patient_id ?? null;
    }
    byId("queue-count").textContent = visible.length;
    byId("patient-rows").innerHTML = visible.map(({patient_id, age, assessment}) =>
      `<button type="button" class="patient" data-patient="${escapeHTML(patient_id)}" aria-pressed="${patient_id === state.selected}">
        <span><strong>${escapeHTML(patient_id)}</strong><span class="age">Age ${escapeHTML(age)}</span></span>
        <span>${badges(assessment)}<span class="reason">${escapeHTML(assessment.headline)}</span>
        ${assessment.missing.length && assessment.status !== "Incomplete"
          ? `<span class="readings-count">${assessment.missing.length} of ${state.bundle.vitals.length} readings missing</span>` : ""}</span></button>`
    ).join("") || '<p class="empty">No patients match this search and filter.</p>';
    drawSummary();
    drawDetails();
  }

  function drawChart(patient) {
    const dates = state.cohort.dates;
    const end = dates.indexOf(state.date) + 1;
    const byDate = new Map(patient.readings.map(reading => [reading.date, reading]));
    const points = dates.slice(Math.max(0, end - state.lookback), end).map(date => {
      const assessment = assessmentFor(patient, date);
      return {
        date, status: assessment.status, reason: assessment.headline,
        value: byDate.get(date)?.[state.vital] ?? null,
      };
    });
    const [label, unit] = fields[state.vital];
    return globalThis.CareTrend.render({ points, field: state.vital, label, unit });
  }

  function vitalCard(field, [label, unit], patient, assessment) {
    const value = patient.values[field];
    const observed = Number.isFinite(value);
    const shown = observed ? (field === "oral_temperature_c" ? value.toFixed(1) : value) : "Missing";
    const severity = observed ? assessment.fieldHighlights[field] : undefined;
    const flag = {review: "Review limit", warning: "Clinical limit", pattern: "Pattern evidence"}[severity];
    return `<button type="button" class="vital${flag ? " flagged-vital" : ""}${observed ? "" : " missing-vital"}"
      data-field="${field}"${flag ? ` data-severity="${severity}"` : ""}
      aria-pressed="${field === state.vital}" aria-label="Show ${label} history. ${observed ? `Recorded ${shown} ${unit}.` : "Reading missing."}${flag ? " " + flag + "." : ""}">
      <span class="vital-name">${label}</span><span class="vital-value">${shown}</span>
      ${observed ? `<span class="vital-unit">${unit}</span>` : ""}
      ${flag ? `<span class="vital-flag-label">${flag}</span>` : ""}</button>`;
  }

  function drawDetails() {
    const panel = byId("details");
    const patient = state.patients.find(item => item.patient_id === state.selected);
    if (!patient) {
      panel.innerHTML = '<p class="empty">Select a patient to see readings and alert dates.</p>';
      return;
    }
    const record = patient.patient_id + "/" + state.date;
    const explainOpened = panel.dataset.record === record && panel.querySelector(".alert-explanation")?.open;
    panel.dataset.record = record;
    const assessment = assessmentFor(patient, state.date, true);
    const total = state.bundle.vitals.length;
    const recorded = total - assessment.missing.length;
    panel.innerHTML = `
      <div class="detail-head ${statuses[assessment.status].style}">
        <div class="detail-kicker"><span class="detail-reading-date">${dateLabel.format(parseDate(state.date))}</span>
        <button type="button" class="back" id="back-queue">Back to queue</button></div>
        <div class="detail-identity"><h2>${escapeHTML(patient.patient_id)}</h2>
          <span class="detail-age">Age ${escapeHTML(patient.age)}</span>${badges(assessment)}</div>
        <p class="assessment">${escapeHTML(assessment.headline)}</p>
        <details class="alert-explanation"${explainOpened ? " open" : ""}>
          <summary>How was this assessment made?</summary>
          <dl>${assessment.evidence.map(({title, text}) =>
            `<div><dt>${escapeHTML(title)}</dt><dd>${escapeHTML(text)}</dd></div>`).join("")}</dl>
        </details>
      </div>
      <div class="detail-section">
        <div class="section-heading"><h3>Recorded vitals</h3><span class="section-note">${recorded} of ${total} recorded</span></div>
        <div class="vitals">${Object.entries(fields).map(([field, label]) => vitalCard(field, label, patient, assessment)).join("")}</div>
      </div>
      <div class="detail-section">
        <div class="section-heading"><h3>Vital history</h3>
          <select class="chart-select" id="lookback" aria-label="History period">${[7, 14].map(days =>
            `<option value="${days}"${state.lookback === days ? " selected" : ""}>Last ${days} days</option>`).join("")}</select></div>
        <p class="chart-summary">${fields[state.vital].join(" · ")}</p>${drawChart(patient)}
      </div>`;
  }

  function chooseDate(date) {
    if (!state.cohort?.dates.includes(date)) return;
    byId("review-date").value = date;
    computeDay(date);
  }

  async function loadDashboard() {
    if (state.loading) return;
    state.loading = true;
    const status = byId("status");
    status.textContent = "Loading the review queue…";
    try {
      const [cohort, bundle] = await Promise.all([
        fetch("./data/cohort.json").then(response => {
          if (!response.ok) throw new Error("The patient readings could not be loaded.");
          return response.json();
        }),
        globalThis.CareModels.load(),
      ]);
      state.cohort = cohort;
      state.bundle = bundle;
      const selector = byId("review-date");
      selector.innerHTML = cohort.dates.slice().reverse().map(date =>
        `<option value="${escapeHTML(date)}">${dateLabel.format(parseDate(date))}</option>`).join("");
      chooseDate(selector.value);
      selector.disabled = false;
      status.hidden = true;
      byId("workspace").hidden = false;
    } catch (error) {
      console.error(error);
      state.cohort = null;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", loadDashboard);
      status.replaceChildren("The review queue could not be loaded. ", retry);
    } finally {
      state.loading = false;
    }
  }

  addEventListener("hashchange", changeView);
  byId("review-date").addEventListener("change", event => chooseDate(event.target.value));
  byId("search").addEventListener("input", drawQueue);
  byId("level").addEventListener("change", drawQueue);
  byId("summary").addEventListener("click", event => {
    const tile = event.target.closest("[data-level]");
    if (!tile) return;
    const level = tile.dataset.level;
    const select = byId("level");
    select.value = select.value === level ? "" : level;
    drawQueue();
    Array.from(byId("summary").children).find(button => button.dataset.level === level)?.focus();
  });
  byId("patient-rows").addEventListener("click", event => {
    const item = event.target.closest("[data-patient]");
    if (!item) return;
    state.selected = item.dataset.patient;
    for (const row of byId("patient-rows").children) row.setAttribute("aria-pressed", String(row === item));
    drawDetails();
    if (matchMedia("(max-width: 800px)").matches) byId("details").focus();
  });
  byId("details").addEventListener("click", event => {
    if (event.target.id === "back-queue") {
      byId("patient-rows").querySelector('[aria-pressed="true"]')?.focus();
      return;
    }
    const alert = event.target.closest("[data-alert-date]");
    if (alert) {
      byId("level").value = "";
      chooseDate(alert.dataset.alertDate);
      byId("details").focus();
      return;
    }
    const vital = event.target.closest("[data-field]");
    if (!vital) return;
    state.vital = vital.dataset.field;
    drawDetails();
    byId("details").querySelector(`[data-field="${state.vital}"]`).focus({ preventScroll: true });
  });
  byId("details").addEventListener("change", event => {
    if (event.target.id !== "lookback") return;
    state.lookback = Number(event.target.value);
    drawDetails();
    byId("lookback").focus({ preventScroll: true });
  });
  changeView();
})();
