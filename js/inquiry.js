// ============================================================
// PUBLIC WAITLIST INQUIRY FORM (standalone, shareable page)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const form      = document.getElementById('inquiryForm');
    const isUnborn  = document.getElementById('iqIsUnborn');
    const dobRow    = document.getElementById('iqDobRow');
    const dueRow    = document.getElementById('iqDueRow');
    const hasSib    = document.getElementById('iqHasSibling');
    const sibFields = document.getElementById('iqSiblingFields');
    const errorEl   = document.getElementById('iqError');

    populateSiblingRoomSelect(document.getElementById('iqSiblingRoom'));

    isUnborn.addEventListener('change', () => {
        const unborn = isUnborn.checked;
        dobRow.classList.toggle('hidden', unborn);
        dueRow.classList.toggle('hidden', !unborn);
        document.getElementById('iqChildDob').required = !unborn;
        document.getElementById('iqDueDate').required  = unborn;
    });

    hasSib.addEventListener('change', () => {
        sibFields.classList.toggle('hidden', !hasSib.checked);
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        errorEl.classList.add('hidden');
        const btn = document.getElementById('iqSubmitBtn');

        const days = [...document.querySelectorAll('.iqDay:checked')].map(cb => cb.value);
        if (!days.length) { showInquiryError('Please select at least one day.'); return; }

        const parentName  = document.getElementById('iqParentName').value.trim();
        const parentEmail = document.getElementById('iqParentEmail').value.trim();
        const childName   = document.getElementById('iqChildName').value.trim();
        const startDate   = document.getElementById('iqStartDate').value;
        if (!parentName || !parentEmail || !childName || !startDate) {
            showInquiryError('Please fill in all required fields.');
            return;
        }

        const isUnbornChecked = isUnborn.checked;
        const childDob = isUnbornChecked ? null : (document.getElementById('iqChildDob').value || null);
        const dueDate  = isUnbornChecked ? (document.getElementById('iqDueDate').value || null) : null;
        if (isUnbornChecked && !dueDate) { showInquiryError('Please enter an expected due date.'); return; }
        if (!isUnbornChecked && !childDob) { showInquiryError("Please enter the child's date of birth."); return; }

        const dayType = document.querySelector('input[name="iqDayType"]:checked').value;

        const payload = {
            parent_name:        parentName,
            parent_email:       parentEmail,
            parent_phone:       document.getElementById('iqParentPhone').value.trim() || null,
            child_name:         childName,
            child_dob:          childDob,
            expected_due_date:  dueDate,
            desired_start_date: startDate,
            start_flexibility:  document.getElementById('iqFlexibility').value,
            days_of_week:       days.join(','),
            day_type:           dayType,
            has_sibling:        hasSib.checked,
            sibling_child_name: hasSib.checked ? (document.getElementById('iqSiblingName').value.trim() || null) : null,
            sibling_room_id:    hasSib.checked ? (document.getElementById('iqSiblingRoom').value || null) : null,
            notes:              document.getElementById('iqNotes').value.trim() || null,
            status:             'pending',
        };

        btn.disabled = true;
        btn.textContent = 'Submitting…';

        try {
            const result = await submitWaitlistApplication(payload);

            // Best-effort — the waitlist entry is already saved even if the
            // confirmation email fails to send.
            sendWaitlistConfirmationEmail(result.id).catch(() => {});

            document.getElementById('inquiryFormScreen').classList.add('hidden');
            document.getElementById('inquirySuccessScreen').classList.remove('hidden');
            document.getElementById('inquirySuccessDetails').textContent =
                `${childName} has been added to our waitlist. We'll contact you at ${parentEmail}.`;
            document.getElementById('inquiryTimestamp').textContent =
                new Date(result.applied_at || Date.now()).toLocaleString([], {
                    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
                });
        } catch (err) {
            showInquiryError('Submission failed: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Join Waitlist';
        }
    });

    function showInquiryError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
        errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
});
