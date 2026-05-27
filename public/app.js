function formatUsd(value) {
  if (value === null || value === undefined || value === "") return "-";
  try {
    const number = Number(BigInt(value)) / 1e6;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
  } catch {
    return String(value);
  }
}

const TOKEN_METADATA = {
  "0x08c6f91e2b681faf5e17227f2a44c307b3c1364c": { symbol: "liquidUSD", decimals: 6 },
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6 },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0x5a7facb970d094b6c7ff1df0ea68d99e6e73cbff": { symbol: "weETH", decimals: 18 },
  "0x5f46d540b6ed704c3c8789105f30e075aa900726": { symbol: "liquidBTC", decimals: 8 },
  "0x657e8c867d8b37dcc18fa4caead9c45eb088c642": { symbol: "eBTC", decimals: 8 },
  "0x80eede496655fb9047dd39d9f418d5483ed600df": { symbol: "frxUSD", decimals: 18 },
  "0x86b5780b606940eb59a062aa85a07959518c0161": { symbol: "sETHFI", decimals: 18 },
  "0x939778d83b46b456224a33fb59630b11dec56663": { symbol: "eUSD", decimals: 18 },
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", decimals: 6 },
  "0xa519afbc91986c0e7501d7e34968fee51cd901ac": { symbol: "beHYPE", decimals: 18 },
  "0xca5921df65e2e1b0b98ae91c0187ba80d4124898": { symbol: "liquidRESERVE", decimals: 18 },
  "0xcc476b1a49bcdf5192561e87b6fb8ea78aa28c13": { symbol: "weEUR", decimals: 18 },
  "0xd83e3d560ba6f05094d9d8b3eb8aaea571d1864e": { symbol: "WHYPE", decimals: 18 },
  "0xdcb612005417dc906ff72c87df732e5a90d49e11": { symbol: "EURC", decimals: 6 },
  "0xe0080d2f853ecddbd81a643dc10da075df26fd3f": { symbol: "ETHFI", decimals: 18 },
  "0xf0bb20865277abd641a307ece5ee04e79073416c": { symbol: "liquidETH", decimals: 18 }
};

const safeTableState = {
  page: 1,
  pageSize: 50
};

const alertTableState = {
  rangeDays: 30
};

function debounce(callback, delay = 250) {
  let timeoutId;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delay);
  };
}

function displayAddress(address) {
  if (!address) return "-";
  return address;
}

function shortAddress(address) {
  if (!address) return "-";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function setAlertDateRange(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Number(days || 30));
  document.querySelector("#alertStartDate").value = formatDateInput(start);
  document.querySelector("#alertEndDate").value = formatDateInput(end);
}

