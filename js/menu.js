// ============================================================
// Public read-only weekly menu page (parent-facing, no login).
// Shows this week + next week of published CACFP menus.
// ============================================================

document.addEventListener('DOMContentLoaded', loadPublicMenu);

function _menuMondayOf(date) {
    const day  = date.getDay(); // 0=Sun … 6=Sat
    const diff = (day === 0 ? -6 : 1 - day);
    const mon  = new Date(date);
    mon.setDate(date.getDate() + diff);
    return mon.toISOString().split('T')[0];
}

function _menuWeekdayDates(monday) {
    const start = new Date(monday + 'T00:00:00');
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

function _menuDayLabel(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

async function loadPublicMenu() {
    const el = document.getElementById('menuContent');
    if (!sbClient) {
        el.innerHTML = '<p class="empty-hint">Menu unavailable right now — please check back later.</p>';
        return;
    }

    const thisMonday = _menuMondayOf(new Date());
    const nextMondayDate = new Date(thisMonday + 'T00:00:00');
    nextMondayDate.setDate(nextMondayDate.getDate() + 7);
    const nextMonday = nextMondayDate.toISOString().split('T')[0];

    const weeks = [
        { label: 'This Week', dates: _menuWeekdayDates(thisMonday) },
        { label: 'Next Week', dates: _menuWeekdayDates(nextMonday) },
    ];
    const allDates = [...weeks[0].dates, ...weeks[1].dates];

    const { data, error } = await sbClient
        .from('cacfp_menus')
        .select('menu_date, meal_type, food_items, milk, meat_alt, vegetable, fruit, grain')
        .in('menu_date', allDates)
        .eq('status', 'published')
        .order('menu_date');

    if (error) {
        console.error('loadPublicMenu:', error);
        el.innerHTML = '<p class="empty-hint">Menu unavailable right now — please check back later.</p>';
        return;
    }
    if (!data || !data.length) {
        el.innerHTML = '<p class="empty-hint">No menu has been posted yet — please check back soon.</p>';
        return;
    }

    const html = weeks.map(week => {
        const rows = week.dates.filter(d => data.some(r => r.menu_date === d));
        if (!rows.length) return '';
        return `
            <h2>${week.label}</h2>
            <div class="menu-grid-wrap">
            <table class="menu-table">
                <thead><tr><th>Meal</th>${rows.map(d => `<th>${_menuDayLabel(d)}</th>`).join('')}</tr></thead>
                <tbody>
                    ${CACFP_MEAL_TYPES.map(mt => `
                        <tr>
                            <td><strong>${mt.label}</strong></td>
                            ${rows.map(d => {
                                const cell = data.find(r => r.menu_date === d && r.meal_type === mt.id);
                                return `<td>${cell && cell.food_items ? escHtml(cell.food_items) : '—'}</td>`;
                            }).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            </div>`;
    }).join('');

    el.innerHTML = html || '<p class="empty-hint">No menu has been posted yet — please check back soon.</p>';
}
