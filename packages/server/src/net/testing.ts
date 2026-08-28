export async function withServer<T>(
  handler: (request: Request) => Response | Promise<Response>,
  fn: (base: string, port: number) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler, idleTimeout: 10 });
  const port = server.port ?? 0;
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await server.stop(true);
  }
}

/** Raw TCP server used to emit responses Bun.serve would never produce. */
export async function withRawServer<T>(
  respond: (received: string) => string | Uint8Array,
  fn: (base: string, port: number) => Promise<T>,
): Promise<T> {
  const answered = new WeakSet<object>();
  const listener = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        if (answered.has(socket)) return;
        answered.add(socket);
        socket.write(respond(new TextDecoder().decode(chunk)));
        socket.end();
      },
      open() {},
      close() {},
      error() {},
    },
  });
  try {
    return await fn(`http://127.0.0.1:${listener.port}`, listener.port);
  } finally {
    listener.stop(true);
  }
}
