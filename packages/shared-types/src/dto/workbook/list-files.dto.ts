import { IsOptional, IsString } from 'class-validator';
import { FileDetailsEntity, FileOrFolderRefEntity } from '../../file-types';
import { DataFolderId } from '../../ids';

export class ListFileDto {
  /** ID of the folder to list contents of. Defaults to workbook root (null). */
  @IsOptional()
  @IsString()
  folderId?: DataFolderId;
}

export type ValidatedListFileDto = ListFileDto;

export interface ListFilesResponseDto {
  /** Flat list of all files and folders within the workbook. */
  items: FileOrFolderRefEntity[];
  /** Cursor for fetching the next page. Absent when there are no more items. */
  nextCursor?: string;
  /** Total number of dirty files in the folder. */
  dirtyCount: number;
}

export type ValidatedListFilesResponseDto = Required<ListFilesResponseDto>;

export interface ListFilesDetailsResponseDto {
  /** Flat list of all files in a folder including full file details. */
  files: FileDetailsEntity[];
}

export type ValidatedListFilesDetailsResponseDto = Required<ListFilesDetailsResponseDto>;
