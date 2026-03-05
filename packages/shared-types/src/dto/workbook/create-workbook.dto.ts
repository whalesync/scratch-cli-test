import { IsOptional, IsString } from 'class-validator';

export class CreateWorkbookDto {
  @IsOptional()
  @IsString()
  name?: string;
}

export type ValidatedCreateWorkbookDto = CreateWorkbookDto;
