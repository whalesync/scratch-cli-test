import { IsArray, IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import type { WorkbookId } from '../../ids';

export class CreateDataFolderDto {
  @IsNotEmpty()
  @IsString()
  name?: string;

  @IsNotEmpty()
  @IsString()
  workbookId?: WorkbookId;

  @IsOptional()
  @IsString()
  connectorAccountId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tableId?: string[];

  @IsOptional()
  @IsString()
  parentFolderId?: string;

  @IsOptional()
  @IsString()
  filter?: string;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  idFieldOverride?: string;

  @IsOptional()
  @IsString()
  nameFieldOverride?: string;

  @IsOptional()
  @IsBoolean()
  triggerPull?: boolean;
}

export type ValidatedCreateDataFolderDto = Required<Pick<CreateDataFolderDto, 'name' | 'workbookId'>> &
  Pick<
    CreateDataFolderDto,
    'connectorAccountId' | 'tableId' | 'parentFolderId' | 'filter' | 'options' | 'idFieldOverride' | 'nameFieldOverride' | 'triggerPull'
  >;
