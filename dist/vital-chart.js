(() => {
  "use strict";

  const dayLength = 86_400_000;
  const dateFormat = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", timeZone: "UTC",
  });
  const fullDateFormat = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  const alertStyles = {"Review": "review", "Early warning": "warning"};
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]);
  const isAlert = status => Object.hasOwn(alertStyles, status);

  function render({points, field, label, unit}) {
    const series = points
      .filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date))
      .map(point => ({...point, time: Date.parse(point.date + "T00:00:00Z")}))
      .filter(point => Number.isFinite(point.time)
        && new Date(point.time).toISOString().slice(0, 10) === point.date)
      .sort((first, second) => first.time - second.time);
    if (!series.length) return '<p class="care-trend-empty">No dated readings in this period.</p>';

    const firstTime = series[0].time;
    const lastTime = series.at(-1).time;
    const values = series.map(point => point.value).filter(Number.isFinite);
    const fieldDigits = field === "oral_temperature_c" ? 1 : 0;
    const chartWidth = 384;
    const dayWidth = firstTime === lastTime ? 54 : chartWidth / ((lastTime - firstTime) / dayLength);
    const x = time => firstTime === lastTime
      ? 239 : 47 + ((time - firstTime) / (lastTime - firstTime)) * chartWidth;
    const top = 23;
    const bottom = 120;
    const alerts = series.filter(point => isAlert(point.status));
    const endLabel = firstTime === lastTime ? "" : `<text x="431" y="143" text-anchor="end">${dateFormat.format(lastTime)}</text>`;
    const measurement = value => Number.isFinite(value)
      ? `${value.toFixed(Math.max(fieldDigits, Number(!Number.isInteger(value))))} ${unit}` : "Reading missing";

    let axes = "";
    let path = "";
    let observations = "";
    if (values.length) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const margin = Math.max((max - min) * .15, fieldDigits ? .15 : 1);
      const low = min - margin;
      const high = max + margin;
      const y = value => bottom - ((value - low) / (high - low)) * (bottom - top);
      axes = [high, (high + low) / 2, low].map(value => `
        <line class="care-trend-grid" x1="47" x2="431" y1="${y(value)}" y2="${y(value)}"/>
        <text x="39" y="${y(value) + 3}" text-anchor="end">${value.toFixed(fieldDigits)}</text>`).join("");
      let previousTime = null;
      for (const point of series) {
        if (!Number.isFinite(point.value)) {
          previousTime = null;
          continue;
        }
        const px = x(point.time);
        const py = y(point.value);
        path += `${previousTime !== null && point.time - previousTime === dayLength ? " L" : " M"}${px} ${py}`;
        previousTime = point.time;
        const tone = isAlert(point.status) ? ` care-trend-${alertStyles[point.status]}-reading` : "";
        const title = `${fullDateFormat.format(point.time)} · ${measurement(point.value)} · ${point.status}`;
        observations += `<circle class="care-trend-point${tone}" r="3.7" cx="${px}" cy="${py}"><title>${escape(title)}</title></circle>`;
      }
    } else {
      axes = '<text x="239" y="75" text-anchor="middle">No measurements for this vital</text>';
    }

    const markerWidth = Math.min(13, dayWidth * .65);
    const markers = alerts.map(point => {
      const position = x(point.time);
      const shape = point.status === "Review"
        ? `<circle class="care-trend-alert-shape" cx="${position}" cy="10" r="4.6"/>`
        : `<path class="care-trend-alert-shape" d="M${position} 4.6l5.4 5.4-5.4 5.4-5.4-5.4z"/>`;
      const note = `${fullDateFormat.format(point.time)} · ${point.status} · ${measurement(point.value)}`;
      return `<g class="care-trend-alert care-trend-${alertStyles[point.status]}" data-marker-date="${escape(point.date)}">
        <title>${escape(note)}</title>
        <rect class="care-trend-band" x="${position - markerWidth / 2}" y="17" width="${markerWidth}" height="109" rx="2"/>
        <line class="care-trend-guide" x1="${position}" x2="${position}" y1="17" y2="125"/>${shape}
      </g>`;
    }).join("");
    const alertDays = alerts.map(point => {
      const date = dateFormat.format(point.time);
      const dateAndStatus = `${fullDateFormat.format(point.time)}, ${point.status}`;
      return `<li>
        <button type="button" class="care-trend-date care-trend-${alertStyles[point.status]}"
          data-alert-date="${escape(point.date)}"
          aria-label="Open ${escape(dateAndStatus)}"
          title="${escape(point.reason || dateAndStatus)}">
          <span class="care-trend-chip-shape" aria-hidden="true"></span>
          <time datetime="${escape(point.date)}">${escape(date)}</time>
          <span>${escape(point.status)}</span>
        </button>
      </li>`;
    }).join("");
    const caption = `${label} history in ${unit}, ${fullDateFormat.format(firstTime)} to ${fullDateFormat.format(lastTime)}`;
    const beginX = firstTime === lastTime ? 239 : 47;
    const anchored = firstTime === lastTime ? ' text-anchor="middle"' : "";
    return `<figure class="care-trend">
      <svg class="care-trend-chart" viewBox="0 0 452 151" role="img" aria-label="${escape(caption)}">
        ${markers}${axes}<path class="care-trend-line" d="${path}"/>${observations}
        <text x="${beginX}" y="143"${anchored}>${dateFormat.format(firstTime)}</text>${endLabel}
      </svg>
      ${alerts.length ? `<figcaption class="care-trend-caption">
        <p>Patient alerts in this period</p>
        <ul class="care-trend-dates" aria-label="Open a date with a patient alert">${alertDays}</ul>
      </figcaption>` : ""}
    </figure>`;
  }

  globalThis.CareTrend = {render};
})();
