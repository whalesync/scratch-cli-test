import type {
  PublishPlanBuildDto as IPublishPlanBuildDto,
  PublishPlanRunDto as IPublishPlanRunDto,
} from '@spinner/shared-types';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
}
