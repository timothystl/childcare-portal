# Privacy, Security & Legal Compliance Overview
## Timothy Lutheran Church — Mother's Day Out Registration Portal

**Prepared:** March 2026
**Audience:** MDO Director, Church Administration, Legal Counsel, Licensing Inspectors
**Purpose:** Plain-language summary of all privacy and security safeguards in the family registration portal, and how the portal addresses applicable legal obligations.

---

## Part 1 — Applicable Laws and Why They Apply

### COPPA — Children's Online Privacy Protection Act (Federal)
COPPA is a U.S. federal law that governs websites and online services that collect personal information about children under the age of 13. Because this portal collects children's names and dates of birth to assign them to age-appropriate classrooms, COPPA applies. The key requirements are:
- Information about children may only be submitted by a parent or legal guardian (not the child themselves).
- The information collected must be limited to what is necessary to operate the service.
- Parents must be able to review and delete the information about their child.

**How this portal complies:** Children do not interact with the portal directly — only parents register and log in. Only name and date of birth are collected for each child. Parents can download all their data and submit a deletion request through the portal.

---

### CCPA — California Consumer Privacy Act (State)
The CCPA grants California residents specific rights over their personal data, including the right to know what is collected, the right to access it, and the right to request deletion. Even for organizations not primarily based in California, maintaining these rights is considered best practice and protects against future exposure.

**How this portal complies:** A published privacy policy explains all data collected. Families can download all their data in one click. Families can request account deletion through the portal. The portal does not sell personal information to any third party.

---

### Missouri Child Care Licensing Requirements (State)
Missouri licensing standards for childcare programs require that facilities maintain accurate enrollment records and protect the privacy of children and families in their care. While there is no specific Missouri law governing web portals, the portal addresses the spirit of these requirements through controlled data access and role-based staff permissions.

> **Note (2026-08-02):** this paragraph previously also cited "a complete audit trail of all administrative actions." See §3.6 — the audit log was never actually operating. Two further qualifications on access control: the read restrictions are narrower than intended (§3.3), and the role-based permissions described in §3.5 are currently enforced in the staff member's browser rather than in the database, so they separate duties in normal use but are not a hard barrier. All three are tracked in `docs/CODE_REVIEW_2026-08.md`.

---

### FERPA Considerations
FERPA (Family Educational Rights and Privacy Act) primarily applies to schools receiving federal education funding. For a church-based MDO program it may not apply directly, but its core principle — that parents have the right to inspect and correct records about their children — is fully honored in this portal's design.

---

## Part 2 — What Personal Data Is Collected and Why

| Data Element | Who It Belongs To | Why It Is Collected |
|---|---|---|
| Parent/Guardian full name | Parent | Identifies the family account; printed on rosters |
| Parent email address | Parent | Registration confirmation emails; contact by staff |
| Parent phone number | Parent | Emergency contact; staff communication |
| Family access PIN | Parent | Secure login to view/edit registrations |
| Child's full name | Child (under 13) | Classroom rosters; identifying the child in care |
| Child's date of birth | Child (under 13) | Determines which age-appropriate room to assign |
| Care schedule selections | Family | Processing registrations; billing; staffing ratios |
| Contact form messages | Parent | Responding to inquiries |

**What is NOT collected:**
- Payment card numbers or banking information (billing is handled offline by the MDO office)
- Social Security numbers
- Medical or health records
- Photos or images of children
- Location data
- Behavioral tracking or advertising data of any kind

---

## Part 3 — Security Safeguards in Plain Language

### 3.1 Encrypted Transmission (HTTPS / TLS)
All data traveling between a parent's browser and the server is encrypted using HTTPS, the same technology used by banks. This is enforced at the Cloudflare edge — it is not possible to access the portal over an unencrypted connection. This means that even if someone were intercepting traffic on a public Wi-Fi network, they could not read any submitted information.

---

### 3.2 Family PINs Are Never Readable — Even by Staff
When a family sets their 4-digit PIN, it is immediately scrambled using a process called "bcrypt hashing" before being saved to the database. The original PIN is discarded and never stored anywhere. When a parent enters their PIN to log in, the system scrambles their input the same way and compares the two scrambled versions — it never compares against the real PIN, because the real PIN no longer exists in any form.

**Practical implication:** If an MDO staff member, a database administrator, or an unauthorized person ever viewed the raw database, they would see thousands of strings like `$2a$12$XK9mQ...` rather than any actual PIN. These scrambled values cannot be reversed directly.

> **Note (2026-08-02):** an earlier version of this section said the scrambled values were "mathematically impossible to reverse." That overstates the protection. Bcrypt cannot be reversed, but a 4-digit PIN has only 10,000 possible values, so anyone holding a copy of the scrambled value could work through all of them offline until one matched. Until 2026-08-02 those scrambled values were readable through the site's public API key; **that access has now been withdrawn** and they are reachable only by an authenticated staff session. The protection is real, but it rests on keeping the scrambled values private — not on the scrambling alone.

