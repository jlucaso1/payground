/** Upstream sources are pinned by commit. `bun run spec:sync` verifies the digest. */
export const PINS = {
  openapi: {
    repo: 'mercadopago/openapi',
    commit: '73bc0e498b966591b9d27ef1222d1fdecdbf42d7',
    files: ['spec3.json', 'fixtures3.json', 'overlays/MLB.yaml'],
  },
} as const;

export const rawUrl = (repo: string, commit: string, file: string): string =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${file}`;
