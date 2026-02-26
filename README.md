# Childcare Registration Portal — Setup Guide

## Overview

| Layer    | Service              | Cost  |
|----------|----------------------|-------|
| Database | Supabase             | Free  |
| Hosting  | Cloudflare Pages     | Free  |
| Code     | GitHub               | Free  |

---

## STEP 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up / log in.
2. Click **New project**, give it a name (e.g. `childcare-portal`), set a database password, click **Create project**.
3. Wait ~1 minute for it to spin up.

---

## STEP 2 — Create the Database Tables

1. In your Supabase project, click **SQL Editor** in the left sidebar.
2. Paste the following SQL and click **Run**:

```sql
-- Stores parent/child info for each registration
CREATE TABLE registrations (
    id            BIGSERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    parent_name   TEXT NOT NULL,
    parent_email  TEXT NOT NULL,
    parent_phone  TEXT NOT NULL,
    child_name    TEXT NOT NULL,
    child_age     INT  NOT NULL,
    room_id       TEXT NOT NULL
);

-- Stores individual care dates linked to a registration
CREATE TABLE registration_dates (
    id                BIGSERIAL PRIMARY KEY,
    registration_id   BIGINT REFERENCES registrations(id) ON DELETE CASCADE,
    room_id           TEXT NOT NULL,
    care_date         DATE NOT NULL,
    waitlisted        BOOLEAN DEFAULT FALSE
);

-- Allow the website to read/write (uses the anon key)
ALTER TABLE registrations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public insert" ON registrations      FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow public insert" ON registration_dates FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow public select" ON registration_dates FOR SELECT TO anon USING (true);
```

---

## STEP 3 — Get Your Supabase Keys

1. In your Supabase project, go to **Settings → API**.
2. Copy:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **anon / public key** (long string starting with `eyJ…`)

---

## STEP 4 — Add Your Keys to the Code

Open `js/supabase.js` and replace the two placeholder values:

```js
const SUPABASE_URL    = 'YOUR_SUPABASE_URL';   // ← paste Project URL here
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // ← paste anon key here
```

---

## STEP 5 — Customise Rooms & Capacity

In `js/supabase.js`, edit the `ROOMS` array to match your actual rooms:

```js
const ROOMS = [
    { id: 'infants',    label: 'Infants',    ages: '0–12 months', capacity: 6  },
    { id: 'toddlers',   label: 'Toddlers',   ages: '1–3 years',   capacity: 10 },
    { id: 'preschool',  label: 'Preschool',  ages: '3–5 years',   capacity: 15 },
    { id: 'school_age', label: 'School Age', ages: '5+ years',    capacity: 20 },
];
```

---

## STEP 6 — Change the Admin Password

Open `js/admin.js` and change line 7:

```js
const ADMIN_PASSWORD = 'childcare2024';  // ← change this!
```

---

## STEP 7 — Push to GitHub

1. Create a new **private** GitHub repository (e.g. `childcare-portal`).
2. Push this project folder to it:

```bash
cd childcare-portal
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/childcare-portal.git
git push -u origin main
```

---

## STEP 8 — Deploy on Cloudflare Pages

1. Log into [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages → Create application → Pages → Connect to Git**.
3. Select your GitHub repo and click **Begin setup**.
4. Settings:
   - **Framework preset**: None
   - **Build command**: *(leave blank)*
   - **Build output directory**: `/` (or leave blank)
5. Click **Save and Deploy**.

Cloudflare will give you a URL like `https://childcare-portal.pages.dev` — that's your live link!

Every time you push to GitHub, Cloudflare automatically re-deploys.

---

## STEP 9 — (Optional) Custom Domain

In Cloudflare Pages → your project → **Custom domains**, add your own domain (e.g. `register.yourcentre.com`).

---

## Day-to-Day Usage

### Parents
- Visit your Cloudflare Pages URL
- Fill in their details, select a room, pick dates, submit

### You (Admin)
- Go to `your-site.pages.dev/admin.html`
- Log in with your admin password
- View all registrations, filter by room or status
- Click **Export CSV** to open in Google Sheets
- Click **Export Excel** to download a `.xlsx` file

---

## File Structure

```
childcare-portal/
├── index.html          Parent registration form
├── admin.html          Admin dashboard (password protected)
├── css/
│   ├── styles.css      Shared styles (portal)
│   └── admin.css       Admin-specific styles
└── js/
    ├── supabase.js     Database config + API functions  ← edit YOUR KEYS here
    ├── app.js          Portal logic (calendar, form)
    └── admin.js        Admin logic (table, export)      ← edit PASSWORD here
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Calendar shows no availability colours | Select a room first |
| Submissions not saving | Check Supabase URL & anon key in `js/supabase.js` |
| Admin page says "Failed to load" | Check RLS policies were created in Step 2 |
| Export button doesn't work | Allow popups in your browser |
