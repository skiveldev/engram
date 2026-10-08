#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const PACKAGE_NAME = `npm:${packageMetadata.name}@${packageMetadata.version}`;
const PIN = /^npm:gentle-engram@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(?![\s\S])/;
const BLOCKED = "Pi Engram pin ownership blocked; use pi-engram adopt <exact-package> for a single version pin without a marker";
const HELP = `pi-engram

Usage:
  pi-engram init [--force]
  pi-engram adopt <exact-package>

Adopt explicitly authorizes management of one existing exact version pin.
It records consent without migrating or installing; conflicts/custom specs block.
Ensures gentle-engram is declared in settings.json.
Does not create or modify Pi MCP config and does not add an MCP adapter
extension (Pi's built-in MCP reads mcp.json). Install the extension with:
pi install ${PACKAGE_NAME}
`;

function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readJsonObject(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function writeJsonObject(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function ensureEngramPackage(settingsPath, adoption) {
  const settings = readJsonObject(settingsPath);
  if (Object.hasOwn(settings, "packages") && !Array.isArray(settings.packages)) throw new Error(BLOCKED);
  const packages = settings.packages || [];
  const refs = packages.filter((value) => JSON.stringify(value).includes("gentle-engram"));
  const marked = Object.hasOwn(settings, "engramManagedPin");
  const marker = settings.engramManagedPin;
  const valid = refs.length === 1 && typeof refs[0] === "string" && PIN.test(refs[0]);
  if (adoption !== undefined) {
    if (marked || !valid || adoption !== refs[0]) throw new Error(BLOCKED);
    settings.engramManagedPin = { schema: 1, package: adoption };
    writeJsonObject(settingsPath, settings);
    console.log(`Authorized management of ${adoption}; package unchanged`);
    return false;
  }
  if (marked ? (!valid || !marker || Array.isArray(marker) || Object.keys(marker).length !== 2 || marker.schema !== 1 || marker.package !== refs[0]) : refs.length !== 0) {
    throw new Error(BLOCKED);
  }
  if (marked && refs[0] === PACKAGE_NAME) return false;
  if (marked) packages[packages.indexOf(refs[0])] = PACKAGE_NAME;
  else packages.push(PACKAGE_NAME);
  settings.packages = packages;
  settings.engramManagedPin = { schema: 1, package: PACKAGE_NAME };
  writeJsonObject(settingsPath, settings);
  return true;
}

function warnExistingEngramMcp(mcpPath) {
  const config = readJsonObject(mcpPath);
  if (config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) && Object.hasOwn(config.mcpServers, "engram")) {
    console.warn(`Warning: ${mcpPath} contains mcpServers.engram. Pi native-only agent writes are not guaranteed while this MCP path remains. To use native-only writes, manually remove only mcpServers.engram from ${mcpPath} (preserve other servers), then restart/reload Pi.`);
  }
}

function init() {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  const mcpPath = join(agentDir, "mcp.json");

  const packageChanged = ensureEngramPackage(settingsPath);
  warnExistingEngramMcp(mcpPath);

  console.log(`Pi agent dir: ${agentDir}`);
  console.log(`${packageChanged ? "Added" : "Kept"} ${PACKAGE_NAME} in settings.json`);
  console.log("Pi-native mem_* tools own agent writes; no Engram MCP registration is created.");
  console.log("Set ENGRAM_URL for an existing engram serve instance, or ENGRAM_BIN for a custom engram binary path.");
}

const command = process.argv[2];
try {
  if (command === "init" && (process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === "--force"))) {
    init();
  } else if (command === "adopt") {
    if (process.argv.length !== 4 || !PIN.test(process.argv[3])) throw new Error(BLOCKED);
    ensureEngramPackage(join(getAgentDir(), "settings.json"), process.argv[3]);
  } else {
    console.log(HELP);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
