import { type NativeModule, requireNativeModule } from "expo";

// App Attest with a caller-supplied 32-byte clientDataHash (base64). See the Swift file for
// why this exists instead of @expo/app-integrity.
declare class TailAttestModule extends NativeModule<Record<never, never>> {
  readonly isSupported: boolean;
  /** Returns the keyId (base64 of SHA256(public key)). */
  generateKey(): Promise<string>;
  /** Returns the attestation object, base64. */
  attestKey(keyId: string, clientDataHashB64: string): Promise<string>;
  /** Returns the assertion (CBOR {signature, authenticatorData}), base64. */
  generateAssertion(keyId: string, clientDataHashB64: string): Promise<string>;
}

export default requireNativeModule<TailAttestModule>("TailAttest");
