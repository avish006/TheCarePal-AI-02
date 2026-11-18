"""Causal scoring of synthetic daily observations. No event labels are read here."""
import csv
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent
CALIBRATION_DAYS = 28


@dataclass(frozen=True)
class Vital:
    field: str
    label: str
    unit: str
    kind: str
    direction: int  # +1 for high, -1 for low, 0 for either direction
    floor: float    # minimum robust scale in the original measurement units


VITALS = (
    Vital("systolic_mmhg", "Systolic BP", "mmHg", "hypertension", 1, 4),
    Vital("diastolic_mmhg", "Diastolic BP", "mmHg", "hypertension", 1, 3),
    Vital("pulse_bpm", "Pulse", "bpm", "pulse", 0, 3),
    Vital("spo2_pct", "SpO₂", "%", "oxygen_drop", -1, 0.8),
    Vital("fasting_glucose_mg_dl", "Fasting glucose", "mg/dL", "low_sugar", -1, 4),
    Vital("oral_temperature_c", "Oral temperature", "°C", "fever", 1, 0.15),
)


def read_rows(path):
    with path.open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def rule_level(field, value):
    """0 ordinary, 1 reference boundary crossed, 2 stronger absolute warning."""
    if field == "systolic_mmhg":
        return 2 if value > 180 else int(value >= 140)
    if field == "diastolic_mmhg":
        return 2 if value > 120 else int(value >= 90)
    if field == "spo2_pct":
        return 2 if value <= 88 else int(value <= 92)
    if field == "fasting_glucose_mg_dl":
        return 2 if value < 55 else int(value < 70)
    if field == "oral_temperature_c":
        return int(value >= 38)
    if field == "pulse_bpm":
        return int(value < 60 or value > 100)
    raise ValueError(f"Unknown vital {field}")


def fit_reference(observations, floor):
    if len(observations) < 7:
        return None
    center = median(observations)
    mad = median(abs(value - center) for value in observations)
    return center, max(1.4826 * mad, floor)


def build_days(data_dir):
    ages = {p["patient_id"]: int(p["age"]) for p in read_rows(data_dir / "patients.csv")}
    readings = sorted(read_rows(data_dir / "vitals.csv"), key=lambda r: (r["date"], r["patient_id"]))
    if not readings:
        raise ValueError("vitals.csv contains no daily observations")
    first = date.fromisoformat(readings[0]["date"])
    samples = defaultdict(list)
    references = {}
    recent = defaultdict(lambda: deque(maxlen=2))
    by_date = defaultdict(dict)
    for row in readings:
        pid, stamp = row["patient_id"], row["date"]
        today = date.fromisoformat(stamp)
        calibrating = (today - first).days < CALIBRATION_DAYS
        if pid in by_date[stamp]:
            raise ValueError(f"Duplicate observation for {pid} on {stamp}")
        values, rules, signals, centers = {}, {}, {}, {}
        for v in VITALS:
            raw = row[v.field]
            value = float(raw) if raw else None
            values[v.field] = value
            key = (pid, v.field)
            if calibrating:
                ref = fit_reference(samples[key], v.floor)
            else:
                if key not in references:
                    references[key] = fit_reference(samples[key], v.floor)
                ref = references[key]
            if ref:
                centers[v.field] = ref[0]
            if value is None:
                recent[key].clear()
                continue
            rules[v.field] = rule_level(v.field, value)
            if ref:
                deviation = (value - ref[0]) / ref[1]
                previous = [z for d, z in recent[key] if today - d <= timedelta(days=2)]
                # Preserve sign until after smoothing so opposite pulse shifts cancel.
                average = (sum(previous) + deviation) / 3 if len(previous) == 2 else deviation
                orient = abs if v.direction == 0 else lambda z: max(0, v.direction * z)
                instant = orient(deviation)
                sustained = min(instant, orient(average)) if len(previous) == 2 else 0
                signals[v.field] = max(instant, 1.25 * sustained)
                recent[key].append((today, deviation))
            if calibrating:
                samples[key].append(value)
        by_date[stamp][pid] = dict(patient_id=pid, age=ages[pid], date=stamp, values=values,
                                   rules=rules, signals=signals, centers=centers)
    return dict(by_date)


def risk(day, cutoff):
    reasons = []
    missing = []
    for v in VITALS:
        value = day["values"][v.field]
        if value is None:
            missing.append(v.label)
            continue
        signal = day["signals"].get(v.field, 0)
        score = min(90 if signal >= cutoff else 64, round(65 * signal / cutoff))
        rule = day["rules"][v.field]
        if rule:
            score = max(score, 95 if rule == 2 else 45)
        description = f"{v.label} {value:g} {v.unit}"
        if rule:
            description += " crosses a fixed alert threshold"
        if signal >= cutoff / 2 and v.field in day["centers"]:
            center = day["centers"][v.field]
            description += f" (usual {center:g} {v.unit})"
        reasons.append((score, description))
    reasons.sort(reverse=True)
    score = reasons[0][0] if reasons else None
    if score is None:
        level, reason = "Incomplete", "All readings are missing for this day."
    elif score >= 45:
        level = "Review" if score >= 65 else "Watch"
        reason = ". ".join(text for points, text in reasons[:2] if points >= 45) + "."
    elif missing:
        level, reason = "Incomplete", "Available readings are below the alert cutoffs."
    else:
        level, reason = "Routine", "Recorded vitals are below the alert cutoffs."
    if missing and reasons:
        reason += " Missing " + ", ".join(missing) + "."
    return {k: day[k] for k in ("patient_id", "age", "values")} | dict(
        score=score, level=level, reason=reason, missing=missing)
