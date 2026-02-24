export interface CommitOptions {
  message: string;
  author?: {
    name: string;
    email: string;
  };
}

export interface FileChange {
  path: string;
  content?: string;
  oid?: string; // Optional OID to reuse existing blobs directly
  type: 'add' | 'modify' | 'delete';
}

export interface GitFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface DirtyFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oid?: string;
}

export interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit';
}
