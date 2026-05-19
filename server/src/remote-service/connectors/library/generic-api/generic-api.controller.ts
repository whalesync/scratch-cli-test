/**
 * GENERIC_API-specific endpoints — separate from the generic data-folder
 * flow because (a) the probe-and-persist sequence is not how other connectors
 * create tables, and (b) PR 5's flow is small enough that mixing it into
 * DataFolderService.createFolder would add more conditional branching than
 * it would save.
 *
 * Endpoints:
 *   POST /workbooks/:workbookId/generic-api/:connectorAccountId/probe-endpoint
 *     Run the table-pick probe for one endpoint. Returns the ProbeResult.
 *     The client uses this BEFORE creating the table so it can show the
 *     status line ("Fetched N from page 1, M from page 2 — looks good").
 *
 *   POST /workbooks/:workbookId/generic-api/data-folders/:dataFolderId/reprobe
 *     Manual re-probe. Runs the same probe, diffs against the persisted
 *     state, and either silently overwrites OR returns an idPath-drift
 *     dialog payload that the client must confirm before applying.
 */

import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  DataFolderId,
  GenericApiConnectorExtras,
  GenericApiFolderOptions,
  isGenericApiConnectorExtras,
  WorkbookId,
} from '@spinner/shared-types';
import { IsNotEmpty, IsString } from 'class-validator';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { Actor, userToActor } from 'src/users/types';
import { Service as ServiceConst } from '../../service-constants';
import { diffProbeResults, ProbeDiff, probeEndpointForTable, ProbeResult } from './generic-api-probe';

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

export class ProbeEndpointDto {
  @IsString()
  @IsNotEmpty()
  readonly endpointId!: string;
}

export interface ProbeEndpointResponse {
  probe: GenericApiFolderOptions['probe'];
  recordsWalked: number;
  page1RecordCount: number;
  page2RecordCount: number;
  page2Status: 'ok' | 'no-pagination';
}

