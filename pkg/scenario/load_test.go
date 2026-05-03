package scenario

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsHTTPURL(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"https://example.com/foo.yaml", true},
		{"http://example.com/foo.yaml", true},
		{"  HTTPS://EXAMPLE.com/foo.yaml ", true},
		{"./foo.yaml", false},
		{"/abs/foo.yaml", false},
		{"file:///foo.yaml", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsHTTPURL(tc.in); got != tc.want {
			t.Errorf("IsHTTPURL(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

const minimalScenario = `- name: Tiny
- nodes:
  - type: vpc
    name: vpc-a
- services: []
- connections: []
`

func TestLoad_FilePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tiny.scenario.yaml")
	if err := os.WriteFile(path, []byte(minimalScenario), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Name != "Tiny" {
		t.Errorf("Name = %q, want Tiny", s.Name)
	}
}

func TestLoad_HTTPURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") == "" {
			t.Errorf("client did not send Accept header")
		}
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = w.Write([]byte(minimalScenario))
	}))
	defer srv.Close()

	s, err := Load(srv.URL + "/scenarios/tiny.scenario.yaml")
	if err != nil {
		t.Fatalf("Load url: %v", err)
	}
	if s.Name != "Tiny" {
		t.Errorf("Name = %q, want Tiny", s.Name)
	}
}

func TestLoad_HTTPURL_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := Load(srv.URL + "/missing.yaml")
	if err == nil {
		t.Fatal("expected error for 404 response")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error %q does not mention 404", err)
	}
}

func TestLoad_HTTPURL_TooLarge(t *testing.T) {
	big := bytes.Repeat([]byte("a"), MaxRemoteScenarioBytes+10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(big)
	}))
	defer srv.Close()

	_, err := Load(srv.URL + "/huge.yaml")
	if err == nil {
		t.Fatal("expected error for oversized body")
	}
	if !strings.Contains(err.Error(), "byte cap") {
		t.Errorf("error %q does not mention byte cap", err)
	}
}

func TestLoad_HTTPURL_EmptyBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, err := Load(srv.URL + "/empty.yaml")
	if err == nil {
		t.Fatal("expected error for empty body")
	}
}

func TestLoadAndValidate_HTTPURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(minimalScenario))
	}))
	defer srv.Close()

	s, err := LoadAndValidate(srv.URL + "/tiny.scenario.yaml")
	if err != nil {
		t.Fatalf("LoadAndValidate: %v", err)
	}
	if s.Name != "Tiny" {
		t.Errorf("Name = %q, want Tiny", s.Name)
	}
}
