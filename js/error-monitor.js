// ============================================================
// CLIENT ERROR MONITOR
// ============================================================
// Captures uncaught JS errors and unhandled promise rejections and reports
// them to the `client_error_log` Supabase table so admins can diagnose
// production issues without waiting for a parent to call the office.
//
// Behaviour:
//   - Runs silently; never interrupts the user or throws its own errors
//   - Throttled to MAX_ERRORS per page load to prevent flooding
//   - Only reports after sbClient is initialised (defined in supabase.js)
//   - Strips long strings to stay within column limits
//
// Admins can view recent errors by querying `client_error_log` in the
// Supabase SQL editor:
//   SELECT occurred_at, page, message, context
//   FROM   client_error_log
//   ORDER  BY occurred_at DESC
//   LIMIT  50;
// ============================================================

(function () {
    'use strict';

    const MAX_ERRORS  = 5;   // max reports per page load
    const MAX_MSG     = 500;
    const MAX_STACK   = 2000;
    const MAX_UA      = 300;

    let _errorCount = 0;

    /**
     * Sends an error report to Supabase. Best-effort — never throws.
     * @param {string}      message
     * @param {string|null} stack
     * @param {Object|null} context
     */
    function reportError(message, stack, context) {
        if (_errorCount >= MAX_ERRORS) return;
        _errorCount++;

        // Resolve whichever Supabase client is available on this page:
        //   sbClient — used by supabase.js (portal / admin / lookup pages)
        //   sb       — used inline by clockin.html
        // If neither is ready (e.g. preview mode / Supabase paused), skip silently.
        const client =
            (typeof sbClient !== 'undefined' && sbClient) ||
            (typeof sb       !== 'undefined' && sb)       ||
            null;
        if (!client) return;

        try {
            client
                .from('client_error_log')
                .insert({
                    page:       window.location.pathname,
                    message:    String(message).slice(0, MAX_MSG),
                    stack:      stack ? String(stack).slice(0, MAX_STACK) : null,
                    user_agent: navigator.userAgent.slice(0, MAX_UA),
                    context:    context || null,
                })
                .then(function (res) {
                    if (res.error) {
                        console.warn('[error-monitor] failed to log error:', res.error.message);
                    }
                });
        } catch (_) { /* non-fatal */ }
    }

    // Uncaught synchronous errors
    window.addEventListener('error', function (event) {
        reportError(
            event.message,
            event.error?.stack || null,
            {
                filename: event.filename || null,
                line:     event.lineno  || null,
                col:      event.colno   || null,
            }
        );
    });

    // Unhandled promise rejections (e.g. a Supabase fetch that throws)
    window.addEventListener('unhandledrejection', function (event) {
        const reason  = event.reason;
        const message = reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection');
        const stack   = reason instanceof Error ? reason.stack   : null;
        reportError(message, stack, { type: 'unhandledrejection' });
    });
})();
