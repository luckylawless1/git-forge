// Entry point for the git forge.
//
// The contest environment starts this program beside its suite and expects
// a short handshake, spelled out in the kit's RULES:
//
//   1. Bring the forge up on an ephemeral port (port 0 — the kernel picks a
//      free one). Port 8080 belongs to the suite itself; never bind it.
//   2. POST {"port": <the chosen port>} to $MAKEFUN_ENV_URL/register. The
//      suite notes the address that POST arrived from and dials the forge
//      back at that address and port.
//   3. Poll GET $MAKEFUN_ENV_URL/done. It answers {"done": false} while the
//      suite works and {"done": true} once it has written its export; only
//      then shut the server down and exit 0.
//
// The forge itself — git smart HTTP, REST v3, GraphQL v4 and MCP — lives
// behind createApp() in app.ts, which reads the bearer token from
// MAKEFUN_SHOP_TOKEN in the environment on its own. This file keeps no
// state of its own: it only owns the process lifecycle around that server.

import type { Server } from 'node:http';

import { createApp, setPortProbe } from './app.ts';

/** Pause between two polls of the environment's /done endpoint. */
const DONE_POLL_MS = 250;
/** How many times the register POST is attempted before giving up. */
const REGISTER_TRIES = 40;
/** Pause between two register attempts. */
const REGISTER_RETRY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The environment's origin, with any trailing slashes stripped. */
function envOrigin(): string {
  const value = process.env.MAKEFUN_ENV_URL;
  if (value === undefined || value === '') {
    throw new Error('MAKEFUN_ENV_URL must name the contest environment origin');
  }
  return value.replace(/\/+$/, '');
}

/** Build the forge server and bind it to a kernel-chosen port. */
async function startForge(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolveBind, rejectBind) => {
    const onBindError = (error: Error) => {
      rejectBind(error);
    };
    server.once('error', onBindError);
    server.listen(0, () => {
      server.removeListener('error', onBindError);
      resolveBind();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound !== 'object') {
    throw new Error('the forge server did not bind a TCP port');
  }
  // app.ts keeps the starter's probe hook for the bound port; feed it.
  setPortProbe(bound.port);
  return { server, port: bound.port };
}

/** Tell the environment which port the forge answers on. */
async function registerWithEnv(origin: string, port: number): Promise<void> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < REGISTER_TRIES; attempt += 1) {
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.ok) return;
      failure = new Error(`register was answered with HTTP ${reply.status}`);
    } catch (error) {
      failure = error;
    }
    await sleep(REGISTER_RETRY_MS);
  }
  throw failure instanceof Error ? failure : new Error('registering with the environment failed');
}

/** Ask the environment whether the trial is over; true once it is. */
async function envIsDone(origin: string): Promise<boolean> {
  const reply = await fetch(`${origin}/done`);
  if (!reply.ok) return false;
  const payload = (await reply.json()) as { done?: unknown };
  return payload.done === true;
}

/** Poll /done until the environment reports the trial finished. */
async function waitForEnv(origin: string): Promise<void> {
  for (;;) {
    try {
      if (await envIsDone(origin)) return;
    } catch {
      // A failed poll says nothing about the trial; keep waiting.
    }
    await sleep(DONE_POLL_MS);
  }
}

/** Close the server, dropping any keep-alive connections the suite holds. */
async function stopForge(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => {
    server.close(() => {
      resolveClose();
    });
  });
}

/**
 * When the pod stops the program, do not die mid-request: drop the suite's
 * connections, close the server and exit cleanly. The fallback timer keeps
 * a stuck close from hanging the shutdown.
 */
function stopOnSignal(server: Server): void {
  const onSignal = () => {
    setTimeout(() => {
      process.exit(0);
    }, 1_000).unref();
    void stopForge(server).then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

async function run(): Promise<void> {
  const origin = envOrigin();
  const { server, port } = await startForge();
  stopOnSignal(server);
  try {
    await registerWithEnv(origin, port);
    await waitForEnv(origin);
  } finally {
    await stopForge(server);
  }
}

run().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
