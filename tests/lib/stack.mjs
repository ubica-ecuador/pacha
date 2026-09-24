// Where the running stack answers: the port the gateway actually publishes,
// never a guess at 3000. On a machine where 3000 belongs to another Grafana, a
// guess would test that one, and could pass.
//
// `localhost`, not `127.0.0.1`: compose.yaml's GF_SERVER_ROOT_URL is
// http://localhost:${STACK_PORT}/, and Grafana Live checks a websocket's
// Origin against root_url before upgrading it. A test (or browser) that
// connects to 127.0.0.1 sends that as its Origin, root_url says localhost,
// and Live 403s the mismatch.
import { compose } from './docker.mjs';

function gatewayUrl() {
  const address = compose(['port', 'gateway', '80']).split('\n')[0]; // "0.0.0.0:3100"
  return `http://localhost:${address.slice(address.lastIndexOf(':') + 1)}`;
}

export const STACK_URL = process.env.STACK_URL ?? gatewayUrl();
