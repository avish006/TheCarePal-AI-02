"""Select the anomaly cutoff on validation days and evaluate on untouched later days."""
import argparse
import json
from collections import Counter
from pathlib import Path
from statistics import median

from detection import ROOT, VITALS, build_days, read_rows


def detection_fields(day, method, cutoff):
    if method == "clinical_rules":
        return {v.field for v in VITALS if day["rules"].get(v.field, 0)}
    fields = {v.field for v in VITALS if day["signals"].get(v.field, 0) >= cutoff}
    if method == "dashboard_review":
        fields.update(field for field, level in day["rules"].items() if level == 2)
    return fields


def calculate(days, dates, events, method, cutoff):
    selected = set(dates)
    episodes = [e for e in events if e["onset_date"] in selected]
    truth = {}
    for e in episodes:
        for stamp in dates:
            if e["onset_date"] <= stamp <= e["end_date"]:
                truth[stamp, e["patient_id"]] = e
    counts = Counter()
    detections = {}
    for stamp in dates:
        for pid, day in days[stamp].items():
            event = truth.get((stamp, pid))
            fields = detection_fields(day, method, cutoff)
            if fields:
                counts["tp" if event else "fp"] += 1
            else:
                counts["fn" if event else "tn"] += 1
            kinds = {v.kind for v in VITALS if v.field in fields}
            if event and event["event_type"] in kinds:
                detections.setdefault(event["event_id"], stamp)
    tp, fp, fn = (counts[k] for k in ("tp", "fp", "fn"))
    before_peak = [dates.index(e["peak_date"]) - dates.index(detections[e["event_id"]])
                   for e in episodes if e["pattern"] == "gradual" and e["event_id"] in detections]
    by_kind = {}
    for kind in sorted({e["event_type"] for e in episodes}):
        group = [e for e in episodes if e["event_type"] == kind]
        by_kind[kind] = {"detected": sum(e["event_id"] in detections for e in group), "total": len(group)}
    return dict(tp=tp, fp=fp, fn=fn, tn=counts["tn"], precision=tp / max(1, tp + fp),
                recall=tp / max(1, tp + fn), f1=2 * tp / max(1, 2 * tp + fp + fn),
                detected_episodes=len(detections), episodes=len(episodes), by_type=by_kind,
                gradual_detected_before_peak=sum(n > 0 for n in before_peak),
                gradual_episodes=sum(e["pattern"] == "gradual" for e in episodes),
                median_days_before_peak_for_detected_gradual=median(before_peak) if before_peak else None)


def evaluate(data_dir):
    days = build_days(data_dir)
    dates = sorted(days)
    if len(dates) != 90:
        raise ValueError("The assignment evaluation expects 90 daily dates.")
    events = read_rows(data_dir / "events.csv")
    validation, test = dates[28:49], dates[49:]
    candidates = [n / 4 for n in range(8, 21)]
    # Resolve equal F1 in favor of the larger cutoff (fewer alerts).
    cutoff = max(candidates, key=lambda c: (calculate(days, validation, events, "personal", c)["f1"], c))
    return dict(cutoff=cutoff, calibration=[dates[0], dates[27]], validation=[validation[0], validation[-1]],
                test=[test[0], test[-1]], test_patient_days=sum(len(days[d]) for d in test),
                results={m: calculate(days, test, events, m, cutoff)
                         for m in ("clinical_rules", "personal", "dashboard_review")})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--output", type=Path, default=ROOT / "evaluation.json")
    args = parser.parse_args()
    report = evaluate(args.data_dir)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
