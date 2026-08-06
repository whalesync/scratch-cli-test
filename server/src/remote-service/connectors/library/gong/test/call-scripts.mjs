/**
 * Fake sales-call scripts for seeding the Gong dev instance.
 *
 * Each script is a list of [repLine, customerLine] exchanges. The seed script
 * loops a conversation twice (with recap bridges) and synthesizes it to a
 * 10-minute-plus MP3 — Gong discards recordings below its minimum length, and
 * media-less calls never become visible to the read API at all.
 *
 * The content is deliberately varied so transcripts, topics, and trackers have
 * something real to chew on: pricing talk, competitor mentions, next steps,
 * objections — plus enough nonsense to make the QA data fun to read.
 */

export const CALL_SCRIPTS = {
  // Classic discovery call with a suspiciously familiar customer.
  'acme-anvils': [
    [
      'Thanks for hopping on. I saw Acme Anvil and Widget Company just opened a distribution hub in the desert southwest. What is driving the growth?',
      'One customer, honestly. He orders anvils, rocket skates, giant rubber bands, tornado seeds, you name it. Volume is incredible but the returns are brutal. Everything comes back flattened.',
    ],
    [
      'Interesting. So your revenue concentration risk is basically one determined coyote. What does your team want to understand from your sales calls?',
      'Why the deals keep failing at the last second. Every quarter the same pattern: the product ships, there is a puff of smoke at the bottom of a canyon, and then a one-star review.',
    ],
    [
      'Our conversation analytics would flag that as a product-market fit signal, not a sales-execution problem. Have you considered selling to the roadrunner instead?',
      'The roadrunner does not take meetings. He has never once answered an email. Fastest lead in the pipeline and completely unresponsive.',
    ],
    [
      'A ghosting problem, literally the fastest ghosting in the industry. Let us talk about your renewal motion. What does the coyote contract look like?',
      'Auto-renews monthly. He has never churned. Honestly he might be our most loyal customer, which says something troubling about our product line.',
    ],
    [
      'Loyalty despite catastrophic outcomes is a fascinating retention story. If we tag every call where a customer mentions the word explosion, would that help your QBR?',
      'Enormously. Also tag falling, cliff, and the phrase help me. Legal wants those escalated within the hour.',
    ],
    [
      'Done — custom trackers handle all four. On pricing, you would land in our growth tier, about eleven dollars per seat with the safety-incident dashboard included.',
      'The board will ask if the safety dashboard can export to PDF. They love a PDF they can frown at during meetings.',
    ],
    [
      'It exports to PDF, spreadsheet, and an executive one-pager with a large worried arrow. What timeline are you working with?',
      'Before next fiscal quarter. The coyote just placed an order for something called an earthquake pill and we want the analytics live before those calls start.',
    ],
    [
      'Then let us schedule the technical review for Thursday. I will send a summary, the pricing grid, and a mutual action plan today.',
      'Send it to me directly, not the general inbox. The general inbox is full of subpoenas from a bird sanctuary.',
    ],
  ],

  // The prospect cannot stop sharing whale facts. The rep adapts heroically.
  'whale-facts': [
    [
      'So, tell me about your data stack. Where does customer information live today?',
      'Everywhere, which is the problem. Salesforce, three spreadsheets, a Notion no one updates. Did you know a blue whale heart is the size of a small car? Anyway, the data is a mess.',
    ],
    [
      'A small car, incredible. Our platform syncs those systems continuously, so every tool sees the same records. What breaks first when the data drifts?',
      'Billing. We invoiced the same customer twice last month. Sperm whales sleep vertically, by the way, just hanging in the water like commuters. Double billing, that is our sperm whale.',
    ],
    [
      'Vertical sleeping, noted, and honestly relatable. Two-way sync would end the double billing — one record, one truth, propagated everywhere. How many systems would we connect?',
      'Six. Humpback songs can travel ten thousand miles underwater. I want our customer data to travel like that, but between Postgres and the CRM instead of the Pacific.',
    ],
    [
      'That is genuinely the best data-sync metaphor a prospect has ever given me. Latency between your systems today is what, hours?',
      'Days sometimes. A gray whale migrates fourteen thousand miles a year. Our data migrates once a quarter when an intern runs a CSV export and cries.',
    ],
    [
      'We can get that to under a minute, no intern tears required. Let us talk about field mapping — do your systems disagree on what a customer even is?',
      'Wildly. One system says account, one says organization, one says client. Orcas have regional dialects, did you know that? Pods develop their own accents. Our databases have dialects too, just worse.',
    ],
    [
      'Database dialects with no shared grammar — that is exactly what our schema mapping solves. Each field gets translated per system, like a pod interpreter. Pricing-wise you would be in the pod tier. I am renaming the tier for you, it is usually called team tier.',
      'The pod tier. My CFO will hate that and I will love it. Narwhal tusks are actually teeth, by the way. What is implementation like?',
    ],
    [
      'A tooth, not a horn, everyone gets that wrong. Implementation is two weeks, and week one is mostly us listening to how your data flows today.',
      'Like whale researchers with hydrophones. Fine, I am convinced. Send the proposal, and if the contract does not contain at least one whale pun my team will be devastated.',
    ],
    [
      'The contract will include a rider stating the partnership shall be whale-come aboard. Legal will fight me and legal will lose. Thursday for the technical deep dive?',
      'Thursday works. Fin. That was a whale pun, that is how meetings should end.',
    ],
  ],

  // Support escalation: the CRM is haunted. (It is a sync loop.)
  'haunted-crm': [
    [
      'I understand the ticket says, and I am quoting, the CRM is haunted. Walk me through what you are seeing.',
      'Records we delete come back at three in the morning. Same records, every night. The ops team lights a candle now before the standup. Morale is complicated.',
    ],
    [
      'Three A M is suspiciously close to your nightly sync window. What happens at three in your infrastructure?',
      'The integration platform runs its batch. But we deleted those contacts weeks ago. They return with slightly different phone numbers, like they learned something on the other side.',
    ],
    [
      'That is not the afterlife, that is a bidirectional sync without delete propagation. System A deletes, system B never hears about it, and the nightly job resurrects the record. A classic poltergeist loop.',
      'Poltergeist loop. So our CRM is not haunted, it is just configured by someone who no longer works here, which is honestly scarier.',
    ],
    [
      'The scariest words in software: the person who set this up has left. Do you have the sync logs from last night?',
      'We have logs but nobody can read them. They are seventeen thousand lines and one of the lines just says WARNING in capital letters with no other text. We framed it.',
    ],
    [
      'A contextless all-caps WARNING is a museum piece, good call framing it. Here is the fix: enable delete mirroring, add a tombstone table, and the records stay deleted.',
      'Tombstone table is an extremely on-theme name for our situation. Will the ghosts, I mean the records, stay gone?',
    ],
    [
      'They stay gone. The tombstone remembers every deletion, so the batch job checks it before resurrecting anything. No more three A M visitors.',
      'The ops team will be thrilled. They have been rotating who has to check the CRM first each morning. We call it the seance shift.',
    ],
    [
      'Retire the seance shift this week. I am also flagging that your duplicate rules are merging two different people named Bob Church, which may explain the phone numbers changing.',
      "Both Bobs have been calling us about it. Neither Bob is happy. One Bob got the other Bob's invoice and paid it out of spite.",
    ],
    [
      'Spite-paying an invoice is the most passive-aggressive thing I have heard this quarter and I respect it. I will send the delete-propagation runbook and we will unmerge the Bobs on Thursday.',
      'Unmerge the Bobs. If this works you are getting a five-star review and a candle of your own.',
    ],
  ],

  // Procurement negotiation: forty emotional-support llamas for the sales kickoff.
  'llama-procurement': [
    [
      'Before we start, I have to ask about the line item in your RFP that says forty llamas, morale, non-negotiable.',
      'Sales kickoff is in Denver this year. Last year we had a mentalist and it went badly — he guessed three passwords. Llamas are safer. Everyone trusts a llama.',
    ],
    [
      'Password-guessing mentalist to llamas is a strong security posture improvement, procurement-wise. What is the llama success criteria?',
      'Attendance at the petting paddock above eighty percent, zero spitting incidents involving the executive team, and at least one llama in the closing keynote photo.',
    ],
    [
      'Measurable, achievable, photogenic — the best OKRs I have seen this year. Our platform can track the vendor calls for the llama procurement too, you know. Every negotiation recorded and analyzed.',
      'That is actually why you are here. The llama vendor is playing hardball. He knows we have no alternative — the alpaca people burned us in twenty twenty-four.',
    ],
    [
      'What happened with the alpaca people, if you can talk about it?',
      'Half the alpacas were rented. Subcontracted alpacas. We found out because one had a barcode from a different petting zoo. The trust was gone by lunch.',
    ],
    [
      'Subcontracted alpacas with foreign barcodes — supply chain integrity matters even in morale livestock. So you want call analytics on the llama vendor negotiations to find leverage.',
      'Exactly. He mentions his cousin every call. We think the cousin has llamas too. If your topic detection can confirm the cousin is a viable second source, we split the order and the price drops.',
    ],
    [
      'Competitive-mention tracking will surface every cousin reference with a timestamp. You will have a cousin dossier by Friday.',
      'A cousin dossier. This is the most valuable software demo I have ever attended. What does this cost, and can you invoice it under morale infrastructure?',
    ],
    [
      'Growth tier, nine hundred a month, and I have seen wilder line items approved — one customer expenses us under weather insurance. What is your timeline?',
      'Kickoff is in six weeks. Llama contract must close in two. The cousin does not know we know. Keep it that way.',
    ],
    [
      'The cousin remains in the dark, the dossier by Friday, contract by the fourteenth. I will send the order form and, for the record, I hope the keynote llama photo goes perfectly.',
      'From your lips to the llama gods. Send the form. If this works we are doing goats for the holiday party and there WILL be a bigger budget.',
    ],
  ],

  // A customer from 2031 needs retroactive data sync. Timezone jokes ensue.
  'time-traveler': [
    [
      'Your signup form says the company was founded in twenty thirty-one, which is five years from now. Typo, or do we need to have a very different conversation?',
      'No typo. Look, I cannot explain the physics on a recorded line. I just need to know if your sync supports backfilling records dated before the account existed.',
    ],
    [
      'Backfill is fully supported, though the compliance team may ask why your earliest invoice is dated after your latest one.',
      'Time is a flat circle in enterprise software, your compliance team will cope. Real question: how do you handle timezones? Where I come from, this matters even more.',
    ],
    [
      'Everything is stored in UTC and rendered in the viewer local zone. Offsets survive the round trip untouched.',
      'Good. I have seen what happens when a platform snaps dates to midnight local. In twenty twenty-nine it caused the Great Invoice Collapse. Fourteen billion in duplicate charges. Do not snap dates to midnight.',
    ],
    [
      'I will pass the warning to engineering with the appropriate level of terror. What systems are we syncing, and in which decade were they configured?',
      'A Postgres from twenty twenty-three, a CRM from twenty twenty-six, and a system I cannot name because it has not been invented yet. Two out of three connect today, which is fine.',
    ],
    [
      'Two out of three shippable systems is honestly better than most enterprise deals. What does success look like for you, chronologically speaking?',
      'Zero drift between systems, and no record may ever display a modified date earlier than its created date. That paradox specifically. It upsets the auditors in every era.',
    ],
    [
      'Created-before-modified is an invariant we enforce, so the auditors of all timelines can relax. Pricing: annual contract, or does annual mean something different to you?',
      'Annual is fine, but date the contract carefully. If the end date precedes the start date your billing system and I will have a fight it cannot win.',
    ],
    [
      'I will personally proofread the term dates. Out of curiosity, does our company still exist in twenty thirty-one?',
      'I am legally and temporally prevented from answering. But I will say this: buy the dip in March. Not this March. You will know which March.',
    ],
    [
      'A cryptic financial prophecy from a prospect — this call is going straight into the training library. I will send the contract with triple-checked dates today.',
      'Perfect. Schedule the kickoff for next week, my time. Which, again, I cannot fully explain on a recorded line.',
    ],
  ],

  // A bronze-gong manufacturer evaluates Gong. Peak tracker confusion.
  'gong-gong': [
    [
      'I have to say it: you are Gong-Gong Bronzeworks, evaluating Gong, to record calls about gongs. Our topic detection team is going to frame this transcript.',
      'You think that is funny — our support line answers gong questions all day and half the callers want your software instead. We forward them. You are welcome for the pipeline.',
    ],
    [
      'That explains some very confusing inbound leads. So walk me through the business — who buys artisanal bronze gongs in this economy?',
      'Meditation studios, orchestras, and an alarming number of tech startups that want one for hitting when a deal closes. That last segment tripled this year. Your industry is our growth market.',
    ],
    [
      'Sales teams hitting a gong on closed-won — so when our customers close deals using our software, they celebrate on your hardware. This is a beautiful supply chain.',
      'Which is why the confusion hurts. When my reps say gong on a call, is your topic detection going to melt down? Every call is one hundred percent gong mentions.',
    ],
    [
      'Great question. Trackers are configurable per workspace — we exclude your product terms so the word gong becomes background noise, and track what actually matters: pricing, delivery dates, bronze alloy grades.',
      'Bronze alloy grades as a sales topic. My metallurgist will weep with joy. He has been saying for years that nobody listens to the alloy content of these calls.',
    ],
    [
      'Today the metallurgist gets a dashboard. What is the sales cycle like on a large ceremonial gong?',
      'Nine months. Longer than some of our customers gestate their children. Lots of site visits — you cannot buy a two-meter gong without hearing it in your own space first. The neighbors get involved. Sometimes lawyers.',
    ],
    [
      'Noise-complaint-driven deal risk, a genuinely new category for us. We can track mentions of neighbors, decibels, and attorney on every call.',
      'Add resonance to that list. When a buyer says the resonance is wrong, the deal is about to die. It is our number one loss reason and nobody says it directly.',
    ],
    [
      'Resonance as a churn signal — tracked. Honestly this may be the most acoustically sophisticated deployment we have ever done. Pricing lands at team tier, and I am contractually obligated to say it is a bargain.',
      'I will sign if you answer one question honestly: does your company own an actual gong?',
    ],
    [
      'We own several, one is two meters, and I am told the resonance is exceptional. Purchased from a competitor of yours, but the next one is yours if this deal closes.',
      'Deal. Send the contract and a microphone placement guide. If we are recording gong calls, the gongs deserve to sound their best.',
    ],
  ],
};

/**
 * Render a script to one flat `say`-ready text: exchanges with pauses, the
 * whole conversation twice (with a bridge line), so ~8 exchanges comfortably
 * clears Gong's minimum recording length at speech rate.
 */
export function renderScriptForSpeech(script_id) {
  const exchanges = CALL_SCRIPTS[script_id];
  if (!exchanges) throw new Error(`Unknown call script '${script_id}'`);
  const lines = [`Reference ${script_id.replace(/-/g, ' ')}.`];
  for (let repetition = 0; repetition < 2; repetition++) {
    for (const [rep_line, customer_line] of exchanges) {
      lines.push(`[[slnc 400]] ${rep_line}`);
      lines.push(`[[slnc 600]] ${customer_line}`);
    }
    if (repetition === 0) {
      lines.push(
        '[[slnc 800]] Before we wrap up, let me replay the key points one more time so the follow-up notes capture everything correctly.',
      );
    }
  }
  return lines.join('\n');
}
