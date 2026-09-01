// ============================================================
// admin-billing-report — the billing report (design handoff `2a`)
// ============================================================
// "This report is the existing monthly registration report, preserved as a
// first-class screen — not replaced by summary cards." The client already
// runs a version of this every month; the ask was to keep it, not swap it for
// a dashboard. Reached from Bill This Month's "See all" link, and useful on
// its own for a parent phone call or the board packet.
//
// ⚠️ SAME MATH AS EVERY OTHER BILLING SCREEN. _buildFamilyBillingData() plus
// the fee logic in computeBillMonthExceptions() (admin-bill-month.js) are the
// only two things this reads. Exception highlighting reuses the exact `causes`
// array Bill the Month computes — a row flagged here and a row flagged there
// are, by construction, the same row.

let _brMonth  = '';
let _brGroup  = 'room';
let _brRows   = [];      // per-child rows, always computed; grouped at render time
let _brFamilyRows = [];  // per-family rows for "by name"
let _brSummary = null;

function _brEl(id) { return document.getElementById(id); }

function _brDefaultMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function renderBillingReportTool() {
    const monthEl = _brEl('brMonth');
    if (monthEl && !monthEl.value) monthEl.value = _brMonth || _brDefaultMonth();
    _brMonth = monthEl?.value || _brDefaultMonth();

    const body = _brEl('brBody');
    if (body) body.innerHTML = '<p class="empty-hint">Building the report…</p>';
    try {
        await _brBuild(_brMonth);
    } catch (err) {
        console.error('renderBillingReportTool:', err);
        if (body) body.innerHTML = `<p class="empty-hint">Could not build the report — ${escHtml(err.message || err)}</p>`;
        return;
    }
    _brRenderTable();
    _brBindToggle();
}

