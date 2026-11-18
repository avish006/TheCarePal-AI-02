/* Browser inference for the trained models exported by export_browser_models.py. */
(() => {
  const DAY_MS = 86_400_000;
  const F = Math.fround;
  const names = ["clinical_rules", "statistical_baseline", "xgboost", "gru_autoencoder", "ensemble"];
  const ensembleNames = {xgboost: "XGBoost", gru_autoencoder: "GRU autoencoder"};
  const statisticDescriptions = [
    "today", "change since yesterday", "change over three days",
    "change from the recent median", "recent variability", "recent observations available",
  ];
  let loading;

  function load() {
    loading ??= fetch(new URL("./data/models.json", document.baseURI)).then(async (response) => {
      if (!response.ok) throw new Error("The trained model files could not be loaded.");
      const bundle = await response.json();
      if (bundle.format_version !== 1 || bundle.ensemble?.decision !== "OR") {
        throw new Error("This version of the dashboard cannot use the supplied model files.");
      }
      return bundle;
    }).catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  }

  function historyByDay(readings, vitals) {
    const history = new Map();
    for (const reading of readings) {
      const date = reading.date;
      const ms = typeof date === "string" ? Date.parse(date) : NaN;
      if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
        throw new Error("Enter reading dates in YYYY-MM-DD format.");
      }
      const day = ms / DAY_MS;
      if (history.has(day)) throw new Error("Enter only one set of readings for each date.");
      const values = vitals.map(({field}) => {
        const value = reading[field];
        if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return NaN;
        if (typeof value !== "number" && typeof value !== "string") throw new Error("Enter numeric readings.");
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error("Enter numeric readings or leave missing values blank.");
        return number;
      });
      history.set(day, values);
    }
    return history;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
  }

  function format(value) {
    return Number(value.toFixed(3)).toString();
  }

  function measurement(value, unit) {
    return format(value) + (unit === "%" ? "%" : " " + unit);
  }

  function rule(field, value) {
    switch (field) {
      case "systolic_mmhg": return value > 180 ? [2, "> 180"] : value >= 140 ? [1, "≥ 140"] : [0, ""];
      case "diastolic_mmhg": return value > 120 ? [2, "> 120"] : value >= 90 ? [1, "≥ 90"] : [0, ""];
      case "pulse_bpm": return value < 60 ? [1, "< 60"] : value > 100 ? [1, "> 100"] : [0, ""];
      case "spo2_pct": return value <= 88 ? [2, "≤ 88"] : value <= 92 ? [1, "≤ 92"] : [0, ""];
      case "fasting_glucose_mg_dl": return value < 55 ? [2, "< 55"] : value < 70 ? [1, "< 70"] : [0, ""];
      case "oral_temperature_c": return value >= 38 ? [1, "≥ 38"] : [0, ""];
      default: throw new Error("Unknown field in the clinical rule set.");
    }
  }

  function result(score, threshold, reason, details = []) {
    return {score, alert: score !== null && threshold !== null && score >= threshold, threshold, reason, details};
  }

  function clinical(current, bundle) {
    const checks = bundle.vitals.flatMap((vital, index) => {
      if (!Number.isFinite(current[index])) return [];
      const [severity, boundary] = rule(vital.field, current[index]);
      return [{...vital, severity, boundary, measured: current[index]}];
    }).sort((a, b) => b.severity - a.severity);
    const crossed = checks.filter(({severity}) => severity > 0);
    const reason = crossed.length
      ? crossed.slice(0, 2).map(({label, measured, unit, boundary}) =>
        label + " " + measurement(measured, unit) + " (" + boundary + " " + unit + ")").join(" · ")
      : "Available readings are within the fixed alert bounds.";
    return result(checks[0]?.severity ?? null, bundle.thresholds.clinical_rules, reason, crossed);
  }

  function statistical(history, days, bundle) {
    const first = days[0];
    const latest = days[days.length - 1];
    const details = [];
    for (const [index, vital] of bundle.vitals.entries()) {
      const samples = [];
      let recent = [];
      let reference;
      for (const day of days) {
        const calibrating = day - first < bundle.calibration_days;
        if (calibrating || reference === undefined) {
          const center = median(samples);
          reference = samples.length < 7 ? null : {
            center,
            scale: Math.max(1.4826 * median(samples.map((value) => Math.abs(value - center))), vital.floor),
          };
        }
        const value = history.get(day)[index];
        if (!Number.isFinite(value)) {
          recent = [];
          continue;
        }
        if (reference) {
          const deviation = (value - reference.center) / reference.scale;
          const previous = recent.filter((entry) => day - entry.day <= 2);
          const orient = vital.direction === 0 ? Math.abs : (z) => Math.max(0, vital.direction * z);
          const instant = orient(deviation);
          const sustained = previous.length === 2
            ? Math.min(instant, orient((previous[0].deviation + previous[1].deviation + deviation) / 3))
            : 0;
          if (day === latest) {
            details.push({...vital, measured: value, usual: reference.center,
              score: Math.max(instant, 1.25 * sustained)});
          }
          recent = [...recent.slice(-1), {day, deviation}];
        }
        if (calibrating) {
          samples.push(value);
          reference = undefined; // Freeze the reference only after incorporating calibration observations.
        }
      }
    }
    details.sort((a, b) => b.score - a.score);
    const strongest = details[0];
    const threshold = bundle.thresholds.statistical_baseline;
    if (!strongest) return result(null, threshold, "The personal baseline needs at least seven earlier observations of a measured vital.");
    const reason = strongest.label + " " + measurement(strongest.measured, strongest.unit)
      + " vs usual " + measurement(strongest.usual, strongest.unit) + ".";
    return result(strongest.score, threshold, reason, details);
  }

  function modelFeatures(sequence, vitalCount) {
    const prior = sequence.slice(0, -1);
    const today = sequence.at(-1);
    const yesterday = sequence.at(-2);
    const threeDaysAgo = sequence.at(-4);
    const history = Array.from({length: vitalCount}, (_, index) =>
      prior.map((values) => values[index]).filter(Number.isFinite));
    const stdev = history.map((values) => {
      if (values.length === 0) return NaN;
      const average = values.reduce((acc, value) => acc + value, 0) / values.length;
      return Math.sqrt(values.reduce((acc, value) => acc + (value - average) ** 2, 0) / values.length);
    });
    return [
      ...today,
      ...today.map((value, index) => value - yesterday[index]),
      ...today.map((value, index) => value - threeDaysAgo[index]),
      ...today.map((value, index) => value - median(history[index])),
      ...stdev,
      ...history.map((values) => values.length / prior.length),
    ].map(F);
  }

  function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
  }

  function nextNode(node, value) {
    return Number.isNaN(value) ? node[4] : value < F(node[1]) ? node[2] : node[3];
  }

  function xgbScore(features, model) {
    let margin = F(-Math.log(F(F(1 / F(model.base_score)) - 1)));
    for (const tree of model.trees) {
      let node = tree[0];
      while (node[0] !== null) node = tree[nextNode(node, features[node[0]])];
      margin = F(margin + F(node[1]));
    }
    return F(1 / F(1 + F(Math.exp(-margin))));
  }

  const preparedTrees = new WeakMap();

  function treeTerms(tree) {
    if (preparedTrees.has(tree)) return preparedTrees.get(tree);
    const features = [...new Set(tree.map((node) => node[0]).filter((index) => index !== null))];
    const bits = new Map(features.map((feature, index) => [feature, 1 << index]));
    const subsetCount = 1 << features.length;
    const weights = new Float64Array(subsetCount);
    for (let mask = 0; mask < subsetCount - 1; mask++) {
      let size = 0;
      for (let remaining = mask; remaining; remaining &= remaining - 1) size++;
      let choose = 1;
      for (let index = 1; index <= size; index++) choose *= (features.length - index) / index;
      weights[mask] = 1 / (features.length * choose);
    }
    const prepared = {features, bits, subsetCount, weights};
    preparedTrees.set(tree, prepared);
    return prepared;
  }

  function conditionalTreeValue(tree, index, mask, bits, features) {
    const node = tree[index];
    if (node[0] === null) return F(node[1]);
    if (mask & bits.get(node[0])) {
      return conditionalTreeValue(tree, nextNode(node, features[node[0]]), mask, bits, features);
    }
    return node[5] * conditionalTreeValue(tree, node[2], mask, bits, features)
      + node[6] * conditionalTreeValue(tree, node[3], mask, bits, features);
  }

  function treeContributions(features, model) {
    // Exact path-dependent Shapley values. Each trained tree uses only a few distinct features.
    const totals = new Float64Array(features.length);
    for (const tree of model.trees) {
      const terms = treeTerms(tree);
      const expected = Array.from({length: terms.subsetCount}, (_, mask) =>
        conditionalTreeValue(tree, 0, mask, terms.bits, features));
      for (const feature of terms.features) {
        const bit = terms.bits.get(feature);
        for (let mask = 0; mask < terms.subsetCount; mask++) {
          if (!(mask & bit)) totals[feature] += terms.weights[mask] * (expected[mask | bit] - expected[mask]);
        }
      }
    }
    return totals;
  }

  function explainXgboost(features, bundle) {
    const contributions = treeContributions(features, bundle.xgboost);
    const vitals = bundle.vitals;
    return bundle.xgboost.feature_names.map((name, index) => {
      const {label, unit} = vitals[index % vitals.length];
      const statistic = Math.floor(index / vitals.length);
      const value = features[index];
      const observed = Number.isFinite(value);
      return {
        feature: name, label: label + " " + statisticDescriptions[statistic], contribution: contributions[index],
        value: observed ? (statistic === 5 ? measurement(100 * value, "%") : measurement(value, unit)) : "unavailable",
      };
    }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }

  function dense(input, weights, biases) {
    return weights.map((row, index) => {
      let sum = 0;
      for (let j = 0; j < input.length; j++) sum += row[j] * input[j];
      return F(F(sum) + biases[index]);
    });
  }

  function runGru(sequence, weights, layer) {
    const inputWeights = weights[layer + ".weight_ih_l0"];
    const recurrentWeights = weights[layer + ".weight_hh_l0"];
    const inputBias = weights[layer + ".bias_ih_l0"];
    const recurrentBias = weights[layer + ".bias_hh_l0"];
    const width = recurrentWeights[0].length;
    let hidden = new Array(width).fill(0);
    for (const input of sequence) {
      const incoming = dense(input, inputWeights, inputBias);
      const recurrent = dense(hidden, recurrentWeights, recurrentBias);
      hidden = hidden.map((previous, unit) => {
        const update = F(sigmoid(F(incoming[width + unit] + recurrent[width + unit])));
        const reset = F(sigmoid(F(incoming[unit] + recurrent[unit])));
        const candidate = F(Math.tanh(F(incoming[2 * width + unit] + F(reset * recurrent[2 * width + unit]))));
        return F(F(F(previous - candidate) * update) + candidate);
      });
    }
    return hidden;
  }

  function gruResult(sequence, bundle) {
    const {center, scale, weights} = bundle.gru;
    const standardized = sequence.map((row) => [
      ...row.map((value, index) => Number.isFinite(value) ? F(F(F(value) - center[index]) / scale[index]) : 0),
      ...row.map((value) => Number(Number.isFinite(value))),
    ]);
    const encoded = runGru(standardized, weights, "encoder");
    const latent = dense(encoded, weights["bottleneck.weight"], weights["bottleneck.bias"])
      .map((value) => F(Math.tanh(value)));
    const decoded = runGru(sequence.map(() => latent), weights, "decoder");
    const reconstruction = dense(decoded, weights["output.weight"], weights["output.bias"]);
    const observed = sequence.at(-1);
    const details = bundle.vitals.flatMap((vital, index) => {
      if (!Number.isFinite(observed[index])) return [];
      return [{
        ...vital, measured: observed[index], reconstructed: reconstruction[index] * scale[index] + center[index],
        error: F(F(reconstruction[index] - standardized.at(-1)[index]) ** 2),
      }];
    }).sort((a, b) => b.error - a.error);
    const strongest = details[0];
    const reason = strongest.label + " had the largest reconstruction gap (measured "
      + measurement(strongest.measured, strongest.unit) + ", reconstructed "
      + measurement(strongest.reconstructed, strongest.unit) + ").";
    return result(strongest.error, bundle.thresholds.gru_autoencoder, reason, details);
  }

  function scorePatient(readings, bundle, {explain = true, includeBaselines = true} = {}) {
    const history = historyByDay(readings, bundle.vitals);
    const days = [...history.keys()].sort((a, b) => a - b);
    const latest = days.at(-1);
    const current = history.get(latest);
    if (!current || !current.some(Number.isFinite)) {
      return Object.fromEntries(names.map((name) => [
        name, result(null, name === "ensemble" ? 1 : bundle.thresholds[name], "No measured vitals on this date."),
      ]));
    }
    const emptyDay = new Array(bundle.vitals.length).fill(NaN);
    const sequence = Array.from({length: bundle.window_days}, (_, index) =>
      history.get(latest - bundle.window_days + 1 + index) ?? emptyDay);
    const features = modelFeatures(sequence, bundle.vitals.length);
    const score = xgbScore(features, bundle.xgboost);
    const contributions = explain ? explainXgboost(features, bundle) : [];
    const drivers = contributions.filter((item) => Math.abs(item.contribution) > 1e-8).slice(0, 2);
    const reason = drivers.length ? drivers.map(({label, value, contribution}) =>
      label + " " + value + " (" + (contribution > 0 ? "raises" : "lowers") + " the score)").join(" · ")
      : "Tabular score from available readings and recent trends.";
    const output = {
      xgboost: result(score, bundle.thresholds.xgboost, reason, contributions),
      gru_autoencoder: gruResult(sequence, bundle),
    };
    if (includeBaselines) {
      output.clinical_rules = clinical(current, bundle);
      output.statistical_baseline = statistical(history, days, bundle);
    }
    const members = Object.entries(bundle.ensemble.thresholds).flatMap(([name, threshold]) => {
      if (threshold === null) return [];
      const member = result(output[name].score, threshold, output[name].reason);
      return [{name, ...member, normalized: threshold > 0 ? member.score / threshold : Number(member.alert)}];
    });
    const triggers = members.filter((member) => member.alert);
    const ensembleReason = triggers.length
      ? triggers.map(({name, reason: memberReason}) => ensembleNames[name] + " triggered. " + memberReason).join(" ")
      : "Member scores are below the ensemble alert thresholds.";
    output.ensemble = result(members.length ? Math.max(...members.map((member) => member.normalized)) : null,
      1, ensembleReason, members);
    return output;
  }

  globalThis.CareModels = {load, scorePatient};
})();
