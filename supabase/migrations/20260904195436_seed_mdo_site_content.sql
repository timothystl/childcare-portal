-- Seeds the three first-slice sections with EXACTLY what index.html renders
-- today, so the editor opens showing the real page rather than a blank form.
--
-- ⚠ DRAFT ONLY — `published` is deliberately left NULL. A section that has
-- never been published makes the public reader fall back to the page's own
-- hardcoded markup, so applying this changes nothing a visitor sees. The
-- office opens the editor, reads the draft against the live page, and presses
-- Publish when they agree it matches. Same rule the church site's own page
-- seeds follow.
--
-- ⚠ ON CONFLICT DO NOTHING — this file is safe to re-run and can never
-- overwrite an edit somebody has already made.

INSERT INTO mdo_site_content (section, draft, updated_by) VALUES
('hero', $json$
{
  "eyebrow": "Lindenwood Park · St. Louis, MO",
  "heading": "Mother's Day Out in St. Louis — a warm, safe place for your child to",
  "headingEmphasis": "grow.",
  "body": "Timothy Lutheran's Mother's Day Out program provides loving, faith-centered care for children from birth through preschool — flexible days, small classrooms, and a community that feels like family.",
  "primaryLabel": "📋 Enroll Your Child",
  "primaryHref": "#enroll",
  "secondaryLabel": "📅 Request Care Days",
  "secondaryHref": "/calendar",
  "cardHoursLabel": "Program hours",
  "cardHours": "8:15 am to 5:00 pm",
  "cardDays": "Monday – Friday, year round",
  "cardFullDayUntil": "5:00 pm",
  "cardHalfDayUntil": "1:00 pm",
  "cardAddress": "6704 Fyler Ave · St. Louis, MO 63139",
  "bannerText": "✨ New this year: Request your care days online — no paper forms needed.",
  "bannerLinkLabel": "See how it works →",
  "bannerHref": "#how-it-works",
  "bannerVisible": true
}
$json$::jsonb, '(seed)'),

('contact', $json$
{
  "label": "Contact Us",
  "title": "We'd love to hear from you.",
  "subtitle": "Questions about enrollment, care days, or the program? Reach out to our director and we'll get back to you promptly.",
  "email": "mdo@timothystl.org",
  "phone": "314-783-0523",
  "addressLine1": "6704 Fyler Ave",
  "addressLine2": "St. Louis, MO 63139",
  "mapNote": "We're at the corner of Fyler & Ivanhoe in Lindenwood Park, an easy drive from Clifton Heights, Ellendale, Franz Park, Dogtown, The Hill, St. Louis Hills, and Southampton."
}
$json$::jsonb, '(seed)'),

('faqs', $json$
{
  "label": "Common Questions",
  "title": "Things families ask us.",
  "items": [
    { "q": "Do I have to commit to the same days every week?",
      "a": "No — that's one of the things families love about MDO. You request days month by month based on what works for your schedule. There's no fixed weekly requirement. <em>Note: infants in the Bear Room use a set-day schedule — see the Infant Program section below.</em>",
      "visible": true },
    { "q": "How do full days and half days work?",
      "a": "Full Day is 8:15 am to 5:00 pm. Half Day is 8:15 am to 1:00 pm. You can mix and match on a day-by-day basis when you request your dates online.",
      "visible": true },
    { "q": "What if a day is full when I try to book?",
      "a": "The portal shows live availability. Fully booked days will appear as unavailable. You can join the online waitlist through the care day portal for the fastest notification when a spot opens.",
      "visible": true },
    { "q": "Is the program open to families outside the church?",
      "a": "Absolutely. Timothy Lutheran MDO welcomes all families, regardless of religious affiliation. Our faith values shape our culture of care — all children and parents are welcome here.",
      "visible": true },
    { "q": "How do I get my 4-digit family PIN?",
      "a": "Your PIN is assigned when you enroll and shared with you by the office. If you can't remember it, you can also look up your family by name or email address in the portal.",
      "visible": true },
    { "q": "My child is on the waitlist. What happens next?",
      "a": "When a spot opens in your child's age group, the office will reach out directly. You can also join the online waitlist through the care day portal for the fastest notification, or <a href=\"/waitlist-status\">check your waitlist status</a> anytime using the email you applied with.",
      "visible": true }
  ],
  "infantVisible": true,
  "infantLabel": "Bear Room — Birth to 12 Months",
  "infantTitle": "Infant Program: What to Know",
  "infantIntro": [
    "Our infant room is a nurturing, peaceful environment where your baby is cared for with love, attention, and intention. We believe these early months are so special, which is why we focus on gentle, one-on-one care to help each child feel safe, secure, and truly known.",
    "Throughout the day, your little one will enjoy meaningful interactions including songs, pat-a-cake, cuddles, and engaging moments that support early development. We take pride in creating a calm, loving space where your baby can grow, explore, and thrive at their own pace."
  ],
  "infantItems": [
    { "q": "How does scheduling work for infants?",
      "a": "The infant program uses a <strong>set-day schedule</strong> rather than our flexible monthly request system. At initial enrollment you choose the specific days of the week your child will attend, and those days remain fixed for as long as your child is in the Bear Room. <strong>A minimum of two set days per week is required</strong> — this allows infants to build familiarity with their caregivers and daily routine. Once your child turns one and moves to the next classroom, they transition to the standard flexible schedule.",
      "visible": true },
    { "q": "Can I add extra days beyond my set schedule?",
      "a": "You may request additional days in a given month if space is available in the infant room — just reach out to the office. Additional days are not guaranteed and are offered on a space-available basis only.",
      "visible": true },
    { "q": "What do I need to bring for feeding?",
      "a": "Families are asked to send <strong>premade bottles</strong> each day to ensure feeding routines are smooth and tailored to your baby's needs. Formula must arrive premixed and ready to serve. Breast milk must be brought in labeled bottles or storage bags with your child's name and the date. Please label every bottle clearly with your child's full name. Staff will not mix or prepare formula on-site.",
      "visible": true },
    { "q": "What diapering supplies should I send?",
      "a": "Please supply an adequate number of <strong>diapers</strong> for the day as well as any <strong>diaper cream</strong> your child uses. Wipes are provided by the center — you do not need to bring those.",
      "visible": true },
    { "q": "How does nap time work in the infant room?",
      "a": "All infants in the Bear Room follow a <strong>center-set nap schedule</strong>. Every baby naps at the same time each day, on the schedule established by our staff. Individual on-demand nap schedules are not accommodated, as a consistent routine supports the development of all infants in the room.",
      "visible": true },
    { "q": "When does my child move out of the infant room?",
      "a": "Children transition out of the Bear Room when they turn <strong>one year old</strong>. At that point they move to the Bee Room (12–24 months) and gain access to the flexible monthly scheduling system used throughout the rest of the MDO program.",
      "visible": true }
  ]
}
$json$::jsonb, '(seed)')

ON CONFLICT (section) DO NOTHING;