---

### 3.3 Database Access Controls (Row-Level Security)
The database uses PostgreSQL Row-Level Security (RLS) policies, which means access rules are enforced by the database itself rather than only by the application deciding what to display. RLS is enabled on every table.

> **⚠️ Known gap — under active remediation (opened 2026-08-02).** The RLS policies currently in force are broader than this section previously described. An earlier version of this document stated that "a family logged in to their account cannot see any other family's records." **That is not accurate today.** The portal's public API key — which is necessarily embedded in every visitor's browser — is currently permitted to read the family and student tables. Family and child records are therefore readable by someone who inspects the site's network traffic, without logging in.
>
> **What has already been fixed (2026-08-02):**
> - Family and staff PIN *hashes* are no longer readable through the public key.
> - The PIN-setting routines can no longer be called without an authenticated staff login. Previously they could be invoked anonymously, which allowed a parent or staff account's PIN to be overwritten by an outsider.
>
> **What remains open:** narrowing the read policies so that a family can retrieve only its own record. This is a staged change — an earlier attempt at a blanket tightening broke parent login and had to be reversed — so it is being done behind server-side functions and smoke-tested before the broad policies are withdrawn. Tracked as R1 in `docs/CODE_REVIEW_2026-08.md`.
>
> This notice will be removed, and the section rewritten, once the remediation is complete and verified. It is stated plainly here rather than omitted because a security overview that overstates its protections is worse than one that names its gaps.

---

### 3.4 Admin Authentication with Automatic Timeout
Accessing the admin dashboard requires a valid staff email address and password, authenticated through Supabase's secure authentication system. Passwords are never stored in the application.

After 30 minutes of inactivity, admin sessions are automatically terminated and the user is required to log in again. This protects against a situation where a staff member walks away from a computer and leaves a sensitive dashboard open.

---

### 3.5 Role-Based Staff Access
Not all staff see the same information. The system supports multiple access roles:

- **Full Admin** — Complete access including payroll, billing reports, all family data, and system settings.
- **Restricted Admin** — Can manage registrations and rosters but cannot see payroll, billing, or system configuration.
- **Staff** — Limited access appropriate for classroom staff.

This "least privilege" approach means a classroom aide does not see billing information or family financial data they have no business reason to see.

> **Note (2026-08-02):** these role restrictions are applied by the dashboard in the staff member's browser, not by the database. In normal use they separate duties as described, but a staff-level account that deliberately used browser developer tools could reach data outside its role. Closing this requires enforcing the roles in the database itself; tracked as R20 in `docs/CODE_REVIEW_2026-08.md`.

---

### 3.6 Complete Admin Activity Audit Log
Every significant action taken by any admin user is automatically recorded in a permanent audit log. This log captures:
- Which admin account performed the action
- What action was taken (e.g., deleted registration, changed billing rate, locked family account)
- Which record was affected (identified by ID, not by displaying personal data)
- The exact date and time it occurred
- The before and after values for any changed fields

**Why this matters legally and operationally:** If a registration is missing, a billing amount appears incorrect, or a staff member is accused of inappropriate access, an audit log provides an authoritative record of exactly what happened and when.

> **⚠️ Correction (2026-08-02), resolved (2026-08-03).** The audit log was **not operating, and never had been**, from launch until 3 August 2026. The application called an audit-recording routine from 26 places, but the database table it writes to was never created — the setup script was written and committed but never run. The recording call was also written to fail quietly, so that an audit problem could never block a staff member mid-task; the failure therefore produced no visible error and went unnoticed.
>
> **Practical implication: no administrative action taken before 3 August 2026 was recorded, and that history cannot be reconstructed.** This section previously described the log as "permanent" and "tamper-evident"; neither was true in practice for that period.
>
> **As of 3 August 2026 the audit log is live and recording.** It was also hardened beyond the original design: the log is readable only by an authenticated staff account and by nobody else, entries are written exclusively by a server-side routine that stamps the staff member's email itself (so it cannot be forged from a browser), and **no staff account — at any access level — can edit or delete an entry once written.** That last point is what makes "tamper-evident" an accurate description rather than an aspiration.
>
> The quiet-failure behaviour has also been changed: an audit failure still never blocks a staff member's work, but it now reports itself loudly, so a broken audit trail cannot go unnoticed again. Tracked as R5 in `docs/CODE_REVIEW_2026-08.md`.

---

### 3.7 XSS Protection — Preventing Malicious Content
The portal protects against a category of web attack called Cross-Site Scripting (XSS). This occurs when an attacker enters malicious computer code into a data field (like a name field) hoping the website will execute it. The portal sanitizes all database content before displaying it — converting any potentially dangerous characters into harmless text. This means a bad actor cannot inject code that could steal other families' sessions or redirect users to fraudulent websites.

---

### 3.8 Server-Enforced Registration Rules
The rule that registration closes after the 15th of each month is enforced in the database itself — not just visually in the browser. Even if someone with technical knowledge attempted to bypass the on-screen lock using browser developer tools, the database would reject the submission. This enforcement cannot be circumvented from a regular browser.

