// Progressive enhancement for the ranked slate. The page is fully rendered at
// build time; this script only localizes kickoff times, runs the headliner
// countdown, and wires up the filters. Without it the page still reads fine.
(() => {
  "use strict";

  // ---------- Local kickoff times ----------

  const kickoffFormats = {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
    date: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }),
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
    long: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }),
  };

  function localizeKickoffTimes() {
    for (const timeElement of document.querySelectorAll("time[data-format]")) {
      const format = kickoffFormats[timeElement.dataset.format];
      const kickoff = new Date(timeElement.dateTime);
      if (format && !Number.isNaN(kickoff.getTime())) timeElement.textContent = format.format(kickoff);
    }
    const timezoneNote = document.querySelector("[data-timezone-note]");
    if (timezoneNote) timezoneNote.textContent = "Kickoffs in your local time";
  }

  // ---------- Headliner countdown ----------

  function startCountdown() {
    const countdown = document.querySelector("[data-countdown-to]");
    if (!countdown) return;
    const kickoff = new Date(countdown.dataset.countdownTo);
    if (Number.isNaN(kickoff.getTime())) return;

    const unitElements = {};
    for (const unitElement of countdown.querySelectorAll("[data-countdown-unit]")) {
      unitElements[unitElement.dataset.countdownUnit] = unitElement;
    }

    function tick() {
      const millisecondsLeft = Math.max(0, kickoff - Date.now());
      const unitValues = {
        days: Math.floor(millisecondsLeft / 86400000),
        hours: Math.floor(millisecondsLeft / 3600000) % 24,
        minutes: Math.floor(millisecondsLeft / 60000) % 60,
      };
      for (const [unit, value] of Object.entries(unitValues)) {
        if (unitElements[unit]) unitElements[unit].textContent = String(value).padStart(2, "0");
      }
    }

    tick();
    countdown.hidden = false;
    setInterval(tick, 30000);
  }

  // ---------- Filters (remembered per browser) ----------

  const storageKey = "ranked-slate-filters";

  function loadFilterState(knownSchools) {
    const filterState = { topTenOnly: false, conferenceOnly: false, followedTeam: null };
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved) {
        filterState.topTenOnly = saved.topTenOnly === true;
        filterState.conferenceOnly = saved.conferenceOnly === true;
        // A team that dropped out of the poll can no longer be followed.
        filterState.followedTeam = knownSchools.has(saved.followedTeam) ? saved.followedTeam : null;
      }
    } catch (storageError) {
      // Storage unavailable or corrupt: start unfiltered.
    }
    return filterState;
  }

  function saveFilterState(filterState) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(filterState));
    } catch (storageError) {
      // Storage unavailable: filters just won't persist.
    }
  }

  function setUpFilters() {
    const toolbar = document.querySelector("[data-toolbar]");
    const tickets = [...document.querySelectorAll(".ticket")];
    if (!toolbar || !tickets.length) return;

    const rosterRows = [...document.querySelectorAll(".roster-row")];
    const filterButtons = [...toolbar.querySelectorAll("[data-filter]")];
    const followedTeamChip = toolbar.querySelector("[data-followed-team-chip]");
    const resultCount = toolbar.querySelector("[data-result-count]");
    const emptyMessage = document.querySelector("[data-empty-message]");
    const weeks = [...document.querySelectorAll("[data-week]")];

    const schoolsByTicket = new Map(tickets.map((ticket) => [ticket, JSON.parse(ticket.dataset.schools)]));
    const filterState = loadFilterState(new Set(rosterRows.map((row) => row.dataset.school)));

    function isVisible(ticket) {
      return (!filterState.topTenOnly || ticket.dataset.topTenClash === "true")
        && (!filterState.conferenceOnly || ticket.dataset.conferenceGame === "true")
        && (!filterState.followedTeam || schoolsByTicket.get(ticket).includes(filterState.followedTeam));
    }

    function applyFilters() {
      let visibleCount = 0;
      for (const ticket of tickets) {
        ticket.hidden = !isVisible(ticket);
        if (!ticket.hidden) visibleCount += 1;
        for (const side of ticket.querySelectorAll(".bout-side")) {
          side.classList.toggle("is-followed", side.dataset.school === filterState.followedTeam);
        }
      }
      for (const week of weeks) {
        week.hidden = !week.querySelector(".ticket:not([hidden])");
      }
      emptyMessage.hidden = visibleCount > 0;
      resultCount.textContent = `${visibleCount} ${visibleCount === 1 ? "matchup" : "matchups"} remaining`;

      for (const button of filterButtons) {
        button.setAttribute("aria-pressed", String(filterState[button.dataset.filter]));
      }
      followedTeamChip.hidden = !filterState.followedTeam;
      followedTeamChip.textContent = filterState.followedTeam ? `Following ${filterState.followedTeam}` : "";
      followedTeamChip.setAttribute("aria-label", filterState.followedTeam ? `Stop following ${filterState.followedTeam}` : "");
      for (const row of rosterRows) {
        row.setAttribute("aria-pressed", String(row.dataset.school === filterState.followedTeam));
      }
    }

    function updateFilters(changes) {
      Object.assign(filterState, changes);
      saveFilterState(filterState);
      applyFilters();
    }

    for (const button of filterButtons) {
      button.addEventListener("click", () => updateFilters({ [button.dataset.filter]: !filterState[button.dataset.filter] }));
    }
    followedTeamChip.addEventListener("click", () => updateFilters({ followedTeam: null }));
    for (const row of rosterRows) {
      row.addEventListener("click", () => updateFilters({
        followedTeam: filterState.followedTeam === row.dataset.school ? null : row.dataset.school,
      }));
    }

    toolbar.hidden = false;
    const rosterNote = document.querySelector("[data-roster-note]");
    if (rosterNote) rosterNote.hidden = false;
    applyFilters();
  }

  localizeKickoffTimes();
  startCountdown();
  setUpFilters();
})();
