#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { VERSION, createServer, type ServerOptions } from '@payground/server';

const USAGE = `payground ${VERSION}

Usage:
  payground start [--port <n>] [--host <addr>]
  payground --version
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  if (command !== 'start') {
    console.error(`unknown command: ${command}`);
    return 1;
  }

  const options: ServerOptions = {};
  if (values.port !== undefined) options.port = Number(values.port);
  if (values.host !== undefined) options.hostname = values.host;

  const server = createServer(options);
  console.log(`payground listening on ${server.url.origin}`);
  return 0;
}

process.exit(main(Bun.argv.slice(2)));
