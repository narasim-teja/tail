// The device FileStore: JSON files in the app's documents directory. They hold no secrets.
// Writes go to a temporary file first, which is then moved over the old one.
import { File, Paths } from "expo-file-system";
import type { FileStore } from "./persist";

export const files: FileStore = {
  read(name) {
    const f = new File(Paths.document, name);
    return f.exists ? f.textSync() : null;
  },
  write(name, text) {
    const tmp = new File(Paths.document, `${name}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    tmp.writeSync(text);
    tmp.moveSync(new File(Paths.document, name), { overwrite: true });
  },
  remove(name) {
    const f = new File(Paths.document, name);
    if (f.exists) f.delete();
  },
};
