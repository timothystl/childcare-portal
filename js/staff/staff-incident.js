// ============================================================
// staff-incident — the incident report, and its three signatures
// ============================================================
// The most specified screen in the design handoff, and the one with the most
// behavior decided for it rather than left to the build. The decisions, and
// what each one costs if it is quietly dropped:
//
//   1. TWO TIMESTAMPS, NEVER ONE. `occurred_at` is what the teacher sets and
//      `filed_at` is what the app stamps. A report written up 28 minutes after
//      a fall must say 10:12, not 10:40 — the gap between them is information
//      (how long before anyone wrote it down), and collapsing them destroys it.
//
//   2. NO BACK-DATE LIMIT. The teacher steps by the minute and may pick a
//      different day. The only bound is the one the handoff states: not in the
//      future. Both halves are enforced in the database too — the RPC clamps
//      with LEAST(p_occurred_at, now()) — because a client-side bound is a
//      suggestion.
//
//   3. FILING IS SIGNING. There is no separate "sign" step for the teacher.
//      Submitting writes signature 1 from the PIN holder, server-side, so the
//      name on the signature is the credential that filed it and not a string
//      the form sent along.
//
//   4. PRINT IS GATED ON ALL THREE, IN ORDER. The button here is decoration:
//      the document comes from incident_print_record(), which refuses to
//      assemble one until teacher, parent and director have all signed. There
//      is deliberately no client-side path to a printable copy — a half-signed
//      report cannot leave the building, and a screenshot of this screen is not
//      a report.
//
// ⚠️ Filing does NOT publish the report to the family. It stamps
// parent_notified_at and pushes a no-detail "come and see us" notice; the
// readable report appears in the parent's Documents only when the director
// signs. That split is deliberate — see the header of
// incident_three_signatures.sql for why both halves are true at once.

// ── Form state ──────────────────────────────────────────────
// Kept in one object rather than read off the DOM at submit time: the body map
// and the chip groups have no form control to read, and a half-built report
// that survives an accidental scroll is worth more than tidiness.
let slIncState = null;
let slIncReport = null;   // { id, signatures: [...] } once filed

const SL_INC_TYPES = [
    { label: 'Fall',          type: 'injury'   },
    { label: 'Bump / bruise', type: 'injury'   },
    { label: 'Bite',          type: 'injury'   },
    { label: 'Scratch',       type: 'injury'   },
    { label: 'Illness',       type: 'illness'  },
    { label: 'Other',         type: 'other'    },
];

// Minutes back from now. "Before lunch" is 190 in the prototype — roughly
// mid-morning from an afternoon write-up, which is when it gets used.
const SL_INC_TIME_CHIPS = [
    { label: 'Just now',    mins: 0   },
    { label: '15 min ago',  mins: 15  },
    { label: 'An hour ago', mins: 60  },
    { label: 'Before lunch', mins: 190 },
];

const SL_INC_AID = ['Cold pack', 'Comfort / rest', 'Cleaned', 'Bandage', 'None needed'];

const SL_INC_AFTER = [
    'Back to playing within 5 minutes',
    'Parent called at the time',
    'Medical attention recommended',
];

const SL_BODY_CHIPS = ['Forehead', 'Knee', 'Elbow', 'Lip', 'Hand', 'Back of head'];

// Tap zones as percentages of the figure box. Each zone that has a side is
// split down the middle, so tapping the left half of "arm" writes "Arm, left
// side" — the handoff's rule, and the reason the map beats a text field.
const SL_BODY_ZONES = {
    front: [
        { name: 'Head',     top: 2,  height: 13, sided: false },
        { name: 'Face',     top: 8,  height: 8,  sided: true  },
        { name: 'Shoulder', top: 17, height: 7,  sided: true  },
        { name: 'Arm',      top: 24, height: 20, sided: true  },
        { name: 'Torso',    top: 22, height: 22, sided: false, left: 32, width: 36 },
        { name: 'Hand',     top: 44, height: 8,  sided: true  },
        { name: 'Hip',      top: 44, height: 8,  sided: false, left: 32, width: 36 },
        { name: 'Leg',      top: 52, height: 30, sided: true  },
        { name: 'Foot',     top: 82, height: 10, sided: true  },
    ],
    back: [
        { name: 'Back of head', top: 2,  height: 13, sided: false },
        { name: 'Neck',         top: 15, height: 5,  sided: false, left: 40, width: 20 },
        { name: 'Shoulder',     top: 17, height: 7,  sided: true  },
        { name: 'Arm',          top: 24, height: 20, sided: true  },
        { name: 'Back',         top: 22, height: 22, sided: false, left: 32, width: 36 },
        { name: 'Hand',         top: 44, height: 8,  sided: true  },
        { name: 'Bottom',       top: 44, height: 8,  sided: false, left: 32, width: 36 },
        { name: 'Leg',          top: 52, height: 30, sided: true  },
        { name: 'Heel',         top: 82, height: 10, sided: true  },
    ],
};

