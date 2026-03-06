import { IsEmail, IsOptional, IsString } from 'class-validator';

export class AddWorkspacePermissionDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  role?: string;
}

export type ValidatedAddWorkspacePermissionDto = AddWorkspacePermissionDto &
  ({ userId: string } | { email: string }) & { role: string };

export class UpdateWorkspacePermissionDto {
  @IsString()
  @IsOptional()
  role?: string;
}

export type ValidatedUpdateWorkspacePermissionDto = Required<Pick<UpdateWorkspacePermissionDto, 'role'>>;
