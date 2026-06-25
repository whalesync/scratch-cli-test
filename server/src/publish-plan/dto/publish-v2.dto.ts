import type {
  PublishPlanBuildDto as IPublishPlanBuildDto,
  PublishPlanRunDto as IPublishPlanRunDto,
  PublishOrigin,
} from '@spinner/shared-types';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PublishPlanBuildDto implements IPublishPlanBuildDto {
  @IsString()
  @IsOptional()
  connectorAccountId?: string;

  @IsBoolean()
  @IsOptional()
  runAfterPlan?: boolean;

  @IsString()
  @IsOptional()
  folderPath?: string;

  @IsString()
  @IsOptional()
  filePath?: string;

  /**
   * DEV-10316 TOCTOU token — the dirty-branch HEAD the desktop captured right
   * after its upload landed. When set, `buildPipeline` aborts (before
   * `rebaseDirty`) if the connection's current dirty HEAD has drifted past it.
   * See `PublishPlanBuildDto` in shared-types for the full contract.
   */
  @IsString()
  @IsOptional()
  expectedBaseDirtyHead?: string;
}

export class PublishPlanRunDto implements IPublishPlanRunDto {
  @IsString()
  @IsNotEmpty()
  pipelineId!: string;

  @IsBoolean()
  @IsOptional()
  executeSinglePhase?: boolean;

  /**
   * Surface that initiated the publish; routes a record's *failed* edit during the
   * post-publish reconcile. `'desktop'` strips failures from server `dirty` (they
   * travel back to the client); `'web'` keeps them on `dirty`. Absent ⇒ `'web'`.
   * See {@link PublishOrigin} in shared-types.
   */
  @IsIn(['web', 'desktop'])
  @IsOptional()
  publishOrigin?: PublishOrigin;
}
