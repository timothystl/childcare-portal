// ============================================================
// BUSINESS LOGIC UNIT TESTS
// Tests for core portal logic: room assignment, discounts,
// registration window, billing (weekly rates, multi-child).
//
// Run: node js/tests/business-logic.test.js
// No npm dependencies — uses only Node.js built-ins.
// ============================================================

'use strict';

// ---- Minimal test runner ----

let _passed = 0, _failed = 0;
function describe(label, fn) { console.log(`\n  ${label}`); fn(); }
function test(label, fn) {
    try {
        fn();
        _passed++;
        console.log(`    ✓ ${label}`);
    } catch (err) {
        _failed++;
        console.error(`    ✗ ${label}\n      ${err.message}`);
    }
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

// ============================================================
// STUBS — mirror the real ROOMS config from supabase.js
// ============================================================
const ROOMS = [
    { id: 'bear',   ageMinMonths: 0,  ageMaxMonths: 11,  fullDayRate: 80,  halfDayRate: null, weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: true },
    { id: 'bee',    ageMinMonths: 12, ageMaxMonths: 23,  fullDayRate: 75,  halfDayRate: 55,   weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: false },
    { id: 'turtle', ageMinMonths: 24, ageMaxMonths: 29,  fullDayRate: 75,  halfDayRate: 45,   weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: false },
    { id: 'goose',  ageMinMonths: 30, ageMaxMonths: 35,  fullDayRate: 75,  halfDayRate: 45,   weeklyFullRate: null, weeklyHalfRate: null, fullDayOnly: false },
    { id: 'owl',    ageMinMonths: 36, ageMaxMonths: null, fullDayRate: 75, halfDayRate: 45,   weeklyFullRate: 300, weeklyHalfRate: 180,  fullDayOnly: false },
    { id: 'summer', ageMinMonths: null, ageMaxMonths: null, fullDayRate: 75, halfDayRate: null, weeklyFullRate: null, weeklyHalfRate: null, hidden: false },
];

// ============================================================
// PURE FUNCTIONS (copied verbatim from app.js / supabase.js)
// These must remain in sync when the source changes.
// ============================================================

function calcAgeMonths(dobStr, referenceDate) {
    if (!dobStr) return null;
    const today = referenceDate || new Date();
    const birth = new Date(dobStr + 'T00:00:00');
    return (today.getFullYear() - birth.getFullYear()) * 12
         + (today.getMonth() - birth.getMonth());
}

function getRoomIdFromDob(dobStr, referenceDate) {
    if (!dobStr) return null;
    const months = calcAgeMonths(dobStr, referenceDate);
    if (months < 0) return null;
    const ageable = ROOMS
        .filter(r => r.id !== 'summer' && r.ageMinMonths != null)
        .sort((a, b) => a.ageMinMonths - b.ageMinMonths);
    for (const room of ageable) {
        if (months >= room.ageMinMonths && (room.ageMaxMonths == null || months <= room.ageMaxMonths)) {
            return room.id;
        }
    }
    return null;
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

    let mode;
    if (day < 1 || day > 15) {
        mode = 'closed';
    } else if (day === 1 && centralHour < 9) {
        mode = 'closed';  // Before 9 AM Central on the 1st
    } else {
        mode = 'confirmed';
    }
    if (override === 'open')   mode = 'confirmed';
    if (override === 'closed') mode = 'closed';

    return {
        mode,
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

// ============================================================
// TESTS
// ============================================================

describe('calcAgeMonths', () => {
    const ref = new Date('2026-03-24');

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
        const r = new Date('2026-03-01');
        // Oct→Nov→Dec→Jan→Feb→Mar = 5 months
        expect(calcAgeMonths('2025-10-31', r)).toBe(5);
    });
});

describe('getRoomIdFromDob — age-based room assignment', () => {
    const ref = new Date('2026-03-24');
    // Helper: produce DOB that gives exactly N months of age on ref date
    const dobAtMonths = m => {
        const d = new Date(ref);
        d.setMonth(d.getMonth() - m);
        return d.toISOString().slice(0, 10);
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
        expect(getRegistrationWindow(new Date('2026-03-01'), 'auto', 9).mode).toBe('confirmed');
    });
    test('day 1 at 8:59 AM → closed (before 9 AM)', () => {
        expect(getRegistrationWindow(new Date('2026-03-01'), 'auto', 8).mode).toBe('closed');
    });
    test('day 1 at midnight → closed (before 9 AM)', () => {
        expect(getRegistrationWindow(new Date('2026-03-01'), 'auto', 0).mode).toBe('closed');
    });
    test('day 15 → open (boundary)', () => {
        expect(getRegistrationWindow(new Date('2026-03-15')).mode).toBe('confirmed');
    });
    test('day 16 → closed', () => {
        expect(getRegistrationWindow(new Date('2026-03-16')).mode).toBe('closed');
    });
    test('day 31 → closed', () => {
        expect(getRegistrationWindow(new Date('2026-01-31')).mode).toBe('closed');
    });
    test('override "open" forces mode to confirmed even after day 15', () => {
        expect(getRegistrationWindow(new Date('2026-03-20'), 'open').mode).toBe('confirmed');
    });
    test('override "open" forces mode to confirmed even before 9 AM on the 1st', () => {
        expect(getRegistrationWindow(new Date('2026-03-01'), 'open', 7).mode).toBe('confirmed');
    });
    test('override "closed" forces mode to closed even on day 1 at 9 AM', () => {
        expect(getRegistrationWindow(new Date('2026-03-01'), 'closed', 9).mode).toBe('closed');
    });
    test('target month is always next calendar month', () => {
        const win = getRegistrationWindow(new Date('2026-03-10'));
        expect(win.targetDate.getMonth()).toBe(3);  // April (0-indexed)
        expect(win.targetDate.getFullYear()).toBe(2026);
    });
    test('target month wraps to January next year in December', () => {
        const win = getRegistrationWindow(new Date('2026-12-10'));
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

// ---- Summary ----
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) process.exit(1);
