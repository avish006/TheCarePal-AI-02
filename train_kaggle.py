"""Train and compare vital-sign detectors using the original synthetic CSVs."""

# %% Imports and shared configuration
import argparse
from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
import pickle

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset
import xgboost as xgb

from detection import CALIBRATION_DAYS, VITALS, build_days


VITAL_COLUMNS = tuple(vital.field for vital in VITALS)
INPUT_FILES = ("patients.csv", "vitals.csv", "events.csv")
FEATURE_NAMES = tuple(
    f"{vital}_{statistic}"
    for statistic in ("today", "change_1d", "change_3d", "delta_from_prior_median",
                      "prior_std", "prior_observation_fraction")
    for vital in VITAL_COLUMNS
)
DEFAULT_WINDOW = 14
DEFAULT_BUDGET = 0.5


def find_data():
    root = Path("/kaggle/input")
    if not root.is_dir():
        directory = Path(__file__).resolve().parent if "__file__" in globals() else Path.cwd()
        return directory / "data"
    matches = sorted({path.parent for path in root.rglob("vitals.csv")
                      if all((path.parent / name).is_file() for name in INPUT_FILES)})
    if len(matches) != 1:
        raise ValueError("Set DATA_DIR to the Kaggle folder containing all three CSVs.")
    return matches[0]


# %% Prepare data and split by patient
def load_data(directory):
    patients = pd.read_csv(directory / "patients.csv", dtype={"patient_id": str})
    readings = pd.read_csv(directory / "vitals.csv", dtype={"patient_id": str})
    events = pd.read_csv(directory / "events.csv", dtype={"patient_id": str, "event_id": str})
    if (patients.empty or patients.patient_id.isna().any() or patients.patient_id.duplicated().any()
            or readings.empty or readings.patient_id.isna().any()
            or not set(readings.patient_id) <= set(patients.patient_id)):
        raise ValueError("Provide unique patient IDs and readings for known patients.")
    readings["date"] = pd.to_datetime(readings.date, format="%Y-%m-%d")
    readings.loc[:, list(VITAL_COLUMNS)] = readings.loc[:, list(VITAL_COLUMNS)].apply(pd.to_numeric)
    if (readings.date.isna().any() or readings.duplicated(["patient_id", "date"]).any()
            or np.isinf(readings.loc[:, list(VITAL_COLUMNS)].to_numpy(dtype=float)).any()):
        raise ValueError("Check for missing dates, duplicate patient-days, or infinite readings.")

    grids = []
    for patient_id, group in readings.groupby("patient_id", sort=True):
        indexed = group.set_index("date")
        daily = pd.date_range(indexed.index.min(), indexed.index.max(), name="date")
        grids.append(indexed.loc[:, list(VITAL_COLUMNS)].reindex(daily).assign(
            patient_id=patient_id, patient_day=np.arange(1, len(daily) + 1)).reset_index())
    panel = pd.concat(grids, ignore_index=True)
    if events.empty or events.event_id.isna().any() or events.event_id.duplicated().any():
        raise ValueError("Provide a nonempty episode log with unique event IDs.")
    for column in ("onset_date", "peak_date", "end_date"):
        events[column] = pd.to_datetime(events[column], format="%Y-%m-%d")
    if (events[["onset_date", "peak_date", "end_date", "event_type", "pattern"]].isna().any().any()
            or (events.onset_date > events.peak_date).any() or (events.peak_date > events.end_date).any()
            or not set(events.patient_id) <= set(panel.patient_id)):
        raise ValueError("Check episode dates and patient IDs.")
    panel["event_active"] = False
    for episode in events.itertuples():
        during = panel.patient_id.eq(episode.patient_id) & panel.date.between(
            episode.onset_date, episode.end_date)
        if during.sum() != (episode.end_date - episode.onset_date).days + 1:
            raise ValueError(f"Episode {episode.event_id} falls outside the patient's timeline.")
        if (panel.loc[during, "patient_day"] <= CALIBRATION_DAYS).any():
            raise ValueError("The original cohort has no injected episodes in the calibration period.")
        panel.loc[during, "event_active"] = True
    return panel, events


