import { createRequire } from "node:module";
import { isRecord } from "./fs-utils.js";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as unknown;

export const VERSION = isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : "0.0.0";
