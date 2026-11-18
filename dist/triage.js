/* Turn measured readings and the existing alert decisions into one nurse-facing status. */
(() => {
  "use strict";

  const status = {
    review: "Review", warning: "Early warning", incomplete: "Incomplete", routine: "No alert",
  };
  const priority = {[status.review]: 3, [status.warning]: 2, [status.incomplete]: 1, [status.routine]: 0};
  const DAY_MS = 86_400_000;
  const MIN_PATTERN_DAYS = 4;
  const number = new Intl.NumberFormat("en-GB", {maximumFractionDigits: 2, useGrouping: false});
  const quantity = (value, unit) => number.format(value) + (unit === "%" ? "%" : " " + unit);
  const measured = value => value != null && !(typeof value === "string" && !value.trim())
    && Number.isFinite(Number(value));

  function describeCrossing(vital) {
    const boundary = vital.boundary.replace(/ /g, "");
    const limit = vital.severity === 2 ? "review limit" : "alert limit";
    return `${vital.label} was ${quantity(vital.measured, vital.unit)}. The ${limit} is ${boundary}${vital.unit === "%" ? "%" : " " + vital.unit}.`;
  }

  function describeTreeFinding(finding, vitals) {
    const vital = vitals.find(({field}) => finding.feature.startsWith(field + "_"));
    if (!vital) return null;
    const feature = finding.feature.slice(vital.field.length + 1);
    const statements = {
      today: `${vital.label} was ${finding.value} on this date.`,
      change_1d: `${vital.label} changed by ${finding.value} since the previous day.`,
      change_3d: `${vital.label} changed by ${finding.value} compared with three days earlier.`,
      delta_from_prior_median: `${vital.label} differed by ${finding.value} from the recent median.`,
      prior_std: `${vital.label} varied across the recent readings.`,
    };
    return statements[feature] ? {field: vital.field, text: statements[feature]} : null;
  }

  function patternEvidence(scores, vitals) {
    const findings = [];
    const alerted = name => scores.ensemble.details.some(item => item.name === name && item.alert);
    if (alerted("xgboost")) {
      const findingsFromReadings = scores.xgboost.details
        .filter(item => item.contribution > 0 && item.value !== "unavailable"
          && !item.feature.endsWith("_prior_observation_fraction"))
        .map(item => describeTreeFinding(item, vitals)).filter(Boolean).slice(0, 2);
      findings.push(...findingsFromReadings);
    }
    if (alerted("gru_autoencoder") && scores.gru_autoencoder.details.length) {
      const vital = scores.gru_autoencoder.details[0];
      findings.push({field: vital.field, text: `${vital.label} was ${quantity(vital.measured, vital.unit)}. The estimate from the recent pattern was ${quantity(vital.reconstructed, vital.unit)}.`});
    }
    return findings;
  }

  function assess(readings, bundle, {explain = true} = {}) {
    const scores = globalThis.CareModels.scorePatient(readings, bundle, {explain});
    const latest = readings.reduce((item, reading) => !item || reading.date > item.date ? reading : item, null);
    const missing = bundle.vitals.filter(({field}) => !measured(latest?.[field])).map(({label}) => label);
    const cutoff = Date.parse(latest?.date) - (bundle.window_days - 1) * DAY_MS;
    const measuredDays = readings.filter(reading => Date.parse(reading.date) >= cutoff
      && bundle.vitals.some(({field}) => measured(reading[field]))).length;
    const crossed = scores.clinical_rules.details;
    const highPriorityLimit = scores.clinical_rules.score === 2;
    const canAssessPattern = measuredDays >= MIN_PATTERN_DAYS;
    const patternAlert = canAssessPattern && scores.ensemble.alert;
    const level = highPriorityLimit || patternAlert ? status.review
      : scores.clinical_rules.alert ? status.warning
      : missing.length ? status.incomplete : status.routine;
    const pattern = explain && patternAlert ? patternEvidence(scores, bundle.vitals) : [];
    const fieldHighlights = Object.fromEntries([
      ...pattern.map(item => [item.field, "pattern"]),
      ...crossed.map(vital => [vital.field, vital.severity === 2 ? "review" : "warning"]),
    ]);
    const evidence = [];

    if (crossed.length) {
      evidence.push({title: "Clinical limits", text: crossed.map(describeCrossing).join(" ")});
    } else if (missing.length < bundle.vitals.length) {
      evidence.push({title: "Clinical limits", text: "The recorded measurements stayed within the clinical alert limits used by this demo."});
    }
    if (patternAlert) {
      evidence.push({title: "Pattern in the readings", text: pattern.length
        ? pattern.map(item => item.text).join(" ")
        : "The pattern in the available readings reached the review threshold."});
    } else if (level === status.warning && canAssessPattern) {
      evidence.push({title: "Pattern in the readings", text: "The recent pattern stayed below the review threshold."});
    }
    if (!canAssessPattern && missing.length < bundle.vitals.length) {
      evidence.push({title: "Limited reading history",
        text: `Trend alerts use readings from at least ${MIN_PATTERN_DAYS} days within the last ${bundle.window_days} days. This assessment uses today's clinical limits.`});
    }
    if (explain && level !== status.routine) {
      const usual = scores.statistical_baseline.details.find(item => Object.hasOwn(fieldHighlights, item.field));
      if (usual) evidence.push({title: "Usual reading for this patient", text:
        `${usual.label} was ${quantity(usual.measured, usual.unit)}, compared with a usual value of ${quantity(usual.usual, usual.unit)}.`});
    }
    if (missing.length) {
      evidence.push({title: "Missing readings", text: missing.length === bundle.vitals.length
        ? "This date has no recorded measurements."
        : `${missing.join(", ")}. The assessment uses the readings that were recorded.`});
    }
    const headline = highPriorityLimit ? describeCrossing(crossed[0])
      : patternAlert ? "The pattern in the readings needs review."
        + (crossed.length ? " " + describeCrossing(crossed[0]) : "")
      : crossed.length ? describeCrossing(crossed[0])
      : missing.length === bundle.vitals.length ? "No readings were recorded for this date."
      : missing.length ? `${missing.length} of ${bundle.vitals.length} readings missing.`
      : canAssessPattern ? "The recorded readings did not trigger an alert."
      : "No clinical alert on this date. More readings are needed to check for trends.";

    return {status: level, headline, missing, evidence, fieldHighlights, priority: priority[level],
      highPriorityLimit, patternScore: canAssessPattern ? scores.ensemble.score : null};
  }

  globalThis.CareTriage = {assess};
})();