def split_patients(panel, events, seed):
    """Split 60/20/20, using episode types only to balance representation."""
    patients = np.sort(panel.patient_id.unique())
    rng = np.random.default_rng(seed)
    count = len(patients)
    held_out = max(1, round(count * 0.2))
    kinds = pd.crosstab(events.patient_id, events.event_type).reindex(patients, fill_value=0)
    counts = kinds.to_numpy()
    if count < 5 or (counts > 0).sum(axis=0).min() < 3:
        raise ValueError("Each event type needs at least three affected patients for a three-way split.")
    for _ in range(3000):
        train, validation, test = np.split(rng.permutation(count), [count - 2 * held_out, count - held_out])
        splits = {"train": train, "validation": validation, "test": test}
        if all((counts[indices].sum(axis=0) > 0).all() for indices in splits.values()):
            return {name: patients[indices].tolist() for name, indices in splits.items()}
    raise ValueError("Could not cover every event type in each split. Check cohort size and event counts.")


def build_features(panel, window):
    """A row uses its own readings and observations dated on or before that day."""
    if window < 4:
        raise ValueError("Use a window of at least four days.")
    sequences = np.full((len(panel), window, len(VITAL_COLUMNS)), np.nan, dtype=np.float32)
    features = np.empty((len(panel), len(FEATURE_NAMES)), dtype=np.float32)
    ordinary = np.zeros(len(panel), dtype=bool)
    for _, rows in panel.groupby("patient_id", sort=False):
        readings = rows.loc[:, list(VITAL_COLUMNS)]
        prior = readings.shift(1).rolling(window - 1, min_periods=1)
        features[rows.index] = np.concatenate((
            readings, readings - readings.shift(1), readings - readings.shift(3),
            readings - prior.median(), prior.std(ddof=0), prior.count().fillna(0) / (window - 1),
        ), axis=1)
        values = readings.to_numpy(dtype=np.float32)
        labels = rows.event_active.to_numpy()
        for end, row in enumerate(rows.index):
            start = max(0, end + 1 - window)
            sequences[row, -(end + 1 - start):] = values[start:end + 1]
            ordinary[row] = not labels[start:end + 1].any()
    return features, sequences, ordinary


def make_sequence_input(sequences, center, scale):
    observed = np.isfinite(sequences)
    # Zero represents the training mean, and the mask tells the GRU it was missing.
    scaled = np.where(observed, (sequences - center) / scale, 0).astype(np.float32)
    return np.concatenate((scaled, observed.astype(np.float32)), axis=-1)


# %% Fit XGBoost and the GRU autoencoder
class GRUAutoencoder(nn.Module):
    def __init__(self, vital_count, hidden_size=24, latent_size=8):
        super().__init__()
        self.encoder = nn.GRU(2 * vital_count, hidden_size, batch_first=True)
        self.bottleneck = nn.Linear(hidden_size, latent_size)
        self.decoder = nn.GRU(latent_size, hidden_size, batch_first=True)
        self.output = nn.Linear(hidden_size, vital_count)

    def forward(self, sequence):
        _, hidden = self.encoder(sequence)
        latent = self.bottleneck(hidden[-1]).tanh()
        decoded, _ = self.decoder(latent.unsqueeze(1).expand(-1, sequence.shape[1], -1))
        return self.output(decoded)


def masked_loss(model, inputs):
    values, observed = inputs.chunk(2, dim=-1)
    return ((model(inputs) - values).square() * observed).sum() / observed.sum().clamp_min(1)


def train_gru(inputs, train_normal, validation_normal, architecture, epochs, seed, device):
    torch.manual_seed(seed)
    model = GRUAutoencoder(**architecture).to(device)
    dataset = TensorDataset(torch.from_numpy(inputs[train_normal]))
    loader = DataLoader(dataset, batch_size=64, shuffle=True,
                        generator=torch.Generator().manual_seed(seed))
    validation = torch.from_numpy(inputs[validation_normal]).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    best_loss, best_weights, stale_epochs = float("inf"), None, 0
    for epoch in range(1, epochs + 1):
        model.train()
        for (batch,) in loader:
            optimizer.zero_grad(set_to_none=True)
            loss = masked_loss(model, batch.to(device))
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
        model.eval()
        with torch.inference_mode():
            validation_loss = masked_loss(model, validation).item()
        print(f"GRU epoch {epoch:02d} | validation reconstruction loss {validation_loss:.4f}")
        if validation_loss < best_loss - 1e-5:
            best_loss, best_weights, stale_epochs = validation_loss, deepcopy(model.state_dict()), 0
        else:
            stale_epochs += 1
            if stale_epochs >= 6:
                break
    if best_weights is None:
        raise RuntimeError("GRU did not produce a finite validation loss.")
    model.load_state_dict(best_weights)
    return model.eval()


