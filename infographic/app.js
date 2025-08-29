const API_BASE = "https://api.sleeper.app/v1";
const GOOGLE_SHEET_ID = "1MDTf1IouUIrm4qabQT9E5T0FsJhQtmaX55P32XK5c_0";

const state = {
  cache: {},
  players: {},
  oneQbData: {},
  sflxData: {},
  userId: null,
  isSuperflex: false,
  teams: [],
  selectedTeam: null,
};

// enable value labels on charts
Chart.register(ChartDataLabels);

// plugin to draw text inside donut charts
const centerTextPlugin = {
  id: "centerText",
  afterDraw(chart, args, opts) {
    if (chart.config.type !== "doughnut" || !opts.text) return;
    const {
      ctx,
      chartArea: { width, height },
    } = chart;
    ctx.save();
    ctx.font = "600 1rem Quicksand";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opts.text, width / 2, height / 2);
  },
};
Chart.register(centerTextPlugin);

Chart.defaults.color = "#eaebf0";
Chart.defaults.font.family = "Quicksand, sans-serif";

function getCssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatNumber(n) {
  return Math.round(n).toLocaleString();
}

async function init() {
  await Promise.all([fetchSleeperPlayers(), fetchDataFromGoogleSheet()]);
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  document.getElementById("loadBtn").addEventListener("click", handleLoad);
  document.getElementById("leagueSelect").addEventListener("change", (e) => {
    const id = e.target.value;
    if (id) loadLeague(id);
  });
  document
    .querySelectorAll(".dl-btn")
    .forEach((b) =>
      b.addEventListener("click", () => downloadChart(b.dataset.chart)),
    );
});

async function handleLoad() {
  const username = document.getElementById("username").value.trim();
  if (!username) return;
  showLoading();
  try {
    const user = await fetchWithCache(`${API_BASE}/user/${username}`);
    if (!user || !user.user_id) {
      alert("User not found");
      return;
    }
    state.userId = user.user_id;
    const currentYear = new Date().getFullYear();
    const leagues = await fetchWithCache(
      `${API_BASE}/user/${state.userId}/leagues/nfl/${currentYear}`,
    );
    const select = document.getElementById("leagueSelect");
    select.innerHTML = '<option value="">Select league</option>';
    leagues.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l.league_id;
      opt.textContent = l.name;
      select.appendChild(opt);
    });
    select.classList.remove("hidden");
  } finally {
    hideLoading();
  }
}

async function loadLeague(leagueId) {
  showLoading();
  try {
    const [leagueInfo, rosters, users, tradedPicks] = await Promise.all([
      fetchWithCache(`${API_BASE}/league/${leagueId}`),
      fetchWithCache(`${API_BASE}/league/${leagueId}/rosters`),
      fetchWithCache(`${API_BASE}/league/${leagueId}/users`),
      fetchWithCache(`${API_BASE}/league/${leagueId}/traded_picks`),
    ]);

    const rosterPositions = leagueInfo.roster_positions;
    const superflexSlots = rosterPositions.filter((p) =>
      ["SUPER_FLEX", "SFLX"].includes(p),
    ).length;
    const qbSlots = rosterPositions.filter((p) => p === "QB").length;
    state.isSuperflex = superflexSlots > 0 || qbSlots > 1;

    state.teams = processRosterData(rosters, users, tradedPicks, leagueInfo);
    computeTeamRanks(state.teams);
    // order teams by starter strength for consistent chart and table display
    state.teams.sort((a, b) => a.starterRank - b.starterRank);
    computeSlotRanks(state.teams);
    buildCharts();
    populateSlotTable(rosterPositions);

    document.getElementById("charts").classList.remove("hidden");
    document.getElementById("slotTableSection").classList.remove("hidden");
    const userIdx = state.teams.findIndex((t) => t.isUserTeam);
    selectTeam(userIdx >= 0 ? userIdx : 0);
  } finally {
    hideLoading();
  }
}