function slIncEl(id) { return document.getElementById(id); }

function slIncFreshState() {
    const now = new Date();
    return {
        occurred:  new Date(now),      // stepped by the minute, never past now
        typeIx:    0,
        bodyView:  'front',
        bodyPart:  '',
        aid:       new Set(),
        after:     new Set(),
        witnesses: [],
    };
}

// ── Time ────────────────────────────────────────────────────

function slIncFmtTime(d) {
    return d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    }).replace(/\s?([AP])M/i, (_, p) => p.toLowerCase());
}

function slIncFmtDay(d) {
    return d.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago',
    });
}

// One minute per press, and never into the future. The floor is deliberately
// absent: a teacher may legitimately be filing yesterday's bite this morning.
function slIncStepTime(deltaMins) {
    const next = new Date(slIncState.occurred.getTime() + deltaMins * 60000);
    if (next.getTime() > Date.now()) {
        slToast('That would be in the future.', 'err');
        return;
    }
    slIncState.occurred = next;
    slIncRenderTime();
}

function slIncRenderTime() {
    const d = slIncState.occurred;
    slIncEl('slIncTimeVal').textContent = `${slIncFmtTime(d)} · ${slIncFmtDay(d)}`;

    // The date input wants a local YYYY-MM-DD, and toISOString() would hand it
    // a UTC one — an evening incident would show as tomorrow.
    const pad = n => String(n).padStart(2, '0');
    slIncEl('slIncDate').value =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    slIncEl('slIncTimeChips').querySelectorAll('[data-mins]').forEach(chip => {
        const target = Date.now() - Number(chip.dataset.mins) * 60000;
        // "Selected" means within the minute — stepping away from a chip must
        // visibly deselect it or the chips start lying about the stored time.
        chip.classList.toggle('is-on', Math.abs(target - d.getTime()) < 60000);
    });
}

// ── Body map ────────────────────────────────────────────────

