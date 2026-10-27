import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { OAuthInitiateOptionsDto } from '../dto/oauth-initiate-options.dto';

/** Run a body through the same global pipe the initiate endpoint uses. */
function parseInitiateBody(body: Record<string, unknown>): OAuthInitiateOptionsDto {
  return new ZodValidationPipe().transform(body, {
    type: 'body',
    metatype: OAuthInitiateOptionsDto,
  }) as OAuthInitiateOptionsDto;
}

const REQUIRED_FIELDS = { resultForwardUrl: 'https://test.scratch.md/oauth/callback-step-2', workbookId: 'wkb_1' };

describe('OAuth initiate options — sandbox switches', () => {
  it.each(['salesforceSandbox', 'quickbooksSandbox'])('accepts %s as a boolean (Scratch web)', (fieldKey) => {
    expect(parseInitiateBody({ ...REQUIRED_FIELDS, [fieldKey]: true })).toMatchObject({ [fieldKey]: true });
  });

  it.each([
    ['salesforceSandbox', 'true', true],
    ['salesforceSandbox', 'false', false],
    ['quickbooksSandbox', 'true', true],
    ['quickbooksSandbox', 'false', false],
  ])('parses %s sent as the string %p (Live Export connect form) to %p', (fieldKey, sentValue, parsedValue) => {
    expect(parseInitiateBody({ ...REQUIRED_FIELDS, [fieldKey]: sentValue })).toMatchObject({
      [fieldKey]: parsedValue,
    });
  });

  it('leaves the switch unset when the form never touched it', () => {
    expect(parseInitiateBody({ ...REQUIRED_FIELDS }).salesforceSandbox).toBeUndefined();
  });

  it.each(['yes', 'TRUE', '1', ''])('still rejects %p', (notAYesNoValue) => {
    expect(() => parseInitiateBody({ ...REQUIRED_FIELDS, salesforceSandbox: notAYesNoValue })).toThrow(
      BadRequestException,
    );
  });
});
