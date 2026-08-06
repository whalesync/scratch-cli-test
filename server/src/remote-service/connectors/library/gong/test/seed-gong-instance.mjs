#!/usr/bin/env node
/**
 * Seed the Gong developer instance with test calls via the ingestion API.
 *
 * PREREQUISITES
 *  - Admin toggle (per user): Gong Admin → People → Team members → (user) →
 *    enable telephony call import. Without it POST /v2/calls returns 409.
 *  - macOS `say` + ffmpeg (audio synthesis — `brew install ffmpeg`).
 *
 * Usage:
 *   set -a; source /Users/ryder/spinner/local/audit-creds/gong.env; set +a
 *   node server/src/remote-service/connectors/library/gong/test/seed-gong-instance.mjs
 *
 * HARD-WON GONG INGESTION FACTS (all verified live on the dev instance):
 *  - A call only becomes visible to the READ API after its media finishes
 *    processing. Media-less calls exist in the web UI ("Call wasn't recorded")
 *    but are NEVER returned by /v2/calls* — so every seeded call gets media.
 *  - Recordings below Gong's minimum length are discarded: the call shows
 *    "Looks like the call was too short" in the UI and never becomes
 *    API-visible. Verified: ~30-second audio fails, 5–7 minute audio passes
 *    (scripts here render 5–7.5 min; exact threshold untested in between).
 *  - Media is deduped by CONTENT HASH — identical audio on a second call is
 *    rejected, so every call's audio must be unique.
 *  - While processing, GET /v2/calls/{id} moves through "is not ready yet" AND
 *    "was not found" (transient!) before returning the call (~4 min for a
 *    12-minute MP3).
 *  - clientUniqueId is burned forever once posted (even for discarded calls) —
 *    hence the generation suffix in the ids below.
 *  - Only users with settings.telephonyCallsImported=true can be primaryUser.
 *
 * Conversations live in ./call-scripts.mjs — six original fake sales calls.
 * Each is synthesized MULTIVOICE: the rep and the customer get different
 * macOS voices, segment by segment, concatenated with ffmpeg into one MP3, so
 * Gong's speaker diarization sees a real two-person conversation.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CALL_SCRIPTS } from './call-scripts.mjs';

const BASE_URL = (process.env.GONG_API_BASE_URL || 'https://api.gong.io').replace(/\/+$/, '');
const ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const ACCESS_KEY_SECRET = process.env.GONG_ACCESS_KEY_SECRET;
if (!ACCESS_KEY || !ACCESS_KEY_SECRET) {
  console.error('Missing GONG_ACCESS_KEY / GONG_ACCESS_KEY_SECRET in the environment.');
  process.exit(1);
}
const AUTH_HEADER = 'Basic ' + Buffer.from(`${ACCESS_KEY}:${ACCESS_KEY_SECRET}`).toString('base64');

/** Bump when a prior generation's clientUniqueIds are burned. */
const SEED_GENERATION = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gong(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

// ---------------------------------------------------------------------------
// Hosts (only import-enabled users can be primaryUser)
// ---------------------------------------------------------------------------

const { json: usersResponse } = await gong('GET', '/v2/users');
const all_team_members = usersResponse.users ?? [];
const import_enabled_hosts = all_team_members.filter((user) => user.settings?.telephonyCallsImported === true);
if (import_enabled_hosts.length === 0) {
  console.error('No Gong user has telephony call import enabled — flip it in Admin → People → Team members first.');
  process.exit(1);
}
const primary_host = import_enabled_hosts[0];
const second_host = import_enabled_hosts[1] ?? import_enabled_hosts[0];
console.log(
  `Import-enabled hosts: ${import_enabled_hosts.map((user) => user.emailAddress).join(', ')} ` +
    `(of ${all_team_members.length} users)`,
);

function internalParty(user, mediaChannelId) {
  return {
    emailAddress: user.emailAddress,
    name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.emailAddress,
    userId: user.id,
    mediaChannelId,
  };
}

const day_ms = 24 * 60 * 60 * 1000;
const base_time = Date.parse('2026-08-01T09:00:00-07:00');
const at_days_ago = (days, hour_offset_hours = 0) =>
  new Date(base_time - days * day_ms + hour_offset_hours * 3600_000).toISOString();

// ---------------------------------------------------------------------------
// The seed set: six calls, six scripts, torture-flavored metadata
// ---------------------------------------------------------------------------

const SEED_CALLS = [
  {
    scriptId: 'acme-anvils',
    voices: { rep: 'Allison', customer: 'Daniel' },
    call: {
      title: 'Discovery — Acme Anvil & Widget Co.',
      direction: 'Outbound',
      purpose: 'Discovery',
      disposition: 'Demo scheduled',
      actualStart: at_days_ago(5),
      parties: [
        internalParty(primary_host, 0),
        {
          emailAddress: 'wile.e@acme-anvils-testing.com',
          name: 'W. E. Coyote',
          title: 'Head of Procurement',
          mediaChannelId: 1,
        },
      ],
    },
  },
  {
    scriptId: 'whale-facts',
    voices: { rep: 'Karen', customer: 'Fred' },
    call: {
      title: '🐋 Data-sync intro — Cetacean Analytics (日本語テスト ümlaut)',
      direction: 'Outbound',
      purpose: 'Discovery',
      customData: JSON.stringify({
        source: 'scratch-seed',
        generation: SEED_GENERATION,
        emoji: '🎉',
        nested: { num: 42 },
      }),
      actualStart: at_days_ago(4),
      parties: [
        internalParty(second_host, 0),
        { emailAddress: 'marina@cetacean-testing.com', name: 'Marina Baleen', title: 'VP Data', mediaChannelId: 1 },
      ],
    },
  },
  {
    scriptId: 'haunted-crm',
    voices: { rep: 'Samantha', customer: 'Grandpa' },
    call: {
      title: 'Support escalation — the haunted CRM',
      direction: 'Inbound',
      purpose: 'Support',
      disposition: 'Follow-up required',
      actualStart: at_days_ago(3),
      parties: [
        internalParty(primary_host, 0),
        { emailAddress: 'ops@spookycorp-testing.com', name: 'Casper Ledger', title: 'RevOps Lead', mediaChannelId: 1 },
      ],
    },
  },
  {
    scriptId: 'llama-procurement',
    voices: { rep: 'Matilda', customer: 'Albert' },
    call: {
      title: 'Negotiation — 40 emotional-support llamas (SKO Denver)',
      direction: 'Conference',
      purpose: 'Negotiation',
      meetingUrl: 'https://meet.example-testing.com/llama-summit',
      actualStart: at_days_ago(2),
      parties: [
        internalParty(primary_host, 0),
        internalParty(second_host, 0),
        {
          emailAddress: 'events@llamapalooza-testing.com',
          name: 'Dolly Cria',
          title: 'Head of Llamas',
          mediaChannelId: 1,
        },
        { emailAddress: 'cfo@llamapalooza-testing.com', name: 'Bill Shear', mediaChannelId: 1 },
      ],
    },
  },
  {
    scriptId: 'time-traveler',
    voices: { rep: 'Daniel', customer: 'Karen' },
    call: {
      title:
        'Onboarding consultation with a customer whose founding date is after the meeting date, which raises questions '
          .repeat(3)
          .trim(),
      direction: 'Inbound',
      scheduledStart: at_days_ago(1, -1),
      actualStart: at_days_ago(1),
      parties: [
        internalParty(second_host, 0),
        {
          emailAddress: 'founder@chronosync-testing.com',
          name: 'Paradox Jones',
          title: 'Founder (2031)',
          mediaChannelId: 1,
        },
      ],
    },
  },
  {
    scriptId: 'gong-gong',
    voices: { rep: 'Fred', customer: 'Allison' },
    call: {
      // Minimal metadata on purpose: no title/purpose/disposition.
      direction: 'Unknown',
      actualStart: at_days_ago(0, -3),
      parties: [
        internalParty(primary_host, 0),
        { emailAddress: 'foundry@gonggong-bronzeworks-testing.com', name: 'Brontë Mallet', mediaChannelId: 1 },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Multivoice synthesis: per-line segments (alternating voices) → ffmpeg → MP3
// ---------------------------------------------------------------------------

function synthesizeMultivoiceMp3(scriptId, voices) {
  const exchanges = CALL_SCRIPTS[scriptId];
  if (!exchanges) throw new Error(`Unknown call script '${scriptId}'`);

  const work_dir = join(tmpdir(), `gong-seed-g${SEED_GENERATION}-${scriptId}`);
  mkdirSync(work_dir, { recursive: true });

  // Two repetitions with a bridge line clears Gong's ~10-minute minimum.
  const segment_lines = [
    { voice: voices.rep, text: `Reference ${scriptId.replace(/-/g, ' ')}, generation ${SEED_GENERATION}.` },
  ];
  for (let repetition = 0; repetition < 2; repetition++) {
    for (const [rep_line, customer_line] of exchanges) {
      segment_lines.push({ voice: voices.rep, text: rep_line });
      segment_lines.push({ voice: voices.customer, text: customer_line });
    }
    if (repetition === 0) {
      segment_lines.push({
        voice: voices.rep,
        text: 'Before we wrap up, let me replay the key points one more time so the follow-up notes capture everything correctly.',
      });
    }
  }

  const segment_paths = segment_lines.map((segment, index) => {
    const segment_path = join(work_dir, `seg-${String(index).padStart(3, '0')}.aiff`);
    execFileSync('say', ['-v', segment.voice, '-o', segment_path, `[[slnc 350]] ${segment.text}`]);
    return segment_path;
  });

  const concat_list_path = join(work_dir, 'segments.txt');
  writeFileSync(concat_list_path, segment_paths.map((p) => `file '${p}'`).join('\n'));
  const mp3_path = join(work_dir, `${scriptId}.mp3`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concat_list_path,
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '64k',
    '-ar',
    '22050',
    '-ac',
    '1',
    mp3_path,
  ]);
  const duration_seconds = parseFloat(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3_path]).toString(),
  );
  return { mp3_path, duration_seconds };
}

async function uploadCallMedia(call_id, mp3_path, scriptId) {
  const form = new FormData();
  form.append('mediaFile', new Blob([readFileSync(mp3_path)], { type: 'audio/mpeg' }), `${scriptId}.mp3`);
  const response = await fetch(`${BASE_URL}/v2/calls/${call_id}/media`, {
    method: 'PUT',
    headers: { Authorization: AUTH_HEADER },
    body: form,
  });
  const body = await response.text();
  console.log(`  media upload → HTTP ${response.status} ${body.slice(0, 120)}`);
  return response.status === 200 || response.status === 201;
}

// ---------------------------------------------------------------------------
// Seed loop (3 req/s limit → 400ms spacing)
// ---------------------------------------------------------------------------

let created_count = 0;
let already_seeded_count = 0;
let failed_count = 0;

for (const { scriptId, voices, call } of SEED_CALLS) {
  const clientUniqueId = `scratch-seed${SEED_GENERATION}-${scriptId}`;
  const { status, json } = await gong('POST', '/v2/calls', {
    ...call,
    clientUniqueId,
    primaryUser: call.parties.find((party) => party.userId)?.userId ?? primary_host.id,
  });

  if (status === 200 || status === 201) {
    const call_id = json.callId;
    console.log(`created ${clientUniqueId} → callId ${call_id}`);
    console.log(`  synthesizing multivoice audio (${voices.rep} + ${voices.customer})…`);
    const { mp3_path, duration_seconds } = synthesizeMultivoiceMp3(scriptId, voices);
    console.log(`  ${Math.round(duration_seconds / 60)}m${Math.round(duration_seconds % 60)}s of audio`);
    await sleep(400);
    const uploaded = await uploadCallMedia(call_id, mp3_path, scriptId);
    if (uploaded) created_count++;
    else failed_count++;
  } else if (status === 409 && JSON.stringify(json.errors ?? '').includes('already been posted')) {
    already_seeded_count++;
    console.log(`already seeded: ${clientUniqueId}`);
  } else {
    failed_count++;
    console.error(`FAILED ${clientUniqueId} → HTTP ${status} ${JSON.stringify(json.errors ?? json)}`);
  }
  await sleep(400);
}

console.log(
  `\nDone: ${created_count} created+uploaded, ${already_seeded_count} already seeded, ${failed_count} failed.`,
);
console.log('Gong processes media asynchronously (~4 min per call); calls appear in the read API when done.');
if (failed_count > 0) process.exit(1);