function pill(value) {
  const className = String(value || "unknown").toLowerCase();
  return `<span class="pill ${className}">${value || "unknown"}</span>`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${Number(value).toFixed(1)}%`;
}

function formatTokenAmount(rawAmount, decimals) {
  if (rawAmount === null || rawAmount === undefined || decimals === null || decimals === undefined) return rawAmount || "-";
  try {
    const value = Number(BigInt(rawAmount)) / 10 ** decimals;
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: value >= 1 ? 4 : 8
    }).format(value);
  } catch {
    return String(rawAmount);
  }
}

function tokenLabel(token) {
  const normalized = String(token || "").toLowerCase();
  const metadata = TOKEN_METADATA[normalized];
  return metadata ? metadata.symbol : shortAddress(token);
}

function normalizeTokenRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderCollateral(row) {
  const collateral = normalizeTokenRows(row.collateral).filter((item) => item && item.token && item.amount !== "0");
  const total = formatUsd(row.total_collateral_usd);
  if (!collateral.length) return total;

  const assets = collateral.map((item) => {
    const normalized = String(item.token).toLowerCase();
    const metadata = TOKEN_METADATA[normalized] || {};
    const amount = formatTokenAmount(item.amount, metadata.decimals);
    const label = tokenLabel(item.token);
    return `<li title="${item.token}"><span>${amount} ${label}</span><small>${shortAddress(item.token)}</small></li>`;
  }).join("");

  return `
    <div class="collateral-breakdown">
      <strong>${total}</strong>
      <ul>${assets}</ul>
    </div>
  `;
}

function healthBand(score) {
  if (score === null || score === undefined) return "unknown";
  if (score < 40) return "critical";
  if (score < 70) return "warning";
  return "healthy";
}

function statusLabel(score) {
  const band = healthBand(score);
  if (band === "critical") return "Critical";
  if (band === "warning") return "Warning";
  if (band === "healthy") return "Healthy";
  return "No data";
}

function pointerPoint(score) {
  const clamped = Math.min(100, Math.max(0, Number(score || 0)));
  const angle = (180 - clamped * 1.8) * (Math.PI / 180);
  return {
    x: 180 + Math.cos(angle) * 108,
    y: 170 - Math.sin(angle) * 108
  };
}

function renderHealthGauge(summary) {
  const health = summary.portfolioHealth || {};
  const score = health.healthScore;
  const point = pointerPoint(score);
  const band = healthBand(score);
  const usable = health.sampleSize || 0;
  const evaluated = summary.evaluatedSafes || 0;

  document.querySelector("#healthGauge").innerHTML = `
    <div class="gauge-layout">
      <svg class="gauge-chart" viewBox="0 0 360 220" role="img" aria-label="Current wallet health score">
        <path class="gauge-track zone-red" d="M 40 170 A 140 140 0 0 1 320 170" pathLength="100" />
        <path class="gauge-track zone-yellow" d="M 40 170 A 140 140 0 0 1 320 170" pathLength="100" />
        <path class="gauge-track zone-green" d="M 40 170 A 140 140 0 0 1 320 170" pathLength="100" />
        <line class="gauge-pointer" x1="180" y1="170" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" />
        <circle class="gauge-pin" cx="180" cy="170" r="9" />
        <text class="gauge-label left" x="40" y="204">0</text>
        <text class="gauge-label middle" x="180" y="76">50</text>
        <text class="gauge-label right" x="320" y="204">100</text>
      </svg>
      <div class="health-readout">
        <span class="pill ${band}">${statusLabel(score)}</span>
        <strong>${score ?? "-"}</strong>
        <p>Portfolio health score</p>
        <dl>
          <div><dt>Avg. liquidation util.</dt><dd>${formatPercent(health.averageLiquidationUtilizationPct)}</dd></div>
          <div><dt>Usable wallets</dt><dd>${usable} / ${evaluated}</dd></div>
        </dl>
      </div>
    </div>
  `;
}

function yForScore(score, top, height) {
  return top + ((100 - score) / 100) * height;
}

function renderHealthTrend(trend) {
  const points = (trend.points || []).filter((point) => point.healthScore !== null);
  if (!points.length) {
    document.querySelector("#healthTrend").innerHTML = `<p class="empty-chart">No health history with usable liquidation utilization yet.</p>`;
    return;
  }

  const width = 680;
  const height = 260;
  const left = 42;
  const right = 20;
  const top = 20;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const xForIndex = (index) => left + (points.length === 1 ? plotWidth : (index / (points.length - 1)) * plotWidth);
  const line = points.map((point, index) => `${xForIndex(index).toFixed(1)},${yForScore(point.healthScore, top, plotHeight).toFixed(1)}`).join(" ");
  const latest = points[points.length - 1];
  const firstDate = formatDate(points[0].timestamp);
  const lastDate = formatDate(latest.timestamp);

  document.querySelector("#healthTrend").innerHTML = `
    <div class="trend-layout">
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Wallet health trend">
        <rect class="trend-zone zone-green-fill" x="${left}" y="${yForScore(100, top, plotHeight)}" width="${plotWidth}" height="${yForScore(70, top, plotHeight) - yForScore(100, top, plotHeight)}" />
        <rect class="trend-zone zone-yellow-fill" x="${left}" y="${yForScore(70, top, plotHeight)}" width="${plotWidth}" height="${yForScore(40, top, plotHeight) - yForScore(70, top, plotHeight)}" />
        <rect class="trend-zone zone-red-fill" x="${left}" y="${yForScore(40, top, plotHeight)}" width="${plotWidth}" height="${yForScore(0, top, plotHeight) - yForScore(40, top, plotHeight)}" />
        <line class="axis-line" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" />
        <line class="axis-line" x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" />
        <text class="axis-label" x="10" y="${yForScore(100, top, plotHeight) + 5}">100</text>
        <text class="axis-label" x="16" y="${yForScore(70, top, plotHeight) + 5}">70</text>
        <text class="axis-label" x="16" y="${yForScore(40, top, plotHeight) + 5}">40</text>
        <text class="axis-label" x="22" y="${yForScore(0, top, plotHeight) + 5}">0</text>
        <polyline class="trend-line" points="${line}" />
        ${points.map((point, index) => `<circle class="trend-point ${healthBand(point.healthScore)}" cx="${xForIndex(index).toFixed(1)}" cy="${yForScore(point.healthScore, top, plotHeight).toFixed(1)}" r="4"><title>${formatDate(point.timestamp)}: ${point.healthScore}</title></circle>`).join("")}
        <text class="time-label" x="${left}" y="${height - 10}">${firstDate}</text>
        <text class="time-label end" x="${left + plotWidth}" y="${height - 10}">${lastDate}</text>
      </svg>
      <div class="trend-summary">
        <span class="pill ${healthBand(latest.healthScore)}">${statusLabel(latest.healthScore)}</span>
        <strong>${latest.healthScore}</strong>
        <p>Latest trend point</p>
      </div>
    </div>
  `;
}

function renderHealthVisuals(summary, trend) {
  renderHealthGauge(summary);
  renderHealthTrend(trend);
}

const mockedLiquidations = [
  {
    wallet: "0x2f0E0a7a1B7d8D34A0A6d3E3f91E6F53E6a4B912",
    chain: "Ethereum",
    liquidationAmountUsd: 1845000,
    debtUsd: 4210000,
    collateralUsd: 5025000,
    scheduledAt: "2026-05-28T16:00:00.000Z",
    reason: "Liquidation threshold breached"
  },
  {
    wallet: "0x8dB9f7A710F2c18d8c64286Ae1a0B90214D3A5c7",
    chain: "Base",
    liquidationAmountUsd: 1260000,
    debtUsd: 2980000,
    collateralUsd: 3560000,
    scheduledAt: "2026-05-28T18:30:00.000Z",
    reason: "Oracle price movement"
  },
  {
    wallet: "0x41E9A01eB3807e383f3E4066f361B89272d7cAf0",
    chain: "Ethereum",
    liquidationAmountUsd: 720000,
    debtUsd: 1740000,
    collateralUsd: 2050000,
    scheduledAt: "2026-05-29T09:15:00.000Z",
    reason: "Collateral drawdown"
  },
  {
    wallet: "0x6504cD9bB66196E5BB4c2B1d604B0D67B4E720e4",
    chain: "Arbitrum",
    liquidationAmountUsd: 410000,
    debtUsd: 990000,
    collateralUsd: 1185000,
    scheduledAt: "2026-05-29T13:45:00.000Z",
    reason: "Health factor below policy"
  }
];

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function renderSummary() {
  const [summary, trend] = await Promise.all([fetchJson("/api/summary"), fetchJson("/api/health-trend")]);
  const statusMap = Object.fromEntries((summary.byStatus || []).map((row) => [row.health_status, row.count]));
  document.querySelector("#metrics").innerHTML = [
    ["Safes", summary.safes],
    ["Evaluated", summary.evaluatedSafes],
    ["Critical", statusMap.critical || 0],
    ["Warning", statusMap.warning || 0]
  ].map(([label, value]) => `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`).join("");

  const local = summary.latestLocal;
  document.querySelector("#checks").innerHTML = local ? `
    <div class="check">
      <div>${pill("fresh")}</div>
      <div>
        <strong>Local RPC snapshot</strong>
        <p class="mono">Safes: ${local.safe_count ?? "-"} | Borrow: ${formatUsd(local.total_borrow_usd)} | Collateral: ${formatUsd(local.total_collateral_usd)}</p>
      </div>
    </div>
  ` : "<p>No local aggregate snapshot yet.</p>";

  renderHealthVisuals(summary, trend);
}

async function renderSafes() {
  const status = document.querySelector("#statusFilter").value;
  const safeFilter = document.querySelector("#safeFilter").value.trim();
  const collateralFilter = document.querySelector("#collateralFilter").value.trim();
  const params = new URLSearchParams({
    page: String(safeTableState.page),
    pageSize: String(safeTableState.pageSize)
  });
  if (status) params.set("status", status);
  if (safeFilter) params.set("safe", safeFilter);
  if (collateralFilter) params.set("collateral", collateralFilter);

  const result = await fetchJson(`/api/safes?${params.toString()}`);
  const rows = Array.isArray(result) ? result : result.rows || [];
  const pagination = Array.isArray(result) ? {
    page: 1,
    pageSize: safeTableState.pageSize,
    totalRows: rows.length,
    totalPages: 1,
    hasPreviousPage: false,
    hasNextPage: false
  } : result.pagination || {
    page: 1,
    pageSize: safeTableState.pageSize,
    totalRows: rows.length,
    totalPages: 1,
    hasPreviousPage: false,
    hasNextPage: false
  };
  safeTableState.page = pagination.page;
  safeTableState.pageSize = pagination.pageSize;

  document.querySelector("#safeRows").innerHTML = rows.map((row) => `
    <tr>
      <td class="mono address-cell" title="${row.safe_address}">${displayAddress(row.safe_address)}</td>
      <td>${row.chain_name || row.chain_id || "-"}</td>
      <td>${formatDate(row.safe_created_at)}</td>
      <td>${formatDate(row.updated_at || row.last_evaluated_at)}</td>
      <td>${pill(row.health_status || "not_polled")}</td>
      <td>${pill(row.data_quality_state || "not_polled")}</td>
      <td>${formatUsd(row.total_borrow_usd)}</td>
      <td>${renderCollateral(row)}</td>
      <td>${row.liquidation_utilization_bps == null ? "-" : `${(row.liquidation_utilization_bps / 100).toFixed(1)}%`}</td>
      <td>${row.block_number || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="10">No safes imported yet.</td></tr>`;

  const start = pagination.totalRows === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.totalRows, pagination.page * pagination.pageSize);
  document.querySelector("#safePageSummary").textContent = `${start}-${end} of ${pagination.totalRows} safes`;
  document.querySelector("#safePageNumber").textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
  document.querySelector("#previousSafePage").disabled = !pagination.hasPreviousPage;
  document.querySelector("#nextSafePage").disabled = !pagination.hasNextPage;
}

function formatMockUsd(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function renderLiquidations() {
  const rows = [...mockedLiquidations].sort((a, b) => b.liquidationAmountUsd - a.liquidationAmountUsd);
  document.querySelector("#liquidationRows").innerHTML = rows.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td class="mono address-cell" title="${row.wallet}">${displayAddress(row.wallet)}</td>
      <td>${row.chain}</td>
      <td><strong>${formatMockUsd(row.liquidationAmountUsd)}</strong></td>
      <td>${formatMockUsd(row.debtUsd)}</td>
      <td>${formatMockUsd(row.collateralUsd)}</td>
      <td>${formatDate(row.scheduledAt)}</td>
      <td>${row.reason}</td>
    </tr>
  `).join("");
}

