package main

import (
	"fmt"
	"io"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/nikhilm/logsim2/pkg/scenario"
)

func newListCmd() *cobra.Command {
	var quiet bool

	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List built-in scenarios from the LogSim catalog",
		Long: `List fetches the public scenario catalog (default ` + scenario.DefaultBaseURL + `/s/index.json,
override with $LOGSIM_BASE_URL) and prints one scenario per line. The
output is plain text with tab-padded columns — pipe it through grep, awk,
sort, etc.

Pass any of the SLUG values to ` + "`logsim run`" + ` directly:

  logsim run db-slowdown-cascade

Examples:
  logsim list                                  # full table
  logsim list | grep cascade                   # filter with grep
  logsim list -q                               # slugs only
  logsim list -q | xargs -L1 logsim validate   # validate every scenario`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cat, err := scenario.FetchCatalog()
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if quiet {
				for _, e := range cat.Scenarios {
					fmt.Fprintln(out, e.Slug)
				}
				return nil
			}
			return writeCatalogTable(out, cat.Scenarios)
		},
	}

	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "print only slugs, one per line (suitable for xargs)")
	return cmd
}

func writeCatalogTable(w io.Writer, entries []scenario.CatalogEntry) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "SLUG\tCATEGORY\tDIFFICULTY\tDESCRIPTION")
	for _, e := range entries {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", e.Slug, e.Category, e.Difficulty, e.Description)
	}
	return tw.Flush()
}
