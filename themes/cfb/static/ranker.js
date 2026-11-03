// Head-to-head ranker. The page embeds every FBS team's record and per-play
// numbers plus the latest AP and Coaches polls at build time; this script
// deals out matchups, builds your top 24 from the picks, and compares it
// with the poll at the end.
//
// Two modes share everything below (set by data-mode on [data-ranker]):
//   normal - teams show by name; the pool starts in poll order
//   blind  - each matchup shows "Team A" and "Team B" with stats, record and
//            a margin tier for any meeting; the pool comes from the stats
//            (no polls) and starts shuffled; names are revealed at the end
(() => {
  "use strict";

  const rankerElement = document.querySelector("[data-ranker]");
  const dataElement = document.getElementById("head-to-head-data");
  if (!rankerElement || !dataElement) return;
  const pageData = JSON.parse(dataElement.textContent);
  const isBlind = rankerElement.dataset.mode === "blind";

  const rankedCount = 24;

  // ---------- Stat ranks across FBS ----------

  const statNames = ["yardsPerPlay", "rushYardsPerCarry", "passYardsPerAttempt"];
  // Offense is better when higher; defense (yards allowed) when lower.
  const sideIsBetterWhenHigher = { offense: true, defense: false };

  // Competition ranking (1, 2, 2, 4); a missing value ranks last.
  function rankBySchool(teams, side, statName) {
    const higherIsBetter = sideIsBetterWhenHigher[side];
    const withValues = teams.filter((team) => typeof team[side]?.[statName] === "number");
    const sorted = [...withValues].sort((first, second) => higherIsBetter
      ? second[side][statName] - first[side][statName]
      : first[side][statName] - second[side][statName]);
    const ranks = new Map();
    sorted.forEach((team, index) => {
      const previous = sorted[index - 1];
      const tiesPrevious = previous && previous[side][statName] === team[side][statName];
      ranks.set(team.school, tiesPrevious ? ranks.get(previous.school) : index + 1);
    });
    for (const team of teams) {
      if (!ranks.has(team.school)) ranks.set(team.school, teams.length);
    }
    return ranks;
  }

  function averageOf(numbers) {
    return numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
  }

  // ---------- Team accent colour: team colour, else alternate, else site ink ----------

  const paperColor = "#EFE5CC";
  const inkColor = "#231C16";
  const minimumAccentContrast = 3; // WCAG minimum for non-text graphics

  function normalizedHex(color) {
    if (typeof color !== "string") return null;
    const hex = color.trim().replace(/^#?/, "#");
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
  }

  function relativeLuminance(hexColor) {
    const channels = hexColor.slice(1).match(/../g).map((pair) => parseInt(pair, 16) / 255);
    const [red, green, blue] = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  function contrastRatio(firstColor, secondColor) {
    const [lighter, darker] = [relativeLuminance(firstColor), relativeLuminance(secondColor)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function readableAccentColor(team) {
    const candidates = [team.color, team.alternateColor].map(normalizedHex).filter(Boolean);
    return candidates.find((color) => contrastRatio(color, paperColor) >= minimumAccentContrast) ?? inkColor;
  }

  // ---------- Teams ----------

  const statRanks = {};
  for (const side of Object.keys(sideIsBetterWhenHigher)) {
    statRanks[side] = {};
    for (const statName of statNames) statRanks[side][statName] = rankBySchool(pageData.teams, side, statName);
  }

  const teams = pageData.teams.map((team) => {
    const ranks = { offense: {}, defense: {} };
    for (const side of Object.keys(ranks)) {
      for (const statName of statNames) ranks[side][statName] = statRanks[side][statName].get(team.school);
    }
    const averageStatRank = averageOf([...Object.values(ranks.offense), ...Object.values(ranks.defense)]);
    return { ...team, ranks, averageStatRank, accentColor: readableAccentColor(team) };
  });
  const teamBySchool = new Map(teams.map((team) => [team.school, team]));
  const fbsTeamCount = teams.length;

  // ---------- Pool ----------
  // Normal: the AP and Coaches top 25s, ordered by their average rank.
  // Blind: no polls at all. Every team in the top N for yards per play on
  // offense or defense, and .500 or better once it has played enough games
  // (rules from blind-field.html / hugo.toml).

  const unrankedSpot = 26; // a team in only one poll counts as just outside the other
  const apRankBySchool = new Map(pageData.seedPolls.ap.map((entry) => [entry.school, entry.rank]));
  const coachesRankBySchool = new Map(pageData.seedPolls.coaches.map((entry) => [entry.school, entry.rank]));

  function pollSeed(school) {
    if (!apRankBySchool.has(school) && !coachesRankBySchool.has(school)) return Infinity; // added by hand
    return averageOf([apRankBySchool.get(school) ?? unrankedSpot, coachesRankBySchool.get(school) ?? unrankedSpot]);
  }

  function isInBlindField(team) {
    const { statRankCutoff, recordRuleMinimumGames } = pageData.blindField;
    const madeStatCut = Math.min(team.ranks.offense.yardsPerPlay, team.ranks.defense.yardsPerPlay) <= statRankCutoff;
    const gamesPlayed = team.wins + team.losses;
    const meetsRecordRule = gamesPlayed < recordRuleMinimumGames || team.wins >= team.losses;
    return madeStatCut && meetsRecordRule;
  }

  const poolSchools = isBlind
    ? teams.filter(isInBlindField).map((team) => team.school).sort((first, second) => first.localeCompare(second))
    : [...new Set([...apRankBySchool.keys(), ...coachesRankBySchool.keys()])]
      .filter((school) => teamBySchool.has(school))
      .sort((first, second) => pollSeed(first) - pollSeed(second)
        || teamBySchool.get(first).averageStatRank - teamBySchool.get(second).averageStatRank
        || first.localeCompare(second));

  // ---------- Meetings this season ----------

  function pairKey(firstSchool, secondSchool) {
    return [firstSchool, secondSchool].sort().join("\u0000");
  }

  const meetingsByPair = new Map();
  for (const game of pageData.meetings) {
    const key = pairKey(game.homeTeam, game.awayTeam);
    if (!meetingsByPair.has(key)) meetingsByPair.set(key, []);
    meetingsByPair.get(key).push(game); // already oldest first
  }

  function seasonMeetings(firstSchool, secondSchool) {
    return meetingsByPair.get(pairKey(firstSchool, secondSchool)) ?? [];
  }

  function meetingResult(game) {
    const homeWon = game.homePoints > game.awayPoints;
    const [winner, winnerPoints, loser, loserPoints] = homeWon
      ? [game.homeTeam, game.homePoints, game.awayTeam, game.awayPoints]
      : [game.awayTeam, game.awayPoints, game.homeTeam, game.homePoints];
    const weekLabel = game.seasonType === "postseason" ? "Postseason" : `Week ${game.week}`;
    return { winner, winnerPoints, loser, loserPoints, margin: winnerPoints - loserPoints, weekLabel };
  }

  // ---------- Poor man's strength of schedule: opponents' combined record ----------
  //
  // For each FBS opponent faced (once per meeting), add its record with the
  // games against this team taken out, so a team's own wins don't drag its
  // opponents down. FCS opponents' full records aren't in the data, so they're
  // only counted.

  const gamesBySchool = new Map();
  for (const game of pageData.meetings) {
    for (const school of [game.homeTeam, game.awayTeam]) {
      if (!gamesBySchool.has(school)) gamesBySchool.set(school, []);
      gamesBySchool.get(school).push(game);
    }
  }

  function opponentsRecord(team) {
    let wins = 0;
    let losses = 0;
    const fbsGames = gamesBySchool.get(team.school) ?? [];
    for (const game of fbsGames) {
      const opponentSchool = game.homeTeam === team.school ? game.awayTeam : game.homeTeam;
      const opponent = teamBySchool.get(opponentSchool);
      if (!opponent) continue;
      const gamesBetween = seasonMeetings(team.school, opponentSchool);
      const opponentWinsBetween = gamesBetween.filter((between) => meetingResult(between).winner === opponentSchool).length;
      wins += opponent.wins - opponentWinsBetween;
      losses += opponent.losses - (gamesBetween.length - opponentWinsBetween);
    }
    const fcsGames = Math.max(0, team.wins + team.losses - fbsGames.length);
    const winShare = wins + losses ? wins / (wins + losses) : null;
    return { wins, losses, winShare, fcsGames };
  }

  // Ranked across FBS: #1 is the toughest schedule (best opponents' win share).
  const scheduleBySchool = new Map(teams.map((team) => [team.school, opponentsRecord(team)]));
  {
    const byToughness = [...scheduleBySchool].filter(([, schedule]) => schedule.winShare !== null)
      .sort(([, first], [, second]) => second.winShare - first.winShare);
    byToughness.forEach(([school, schedule], index) => {
      const previous = byToughness[index - 1];
      schedule.rank = previous && previous[1].winShare === schedule.winShare ? previous[1].rank : index + 1;
    });
    for (const schedule of scheduleBySchool.values()) schedule.rank ??= fbsTeamCount;
  }

  // ---------- Poll to compare against at the end ----------

  const comparisonPoll = {
    label: pageData.poll.label,
    ranks: Object.fromEntries(pageData.poll.ranks.map((entry) => [entry.school, entry.rank])),
  };

  // ---------- Building the top 24 from picks ----------
  //
  // Teams arrive one at a time (normal: poll order; blind: shuffled). Each is
  // compared against teams already placed until its spot is pinned down:
  // first where it's expected to land (normal: its poll spot; blind: the
  // middle), then galloping outward 1, 2, 4… spots, then halving. Once 24
  // teams are placed, a newcomer first faces your #24: lose and it's out
  // after one pick; win and it's placed while the old #24 drops out.

  const storageKey = `head-to-head-${pageData.seasonYear}-${isBlind ? "blind" : "normal"}`;
  const maximumUndoSteps = 50;
  const poolSignature = [...poolSchools].sort().join("|");

  // How sure the pick was. "close" says it's a coin flip; "easily" says the teams are far apart.
  const pickStrengths = {
    close: { label: "Close", description: "narrowly beats" },
    wins: { label: "Wins", description: "beats" },
    easily: { label: "Easily", description: "easily beats" },
  };

  let sortState;
  let undoHistory;

  function shuffled(list) {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  }

  function freshSortState() {
    const queue = isBlind ? shuffled(poolSchools) : [...poolSchools];
    const state = { placed: [queue.shift()], cut: [], waiting: queue, added: [], candidate: null, picks: 0 };
    takeNextCandidate(state);
    return state;
  }

  // Normal mode: below every placed team with a better poll average. Blind: the middle.
  function expectedIndex(state, school) {
    if (isBlind) return Math.floor(state.placed.length / 2);
    const seed = pollSeed(school);
    return state.placed.filter((placedSchool) => pollSeed(placedSchool) <= seed).length;
  }

  function takeNextCandidate(state) {
    state.candidate = state.waiting.shift() ?? null;
    state.low = 0;
    state.high = state.placed.length;
    state.gallop = null;
    state.halving = false;
    state.facingCut = false;
    state.probe = null;
    if (!state.candidate) return;
    if (state.placed.length >= rankedCount) {
      state.facingCut = true;
      state.probe = rankedCount - 1;
    } else {
      state.probe = Math.min(expectedIndex(state, state.candidate), state.placed.length - 1);
    }
  }

  // The placed team the candidate faces next: the gallop probe while it's in range, else the midpoint.
  function opponentIndex() {
    const { probe, low, high } = sortState;
    if (probe !== null && probe >= low && probe < high) return probe;
    return Math.floor((low + high) / 2);
  }

  // Gallop outward, doubling each step (quadrupling after "easily", since the
  // teams are far apart). Once a pick goes the other way the spot is
  // bracketed and the search halves from then on.
  function chooseNextProbe(comparedIndex, candidateWins, strength) {
    if (sortState.facingCut) {
      // Beat the #24: start the real search where the team is expected to land.
      sortState.facingCut = false;
      sortState.probe = Math.min(expectedIndex(sortState, sortState.candidate), sortState.high - 1);
      return;
    }
    if (sortState.halving) return;
    const direction = candidateWins ? "up" : "down";
    const { gallop } = sortState;
    if (gallop && gallop.direction !== direction) {
      sortState.halving = true;
      sortState.gallop = null;
      sortState.probe = null;
      return;
    }
    const growth = strength === "easily" ? 4 : 2;
    const step = gallop ? gallop.step * growth : growth / 2;
    sortState.gallop = { direction, step };
    const nextProbe = candidateWins ? comparedIndex - step : comparedIndex + step;
    sortState.probe = Math.min(Math.max(nextProbe, sortState.low), sortState.high - 1);
  }

  function rememberForUndo() {
    undoHistory.push(structuredClone(sortState));
    if (undoHistory.length > maximumUndoSteps) undoHistory.shift();
  }

  function recordPick(candidateWins, strength = "wins") {
    rememberForUndo();
    const comparedIndex = opponentIndex();
    sortState.picks += 1;

    if (strength === "close") {
      // Close enough to call it a coin flip: settle the team right beside this opponent.
      sortState.low = sortState.high = candidateWins ? comparedIndex : comparedIndex + 1;
    } else if (candidateWins) {
      sortState.high = comparedIndex;
    } else {
      sortState.low = comparedIndex + 1;
    }

    if (sortState.low === sortState.high) {
      sortState.placed.splice(sortState.low, 0, sortState.candidate);
      // Only the top 24 are kept in order; whoever falls to #25 is out.
      if (sortState.placed.length > rankedCount) sortState.cut.push(sortState.placed.pop());
      takeNextCandidate(sortState);
    } else {
      chooseNextProbe(comparedIndex, candidateWins, strength);
    }
    saveProgress();
    render();
  }

  // Normal mode only: bring in a team from outside the two polls.
  function addTeam(school) {
    if (!teamBySchool.has(school) || isInPlay(school)) return;
    rememberForUndo();
    sortState.added.push(school);
    sortState.waiting.push(school);
    if (!sortState.candidate) takeNextCandidate(sortState);
    saveProgress();
    render();
  }

  function isInPlay(school) {
    return poolSchools.includes(school) || sortState.added.includes(school);
  }

  function undoPick() {
    if (!undoHistory.length) return;
    sortState = undoHistory.pop();
    saveProgress();
    render();
  }

  // Starting over is itself undoable, so a stray click can't wipe out a run.
  function startOver() {
    if (sortState.picks === 0 && !sortState.added.length) return;
    rememberForUndo();
    sortState = freshSortState();
    saveProgress();
    render();
  }

  // A rough count. Normal: about two picks per team when you agree with the polls.
  // Blind: a search through the list as it grows (plus a half pick for the
  // gallop); once it's full, one pick against #24 and a search only for
  // newcomers that get in (about 24 in every teams-seen-so-far). Within a few
  // percent of simulated runs for fields of 27 to 55.
  function expectedPicksLeft() {
    if (!sortState.candidate) return 0;
    const teamsLeft = sortState.waiting.length + 1;
    if (!isBlind) return teamsLeft * 2;
    let teamsSeen = sortState.placed.length + sortState.cut.length;
    let picksLeft = 0;
    for (let team = 0; team < teamsLeft; team += 1) {
      const searchPicks = Math.log2(Math.min(teamsSeen, rankedCount) + 1) + 0.5;
      picksLeft += teamsSeen >= rankedCount ? 1 + searchPicks * rankedCount / (teamsSeen + 1) : searchPicks;
      teamsSeen += 1;
    }
    return Math.ceil(picksLeft);
  }

  // ---------- Saved progress (this browser only) ----------

  function saveProgress() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ poolSignature, sortState, undoHistory }));
    } catch (storageError) {
      // Storage unavailable: progress just won't survive a reload.
    }
  }

  // Saved progress is reused only while the pool is unchanged (new polls, or new stats in blind).
  function loadProgress() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      const stillValid = saved?.poolSignature === poolSignature && saved.sortState
        && (saved.sortState.added ?? []).every((school) => teamBySchool.has(school));
      if (stillValid) {
        return { savedSortState: saved.sortState, savedUndoHistory: Array.isArray(saved.undoHistory) ? saved.undoHistory : [] };
      }
    } catch (storageError) {
      // Storage unavailable or corrupt: start fresh.
    }
    return null;
  }

  // ---------- Names: real, or a dealt code in blind mode ----------

  // In blind mode the left card is always "Team A" and the right "Team B";
  // the labels belong to the matchup on screen, not to the team.
  let blindLabelBySchool = new Map();

  function shownName(school) {
    return isBlind ? blindLabelBySchool.get(school) : school;
  }

  // ---------- Prize rosette for the team that won the meeting ----------

  // Margin tiers in possessions: a touchdown plus two-point try is 8 points.
  const awardTiers = [
    { className: "is-one-score", verb: "Edged", phrase: "one score", maximumMargin: 8, keyLabel: "One score · 1–8" },
    { className: "is-two-score", verb: "Beat", phrase: "two scores", maximumMargin: 16, keyLabel: "Two scores · 9–16" },
    { className: "is-blowout", verb: "Routed", phrase: "three or more scores", maximumMargin: Infinity, keyLabel: "Three+ scores · 17+" },
  ];

  function awardTierFor(margin) {
    return awardTiers.find((tier) => margin <= tier.maximumMargin);
  }

  // Scalloped rosette edge: alternating outer/inner points around the centre.
  const rosettePetalPoints = Array.from({ length: 48 }, (_, pointIndex) => {
    const angle = (pointIndex / 48) * Math.PI * 2;
    const radius = pointIndex % 2 === 0 ? 49 : 43;
    return `${(50 + radius * Math.sin(angle)).toFixed(1)},${(50 - radius * Math.cos(angle)).toFixed(1)}`;
  }).join(" ");

  // The tier shows through size and colour; the margin is printed except in
  // blind mode, where an exact score would give teams away.
  function awardMarkup(tier, margin, ariaLabel) {
    const star = tier.className === "is-blowout"
      ? `<polygon class="award-star" points="50,3 52.6,9.4 59.4,9.4 54,13.6 56,20 50,16.2 44,20 46,13.6 40.6,9.4 47.4,9.4"/>`
      : "";
    const marginText = isBlind ? "" : `<b>+${margin}</b>`;
    return `<div class="award ${tier.className}" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <svg viewBox="0 0 100 130" aria-hidden="true">
        <polygon class="award-tail" points="30,70 46,76 38,128 30,118 21,124"/>
        <polygon class="award-tail" points="70,70 54,76 62,128 70,118 79,124"/>
        <polygon class="award-petals" points="${rosettePetalPoints}"/>
        <circle class="award-center" cx="50" cy="50" r="35"/>
        <circle class="award-ring" cx="50" cy="50" r="30"/>
        ${star}
      </svg>
      <span class="award-text" aria-hidden="true" data-margin-digits="${String(margin).length}">${marginText}</span>
    </div>`;
  }

  // The rosette goes only on the card of the team that won the most recent meeting.
  function contenderAward(team, opponent) {
    const meetings = seasonMeetings(team.school, opponent.school);
    if (!meetings.length) return "";
    const result = meetingResult(meetings[meetings.length - 1]);
    if (result.winner !== team.school || result.margin <= 0) return "";
    const tier = awardTierFor(result.margin);
    const ariaLabel = isBlind
      ? `${tier.verb} ${shownName(opponent.school)} by ${tier.phrase}`
      : `${tier.verb} ${opponent.school} by ${result.margin}, ${result.weekLabel}`;
    return awardMarkup(tier, result.margin, ariaLabel);
  }

  function renderAwardKey() {
    const sampleMargins = [3, 13, 24];
    document.querySelector("[data-award-key]").innerHTML =
      `<span class="award-key-title">Head-to-head ribbons</span>` +
      awardTiers.map((tier, tierIndex) => `<div class="award-key-item">
        ${awardMarkup(tier, sampleMargins[tierIndex], `${tier.verb}: ${tier.keyLabel} points`)}
        <span>${tier.keyLabel}</span>
      </div>`).join("");
  }

  // ---------- Rendering ----------

  let activePair = null; // the pair on screen, for keyboard picks
  const leftCard = document.querySelector('[data-contender="left"]');
  const rightCard = document.querySelector('[data-contender="right"]');

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  }

  function formatRate(value) {
    return typeof value === "number" ? value.toFixed(1) : "—";
  }

  function rankCell(rank) {
    const quality = rank <= 25 ? " is-elite" : rank > fbsTeamCount - 36 ? " is-poor" : "";
    return `<td class="tape-rank${quality}">#${rank}</td>`;
  }

  function tapeTable(team, side) {
    const isDefense = side === "defense";
    const suffix = isDefense ? " allowed" : "";
    const stats = team[side] ?? {};
    const ranks = team.ranks[side];
    return `
      <table class="tape${isDefense ? " is-defense" : ""}">
        <caption>${isDefense ? "Defense" : "Offense"}</caption>
        <tbody>
          <tr><th scope="row">Yards / play${suffix}</th><td>${formatRate(stats.yardsPerPlay)}</td>${rankCell(ranks.yardsPerPlay)}</tr>
          <tr class="tape-sub"><th scope="row">Rush yds / carry</th><td>${formatRate(stats.rushYardsPerCarry)}</td>${rankCell(ranks.rushYardsPerCarry)}</tr>
          <tr class="tape-sub"><th scope="row">Pass yds / attempt</th><td>${formatRate(stats.passYardsPerAttempt)}</td>${rankCell(ranks.passYardsPerAttempt)}</tr>
        </tbody>
      </table>`;
  }

  function pickLabel(team, opponent, strength) {
    return `${shownName(team.school)} ${pickStrengths[strength].description} ${shownName(opponent.school)}`;
  }

  function strengthButton(team, opponent, strength) {
    return `<button class="contender-strength" type="button" data-strength="${strength}"
      aria-label="${escapeHtml(pickLabel(team, opponent, strength))}">${pickStrengths[strength].label}</button>`;
  }

  // e.g. "Opponents 34–28 · .548 · #40 · +1 FCS"
  function scheduleLine(team) {
    const schedule = scheduleBySchool.get(team.school);
    const share = schedule.winShare === null ? "—" : schedule.winShare.toFixed(3).replace(/^0/, "");
    const fcs = schedule.fcsGames ? ` · +${schedule.fcsGames} FCS` : "";
    const quality = schedule.rank <= 25 ? " is-elite" : schedule.rank > fbsTeamCount - 36 ? " is-poor" : "";
    return `<span class="contender-schedule">Opponents ${schedule.wins}–${schedule.losses} · ${share} · <b class="schedule-rank${quality}">#${schedule.rank}</b>${fcs}</span>`;
  }

  function contenderMarkup(team, opponent, keyHint) {
    const conference = isBlind ? "Conference hidden" : team.conference ?? "";
    return `
      ${contenderAward(team, opponent)}
      <div class="contender-head">
        <span class="contender-name">${escapeHtml(shownName(team.school))}</span>
        <span class="contender-conf">${escapeHtml(conference)}</span>
        <span class="contender-record">${team.wins}–${team.losses}<small>RECORD</small></span>
        ${scheduleLine(team)}
        <span class="contender-average">Avg stat rank <b>${team.averageStatRank.toFixed(1)}</b></span>
      </div>
      ${tapeTable(team, "offense")}
      ${tapeTable(team, "defense")}
      <div class="contender-picks">
        ${strengthButton(team, opponent, "close")}
        <button class="contender-pick" type="button" data-strength="wins"
          aria-label="${escapeHtml(pickLabel(team, opponent, "wins"))}">${pickStrengths.wins.label}<span class="contender-key">${keyHint}</span></button>
        ${strengthButton(team, opponent, "easily")}
      </div>`;
  }

  // Compare one team's offense with the other's defense, run and pass.
  function edgeLabel(offenseTeam, defenseTeam, statName) {
    const offenseRank = offenseTeam.ranks.offense[statName];
    const defenseRank = defenseTeam.ranks.defense[statName];
    const evenMargin = 10;
    if (Math.abs(offenseRank - defenseRank) <= evenMargin) return `<span class="matchup-edge is-even">Even</span>`;
    return offenseRank < defenseRank
      ? `<span class="matchup-edge is-offense">Edge ${escapeHtml(shownName(offenseTeam.school))}</span>`
      : `<span class="matchup-edge is-defense">Edge ${escapeHtml(shownName(defenseTeam.school))}</span>`;
  }

  function possessionMarkup(offenseTeam, defenseTeam) {
    const rows = [["Run", "rushYardsPerCarry"], ["Pass", "passYardsPerAttempt"]].map(([kind, statName]) => `
      <div class="matchup-row">
        <span class="matchup-kind">${kind}</span>
        <span class="matchup-vs">#${offenseTeam.ranks.offense[statName]} off vs #${defenseTeam.ranks.defense[statName]} def</span>
        ${edgeLabel(offenseTeam, defenseTeam, statName)}
      </div>`).join("");
    return `<div class="matchup-half"><span class="matchup-title">When ${escapeHtml(shownName(offenseTeam.school))} has the ball</span>${rows}</div>`;
  }

  // Blind mode keeps only who won and by how many scores: no score, week or site.
  function meetingMarkup(firstTeam, secondTeam) {
    const meetings = seasonMeetings(firstTeam.school, secondTeam.school);
    if (!meetings.length) return `<span class="meeting-none">Haven’t met this season</span>`;
    const results = meetings.map((game) => {
      const result = meetingResult(game);
      if (isBlind) {
        return `<span class="meeting-result"><b>${escapeHtml(shownName(result.winner))}</b> won by ${awardTierFor(result.margin).phrase}</span>`;
      }
      const site = game.neutralSite ? "neutral site" : `at ${escapeHtml(game.homeTeam)}`;
      return `<span class="meeting-result">${result.weekLabel} · <b>${escapeHtml(result.winner)} ${result.winnerPoints}</b>, ${escapeHtml(result.loser)} ${result.loserPoints} · ${site}</span>`;
    });
    return `<span class="stamp is-notes">Already met</span>${results.join("")}`;
  }

  // Each pairing always shows the same team on the left, even after a reload.
  function candidateGoesLeft(candidateSchool, opponentSchool) {
    let hash = 0;
    for (const character of `${candidateSchool}|${opponentSchool}`) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return hash % 2 === 0;
  }

  function currentPair() {
    const candidate = teamBySchool.get(sortState.candidate);
    const opponent = teamBySchool.get(sortState.placed[opponentIndex()]);
    return candidateGoesLeft(candidate.school, opponent.school)
      ? { left: candidate, right: opponent, leftIsCandidate: true }
      : { left: opponent, right: candidate, leftIsCandidate: false };
  }

  // ---------- Final order vs the real poll ----------
  //
  // Compares against where the poll puts the same teams you ranked. Poll-
  // unranked teams share the spot after the last ranked one.

  function pollOrderRanks(schools) {
    const ranked = schools
      .filter((school) => comparisonPoll.ranks[school])
      .sort((first, second) => comparisonPoll.ranks[first] - comparisonPoll.ranks[second]);
    const unrankedPollSpot = ranked.length + 1;
    const spotBySchool = new Map(ranked.map((school, index) => [school, index + 1]));
    return new Map(schools.map((school) => [school, spotBySchool.get(school) ?? unrankedPollSpot]));
  }

  function pollDeltaMarkup(school, yourRank, pollOrderRank) {
    const pollRank = comparisonPoll.ranks[school];
    const pollDescription = escapeHtml(pollRank ? `${comparisonPoll.label} #${pollRank}` : `Unranked in the ${comparisonPoll.label}`);
    // Two poll-unranked teams have no order between them, so below the unranked spot is "same".
    const bothBelowPoll = !pollRank && yourRank >= pollOrderRank;
    const spotsHigher = bothBelowPoll ? 0 : pollOrderRank - yourRank;
    if (spotsHigher === 0) {
      return `<span class="poll-delta is-same" title="${pollDescription}" aria-label="Same as the poll. ${pollDescription}">–</span>`;
    }
    const isUp = spotsHigher > 0;
    const spots = Math.abs(spotsHigher);
    // A poll-unranked team could sit anywhere below the ranked ones, so its gap is a minimum.
    const spotsText = pollRank ? `${spots}` : `${spots}+`;
    const spotsWord = `${spotsText} ${spots === 1 && pollRank ? "spot" : "spots"}`;
    return `<span class="poll-delta ${isUp ? "is-up" : "is-down"}" title="${pollDescription}"
      aria-label="You rank them ${spotsWord} ${isUp ? "higher" : "lower"}. ${pollDescription}"><span aria-hidden="true">${isUp ? "▲" : "▼"}</span><b aria-hidden="true">${spotsText}</b></span>`;
  }

  // Your top 24, names revealed in blind mode.
  function renderFinal() {
    const pollSpotBySchool = pollOrderRanks(sortState.placed);
    document.querySelector("[data-final-list]").innerHTML = sortState.placed.map((school, index) => {
      const team = teamBySchool.get(school);
      return `<li class="final-row" style="--team-color: ${team.accentColor}">
        <span class="patch">${index + 1}</span>
        <span class="final-team">${escapeHtml(school)}<small>${escapeHtml(team.conference ?? "")}</small></span>
        <span class="final-record">${team.wins}–${team.losses}</span>
        ${pollDeltaMarkup(school, index + 1, pollSpotBySchool.get(school))}
      </li>`;
    }).join("");
    const cutNames = [...sortState.cut].sort((first, second) => first.localeCompare(second));
    document.querySelector("[data-final-cut]").textContent = cutNames.length
      ? `Didn’t make your 24: ${cutNames.join(", ")}`
      : "";
    document.querySelector("[data-poll-legend]").textContent =
      `▲ spots higher than the ${comparisonPoll.label} has them · ▼ spots lower · – same · “+” = poll-unranked, so at least that many · hover for the poll rank`;
  }

  const alphabetical = (first, second) => first.localeCompare(second);

  // Lowercase, single-spaced, without "the", "university of" or "university".
  function normalizedName(name) {
    return String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim()
      .replace(/^the /, "").replace(/^university of /, "").replace(/ university$/, "");
  }

  // Every name a team answers to: school, abbreviation, alternate names, mascot, and "School Mascot".
  const lookupNamesBySchool = new Map(teams.map((team) => [team.school, new Set([
    team.school, team.abbreviation, team.mascot, `${team.school} ${team.mascot ?? ""}`, ...(team.alternateNames ?? []),
  ].filter(Boolean).map(normalizedName))]));

  // The autocomplete lists every FBS team, marking the ones already in the field.
  function renderAddTeam() {
    const addTeamElement = document.querySelector("[data-add-team]");
    if (!addTeamElement || isBlind) return;
    document.getElementById("add-team-options").innerHTML = teams.map((team) => team.school).sort(alphabetical).map((school) => {
      const team = teamBySchool.get(school);
      const details = [team.mascot, team.abbreviation, isInPlay(school) ? "already in the field" : null].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(school)}" label="${escapeHtml(details)}"></option>`;
    }).join("");
    const fieldSchools = [...poolSchools, ...sortState.added].sort(alphabetical);
    addTeamElement.querySelector("[data-field-count]").textContent = fieldSchools.length;
    addTeamElement.querySelector("[data-field-list]").textContent = fieldSchools.join(", ");
    addTeamElement.hidden = false;
  }

  // Match what was typed to a team by any name it answers to.
  function addTypedTeam(typedName) {
    const wanted = normalizedName(typedName);
    if (!wanted) return { added: false, message: "Type a team’s name first." };
    const matches = [...lookupNamesBySchool].filter(([, names]) => names.has(wanted)).map(([school]) => school);
    if (!matches.length) return { added: false, message: `No FBS team called “${typedName.trim()}”. Pick one from the suggestions.` };
    if (matches.length > 1) return { added: false, message: `“${typedName.trim()}” could be ${matches.sort(alphabetical).join(", ")}. Type the school’s name.` };
    const [school] = matches;
    if (isInPlay(school)) return { added: false, message: `${school} is already in the field.` };
    addTeam(school);
    return { added: true, message: `${school} added to the field.` };
  }

  function render() {
    const isFinished = !sortState.candidate;
    document.querySelector("[data-duel-stage]").hidden = isFinished;
    document.querySelector("[data-final-stage]").hidden = !isFinished;
    document.querySelector("[data-stage-title]").textContent = isFinished ? (isBlind ? "The Reveal" : "Your Top 24") : "Who Wins?";
    document.querySelector("[data-stage-note]").textContent = isFinished
      ? `${sortState.picks} picks · ▲▼ vs ${comparisonPoll.label}`
      : `Ranks are out of ${fbsTeamCount} FBS teams`;
    for (const undoButton of document.querySelectorAll("[data-undo]")) undoButton.disabled = !undoHistory.length;
    renderAddTeam();

    if (isFinished) {
      renderFinal();
      return;
    }

    const pair = currentPair();
    blindLabelBySchool = new Map([[pair.left.school, "Team A"], [pair.right.school, "Team B"]]);
    leftCard.innerHTML = contenderMarkup(pair.left, pair.right, "←");
    rightCard.innerHTML = contenderMarkup(pair.right, pair.left, "→");
    leftCard.style.setProperty("--team-color", isBlind ? inkColor : pair.left.accentColor);
    rightCard.style.setProperty("--team-color", isBlind ? inkColor : pair.right.accentColor);
    // A click anywhere on a card is a plain "wins"; its Close / Easily buttons say how sure.
    const strengthOf = (clickEvent) => clickEvent.target.closest("[data-strength]")?.dataset.strength ?? "wins";
    leftCard.onclick = (clickEvent) => recordPick(pair.leftIsCandidate, strengthOf(clickEvent));
    rightCard.onclick = (clickEvent) => recordPick(!pair.leftIsCandidate, strengthOf(clickEvent));
    activePair = pair;
    document.querySelector("[data-meeting]").innerHTML = meetingMarkup(pair.left, pair.right);
    document.querySelector("[data-matchup-strip]").innerHTML =
      possessionMarkup(pair.left, pair.right) + possessionMarkup(pair.right, pair.left);

    // The order stays hidden until the end so it can't sway picks; only the count of teams left shows.
    const picksLeft = expectedPicksLeft();
    const totalPicks = sortState.picks + picksLeft;
    const teamsLeft = sortState.waiting.length + 1;
    document.querySelector("[data-progress-fill]").style.width = `${(sortState.picks / totalPicks) * 100}%`;
    document.querySelector("[data-progress-count]").textContent =
      `Pick ${sortState.picks + 1} · ${teamsLeft} ${teamsLeft === 1 ? "team" : "teams"} left to consider`;
    document.querySelector("[data-progress-left]").textContent = isBlind
      ? `About ${picksLeft} to go`
      : `About ${picksLeft} to go if you agree with the polls`;
  }

  // ---------- Start ----------

  document.addEventListener("keydown", (keyEvent) => {
    if (!sortState.candidate || keyEvent.altKey || keyEvent.ctrlKey || keyEvent.metaKey) return;
    if (keyEvent.key !== "ArrowLeft" && keyEvent.key !== "ArrowRight") return;
    if (keyEvent.target.closest?.("select, input, textarea")) return;
    keyEvent.preventDefault();
    const leftWins = keyEvent.key === "ArrowLeft";
    recordPick(leftWins === activePair.leftIsCandidate, keyEvent.shiftKey ? "easily" : "wins");
  });
  for (const undoButton of document.querySelectorAll("[data-undo]")) undoButton.addEventListener("click", undoPick);
  for (const restartButton of document.querySelectorAll("[data-restart]")) restartButton.addEventListener("click", startOver);
  const addTeamElement = document.querySelector("[data-add-team]");
  addTeamElement?.addEventListener("submit", (submitEvent) => {
    submitEvent.preventDefault();
    const input = addTeamElement.querySelector("input");
    const { added, message } = addTypedTeam(input.value);
    addTeamElement.querySelector("[data-add-team-message]").textContent = message;
    if (added) input.value = "";
  });

  const savedProgress = loadProgress();
  if (savedProgress) {
    sortState = savedProgress.savedSortState;
    undoHistory = savedProgress.savedUndoHistory;
  } else {
    sortState = freshSortState();
    undoHistory = [];
    // Save straight away so a reload keeps the same shuffled order.
    saveProgress();
  }

  renderAwardKey();
  render();
})();
