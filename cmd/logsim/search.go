package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/nikhilm/logsim2/pkg/search"
)

func newSearchCmd() *cobra.Command {
	var (
		port    int
		noTUI   bool
	)

	cmd := &cobra.Command{
		Use:   "search",
		Short: "Run an in-process log search daemon with a TUI",
		Long: `Search starts the logsim search daemon and drops into a TUI.

The daemon listens on http://127.0.0.1:3700 (override with --port). It exposes
a Splunk/Cribl-compatible HEC ingest endpoint plus a small set of information-
retrieval functions backed by an in-memory DuckDB:

  POST   /dbs                                     — create a db
  GET    /dbs                                     — list dbs
  DELETE /dbs/{code}                              — delete a db
  POST   /dbs/{code}/services/collector/event     — HEC NDJSON ingest
  POST   /dbs/{code}/services/collector/raw       — HEC raw-line ingest
  POST   /dbs/{code}/get_raw                      — IR: raw events
  POST   /dbs/{code}/get_summary                  — IR: aggregations
  POST   /dbs/{code}/get_distribution             — IR: time-bucketed counts
  POST   /dbs/{code}/get_top_values               — IR: top N field values

Each db is identified by a 6-char alphanumeric code (a–z, 0–9). Codes are
generated on POST /dbs unless the caller supplies one.

Forwarding from the same machine:

  logsim run web-service --to local           # auto db code from scenario
  logsim run web-service --to local:abc123    # pin to a specific code

The TUI shows a live list of dbs with event counts; press Enter on a row to
spot-check the first 100 raw lines. Press q or Ctrl-C to exit — every db is
deleted on shutdown.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			addr := fmt.Sprintf("127.0.0.1:%d", port)
			ln, err := net.Listen("tcp", addr)
			if err != nil {
				return fmt.Errorf("listen %s: %w", addr, err)
			}

			reg := search.NewRegistry(func() (search.Backend, error) {
				return search.NewDuckDBBackend()
			})

			srv := search.NewServer(reg)
			httpSrv := &http.Server{
				Handler:     srv.Handler(),
				ReadTimeout: 30 * time.Second,
				IdleTimeout: 120 * time.Second,
			}

			ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer cancel()

			serveErr := make(chan error, 1)
			go func() {
				if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
					serveErr <- err
					return
				}
				serveErr <- nil
			}()

			displayAddr := "http://" + addr
			if noTUI {
				fmt.Fprintf(os.Stderr, "logsim search: listening on %s\n", displayAddr)
				fmt.Fprintln(os.Stderr, "logsim search: ctrl-c to quit (deletes all dbs)")
				select {
				case <-ctx.Done():
				case err := <-serveErr:
					if err != nil {
						return err
					}
				}
			} else {
				if err := search.RunTUI(ctx, search.TUIOptions{
					Address:         displayAddr,
					Registry:        reg,
					RefreshInterval: time.Second,
				}); err != nil {
					fmt.Fprintf(os.Stderr, "tui: %v\n", err)
				}
			}

			// Shutdown order: stop accepting → close registry → drain serve goroutine.
			shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer shutCancel()
			_ = httpSrv.Shutdown(shutCtx)
			_ = reg.Close()
			<-serveErr
			return nil
		},
	}

	cmd.Flags().IntVar(&port, "port", search.DefaultPort, "HTTP port to listen on")
	cmd.Flags().BoolVar(&noTUI, "no-tui", false, "skip the TUI; useful for scripting/CI")
	return cmd
}
