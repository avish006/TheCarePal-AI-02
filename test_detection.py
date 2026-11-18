"""Regression checks for clinical boundaries, causal fitting, and missing readings."""
import csv
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from app import Dashboard
from detection import ROOT, VITALS, build_days, risk, rule_level
from evaluate import detection_fields


class DetectionTests(unittest.TestCase):
    def test_rule_boundaries(self):
        cases = {
            "systolic_mmhg": [(139, 0), (140, 1), (180, 1), (181, 2)],
            "diastolic_mmhg": [(89, 0), (90, 1), (120, 1), (121, 2)],
            "pulse_bpm": [(59, 1), (60, 0), (100, 0), (101, 1)],
            "spo2_pct": [(93, 0), (92, 1), (88, 2)],
            "fasting_glucose_mg_dl": [(70, 0), (69, 1), (55, 1), (54, 2)],
            "oral_temperature_c": [(37.9, 0), (38, 1)],
        }
        for field, examples in cases.items():
            for value, expected in examples:
                with self.subTest(field=field, value=value):
                    self.assertEqual(rule_level(field, value), expected)

    def test_past_only_reference_and_missingness(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "patients.csv").write_text("patient_id,age\nP001,74\n")
            dates = [(date(2026, 1, 1) + timedelta(days=n)).isoformat() for n in range(32)]
            with (directory / "vitals.csv").open("w", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(["patient_id", "date", *(v.field for v in VITALS)])
                for i, stamp in enumerate(dates):
                    values = [120 if i < 28 else 170, 75, 72, 97, 95, 36.5]
                    if i == 29:
                        values = [None] * 6
                    if i == 30:
                        values[3:] = [88, None, None]
                    writer.writerow(["P001", stamp, *values])
            days = build_days(directory)
            self.assertFalse(days[dates[6]]["P001"]["signals"])
            self.assertEqual(days[dates[7]]["P001"]["centers"]["systolic_mmhg"], 120)
            for stamp in dates[28:]:
                self.assertEqual(days[stamp]["P001"]["centers"]["systolic_mmhg"], 120)
            blank = risk(days[dates[29]]["P001"], 4)
            self.assertEqual((blank["score"], blank["level"]), (None, "Incomplete"))
            partial = risk(days[dates[30]]["P001"], 4)
            self.assertEqual((partial["score"], partial["level"]), (95, "Review"))
            self.assertIn("Missing", partial["reason"])

    def test_served_review_matches_evaluated_detector(self):
        dashboard = Dashboard(ROOT / "data", 4)
        for stamp, day in dashboard.days.items():
            for record in day.values():
                predicted = bool(detection_fields(record, "dashboard_review", 4))
                self.assertEqual(risk(record, 4)["level"] == "Review", predicted)
        payload = dashboard.for_date(dashboard.dates[4])
        scores = [p["score"] for p in payload["patients"]]
        self.assertEqual(scores, sorted(scores, reverse=True, key=lambda s: -1 if s is None else s))
        for patient in payload["patients"]:
            self.assertEqual([p["date"] for p in patient["history"]], dashboard.dates[:5])


if __name__ == "__main__":
    unittest.main()
