document.addEventListener('DOMContentLoaded', async () => {
    // --- DOM Elements ---
    const usernameInput = document.getElementById('usernameInput');
    const leagueSelect = document.getElementById('leagueSelect');
    const fetchButton = document.getElementById('fetchButton');
    const loadingIndicator = document.getElementById('loading');
    const welcomeScreen = document.getElementById('welcome-screen');
    const infographicContainer = document.getElementById('infographic-container');
    const totalValueChartCanvas = document.getElementById('totalValueChart').getContext('2d');
    const starterValueChartCanvas = document.getElementById('starterValueChart').getContext('2d');
    const positionalRanksContainer = document.getElementById('positional-ranks-container');
    const teamTiersContainer = document.getElementById('team-tiers-container');
    const teamDnaContainer = document.getElementById('team-dna-container');
    const viewToggle = document.getElementById('viewToggle');

    // --- State ---
    const state = {
        userId: null, leagues: [], players: {}, oneQbData: {}, sflxData: {},
        currentLeagueId: null, isSuperflex: false, cache: {}, charts: {},
        currentTeams: [], currentView: 'value' // 'value' or 'rank'
    };

    // --- Constants ---
    const API_BASE = 'https://api.sleeper.app/v1';
    const GOOGLE_SHEET_ID = '1MDTf1IouUIrm4qabQT9E5T0FsJhQtmaX55P32XK5c_0';
    const POS_COLORS = { /* ... */ };

    // --- Initialization & Event Listeners ---
    setLoading(true, 'Loading KTC data...');
    await Promise.all([fetchSleeperPlayers(), fetchDataFromGoogleSheet()]);
    setLoading(false);

    fetchButton.addEventListener('click', handleFetch);
    leagueSelect.addEventListener('change', handleLeagueSelect);
    viewToggle.addEventListener('change', handleViewToggle);

    // --- Main Handlers ---
    async function handleFetch() {
        const username = usernameInput.value.trim();
        if (!username) return;
        setLoading(true, 'Fetching user leagues...');
        try {
            await fetchAndSetUser(username);
            state.leagues = await fetchUserLeagues(state.userId);
            state.leagues.sort((a, b) => a.name.localeCompare(b.name));
            populateLeagueSelect(state.leagues);
            if (state.leagues.length > 0) await handleLeagueSelect();
            else handleError({ message: 'No leagues found for this user.' }, username);
        } catch (error) {
            handleError(error, username);
        } finally {
            setLoading(false);
        }
    }

    async function handleLeagueSelect() {
        const leagueId = leagueSelect.value;
        if (!leagueId) return;
        state.currentLeagueId = leagueId;
        const leagueInfo = state.leagues.find(l => l.league_id === leagueId);
        setLoading(true, `Analyzing ${leagueInfo?.name || 'league'}...`);
        try {
            const rosterPositions = leagueInfo.roster_positions;
            state.isSuperflex = rosterPositions.includes('SUPER_FLEX') || rosterPositions.filter(p => p === 'QB').length > 1;
            const [rosters, users, tradedPicks] = await Promise.all([
                fetchWithCache(`${API_BASE}/league/${leagueId}/rosters`),
                fetchWithCache(`${API_BASE}/league/${leagueId}/users`),
                fetchWithCache(`${API_BASE}/league/${leagueId}/traded_picks`),
            ]);
            state.currentTeams = processTeamData(rosters, users, tradedPicks, leagueInfo);
            renderInfographic(state.currentTeams, leagueInfo);
            infographicContainer.classList.remove('hidden');
            welcomeScreen.classList.add('hidden');
        } catch (error) {
            handleError(error, `league ${leagueId}`);
        } finally {
            setLoading(false);
        }
    }

    function handleViewToggle() {
        state.currentView = viewToggle.checked ? 'rank' : 'value';
        const leagueInfo = state.leagues.find(l => l.league_id === state.currentLeagueId);
        renderPositionalRanks(state.currentTeams, leagueInfo);
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
            team.averageStarterAge = team.starters.length > 0 ? team.starters.reduce((sum, p) => sum + (p.age || 25), 0) / team.starters.length : 30;

            return team;
        });

        // Calculate Tiers and Positional Scores after all teams are processed
        calculateTeamTiers(teams);
        calculatePositionalScores(teams);
        return teams;
    }

    function calculateTeamTiers(teams) {
        const valueScores = teams.map(t => t.starterValue);
        const maxVal = Math.max(...valueScores);
        const minVal = Math.min(...valueScores);

        teams.forEach(team => {
            const valueScore = (team.starterValue - minVal) / (maxVal - minVal);
            if (valueScore > 0.65 && team.averageStarterAge < 28) team.tier = 'Contender';
            else if (valueScore < 0.4 && team.draftCapitalValue > 5000) team.tier = 'Rebuilder';
            else team.tier = 'Pretender';
        });
    }

    function calculatePositionalScores(teams) {
        ['QB', 'RB', 'WR', 'TE'].forEach(pos => {
            const posValues = teams.map(t => t.starters.filter(p => p.pos === pos).reduce((sum, p) => sum + p.ktc, 0));
            const maxPosVal = Math.max(...posValues);
            teams.forEach((team, i) => {
                team.positionalScores = team.positionalScores || {};
                team.positionalScores[pos] = maxPosVal > 0 ? (posValues[i] / maxPosVal) * 100 : 0;
            });
        });
    }

    // --- Rendering ---
    function renderInfographic(teams, leagueInfo) {
        renderTeamTiers(teams.slice().sort((a,b) => b.totalValue - a.totalValue));
        renderBarChart('totalValue', totalValueChartCanvas, teams, 'totalValue', 'Overall Team Value');
        renderBarChart('starterValue', starterValueChartCanvas, teams.slice().sort((a, b) => b.starterValue - a.starterValue), 'starterValue', 'Starter Value');
        renderPositionalRanks(teams, leagueInfo);
        renderTeamDna(teams);
    }

    function renderTeamTiers(teams) {
        teamTiersContainer.innerHTML = '<h3>Team Tiers</h3>';
        teams.forEach(team => {
            const row = document.createElement('div');
            row.className = 'tier-row';
            row.innerHTML = `<div class="tier-badge ${team.tier.toLowerCase()}">${team.tier}</div><div class="team-name">${team.teamName}</div>`;
            teamTiersContainer.appendChild(row);
        });
    }

    // --- FULL IMPLEMENTATIONS ---
    function renderBarChart(chartId, canvas, teams, valueKey, label) {
        if (state.charts[chartId]) state.charts[chartId].destroy();
        state.charts[chartId] = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: teams.map(t => t.teamName),
                datasets: [{
                    label: label,
                    data: teams.map(t => t[valueKey]),
                    backgroundColor: teams.map(t => t.isUserTeam ? 'rgba(118, 109, 255, 0.8)' : 'rgba(144, 150, 192, 0.5)'),
                    borderColor: teams.map(t => t.isUserTeam ? '#fff' : 'rgba(144, 150, 192, 1)'),
                    borderWidth: 1
                }]
            },
            options: { /* Chart options */ }
        });
    }

    function renderPositionalRanks(teams, leagueInfo) {
        positionalRanksContainer.innerHTML = '';
        const lineupSlots = getLineupSlots(leagueInfo.roster_positions);
        for (const slot in lineupSlots) {
            const card = document.createElement('div');
            card.className = 'position-card';
            const title = document.createElement('h3');
            title.textContent = slot;
            card.appendChild(title);

            const rankedTeams = teams.map(team => ({
                teamName: team.teamName,
                isUserTeam: team.isUserTeam,
                player: team.startersBySlot[slot] || { name: 'Empty', ktc: 0 }
            })).sort((a, b) => b.player.ktc - a.player.ktc);

            rankedTeams.forEach((team, index) => {
                const row = document.createElement('div');
                row.className = 'team-rank-row';
                if (team.isUserTeam) row.classList.add('is-user');
                const displayValue = state.currentView === 'value' ? `KTC: ${team.player.ktc}` : `#${index + 1}`;
                row.innerHTML = `<div class="rank">#${index + 1}</div>
                                 <div class="team-name">${team.teamName}</div>
                                 <div class="player-info">
                                     <div class="player-name">${team.player.name}</div>
                                     <div class="player-ktc">${state.currentView === 'value' ? `KTC: ${team.player.ktc}` : ''}</div>
                                 </div>
                                 <div class="position-rank">${state.currentView === 'rank' ? `#${index + 1}` : ''}</div>`;
                card.appendChild(row);
            });
            positionalRanksContainer.appendChild(card);
        }
    }

    function renderTeamDna(teams) {
        teamDnaContainer.innerHTML = '';
        teams.forEach(team => {
            const wrapper = document.createElement('div');
            wrapper.className = 'radar-chart-wrapper';
            const title = document.createElement('h4');
            title.textContent = team.teamName;
            const canvas = document.createElement('canvas');
            wrapper.appendChild(title);
            wrapper.appendChild(canvas);
            teamDnaContainer.appendChild(wrapper);

            new Chart(canvas.getContext('2d'), {
                type: 'radar',
                data: {
                    labels: ['QB', 'RB', 'WR', 'TE'],
                    datasets: [{
                        label: 'Positional Strength',
                        data: Object.values(team.positionalScores),
                        backgroundColor: 'rgba(66, 194, 255, 0.2)',
                        borderColor: 'rgba(66, 194, 255, 1)',
                        borderWidth: 2
                    }]
                },
                options: { /* Radar chart options */ }
            });
        });
    }

    // --- FULL HELPER IMPLEMENTATIONS ---
    // (pasting all the helper functions again)
    async function fetchAndSetUser(username) {
        const userRes = await fetchWithCache(`${API_BASE}/user/${username}`);
        if (!userRes || !userRes.user_id) throw new Error('User not found.');
        state.userId = userRes.user_id;
    }
    async function fetchUserLeagues(userId) {
        const currentYear = new Date().getFullYear();
        return await fetchWithCache(`${API_BASE}/user/${userId}/leagues/nfl/${currentYear}`) || [];
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
        const label = `${season} ${round}${sfx} Round Pick`;
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
        leagueSelect.innerHTML = '';
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
        if (isLoading) {
            welcomeScreen.classList.add('hidden');
            infographicContainer.classList.add('hidden');
            loadingIndicator.innerHTML = `<div class="spinner"></div><p>${message}</p>`;
            loadingIndicator.classList.remove('hidden');
            fetchButton.disabled = true;
        } else {
            loadingIndicator.classList.add('hidden');
            fetchButton.disabled = false;
        }
    }
    function handleError(error, context) {
        console.error(`Error for ${context}:`, error);
        loadingIndicator.classList.add('hidden');
        welcomeScreen.classList.remove('hidden');
        infographicContainer.classList.add('hidden');
        welcomeScreen.innerHTML = `<h2 style="color: #FF47A6;">Error</h2><p>Could not fetch data for ${context}.</p><p style="font-size: 0.9rem; color: var(--color-text-tertiary);">${error.message}</p>`;
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
