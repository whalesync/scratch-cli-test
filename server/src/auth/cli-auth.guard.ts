import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Auth guard for protecting CLI endpoints by validating the User-Agent header.
 * This guard requires a User-Agent that identifies a Scratch client (see `CliStrategy`).
 */
@Injectable()
export class CliAuthGuard extends AuthGuard('CLI_STRATEGY') {}
