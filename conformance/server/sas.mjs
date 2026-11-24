// Pairing SAS (normative, SPEC.md "Pairing wire"): the first 64 bits of
// sha256(JCS({commit, clientNonce, serverNonce, pub, nodeKey})) mod 10^6,
// zero-padded. nodeKey is the node key's x (base64url) as the client received
// it, so an impostor that relays the pairing but substitutes its own node key
// makes the two codes differ.
import { hashOf } from '../lib/wire.mjs';
export function sasOf({ commit, clientNonce, serverNonce, pub, nodeKey }) {
  if (typeof nodeKey !== 'string') throw new TypeError('sasOf: nodeKey (x, base64url) is required');
  const h = hashOf({ commit, clientNonce, serverNonce, pub, nodeKey }).slice(7);
  return String(Number(BigInt('0x' + h.slice(0, 16)) % 1000000n)).padStart(6, '0');
}
