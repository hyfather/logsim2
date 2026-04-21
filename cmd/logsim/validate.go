package main

import (
	"fmt"
	"os"

	"github.com/nikhilm/logsim2/pkg/scenario"
	"github.com/spf13/cobra"
)

func newValidateCmd() *cobra.Command {
	var scenarioPath string

	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Parse and validate a scenario YAML",
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := scenario.ValidateFile(scenarioPath)
			if err != nil {
				fmt.Fprintln(os.Stderr, "validation failed:", err)
				os.Exit(1)
			}
			fmt.Printf("OK  %q — %d node(s), %d service(s), %d connection(s)\n",
				s.Name, len(s.Nodes), len(s.Services), len(s.Connections))
			return nil
		},
	}

	cmd.Flags().StringVar(&scenarioPath, "scenario", "", "path to scenario YAML (required)")
	_ = cmd.MarkFlagRequired("scenario")

	return cmd
}
