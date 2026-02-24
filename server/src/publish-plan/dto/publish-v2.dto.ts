import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PlanPublishV2Dto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsOptional()
  connectorAccountId?: string;

  @IsBoolean()
  @IsOptional()
  runAfterPlan?: boolean;
}

export class RunPublishV2Dto {
  @IsString()
  @IsNotEmpty()
  pipelineId!: string;

  @IsBoolean()
  @IsOptional()
  executeSinglePhase?: boolean;
}
