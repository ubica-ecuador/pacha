// Thin wrappers over the docker CLI. The tests shell out on purpose: what they
// check is what `docker` and `docker compose` do, not an SDK's idea of them.
import { execFileSync } from 'node:child_process';

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

export async function waitFor(check, { timeoutMs = 120_000, intervalMs = 1_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

export function runDetached(image, { dockerArgs = [], command = [] } = {}) {
  return sh('docker', ['run', '-d', ...dockerArgs, image, ...command]);
}

export function hostPort(containerId, containerPort) {
  // One line per address family, e.g. "127.0.0.1:49153"; the first will do.
  const line = sh('docker', ['port', containerId, `${containerPort}/tcp`]).split('\n')[0];
  return Number(line.slice(line.lastIndexOf(':') + 1));
}

export function remove(containerId) {
  sh('docker', ['rm', '-f', containerId]);
}

export function compose(args, opts = {}) {
  return sh('docker', ['compose', ...args], opts);
}

// curl from inside another container's network namespace. It works even when
// that container runs with `--network none`, which is the point: loopback is
// all there is to reach.
export function curlIn(containerId, curlArgs) {
  return sh('docker', ['run', '--rm', '--network', `container:${containerId}`, 'curlimages/curl:8.10.1', ...curlArgs]);
}