---

### 3.9 Error Monitoring (Operational Security)
A silent background monitor watches for any technical errors on every page of the portal. If something breaks — such as a registration submission failing, a page crashing, or a database query returning an error — it is logged automatically to an admin-viewable error table. This allows staff to discover and fix problems proactively rather than waiting for a parent to report them, reducing the window of time that families might encounter broken features.

---

### 3.10 No Third-Party Advertising or Tracking
The portal does not use advertising cookies, cross-site tracking pixels, or third-party analytics on parent-facing pages. No family data is shared with advertising networks. The only external services used are:

| Service | Purpose | Their Privacy Policy |
|---|---|---|
| **Supabase** | Database, authentication, serverless functions | supabase.com/privacy |
| **Cloudflare** | Web hosting and edge security (CDN) | cloudflare.com/privacypolicy |
| **Google Fonts** | Web fonts (font files loaded from Google's servers) | policies.google.com/privacy |

---

## Part 4 — Family Rights and How They Are Exercised

### Right to Access (Download Your Data)
Any logged-in parent can click "Download My Data" in the My Schedule portal. This generates and downloads a complete record of everything the system holds about their family: parent contact information, children's names and birthdates, and all registration history. No request to the office is required.

### Right to Correction
Families can request corrections to any inaccurate information by emailing mdo@timothystl.org. The MDO office can update records directly from the admin dashboard.

### Right to Deletion
Families can submit a deletion request directly through the portal using the "Request Account Deletion" form, or by emailing mdo@timothystl.org. All deletion requests are handled within 30 days. An admin-facing queue in the dashboard shows all pending deletion requests so nothing falls through the cracks.

**Note on retention exceptions:** Records that are required for legal, financial, or tax purposes may be retained for the minimum period required by law even after a deletion request. The portal's privacy policy discloses this limitation.

### Right to Know We Don't Sell Data
The portal does not sell, rent, or trade personal information to any third party for commercial purposes. This is stated in the published privacy policy and requires no opt-out action by families.

---

## Part 5 — Data Retention

- **Active records** are retained throughout the current program year.
- **Prior year records** are retained for one full program year to support billing reconciliation and attendance reporting if disputes arise.
- **Records older than two program years** may be purged at the MDO director's discretion.
- **Audit logs** may be retained longer as part of the organization's operational record.

---

## Part 6 — Published Privacy Policy

A formal privacy policy is published at the portal address (`/privacy.html`) and is linked from the parent-facing registration pages. It covers:

1. What information is collected
2. How it is used
3. Children's privacy (COPPA compliance statement)
4. Data storage and security measures
5. Data retention periods
6. Family rights (access, correction, deletion, no-sale)
7. Cookies and tracking disclosure
8. Third-party services disclosure
9. Contact information for privacy requests
10. Policy update process

The policy is written in plain English and is accessible without logging in.

---

## Part 7 — Summary of Key Compliance Points

| Requirement | Status | How It Is Met |
|---|---|---|
| COPPA — Parental consent for children's data | Compliant | Only parents register; children do not interact with portal |
| COPPA — Minimal data collection | Compliant | Only name + DOB collected for children |
| COPPA — Parental access and deletion rights | Compliant | Download and deletion tools built into parent portal |
| CCPA — Privacy policy published | Compliant | privacy.html linked from all pages |
| CCPA — Right to access | Compliant | One-click data download in parent portal |
| CCPA — Right to deletion | Compliant | In-portal deletion request form + email option |
| CCPA — No sale of personal data | Compliant | Data not sold; disclosed in privacy policy |
| Secure transmission | Compliant | HTTPS enforced at Cloudflare edge |
| Secure credential storage | Compliant | PINs hashed with bcrypt; admin passwords via Supabase Auth. Hash values were readable via the public API key until 2026-08-02; that access is now withdrawn. |
| Access controls | **Gap — remediation in progress** | RLS enabled on every table, but the public API key can still read family/student records. Closed so far: PIN hashes and PIN-setting routines (2026-08-02); staff wages/PIN hashes, and parent contact messages (2026-08-03). See §3.3 and R1 in `docs/CODE_REVIEW_2026-08.md`. |
| Activity audit trail | Compliant **from 2026-08-03** | The audit table was never created until 3 Aug 2026, so nothing before that date was recorded. Now live, staff-read-only, and not editable or deletable by any staff account. See §3.6. |
| No advertising tracking | Compliant | No ad cookies or tracking pixels on parent pages |

---

## Contact for Privacy Questions

**Timothy Lutheran Church Mother's Day Out**
Email: mdo@timothystl.org
Address: Timothy Lutheran Church, St. Louis, MO

*For questions about this document or the portal's privacy practices, contact the MDO director.*

---

*Document reflects portal state as of March 2026. Should be reviewed and updated whenever significant changes are made to data practices or applicable law changes.*
