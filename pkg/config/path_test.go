package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultPath_LogsimEnvWins(t *testing.T) {
	t.Setenv("LOGSIM_CONFIG", "/tmp/custom.yaml")
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	if got, want := DefaultPath(), "/tmp/custom.yaml"; got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}

func TestDefaultPath_XDG(t *testing.T) {
	t.Setenv("LOGSIM_CONFIG", "")
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	if got, want := DefaultPath(), "/tmp/xdg/logsim/destinations.yaml"; got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}

func TestDefaultPath_HomeFallback(t *testing.T) {
	t.Setenv("LOGSIM_CONFIG", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/tmp/fakehome")
	if got, want := DefaultPath(), "/tmp/fakehome/.config/logsim/destinations.yaml"; got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}

func TestLoadDefault_MissingReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOGSIM_CONFIG", filepath.Join(dir, "does-not-exist.yaml"))
	cfg, _, ok, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault: %v", err)
	}
	if ok {
		t.Error("ok should be false when the file does not exist")
	}
	if cfg == nil || len(cfg.Destinations) != 0 {
		t.Errorf("expected empty config, got %+v", cfg)
	}
}

func TestSaveAndReload_Roundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "destinations.yaml")
	t.Setenv("LOGSIM_CONFIG", path)

	cfg := &DestinationsConfig{
		Destinations: []Destination{{
			Name:      "alpha",
			Type:      DestinationTypeCribl,
			Enabled:   true,
			URL:       "https://hec.example.com/services/collector/event",
			Token:     "shh",
			BatchSize: 50,
			Format:    "ocsf",
		}},
	}
	if err := cfg.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("file perm = %o, want 600", perm)
	}

	reloaded, _, ok, err := LoadDefault()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !ok {
		t.Fatal("expected ok=true after save")
	}
	if len(reloaded.Destinations) != 1 || reloaded.Destinations[0].Name != "alpha" {
		t.Fatalf("unexpected reload: %+v", reloaded)
	}
	if reloaded.Destinations[0].Token != "shh" {
		t.Errorf("token not roundtripped: %q", reloaded.Destinations[0].Token)
	}
}

func TestUpsertReplace(t *testing.T) {
	cfg := &DestinationsConfig{Destinations: []Destination{
		{Name: "a", Type: DestinationTypeCribl, URL: "https://a", Token: "t"},
	}}
	replaced := cfg.Upsert(Destination{
		Name: "a", Type: DestinationTypeCribl, URL: "https://a2", Token: "t2", Enabled: true,
	})
	if !replaced {
		t.Error("Upsert should report replacement")
	}
	if len(cfg.Destinations) != 1 || cfg.Destinations[0].URL != "https://a2" {
		t.Errorf("unexpected after replace: %+v", cfg.Destinations)
	}

	added := cfg.Upsert(Destination{
		Name: "b", Type: DestinationTypeCribl, URL: "https://b", Token: "t",
	})
	if added {
		t.Error("Upsert of new name should report added (false)")
	}
	if len(cfg.Destinations) != 2 {
		t.Errorf("expected 2 destinations, got %d", len(cfg.Destinations))
	}
}

func TestRemoveAndSetEnabled(t *testing.T) {
	cfg := &DestinationsConfig{Destinations: []Destination{
		{Name: "x", Enabled: true},
		{Name: "y", Enabled: false},
	}}
	if ok := cfg.SetEnabled("y", true); !ok || !cfg.Destinations[1].Enabled {
		t.Error("SetEnabled failed")
	}
	if ok := cfg.SetEnabled("missing", true); ok {
		t.Error("SetEnabled on missing name should return false")
	}
	if ok := cfg.Remove("x"); !ok || len(cfg.Destinations) != 1 {
		t.Error("Remove failed")
	}
	if ok := cfg.Remove("missing"); ok {
		t.Error("Remove on missing name should return false")
	}
}

func TestEnabledDestinations(t *testing.T) {
	cfg := &DestinationsConfig{Destinations: []Destination{
		{Name: "a", Enabled: true},
		{Name: "b", Enabled: false},
		{Name: "c", Enabled: true},
	}}
	got := cfg.EnabledDestinations()
	if len(got) != 2 || got[0].Name != "a" || got[1].Name != "c" {
		t.Errorf("unexpected: %+v", got)
	}
}
