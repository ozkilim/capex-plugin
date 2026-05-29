// CAPEX uninstall helper. Run via the /capex-uninstall skill BEFORE removing
// the plugin, because a plugin hook can't run after uninstall — so the settings
// CAPEX self-installed (the status line) would otherwise be orphaned.
//
// This script reverses everything CAPEX writes outside its own plugin dir:
//   - removes our `statusLine` from ~/.claude/settings.json (only if it's ours);
//   - removes a pinned `"agent": "capex:code"` if present;
//   - drops CAPEX permission/skill entries from ~/.claude/settings.local.json.
//
// It does NOT delete the plugin itself (that's `/plugin uninstall …`, a
// Claude Code command) and does NOT delete ~/.capex by default (that holds your
// lifetime savings stats). Pass --purge to also remove ~/.capex.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CAPEX_AGENT = "capex:code";

function isCapexStatusLine(cmd) {
  return typeof cmd === "string" && cmd.includes("status-line.js") && cmd.includes("capex");
}

function isCapexPermission(entry) {
  return (
    typeof entry === "string" &&
    (entry.startsWith("Skill(capex:") || entry.includes("mcp__plugin_capex_code__"))
  );
}

// Parse JSON, returning null on missing/unreadable/invalid so we never clobber
// a file we can't safely understand.
function readJson(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try {
    return { data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { invalid: true };
  }
}

function writeJson(file, obj) {
  const tmp = file + ".capex.tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function cleanSettings(settingsPath, done) {
  const res = readJson(settingsPath);
  if (res.missing) return;
  if (res.invalid) {
    done.push(`! ${settingsPath} is not valid JSON — left untouched; remove the CAPEX statusLine by hand.`);
    return;
  }
  const settings = res.data;
  if (!settings || typeof settings !== "object") return;
  let changed = false;

  if (settings.statusLine && isCapexStatusLine(settings.statusLine.command)) {
    delete settings.statusLine;
    changed = true;
    done.push("removed CAPEX statusLine from settings.json");
  }
  if (settings.agent === CAPEX_AGENT) {
    delete settings.agent;
    changed = true;
    done.push('removed pinned "agent": "capex:code" from settings.json');
  }

  if (changed) writeJson(settingsPath, settings);
}

function cleanLocalSettings(localPath, done) {
  const res = readJson(localPath);
  if (res.missing || res.invalid) return;
  const settings = res.data;
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) return;

  const kept = allow.filter((e) => !isCapexPermission(e));
  if (kept.length !== allow.length) {
    settings.permissions.allow = kept;
    writeJson(localPath, settings);
    done.push(`removed ${allow.length - kept.length} CAPEX permission entr${allow.length - kept.length === 1 ? "y" : "ies"} from settings.local.json`);
  }
}

function main() {
  const purge = process.argv.slice(2).includes("--purge");
  const claudeDir = path.join(os.homedir(), ".claude");
  const done = [];

  cleanSettings(path.join(claudeDir, "settings.json"), done);
  cleanLocalSettings(path.join(claudeDir, "settings.local.json"), done);

  if (purge) {
    const capexDir = path.join(os.homedir(), ".capex");
    try {
      if (fs.existsSync(capexDir)) {
        fs.rmSync(capexDir, { recursive: true, force: true });
        done.push("removed ~/.capex (lifetime savings state)");
      }
    } catch (e) {
      done.push(`! could not remove ~/.capex: ${e && e.message ? e.message : e}`);
    }
  }

  console.log("CAPEX uninstall cleanup");
  console.log("=======================");
  if (done.length === 0) {
    console.log("Nothing to clean — no CAPEX settings found.");
  } else {
    for (const line of done) console.log(" - " + line);
  }
  console.log("");
  console.log("Settings are clean. To finish removing CAPEX, run these Claude Code commands:");
  console.log("  /plugin uninstall capex@capex-marketplace");
  console.log("  /plugin marketplace remove capex-marketplace");
  if (!purge) {
    console.log("");
    console.log("Your lifetime savings stats in ~/.capex were kept. To erase them too:");
    console.log("  re-run this with --purge, or:  rm -rf ~/.capex");
  }
  console.log("");
  console.log("Then restart Claude Code.");
}

main();
