import { Stack } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Text12Book,
  Text12Medium,
  Text12Regular,
  Text13Book,
  Text13Medium,
  Text13Regular,
  Text16Book,
  Text16Medium,
  Text16Regular,
  Text9Regular,
  TextMono12Regular,
  TextMono13Regular,
  TextTitle1,
  TextTitle2,
  TextTitle3,
  TextTitle4,
} from './text';

const meta: Meta = {
  title: 'Foundations/Typography',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Headings: Story = {
  render: () => (
    <Stack gap="md" align="flex-start">
      <TextTitle1>Workbook overview</TextTitle1>
      <TextTitle2>Connections</TextTitle2>
      <TextTitle3>Publish plan</TextTitle3>
      <TextTitle4>Field details</TextTitle4>
    </Stack>
  ),
};

export const BodyText: Story = {
  render: () => (
    <Stack gap="xs" align="flex-start">
      <Text16Medium>16 Medium — The quick brown fox</Text16Medium>
      <Text16Regular>16 Regular — The quick brown fox</Text16Regular>
      <Text16Book>16 Book — The quick brown fox</Text16Book>
      <Text13Medium>13 Medium — The quick brown fox jumps over the lazy dog</Text13Medium>
      <Text13Regular>13 Regular — The quick brown fox jumps over the lazy dog</Text13Regular>
      <Text13Book>13 Book — The quick brown fox jumps over the lazy dog</Text13Book>
      <Text12Medium>12 Medium — The quick brown fox jumps over the lazy dog</Text12Medium>
      <Text12Regular>12 Regular — The quick brown fox jumps over the lazy dog</Text12Regular>
      <Text12Book>12 Book — The quick brown fox jumps over the lazy dog</Text12Book>
      <Text9Regular>9 REGULAR — THE QUICK BROWN FOX</Text9Regular>
    </Stack>
  ),
};

export const Monospace: Story = {
  render: () => (
    <Stack gap="xs" align="flex-start">
      <TextMono13Regular>rec_8Kd0Pq · /Site/Collections</TextMono13Regular>
      <TextMono12Regular>2026-06-25T14:02:11Z</TextMono12Regular>
    </Stack>
  ),
};
