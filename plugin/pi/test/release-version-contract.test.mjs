import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReleaseVersionAgreement } from "../release/version-contract.mjs";

function release(version = "1.2.3", route = "core") {
	return {
		route,
		releaseRef: `refs/tags/${route === "pi" ? "pi-v" : "v"}${version}`,
		packageVersion: version,
		installerVersion: version,
	};
}

const validVersions = [
	"0.0.0", "1.2.3", "1.2.3-0", "1.2.3-alpha.1", "1.2.3-rc.10+build.001",
	"1.2.3-x-y.z+abc-def.0", "1.2.3-01a", "1.2.3+001",
	"999999999999999999999999.2.3-999999999999999999999999+000",
];

const invalidVersions = [
	undefined, null, 123, {}, "", "v1.2.3", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03",
	"1.2.3-01", "1.2.3-alpha.01", "1.2.3-", "1.2.3+", "1.2.3-a..b", "1.2.3+a..b",
	"1.2.3-a_b", "1.2.3+a_b", "1.2.3+foo+bar", "1.2.3-é", "1.2.3+é",
	" 1.2.3", "1.2.3 ", "1.2.3\n", "1.2.3\r\n", "1.2.3\u0000", "１.2.3",
];

test("both explicit routes accept strict SemVer without numeric conversion", () => {
	for (const route of ["core", "pi"]) {
		for (const version of validVersions) {
			assert.equal(assertReleaseVersionAgreement({ ...release(version, route), piMetadataVersion: version }), version);
		}
	}
});

test("every supplied version must be a canonical SemVer string", () => {
	for (const field of ["packageVersion", "installerVersion", "piMetadataVersion"]) {
		for (const version of invalidVersions) {
			assert.throws(() => assertReleaseVersionAgreement({ ...release(), [field]: version }), /SemVer/, `${field}: ${String(version)}`);
		}
	}
	for (const field of ["packageVersion", "installerVersion"]) {
		const input = release();
		delete input[field];
		assert.throws(() => assertReleaseVersionAgreement(input), /SemVer/);
	}
});

test("agreement is exact, including prerelease and build metadata", () => {
	for (const field of ["installerVersion", "piMetadataVersion"]) {
		for (const version of ["1.2.4", "1.2.3-rc.1", "1.2.3+build.1"]) {
			assert.throws(() => assertReleaseVersionAgreement({ ...release(), [field]: version }), /must match package version/);
		}
	}
	assert.throws(() => assertReleaseVersionAgreement({ ...release("1.2.3+001"), installerVersion: "1.2.3+1" }), /must match/);
	assert.equal(assertReleaseVersionAgreement(release()), "1.2.3", "Pi metadata may be omitted");
});

test("release refs reject invalid versions, branches, shorthand and mixed routes", () => {
	for (const route of ["core", "pi"]) {
		const prefix = route === "pi" ? "pi-v" : "v";
		const refs = [
			undefined, null, 123, "", "refs/heads/main", `refs/heads/${prefix}1.2.3`,
			`${prefix}1.2.3`, `tags/${prefix}1.2.3`, `refs/tags/${prefix}1.2.3\n`,
			`refs/tags/${prefix}01.2.3`, `refs/tags/${prefix}1.2.3-01`,
			`refs/tags/${prefix}1.2.3+`, `refs/tags/${prefix}1.2.4`,
			`refs/tags/${prefix}1.2.3+build`, "refs/tags/pi-vv1.2.3",
			release("1.2.3", route === "pi" ? "core" : "pi").releaseRef,
		];
		for (const releaseRef of refs) {
			assert.throws(() => assertReleaseVersionAgreement({ ...release("1.2.3", route), releaseRef }), /must match package version/);
		}
	}
});

test("the route is required and validation does not mutate supplied metadata", () => {
	for (const route of [undefined, null, "", "train", "PI", 1]) {
		assert.throws(() => assertReleaseVersionAgreement({ ...release(), route }), /route/);
	}
	const input = Object.freeze(release());
	assert.equal(assertReleaseVersionAgreement(input), "1.2.3");
});
