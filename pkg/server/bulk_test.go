package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBulk_ReturnsZIP(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate/bulk", simulateRequest(minimalYAML, 3, 42))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	ct := w.Header().Get("Content-Type")
	if ct != "application/zip" {
		t.Errorf("expected application/zip, got %q", ct)
	}
}

func TestBulk_ContainsManifestAndChannelFiles(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate/bulk", simulateRequest(minimalYAML, 3, 42))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	body := w.Body.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open ZIP: %v", err)
	}

	fileNames := map[string]bool{}
	for _, f := range zr.File {
		fileNames[f.Name] = true
	}

	if !fileNames["manifest.json"] {
		t.Error("ZIP missing manifest.json")
	}
	if len(zr.File) < 2 {
		t.Errorf("expected at least 2 files in ZIP (manifest + 1 channel), got %d", len(zr.File))
	}
	t.Logf("ZIP files: %v", func() []string {
		names := make([]string, len(zr.File))
		for i, f := range zr.File {
			names[i] = f.Name
		}
		return names
	}())
}

func TestBulk_ManifestStructure(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate/bulk", simulateRequest(minimalYAML, 3, 42))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	body := w.Body.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open ZIP: %v", err)
	}

	var manifestFile *zip.File
	for _, f := range zr.File {
		if f.Name == "manifest.json" {
			manifestFile = f
			break
		}
	}
	if manifestFile == nil {
		t.Fatal("manifest.json not found in ZIP")
	}

	rc, _ := manifestFile.Open()
	defer rc.Close()

	var manifest map[string]any
	if err := json.NewDecoder(rc).Decode(&manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}

	for _, field := range []string{"generated_at", "ticks", "scenario", "files"} {
		if _, ok := manifest[field]; !ok {
			t.Errorf("manifest missing field %q", field)
		}
	}
	if manifest["scenario"] != "Test Scenario" {
		t.Errorf("scenario: got %v, want 'Test Scenario'", manifest["scenario"])
	}
}

func TestBulk_ChannelFilesAreValidJSONL(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate/bulk", simulateRequest(minimalYAML, 3, 42))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	body := w.Body.Bytes()
	zr, _ := zip.NewReader(bytes.NewReader(body), int64(len(body)))

	for _, f := range zr.File {
		if f.Name == "manifest.json" || !strings.HasSuffix(f.Name, ".jsonl") {
			continue
		}
		rc, _ := f.Open()
		defer rc.Close()

		scanner := &lineScanner{}
		scanner.scan(rc)
		for i, line := range scanner.lines {
			if line == "" {
				continue
			}
			var v map[string]any
			if err := json.Unmarshal([]byte(line), &v); err != nil {
				t.Errorf("file %s line %d: invalid JSON: %v", f.Name, i+1, err)
			}
		}
	}
}

// lineScanner is a minimal line reader for test use.
type lineScanner struct {
	lines []string
}

func (s *lineScanner) scan(r interface{ Read([]byte) (int, error) }) {
	buf := new(bytes.Buffer)
	tmp := make([]byte, 1024)
	for {
		n, err := r.Read(tmp)
		buf.Write(tmp[:n])
		if err != nil {
			break
		}
	}
	for _, l := range strings.Split(buf.String(), "\n") {
		s.lines = append(s.lines, strings.TrimSpace(l))
	}
}

func TestBulk_InvalidBody(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/simulate/bulk", strings.NewReader(`not json`))
	r.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}
