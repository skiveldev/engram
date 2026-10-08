package engram_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestReleaseChecksModuleMetadataWithoutMutatingTaggedSources(t *testing.T) {
	root := releaseConfigRepoRoot(t)
	goreleaser := releaseConfigFile(t, filepath.Join(root, ".goreleaser.yaml"))
	if strings.Contains(goreleaser, "go mod tidy") {
		t.Fatal(".goreleaser.yaml must not run go mod tidy during a release")
	}

	workflow := releaseConfigFile(t, filepath.Join(root, ".github", "workflows", "release.yml"))
	if strings.Count(workflow, "\n  coordinated:\n") != 1 ||
		strings.Count(workflow, "run: node .github/scripts/coordinated-release.mjs") != 1 ||
		!strings.Contains(workflow, `go-version: "1.25.10"`) || strings.Contains(workflow, "args: release") {
		t.Fatal("release workflow must delegate its sole release to the coordinated driver after Go setup")
	}
	driver := releaseConfigFile(t, filepath.Join(root, ".github", "scripts", "coordinated-release.mjs"))
	tidy := strings.Index(driver, "await call('go', ['mod', 'tidy', '-diff'])")
	build := strings.Index(driver, "await call('goreleaser'")
	if tidy < 0 || build <= tidy {
		t.Fatal("driver must gate the core build with nonmutating go mod tidy -diff")
	}
}

// modulePath must carry the major-version suffix of the release line so that
// `go install <modulePath>/cmd/engram@latest` resolves the tagged release.
const modulePath = "github.com/Gentleman-Programming/engram/v3"

func TestModulePathMatchesReleaseMajorVersion(t *testing.T) {
	root := releaseConfigRepoRoot(t)
	goMod := strings.ReplaceAll(releaseConfigFile(t, filepath.Join(root, "go.mod")), "\r\n", "\n")
	firstLine, _, _ := strings.Cut(goMod, "\n")
	if want := "module " + modulePath; firstLine != want {
		t.Fatalf("go.mod module line = %q, want %q", firstLine, want)
	}

	install := "go install " + modulePath + "/cmd/engram@latest"
	installation := releaseConfigFile(t, filepath.Join(root, "docs", "INSTALLATION.md"))
	if strings.Count(installation, install) < 2 {
		t.Fatalf("docs/INSTALLATION.md must document %q for both Windows and macOS/Linux", install)
	}
}

// releaseWorkflowGoreleaserJob extracts this repository's one top-level job.
// It deliberately is not a YAML parser: the exact job text is the contract.
func releaseWorkflowGoreleaserJob(workflow string) (string, bool) {
	const jobMarker = "\n  goreleaser:\n"
	workflow = strings.ReplaceAll(workflow, "\r\n", "\n")
	if strings.Count(workflow, jobMarker) != 1 {
		return "", false
	}

	start := strings.Index(workflow, jobMarker) + 1
	job := workflow[start:]
	for offset := len(jobMarker) - 1; ; {
		nextJob := strings.Index(job[offset:], "\n  ")
		if nextJob < 0 {
			break
		}
		nextJob += offset
		if nextJob+3 == len(job) || job[nextJob+3] != ' ' {
			job = job[:nextJob]
			break
		}
		offset = nextJob + 3
	}
	return job, true
}

func releaseConfigRepoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Dir(file)
}

func releaseConfigFile(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(content)
}
