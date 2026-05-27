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

function pill(value) {
  const className = String(value || "unknown").toLowerCase();
  return `<span class="pill ${className}">${value || "unknown"}</span>`;
}

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
      <td>${pill(row.health_status || "not_polled")}</td>
      <td>${pill(row.data_quality_state || "not_polled")}</td>
      <td>${formatUsd(row.total_borrow_usd)}</td>
      <td>${formatUsd(row.total_collateral_usd)}</td>
      <td>${row.liquidation_utilization_bps == null ? "-" : `${(row.liquidation_utilization_bps / 100).toFixed(1)}%`}</td>
      <td>${row.block_number || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">No safes imported yet.</td></tr>`;
}

async function render() {
  await Promise.all([renderSummary(), renderSafes()]);
}

document.querySelector("#refresh").addEventListener("click", render);
document.querySelector("#statusFilter").addEventListener("change", renderSafes);
render().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre>${error.message}</pre>`);
});