def gru_errors(model, inputs, device):
    """Standardized squared errors for the scoring day's measured vitals."""
    parts = []
    with torch.inference_mode():
        for batch in torch.from_numpy(inputs).split(256):
            batch = batch.to(device)
            value, observed = batch[:, -1].chunk(2, dim=-1)
            errors = (model(batch)[:, -1] - value).square()
            parts.append(errors.masked_fill(observed == 0, torch.nan).cpu().numpy())
    return np.concatenate(parts)


def row_max(errors):
    maximum = np.where(np.isfinite(errors), errors, -np.inf).max(axis=1)
    return np.where(np.isfinite(maximum), maximum, np.nan)


def train_xgboost(features, target, training, seed):
    labels = target[training].astype(int)
    positives = labels.sum()
    if positives == 0 or positives == len(labels):
        raise ValueError("XGBoost training requires both ordinary and event days.")
    model = xgb.XGBClassifier(
        objective="binary:logistic", eval_metric="logloss", tree_method="hist",
        n_estimators=180, max_depth=3, learning_rate=0.05, subsample=0.85,
        colsample_bytree=0.85, scale_pos_weight=(len(labels) - positives) / positives,
        random_state=seed, n_jobs=2,
    )
    model.fit(pd.DataFrame(features[training], columns=FEATURE_NAMES), labels)
    return model.get_booster()


def xgboost_scores(model, features):
    return model.predict(xgb.DMatrix(features, feature_names=list(FEATURE_NAMES)))


# %% Evaluate and select alert thresholds
def baseline_scores(directory, panel):
    original = build_days(directory)
    scores = np.full((len(panel), 2), np.nan)
    for row in panel.itertuples():
        day = original.get(row.date.date().isoformat(), {}).get(row.patient_id)
        if day and day["rules"]:
            scores[row.Index] = max(day["rules"].values()), max(day["signals"].values(), default=0)
    return scores.T


@dataclass
class Evaluation:
    target: np.ndarray
    active_days: np.ndarray
    before_peak: np.ndarray
    event_types: np.ndarray
    gradual: np.ndarray

    @classmethod
    def from_split(cls, panel, events):
        episodes = events[events.patient_id.isin(panel.patient_id)]
        patient = panel.patient_id.to_numpy()[None, :]
        dates = panel.date.to_numpy()[None, :]
        gradual = episodes.pattern.eq("gradual").to_numpy()
        active = ((patient == episodes.patient_id.to_numpy()[:, None])
                  & (dates >= episodes.onset_date.to_numpy()[:, None])
                  & (dates <= episodes.end_date.to_numpy()[:, None]))
        early = active & gradual[:, None] & (dates < episodes.peak_date.to_numpy()[:, None])
        return cls(panel.event_active.to_numpy(), active, early, episodes.event_type.to_numpy(), gradual)

    def counts(self, alerts):
        detected = (self.active_days & alerts).any(axis=1)
        early = (self.before_peak & alerts).any(axis=1)
        tp = np.count_nonzero(alerts & self.target)
        fp = np.count_nonzero(alerts & ~self.target)
        return detected, early, int(tp), int(fp)

    def summary(self, alerts):
        detected, early, tp, fp = self.counts(alerts)
        positives = int(self.target.sum())
        return {
            "patient_days": len(self.target), "event_days": positives,
            "true_positive_days": tp, "false_positive_days": fp, "missed_event_days": positives - tp,
            "precision": tp / (tp + fp) if tp + fp else 0.0,
            "day_recall": tp / positives,
            "episodes_detected": int(detected.sum()), "episodes": len(detected),
            "episode_recall": float(detected.mean()),
            "early_gradual_episodes": int(early.sum()), "gradual_episodes": int(self.gradual.sum()),
            "false_alerts_per_patient_week": 7 * fp / len(self.target),
        }


def alert_mask(scores, threshold):
    if threshold is None:
        return np.zeros(len(scores), dtype=bool)
    return np.isfinite(scores) & (scores >= threshold)


def candidate_alerts(scores):
    unique = np.unique(scores[np.isfinite(scores)])
    positions = np.unique(np.linspace(0, len(unique) - 1, min(len(unique), 81), dtype=int))
    return [(float(unique[i]), alert_mask(scores, unique[i])) for i in positions] + [
        (None, alert_mask(scores, None))]


