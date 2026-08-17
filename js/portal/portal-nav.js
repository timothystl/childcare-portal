// ============================================================
// portal-nav — the parent app's tab shell
// ============================================================
// Design: docs/design_handoff/README.md, "Navigation". Four persistent tabs —
// 🏠 Today · 🗓 Schedule · 💬 Messages · 👤 Account — on every non-modal
// screen. The bar never scrolls; the route body above it does.
//
// Why this exists at all: the portal shipped as a single scrolling page while
// the design is a multi-tab app. Everything already built becomes the Today
// tab, and every screen still to come becomes additive instead of a restructure.
//
// "Tab state is a single `route` value" (README, Interactions). Deliberately
// NOT a router with URLs: these are panes of one signed-in app, and a
// deep-linkable /portal#billing would need auth-gated route restoration that
// nothing yet asks for. When push deep links land (README: "Push → deep link"),
// this is the function they call.

// ⚠️ Documents is NOT its own tab. It shipped briefly as a fifth tab
// (replacing a Billing placeholder), but paperwork a parent opens once a
// season doesn't earn a permanent slot in the bar a parent taps every day —
// it now renders inside the Account tab (portal.html, #pdBody nested under
// #ptAccountBody), the "everything about my family" tab, right alongside the
// pickup list and notification prefs. See portal-account.js / paLoad, which
// loads it together with the rest of Account on first visit.
const PT_TABS = [
    { key: 'today',     icon: '🏠', label: 'Today' },
    { key: 'schedule',  icon: '🗓', label: 'Schedule' },
    { key: 'messages',  icon: '💬', label: 'Messages' },
    { key: 'account',   icon: '👤', label: 'Account' },
];

let ptRoute   = 'today';
const ptBadges = {};        // key -> count; 0/undefined renders nothing
const ptOpened = {};        // key -> true once its loader has run

function ptNavEl(id) { return document.getElementById(id); }

function ptRenderTabs() {
    const bar = ptNavEl('ptTabs');
    if (!bar) return;
    bar.style.gridTemplateColumns = `repeat(${PT_TABS.length},1fr)`;
    bar.innerHTML = PT_TABS.map(t => {
        const n = ptBadges[t.key] || 0;
        return `<button type="button" class="tabbar-item ${t.key === ptRoute ? 'is-active' : ''}"
                    data-tab="${t.key}" role="tab" aria-selected="${t.key === ptRoute}">
            <span class="tabbar-icon" aria-hidden="true">${t.icon}</span>
            <span class="tabbar-label">${t.label}</span>
            ${n ? `<span class="tabbar-badge" aria-label="${n} unread">${n > 9 ? '9+' : n}</span>` : ''}
        </button>`;
    }).join('');
    bar.querySelectorAll('.tabbar-item').forEach(b => {
        b.addEventListener('click', () => ptGoTab(b.dataset.tab));
    });
}

/** Set (or clear) a tab's unread pill. */
function ptSetBadge(tabKey, count) {
    ptBadges[tabKey] = Number(count) || 0;
    ptRenderTabs();
}

function ptGoTab(key) {
    if (!PT_TABS.some(t => t.key === key)) return;
    ptRoute = key;

    document.querySelectorAll('#ptRoute .pt-tab').forEach(sec => {
        sec.classList.toggle('hidden', sec.dataset.tab !== key);
    });
    ptRenderTabs();
    // Switching tabs resets that tab's scroll — a parent tapping Messages
    // expects the top of Messages, not wherever Today was left.
    const route = ptNavEl('ptRoute');
    if (route) route.scrollTop = 0;

    // Lazy first open. Messages in particular must NOT load on sign-in: reading
    // the thread marks it read, so eager loading would clear the unread badge
    // for a parent who never opened the tab.
    if (!ptOpened[key]) {
        ptOpened[key] = true;
        if (key === 'messages' && typeof pmLoad === 'function') pmLoad();
        // Documents lives inside Account now — load both together.
        if (key === 'account'  && typeof paLoad === 'function') paLoad();
        if (key === 'account'  && typeof pdLoad === 'function') pdLoad();
        if (key === 'schedule' && typeof psLoad === 'function') psLoad();
    }
}

function ptInitTabs() {
    ptRenderTabs();
    ptGoTab('today');
}