export interface ReprobeResponse {
  /** True when the new probe was applied (silent overwrite). */
  applied: boolean;
  /** When applied=false, the client must show a confirmation dialog with these diff details. */
  diff: ProbeDiff;
  /** The new probe (so the client can render before/after). */
  newProbe: GenericApiFolderOptions['probe'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class GenericApiProbeService {
  constructor(
    private readonly dbService: DbService,
    private readonly credentialEncryption: CredentialEncryptionService,
  ) {}

  /**
   * Probe one endpoint on a connection and return the result (without
   * persisting). The client uses this to show the probe-status line, then
   * calls the standard data-folder create endpoint with the result in
   * `options.genericApi`.
   */
  async probeEndpoint(
    workbookId: WorkbookId,
    connectorAccountId: string,
    endpointId: string,
    actor: Actor,
  ): Promise<ProbeResult> {
    checkWorkspacePermissions(actor, workbookId);

    const account = await this.dbService.client.connectorAccount.findFirst({
      where: { id: connectorAccountId, workbookId },
    });
    if (!account) throw new NotFoundException('Connector account not found');
    if (account.service !== ServiceConst.GENERIC_API) {
      throw new BadRequestException('This endpoint only supports the GENERIC_API connector.');
    }
    if (!isGenericApiConnectorExtras(account.extras)) {
      throw new BadRequestException('Connector account extras are malformed for GENERIC_API.');
    }

    const decrypted = await this.credentialEncryption.decryptCredentials(
      account.encryptedCredentials as Parameters<typeof this.credentialEncryption.decryptCredentials>[0],
    );
    const apiKey = (decrypted as Record<string, unknown>)['apiKey'];
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new BadRequestException('Connector account has no apiKey.');
    }

    return probeEndpointForTable({
      extras: account.extras as GenericApiConnectorExtras,
      apiKey,
      endpointId,
    });
  }

  /**
   * Re-probe an existing GENERIC_API DataFolder. Compares the new probe to
   * the persisted one; applies silent diffs immediately; surfaces the
   * extractionIdPath-drift case as a dialog the client must confirm.
   */
  async reprobe(workbookId: WorkbookId, dataFolderId: DataFolderId, actor: Actor): Promise<ReprobeResponse> {
    checkWorkspacePermissions(actor, workbookId);

    const folder = await this.dbService.client.dataFolder.findFirst({
      where: { id: dataFolderId, workbookId },
    });
    if (!folder) throw new NotFoundException('Data folder not found');
    if (folder.connectorService !== ServiceConst.GENERIC_API) {
      throw new BadRequestException('Re-probe only supports GENERIC_API data folders.');
    }
    if (!folder.connectorAccountId) {
      throw new BadRequestException('Data folder has no connector account.');
    }

    const folderOptions = folder.options as { genericApi?: GenericApiFolderOptions } | null;
    const currentProbe = folderOptions?.genericApi?.probe;
    if (!currentProbe) {
      throw new BadRequestException('Data folder has no persisted probe to compare against.');
    }
    const endpointId = folderOptions?.genericApi?.endpointId;
    if (!endpointId) {
      throw new BadRequestException('Data folder has no endpointId in options.');
    }

    const newResult = await this.probeEndpoint(workbookId, folder.connectorAccountId, endpointId, actor);
    const diff = diffProbeResults(currentProbe, newResult.probe);

    // Hard-stop case: extractionIdPath drift. Do NOT apply; return the diff
    // so the client can show the confirmation dialog.
    if (diff.extractionIdPathChanged) {
      return { applied: false, diff, newProbe: newResult.probe };
    }

    // Schema removed-fields case: keep old fields, just merge new ones in.
    // For v1 the simplest approach is to overwrite with the new probe — the
    // raw record files on disk still carry any removed field. View renderers
    // tolerate missing fields. If this turns out to be wrong, the impl plan
    // says to mark removed fields as "not seen recently"; that's a future
    // iteration.
    await this.dbService.client.dataFolder.update({
      where: { id: dataFolderId },
      data: {
        options: {
          ...(folderOptions ?? {}),
          genericApi: {
            ...folderOptions?.genericApi,
            endpointId,
            probe: newResult.probe,
          } satisfies GenericApiFolderOptions,
        },
      },
    });

    return { applied: true, diff, newProbe: newResult.probe };
  }

  /**
   * Apply a re-probe result that was previously withheld due to
   * extractionIdPath drift. The client calls this after the user explicitly
   * confirms the drift dialog.
   */
  async applyReprobe(
    workbookId: WorkbookId,
    dataFolderId: DataFolderId,
    confirmedProbe: GenericApiFolderOptions['probe'],
    actor: Actor,
  ): Promise<void> {
    checkWorkspacePermissions(actor, workbookId);
    const folder = await this.dbService.client.dataFolder.findFirst({
      where: { id: dataFolderId, workbookId },
    });
    if (!folder) throw new NotFoundException('Data folder not found');
    if (folder.connectorService !== ServiceConst.GENERIC_API) {
      throw new ForbiddenException('Apply-reprobe only supports GENERIC_API data folders.');
    }
    const folderOptions = folder.options as { genericApi?: GenericApiFolderOptions } | null;
    const endpointId = folderOptions?.genericApi?.endpointId;
    if (!endpointId) throw new BadRequestException('Data folder has no endpointId in options.');

    await this.dbService.client.dataFolder.update({
      where: { id: dataFolderId },
      data: {
        options: {
          ...(folderOptions ?? {}),
          genericApi: { endpointId, probe: confirmedProbe } satisfies GenericApiFolderOptions,
        },
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

@Controller('workbooks/:workbookId/generic-api')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class GenericApiController {
  constructor(private readonly probeService: GenericApiProbeService) {}

  /** POST /workbooks/:workbookId/generic-api/:connectorAccountId/probe-endpoint */
  @Post(':connectorAccountId/probe-endpoint')
  async probeEndpoint(
    @Param('workbookId') workbookId: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Body() body: ProbeEndpointDto,
    @Req() req: RequestWithUser,
  ): Promise<ProbeEndpointResponse> {
    const actor = userToActor(req.user);
    const result = await this.probeService.probeEndpoint(
      workbookId as WorkbookId,
      connectorAccountId,
      body.endpointId,
      actor,
    );
    return {
      probe: result.probe,
      recordsWalked: result.recordsWalked,
      page1RecordCount: result.recordsWalked - result.page2RecordCount,
      page2RecordCount: result.page2RecordCount,
      page2Status: result.page2Status,
    };
  }

  /** POST /workbooks/:workbookId/generic-api/data-folders/:dataFolderId/reprobe */
  @Post('data-folders/:dataFolderId/reprobe')
  async reprobe(
    @Param('workbookId') workbookId: string,
    @Param('dataFolderId') dataFolderId: string,
    @Req() req: RequestWithUser,
  ): Promise<ReprobeResponse> {
    const actor = userToActor(req.user);
    return this.probeService.reprobe(workbookId as WorkbookId, dataFolderId as DataFolderId, actor);
  }
}
