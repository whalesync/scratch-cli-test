import { IsNotEmpty, IsObject, IsString } from 'class-validator';
import { TransformerConfig } from '../../sync-mapping';

export class TestTransformerDto {
  @IsString()
  @IsNotEmpty()
  workbookId!: string;

  @IsString()
  @IsNotEmpty()
  fileId!: string;

  @IsString()
  @IsNotEmpty()
  path!: string;

  @IsObject()
  @IsNotEmpty()
  transformerConfig!: TransformerConfig;
}

export interface TestTransformerResponse {
  success: boolean;
  value: unknown;
  error?: string;
  originalValue?: unknown;
}
