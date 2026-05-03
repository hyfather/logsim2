package scenario

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const sampleCatalog = `{
  "groups": [
    {"id": "incident", "label": "Production Incidents", "description": "Outages.", "order": 1}
  ],
  "scenarios": [
    {
      "file": "db-slowdown-cascade.yaml",
      "slug": "db-slowdown-cascade",
      "title": "Database Slowdown Cascade",
      "description": "Postgres slow queries cascade.",
      "category": "incident",
      "difficulty": "easy",
      "durationTicks": 1200,
      "serviceCount": 5,
      "bytes": 4544
    },
    {
      "file": "ddos-edge-mitigation.yaml",
      "slug": "ddos-edge-mitigation",
      "title": "DDoS at the Edge",
      "description": "L7 flood saturates the edge LB.",
      "category": "security",
      "difficulty": "medium",
      "durationTicks": 1200,
      "serviceCount": 6,
      "bytes": 5147
    }
  ],
  "generatedAt": "2026-05-03T05:15:39.076Z"
}`

func TestBaseURL_DefaultAndOverride(t *testing.T) {
	t.Setenv("LOGSIM_BASE_URL", "")
	if got := BaseURL(); got != DefaultBaseURL {
		t.Errorf("BaseURL() default = %q, want %q", got, DefaultBaseURL)
	}
	t.Setenv("LOGSIM_BASE_URL", "https://example.com/")
	if got := BaseURL(); got != "https://example.com" {
		t.Errorf("BaseURL() with trailing slash = %q, want trimmed", got)
	}
	t.Setenv("LOGSIM_BASE_URL", "  https://example.com  ")
	if got := BaseURL(); got != "https://example.com" {
		t.Errorf("BaseURL() with whitespace = %q, want trimmed", got)
	}
}

func TestSlugURL(t *testing.T) {
	t.Setenv("LOGSIM_BASE_URL", "https://example.com")
	if got, want := SlugURL("db-slowdown-cascade"), "https://example.com/s/db-slowdown-cascade.yaml"; got != want {
		t.Errorf("SlugURL = %q, want %q", got, want)
	}
}

func TestFetchCatalog_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/s/index.json" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if accept := r.Header.Get("Accept"); !strings.Contains(accept, "json") {
			t.Errorf("missing Accept: json header, got %q", accept)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sampleCatalog))
	}))
	defer srv.Close()
	t.Setenv("LOGSIM_BASE_URL", srv.URL)

	cat, err := FetchCatalog()
	if err != nil {
		t.Fatalf("FetchCatalog: %v", err)
	}
	if len(cat.Scenarios) != 2 {
		t.Fatalf("Scenarios = %d, want 2", len(cat.Scenarios))
	}
	if cat.Scenarios[0].Slug != "db-slowdown-cascade" {
		t.Errorf("first slug = %q", cat.Scenarios[0].Slug)
	}
	if cat.Scenarios[0].Description == "" {
		t.Errorf("description should be populated")
	}
	if len(cat.Groups) != 1 || cat.Groups[0].ID != "incident" {
		t.Errorf("groups not parsed: %+v", cat.Groups)
	}
}

func TestFetchCatalog_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer srv.Close()
	t.Setenv("LOGSIM_BASE_URL", srv.URL)

	_, err := FetchCatalog()
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected 404 error, got %v", err)
	}
}

func TestFetchCatalog_BadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()
	t.Setenv("LOGSIM_BASE_URL", srv.URL)

	_, err := FetchCatalog()
	if err == nil || !strings.Contains(err.Error(), "decode") {
		t.Fatalf("expected decode error, got %v", err)
	}
}
