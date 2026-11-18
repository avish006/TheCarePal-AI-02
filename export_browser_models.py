"""Export the trained Kaggle artifacts as data for the dependency-free browser scorer."""

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from detection import VITALS
from train_kaggle import FEATURE_NAMES, VITAL_COLUMNS, load_gru, load_xgboost


def export_tree(root, feature_indices):
    """Store leaves as [null, value] and split nodes as compact indexed records."""
    rows = []

    def visit(node):
        index = len(rows)
        rows.append(None)
        if "leaf" in node:
            rows[index] = [None, node["leaf"]]
        else:
            children = {child["nodeid"]: child for child in node["children"]}
            yes, no = children[node["yes"]], children[node["no"]]
            yes_index, no_index = visit(yes), visit(no)
            cover = yes["cover"] + no["cover"]
            rows[index] = [
                feature_indices[node["split"]], node["split_condition"], yes_index, no_index,
                yes_index if node["missing"] == node["yes"] else no_index,
                yes["cover"] / cover, no["cover"] / cover,
            ]
        return index

    visit(root)
    return rows


def export_models(artifacts, output):
    booster, config = load_xgboost(artifacts / "xgboost_model.pkl")
    gru, gru_config = load_gru(artifacts / "gru_autoencoder.pkl")
    if config != gru_config:
        raise ValueError("Both artifacts must come from the same training run.")
    if config["format_version"] != 1 or config["ensemble"]["decision"] != "OR":
        raise ValueError("This browser scorer supports the version 1 trained OR ensemble.")
    if config["vitals"] != list(VITAL_COLUMNS) or config["xgboost_feature_names"] != list(FEATURE_NAMES):
        raise ValueError("The artifacts use a different set of vital signs or features.")
    learner = json.loads(booster.save_config())["learner"]
    if learner["objective"]["name"] != "binary:logistic" or learner["gradient_booster"]["name"] != "gbtree":
        raise ValueError("The browser scorer expects a binary logistic gbtree model.")
    base_score = float(learner["learner_model_param"]["base_score"].strip("[]"))
    feature_indices = {name: index for index, name in enumerate(FEATURE_NAMES)}
    bundle = {
        "format_version": 1,
        "window_days": config["window_days"],
        "calibration_days": config["calibration_days"],
        "vitals": [asdict(vital) for vital in VITALS],
        "thresholds": config["thresholds"],
        "ensemble": config["ensemble"],
        "xgboost": {
            "base_score": base_score,
            "feature_names": list(FEATURE_NAMES),
            "trees": [export_tree(json.loads(tree), feature_indices)
                      for tree in booster.get_dump(dump_format="json", with_stats=True)],
        },
        "gru": {
            "center": config["gru_center"],
            "scale": config["gru_scale"],
            "weights": {name: tensor.detach().cpu().tolist()
                        for name, tensor in gru.state_dict().items()},
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(bundle, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n",
                      encoding="utf-8")
    print(f"Exported {len(bundle['xgboost']['trees'])} XGBoost trees and GRU weights to {output}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    parser.add_argument("--output", type=Path, default=Path("dist/data/models.json"))
    args = parser.parse_args()
    export_models(args.artifacts, args.output)
