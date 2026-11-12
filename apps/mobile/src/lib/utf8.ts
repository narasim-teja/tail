// A strict UTF-8 TextDecoder for runtimes without one. @tail/protocol's borsh Reader decodes
// strings with `new TextDecoder("utf-8", { fatal: true })`; Hermes ships TextEncoder but not
// TextDecoder, and Expo's runtime does not add one. Only what the protocol uses is supported.

export class Utf8Decoder {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM = true;

  constructor(label = "utf-8", options: { fatal?: boolean } = {}) {
    if (label.toLowerCase().replace("-", "") !== "utf8")
      throw new RangeError(`unsupported encoding ${label}`);
    this.fatal = options.fatal ?? false;
  }

  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (input === undefined) return "";
    const b =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let out = "";
    let i = 0;
    const bad = () => {
      if (this.fatal) throw new TypeError("invalid UTF-8");
      out += "�";
    };
    while (i < b.length) {
      const c = b[i] as number;
      // [length, minimum code point] by lead byte; the minimum rejects overlong encodings.
      const [len, min] =
        c < 0x80
          ? [1, 0]
          : c >= 0xc2 && c < 0xe0
            ? [2, 0x80]
            : c >= 0xe0 && c < 0xf0
              ? [3, 0x800]
              : c >= 0xf0 && c < 0xf5
                ? [4, 0x10000]
                : [0, 0];
      if (len === 0 || i + len > b.length) {
        bad();
        i++;
        continue;
      }
      let cp = len === 1 ? c : c & (0xff >> (len + 1));
      let ok = true;
      for (let k = 1; k < len; k++) {
        const x = b[i + k] as number;
        if ((x & 0xc0) !== 0x80) ok = false;
        cp = (cp << 6) | (x & 0x3f);
      }
      if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        bad();
        i++;
        continue;
      }
      out += String.fromCodePoint(cp);
      i += len;
    }
    return out;
  }
}