function processRosterData(rosters, users, tradedPicks, leagueInfo) {
  const userMap = users.reduce((acc, u) => {
    acc[u.user_id] = u;
    return acc;
  }, {});
  const rosterPositions = leagueInfo.roster_positions;
  return rosters.map((roster) => {
    const owner = userMap[roster.owner_id];
    const starters = roster.starters || [];
    const allPlayers = roster.players || [];
    const starterObjs = starters.map((pid, idx) => {
      const slot = rosterPositions[idx] || "FLEX";
      return getPlayerData(pid, slot);
    });
    const slotCounts = {};
    const slotValues = {};
    starterObjs.forEach((p) => {
      slotCounts[p.slot] = (slotCounts[p.slot] || 0) + 1;
      const displaySlot =
        slotCounts[p.slot] > 1 ? `${p.slot}${slotCounts[p.slot]}` : p.slot;
      p.displaySlot = displaySlot;
      slotValues[displaySlot] = p.ktc || 0;
    });
    const starterTotal = starterObjs.reduce((sum, p) => sum + (p.ktc || 0), 0);
    const allPlayerObjs = allPlayers.map((pid) => getPlayerData(pid, ""));
    const posTotals = {};
    allPlayerObjs.forEach((p) => {
      posTotals[p.pos] = (posTotals[p.pos] || 0) + (p.ktc || 0);
    });
    const ages = allPlayerObjs.map((p) => p.age).filter((a) => a);
    const avgAge = ages.length
      ? ages.reduce((s, a) => s + a, 0) / ages.length
      : null;
    const draftPicks = getOwnedPicks(
      roster.roster_id,
      tradedPicks,
      leagueInfo,
    ).map((p) => getPickData(p));
    const pickTotal = draftPicks.reduce((s, p) => s + (p.ktc || 0), 0);
    const totalValue =
      allPlayerObjs.reduce((s, p) => s + (p.ktc || 0), 0) + pickTotal;
    return {
      teamName: owner?.display_name || `Team ${roster.roster_id}`,
      isUserTeam: roster.owner_id === state.userId,
      starters: starterObjs,
      slotValues,
      slotRanks: {},
      starterTotal,
      posTotals,
      pickTotal,
      totalValue,
      avgAge,
    };
  });
}

function computeSlotRanks(teams) {
  const slots = new Set();
  teams.forEach((t) => Object.keys(t.slotValues).forEach((s) => slots.add(s)));
  slots.forEach((slot) => {
    const sorted = [...teams].sort(
      (a, b) => (b.slotValues[slot] || 0) - (a.slotValues[slot] || 0),
    );
    sorted.forEach((team, idx) => {
      team.slotRanks[slot] = idx + 1;
    });
  });
}

function computeTeamRanks(teams) {
  const startersSorted = [...teams].sort(
    (a, b) => b.starterTotal - a.starterTotal,
  );
  startersSorted.forEach((team, idx) => {
    team.starterRank = idx + 1;
  });
  const totalSorted = [...teams].sort((a, b) => b.totalValue - a.totalValue);
  totalSorted.forEach((team, idx) => {
    team.totalRank = idx + 1;
  });
}

let startersChart, totalChart, teamChart;

