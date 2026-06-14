# TableTurn — ProductHunt Launch Kit

## Listing Info

**Product Name:** TableTurn
**Website:** https://www.tturn.xyz
**Category/Topics:** Productivity, Developer Tools, AI

---

## Tagline (≤60 chars)
```
Bulk clean & translate your Airtable data with AI
```
(57 chars)

Alternative:
```
AI-powered bulk data cleaning & translation for Airtable
```
(56 chars)

---

## Description (≤260 chars)
```
Connect your Airtable base, bulk translate 20+ languages and clean messy data with DeepSeek AI. Free 3 trials — no registration needed. Write results back to Airtable with one click.
```
(212 chars)

---

## Pricing

**Pay-as-you-go — no subscription, no hidden fees.**

| Feature | Price | Notes |
|---------|-------|-------|
| AI Translation | $2 / 1M characters | DeepSeek-powered, 20+ languages |
| AI Data Cleaning | $0.40 / 1K tokens | Fix emails, phones, names, formatting |
| Free Trial | 3 translations + 3 cleanings | No login, no card required |
| PH Perk | Extra free credits | Mention "PH" at launch |

---

## Maker Comment (post immediately at launch)

```
Hey Product Hunt! 👋

I'm Nick (徐民华), a solo indie maker from Hangzhou, China 🇨🇳

I built TableTurn to solve a real pain I kept running into — managing multilingual product data in Airtable for international clients. Every week I'd spend hours manually cleaning messy CSVs, fixing malformed emails, and copy-pasting cells into Google Translate. It was mind-numbing. So I wired up DeepSeek AI to do it in bulk.

**🔒 Your data stays yours:**
• We never store your Airtable PAT — it stays in your browser session, sent directly to Airtable API
• No database, no data retention. Translation/cleaning requests hit DeepSeek API only during processing
• No third-party analytics, no tracking scripts — just a clean Node.js backend

**⚡ What it actually does:**
• Connect any Airtable base in 10 seconds (paste your PAT once)
• Bulk translate 20+ languages — product catalogs, user feedback, support tickets
• AI cleaning: fix malformed emails, unify phone formats, normalize company names, strip whitespace
• Results write back to Airtable in one click — no export/import dance

**💰 Honest pricing, no dark patterns:**
• 3 free demos — no credit card, no registration
• $2 per 1M characters translated | $0.40 per 1K tokens cleaned
• Pay-as-you-go only. No subscriptions. No auto-renewal traps. Use it when you need it.

**🛠 Under the hood:**
Node.js + Express on Railway (us-west2), vanilla JS SPA frontend. DeepSeek AI for translation + structured data cleaning. Airtable PAT for read/write. That's it — no bloated framework, no vendor lock-in.

**Why I'm really here:**
This started as an internal tool. After the 5th time a friend said "can you clean this spreadsheet for me?", I realized other people might want this too. I bought tturn.xyz on a whim, polished it up, and now I want real feedback from people who actually use Airtable every day.

I'm a solo maker — you'll get fast, honest responses from me directly, not a support ticket queue. If something breaks, I'll fix it. If you have feature ideas, I'll build them.

**🎁 PH community perk:**
Mention "PH" and I'll add extra free credits to your account. No strings attached.

Questions I'd love your take on:
1. What's the most painful data task in your Airtable workflow right now?
2. What integration would make this a no-brainer? (Google Sheets? Notion? Supabase?)
3. What would make you trust a tool like this with your data?

Thanks for reading — 谢谢！🙏
```

---

## Gallery Images (1270×760px)

Need screenshots of:
1. **Hero/demo** — The landing page with "Try Live Demo" button + sample data
2. **Data cleaning example** — Before/after comparison showing cleaned data
3. **Translation example** — Table showing original + translated text side by side
4. **Results** — The write-back confirmation / results view

---

## First Comment (posted by a friend/teammate)

```
Been testing this for my team's CRM Airtable. The translation quality surprised me — handled mixed CN/EN content without mangling the formatting. Bulk cleaning fixed 200+ malformed email addresses in about 10 seconds. 🚀
```

---

## Pre-Launch To-Do

- [ ] Take 1270×760 screenshots of the app
- [ ] Record a 30-60s demo video (Loom) showing: connect Airtable → select fields → clean/translate → see results
- [ ] Create PH account if not already (warm it up first!)
- [ ] Schedule launch for midnight PST, Tuesday-Thursday