async function renderAlerts() {
  const start = document.querySelector("#alertStartDate").value;
  const end = document.querySelector("#alertEndDate").value;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);

  const result = await fetchJson(`/api/alerts?${params.toString()}`);
  document.querySelector("#alertRows").innerHTML = (result.alerts || []).map((row) => `
    <tr>
      <td>
        <strong>${row.name}</strong>
        <p class="row-description">${row.description}</p>
        <small>${row.signal || "-"}</small>
      </td>
      <td>${pill(row.status || "running")}</td>
      <td>${pill(row.severity || "unknown")}</td>
      <td>${row.cadence || "-"}</td>
      <td>${formatDate(row.lastRunAt)}</td>
      <td>${formatDate(row.lastSuccessfulRunAt)}</td>
      <td>${formatDate(row.lastFiredAt)}</td>
      <td><strong>${row.firedCount ?? 0}</strong></td>
      <td>${row.currentOpen ?? 0}</td>
      <td class="error-cell">${row.lastError || "-"}</td>
      <td>${row.route || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="11">No alert monitors configured.</td></tr>`;
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelector("#safesTab").classList.toggle("active", tabName === "safes");
  document.querySelector("#liquidationsTab").classList.toggle("active", tabName === "liquidations");
  document.querySelector("#alertsTab").classList.toggle("active", tabName === "alerts");
}