function buildCharts() {
  const teams = state.teams;
  const labels = teams.map((t) => t.teamName);
  const starterData = teams.map((t) => t.starterTotal);
  const ctx1 = document.getElementById("startersChart").getContext("2d");
  const wrHex = getCssVar("--pos-wr");
  const accentHex = getCssVar("--color-accent-primary");
  const gradientNormal = ctx1.createLinearGradient(0, 0, ctx1.canvas.width, 0);
  gradientNormal.addColorStop(0, hexToRgba(wrHex, 0.4));
  gradientNormal.addColorStop(1, wrHex);
  const gradientAccent = ctx1.createLinearGradient(0, 0, ctx1.canvas.width, 0);
  gradientAccent.addColorStop(0, hexToRgba(accentHex, 0.4));
  gradientAccent.addColorStop(1, accentHex);
  const starterColors = teams.map((t) =>
    t.isUserTeam ? gradientAccent : gradientNormal,
  );
  ctx1.canvas.height = Math.max(teams.length * 40, 200);
  if (startersChart) startersChart.destroy();
  startersChart = new Chart(ctx1, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Starters KTC",
          data: starterData,
          backgroundColor: starterColors,
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          beginAtZero: true,
          ticks: { callback: (v) => v.toLocaleString() },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const team = teams[ctx.dataIndex];
              const val = ctx.parsed.x.toLocaleString();
              return `${team.teamName}: ${val} (${ordinalSuffix(team.starterRank)})`;
            },
          },
        },
        datalabels: {
          anchor: "end",
          align: "right",
          color: "#fff",
          formatter: (value, ctx) => {
            const rank = ordinalSuffix(teams[ctx.dataIndex].starterRank);
            return `${formatNumber(value)} (${rank})`;
          },
        },
      },
      onClick: (evt) => {
        const points = startersChart.getElementsAtEventForMode(
          evt,
          "nearest",
          { intersect: true },
          true,
        );
        if (points.length) selectTeam(points[0].index);
      },
    },
  });

  const positions = ["QB", "RB", "WR", "TE"];
  const ctx2 = document.getElementById("totalChart").getContext("2d");
  const colors = positions.reduce((acc, pos) => {
    const hex = getCssVar(`--pos-${pos.toLowerCase()}`);
    const grad = ctx2.createLinearGradient(0, 0, ctx2.canvas.width, 0);
    grad.addColorStop(0, hexToRgba(hex, 0.4));
    grad.addColorStop(1, hex);
    acc[pos] = grad;
    return acc;
  }, {});
  const pickHex = getCssVar("--pos-pick");
  const pickGrad = ctx2.createLinearGradient(0, 0, ctx2.canvas.width, 0);
  pickGrad.addColorStop(0, hexToRgba(pickHex, 0.4));
  pickGrad.addColorStop(1, pickHex);
  const datasets = positions.map((pos) => ({
    label: pos,
    data: teams.map((t) => t.posTotals[pos] || 0),
    backgroundColor: colors[pos],
    stack: "stack",
    datalabels: {
      color: "#000",
      anchor: "center",
      formatter: (value) => (value ? formatNumber(value) : ""),
    },
  }));
  datasets.push({
    label: "Picks",
    data: teams.map((t) => t.pickTotal),
    backgroundColor: pickGrad,
    stack: "stack",
    datalabels: {
      anchor: "end",
      align: "right",
      color: "#fff",
      formatter: (value, ctx) => {
        const total =
          positions.reduce(
            (sum, p) =>
              sum + (datasets[positions.indexOf(p)].data[ctx.dataIndex] || 0),
            0,
          ) + value;
        return formatNumber(total);
      },
    },
  });
  ctx2.canvas.height = Math.max(teams.length * 40, 200);
  if (totalChart) totalChart.destroy();
  totalChart = new Chart(ctx2, {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          beginAtZero: true,
          ticks: { callback: (v) => v.toLocaleString() },
        },
        y: { stacked: true },
      },
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            footer: (items) => {
              const total = items.reduce((s, i) => s + i.parsed.x, 0);
              const team = teams[items[0].dataIndex];
              return `Total: ${total.toLocaleString()} (${ordinalSuffix(team.totalRank)})`;
            },
          },
        },
      },
      onClick: (evt) => {
        const points = totalChart.getElementsAtEventForMode(
          evt,
          "nearest",
          { intersect: true },
          true,
        );
        if (points.length) selectTeam(points[0].index);
      },
    },
  });
}

