package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/nikhilm/logsim2/internal/server"
)

func newServeCmd() *cobra.Command {
	var (
		port       int
		corsOrigin string
		configPath string
	)

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run logsim as an HTTP server (SSE + bulk export)",
		RunE: func(cmd *cobra.Command, args []string) error {
			srv := server.New(corsOrigin, configPath)
			srv.WatchSIGHUP()

			addr := fmt.Sprintf(":%d", port)
			ln, err := net.Listen("tcp", addr)
			if err != nil {
				return fmt.Errorf("listen %s: %w", addr, err)
			}

			httpSrv := &http.Server{
				Handler: srv.Handler(),
				// WriteTimeout omitted — SSE connections are long-lived.
				ReadTimeout: 30 * time.Second,
				IdleTimeout: 120 * time.Second,
			}

			ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer cancel()

			go func() {
				<-ctx.Done()
				shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer shutdownCancel()
				_ = httpSrv.Shutdown(shutdownCtx)
			}()

			fmt.Fprintf(os.Stderr, "logsim: serving on http://localhost%s\n", addr)
			if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
				return err
			}
			return nil
		},
	}

	cmd.Flags().IntVar(&port, "port", 8080, "HTTP port to listen on")
	cmd.Flags().StringVar(&corsOrigin, "cors-origin", "*", "allowed CORS origin")
	cmd.Flags().StringVar(&configPath, "config", "", "path to destinations.yaml")

	return cmd
}
