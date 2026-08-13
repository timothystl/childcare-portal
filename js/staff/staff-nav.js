// ============================================================
// staff-nav — the staff app's tab shell
// ============================================================
// Design: docs/design_handoff/README.md, "Navigation". Four persistent tabs —
// 👶 Room · 🗓 Schedule · 💬 Messages · 👤 Account.
//
// Same geometry as the parent bar (.tabbar in css/styles.css), different tab
// list. Kept as two small modules rather than one shared router because the two
// apps share no state, no session and no build entry — the only thing genuinely
// common is the CSS, and that is where it lives.
//
// ⚠️ The bar belongs to the SIGNED-IN app only, and modal sheets cover it
// entirely ("dismissed by the grab handle, never by a tab"). So it renders
// inside the roster screen's shell and the sheets sit above it.

const SL_TABS = [
    { key: 'room',     icon: '👶', label: 'Room' },
    { key: 'schedule', icon: '🗓', label: 'Schedule' },
    { key: 'messages', icon: '💬', label: 'Messages' },
    { key: 'account',  icon: '👤', label: 'Account' },
];

let slRoute = 'room';
const slBadges = {};
const slOpened = {};

function slNavEl(id) { return document.getElementById(id); }

function slRenderTabs() {
    const bar = slNavEl('slTabs');
    if (!bar) return;
    bar.style.gridTemplateColumns = `repeat(${SL_TABS.length},1fr)`;
    bar.innerHTML = SL_TABS.map(t => {
        const n = slBadges[t.key] || 0;
        return `<button type="button" class="tabbar-item ${t.key === slRoute ? 'is-active' : ''}"
                    data-tab="${t.key}" role="tab" aria-selected="${t.key === slRoute}">
            <span class="tabbar-icon" aria-hidden="true">${t.icon}</span>
            <span class="tabbar-label">${t.label}</span>
            ${n ? `<span class="tabbar-badge" aria-label="${n} unread">${n > 9 ? '9+' : n}</span>` : ''}
        </button>`;
    }).join('');
    bar.querySelectorAll('.tabbar-item').forEach(b => {
        b.addEventListener('click', () => slGoTab(b.dataset.tab));
    });
}

function slSetBadge(tabKey, count) {
    slBadges[tabKey] = Number(count) || 0;
    slRenderTabs();
}

function slGoTab(key) {
    if (!SL_TABS.some(t => t.key === key)) return;
    slRoute = key;
    document.querySelectorAll('#slRoute .sl-tab').forEach(sec => {
        sec.classList.toggle('hidden', sec.dataset.tab !== key);
    });
    slRenderTabs();
    const route = slNavEl('slRoute');
    if (route) route.scrollTop = 0;

    if (!slOpened[key]) {
        slOpened[key] = true;
        // Same rule as the parent app: opening the tab is what reads the
        // messages, so it cannot happen at sign-in.
        if (key === 'messages' && typeof slOpenMessagesTab === 'function') slOpenMessagesTab();
    }
}

function slInitTabs() {
    slRenderTabs();
    slGoTab('room');
}