function buildTeamChart(team) {
  const ctx = document.getElementById("teamChart").getContext("2d");
  const labels = ["QB", "RB", "WR", "TE", "Picks"];
  const data = [
    team.posTotals.QB || 0,
    team.posTotals.RB || 0,
    team.posTotals.WR || 0,
    team.posTotals.TE || 0,
    team.pickTotal,
  ];
  const colors = [
    getCssVar("--pos-qb"),
    getCssVar("--pos-rb"),
    getCssVar("--pos-wr"),
    getCssVar("--pos-te"),
    getCssVar("--pos-pick"),
  ];
  ctx.canvas.height = 300;
  if (teamChart) teamChart.destroy();
  teamChart = new Chart(ctx, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${ctx.parsed.toLocaleString()}`,
          },
        },
        datalabels: {
          color: "#fff",
          formatter: (value, ctx) => {
            if (!value) return "";
            const total = ctx.chart.data.datasets[0].data.reduce(
              (s, v) => s + v,
              0,
            );
            const pct = ((value / total) * 100).toFixed(0);
            return `${pct}%`;
          },
        },
        centerText: { text: formatNumber(team.totalValue) },
      },
    },
  });
  document.getElementById("teamDetailName").textContent = team.teamName;
  const ageText = team.avgAge ? ` | Avg Age: ${team.avgAge.toFixed(1)}` : "";
  const starterRank = ordinalSuffix(team.starterRank);
  const totalRank = ordinalSuffix(team.totalRank);
  document.getElementById("teamSummary").textContent =
    `Starters: ${formatNumber(team.starterTotal)} (${starterRank}) | Total: ${formatNumber(team.totalValue)} (${totalRank})${ageText}`;
  document.getElementById("teamDetail").classList.remove("hidden");
}

function downloadChart(id) {
  const canvas = document.getElementById(id);
  const link = document.createElement("a");
  link.download = `${id}.png`;
  link.href = canvas.toDataURL("image/png", 1);
  link.click();
}

function showLoading() {
  document.getElementById("loading").classList.remove("hidden");
}

function hideLoading() {
  document.getElementById("loading").classList.add("hidden");
}

function populateSlotTable(rosterPositions) {
  const teams = state.teams;
  const slotOrder = [];
  const slotCounts = {};
  rosterPositions.forEach((slot) => {
    if (["BN", "IR", "TAXI"].includes(slot)) return;
    slotCounts[slot] = (slotCounts[slot] || 0) + 1;
    const display = slotCounts[slot] > 1 ? `${slot}${slotCounts[slot]}` : slot;
    slotOrder.push(display);
  });

  const table = document.getElementById("slotTable");
  table.innerHTML = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML =
    "<th>Team</th><th>Starter Total</th>" +
    slotOrder.map((s) => `<th>${s}</th>`).join("");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  teams.forEach((team, idx) => {
    const row = document.createElement("tr");
    row.addEventListener("click", () => selectTeam(idx));
    if (team.isUserTeam) row.classList.add("highlight");
    const starterRank = ordinalSuffix(team.starterRank);
    let cells = `<td>${team.teamName}</td><td>${formatNumber(team.starterTotal)}<br/><span class="rank">${starterRank}</span></td>`;
    cells += slotOrder
      .map((slot) => {
        const val = team.slotValues[slot] || 0;
        const rank = team.slotRanks[slot] || teams.length;
        return `<td>${formatNumber(val)}<br/><span class="rank">${ordinalSuffix(rank)}</span></td>`;
      })
      .join("");
    row.innerHTML = cells;
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
}

function selectTeam(index) {
  state.selectedTeam = state.teams[index];
  const rows = document.querySelectorAll("#slotTable tbody tr");
  rows.forEach((r, i) => r.classList.toggle("selected", i === index));
  buildTeamChart(state.selectedTeam);
  // highlight bars
  startersChart.setActiveElements([{ datasetIndex: 0, index }]);
  const active = [];
  totalChart.data.datasets.forEach((_, dIdx) =>
    active.push({ datasetIndex: dIdx, index }),
  );
  totalChart.setActiveElements(active);
  startersChart.update();
  totalChart.update();
}

async function fetchSleeperPlayers() {
  try {
    state.players = await fetchWithCache(`${API_BASE}/players/nfl`);
  } catch (e) {
    console.error("player fetch failed", e);
  }
}

async function fetchDataFromGoogleSheet() {
  try {
    const [oneQbCsv, sflxCsv] = await Promise.all([
      fetch(
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=KTC_1QB`,
      ).then((r) => r.text()),
      fetch(
        `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=KTC_SFLX`,
      ).then((r) => r.text()),
    ]);
    state.oneQbData = parseSheetData(oneQbCsv);
    state.sflxData = parseSheetData(sflxCsv);
  } catch (e) {
    console.error("sheet fetch failed", e);
  }
}