function slIncRenderBody() {
    const fig = slIncEl('slIncBodyFigure');
    const view = slIncState.bodyView;

    // Drawn inline rather than dropped in as an asset: it has to scale on a
    // phone, read in both the cream app and on the printed sheet, and carry tap
    // zones positioned against the same coordinate space.
    const outline = view === 'front' ? `
        <circle cx="50" cy="11" r="9"/>
        <path d="M50 20 C40 20 33 25 32 34 L29 56 C29 59 34 59 34 56 L36 42 L36 60
                 L34 88 C34 92 40 92 41 88 L45 62 L50 62 L55 62 L59 88
                 C60 92 66 92 66 88 L64 60 L64 42 L66 56 C66 59 71 59 71 56 L68 34
                 C67 25 60 20 50 20 Z"/>` : `
        <circle cx="50" cy="11" r="9"/>
        <path d="M50 20 C40 20 33 25 32 34 L29 56 C29 59 34 59 34 56 L36 42 L36 60
                 L34 88 C34 92 40 92 41 88 L45 62 L50 62 L55 62 L59 88
                 C60 92 66 92 66 88 L64 60 L64 42 L66 56 C66 59 71 59 71 56 L68 34
                 C67 25 60 20 50 20 Z"/>
        <line x1="50" y1="22" x2="50" y2="60"/>`;

    const zones = SL_BODY_ZONES[view].map(z => {
        if (!z.sided) {
            return `<button type="button" class="sl-zone" data-part="${escHtml(z.name)}"
                     style="top:${z.top}%;height:${z.height}%;left:${z.left ?? 20}%;width:${z.width ?? 60}%"
                     title="${escHtml(z.name)}" aria-label="${escHtml(z.name)}"></button>`;
        }
        return ['left', 'right'].map(side => {
            // The child in the drawing faces the viewer, so the viewer's left
            // half is the CHILD's right side. Getting this backwards puts the
            // injury on the wrong arm in a licensing record.
            const childSide = view === 'front'
                ? (side === 'left' ? 'right' : 'left')
                : side;
            const label = `${z.name}, ${childSide} side`;
            return `<button type="button" class="sl-zone" data-part="${escHtml(label)}"
                     style="top:${z.top}%;height:${z.height}%;left:${side === 'left' ? 6 : 56}%;width:38%"
                     title="${escHtml(label)}" aria-label="${escHtml(label)}"></button>`;
        }).join('');
    }).join('');

    fig.innerHTML = `
        <svg viewBox="0 0 100 100" class="sl-body-svg" aria-hidden="true"
             preserveAspectRatio="xMidYMid meet">${outline}</svg>
        ${zones}`;

    fig.querySelectorAll('.sl-zone').forEach(b => {
        b.classList.toggle('is-on', b.dataset.part === slIncState.bodyPart);
        b.onclick = () => { slIncState.bodyPart = b.dataset.part; slIncRenderBodyPart(); };
    });

    slIncEl('slIncBodyViews').querySelectorAll('[data-view]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.view === view));
}

function slIncRenderBodyPart() {
    const part = slIncState.bodyPart;
    const pill = slIncEl('slIncBodyPart');
    pill.textContent = part || 'Not marked';
    pill.classList.toggle('is-set', !!part);

    slIncEl('slIncBodyFigure').querySelectorAll('.sl-zone').forEach(b =>
        b.classList.toggle('is-on', b.dataset.part === part));
    slIncEl('slIncBodyChips').querySelectorAll('[data-chip]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.chip === part));
}

// ── Chip groups ─────────────────────────────────────────────

function slIncRenderChips() {
    slIncEl('slIncTimeChips').innerHTML = SL_INC_TIME_CHIPS.map(c =>
        `<button type="button" class="sl-inc-chip" data-mins="${c.mins}">${escHtml(c.label)}</button>`
    ).join('');
    slIncEl('slIncTimeChips').querySelectorAll('[data-mins]').forEach(b => {
        b.onclick = () => {
            slIncState.occurred = new Date(Date.now() - Number(b.dataset.mins) * 60000);
            slIncRenderTime();
        };
    });

    slIncEl('slIncTypeChips').innerHTML = SL_INC_TYPES.map((t, i) =>
        `<button type="button" class="sl-inc-chip" role="radio" data-type="${i}"
                 aria-checked="${i === slIncState.typeIx}">${escHtml(t.label)}</button>`
    ).join('');
    slIncEl('slIncTypeChips').querySelectorAll('[data-type]').forEach(b => {
        b.onclick = () => {
            slIncState.typeIx = Number(b.dataset.type);
            slIncEl('slIncTypeChips').querySelectorAll('[data-type]').forEach(x => {
                const on = Number(x.dataset.type) === slIncState.typeIx;
                x.classList.toggle('is-on', on);
                x.setAttribute('aria-checked', String(on));
            });
            // A bump has a body part; an illness does not. Hiding the map keeps
            // an irrelevant required-looking control off a form used one-handed.
            slIncEl('slIncBodyBlock').classList.toggle(
                'hidden', SL_INC_TYPES[slIncState.typeIx].type !== 'injury');
        };
    });
    slIncEl('slIncTypeChips').querySelector('[data-type="0"]')?.classList.add('is-on');

    slIncEl('slIncBodyViews').innerHTML = ['front', 'back'].map(v =>
        `<button type="button" class="sl-body-view" data-view="${v}" role="radio"
                 aria-checked="${v === 'front'}">${v === 'front' ? 'Front' : 'Back'}</button>`
    ).join('');
    slIncEl('slIncBodyViews').querySelectorAll('[data-view]').forEach(b => {
        b.onclick = () => { slIncState.bodyView = b.dataset.view; slIncRenderBody(); };
    });

    slIncEl('slIncBodyChips').innerHTML = SL_BODY_CHIPS.map(c =>
        `<button type="button" class="sl-inc-chip" data-chip="${escHtml(c)}">${escHtml(c)}</button>`
    ).join('');
    slIncEl('slIncBodyChips').querySelectorAll('[data-chip]').forEach(b => {
        b.onclick = () => { slIncState.bodyPart = b.dataset.chip; slIncRenderBodyPart(); };
    });

    slIncEl('slIncAidChips').innerHTML = SL_INC_AID.map(a =>
        `<button type="button" class="sl-inc-chip" data-aid="${escHtml(a)}">${escHtml(a)}</button>`
    ).join('');
    slIncEl('slIncAidChips').querySelectorAll('[data-aid]').forEach(b => {
        b.onclick = () => {
            const v = b.dataset.aid;
            if (slIncState.aid.has(v)) slIncState.aid.delete(v); else slIncState.aid.add(v);
            b.classList.toggle('is-on', slIncState.aid.has(v));
        };
    });

    slIncEl('slIncAfterChecks').innerHTML = SL_INC_AFTER.map(a =>
        `<label class="sl-inc-check"><input type="checkbox" data-after="${escHtml(a)}">
            <span>${escHtml(a)}</span></label>`
    ).join('');
    slIncEl('slIncAfterChecks').querySelectorAll('[data-after]').forEach(b => {
        b.onchange = () => {
            const v = b.dataset.after;
            if (b.checked) slIncState.after.add(v); else slIncState.after.delete(v);
        };
    });

    slIncRenderWitnesses();
}

// ── Witnesses ───────────────────────────────────────────────
// Free text rather than a staff picker: the witness to a playground fall is
// often a parent, a sub, or the maintenance man, and a picker that only offers
// the roster quietly teaches people to leave the field empty.

function slIncRenderWitnesses() {
    const wrap = slIncEl('slIncWitnesses');
    wrap.innerHTML = slIncState.witnesses.map((w, i) =>
        `<span class="sl-inc-chip is-on">${escHtml(w)}
            <button type="button" class="sl-chip-x" data-drop="${i}"
                    aria-label="Remove ${escHtml(w)}">✕</button></span>`
    ).join('') + `<button type="button" class="sl-inc-chip sl-chip-add" id="slIncAddWitness">+ Add</button>`;

    wrap.querySelectorAll('[data-drop]').forEach(b => {
        b.onclick = () => {
            slIncState.witnesses.splice(Number(b.dataset.drop), 1);
            slIncRenderWitnesses();
        };
    });
    slIncEl('slIncAddWitness').onclick = () => {
        const name = prompt('Who else saw it?');
        const clean = (name || '').trim();
        if (clean) { slIncState.witnesses.push(clean); slIncRenderWitnesses(); }
    };
}

// ── Open / close ────────────────────────────────────────────

function slOpenIncident() {
    if (!slOpenChild) return;
    slIncState  = slIncFreshState();
    slIncReport = null;

    slIncEl('slIncidentChild').textContent = slOpenChild.child_name;
    slIncEl('slIncidentForm').reset();
    slIncEl('slIncidentForm').classList.remove('hidden');
    slIncEl('slIncSigned').classList.add('hidden');
    slIncEl('slIncFiledAt').textContent = slIncFmtTime(new Date());

    slIncRenderChips();
    slIncRenderTime();
    slIncRenderBody();
    slIncRenderBodyPart();

    slIncEl('slIncidentSheet').classList.remove('hidden');
}

function slCloseIncident() {
    slIncEl('slIncidentSheet').classList.add('hidden');
}

// ── Filing ──────────────────────────────────────────────────

async function slSubmitIncident(e) {
    e.preventDefault();
    if (!slOpenChild || !slIncState) return;

    const description = slIncEl('slIncDescription').value.trim();
    const actionTaken = slIncEl('slIncAction').value.trim();
    if (!description) {
        slToast('Describe what happened.', 'err');
        return;
    }

    const chip = SL_INC_TYPES[slIncState.typeIx];
    const aid  = [...slIncState.aid];

    // action_taken is NOT NULL in the table and the RPC rejects an empty one.
    // A teacher who ticked "Cold pack" and typed nothing has in fact told us
    // what they did, so build the sentence rather than blocking on the box.
    const action = actionTaken || (aid.length ? aid.join(', ') : '');
    if (!action) {
        slToast('Say what you did — a chip or a sentence.', 'err');
        return;
    }

    const btn = slIncEl('slIncSubmitBtn');
    btn.disabled = true; btn.textContent = 'Filing…';
    try {
        const id = await submitIncidentReport(slStaffId, slPin, {
            studentId:    slOpenChild.student_id,
            incidentType: chip.type,
            incidentKind: chip.label,
            description,
            actionTaken:  action,
            location:     slIncEl('slIncLocation').value.trim(),
            bodyArea:     slIncState.bodyPart,
            bodyPart:     slIncState.bodyPart,
            bodyView:     chip.type === 'injury' ? slIncState.bodyView : null,
            occurredAt:   slIncState.occurred.toISOString(),
            witnesses:    slIncState.witnesses,
            firstAid:     aid,
            afterNotes:   [...slIncState.after],
            ratioNote:    slIncRatioNote(),
        });
        if (!id) { slToast('The report was not accepted. Check your PIN.', 'err'); return; }

        // Tell the family now, without publishing the report. The push carries
        // no detail on purpose — a lock-screen preview is read in public.
        slNotifyParentOfIncident(id);

        // The name shown here is cosmetic — the stored signature was written
        // server-side from the PIN holder, so this only has to match it.
        slIncReport = { id, signatures: [{ role: 'teacher',
                                           signed_name: slStaff?.name || 'You',
                                           signed_at: new Date().toISOString() }] };
        slIncShowSignatures();
        slToast('Filed and signed. Catch the parent at pickup.', 'ok');
    } catch (err) {
        console.warn('incident:', err);
        slToast('Could not file the report. Try again.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Sign & file this report';
    }
}

// The staff-to-child ratio at the time, printed on the licensing copy. Derived
// from the roster this teacher already has loaded rather than asked for — a
// number a teacher has to count during an incident is a number that gets
// guessed.
function slIncRatioNote() {
    // ⚠️ attendance_status, never checked_in — checked_in stays true after a
    // child has gone home, so it would inflate the ratio recorded on a legal
    // document. Same rule as the head count sheet.
    const kids = Array.isArray(slChildren)
        ? slChildren.filter(c => c.attendance_status === 'present').length : 0;
    return kids ? `${kids} children present in the room at the time` : null;
}

async function slNotifyParentOfIncident(id) {
    try {
        await notifyParentOfIncident(slStaffId, slPin, id);
    } catch (err) {
        // The report is filed either way. A failed notice must not read to the
        // teacher as a failed filing — that is how a report gets written twice.
        console.warn('incident notify (non-fatal):', err);
    }
}

// ── Signatures ──────────────────────────────────────────────

const SL_SIG_ROLES = [
    { role: 'teacher',  n: 1, who: 'Teacher' },
    { role: 'parent',   n: 2, who: 'Parent'  },
    { role: 'director', n: 3, who: 'Director' },
];

function slIncSigFor(role) {
    return (slIncReport?.signatures || []).find(s => s.role === role) || null;
}

function slIncShowSignatures() {
    slIncEl('slIncidentForm').classList.add('hidden');
    slIncEl('slIncSigned').classList.remove('hidden');

    const teacher  = slIncSigFor('teacher');
    const parent   = slIncSigFor('parent');
    const director = slIncSigFor('director');

    slIncEl('slIncSigList').innerHTML = SL_SIG_ROLES.map(r => {
        const sig = slIncSigFor(r.role);
        const time = sig ? ` · signed ${slIncFmtTime(new Date(sig.signed_at))}` : '';

        let status, mark;
        if (sig) {
            status = `${r.who}${time}`;
            mark = `<span class="sl-sig-mark">${escHtml(sig.signed_name)}</span>`;
        } else if (r.role === 'parent') {
            status = `${r.who} · signs on this phone at pickup`;
            mark = `<button type="button" class="sl-sig-go" data-sign="parent">Sign</button>`;
        } else {
            // The director's row is locked while the parent's is open. It says
            // what it is waiting on, so nobody goes looking for her.
            status = `${r.who} · waiting on the parent`;
            mark = `<span class="sl-sig-locked">Locked</span>`;
        }

        return `<div class="sl-sig-row${sig ? ' is-done' : ''}">
            <span class="sl-sig-n">${r.n}</span>
            <span class="sl-sig-who">
                <span class="sl-sig-name">${escHtml(sig ? sig.signed_name : '—')}</span>
                <span class="sl-sig-status">${escHtml(status)}</span>
            </span>
            ${mark}
        </div>`;
    }).join('');

    slIncEl('slIncSigList').querySelector('[data-sign="parent"]')
        ?.addEventListener('click', slOpenParentSign);

    const complete = !!(teacher && parent && director);
    slIncEl('slIncSigBanner').className = complete ? 'sl-sig-banner is-done' : 'sl-sig-banner';
    slIncEl('slIncSigBanner').innerHTML = complete
        ? `<strong>Record complete.</strong> All three signatures are in. The printable
           copy is available here and in the family's Documents.`
        : `<strong>Not complete yet.</strong> You signed, the parent signs at pickup,
           then the director signs to close it. The printable copy unlocks only after
           all three — a half-signed report can't leave the building.`;

    const print = slIncEl('slIncPrintBtn');
    print.disabled    = !complete;
    print.textContent = complete ? '🖨️ Print' : '🔒 Print';

    const parentBtn = slIncEl('slIncParentSignBtn');
    parentBtn.classList.toggle('hidden', !!parent);
}

function slOpenParentSign() {
    if (!slIncReport) return;
    slIncEl('slParentSignIntro').textContent =
        `${slOpenChild?.child_name || 'This child'} — incident report filed ` +
        `${slIncFmtTime(slIncState.occurred)}. Please read it with the teacher before signing.`;
    slIncEl('slParentSignName').value = '';
    slIncEl('slParentSignPreview').textContent = '';
    slIncEl('slParentSignSheet').classList.remove('hidden');
    slIncEl('slParentSignName').focus();
}

function slCloseParentSign() {
    slIncEl('slParentSignSheet').classList.add('hidden');
}

async function slSubmitParentSign() {
    const name = slIncEl('slParentSignName').value.trim();
    if (name.length < 2) { slToast('Type your full name to sign.', 'err'); return; }
    if (!slIncReport) return;

    const btn = slIncEl('slParentSignBtn');
    btn.disabled = true; btn.textContent = 'Signing…';
    try {
        const ok = await signIncidentAsParent(slStaffId, slPin, slIncReport.id, name);
        if (!ok) { slToast('That signature was not accepted.', 'err'); return; }

        slIncReport.signatures.push({
            role: 'parent', signed_name: name, signed_at: new Date().toISOString(),
        });
        slCloseParentSign();
        slIncShowSignatures();
        slToast('Parent signature recorded. The director closes it from here.', 'ok');
    } catch (err) {
        console.warn('parent sign:', err);
        slToast('Could not record that signature. Try again.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Sign';
    }
}

// ── Wiring ──────────────────────────────────────────────────

function slSetupIncident() {
    slIncEl('slIncidentBtn')?.addEventListener('click', slOpenIncident);
    slIncEl('slIncidentCancel')?.addEventListener('click', slCloseIncident);
    slIncEl('slIncidentForm')?.addEventListener('submit', slSubmitIncident);
    slIncEl('slIncDoneBtn')?.addEventListener('click', () => {
        slCloseIncident();
        if (typeof slCloseSheet === 'function') slCloseSheet();
    });

    slIncEl('slIncTimeDown')?.addEventListener('click', () => slIncStepTime(-1));
    slIncEl('slIncTimeUp')?.addEventListener('click',   () => slIncStepTime(1));

    slIncEl('slIncDate')?.addEventListener('change', e => {
        const [y, m, d] = e.target.value.split('-').map(Number);
        if (!y) return;
        const next = new Date(slIncState.occurred);
        next.setFullYear(y, m - 1, d);
        if (next.getTime() > Date.now()) {
            slToast('That day is in the future.', 'err');
            slIncRenderTime();
            return;
        }
        slIncState.occurred = next;
        slIncRenderTime();
    });

    slIncEl('slIncParentSignBtn')?.addEventListener('click', slOpenParentSign);
    slIncEl('slParentSignCancel')?.addEventListener('click', slCloseParentSign);
    slIncEl('slParentSignBtn')?.addEventListener('click', slSubmitParentSign);

    // The cursive preview is the only place Dancing Script appears in the app.
    slIncEl('slParentSignName')?.addEventListener('input', e => {
        slIncEl('slParentSignPreview').textContent = e.target.value.trim();
    });

    // The print button is enabled only when all three signatures exist, and
    // even then the document is fetched from the server — this never renders
    // one from what the phone happens to be holding.
    slIncEl('slIncPrintBtn')?.addEventListener('click', async () => {
        if (!slIncReport) return;
        slToast('Opening the signed copy…', 'ok');
        window.open(`incident-print.html?id=${encodeURIComponent(slIncReport.id)}`, '_blank');
    });
}
