package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fakeCatalog = `{
  "groups": [],
  "scenarios": [
    {"file":"db-slowdown-cascade.yaml","slug":"db-slowdown-cascade","title":"Database Slowdown Cascade","description":"Postgres slow queries cascade.","category":"incident","difficulty":"easy","durationTicks":1200,"serviceCount":5,"bytes":4544},
    {"file":"ddos-edge-mitigation.yaml","slug":"ddos-edge-mitigation","title":"DDoS at the Edge","description":"L7 flood saturates the edge LB.","category":"security","difficulty":"medium","durationTicks":1200,"serviceCount":6,"bytes":5147}
  ],
  "generatedAt": "2026-05-03T05:15:39.076Z"
}`

func startCatalogServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fakeCatalog))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("LOGSIM_BASE_URL", srv.URL)
	return srv
}

func TestListCmd_TablePrintsHeaderAndRows(t *testing.T) {
	startCatalogServer(t)

	cmd := newListCmd()
	var stdout bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetArgs(nil)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	out := stdout.String()
	for _, want := range []string{
		"SLUG", "CATEGORY", "DIFFICULTY", "DESCRIPTION",
		"db-slowdown-cascade", "incident", "easy", "Postgres slow queries cascade.",
		"ddos-edge-mitigation", "security", "medium", "L7 flood saturates the edge LB.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n----\n%s", want, out)
		}
	}
	// Header should be the first line.
	if first := strings.SplitN(out, "\n", 2)[0]; !strings.HasPrefix(first, "SLUG") {
		t.Errorf("first line should start with SLUG, got %q", first)
	}
}

func TestListCmd_QuietPrintsSlugsOnly(t *testing.T) {
	startCatalogServer(t)

	cmd := newListCmd()
	var stdout bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetArgs([]string{"-q"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	got := strings.TrimRight(stdout.String(), "\n")
	want := "db-slowdown-cascade\nddos-edge-mitigation"
	if got != want {
		t.Errorf("quiet output = %q, want %q", got, want)
	}
}

func TestListCmd_PropagatesFetchErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer srv.Close()
	t.Setenv("LOGSIM_BASE_URL", srv.URL)

	cmd := newListCmd()
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs(nil)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected 404 error, got %v", err)
	}
}
