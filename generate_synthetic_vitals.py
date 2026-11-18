"""Generate fictional daily home-care vitals and an independent episode log."""

import argparse
import csv
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from random import Random


PATIENT_COUNT = 50
DAY_COUNT = 90
# Zero-based boundaries. Each event window fits entirely in its assigned period.
EVALUATION_PERIODS = ((28, 49, 6), (49, DAY_COUNT, 14))
VITAL_FIELDS = (
    "systolic_mmhg",
    "diastolic_mmhg",
    "pulse_bpm",
    "spo2_pct",
    "fasting_glucose_mg_dl",
    "oral_temperature_c",
)
READING_GROUPS = (VITAL_FIELDS[:2], *((field,) for field in VITAL_FIELDS[2:]))

# Fractions of the event's peak effect. The first entry marks latent onset.
EVENT_SHAPES = {
    "hypertension": (
        ("gradual", (0.18, 0.34, 0.59, 0.81, 1.0, 0.72, 0.35)),
        ("gradual", (0.25, 0.49, 0.76, 1.0, 0.59)),
        ("abrupt", (1.0, 0.74, 0.35)),
    ),
    "low_sugar": (
        ("abrupt", (1.0,)),
        ("abrupt", (1.0, 0.30)),
        ("gradual", (0.35, 0.60, 1.0, 0.25)),
    ),
    "fever": (
        ("gradual", (0.26, 0.62, 1.0, 0.87, 0.56, 0.20)),
        ("gradual", (0.42, 1.0, 0.74, 0.31)),
        ("abrupt", (1.0, 0.68, 0.24)),
    ),
    "oxygen_drop": (
        ("abrupt", (1.0, 0.67)),
        ("gradual", (0.29, 0.65, 1.0, 0.70, 0.25)),
        ("abrupt", (1.0, 0.84, 0.63, 0.39)),
    ),
}


@dataclass(frozen=True)
class Patient:
    patient_id: str
    age: int
    higher_bp: bool
    glucose_risk: bool
    lower_oxygen: bool

    def event_weight(self, kind):
        if kind == "hypertension" and self.higher_bp:
            return 2.5
        if kind == "low_sugar" and self.glucose_risk:
            return 6
        if kind == "oxygen_drop" and self.lower_oxygen:
            return 3
        return 1


@dataclass(frozen=True)
class Event:
    patient: Patient
    kind: str
    onset: int
    pattern: str
    shape: tuple
    subtle: bool

    @property
    def peak(self):
        return self.onset + self.shape.index(1.0)

    @property
    def end(self):
        return self.onset + len(self.shape) - 1


def make_patients(rng):
    return [
        Patient(
            f"P{number:03d}",
            round(rng.triangular(60, 94, 70)),
            higher_bp=rng.random() < 0.45,
            glucose_risk=rng.random() < 0.35,
            lower_oxygen=rng.random() < 0.18,
        )
        for number in range(1, PATIENT_COUNT + 1)
    ]


def background_vitals(patient, rng):
    """Personal baseline plus persistent daily variation and measurement noise."""
    age_offset = patient.age - 72
    systolic = rng.uniform(132, 155) if patient.higher_bp else rng.uniform(108, 132)
    systolic += 0.15 * age_offset
    diastolic = 67 + 0.38 * (systolic - 110) - 0.10 * age_offset + rng.uniform(-5, 5)
    oxygen = rng.uniform(93.5, 96) if patient.lower_oxygen else rng.uniform(96, 99)
    glucose = rng.uniform(102, 149) if patient.glucose_risk else rng.uniform(83, 106)
    centers = (systolic, diastolic, rng.uniform(59, 86), oxygen, glucose,
               rng.uniform(36.05, 36.83) - 0.008 * age_offset)

    # The first tuple governs day-to-day drift, the second measurement noise.
    drift_sd = (3.3, 1.5, 2.8, 0.36, 8.0 if patient.glucose_risk else 3.5, 0.10)
    noise_sd = (2.0, 1.4, 1.6, 0.40, 3.0, 0.08)
    drift = [0.0] * len(VITAL_FIELDS)
    days = []
    for _ in range(DAY_COUNT):
        drift = [0.68 * previous + rng.gauss(0, sd) for previous, sd in zip(drift, drift_sd)]
        values = [
            center + change + rng.gauss(0, noise)
            for center, change, noise in zip(centers, drift, noise_sd)
        ]
        values[1] += 0.35 * drift[0]
        values[2] += 0.15 * drift[0]
        days.append(dict(zip(VITAL_FIELDS, values)))
    return days


