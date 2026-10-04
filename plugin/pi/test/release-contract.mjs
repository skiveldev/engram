import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertReleaseVersionAgreement } from "../release/version-contract.mjs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const installerSource = readFileSync(new URL("../../../internal/setup/setup.go", import.meta.url), "utf8");
const installerPinMatches = [...installerSource.matchAll(/^\s*piGentleEngramPackage\s*=\s*"npm:gentle-engram@([^"]+)"\s*$/gm)];
const packageName = `npm:${packageMetadata.name}@${packageMetadata.version}`;

if (installerPinMatches.length === 0) {
	throw new Error("Pi installer pin npm:gentle-engram@<version> is missing from internal/setup/setup.go");
}
if (installerPinMatches.length !== 1) {
	throw new Error("Pi installer pin npm:gentle-engram@<version> is ambiguous in internal/setup/setup.go");
}

const installerVersion = installerPinMatches[0][1];
assertReleaseVersionAgreement({
	route: "pi",
	releaseRef: process.argv[2],
	packageVersion: packageMetadata.version,
	installerVersion,
});
const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

const help = execFileSync(process.execPath, [cliPath], { encoding: "utf8" });
if (!help.includes(`pi install ${packageName}`)) {
	throw new Error(`Pi CLI help must include the current package ${packageName}`);
}
