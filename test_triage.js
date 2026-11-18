const test = require("node:test");
const assert = require("node:assert/strict");
const cohort = require("./dist/data/cohort.json");
const bundle = require("./dist/data/models.json");
require("./dist/models.js");
require("./dist/triage.js");
require("./dist/vital-chart.js");

const latest = cohort.dates.at(-1);
const normal = {
  date: latest,
  systolic_mmhg: 125, diastolic_mmhg: 78, pulse_bpm: 73, spo2_pct: 97,
  fasting_glucose_mg_dl: 110, oral_temperature_c: 36.5,
};

function assessPatient(id) {
  const patient = cohort.patients.find(row => row.patient_id === id);
  return CareTriage.assess(patient.readings, bundle);
}

test("partial readings are incomplete even when a model can calculate a score", () => {
  const result = assessPatient("P029");
  assert.equal(result.status, "Incomplete");
  assert.deepEqual(result.missing, ["Systolic BP", "Diastolic BP"]);
});

test("missing readings stay visible on both types of alert", () => {
  const review = assessPatient("P023");
  assert.equal(review.status, "Review");
  assert.deepEqual(review.missing, ["Fasting glucose"]);
  assert.equal(review.fieldHighlights.spo2_pct, "pattern");
  assert.equal(review.fieldHighlights.systolic_mmhg, "warning");
  const warning = assessPatient("P024");
  assert.equal(warning.status, "Early warning");
  assert.deepEqual(warning.missing, ["Fasting glucose"]);
  assert.match(warning.headline, /limit/);
});

test("short histories use clinical limits and preserve stronger alerts", () => {
  const initial = CareTriage.assess([normal], bundle);
  assert.equal(initial.status, "No alert");
  assert.ok(initial.evidence.some(item => item.title === "Limited reading history"));
  const warning = CareTriage.assess([{date: latest, systolic_mmhg: 145}], bundle);
  assert.equal(warning.status, "Early warning");
  assert.equal(warning.missing.length, 5);
  const review = CareTriage.assess([{date: latest, spo2_pct: 88}], bundle);
  assert.equal(review.status, "Review");
  assert.ok(review.highPriorityLimit);
  assert.equal(review.missing.length, 5);
});

test("a completely blank date has no alert and lists every missing measurement", () => {
  const result = CareTriage.assess([{date: latest}], bundle);
  assert.equal(result.status, "Incomplete");
  assert.equal(result.missing.length, 6);
  assert.match(result.headline, /No readings/);
});

test("the chart links the exact dates of Review and Early warning, including missing plotted vitals", () => {
  const points = [
    {date: "2026-11-16", value: 123, status: "No alert"},
    {date: "2026-11-17", value: null, status: "Review", reason: "Oxygen reading crossed a limit."},
    {date: "2026-11-18", value: 144, status: "Early warning", reason: "Blood pressure crossed a limit."},
  ];
  const markup = CareTrend.render({points, field: "systolic_mmhg", label: "Systolic BP", unit: "mmHg"});
  assert.match(markup, /data-alert-date="2026-11-17"/);
  assert.match(markup, /data-alert-date="2026-11-18"/);
  assert.doesNotMatch(markup, /data-alert-date="2026-11-16"/);
});
