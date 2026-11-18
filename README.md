# CarePal · Daily monitoring

A local early-warning dashboard for a home-care nurse reviewing daily visits. The queue ranks 50 synthetic patients by review priority. Selecting a patient shows the measurements behind the score, missing readings, and up to 14 days of history. The demo opens on the latest date in the dataset, **18 November 2026**.

Built for TheCarePal AI/ML internship assignment AI-02. This prototype supports care-team review. It does not diagnose conditions or replace clinical judgment.

![Daily monitoring dashboard with the ranked patient queue, selected patient's measurements, and vital history](docs/dashboard.png)

## Run locally

Requires **Python 3.10+** and a browser. Python 3.12 was used for verification. The example cohort and fitted cutoff are included. All scoring runs locally with the Python standard library and vanilla JavaScript. There are no paid libraries, model APIs, credentials, or hosting charges. Application software and API cost per run is **$0**, excluding the computer and electricity.

```sh
git clone https://github.com/avish006/TheCarePal-AI-02.git
cd TheCarePal-AI-02
python app.py
```

Open **[the local dashboard](http://127.0.0.1:8765/)**. Use `Ctrl+C` to stop the server or `python app.py --port 8766` to choose a different port. On Windows with uv and Python 3.12 installed, `uv run --offline --no-cache --python 3.12 app.py` also works.

### Try one patient

Choose **12 October 2026**, search for **P012**, then select **Oral temperature**. The reading is **37.9 °C**, compared with a personal median of **36.45 °C**. The temperature signal earns a **Review** even below the fixed fever cutoff of 38 °C. The same patient also crosses the fixed systolic BP boundary that day. Selecting different vitals shows which signal changed and which was already elevated.

The JSON API serves the same ranked queue and histories visible in the app. These links work while the local server is running. [Latest observations](http://127.0.0.1:8765/api/dashboard) · [P012 example date, full queue](http://127.0.0.1:8765/api/dashboard?date=2026-10-12)

## Data and scoring

[The generator](generate_synthetic_vitals.py) creates personal baselines, correlated daily variation, and measurement noise. It overlays abrupt or gradual hypertension, hypoglycemia, fever, and oxygen-drop episodes. Blood pressure has two components. Glucose represents a fasting measurement, temperature is oral, and the pulse rule assumes a resting observation. No real patient records are used.

The default seed of 42 produces 4,500 patient-days and 20 episodes of each type. Patient ages span 60–92 in this sample. Dates, episode rates, effect sizes and shapes, baseline distributions, and the 1.5% missing probability per measurement group are simulation choices. Episodes for one person have a two-day buffer. A blank measurement stays blank throughout scoring and appears as a gap in the chart.

| Detector | How it decides |
| --- | --- |
| Fixed clinical rules | Flags a day when any available vital crosses a reference boundary in the table below. |
| Learned personal baseline | Fits each patient's median and median absolute deviation (MAD) for each vital using the first 28 days. For a new reading, it divides the deviation from that median by the larger of 1.4826 × MAD and a vital-specific minimum scale. BP and temperature score upward changes, glucose and oxygen downward changes, and pulse either direction. |
| Daily dashboard priority | Combines the largest personal signal with fixed-rule alerts. A strong absolute warning can still move a patient to the top of the queue when their personal baseline is elevated. |

The first seven observed calibration values for each patient and vital establish a minimum history. During calibration, each personal reference uses only prior observations. The dashboard replays historical dates using the operating cutoff selected on days 29–49. Only days 50–90 are held out for reporting. The personal references freeze after day 28. If the preceding two daily measurements are available, a sustained change in the same direction can increase the signal by up to 25%. The scale floors in [detection.py](detection.py) keep a nearly constant vital from triggering on tiny fluctuations.

### Clinical references

| Measurement | Fixed alert used in the demo | Stronger absolute warning | Reference |
| --- | --- | --- | --- |
| Blood pressure | Systolic ≥140 or diastolic ≥90 mmHg | Systolic >180 or diastolic >120 mmHg | [American Heart Association](https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings) |
| Resting pulse | <60 or >100 bpm | — | [MedlinePlus](https://medlineplus.gov/ency/article/002341.htm) |
| SpO₂ | ≤92% | ≤88% | [MedlinePlus](https://medlineplus.gov/lab-tests/pulse-oximetry/) |
| Fasting blood glucose | <70 mg/dL | <55 mg/dL | [CDC](https://www.cdc.gov/diabetes/treatment/treatment-low-blood-sugar-hypoglycemia.html) |
| Oral temperature | ≥38 °C | — | [NHS](https://www.nhs.uk/symptoms/fever-in-adults/) |

These thresholds are comparison rules for a synthetic benchmark. An individual's care plan, symptoms and repeat measurements matter in clinical practice.

### Reading the queue

The score expresses review priority on a 0–100 scale. It is a heuristic, with no calibrated probability interpretation. Each vital contributes up to 90 points according to its personal signal, reaching 65 at the learned cutoff. A fixed-rule crossing sets a floor of 45, and a stronger absolute warning sets a floor of 95. The highest contribution sets the daily score. The explanation names up to two contributing vitals.

| Status | Meaning |
| --- | --- |
| Review | Score ≥65. The personal detector fired or a stronger absolute warning fired. |
| Watch | Score 45–64. A fixed rule fired or a smaller personal change warrants attention. |
| Routine | Score below 45, with all vitals present. |
| Incomplete | Score below 45 with missing measurements. When all measurements are absent the score is unavailable. Missing values also appear on Watch and Review rows. |

## Evaluation

Days 1–28 establish personal reference ranges. Days 29–49 contain 24 validation episodes. The evaluator selects a personal cutoff by validation F1 over 13 candidates from 2.0 through 5.0, choosing **4.0**. Days 50–90 contain **2,050 held-out patient-days**, including **221 event-days across 56 episodes**. Episode windows stay inside their split. Only the evaluator reads the injected labels.

| Held-out detector | Precision | Recall | F1 | False-positive days | Episodes detected |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed rules | 19.5% | 66.5% | 30.1% | 608 | 46/56 |
| Personal baseline | 81.2% | 54.8% | 65.4% | 28 | 45/56 |
| Dashboard **Review** | 81.2% | 54.8% | 65.4% | 28 | 45/56 |

Daily precision and recall compare any alert with any active injected window for the same person and day, including onset and recovery. A clinically elevated but stable reading outside a window counts as a false positive under this definition. Episode detection is stricter about the cause. It requires an alert from the affected vital during the window and counts each episode once.

The personal detector caught **14/14 fever episodes** and **8/14 BP episodes**. The rules caught **8/14** and **13/14**, respectively. Among 30 gradual episodes, the personal detector alerted on the affected vital before the planned peak in 18, compared with 17 for the rules. The dashboard's stronger absolute warnings added no extra Review days on this seed. These results describe this simulator and operating point. [Full counts and per-type breakdown](evaluation.json)

### Reproduce the benchmark

```sh
python generate_synthetic_vitals.py --seed 42
python evaluate.py
python -m unittest -v
python app.py
```

Run the first two commands together after changing the cohort, then restart the server. Use `--missing-rate 0` for complete observations. The generator writes [patient ages](data/patients.csv), [daily vitals](data/vitals.csv), and [episode labels](data/events.csv). The [evaluator](evaluate.py) writes the selected cutoff and held-out report. The [server](app.py) reads the cutoff and observations and serves the [dashboard interface](dist/).

## Next steps

Evaluate across additional seeds and simulated patients with overlapping events, irregular visits and changing baselines. Compare alert burden per nurse shift and detection delays by episode type. Before any clinical deployment, the thresholds and escalation workflow would need clinical review, local validation and prospective testing.

## AI assistance

OpenAI Codex assisted with interpreting the brief, building the generator, implementing the detectors and interface, running checks, preparing the walkthrough, and drafting this README. The application uses deterministic scoring and makes no calls to an AI service.
