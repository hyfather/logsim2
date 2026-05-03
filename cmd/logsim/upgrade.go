package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

const installScriptURL = "https://raw.githubusercontent.com/hyfather/logsim2/main/scripts/install.sh"

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
			fmt.Fprintln(os.Stderr, "logsim: fetching installer from", installScriptURL)

			pipeline := fmt.Sprintf("%s %s | sh", fetcher, installScriptURL)
			sh := exec.Command("sh", "-c", pipeline)
			sh.Stdin = os.Stdin
			sh.Stdout = os.Stdout
			sh.Stderr = os.Stderr
			if targetVersion != "" {
				sh.Env = append(os.Environ(), "LOGSIM_VERSION="+targetVersion)
			}
			return sh.Run()
		},
	}

	cmd.Flags().StringVar(&targetVersion, "version", "", "release tag to install (default: latest)")
	return cmd
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
