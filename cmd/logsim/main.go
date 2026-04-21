package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func main() {
	root := &cobra.Command{
		Use:   "logsim",
		Short: "Infrastructure log simulator",
		Long:  "LogSim generates realistic infrastructure logs from a scenario YAML.",
	}

	root.AddCommand(
		newValidateCmd(),
		newRunCmd(),
		newServeCmd(),
	)

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
