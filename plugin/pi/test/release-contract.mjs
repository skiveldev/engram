import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertReleaseVersionAgreement } from "../release/version-contract.mjs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const evidenceArgs = process.argv.slice(3);
if (evidenceArgs.length && (evidenceArgs.length !== 2 || evidenceArgs[0] !== "--core-evidence" || !evidenceArgs[1])) {
	process.stderr.write("Pi release contract requires --core-evidence <setup.go path>\n");
	process.exit(1);
}
const installerPath = evidenceArgs.length ? evidenceArgs[1] : new URL("../../../internal/setup/setup.go", import.meta.url);
let installerSource;
try {
	installerSource = readFileSync(installerPath, "utf8");
} catch (error) {
	if (!evidenceArgs.length) throw error;
	process.stderr.write("Pi release contract cannot read core installer evidence\n");
	process.exit(1);
}
const installerPinMatches = [...installerSource.matchAll(/^\s*piGentleEngramPackage\s*=\s*"npm:gentle-engram@([^"]+)"\s*$/gm)];
const packageName = `npm:${packageMetadata.name}@${packageMetadata.version}`;

if (installerPinMatches.length === 0) {
	if (!evidenceArgs.length) throw new Error("Pi installer pin npm:gentle-engram@<version> is missing from internal/setup/setup.go");
	process.stderr.write("Pi installer pin npm:gentle-engram@<version> is missing from internal/setup/setup.go\n");
	process.exit(1);
}
if (installerPinMatches.length !== 1) {
	if (!evidenceArgs.length) throw new Error("Pi installer pin npm:gentle-engram@<version> is ambiguous in internal/setup/setup.go");
	process.stderr.write("Pi installer pin npm:gentle-engram@<version> is ambiguous in internal/setup/setup.go\n");
	process.exit(1);
}

const installerVersion = installerPinMatches[0][1];
try {
	assertReleaseVersionAgreement({
		route: "pi",
		releaseRef: process.argv[2],
		packageVersion: packageMetadata.version,
		installerVersion,
	});
} catch (error) {
	if (!evidenceArgs.length) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

const help = execFileSync(process.execPath, [cliPath], { encoding: "utf8" });
if (!help.includes(`pi install ${packageName}`)) {
	throw new Error(`Pi CLI help must include the current package ${packageName}`);
}
