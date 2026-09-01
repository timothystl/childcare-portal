// ============================================================
// portal-nav — the parent app's tab shell
// ============================================================
// Design: docs/design_handoff/README.md, "Navigation" — as extended by the
// Recap tab below. Six persistent tabs — 🏠 Today · 📔 Recap · 🗓 Schedule ·
// 💳 Billing · 💬 Messages · 👤 Account — on every non-modal screen. The bar
// never scrolls; the route body above it does.
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
//
// ⚠️ Billing had already been through two shapes before this one — a real
// tab that was a "coming soon" placeholder, then removed in favor of
// Documents, which was itself later folded into Account. It's a tab again
// because a parent needs to see what's billed and what's owed, which is real
// data now (portal-billing.js, off the same my_schedule() invoices the
// Schedule tab already reads) — only the "Pay" button is still a
// placeholder, because no payment processor is wired into this app yet.
//
// ⚠️ Documents is NOT its own tab. It renders inside the Account tab
// (portal.html, #pdBody nested under #ptAccountBody) — see portal-account.js
// / paLoad, which loads it together with the rest of Account on first visit.
//
// ⚠️ Recap IS its own tab, unlike Documents — a parent asking "how did today
// go" wants the browsable record (daily-sheet events, photos, incidents) for
// ANY day, not just the printable copy of one. Today already renders all of
// this live for the current day (js/portal/portal-today.js); Recap
// (js/portal/portal-recap.js) is the same three sections, for a date the
// parent picks, and reuses Today's rendering vocabulary rather than keeping a
// second copy of "how an event reads."
//
// ⚠️ The icons are the handoff's illustrated set (design_handoff_parent_portal,
// images/icons/*.png), not emoji. They are real images, so BOTH layouts render
// the same <img> — the bottom bar at 26px and the sidebar rail at 22px — and
// the inactive state is opacity, not a different glyph. The desktop sidebar in
// the design file still showed emoji as placeholders; its own README says to
// "swap for the same illustrated icon set once available", which this does.
const PT_TABS = [
    { key: 'today',     icon: 'images/icons/nav-today.png',    label: 'Today' },
    { key: 'daily',     icon: 'images/icons/nav-recap.png',    label: 'Recap' },
    { key: 'schedule',  icon: 'images/icons/nav-schedule.png', label: 'Schedule' },
    { key: 'billing',   icon: 'images/icons/nav-billing.png',  label: 'Billing' },
    { key: 'messages',  icon: 'images/icons/nav-messages.png', label: 'Messages' },
    { key: 'account',   icon: 'images/icons/nav-account.png',  label: 'Account' },
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
            <img class="tabbar-icon" src="${t.icon}" alt="" aria-hidden="true">
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
        if (key === 'billing'  && typeof pbLoad === 'function') pbLoad();
        if (key === 'daily'    && typeof prLoad === 'function') prLoad();
    }
}

function ptInitTabs() {
    ptRenderTabs();
    ptGoTab('today');
}
