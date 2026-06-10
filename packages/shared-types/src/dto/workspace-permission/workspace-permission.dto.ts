import { z } from 'zod';

export const addWorkspacePermissionSchema = z.object({
  userId: z.string().optional(),
  email: z.string().email().optional(),
  role: z.string().optional(),
});

export type AddWorkspacePermissionDto = z.infer<typeof addWorkspacePermissionSchema>;

export type ValidatedAddWorkspacePermissionDto = AddWorkspacePermissionDto &
  ({ userId: string } | { email: string }) & { role: string };

export const updateWorkspacePermissionSchema = z.object({
  role: z.string().optional(),
});

export type UpdateWorkspacePermissionDto = z.infer<typeof updateWorkspacePermissionSchema>;
export type ValidatedUpdateWorkspacePermissionDto = Required<Pick<UpdateWorkspacePermissionDto, 'role'>>;