def schedule_events(patients, rng):
    occupied = {patient: set() for patient in patients}
    events = []
    for first_day, stop_day, per_kind in EVALUATION_PERIODS:
        kinds = list(EVENT_SHAPES) * per_kind
        rng.shuffle(kinds)
        for kind in kinds:
            pattern, shape = rng.choice(EVENT_SHAPES[kind])
            slots = {}
            for patient in patients:
                starts = [
                    day for day in range(first_day, stop_day - len(shape) + 1)
                    if occupied[patient].isdisjoint(range(day, day + len(shape)))
                ]
                if starts:
                    slots[patient] = starts

            eligible = list(slots)
            patient = rng.choices(
                eligible, weights=[candidate.event_weight(kind) for candidate in eligible]
            )[0]
            onset = rng.choice(slots[patient])
            event = Event(patient, kind, onset, pattern, shape, subtle=rng.random() < 0.40)
            events.append(event)
            # Leave two days between windows for the same patient.
            occupied[patient].update(range(event.onset - 2, event.end + 3))
    return sorted(events, key=lambda event: (event.onset, event.patient.patient_id))


def inject_event(days, event, rng):
    """Apply an episode relative to the patient's own unperturbed readings."""
    peak = days[event.peak]
    if event.kind == "hypertension":
        rise = rng.uniform(14, 24) if event.subtle else rng.uniform(30, 47)
        shifts = {"systolic_mmhg": rise, "diastolic_mmhg": rise * rng.uniform(0.22, 0.42)}
    elif event.kind == "low_sugar":
        nadir = rng.uniform(63, 69) if event.subtle else rng.uniform(48, 63)
        shifts = {"fasting_glucose_mg_dl": nadir - peak["fasting_glucose_mg_dl"],
                  "pulse_bpm": rng.uniform(0, 11)}
    elif event.kind == "fever":
        high = rng.uniform(37.55, 38.15) if event.subtle else rng.uniform(38.2, 39.4)
        shifts = {"oral_temperature_c": high - peak["oral_temperature_c"],
                  "pulse_bpm": rng.uniform(4, 14)}
    else:
        drop = rng.uniform(2.6, 4.2) if event.subtle else rng.uniform(5.0, 9.0)
        shifts = {"spo2_pct": -drop, "pulse_bpm": rng.uniform(1, 10)}

    for offset, fraction in enumerate(event.shape):
        reading = days[event.onset + offset]
        for vital, shift in shifts.items():
            reading[vital] += fraction * shift


def write_csv(path, fields, rows):
    with path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def generate(start_date, output_dir, seed, missing_rate):
    rng = Random(seed)
    patients = make_patients(rng)
    series = {patient: background_vitals(patient, rng) for patient in patients}
    events = schedule_events(patients, rng)
    for event in events:
        inject_event(series[event.patient], event, rng)

    dates = [(start_date + timedelta(days=day)).isoformat() for day in range(DAY_COUNT)]
    rows = []
    for day, reading_date in enumerate(dates):
        for patient in patients:
            values = series[patient][day]
            values["spo2_pct"] = min(100, values["spo2_pct"])
            observed = {field: round(value) for field, value in values.items()}
            observed["oral_temperature_c"] = round(values["oral_temperature_c"], 1)
            for group in READING_GROUPS:
                if rng.random() < missing_rate:
                    observed.update(dict.fromkeys(group, None))
            rows.append({"patient_id": patient.patient_id, "date": reading_date, **observed})

    output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(output_dir / "patients.csv", ("patient_id", "age"),
              ({"patient_id": p.patient_id, "age": p.age} for p in patients))
    write_csv(output_dir / "vitals.csv", ("patient_id", "date", *VITAL_FIELDS), rows)
    event_fields = ("event_id", "patient_id", "event_type", "onset_date", "peak_date",
                    "end_date", "pattern", "magnitude")
    write_csv(output_dir / "events.csv", event_fields, (
        {"event_id": f"E{index:03d}", "patient_id": e.patient.patient_id,
         "event_type": e.kind, "onset_date": dates[e.onset], "peak_date": dates[e.peak],
         "end_date": dates[e.end], "pattern": e.pattern,
         "magnitude": "subtle" if e.subtle else "marked"}
        for index, e in enumerate(events, start=1)
    ))

    counts = Counter(event.kind for event in events)
    print(f"{len(patients)} patients, {len(dates)} days, {len(rows)} readings in {output_dir}")
    print(f"{len(events)} injected episodes ({', '.join(f'{k}: {v}' for k, v in sorted(counts.items()))})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-date", type=date.fromisoformat, default=date(2026, 8, 21))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--missing-rate", type=float, default=0.015,
                        help="Missing probability per reading group (default 0.015). Use 0 for complete data.")
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    args = parser.parse_args()
    if not 0 <= args.missing_rate <= 1:
        parser.error("--missing-rate must be between 0 and 1")
    generate(args.start_date, args.output_dir, args.seed, args.missing_rate)
