import path from "node:path";
import { DATA_DIR } from "../config.js";
import { SecretVault } from "../util/secret-vault.js";

/** Separate from database snapshots; never send credentials or upload URLs to clients. */
export class YoutubeVault extends SecretVault {
  constructor(file = path.join(DATA_DIR, "youtube.key")) {
    super(file, "YouTube");
  }
}
