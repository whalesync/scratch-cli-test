# Run of show — Webflow CMS/SEO demo (internal links)

**Audience:** a content / SEO lead at a content-heavy site who edits Webflow by hand.
**The wow:** Scratch + Claude add contextually-correct internal links across the whole
blog at once — reviewed, then published back into the live Webflow CMS.
**Length:** ~5–7 minutes. **Surface:** Scratch Desktop (live), Webflow CMS (to prove it landed).

> One-line pitch to open with: *"You know that internal-linking pass everyone knows they
> should do and nobody ever finishes? Watch me do the whole site in about two minutes."*

---

## Pre-call checklist (do ~5 min before)

1. **Reset to baseline** (from the repo root):
   ```bash
   node demos/webflow-cms-seo/ready.ts
   ```
   This resets the Webflow service to the link-free baseline **and** resets the Scratch
   workbook (discard leftover edits + re-pull). Expect: `40 link-free posts`, workbook re-pulled.
   *(If the stack isn't up and you only want to reset the service: `DEMO_SKIP_WORKBOOK_RESET=1 node demos/webflow-cms-seo/ready.ts`.)*
2. **Open Scratch Desktop** → workbook **"Webflow CMS-SEO Demo"** → open the **Blog Posts** folder.
   Confirm ~40 posts, bodies with **no** links yet.
3. **Have the fallback ready** (see "If something goes wrong"): know the re-prompt, and have
   the pre-approved patch set on hand (plan T1.7) for a high-stakes call.
4. Close noisy apps / notifications. Zoom the Desktop font up a notch so diffs read on a share.

---

## The arc

### 1 — Frame the pain (0:00–0:30)
**Say:** "This is a blog with 40 posts. Like most blogs, the posts barely link to each other — which is leaving
SEO on the table and is a miserable manual job. Normally you'd open each post in Webflow,
figure out which other posts to link, write the anchor text, paste the link… for every post."

**Do:** Open one post in Desktop, scroll the body, point out it references related topics in
plain text but links to nothing.

### 2 — Make the ask in plain English (0:30–1:30)
**Do:** Open the Claude chat in Scratch Desktop. Type the prompt (verbatim below).

> **Primary prompt:**
> *"For every blog post, add internal links from the body to other related posts in this
> folder. Use a natural phrase already in the text as the anchor, link only to posts on a
> related topic, and add at most 2–3 links per post. Use relative URLs of the form
> `/demo-blog-posts/<post-slug>`."*

**Say (while it works):** "It's reading every post, working out which ones are related, and
writing the links — across the whole site at once. This is the part you can't get from
pasting one post into ChatGPT: it has the whole corpus."

### 3 — Quality: show ONE diff in detail (1:30–3:30)
This is the trust beat. Pick a post with obvious, correct links.

**Do:** Open the diff for **"Understanding Hydration Ratios in Sourdough."** It should now link
- *"a healthy starter"* → **How to Start a Sourdough Starter from Scratch**, and
- *"score it before baking"* → **Scoring Patterns for a Better Rise.**

**Say:** "Look at the anchor text — it didn't bolt on 'click here.' It linked the phrase that
was already there, to exactly the right post. That's an editor's judgment call, done
automatically." Hover/show the link targets are real posts.

### 4 — Scale: show the aggregate (3:30–4:15)
**Do:** Step back to the folder / changed-records view. Show that **every** post changed and the
**total link count** (e.g. *"~70 internal links across 40 posts"*).

**Say:** "One review pass, the whole site linked. And nothing's live yet — every one of these
is a proposed change I get to approve or reject first."

### 5 — Publish back to Webflow (4:15–5:00)
**Do:** Accept the changes and **Publish**. (This is *your* click in Desktop — Scratch never
publishes on its own.)

**Say:** "Approved changes go straight back into Webflow. No CSV export, no re-import, no
pasting into 40 CMS entries."

### 6 — Prove it landed (5:00–6:00)
**Do (the money shot):** open the **live post page**, e.g.
`https://scratch-general-test-site.webflow.io/demo-blog-posts/how-to-store-cheese`, and **click one
of the internal links the AI just added** — it navigates to the related post. The scripts publish
the site, so the edits are live within seconds of you hitting Publish in Scratch.

**Fallback:** if the live page isn't cooperating, switch to the **Webflow CMS** item editor and show
the body now contains the links.

> Setup note: the live pages render because the integration-test site has a Designer collection-page
> template for `Blog Posts (Demo)` (added once). A brand-new demo site would need that one-time
> Designer step — the API can't create page templates.

**Close:** "From a blog nobody linked, to a fully cross-linked site, reviewed and live — in the
time we've been talking. That's any bulk content change: SEO metadata, alt text, tone, a
rebrand. You describe it, review it, ship it."

---

## If something goes wrong (fallback ladder)

1. **AI is slow (>~60s):** narrate the value while it runs; it's usually fine. Don't fill silence with apology.
2. **Links come out in the wrong format / broken hrefs:** re-prompt: *"Redo those as relative
   URLs like `/demo-blog-posts/<post-slug>`, nothing else."*
3. **AI links to unrelated posts:** re-prompt: *"Only link posts within the same topic; remove the rest."*
4. **AI errors / refuses / total miss:** fall back to the **pre-approved patch set** (plan T1.7):
   apply the known-good edits, then review + publish as normal. The audience still sees the
   review-and-publish wow, just not live generation.
   > ⚠️ T1.7 isn't built yet — build it before relying on this for a high-stakes call.

---

## After the call

Reset for the next demo:
```bash
node demos/webflow-cms-seo/ready.ts
```

---

## Appendix — cluster map (so you can narrate the links confidently)

The seed is 40 posts in 9 topical clusters; links should stay within a cluster.

- **Sourdough:** Start a Starter ↔ Hydration Ratios ↔ Flat Loaf ↔ Scoring Patterns
  *(starter ↔ hydration ↔ scoring are the densest, most obvious links — use Sourdough for the detail beat).*
- **Coffee:** Grind Size ↔ Pour-Over vs French Press ↔ Espresso Extraction ↔ Water Quality
- **Knife Skills:** Four Cuts ↔ Keep It Sharp ↔ First Chef's Knife ↔ Mise en Place
- **Tea:** Green Tea ↔ Water Temperature ↔ Loose-Leaf vs Bags ↔ Steeping Time ↔ Oolong
- **Grilling:** Direct vs Indirect ↔ Perfect Sear ↔ Low and Slow ↔ Choosing Wood ↔ Resting Meat
- **Pasta:** Fresh vs Dried ↔ Al Dente ↔ Salting Water ↔ Shapes & Sauces ↔ Tomato Sauce
- **Fermentation:** Sauerkraut ↔ Salt Ratio ↔ Kimchi ↔ Kombucha ↔ Reading the Signs
- **Cocktails:** Spirit/Sweet/Sour Balance ↔ Shaken vs Stirred ↔ Simple Syrup ↔ Ice Quality
- **Cheese:** Cheese Board ↔ Soft vs Hard ↔ Pairing ↔ Storage

Each body references its siblings in plain text, so the correct links are self-evident — which
is exactly why the result looks smart.