def tune_thresholds(validation, score_arrays, budget):
    """Tune one detector or an OR pair under the same validation alert budget."""
    from itertools import product

    allowed_false_positives = int(budget * len(validation.target) / 7)
    best_key, best_thresholds = None, None
    for candidates in product(*(candidate_alerts(scores) for scores in score_arrays)):
        alerts = np.logical_or.reduce([mask for _, mask in candidates])
        fp = np.count_nonzero(alerts & ~validation.target)
        if fp > allowed_false_positives:
            continue
        detected, early, tp, fp = validation.counts(alerts)
        key = (int(detected.sum()), int(early.sum()), tp, -fp,
               sum(threshold is not None for threshold, _ in candidates))
        if best_key is None or key > best_key:
            best_key = key
            best_thresholds = [threshold for threshold, _ in candidates]
    return best_thresholds


def evaluate_models(panel, events, split_masks, scores, budget):
    validation_rows = split_masks["validation"]
    validation = Evaluation.from_split(panel.loc[validation_rows], events)
    thresholds = {
        name: tune_thresholds(validation, [scores[name][validation_rows]], budget)[0]
        for name in ("statistical_baseline", "xgboost", "gru_autoencoder")
    }
    thresholds["clinical_rules"] = 1.0
    members = ("xgboost", "gru_autoencoder")
    ensemble = dict(zip(members, tune_thresholds(
        validation, [scores[name][validation_rows] for name in members], budget)))
    summaries, episode_summaries, predictions = [], [], []
    for split in ("validation", "test"):
        selected = split_masks[split]
        records = panel.loc[selected, ["patient_id", "date", "event_active"]].copy()
        evaluation = Evaluation.from_split(panel.loc[selected], events)
        alerts = {name: alert_mask(scores[name][selected], cutoff) for name, cutoff in thresholds.items()}
        for name, mask in alerts.items():
            records[f"{name}_score"] = scores[name][selected]
            records[f"{name}_alert"] = mask
        for name, cutoff in ensemble.items():
            records[f"ensemble_{name}_alert"] = alert_mask(scores[name][selected], cutoff)
        alerts["ensemble"] = records.ensemble_xgboost_alert.to_numpy() | records.ensemble_gru_autoencoder_alert.to_numpy()
        records["ensemble_alert"] = alerts["ensemble"]
        predictions.append(records.assign(split=split))
        for name, mask in alerts.items():
            summaries.append({"split": split, "model": name, **evaluation.summary(mask)})
            detected, early, _, _ = evaluation.counts(mask)
            for kind in np.unique(evaluation.event_types):
                group = evaluation.event_types == kind
                episode_summaries.append({
                    "split": split, "model": name, "event_type": kind,
                    "episodes": int(group.sum()), "detected": int(detected[group].sum()),
                    "gradual_episodes": int(evaluation.gradual[group].sum()),
                    "detected_before_peak": int(early[group].sum()),
                })
    return thresholds, ensemble, pd.DataFrame(summaries), pd.DataFrame(episode_summaries), pd.concat(predictions)


# %% Export the trained models and preprocessing configuration
def save_pickle(path, data):
    with path.open("wb") as file:
        pickle.dump(data, file, protocol=pickle.HIGHEST_PROTOCOL)


def load_xgboost(path):
    with Path(path).open("rb") as file:
        artifact = pickle.load(file)
    model = xgb.Booster()
    model.load_model(bytearray(artifact["booster_ubj"]))
    return model, artifact["config"]


def load_gru(path, device="cpu"):
    with Path(path).open("rb") as file:
        artifact = pickle.load(file)
    model = GRUAutoencoder(**artifact["architecture"]).to(device)
    model.load_state_dict({name: torch.from_numpy(value) for name, value in artifact["weights"].items()})
    return model.eval(), artifact["config"]