function parseSheetData(csv) {
  const lines = csv.trim().split(/\r?\n/).slice(1);
  const map = {};
  lines.forEach((line) => {
    const cols = line
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((c) => c.replace(/^"|"$/g, ""));
    if (cols.length < 13) return;
    const key = cols[12] ? cols[12] : cols[1];
    const ktc = parseInt(cols[6], 10);
    const age = parseFloat(cols[3]);
    const adp = parseFloat(cols[11]);
    const posRank =
      cols[7] && cols[7].includes("·")
        ? parseInt(cols[7].split("·")[1], 10)
        : null;
    map[key] = {
      ktc: isNaN(ktc) ? 0 : ktc,
      age: isNaN(age) ? null : age,
      adp: isNaN(adp) ? null : adp,
      posRank,
    };
  });
  return map;
}

function getPlayerData(playerId, slot) {
  const player = state.players[playerId] || {};
  const dataSet = state.isSuperflex ? state.sflxData : state.oneQbData;
  const valueData = dataSet[playerId] || {};
  return {
    id: playerId,
    name: player.full_name || playerId,
    pos: player.position || "NA",
    ktc: valueData.ktc || 0,
    age: valueData.age || null,
    slot,
  };
}

function ordinalSuffix(n) {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getPickData(pick) {
  const { season, round } = pick;
  const label = `${season} ${ordinalSuffix(round)}`;
  const staticVals = {
    oneqb: { 1: 5200, 2: 3200, 3: 2000, 4: 1200, 5: 400 },
    sflx: { 1: 4300, 2: 2600, 3: 1700, 4: 1000, 5: 400 },
  };
  let ktc = 0;
  if (parseInt(season) >= 2028 || round >= 5) {
    ktc = (state.isSuperflex ? staticVals.sflx : staticVals.oneqb)[round] || 0;
  } else {
    const sfx =
      round === 1 ? "st" : round === 2 ? "nd" : round === 3 ? "rd" : "th";
    const key = `${season} Mid ${round}${sfx}`;
    const dataSet = state.isSuperflex ? state.sflxData : state.oneQbData;
    ktc = dataSet[key]?.ktc || 0;
  }
  return { label, ktc };
}

function getOwnedPicks(rosterId, tradedPicks, leagueInfo) {
  const defaultRounds = leagueInfo.settings.draft_rounds || 5;
  const leagueSeason = parseInt(leagueInfo.season);
  const firstPickSeason = leagueSeason + 1;
  let owned = [];
  for (let i = 0; i < 4; i++) {
    const season = firstPickSeason + i;
    for (let round = 1; round <= defaultRounds; round++) {
      owned.push({
        season: String(season),
        round,
        original_owner_id: rosterId,
      });
    }
  }
  tradedPicks.forEach((pick) => {
    if (pick.roster_id === rosterId && pick.owner_id !== rosterId) {
      owned = owned.filter(
        (p) =>
          !(
            p.season === pick.season &&
            p.round === pick.round &&
            p.original_owner_id === rosterId
          ),
      );
    }
    if (pick.owner_id === rosterId && pick.roster_id !== rosterId) {
      if (parseInt(pick.season) >= firstPickSeason) {
        owned.push({
          season: pick.season,
          round: pick.round,
          original_owner_id: pick.roster_id,
        });
      }
    }
  });
  owned = owned.filter((p) => parseInt(p.season) < 2029);
  return owned.sort(
    (a, b) => a.season.localeCompare(b.season) || a.round - b.round,
  );
}

async function fetchWithCache(url) {
  if (state.cache[url]) return state.cache[url];
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  const data = await res.json();
  state.cache[url] = data;
  return data;
}