async function render() {
  renderLiquidations();
  await Promise.all([renderSummary(), renderSafes(), renderAlerts()]);
}

setAlertDateRange(alertTableState.rangeDays);
document.querySelector("#refresh").addEventListener("click", render);
const renderSafesFromFirstPage = () => {
  safeTableState.page = 1;
  renderSafes();
};
const debouncedSafeFilterRender = debounce(renderSafesFromFirstPage);
document.querySelector("#safeFilter").addEventListener("input", debouncedSafeFilterRender);
document.querySelector("#collateralFilter").addEventListener("input", debouncedSafeFilterRender);
document.querySelector("#statusFilter").addEventListener("change", () => {
  renderSafesFromFirstPage();
});
document.querySelector("#pageSize").addEventListener("change", (event) => {
  safeTableState.page = 1;
  safeTableState.pageSize = Number(event.target.value) || 50;
  renderSafes();
});
document.querySelector("#clearSafeFilters").addEventListener("click", () => {
  document.querySelector("#safeFilter").value = "";
  document.querySelector("#collateralFilter").value = "";
  document.querySelector("#statusFilter").value = "";
  renderSafesFromFirstPage();
});
document.querySelector("#previousSafePage").addEventListener("click", () => {
  safeTableState.page = Math.max(1, safeTableState.page - 1);
  renderSafes();
});
document.querySelector("#nextSafePage").addEventListener("click", () => {
  safeTableState.page += 1;
  renderSafes();
});
document.querySelector("#alertQuickRange").addEventListener("change", (event) => {
  alertTableState.rangeDays = Number(event.target.value) || 30;
  setAlertDateRange(alertTableState.rangeDays);
  renderAlerts();
});
document.querySelector("#alertStartDate").addEventListener("change", renderAlerts);
document.querySelector("#alertEndDate").addEventListener("change", renderAlerts);
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
});
render().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${error.message}</pre>`);
});
