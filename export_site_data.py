"""Prepare public synthetic cohort and evaluation assets for the static dashboard."""

import argparse
import json
from pathlib import Path

from detection import ROOT, VITALS, read_rows


def write_json(path, document):
    path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                    + "\n", encoding="utf-8")


def export_data(data_dir, artifacts_dir, output_dir):
    config = json.loads((artifacts_dir / "training_config.json").read_text(encoding="utf-8"))
    assignments = {patient: split for split, patients in config["patients"].items()
                   for patient in patients}
    patients = {
        row["patient_id"]: {
            "patient_id": row["patient_id"], "age": int(row["age"]),
            "split": assignments[row["patient_id"]], "readings": [],
        }
        for row in read_rows(data_dir / "patients.csv")
    }
    dates = set()
    for row in sorted(read_rows(data_dir / "vitals.csv"), key=lambda item: item["date"]):
        dates.add(row["date"])
        patients[row["patient_id"]]["readings"].append({
            "date": row["date"],
            **{vital.field: float(row[vital.field]) if row[vital.field] else None for vital in VITALS},
        })
    metrics = [
        {key: value if key in {"split", "model"} else float(value) for key, value in row.items()}
        for row in read_rows(artifacts_dir / "model_comparison.csv")
    ]
    by_type = [
        {key: value if key in {"split", "model", "event_type"} else int(value)
         for key, value in row.items()}
        for row in read_rows(artifacts_dir / "episodes_by_type.csv")
    ]
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "cohort.json", {"dates": sorted(dates), "patients": list(patients.values())})
    write_json(output_dir / "evaluation.json", {
        "metrics": metrics, "by_type": by_type,
        "split_counts": {key: len(value) for key, value in config["patients"].items()},
        "window_days": config["window_days"],
        "calibration_days": config["calibration_days"],
        "false_alert_budget": config["validation_false_alert_budget_per_patient_week"],
    })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--artifacts-dir", type=Path, default=ROOT / "models")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist" / "data")
    args = parser.parse_args()
    export_data(args.data_dir, args.artifacts_dir, args.output_dir)
