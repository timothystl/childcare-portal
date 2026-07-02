// ============================================================
// PUBLIC "STILL INTERESTED?" RESPONSE PAGE (from tour-reminder emails)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const token = new URLSearchParams(window.location.search).get('token');
    const promptEl = document.getElementById('ciPrompt');
    const resultEl = document.getElementById('ciResult');
    const errorEl  = document.getElementById('ciError');

    if (!token) {
        showResult(false, 'Invalid Link', 'This confirmation link is missing information. Please use the link from your email, or contact us directly.');
        return;
    }

    document.getElementById('ciYesBtn').addEventListener('click', () => respond(true));
    document.getElementById('ciNoBtn').addEventListener('click', () => {
        if (!confirm('Let us know you no longer need care and remove your spot on the waitlist?')) return;
        respond(false);
    });

    async function respond(interested) {
        document.getElementById('ciYesBtn').disabled = true;
        document.getElementById('ciNoBtn').disabled = true;
        errorEl.classList.add('hidden');
        try {
            const res = await confirmWaitlistInterest(token, interested);
            const childName = res?.childName || 'your child';
            if (interested) {
                showResult(true, 'Thanks for Confirming!', `Great — ${childName} stays on our waitlist. We'll be in touch about a tour and let you know as soon as a spot opens up.`);
            } else {
                showResult(true, 'Got It', `We've removed ${childName} from the waitlist. If your plans change, you're always welcome to apply again.`);
            }
        } catch (err) {
            errorEl.textContent = 'Something went wrong: ' + err.message;
            errorEl.classList.remove('hidden');
            document.getElementById('ciYesBtn').disabled = false;
            document.getElementById('ciNoBtn').disabled = false;
        }
    }

    function showResult(success, title, msg) {
        promptEl.classList.add('hidden');
        resultEl.classList.remove('hidden');
        document.getElementById('ciResultIcon').textContent = success ? '✓' : '⚠';
        document.getElementById('ciResultTitle').textContent = title;
        document.getElementById('ciResultMsg').textContent = msg;
    }
});
