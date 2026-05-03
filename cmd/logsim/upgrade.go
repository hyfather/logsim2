package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	installScriptURL = "https://raw.githubusercontent.com/hyfather/logsim2/master/scripts/install.sh"
	latestReleaseURL = "https://api.github.com/repos/hyfather/logsim2/releases/latest"
)

func newUpgradeCmd() *cobra.Command {
	var targetVersion string

	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Download and install the latest logsim release",
		Long: `Upgrade re-runs the official install script to fetch the latest released
binary from GitHub and replace the current logsim executable.

Pass --version vX.Y.Z to pin to a specific release tag. Set LOGSIM_PREFIX to
control the install location (defaults to /usr/local if writable, else
$HOME/.local).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			fetcher, err := pickFetcher()
			if err != nil {
				return err
			}
			if _, err := exec.LookPath("sh"); err != nil {
				return fmt.Errorf("sh is required to run the installer: %w", err)
			}

			fmt.Fprintf(os.Stderr, "logsim: current version %s\n", version)

			resolved := strings.TrimSpace(targetVersion)
			if resolved == "" {
				latest, err := resolveLatestTag(cmd.Context())
				if err != nil {
					return fmt.Errorf("could not resolve latest release tag: %w", err)
				}
				resolved = latest
				fmt.Fprintf(os.Stderr, "logsim: latest release is %s\n", resolved)
			}

			if sameVersion(version, resolved) {
				fmt.Fprintf(os.Stderr, "logsim: already on the latest version (%s)\n", resolved)
				return nil
			}

			fmt.Fprintln(os.Stderr, "logsim: fetching installer from", installScriptURL)

			pipeline := fmt.Sprintf("%s %s | sh", fetcher, installScriptURL)
			sh := exec.Command("sh", "-c", pipeline)
			sh.Stdin = os.Stdin
			sh.Stdout = os.Stdout
			sh.Stderr = os.Stderr
			sh.Env = append(os.Environ(), "LOGSIM_VERSION="+resolved)
			if err := sh.Run(); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "logsim: upgraded from %s to %s\n", version, resolved)
			return nil
		},
	}

	cmd.Flags().StringVar(&targetVersion, "version", "", "release tag to install (default: latest)")
	return cmd
}

func resolveLatestTag(ctx context.Context) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latestReleaseURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("GitHub API returned %s", resp.Status)
	}

	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	tag := strings.TrimSpace(payload.TagName)
	if tag == "" {
		return "", fmt.Errorf("GitHub release payload missing tag_name")
	}
	return tag, nil
}

// sameVersion reports whether the running build is already at target. A "dev"
// build (no -ldflags injection) is never considered up to date so the upgrade
// can still install a real release on top of it.
func sameVersion(current, target string) bool {
	c := strings.TrimPrefix(strings.TrimSpace(current), "v")
	t := strings.TrimPrefix(strings.TrimSpace(target), "v")
	if c == "" || c == "dev" {
		return false
	}
	return c == t
}

func pickFetcher() (string, error) {
	if _, err := exec.LookPath("curl"); err == nil {
		return "curl -fsSL", nil
	}
	if _, err := exec.LookPath("wget"); err == nil {
		return "wget -qO-", nil
	}
	return "", fmt.Errorf("upgrade requires either curl or wget on PATH")
}
