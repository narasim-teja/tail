import DeviceCheck
import ExpoModulesCore

// App Attest with a raw 32-byte clientDataHash.
//
// @expo/app-integrity only takes a string and hashes its UTF-8 bytes, so it cannot produce the
// byte-exact hashes TECHNICAL.md 4.3/4.4 specify (enrollClientDataHash and batchClientDataHash
// in @tail/protocol). The S3 spike chose this module: the JS side computes the hash and passes
// it here as base64.
public class TailAttestModule: Module {
    private let service = DCAppAttestService.shared

    public func definition() -> ModuleDefinition {
        Name("TailAttest")

        Constant("isSupported") {
            return self.service.isSupported
        }

        AsyncFunction("generateKey") { () async throws -> String in
            do {
                return try await self.service.generateKey()
            } catch {
                throw AppAttestException(error)
            }
        }

        AsyncFunction("attestKey") { (keyId: String, clientDataHashB64: String) async throws -> String in
            let hash = try decodeHash(clientDataHashB64)
            do {
                return try await self.service.attestKey(keyId, clientDataHash: hash).base64EncodedString()
            } catch {
                throw AppAttestException(error)
            }
        }

        AsyncFunction("generateAssertion") { (keyId: String, clientDataHashB64: String) async throws -> String in
            let hash = try decodeHash(clientDataHashB64)
            do {
                return try await self.service.generateAssertion(keyId, clientDataHash: hash)
                    .base64EncodedString()
            } catch {
                throw AppAttestException(error)
            }
        }
    }
}

private func decodeHash(_ b64: String) throws -> Data {
    guard let data = Data(base64Encoded: b64), data.count == 32 else {
        throw BadHashException(b64)
    }
    return data
}

internal final class BadHashException: GenericException<String>, @unchecked Sendable {
    override var reason: String {
        "clientDataHash must be 32 bytes as base64, got '\(param)'"
    }
}

internal final class AppAttestException: GenericException<Error>, @unchecked Sendable {
    override var code: String {
        guard let dc = param as? DCError else { return "ERR_APP_ATTEST_UNKNOWN" }
        switch dc.code {
        case .featureUnsupported: return "ERR_APP_ATTEST_UNSUPPORTED"
        case .invalidInput: return "ERR_APP_ATTEST_INVALID_INPUT"
        case .invalidKey: return "ERR_APP_ATTEST_INVALID_KEY"
        case .serverUnavailable: return "ERR_APP_ATTEST_SERVER_UNAVAILABLE"
        case .unknownSystemFailure: return "ERR_APP_ATTEST_SYSTEM_FAILURE"
        @unknown default: return "ERR_APP_ATTEST_UNKNOWN"
        }
    }

    override var reason: String {
        "App Attest failed: \(param.localizedDescription)"
    }
}
