document.addEventListener('DOMContentLoaded', async () => {
    // --- DOM Elements ---
    const usernameInput = document.getElementById('usernameInput');
    const leagueSelect = document.getElementById('leagueSelect');
    const fetchButton = document.getElementById('fetchButton');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const welcomeScreen = document.getElementById('welcome-screen');
    const dashboardContainer = document.getElementById('dashboard-container');
    const totalValueChartCanvas = document.getElementById('totalValueChart');
    const starterValueChartCanvas = document.getElementById('starterValueChart');
    const positionalRanksContainer = document.getElementById('positional-ranks-container');
    const teamTiersContainer = document.getElementById('team-tiers-container');
    const teamDnaContainer = document.getElementById('team-dna-container');
    const viewToggle = document.getElementById('viewToggle');
    const customTooltip = document.getElementById('custom-tooltip');

    // --- State ---
    const state = {
        userId: null, leagues: [], players: {}, oneQbData: {}, sflxData: {},
        currentLeagueId: null, isSuperflex: false, cache: {}, charts: {},
        currentTeams: [], currentView: 'value'
    };

    // --- Constants ---
    const API_BASE = 'https://api.sleeper.app/v1';
    const GOOGLE_SHEET_ID = '1MDTf1IouUIrm4qabQT9E5T0FsJhQtmaX55P32XK5c_0';

    // --- Initialization & Event Listeners ---
    setLoading(true, 'Loading KTC Data...');
    await Promise.all([fetchSleeperPlayers(), fetchDataFromGoogleSheet()]);
    setLoading(false);
    welcomeScreen.classList.remove('hidden');
    loadingOverlay.classList.remove('visible');

    fetchButton.addEventListener('click', handleFetch);
    leagueSelect.addEventListener('change', handleLeagueSelect);
    viewToggle.addEventListener('change', handleViewToggle);

    // --- Main Handlers ---
    async function handleFetch() {
        const username = usernameInput.value.trim();
        if (!username) return;
        setLoading(true, 'Fetching User & Leagues...');
        try {
            await fetchAndSetUser(username);
            state.leagues = await fetchUserLeagues(state.userId) || [];
            state.leagues.sort((a, b) => a.name.localeCompare(b.name));
            populateLeagueSelect(state.leagues);
            if (state.leagues.length > 0) {
                await handleLeagueSelect();
            } else {
                handleError({ message: 'No leagues found for this user.' });
            }
        } catch (error) {
            handleError(error);
        } finally {
            setLoading(false);
        }
    }

    async function handleLeagueSelect() {
        const leagueId = leagueSelect.value;
        if (!leagueId) return;
        state.currentLeagueId = leagueId;
        const leagueInfo = state.leagues.find(l => l.league_id === leagueId);
        setLoading(true, `Analyzing ${leagueInfo?.name || 'League'}...`);
        try {
            dashboardContainer.classList.add('hidden');
            const rosterPositions = leagueInfo.roster_positions;
            state.isSuperflex = rosterPositions.includes('SUPER_FLEX') || rosterPositions.filter(p => p === 'QB').length > 1;
            const [rosters, users, tradedPicks] = await Promise.all([
                fetchWithCache(`${API_BASE}/league/${leagueId}/rosters`),
                fetchWithCache(`${API_BASE}/league/${leagueId}/users`),
                fetchWithCache(`${API_BASE}/league/${leagueId}/traded_picks`),
            ]);
            state.currentTeams = processTeamData(rosters, users, tradedPicks, leagueInfo);
            renderInfographic(state.currentTeams, leagueInfo);
            welcomeScreen.classList.add('hidden');
            dashboardContainer.classList.remove('hidden');
        } catch (error) {
            handleError(error);
        } finally {
            setLoading(false);
        }
    }

    function handleViewToggle() {
        state.currentView = viewToggle.checked ? 'rank' : 'value';
        renderPositionalRanks(state.currentTeams, state.leagues.find(l => l.league_id === state.currentLeagueId));
    }

    // --- Data Processing ---
    function processTeamData(rosters, users, tradedPicks, leagueInfo) {
        const userMap = users.reduce((acc, user) => ({ ...acc, [user.user_id]: user }), {});
        const teams = rosters.map(roster => {
            const owner = userMap[roster.owner_id];
            const allPlayers = (roster.players || []).map(pId => getPlayerData(pId));
            const starterIds = new Set(roster.starters || []);
            const starters = allPlayers.filter(p => starterIds.has(p.id));
            const draftPicks = getOwnedPicks(roster.roster_id, tradedPicks, leagueInfo).map(p => getPickData(p));

            const team = {
                teamName: owner?.display_name || `Team ${roster.roster_id}`,
                isUserTeam: roster.owner_id === state.userId,
                starters,
                allAssets: [...allPlayers, ...draftPicks],
                startersBySlot: assignStartersToSlots(starters, getLineupSlots(leagueInfo.roster_positions))
            };

            team.totalValue = team.allAssets.reduce((sum, asset) => sum + (asset.ktc || 0), 0);
            team.starterValue = team.starters.reduce((sum, asset) => sum + (asset.ktc || 0), 0);
            team.draftCapitalValue = draftPicks.reduce((sum, p) => sum + p.ktc, 0);
            const starterAges = team.starters.map(p => p.age).filter(Boolean);
            team.averageStarterAge = starterAges.length > 0 ? starterAges.reduce((sum, age) => sum + age, 0) / starterAges.length : 28;
            team.youthScore = team.starters.filter(p => p.age && p.age < 25).reduce((sum, p) => sum + p.ktc, 0);
            const sortedStarters = [...team.starters].sort((a,b) => b.ktc - a.ktc);
            const studValue = sortedStarters.slice(0, 3).reduce((sum, p) => sum + p.ktc, 0);
            team.studScore = team.starterValue > 0 ? (studValue / team.starterValue) * 100 : 0;

            return team;
        });

        calculateTeamTiers(teams);
        calculatePositionalScores(teams);
        return teams;
    }

    function calculateTeamTiers(teams) {
        const valueScores = teams.map(t => t.starterValue);
        const maxVal = Math.max(...valueScores);
        const minVal = Math.min(...valueScores);

        teams.forEach(team => {
            const valueScore = maxVal > minVal ? (team.starterValue - minVal) / (maxVal - minVal) : 0.5;
            if (valueScore > 0.65 && team.averageStarterAge < 27.5) team.tier = 'Contender';
            else if (valueScore < 0.4 && team.draftCapitalValue > 4000) team.tier = 'Rebuilder';
            else team.tier = 'Pretender';
        });
    }

    function calculatePositionalScores(teams) {
        const leagueAverage = { QB: 0, RB: 0, WR: 0, TE: 0 };
        teams.forEach(team => {
            team.positionalScores = { QB: 0, RB: 0, WR: 0, TE: 0 };
            team.starters.forEach(p => {
                if (team.positionalScores[p.pos] !== undefined) {
                    team.positionalScores[p.pos] += p.ktc;
                }
            });
        });

        let maxes = { QB: 0, RB: 0, WR: 0, TE: 0 };
        teams.forEach(team => { for(let pos in maxes) { if(team.positionalScores[pos] > maxes[pos]) maxes[pos] = team.positionalScores[pos]; } });

        teams.forEach(team => {
            for(let pos in maxes) {
                if(maxes[pos] > 0) { team.positionalScores[pos] = (team.positionalScores[pos] / maxes[pos]) * 100; }
                leagueAverage[pos] += team.positionalScores[pos];
            }
        });
        for(let pos in leagueAverage) { leagueAverage[pos] /= teams.length; }
        state.leagueAverageScores = leagueAverage;
    }

    // --- Rendering ---
    function renderInfographic(teams, leagueInfo) {
        const sortedByTotal = [...teams].sort((a, b) => b.totalValue - a.totalValue);
        renderTeamTiers(sortedByTotal);
        renderBarChart('totalValue', totalValueChartCanvas, sortedByTotal, 'totalValue');
        renderBarChart('starterValue', starterValueChartCanvas, [...teams].sort((a, b) => b.starterValue - a.starterValue), 'starterValue');
        renderPositionalRanks(teams, leagueInfo);
        renderTeamDna(teams);
    }

    function renderTeamTiers(teams) {
        teamTiersContainer.innerHTML = '<h3 class="chart-title">Team Tiers</h3>';
        teams.forEach(team => {
            const row = document.createElement('div');
            row.className = 'tier-row';
            if (team.isUserTeam) row.classList.add('is-user');
            row.innerHTML = `<span class="tier-badge ${team.tier.toLowerCase()}">${team.tier}</span><span class="team-name">${team.teamName}</span>`;
            teamTiersContainer.appendChild(row);
        });
    }

    function renderBarChart(chartId, canvas, teams, valueKey) {
        if (state.charts[chartId]) state.charts[chartId].destroy();

        const data = {
            labels: teams.map(t => t.teamName),
            datasets: [{
                data: teams.map(t => t[valueKey]),
                backgroundColor: context => {
                    const ctx = context.chart.ctx;
                    const gradient = ctx.createLinearGradient(0, 0, context.chart.width, 0);
                    gradient.addColorStop(0, 'rgba(138, 125, 255, 0.7)');
                    gradient.addColorStop(1, 'rgba(66, 194, 255, 0.7)');
                    return gradient;
                },
                borderColor: (context) => teams[context.dataIndex].isUserTeam ? '#fff' : 'rgba(138, 125, 255, 1)',
                borderWidth: (context) => teams[context.dataIndex].isUserTeam ? 2 : 1,
                borderRadius: 4,
                barThickness: 'flex'
            }]
        };

        state.charts[chartId] = new Chart(canvas, {
            type: 'bar',
            data: data,
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false,
                        external: context => {
                            const { chart, tooltip } = context;
                            if (tooltip.opacity === 0) { customTooltip.style.opacity = 0; return; }
                            const team = teams[tooltip.dataPoints[0].dataIndex];
                            let innerHtml = `<h4>${team.teamName} <span class="tier-badge-tooltip ${team.tier.toLowerCase()}">${team.tier}</span></h4>`;
                            innerHtml += `<ul>
                                <li><strong>Total Value:</strong> ${team.totalValue.toLocaleString()}</li>
                                <li><strong>Starter Value:</strong> ${team.starterValue.toLocaleString()}</li>
                                <li><strong>Player Value:</strong> ${(team.totalValue - team.draftCapitalValue).toLocaleString()}</li>
                                <li><strong>Pick Value:</strong> ${team.draftCapitalValue.toLocaleString()}</li>
                            </ul>`;
                            customTooltip.innerHTML = innerHtml;
                            const position = chart.canvas.getBoundingClientRect();
                            customTooltip.style.opacity = 1;
                            customTooltip.style.left = position.left + window.pageXOffset + tooltip.caretX + 'px';
                            customTooltip.style.top = position.top + window.pageYOffset + tooltip.caretY + 'px';
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: 'rgba(234, 235, 240, 0.7)' }, grid: { color: 'rgba(128, 138, 189, 0.1)' } },
                    y: { ticks: { color: '#EAEBF0', font: { size: 12 } }, grid: { display: false } }
                }
            }
        });
    }

    function renderPositionalRanks(teams, leagueInfo) {
        positionalRanksContainer.innerHTML = '';
        const lineupSlots = getLineupSlots(leagueInfo.roster_positions);
        let delay = 0;
        for (const slot in lineupSlots) {
            const card = document.createElement('div');
            card.className = 'position-card glass-panel';
            card.style.animationDelay = `${delay}s`;
            const title = document.createElement('h3');
            title.className = 'chart-title';
            title.textContent = slot;
            card.appendChild(title);

            const rankedTeams = teams.map(team => ({
                teamName: team.teamName, isUserTeam: team.isUserTeam,
                player: team.startersBySlot[slot] || { name: 'Empty', ktc: 0 }
            })).sort((a, b) => b.player.ktc - a.player.ktc);

            rankedTeams.forEach((team, index) => {
                const row = document.createElement('div');
                row.className = 'team-rank-row';
                if (team.isUserTeam) row.classList.add('is-user');

                const displayValue = state.currentView === 'value'
                    ? `KTC: ${team.player.ktc.toLocaleString()}`
                    : `#${index + 1}`;

                row.innerHTML = `<div class="rank">#${index + 1}</div>
                                 <div class="team-name">${team.teamName}</div>
                                 <div class="player-info">
                                     <div class="player-name">${team.player.name}</div>
                                     <div class="player-ktc">${state.currentView === 'value' ? displayValue : ''}</div>
                                 </div>
                                 <div class="position-rank">${state.currentView === 'rank' ? displayValue : ''}</div>`;
                card.appendChild(row);
            });
            positionalRanksContainer.appendChild(card);
            delay += 0.05;
        }
    }

    function renderTeamDna(teams) {
        teamDnaContainer.innerHTML = '';
        teams.forEach(team => {
            const wrapper = document.createElement('div');
            wrapper.className = 'dna-card glass-panel';
            wrapper.innerHTML = `<h3 class="chart-title">${team.teamName}</h3><canvas></canvas>
                                 <div class="dna-metric"><span class="dna-metric-title">Avg. Starter Age</span><span class="dna-metric-value">${team.averageStarterAge.toFixed(1)} yrs</span></div>
                                 <div class="dna-metric"><span class="dna-metric-title">Youth Score (U25 Starter KTC)</span><div class="progress-bar"><div class="progress-bar-inner" style="width: ${team.youthScore / 15000 * 100}%" title="${team.youthScore.toLocaleString()}"></div></div></div>
                                 <div class="dna-metric"><span class="dna-metric-title">Stud Concentration</span><div class="progress-bar"><div class="progress-bar-inner" style="width: ${team.studScore}%" title="${team.studScore.toFixed(1)}%"></div></div></div>`;
            teamDnaContainer.appendChild(wrapper);
            const canvas = wrapper.querySelector('canvas');
            new Chart(canvas.getContext('2d'), {
                type: 'radar',
                data: {
                    labels: ['QB', 'RB', 'WR', 'TE'],
                    datasets: [{
                        label: team.teamName,
                        data: Object.values(team.positionalScores),
                        backgroundColor: 'rgba(138, 125, 255, 0.2)',
                        borderColor: 'rgba(138, 125, 255, 1)',
                        pointBackgroundColor: 'rgba(138, 125, 255, 1)',
                    }, {
                        label: 'League Average',
                        data: Object.values(state.leagueAverageScores),
                        backgroundColor: 'rgba(66, 194, 255, 0.2)',
                        borderColor: 'rgba(66, 194, 255, 1)',
                        pointBackgroundColor: 'rgba(66, 194, 255, 1)',
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: { legend: { labels: { color: '#EAEBF0' } } },
                    scales: {
                        r: {
                            angleLines: { color: 'rgba(234, 235, 240, 0.2)' },
                            grid: { color: 'rgba(234, 235, 240, 0.2)' },
                            pointLabels: { color: '#EAEBF0', font: { size: 14 } },
                            ticks: { display: false, beginAtZero: true, max: 100 }
                        }
                    }
                }
            });
        });
    }

    // --- Helper Functions ---
    async function fetchAndSetUser(username) {
        const userRes = await fetchWithCache(`${API_BASE}/user/${username}`);
        if (!userRes || !userRes.user_id) throw new Error('User not found.');
        state.userId = userRes.user_id;
    }
    async function fetchUserLeagues(userId) {
        const currentYear = new Date().getFullYear();
        return await fetchWithCache(`${API_BASE}/user/${userId}/leagues/nfl/${currentYear}`);
    }
    async function fetchSleeperPlayers() {
        try { state.players = await fetchWithCache(`${API_BASE}/players/nfl`); } catch (e) { console.error("Failed to fetch Sleeper players:", e); }
    }
    async function fetchDataFromGoogleSheet() {
        const sheetNames = { oneQb: 'KTC_1QB', sflx: 'KTC_SFLX' };
        try {
            const [oneQbCsv, sflxCsv] = await Promise.all([
                fetch(`https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${sheetNames.oneQb}`).then(res => res.text()),
                fetch(`https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${sheetNames.sflx}`).then(res => res.text())
            ]);
            state.oneQbData = parseSheetData(oneQbCsv);
            state.sflxData = parseSheetData(sflxCsv);
        } catch (e) { console.error("Fatal Error: Could not fetch data from Google Sheet.", e); }
    }
    function parseSheetData(csvText) {
        const dataMap = {};
        const lines = csvText.split(/\r?\n/).slice(1);
        lines.forEach(line => {
            const columns = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
            if (columns.length < 13) return;
            const clean = (str) => str ? str.replace(/"/g, '').trim() : '';
            const pos = clean(columns[2]);
            const sleeperId = clean(columns[12]);
            const ktcValue = parseInt(clean(columns[6]), 10);
            const age = parseFloat(clean(columns[3]));
            if (pos === 'RDP') {
                const pickName = clean(columns[1]);
                if (pickName) dataMap[pickName] = { ktc: ktcValue, age: null };
            } else if (sleeperId && sleeperId !== 'NA') {
                dataMap[sleeperId] = { ktc: isNaN(ktcValue) ? 0 : ktcValue, age: isNaN(age) ? null : age };
            }
        });
        return dataMap;
    }
    function getOwnedPicks(rosterId, tradedPicks, leagueInfo) {
        const defaultRounds = leagueInfo.settings.draft_rounds || 4;
        const leagueSeason = parseInt(leagueInfo.season);
        let ownedPicks = [];
        for (let i = 0; i < 3; i++) {
            const season = leagueSeason + i + 1;
            for (let round = 1; round <= defaultRounds; round++) {
                ownedPicks.push({ season: String(season), round, original_owner_id: rosterId });
            }
        }
        tradedPicks.forEach(pick => {
            if (pick.roster_id === rosterId && pick.owner_id !== rosterId) {
                const i = ownedPicks.findIndex(p => p.season == pick.season && p.round == pick.round && p.original_owner_id == rosterId);
                if (i > -1) ownedPicks.splice(i, 1);
            }
            if (pick.owner_id === rosterId && pick.roster_id !== rosterId) {
                ownedPicks.push({ season: pick.season, round: pick.round, original_owner_id: pick.roster_id });
            }
        });
        return ownedPicks.sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
    }
    function getPlayerData(playerId) {
        const player = state.players[playerId];
        if (!player) return { id: playerId, name: 'Unknown', pos: '?', ktc: 0, age: null };
        const valueData = state.isSuperflex ? state.sflxData[playerId] : state.oneQbData[playerId];
        return {
            id: playerId, name: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
            pos: player.position || '?', ktc: valueData?.ktc || 0, age: valueData?.age || player.age
        };
    }
    function getPickData(pick) {
        const { season, round } = pick;
        const sfx = round === 1 ? 'st' : round === 2 ? 'nd' : round === 3 ? 'rd' : 'th';
        const label = `${season} ${round}${sfx} Pick`;
        const ktcKey = `${season} Mid ${round}${sfx}`;
        const dataSet = state.isSuperflex ? state.sflxData : state.oneQbData;
        return { name: label, ktc: dataSet[ktcKey]?.ktc || 0, pos: 'PICK', age: null };
    }
    function getLineupSlots(rosterPositions) {
        const slots = {}; const counts = {};
        rosterPositions.forEach(pos => {
            const type = ['QB', 'RB', 'WR', 'TE'].includes(pos) ? 'POSITION' : (pos === 'FLEX' ? 'FLEX' : 'SUPER_FLEX');
            if (type !== 'POSITION' && type !== 'FLEX' && type !== 'SUPER_FLEX') return;
            counts[pos] = (counts[pos] || 0) + 1;
            slots[`${pos}${counts[pos]}`] = { pos, type };
        });
        return slots;
    }
    function assignStartersToSlots(starters, lineupSlots) {
        const assigned = {}; let unassigned = [...starters].sort((a,b) => b.ktc - a.ktc);
        Object.keys(lineupSlots).forEach(slot => {
            const { pos, type } = lineupSlots[slot];
            let playerIndex = -1;
            if (type === 'POSITION') playerIndex = unassigned.findIndex(p => p.pos === pos);
            else if (type === 'FLEX') playerIndex = unassigned.findIndex(p => ['RB', 'WR', 'TE'].includes(p.pos));
            else if (type === 'SUPER_FLEX') playerIndex = unassigned.findIndex(p => ['QB', 'RB', 'WR', 'TE'].includes(p.pos));
            if (playerIndex > -1) {
                assigned[slot] = unassigned[playerIndex];
                unassigned.splice(playerIndex, 1);
            }
        });
        return assigned;
    }
    function populateLeagueSelect(leagues) {
        leagueSelect.innerHTML = '<option value="">Select a League...</option>';
        if (leagues.length === 0) {
            leagueSelect.innerHTML = '<option>No leagues found</option>';
            leagueSelect.disabled = true; return;
        }
        leagues.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.league_id; opt.textContent = l.name;
            leagueSelect.appendChild(opt);
        });
        leagueSelect.disabled = false;
    }
    function setLoading(isLoading, message = 'Loading...') {
        loadingText.textContent = message;
        loadingOverlay.classList.toggle('visible', isLoading);
    }
    function handleError(error) {
        welcomeScreen.classList.remove('hidden');
        dashboardContainer.classList.add('hidden');
        welcomeScreen.innerHTML = `<h2 style="color: #FF47A6;">Error</h2><p>${error.message}</p>`;
    }
    async function fetchWithCache(url) {
        const cacheKey = `cache_${url}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const { timestamp, data } = JSON.parse(cached);
            if (Date.now() - timestamp < 5 * 60 * 1000) return data;
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
        const data = await response.json();
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
        return data;
    }
});
