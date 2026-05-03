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
		Use:   "validate [scenario.yaml | https://…/scenario.yaml]",
		Short: "Parse and validate a scenario YAML",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			switch {
			case len(args) == 1 && scenarioPath == "":
				scenarioPath = args[0]
			case len(args) == 1 && scenarioPath != "" && scenarioPath != args[0]:
				return fmt.Errorf("scenario specified twice: positional %q and --scenario %q",
					args[0], scenarioPath)
			case len(args) == 0 && scenarioPath == "":
				return fmt.Errorf("scenario is required: pass it positionally (`logsim validate path/to/scenario.yaml` or a URL) or via --scenario")
			}

			s, err := scenario.LoadAndValidate(scenarioPath)
			if err != nil {
				fmt.Fprintln(os.Stderr, "validation failed:", err)
				os.Exit(1)
			}
			fmt.Printf("OK  %q — %d node(s), %d service(s), %d connection(s)\n",
				s.Name, len(s.Nodes), len(s.Services), len(s.Connections))
			return nil
		},
	}

	cmd.Flags().StringVar(&scenarioPath, "scenario", "", "path or http(s) URL of the scenario YAML (or pass it positionally)")

	return cmd
}
