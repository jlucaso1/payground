/** Upstream sources are pinned by commit. `bun run spec:sync` verifies the digest. */
export const PINS = {
  openapi: {
    repo: 'mercadopago/openapi',
    commit: '4bf7b8751434d29f5a1d9a2dfe498c69ce50d3cb',
    files: ['spec3.json', 'fixtures3.json', 'overlays/MLB.yaml'],
  },
} as const;

export const rawUrl = (repo: string, commit: string, file: string): string =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${file}`;