def run_training(data_dir, output_dir, *, seed=42, window=DEFAULT_WINDOW,
                 epochs=40, budget=DEFAULT_BUDGET, device=None):
    if epochs < 1 or not np.isfinite(budget) or budget < 0:
        raise ValueError("Epochs must be positive and the false-alert budget must be nonnegative.")
    data_dir, output_dir = Path(data_dir), Path(output_dir)
    device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
    torch.set_num_threads(2)
    panel, events = load_data(data_dir)
    splits = split_patients(panel, events, seed)
    for name, patients in splits.items():
        counts = events.loc[events.patient_id.isin(patients)].groupby("event_type").size()
        print(f"{name}: {len(patients)} patients | {counts.to_dict()}")
    features, sequences, ordinary = build_features(panel, window)
    target = panel.event_active.to_numpy()
    values = sequences[:, -1]
    available = np.isfinite(values).any(axis=1)
    member = {name: panel.patient_id.isin(patients).to_numpy() for name, patients in splits.items()}
    scored_day = panel.patient_day.to_numpy() > CALIBRATION_DAYS
    split_masks = {name: mask & scored_day for name, mask in member.items()}
    normal_values = values[member["train"] & ~target]
    center, scale = np.nanmean(normal_values, axis=0), np.nanstd(normal_values, axis=0)
    if not (np.isfinite(center).all() and np.isfinite(scale).all()):
        raise ValueError("Each vital needs observations in the normal training data.")
    scale = np.where(scale > 1e-6, scale, 1).astype(np.float32)
    inputs = make_sequence_input(sequences, center, scale)
    normal = ordinary & available
    if not (normal & member["train"]).any() or not (normal & member["validation"]).any():
        raise ValueError("Normal windows are required in training and validation.")
    architecture = {"vital_count": len(VITAL_COLUMNS), "hidden_size": 24, "latent_size": 8}
    booster = train_xgboost(features, target, split_masks["train"] & available, seed)
    gru = train_gru(inputs, normal & member["train"], normal & member["validation"],
                    architecture, epochs, seed, device)
    clinical, statistical = baseline_scores(data_dir, panel)
    score_arrays = {
        "clinical_rules": clinical, "statistical_baseline": statistical,
        "xgboost": np.where(available, xgboost_scores(booster, features), np.nan),
        "gru_autoencoder": row_max(gru_errors(gru, inputs, device)),
    }
    thresholds, ensemble, metrics, by_type, predictions = evaluate_models(
        panel, events, split_masks, score_arrays, budget)
    config = {
        "format_version": 1, "window_days": window, "calibration_days": CALIBRATION_DAYS,
        "vitals": list(VITAL_COLUMNS), "xgboost_feature_names": list(FEATURE_NAMES),
        "gru_center": center.tolist(), "gru_scale": scale.tolist(),
        "gru_score": "max_standardized_squared_reconstruction_error_on_latest_observed_vitals",
        "thresholds": thresholds, "ensemble": {"decision": "OR", "thresholds": ensemble},
        "validation_false_alert_budget_per_patient_week": budget, "seed": seed, "patients": splits,
        "versions": {"numpy": np.__version__, "pandas": pd.__version__, "torch": str(torch.__version__),
                     "xgboost": xgb.__version__},
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    xgb_path = output_dir / "xgboost_model.pkl"
    gru_path = output_dir / "gru_autoencoder.pkl"
    save_pickle(xgb_path, {"booster_ubj": bytes(booster.save_raw(raw_format="ubj")), "config": config})
    save_pickle(gru_path, {"architecture": architecture, "config": config,
                          "weights": {name: tensor.detach().cpu().numpy()
                                      for name, tensor in gru.state_dict().items()}})
    # Confirm reloaded artifacts reproduce predictions independently of the training device.
    reloaded_xgb, _ = load_xgboost(xgb_path)
    reloaded_gru, _ = load_gru(gru_path)
    verification = np.flatnonzero(split_masks["test"])[:32]
    np.testing.assert_allclose(xgboost_scores(reloaded_xgb, features[verification]),
                               xgboost_scores(booster, features[verification]), rtol=1e-6)
    np.testing.assert_allclose(gru_errors(reloaded_gru, inputs[verification], "cpu"),
                               gru_errors(gru, inputs[verification], device),
                               rtol=5e-4, atol=1e-5, equal_nan=True)
    (output_dir / "training_config.json").write_text(
        json.dumps(config, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    metrics.to_csv(output_dir / "model_comparison.csv", index=False)
    by_type.to_csv(output_dir / "episodes_by_type.csv", index=False)
    predictions.to_csv(output_dir / "patient_day_predictions.csv", index=False)
    print(metrics[metrics.split == "test"].round(3).to_string(index=False))
    print(f"Saved both verified model files and comparison tables to {output_dir.resolve()}")
    return metrics


# %% Command-line entry point
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--false-alert-budget", type=float, default=DEFAULT_BUDGET)
    parser.add_argument("--device", choices=["cpu", "cuda"])
    args = parser.parse_args()
    run_training(args.data_dir or find_data(), args.output_dir, seed=args.seed, window=args.window,
                 epochs=args.epochs, budget=args.false_alert_budget, device=args.device)
