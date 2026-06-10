import { z } from 'zod';
import { FileDetailsEntity, FileOrFolderRefEntity } from '../../file-types';
import type { DataFolderId } from '../../ids';

export const listFileSchema = z.object({
  /** ID of the folder to list contents of. Defaults to workbook root (null). */
  folderId: z.string().optional(),
});

// `folderId` is validated as a string but carries the branded `DataFolderId` type.
export type ListFileDto = Omit<z.infer<typeof listFileSchema>, 'folderId'> & { folderId?: DataFolderId };
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
