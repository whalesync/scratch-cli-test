import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

  @IsString()
  @IsIn(['edit', 'create', 'delete', 'backfill'])
  @IsOptional()
  phase?: string;
}
