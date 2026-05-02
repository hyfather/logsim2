package config

import (
	"os"
	"path/filepath"
)

// DefaultPath returns the path to the user's destinations dotfile, following
// the XDG Base Directory Specification:
//
//   - $LOGSIM_CONFIG, if set, wins outright
//   - $XDG_CONFIG_HOME/logsim/destinations.yaml
//   - $HOME/.config/logsim/destinations.yaml
//
// The returned path is not guaranteed to exist; callers should handle ENOENT.
func DefaultPath() string {
	if p := os.Getenv("LOGSIM_CONFIG"); p != "" {
		return p
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "logsim", "destinations.yaml")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".logsim", "destinations.yaml")
	}
	return filepath.Join(home, ".config", "logsim", "destinations.yaml")
}

// LoadDefault reads the dotfile at DefaultPath. If the file does not exist it
// returns an empty config and ok=false so callers can distinguish "no config"
// from "config exists but is empty".
func LoadDefault() (cfg *DestinationsConfig, path string, ok bool, err error) {
	path = DefaultPath()
	cfg, err = ParseFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &DestinationsConfig{}, path, false, nil
		}
		// ParseFile wraps with %w("open ...", err); also unwrap one level.
		if os.IsNotExist(unwrap(err)) {
			return &DestinationsConfig{}, path, false, nil
		}
		return nil, path, false, err
	}
	return cfg, path, true, nil
}

// unwrap returns the first wrapped error or err itself.
func unwrap(err error) error {
	type wrapper interface{ Unwrap() error }
	if w, ok := err.(wrapper); ok {
		if u := w.Unwrap(); u != nil {
			return u
		}
	}
	return err
}
