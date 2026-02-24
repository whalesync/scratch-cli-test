import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { ScheduleAction } from '../../enums';

export class CreateScheduleDto {
  @IsString()
  name?: string;

  @IsEnum(ScheduleAction)
  action?: ScheduleAction;

  @IsString()
  entityId?: string;

  @IsString()
  cronExpression?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export type ValidatedCreateScheduleDto = Required<
  Pick<CreateScheduleDto, 'name' | 'action' | 'entityId' | 'cronExpression'>
> &
  CreateScheduleDto;
