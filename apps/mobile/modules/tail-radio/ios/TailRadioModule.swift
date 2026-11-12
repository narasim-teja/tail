import CoreBluetooth
import CoreLocation
import ExpoModulesCore
import UIKit

// JS API (TECHNICAL.md 5.5), proven on two iPhones in spikes/device:
//   startBeacon() setToken(uuid) stopBeacon()
//   setScanFilter(prefixes) startScan() stopScan()   -> onSighting {uuid, rssi, tMs}
//   startLocation() stopLocation()                   -> onFix {tMs, lat, lon, acc, speed, course, simulated, accessory}
//   setPocketMode(on)
// Status events so the hunt screen can explain gaps:
//   onAppState {state, event, tMs}, onProximity {near, tMs},
//   onRadioState {role, state, advertising?, scanning?, error?, tMs}, onLocationState {status, error?, tMs}
public class TailRadioModule: Module {
    private var engine: TailRadioEngine?

    public func definition() -> ModuleDefinition {
        Name("TailRadio")

        Events("onSighting", "onFix", "onAppState", "onProximity", "onRadioState", "onLocationState")

        OnCreate { [weak self] in
            guard let self else { return }
            // The engine holds the module weakly so it never keeps a destroyed module alive.
            self.engine = TailRadioEngine { [weak self] name, body in
                self?.sendEvent(name, body)
            }
        }

        OnDestroy {
            self.engine?.shutdown()
            self.engine = nil
        }

        Function("startBeacon") {
            self.engine?.startBeacon()
        }

        Function("setToken") { (uuid: String) in
            // Reject anything that is not a 128-bit UUID so a bad token fails loudly in JS
            // instead of silently advertising nothing.
            guard UUID(uuidString: uuid) != nil else {
                throw InvalidTokenException(uuid)
            }
            self.engine?.setToken(uuid)
        }

        Function("stopBeacon") {
            self.engine?.stopBeacon()
        }

        Function("setScanFilter") { (prefixes: [String]) in
            let parsed = try prefixes.map { p -> Data in
                guard let d = hexData(p), d.count == 4 else { throw InvalidPrefixException(p) }
                return d
            }
            self.engine?.setScanFilter(parsed)
        }

        Function("startScan") {
            self.engine?.startScan()
        }

        Function("stopScan") {
            self.engine?.stopScan()
        }

        Function("startLocation") {
            self.engine?.startLocation()
        }

        Function("stopLocation") {
            self.engine?.stopLocation()
        }

        Function("setPocketMode") { (on: Bool) in
            self.engine?.setPocketMode(on)
        }

        Function("getAppState") { () -> String in
            return TailRadioEngine.currentAppState()
        }
    }
}

internal final class InvalidTokenException: GenericException<String>, @unchecked Sendable {
    override var reason: String {
        "setToken needs a 128-bit UUID string (8-4-4-4-12 hex), got '\(param)'"
    }
}

internal final class InvalidPrefixException: GenericException<String>, @unchecked Sendable {
    override var reason: String {
        "setScanFilter needs 4-byte prefixes as 8 hex characters, got '\(param)'"
    }
}

private func hexData(_ s: String) -> Data? {
    guard s.count % 2 == 0 else { return nil }
    var out = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        guard let byte = UInt8(s[i..<j], radix: 16) else { return nil }
        out.append(byte)
        i = j
    }
    return out
}

private func nowMs() -> Double {
    return (Date().timeIntervalSince1970 * 1000).rounded()
}

private func managerStateName(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
}

private func authorizationName(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorizedAlways: return "authorizedAlways"
    case .authorizedWhenInUse: return "authorizedWhenInUse"
    @unknown default: return "unknown"
    }
}

