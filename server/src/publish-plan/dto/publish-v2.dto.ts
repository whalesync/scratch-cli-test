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
}

export class PublishPlanRunDto implements IPublishPlanRunDto {
  @IsString()
  @IsNotEmpty()
  pipelineId!: string;

  @IsBoolean()
  @IsOptional()
  executeSinglePhase?: boolean;
}
