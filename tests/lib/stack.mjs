// Where the running stack answers: the port the gateway actually publishes,
// never a guess at 3000. On a machine where 3000 belongs to another Grafana, a
// guess would test that one, and could pass.
import { compose } from './docker.mjs';

function gatewayUrl() {
  const address = compose(['port', 'gateway', '80']).split('\n')[0]; // "0.0.0.0:3100"
  return `http://127.0.0.1:${address.slice(address.lastIndexOf(':') + 1)}`;
}

export const STACK_URL = process.env.STACK_URL ?? gatewayUrl();
