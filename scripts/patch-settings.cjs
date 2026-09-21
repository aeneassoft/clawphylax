// One-off patch: settings table for consent and other small state.
const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "..", "src", "ledger.ts");
let l = fs.readFileSync(f, "utf8");
if (!l.includes("CREATE TABLE IF NOT EXISTS settings")) {
  l = l.replace(`      CREATE TABLE IF NOT EXISTS rules (`, `      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (`);
  l = l.replace(`  counts(): { events: number; hosts: number; keys: number } {`, `  getSetting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, Date.now());
  }

  counts(): { events: number; hosts: number; keys: number } {`);
  fs.writeFileSync(f, l);
  console.log("settings added");
} else {
  console.log("settings already present");
}
