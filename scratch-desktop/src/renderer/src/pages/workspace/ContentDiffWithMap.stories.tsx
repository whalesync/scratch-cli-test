import { Box } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ContentDiffWithMap } from './ContentDiffWithMap';

const OPENING =
  'Remote onboarding is mostly a logistics problem dressed up as a culture problem. Get the boring things right — hardware, access, a clear first week — and the culture part very nearly takes care of itself.';
const RUN_1A =
  'Pre-stage every account the night before. SSO, email, the repo, the design tool, the docs — all of it should be waiting when they log in, not requested on day one.';
const RUN_1B =
  'Then write a first-week plan and share it before they start. Ambiguity is the enemy; a new hire staring at an empty calendar is a new hire quietly wondering whether they made a mistake.';
const RUN_2A =
  'Assign a single point of contact for questions. Not the manager, not the team — one named person whose entire job that week is to be interruptible.';
const RUN_2B =
  "Front-load the social stuff, too. Quick intros, a team lunch on the company card, and a channel where it's explicitly safe to ask the dumb questions.";
const RUN_3 =
  'Documentation only goes so far on its own. People learn an organization through other people — the unwritten norms, the who-to-ask, the way decisions actually get made.';
const RUN_4 =
  'By the end of week one they should have shipped something small but real — a doc edit, a one-line bug fix, a config change that lands in production.';
const CLOSING =
  "Onboarding never really ends, but the first week sets the tone for everything after it. Spend the effort up front and you'll spend far less of it later.";

const CREATED_PARAGRAPH =
  'Pair every new hire with a buddy outside their own team for the first month — someone with no authority over them and no stake in looking competent.';
const DELETED_PARAGRAPH =
  'Want help getting started? Our remote-onboarding template is free to download at the link below.';

// before/after share unchanged runs and carry 3 modified, 1 created, 1 deleted paragraph.
const BEFORE = [
  OPENING,
  'Send the new hire their laptop a week before day one — nothing kills momentum like a blank desk and a login that does not work yet.',
  RUN_1A,
  RUN_1B,
  'When we rebuilt our first-week plan around these tips, we saw a 30% bump in 90-day retention across remote hires.',
  RUN_2A,
  RUN_2B,
  'Schedule a single onboarding call and let them settle in on their own.',
  RUN_3,
  RUN_4,
  DELETED_PARAGRAPH,
  CLOSING,
].join('\n\n');

const AFTER = [
  OPENING,
  'Ship the new hire their laptop and welcome kit at least a week before day one — nothing kills momentum like a blank desk and a login that does not work yet.',
  RUN_1A,
  RUN_1B,
  'When we rebuilt our first-week plan around these tips, we saw a 42% bump in 90-day retention across remote hires.',
  RUN_2A,
  RUN_2B,
  'Schedule a short daily check-in for the whole first week — ten minutes is plenty, and it catches the small blockers before they fester.',
  RUN_3,
  CREATED_PARAGRAPH,
  RUN_4,
  CLOSING,
].join('\n\n');

const meta: Meta<typeof ContentDiffWithMap> = {
  title: 'ReviewSurface/ContentDiffWithMap',
  component: ContentDiffWithMap,
  decorators: [
    (Story) => (
      <Box style={{ width: 600, maxWidth: '100%' }}>
        <Story />
      </Box>
    ),
  ],
  args: {
    fromValue: BEFORE,
    toValue: AFTER,
    diffKind: 'unreviewed',
  },
};
export default meta;

type Story = StoryObj<typeof ContentDiffWithMap>;

/** Mixed body: 3 modified, 1 created, 1 deleted paragraph, with several unchanged runs to collapse. */
export const MixedChanges: Story = {};

/** A single edited paragraph buried in a long body — exercises a one-tick minimap. */
export const SingleEditInLongBody: Story = {
  args: {
    fromValue: [
      OPENING,
      RUN_1A,
      RUN_1B,
      'The retention bump was 30% across remote hires.',
      RUN_2A,
      RUN_2B,
      RUN_3,
      RUN_4,
      CLOSING,
    ].join('\n\n'),
    toValue: [
      OPENING,
      RUN_1A,
      RUN_1B,
      'The retention bump was 42% across remote hires.',
      RUN_2A,
      RUN_2B,
      RUN_3,
      RUN_4,
      CLOSING,
    ].join('\n\n'),
  },
};

/** A long single-paragraph value with no blank-line breaks — diffs as one modified entry. */
export const SingleParagraphNoBreaks: Story = {
  args: {
    fromValue: `${OPENING} ${RUN_1A} ${RUN_2A} The retention bump was 30% across remote hires and rising.`,
    toValue: `${OPENING} ${RUN_1A} ${RUN_2A} The retention bump was 42% across remote hires and climbing.`,
  },
};
