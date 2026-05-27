function formatUsd(value) {
  if (value === null || value === undefined || value === "") return "-";
  try {
    const number = Number(BigInt(value)) / 1e18;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
  } catch {
    return String(value);
  }
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

function pill(value) {
  const className = String(value || "unknown").toLowerCase();
  return `<span class="pill ${className}">${value || "unknown"}</span>`;
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
  const summary = await fetchJson("/api/summary");
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
}

async function renderSafes() {
  const status = document.querySelector("#statusFilter").value;
  const rows = await fetchJson(`/api/safes${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  document.querySelector("#safeRows").innerHTML = rows.map((row) => `
    <tr>
      <td class="mono" title="${row.safe_address}">${shortAddress(row.safe_address)}</td>
      <td>${row.chain_name || row.chain_id || "-"}</td>
      <td>${formatDate(row.safe_created_at)}</td>
      <td>${pill(row.health_status || "not_polled")}</td>
      <td>${pill(row.data_quality_state || "not_polled")}</td>
      <td>${formatUsd(row.total_borrow_usd)}</td>
      <td>${formatUsd(row.total_collateral_usd)}</td>
      <td>${row.liquidation_utilization_bps == null ? "-" : `${(row.liquidation_utilization_bps / 100).toFixed(1)}%`}</td>
      <td>${row.block_number || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="9">No safes imported yet.</td></tr>`;
}

function formatMockUsd(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function renderLiquidations() {
  const rows = [...mockedLiquidations].sort((a, b) => b.liquidationAmountUsd - a.liquidationAmountUsd);
  document.querySelector("#liquidationRows").innerHTML = rows.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td class="mono" title="${row.wallet}">${shortAddress(row.wallet)}</td>
      <td>${row.chain}</td>
      <td><strong>${formatMockUsd(row.liquidationAmountUsd)}</strong></td>
      <td>${formatMockUsd(row.debtUsd)}</td>
      <td>${formatMockUsd(row.collateralUsd)}</td>
      <td>${formatDate(row.scheduledAt)}</td>
      <td>${row.reason}</td>
    </tr>
  `).join("");
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelector("#safesTab").classList.toggle("active", tabName === "safes");
  document.querySelector("#liquidationsTab").classList.toggle("active", tabName === "liquidations");
}

async function render() {
  renderLiquidations();
  await Promise.all([renderSummary(), renderSafes()]);
}

document.querySelector("#refresh").addEventListener("click", render);
document.querySelector("#statusFilter").addEventListener("change", renderSafes);
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
});
render().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${error.message}</pre>`);
});
