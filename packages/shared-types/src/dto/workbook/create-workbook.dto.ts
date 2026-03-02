import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateWorkbookDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export type ValidatedCreateWorkbookDto = CreateWorkbookDto;