async function _brBuild(month) {
    const { rows: famRows } = await computeBillMonthExceptions(month);
    _brFamilyRows = famRows;

    // A free-text note per family, separate from the causes below — causes
    // are the engine telling you what it noticed changed since last month;
    // a note is what you know ("confirmed with mom, this is right") and has
    // nothing to do with a diff.
    let noteRows = [];
    try { noteRows = await fetchBillingNotes(month); } catch (e) { console.warn('br notes:', e); }
    const notesMap = new Map(noteRows.map(r => [(r.parent_email || '').toLowerCase(), r.note || '']));
    famRows.forEach(fam => { fam.note = notesMap.get((fam.email || '').toLowerCase()) || ''; });

    // Per-child rows, one per registered child, carrying the same cause text
    // its family-level exception computed — the family causes list already
    // names the child ("Ellie: days changed 5→3"), so a child inherits any
    // cause that mentions their name, or the family-wide ones (fee, credit,
    // sibling) on every child in that family.
    //
    // Loads the same overrides computeBillMonthExceptions used, so a child
    // with a manual billing override prices the same way here as it does in
    // the family total it rolls up into — an empty map here previously made
    // "Base tuition" (built from these rows) and "Total to bill" (built from
    // computeBillMonthExceptions) disagree for every overridden child.
    let overrideRows = [];
    try { overrideRows = await fetchBillingOverrides(month); } catch (e) { console.warn('br overrides:', e); }
    const overridesMap = new Map(overrideRows.map(r => [
        `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
        parseFloat(r.override_amount),
    ]));

    const rows = [];
    famRows.forEach(fam => {
        // Withdrawn families never billed anything this month — surfacing
        // them as a dimmed "(withdrawn)" row/section just cluttered the
        // report with rows that are always $0. They're still excluded from
        // childCount/familyCount below; this just stops rendering them too.
        if (fam.withdrawn) return;
        // Re-derive per-child figures from the same source computeBillMonthExceptions
        // used, so a room subtotal and the family total it rolls up into can
        // never disagree — no second pass over registrations here.
        const perChild = _buildFamilyBillingData(month, overridesMap)
            .find(f => (f.parentEmail || '').toLowerCase() === (fam.email || '').toLowerCase());
        (perChild?.children || []).forEach(c => {
            const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
            const childCauses = fam.causes.filter(cz => !cz.child || cz.child === c.childName);
            rows.push({
                childName: c.childName, roomLabel: c.roomLabel, roomId: c.roomId,
                familyName: fam.name, payer: fam.email,
                fullDays: c.fullDays, halfDays: c.halfDays,
                adjustments: childCauses.map(cz => cz.text.replace(/^.*?: /, '')).join(' · '),
                amount: Math.round((billed + (c.changeFees || 0)) * 100) / 100,
                isException: fam.isException,
            });
        });
    });
    _brRows = rows;

    // fam.base is already NET of the individual/sibling discount (see
    // _buildFamilyBillingData: `subtotal += effRate - sib`), so summing the
    // per-child row amounts (which come from that same net figure) and then
    // showing "Discounts" as a further subtraction double-counts it — the
    // stat tiles could never add up to Total that way. Base tuition here is
    // the gross, pre-discount figure (fam.base + fam.discount) so
    // Base − Discounts + Fees − Credits actually equals Total. It also
    // excludes change fees, matching fam.total below, which excludes them too.
    const baseTuition = famRows.reduce((s, f) => s + (f.base || 0) + (f.discount || 0), 0);
    const discounts    = famRows.reduce((s, f) => s + (f.discount || 0), 0);
    const fees         = famRows.reduce((s, f) => s + (f.regFee || 0) + (f.familyNewFee || 0), 0);
    const credits      = famRows.reduce((s, f) => s + (f.creditTotal || 0), 0);
    const total        = famRows.reduce((s, f) => s + f.total, 0);
    const totalFullDays = rows.reduce((s, r) => s + (r.fullDays || 0), 0);
    const totalHalfDays = rows.reduce((s, r) => s + (r.halfDays || 0), 0);

    // "Ties to": cross-check against what actually got issued this month, and
    // what last month settled at, so the report is never read in isolation.
    let invoiceCount = 0, heldCount = 0, prevBilled = 0, prevCollected = 0;
    try {
        // Read-only report — a month with nothing billed yet has no cycle
        // row, and that's a fact to display (0 invoices), not something to
        // create by the act of looking at the report. fetchBillingCycle()
        // never inserts, unlike getOrCreateBillingCycle().
        const cycle = await fetchBillingCycle(month);
        const invoices = cycle ? await fetchInvoicesForCycle(cycle.id) : [];
        invoiceCount = invoices.length;
        heldCount    = invoices.filter(i => !i.sent_at).length;

        const prevMonth = _bmPrevMonth(month);
        const prevCycle = await fetchBillingCycle(prevMonth);
        const [prevInv, prevPay] = await Promise.all([
            prevCycle ? fetchInvoicesForCycle(prevCycle.id) : Promise.resolve([]),
            fetchPaymentsForMonth(prevMonth).catch(() => []),
        ]);
        prevBilled    = prevInv.reduce((s, i) => s + parseFloat(i.final_amount || 0), 0);
        prevCollected = prevPay.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    } catch (e) { console.warn('br ties-to:', e); }

    _brSummary = {
        baseTuition: Math.round(baseTuition * 100) / 100,
        discounts:   Math.round(discounts * 100) / 100,
        fees:        Math.round(fees * 100) / 100,
        credits:     Math.round(credits * 100) / 100,
        total:       Math.round(total * 100) / 100,
        totalFullDays, totalHalfDays,
        childCount:  rows.filter(r => !r.withdrawn).length,
        familyCount: famRows.filter(f => !f.withdrawn).length,
        invoiceCount, heldCount, prevBilled, prevCollected,
    };
}

function _brRenderTable() {
    const body = _brEl('brBody');
    if (!body || !_brSummary) return;
    const s = _brSummary;
    const [y, m] = _brMonth.split('-').map(Number);
    const monthLabel = m ? `${MONTH_NAMES[m - 1]} ${y}` : _brMonth;

    body.innerHTML = `
    <div class="br-head">
        <h2>${escHtml(monthLabel)} billing report</h2>
        <p class="br-sub">All active registrations as of ${escHtml(friendlyShort(new Date().toISOString().slice(0, 10)))} ·
            grouped ${_brGroup === 'room' ? 'by room' : 'by family name, A–Z'} · ${s.childCount} children · ${s.familyCount} families</p>
    </div>

    <div class="br-summary">
        <div class="br-stat"><div class="br-stat-label">Base tuition</div><div class="br-stat-val">$${s.baseTuition.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
        <div class="br-stat"><div class="br-stat-label">Discounts</div><div class="br-stat-val br-neg">−$${s.discounts.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
        <div class="br-stat"><div class="br-stat-label">Fees &amp; credits</div><div class="br-stat-val">${s.fees - s.credits >= 0 ? '+' : '−'}$${Math.abs(s.fees - s.credits).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
        <div class="br-stat br-stat-total"><div class="br-stat-label">Total to bill</div><div class="br-stat-val">$${s.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            <div class="br-stat-sub">${s.familyCount} invoices · avg $${s.familyCount ? Math.round(s.total / s.familyCount).toLocaleString() : 0}</div></div>
    </div>

    <div id="brTableWrap">${_brGroup === 'room' ? _brRoomTable() : _brNameTable()}</div>

    <div class="br-ties">
        <strong>Ties to:</strong> ${s.invoiceCount} invoice${s.invoiceCount === 1 ? '' : 's'} for this cycle
        ${s.heldCount ? `, ${s.heldCount} still held` : ', all issued'} ·
        last month billed $${s.prevBilled.toLocaleString(undefined, { maximumFractionDigits: 0 })},
        collected $${s.prevCollected.toLocaleString(undefined, { maximumFractionDigits: 0 })}
    </div>`;
}

function _brRoomTable() {
    const byRoom = new Map();
    _brRows.forEach(r => {
        const key = r.roomId || 'zzz';
        if (!byRoom.has(key)) byRoom.set(key, { label: r.roomLabel, rows: [] });
        byRoom.get(key).rows.push(r);
    });
    const roomOrder = (typeof ROOMS !== 'undefined' ? ROOMS.map(x => x.id) : []);
    const keys = [...byRoom.keys()].sort((a, b) => {
        const ia = roomOrder.indexOf(a), ib = roomOrder.indexOf(b);
        if (a === 'zzz') return 1; if (b === 'zzz') return -1;
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    // The room-subtotal bar has to be a <tr> — a <div> inside <tbody> is
    // invalid HTML and the browser silently hoists it out of the table,
    // which un-groups every row the moment this renders.
    const sections = keys.map(key => {
        const g = byRoom.get(key);
        const subtotal = g.rows.reduce((s, r) => s + (r.amount || 0), 0);
        const rows = g.rows.map(_brChildRow).join('');
        return `
        <tr class="br-room-bar"><td colspan="4">${escHtml(g.label)} · ${g.rows.length} children</td><td></td><td style="text-align:right">$${subtotal.toFixed(2)}</td></tr>
        ${rows}`;
    }).join('');

    return `<div class="table-wrapper"><table class="report-table br-room-table">
        <thead><tr><th>Child</th><th>Family &amp; payer</th><th>Full days</th><th>Half days</th><th>Adjustments</th><th>Amount</th></tr></thead>
        <tbody>${sections}${_brGrandTotalRow(6, 'room')}</tbody>
    </table></div>`;
}

function _brChildRow(r) {
    // data-br-email is a pure hook — Finance Hub delegates a click here to
    // switch to the Ledger tab and open that family's drawer (implementation
    // spec §5: "Billing Report row clicks must switch to the Ledger tab AND
    // open that family's drawer in the same action"). No calculation here
    // changes; admin-finance-hub.js owns what the click does.
    return `<tr class="br-row${r.isException ? ' br-exc' : ''}${r.withdrawn ? ' br-withdrawn' : ''}" data-br-email="${escHtml(r.payer || '')}">
        <td>${escHtml(r.childName)}</td>
        <td>${escHtml(r.familyName)}<br><small style="color:var(--text-muted)">${escHtml(r.payer)}</small></td>
        <td style="text-align:center">${r.fullDays || '—'}</td>
        <td style="text-align:center">${r.halfDays || '—'}</td>
        <td>${escHtml(r.adjustments || '—')}</td>
        <td style="text-align:right"><strong>$${(r.amount || 0).toFixed(2)}</strong></td>
    </tr>`;
}

function _brNameTable() {
    const rows = _brFamilyRows.filter(f => !f.withdrawn).map(f => {
        const kids = f.children.map((name, i) => `${escHtml(name)} <small>(${escHtml(_brRows.find(r => r.childName === name)?.roomLabel || '')})</small>`).join(', ');
        return `<tr class="br-row${f.isException ? ' br-exc' : ''}${f.withdrawn ? ' br-withdrawn' : ''}" data-br-email="${escHtml(f.email || '')}">
            <td>${escHtml(f.name)}<br><small style="color:var(--text-muted)">${escHtml(f.email)}</small></td>
            <td>${kids || '—'}</td>
            <td style="text-align:center">${f.children.length}</td>
            <td style="text-align:right">$${f.base.toFixed(2)}</td>
            <td>${escHtml(f.causes.map(c => c.text).join(' · ') || '—')}</td>
            <td><input type="text" class="br-note-input" data-email="${escHtml(f.email || '')}" value="${escHtml(f.note || '')}" placeholder="Add a note…"></td>
            <td style="text-align:right"><strong>$${f.total.toFixed(2)}</strong></td>
        </tr>`;
    }).join('');

    return `<div class="table-wrapper"><table class="report-table">
        <thead><tr><th>Family &amp; payer</th><th>Children &amp; room</th><th>Kids</th><th>Base</th><th>Adjustments</th><th>Notes</th><th>Amount</th></tr></thead>
        <tbody>${rows}${_brGrandTotalRow(7, 'name')}</tbody>
    </table></div>`;
}

function _brGrandTotalRow(cols, mode) {
    const s = _brSummary;
    // The row body below fills 6 columns (the first cell spans 2). Any
    // column beyond that — e.g. the name table's Notes column — gets a
    // blank cell here so the Amount total stays in the table's last column
    // instead of sliding left under whatever column follows Adjustments.
    const filler = '<td></td>'.repeat(Math.max(0, cols - 6));
    // Columns 3/4 mean different things per table: the room table's are
    // Full days / Half days, the name table's are Kids / Base — so the
    // totals row has to speak whichever pair the header above it actually
    // labeled, not the same two figures under both.
    const col3 = mode === 'room' ? s.totalFullDays : s.childCount;
    const col4 = mode === 'room' ? s.totalHalfDays : `$${s.baseTuition.toFixed(2)}`;
    const col3Align = 'text-align:center';
    const col4Align = mode === 'room' ? 'text-align:center' : 'text-align:right';
    return `<tr class="br-grand-total">
        <td colspan="2">Total · ${_brMonth} · ${s.childCount} children</td>
        <td style="${col3Align}">${col3}</td>
        <td style="${col4Align}">${col4}</td>
        <td>Discounts −$${s.discounts.toFixed(2)} · Fees +$${s.fees.toFixed(2)}</td>
        ${filler}
        <td style="text-align:right" class="br-grand-amt">$${s.total.toFixed(2)}</td>
    </tr>`;
}

function _brBindToggle() {
    document.querySelectorAll('#brGroupToggle .ap-seg-btn').forEach(b => {
        b.onclick = () => {
            _brGroup = b.dataset.group;
            document.querySelectorAll('#brGroupToggle .ap-seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
            _brRenderTable();
        };
    });
    _brEl('brPrintBtn')?.addEventListener('click', _brPrint);
    _brEl('brCsvBtn')?.addEventListener('click', _brExportCsv);
    const monthEl = _brEl('brMonth');
    if (monthEl) monthEl.onchange = () => renderBillingReportTool();
    _brBindNotes();
}

// Delegated on #brBody (which survives every re-render — only its innerHTML
// is replaced) so this only needs binding once per tool open, not once per
// render. The dataset flag guards against a second renderBillingReportTool()
// call double-binding onto the same node.
function _brBindNotes() {
    const body = _brEl('brBody');
    if (!body || body.dataset.notesBound) return;
    body.dataset.notesBound = '1';
    body.addEventListener('change', e => {
        const input = e.target.closest('.br-note-input');
        if (input) _brSaveNote(input.dataset.email, input.value);
    });
}

async function _brSaveNote(email, value) {
    if (!email) return;
    const fam = _brFamilyRows.find(f => (f.email || '').toLowerCase() === email.toLowerCase());
    if (fam && (fam.note || '') === value) return; // unchanged
    try {
        const adminEmail = await getAdminEmail();
        await upsertBillingNote(_brMonth, email, value, adminEmail);
        if (fam) fam.note = value;
        logAdminAction('update', 'billing_note', null, { month: _brMonth, parent_email: email });
    } catch (err) {
        console.error('_brSaveNote:', err);
        showToast('Could not save the note — try again.', 'error');
    }
}

// Always prints the room grouping — "so it can go in the binder or to the
// board the way the current report does" — regardless of which toggle is
// active on screen.
function _brPrint() {
    if (!_brSummary) return;
    const [y, m] = _brMonth.split('-').map(Number);
    const monthLabel = m ? `${MONTH_NAMES[m - 1]} ${y}` : _brMonth;
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Billing Report — ${escHtml(monthLabel)}</title>
        <style>
            body { font-family: Arial, sans-serif; font-size: 12px; color: #000; margin: 24px; }
            h1 { font-size: 16px; margin: 0 0 2px; }
            p.subtitle { font-size: 10px; color: #666; margin: 0 0 16px; }
            table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
            th { background: #01294A; color: #fff; padding: 6px 10px; text-align: left; font-size: 11px; }
            th:nth-child(3), th:nth-child(4), th:nth-child(6) { text-align: right; }
            td { padding: 5px 10px; font-size: 11px; border-bottom: 1px solid #eee; vertical-align: top; }
            tr.br-room-bar td { background: #F5F0E4; font-weight: bold; border-top: 2px solid #ccc; }
            tr.br-grand-total td { background: #01294A; color: #fff; font-weight: bold; }
            tr.br-exc td { background: #FFF8E1; }
            tr.br-withdrawn td { opacity: .62; }
            @media print { body { margin: 0; } tr { page-break-inside: avoid; } }
        </style></head><body>
        <h1>${escHtml(monthLabel)} billing report</h1>
        <p class="subtitle">Printed ${new Date().toLocaleDateString()} · grouped by room</p>
        ${_brRoomTable()}
        </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
}

function _brExportCsv() {
    if (!_brRows.length && !_brFamilyRows.length) { alert('Nothing to export.'); return; }
    let header, lines;
    if (_brGroup === 'room') {
        header = ['Child', 'Family', 'Payer', 'Room', 'Full days', 'Half days', 'Adjustments', 'Amount'];
        lines = _brRows.map(r => [
            csvCell(r.childName), csvCell(r.familyName), csvCell(r.payer), csvCell(r.roomLabel),
            r.fullDays, r.halfDays, csvCell(r.adjustments), (r.amount || 0).toFixed(2),
        ].join(','));
    } else {
        header = ['Family', 'Payer', 'Children', 'Kids', 'Base', 'Adjustments', 'Notes', 'Amount'];
        lines = _brFamilyRows.map(f => [
            csvCell(f.name), csvCell(f.email), csvCell(f.children.join('; ')), f.children.length,
            f.base.toFixed(2), csvCell(f.causes.map(c => c.text).join('; ')), csvCell(f.note || ''), f.total.toFixed(2),
        ].join(','));
    }
    downloadFile(`billing-report-${_brMonth}-${_brGroup}.csv`, 'text/csv', [header.join(','), ...lines].join('\n'));
}
