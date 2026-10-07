import { generateSecretKey, getPublicKey } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";

/**
 * Private delivery: content sealed to the buyer's Nostr key with NIP-44 (v2), using a one-time
 * sender key. Only the holder of the buyer's secret key can open it.
 */
export interface SealedDelivery {
  scheme: "nip44";
  ephemeralPubkey: string;
  ciphertext: string;
}

// ponytail: one NIP-44 payload, so content is capped at 65,535 bytes; chunk it for bigger datasets.
const MAX_BYTES = 65_535;

export function sealFor(recipientPubkey: string, plaintext: string): SealedDelivery {
  if (Buffer.byteLength(plaintext) > MAX_BYTES) throw new Error(`Content over ${MAX_BYTES} bytes needs chunking`);
  const ephemeral = generateSecretKey();
  return {
    scheme: "nip44",
    ephemeralPubkey: getPublicKey(ephemeral),
    ciphertext: nip44.encrypt(plaintext, nip44.getConversationKey(ephemeral, recipientPubkey)),
  };
}

export function openDelivery(d: SealedDelivery, recipientSecretKey: Uint8Array): string {
  return nip44.decrypt(d.ciphertext, nip44.getConversationKey(recipientSecretKey, d.ephemeralPubkey));
}
