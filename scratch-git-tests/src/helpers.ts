import crypto from 'node:crypto';

let counter = 0;

export function newRepoId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `test-${ts}-${rand}-${counter++}`;
}

export function file(filePath: string, content: string) {
  return { path: filePath, content };
}
