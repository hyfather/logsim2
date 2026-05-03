package scenario

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveSource_URLPassThrough(t *testing.T) {
	t.Setenv("LOGSIM_BASE_URL", "https://example.com")
	in := "https://other.example/foo.yaml"
	if got := ResolveSource(in); got != in {
		t.Errorf("ResolveSource(%q) = %q, want unchanged", in, got)
	}
}

func TestResolveSource_ExistingFilePassThrough(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tiny.yaml")
	if err := os.WriteFile(path, []byte("- name: x\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := ResolveSource(path); got != path {
		t.Errorf("ResolveSource(%q) = %q, want unchanged", path, got)
	}
}

func TestResolveSource_SlugMappedToURL(t *testing.T) {
	t.Setenv("LOGSIM_BASE_URL", "https://example.com")
	got := ResolveSource("db-slowdown-cascade")
	want := "https://example.com/s/db-slowdown-cascade.yaml"
	if got != want {
		t.Errorf("ResolveSource(slug) = %q, want %q", got, want)
	}
}

func TestResolveSource_PathLikeNotASlug(t *testing.T) {
	// A missing file path should NOT silently be rewritten as a slug —
	// it must pass through so the file loader can produce a "no such file" error.
	t.Setenv("LOGSIM_BASE_URL", "https://example.com")
	cases := []string{
		"missing.yaml",
		"./scenarios/missing.yaml",
		"/abs/path/missing.yaml",
		"with spaces",
	}
	for _, in := range cases {
		got := ResolveSource(in)
		if strings.HasPrefix(got, "https://example.com/s/") {
			t.Errorf("ResolveSource(%q) = %q, must not be treated as slug", in, got)
		}
	}
}

func TestIsSlug(t *testing.T) {
	yes := []string{"db-slowdown-cascade", "alpha", "alpha_beta", "Alpha-1", "X1"}
	no := []string{
		"", "with space", "has/slash", "ends.with.dot",
		"file.yaml", "scenarios/web", "../foo",
	}
	for _, s := range yes {
		if !isSlug(s) {
			t.Errorf("isSlug(%q) = false, want true", s)
		}
	}
	for _, s := range no {
		if isSlug(s) {
			t.Errorf("isSlug(%q) = true, want false", s)
		}
	}
}

// End-to-end: a slug should round-trip through Load to an HTTP fetch.
func TestLoad_SlugFetchesFromBaseURL(t *testing.T) {
	const tiny = `- name: Tiny
- nodes:
  - type: vpc
    name: vpc-a
- services: []
- connections: []
`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/s/some-slug.yaml" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(tiny))
	}))
	defer srv.Close()
	t.Setenv("LOGSIM_BASE_URL", srv.URL)

	s, err := Load("some-slug")
	if err != nil {
		t.Fatalf("Load(slug): %v", err)
	}
	if s.Name != "Tiny" {
		t.Errorf("Name = %q, want Tiny", s.Name)
	}
}
