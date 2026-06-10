import { z } from 'zod';
import { FileDetailsEntity } from '../../file-types';
import { DataFolderId } from '../../ids';

export interface FileDetailsResponseDto {
  file: FileDetailsEntity;
}

export type ValidatedFileDetailsResponseDto = Required<FileDetailsResponseDto>;

export const createFileSchema = z.object({
  /** Name of the file (with extension) */
  name: z.string().min(1),
  /** ID of the parent folder, or null for workbook root */
  parentFolderId: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  useTemplate: z.boolean().optional(),
});

// `parentFolderId` is validated as a string but carries the branded `DataFolderId` type for consumers.
export type CreateFileDto = Omit<z.infer<typeof createFileSchema>, 'parentFolderId'> & {
  parentFolderId?: DataFolderId | null;
};

export type ValidatedCreateFileDto = Required<Pick<CreateFileDto, 'name'>> &
  Pick<CreateFileDto, 'parentFolderId' | 'content' | 'useTemplate'>;

export const updateFileSchema = z.object({
  /** New name for the file (with extension) */
  name: z.string().min(1).optional(),
  content: z.string().nullable().optional(),
});

export type UpdateFileDto = z.infer<typeof updateFileSchema>;
export type ValidatedUpdateFileDto = UpdateFileDto;