final class TailRadioEngine: NSObject, CBPeripheralManagerDelegate, CBCentralManagerDelegate,
    CLLocationManagerDelegate
{
    typealias Emit = (String, [String: Any?]) -> Void

    private let emit: Emit
    // CoreBluetooth calls back on this queue; all Bluetooth state below is touched only here.
    private let bleQueue = DispatchQueue(label: "tail.radio.ble")

    private var peripheral: CBPeripheralManager?
    private var central: CBCentralManager?
    private var wantBeacon = false
    private var wantScan = false
    private var token: String?
    // First 4 bytes of the match's tags for e-1, e, e+1. Scanning with duplicates reports every
    // packet of every nearby device; only these can be tokens of this match, so everything else
    // is dropped here instead of crossing the bridge. JS still checks each one with tagMatches.
    private var prefixes: [Data] = []

    // Location and UIKit state are main-thread only.
    private var location: CLLocationManager?
    private var wantLocation = false
    private var observers: [NSObjectProtocol] = []

    init(emit: @escaping Emit) {
        self.emit = emit
        super.init()
        DispatchQueue.main.async { self.observeAppState() }
    }

    func shutdown() {
        bleQueue.sync {
            self.peripheral?.stopAdvertising()
            self.central?.stopScan()
            self.wantBeacon = false
            self.wantScan = false
        }
        DispatchQueue.main.async {
            self.location?.stopUpdatingLocation()
            for o in self.observers { NotificationCenter.default.removeObserver(o) }
            self.observers.removeAll()
            UIApplication.shared.isIdleTimerDisabled = false
            UIDevice.current.isProximityMonitoringEnabled = false
        }
    }

    // MARK: App state

    static func currentAppState() -> String {
        let read = { () -> String in
            switch UIApplication.shared.applicationState {
            case .active: return "active"
            case .inactive: return "inactive"
            case .background: return "background"
            @unknown default: return "unknown"
            }
        }
        return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
    }

    private func observeAppState() {
        let center = NotificationCenter.default
        let pairs: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "didBecomeActive"),
            (UIApplication.willResignActiveNotification, "willResignActive"),
            (UIApplication.didEnterBackgroundNotification, "didEnterBackground"),
            (UIApplication.willEnterForegroundNotification, "willEnterForeground"),
            // Device lock: tells "the screen went dark because of the proximity sensor" apart
            // from "the user pressed the side button".
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "protectedDataWillBecomeUnavailable"),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "protectedDataDidBecomeAvailable"),
        ]
        for (name, label) in pairs {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.emit(
                        "onAppState",
                        ["state": TailRadioEngine.currentAppState(), "event": label, "tMs": nowMs()])
                })
        }
        observers.append(
            center.addObserver(
                forName: UIDevice.proximityStateDidChangeNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.emit("onProximity", ["near": UIDevice.current.proximityState, "tMs": nowMs()])
            })
    }

    // MARK: Pocket mode

    func setPocketMode(_ on: Bool) {
        DispatchQueue.main.async {
            // Idle timer off keeps the app from auto-locking; proximity monitoring turns the
            // display off in a pocket while the app stays active (TECHNICAL.md 4.2).
            UIApplication.shared.isIdleTimerDisabled = on
            UIDevice.current.isProximityMonitoringEnabled = on
            let supported = UIDevice.current.isProximityMonitoringEnabled == on
            self.emit(
                "onProximity",
                [
                    "near": UIDevice.current.proximityState, "pocketMode": on,
                    "proximitySupported": supported, "tMs": nowMs(),
                ])
        }
    }

    // MARK: Beacon (peripheral)

    func startBeacon() {
        bleQueue.async {
            self.wantBeacon = true
            if self.peripheral == nil {
                // No restore identifier: tail-radio is foreground-only by design.
                self.peripheral = CBPeripheralManager(delegate: self, queue: self.bleQueue, options: nil)
            }
            self.applyAdvertising()
        }
    }

    func setToken(_ uuid: String) {
        bleQueue.async {
            self.token = uuid.uppercased()
            self.applyAdvertising()
        }
    }

    func stopBeacon() {
        bleQueue.async {
            self.wantBeacon = false
            self.peripheral?.stopAdvertising()
            self.emitRadio(role: "peripheral", extra: ["advertising": false])
        }
    }

    private func applyAdvertising() {
        guard let p = peripheral, wantBeacon, p.state == .poweredOn, let token = token else { return }
        // iOS cannot change the payload of a running advertisement, so a new token means
        // stop then start. Only one 128-bit service UUID and no local name: that fits the
        // 28-byte foreground advertising budget (TECHNICAL.md 4.2).
        if p.isAdvertising { p.stopAdvertising() }
        p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: token)]])
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        emitRadio(role: "peripheral", extra: [:])
        applyAdvertising()
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        emitRadio(
            role: "peripheral",
            extra: ["advertising": error == nil, "error": error?.localizedDescription])
    }

    // MARK: Scan (central)

    func setScanFilter(_ prefixes: [Data]) {
        bleQueue.async { self.prefixes = prefixes }
    }

    func startScan() {
        bleQueue.async {
            self.wantScan = true
            if self.central == nil {
                self.central = CBCentralManager(delegate: self, queue: self.bleQueue, options: nil)
            }
            self.applyScan()
        }
    }

    func stopScan() {
        bleQueue.async {
            self.wantScan = false
            self.central?.stopScan()
            self.emitRadio(role: "central", extra: ["scanning": false])
        }
    }

    private func applyScan() {
        guard let c = central, wantScan, c.state == .poweredOn else { return }
        // Duplicates allowed so every advertisement packet is reported, which is what gives
        // the per-epoch sample count n and the RSSI spread (TECHNICAL.md 4.2, 4.3).
        c.scanForPeripherals(
            withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        emitRadio(role: "central", extra: ["scanning": true])
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        emitRadio(role: "central", extra: [:])
        applyScan()
    }

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi: NSNumber
    ) {
        // Overflow-area UUIDs (a backgrounded advertiser, TECHNICAL.md F17) are not read: a
        // backgrounded phone is not playing, and the S1 spike only logged them.
        guard let uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] else { return }
        let t = nowMs()
        let level = rssi.intValue
        for u in uuids where u.data.count == 16 && prefixes.contains(u.data.prefix(4)) {
            emit("onSighting", ["uuid": u.uuidString, "rssi": level, "tMs": t])
        }
    }

    private func emitRadio(role: String, extra: [String: Any?]) {
        let state: CBManagerState? = role == "peripheral" ? peripheral?.state : central?.state
        var body: [String: Any?] = [
            "role": role, "state": state.map(managerStateName) ?? "notCreated", "tMs": nowMs(),
        ]
        for (k, v) in extra { body[k] = v }
        emit("onRadioState", body)
    }

    // MARK: Location

    func startLocation() {
        DispatchQueue.main.async {
            self.wantLocation = true
            if self.location == nil {
                let m = CLLocationManager()
                m.delegate = self
                m.desiredAccuracy = kCLLocationAccuracyBest
                m.distanceFilter = kCLDistanceFilterNone
                m.activityType = .fitness
                // The game needs fixes while a player stands still, so iOS must not pause updates.
                m.pausesLocationUpdatesAutomatically = false
                self.location = m
            }
            guard let m = self.location else { return }
            if m.authorizationStatus == .notDetermined {
                m.requestWhenInUseAuthorization()
            }
            m.startUpdatingLocation()
            self.emitLocationState(m, error: nil)
        }
    }

    func stopLocation() {
        DispatchQueue.main.async {
            self.wantLocation = false
            self.location?.stopUpdatingLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        emitLocationState(manager, error: nil)
        if wantLocation { manager.startUpdatingLocation() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        emitLocationState(manager, error: error.localizedDescription)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for loc in locations {
            // sourceInformation is nil when iOS has nothing to report; it is sent as null and
            // JS treats it as "no flag set", which is what an unmodified device reports.
            let info = loc.sourceInformation
            emit(
                "onFix",
                [
                    "tMs": (loc.timestamp.timeIntervalSince1970 * 1000).rounded(),
                    "lat": loc.coordinate.latitude,
                    "lon": loc.coordinate.longitude,
                    "acc": loc.horizontalAccuracy,
                    "speed": loc.speed,
                    // Degrees from true north; negative when iOS has no heading (standing still).
                    "course": loc.course,
                    "simulated": info.map { $0.isSimulatedBySoftware } as Any?,
                    "accessory": info.map { $0.isProducedByAccessory } as Any?,
                ])
        }
    }

    private func emitLocationState(_ m: CLLocationManager, error: String?) {
        emit(
            "onLocationState",
            [
                "status": authorizationName(m.authorizationStatus),
                "fullAccuracy": m.accuracyAuthorization == .fullAccuracy,
                "error": error, "tMs": nowMs(),
            ])
    }
}
