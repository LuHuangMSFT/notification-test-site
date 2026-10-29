import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import webPush from "web-push";

const configURL = new URL("../site/config.json", import.meta.url);
const config = JSON.parse(await readFile(configURL, "utf8"));
if (config.vapidPublicKey) {
  throw new Error("Already configured. Do not rotate VAPID keys casually: existing subscriptions use this key.");
}
const identity = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
if (identity.status !== 0 || identity.stdout.trim().toLowerCase() !== config.repository.split("/")[0].toLowerCase()) {
  throw new Error("Sign GitHub CLI into the repository owner account before configuring secrets.");
}
const keys = webPush.generateVAPIDKeys();
const result = spawnSync("gh", ["secret", "set", "VAPID_PRIVATE_KEY", "--repo", config.repository], {
  input: keys.privateKey, encoding: "utf8",
});
if (result.status !== 0) throw new Error("Could not save the private key in GitHub Actions secrets.");
config.vapidPublicKey = keys.publicKey;
await writeFile(configURL, `${JSON.stringify(config, null, 2)}\n`);
console.log("Private VAPID key saved as an Actions secret. Only the public key was written to site/config.json.");
