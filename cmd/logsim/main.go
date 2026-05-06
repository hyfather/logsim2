package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	root := &cobra.Command{
		Use:     "logsim",
		Short:   "Infrastructure log simulator",
		Long:    "LogSim generates realistic infrastructure logs from a scenario YAML.",
		Version: version,
	}
	root.SetVersionTemplate("logsim {{.Version}}\n")

	root.AddCommand(
		newValidateCmd(),
		newRunCmd(),
		newListCmd(),
		newServeCmd(),
		newSearchCmd(),
		newDestinationsCmd(),
		newUpgradeCmd(),
	)

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
