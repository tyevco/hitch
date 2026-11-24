// Pairing SAS (normative, SPEC.md "Pairing wire"): the first 64 bits of
// sha256(JCS({commit, clientNonce, serverNonce, pub})) mod 10^6, zero-padded.
import { hashOf } from '../lib/wire.mjs';
export function sasOf({ commit, clientNonce, serverNonce, pub }) {
  const h = hashOf({ commit, clientNonce, serverNonce, pub }).slice(7);
  return String(Number(BigInt('0x' + h.slice(0, 16)) % 1000000n)).padStart(6, '0');
}
