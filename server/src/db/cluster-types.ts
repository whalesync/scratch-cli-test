/* eslint-disable @typescript-eslint/no-namespace */
import { Prisma } from '@prisma/client';

export namespace UserCluster {
  export type User = Prisma.UserGetPayload<typeof _validator>;
  export type WorkspacePermission = User['workspacePermissions'][number];

  export const _validator = Prisma.validator<Prisma.UserDefaultArgs>()({
    include: { apiTokens: true, organization: { include: { subscriptions: true } }, workspacePermissions: true },
  });
}

export namespace WorkbookCluster {
  export type Workbook = Prisma.WorkbookGetPayload<typeof _validator>;
  export type DataFolder = Workbook['dataFolders'][number];
  export type WorkspacePermission = Workbook['workspacePermissions'][number];

  export const _validator = Prisma.validator<Prisma.WorkbookDefaultArgs>()({
    include: {
      dataFolders: {
        include: { connectorAccount: true },
        orderBy: {
          createdAt: 'asc',
        },
      },
      workspacePermissions: true,
    },
  });
}

export namespace WorkspacePermissionCluster {
  export type WorkspacePermission = Prisma.WorkspacePermissionGetPayload<typeof _validator>;
  export type User = WorkspacePermission['user'];

  export const _validator = Prisma.validator<Prisma.WorkspacePermissionDefaultArgs>()({
    include: { user: true },
  });
}

export namespace DataFolderCluster {
  export type DataFolder = Prisma.DataFolderGetPayload<typeof _validator>;

  export const _validator = Prisma.validator<Prisma.DataFolderDefaultArgs>()({
    include: { connectorAccount: true },
  });
}
