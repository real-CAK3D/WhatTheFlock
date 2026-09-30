'use strict';
// Settings page organisation: the cards (added by many modules) are sorted
// into sections with a tab bar and a search box. Loaded last so every card
// exists; cards added later by other code fall into "More".

const SETTINGS_GROUPS = [
  { id: 'driving', label: '🚗 Driving', titles: ['Navigation', 'Co-driver', 'Speed', 'HUD', 'Drives & telemetry', 'Parking & sharing'] },
  { id: 'alerts',  label: '🔔 Alerts',  titles: ['Voice & alerts', 'Sounds & alerts', 'Traffic', 'Weather'] },
  { id: 'maps',    label: '🗺️ Maps',    titles: ['Offline maps', 'Mapped cameras', '3D view'] },
  { id: 'board',   label: '📡 Board',   titles: ['Beeps on the board', 'Board storage', 'Board SD card'] },
  { id: 'data',    label: '💾 Data',    titles: ['Phone', 'Export', 'Data'] },
  { id: 'setup',   label: '⚙️ Setup',   titles: ['Setup & permissions'] },
];
opts.settingsGroup = opts.settingsGroup || 'driving';

function settingsCards() { return [...document.querySelectorAll('#tab-set .card')]; }

function groupCards() {
  for (const card of settingsCards()) {
    const t = card.querySelector('h2')?.textContent.trim() || '';
    const g = SETTINGS_GROUPS.find(x => x.titles.includes(t));
    card.dataset.group = g ? g.id : 'more';
  }
}

function showSettingsGroup(id) {
  opts.settingsGroup = id; saveOpts();
  $('setSearch').value = '';
  document.querySelectorAll('.set-tabs button').forEach(b => b.classList.toggle('on', b.dataset.g === id));
  for (const card of settingsCards()) card.hidden = card.dataset.group !== id && !(id === 'data' && card.dataset.group === 'more');
  $('tab-set').scrollTop = 0;
  if (id === 'setup' && typeof refreshSetup === 'function') refreshSetup();
}

// Search every card (titles, labels and option text); show matches from all sections.
function searchSettings(q) {
  q = q.trim().toLowerCase();
  if (!q) { showSettingsGroup(opts.settingsGroup); return; }
  document.querySelectorAll('.set-tabs button').forEach(b => b.classList.remove('on'));
  let n = 0;
  for (const card of settingsCards()) {
    const hit = card.textContent.toLowerCase().includes(q);
    card.hidden = !hit; if (hit) n++;
  }
  $('setNone').hidden = n > 0;
}

(function buildSettingsNav() {
  groupCards();
  const bar = document.createElement('div');
  bar.className = 'set-bar';
  bar.innerHTML = `
    <input id="setSearch" type="search" placeholder="Search settings" autocomplete="off">
    <div class="set-tabs">${SETTINGS_GROUPS.map(g => `<button data-g="${g.id}">${g.label}</button>`).join('')}</div>
    <p class="mute small1" id="setNone" hidden style="padding:0 12px">No settings match.</p>`;
  $('tab-set').prepend(bar);
  bar.querySelector('.set-tabs').onclick = e => { const b = e.target.closest('[data-g]'); if (b) showSettingsGroup(b.dataset.g); };
  let t = null;
  $('setSearch').oninput = e => { clearTimeout(t); t = setTimeout(() => searchSettings(e.target.value), 150); };
  // The setup banner's "Fix" jumps straight to Setup.
  $('bSetupGo').addEventListener('click', () => setTimeout(() => showSettingsGroup('setup'), 0));
  showSettingsGroup(opts.settingsGroup);
})();
