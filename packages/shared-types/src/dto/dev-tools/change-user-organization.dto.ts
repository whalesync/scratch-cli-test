import { z } from 'zod';

export const changeUserOrganizationSchema = z.object({
  userId: z.string().min(1),
  newOrganizationId: z.string().min(1),
  /**
   * If true, mark the user's old organization as deleted when no other users are associated with it.
   */
  deleteOldOrganization: z.boolean().optional(),
});

export type ChangeUserOrganizationDto = z.infer<typeof changeUserOrganizationSchema>;

export type ValidatedChangeUserOrganizationDto = Required<
  Pick<ChangeUserOrganizationDto, 'userId' | 'newOrganizationId'>
> &
  Pick<ChangeUserOrganizationDto, 'deleteOldOrganization'>;
