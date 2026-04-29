// Self-service PIN reset page. Activated by the link emailed from the
// request-pin-reset Edge Function: /reset-pin.html?token=...
(() => {
    const form     = document.getElementById('resetForm');
    const success  = document.getElementById('resetSuccess');
    const errorEl  = document.getElementById('resetError');
    const newPin   = document.getElementById('newPin');
    const confirm  = document.getElementById('confirmPin');
    const button   = document.getElementById('resetBtn');

    const params = new URLSearchParams(window.location.search);
    const token  = params.get('token') || '';

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
    }
    function clearError() {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }

    if (!token) {
        showError('This reset link is missing its token. Open the link from the email instead of typing the URL.');
        button.disabled = true;
        return;
    }

    [newPin, confirm].forEach(el => el.addEventListener('input', clearError));
    [newPin, confirm].forEach(el => el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }));
    button.addEventListener('click', submit);

    async function submit() {
        clearError();
        const a = newPin.value.trim();
        const b = confirm.value.trim();

        if (!/^\d{4,8}$/.test(a)) { showError('PIN must be 4 to 8 digits.'); return; }
        if (a !== b)              { showError('PINs do not match.');         return; }

        button.disabled    = true;
        button.textContent = 'Saving…';

        try {
            // sbClient is declared with `let` in js/supabase.js — script-scoped,
            // accessible by name from another script tag in the same document.
            if (typeof sbClient === 'undefined' || !sbClient) throw new Error('not_configured');
            const { data, error } = await sbClient.rpc('consume_pin_reset', {
                p_token:   token,
                p_new_pin: a,
            });
            if (error) throw error;
            if (data?.error) {
                const msg = ({
                    invalid_token:      'This reset link is no longer valid. Request a new one from the sign-in page.',
                    token_already_used: 'This reset link has already been used. Request a new one if you need to reset again.',
                    token_expired:      'This reset link has expired. Request a new one from the sign-in page.',
                    invalid_pin_format: 'PIN must be 4 to 8 digits.',
                })[data.error] || 'We could not reset your PIN. Please request a new link.';
                showError(msg);
                return;
            }

            form.classList.add('hidden');
            success.classList.remove('hidden');
        } catch (_err) {
            showError('Something went wrong. Please request a new reset link.');
        } finally {
            button.disabled    = false;
            button.textContent = 'Set New PIN';
        }
    }

})();
