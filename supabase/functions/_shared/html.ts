// ============================================================
// html — shared HTML-escaping helper for Edge Functions
// ============================================================
// Before this, escHtml() was pasted independently into 12 functions that
// build HTML email bodies. Eleven of the twelve escaped the same five
// characters (&, <, >, ", '); check-missed-clocks's copy silently dropped
// the apostrophe, so any single-quote-containing value it interpolated
// (a staff or child name, a note) rendered unescaped into that function's
// HTML email — the same class of gap chms's scheduler-html.js had. One
// shared copy means one place for that omission to be possible, not
// twelve.
// ============================================================

export function escHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
