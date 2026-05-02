package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"github.com/nikhilm/logsim2/pkg/config"
)

func newDestinationsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "destinations",
		Aliases: []string{"dest", "dst"},
		Short:   "Manage forwarding destinations stored in the dotfile",
		Long: "Destinations live in " + config.DefaultPath() + " (override with " +
			"$LOGSIM_CONFIG). Each destination is a named log target — currently " +
			"Cribl Stream / Splunk HEC.",
	}

	cmd.AddCommand(
		newDestAddCmd(),
		newDestListCmd(),
		newDestRemoveCmd(),
		newDestEnableCmd(true),
		newDestEnableCmd(false),
		newDestTestCmd(),
		newDestPathCmd(),
	)
	return cmd
}

// --- add ---------------------------------------------------------------

func newDestAddCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add",
		Short: "Add a destination via interactive form",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, path, _, err := config.LoadDefault()
			if err != nil {
				return err
			}
			d, err := promptDestination(cfg)
			if err != nil {
				return err
			}
			replaced := cfg.Upsert(d)
			if err := cfg.Save(path); err != nil {
				return err
			}
			verb := "Added"
			if replaced {
				verb = "Updated"
			}
			fmt.Fprintf(os.Stderr, "%s destination %q in %s\n", verb, d.Name, path)
			return nil
		},
	}
}

// promptDestination drives the huh form. existingNames is used to warn (not
// block) on overwrite — overwriting an existing destination is allowed and
// announced via "Updated" instead of "Added".
func promptDestination(cfg *config.DestinationsConfig) (config.Destination, error) {
	var (
		name      string
		urlStr    string
		token     string
		formatStr = "native"
		batchStr  = "100"
		flushStr  = "2000"
		enabled   = true
	)

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Name").
				Description("A short, unique label (e.g. prod-cribl).").
				Value(&name).
				Validate(func(s string) error {
					s = strings.TrimSpace(s)
					if s == "" {
						return errors.New("name is required")
					}
					if strings.ContainsAny(s, " \t\n") {
						return errors.New("name must not contain whitespace")
					}
					return nil
				}),
			huh.NewInput().
				Title("HEC URL").
				Description("Full Splunk/Cribl HEC endpoint, e.g. https://host/services/collector/event").
				Value(&urlStr).
				Validate(func(s string) error {
					s = strings.TrimSpace(s)
					if s == "" {
						return errors.New("url is required")
					}
					u, err := url.Parse(s)
					if err != nil || u.Scheme == "" || u.Host == "" {
						return errors.New("must be an absolute URL (https://...)")
					}
					return nil
				}),
			huh.NewInput().
				Title("HEC token").
				Description("The HEC token. Stored in plain text in the dotfile (chmod 0600).").
				EchoMode(huh.EchoModePassword).
				Value(&token).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return errors.New("token is required")
					}
					return nil
				}),
			huh.NewSelect[string]().
				Title("Wire format").
				Description("Schema applied before forwarding.").
				Options(
					huh.NewOption("native (raw log line)", "native"),
					huh.NewOption("ocsf (OCSF v1.x JSON)", "ocsf"),
					huh.NewOption("otel (OTLP/JSON LogRecord)", "otel"),
					huh.NewOption("udm (reserved → native)", "udm"),
					huh.NewOption("asim (reserved → native)", "asim"),
				).
				Value(&formatStr),
			huh.NewInput().
				Title("Batch size").
				Description("Events per HTTP POST. 1–500.").
				Value(&batchStr).
				Validate(intInRange(1, 500)),
			huh.NewInput().
				Title("Flush interval (ms)").
				Description("Background flush cadence. 0 = flush only on full batches.").
				Value(&flushStr).
				Validate(intInRange(0, 600_000)),
			huh.NewConfirm().
				Title("Enable now?").
				Description("Disabled destinations are skipped by `logsim run`.").
				Value(&enabled),
		),
	)

	if err := form.Run(); err != nil {
		return config.Destination{}, err
	}

	batch, _ := strconv.Atoi(batchStr)
	flush, _ := strconv.Atoi(flushStr)
	return config.Destination{
		Name:          strings.TrimSpace(name),
		Type:          config.DestinationTypeCribl,
		Enabled:       enabled,
		URL:           strings.TrimSpace(urlStr),
		Token:         strings.TrimSpace(token),
		BatchSize:     batch,
		FlushInterval: flush,
		Format:        formatStr,
	}, nil
}

func intInRange(lo, hi int) func(string) error {
	return func(s string) error {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil {
			return errors.New("must be an integer")
		}
		if n < lo || n > hi {
			return fmt.Errorf("must be in [%d, %d]", lo, hi)
		}
		return nil
	}
}

// --- list --------------------------------------------------------------

func newDestListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List destinations in the dotfile",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, path, ok, err := config.LoadDefault()
			if err != nil {
				return err
			}
			if !ok || len(cfg.Destinations) == 0 {
				fmt.Fprintf(os.Stderr, "No destinations configured (%s).\nRun `logsim destinations add` to create one.\n", path)
				return nil
			}
			tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "NAME\tTYPE\tFORMAT\tENABLED\tURL")
			for _, d := range cfg.Destinations {
				format := d.Format
				if format == "" {
					format = "native"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%v\t%s\n", d.Name, d.Type, format, d.Enabled, d.URL)
			}
			return tw.Flush()
		},
	}
}

// --- remove ------------------------------------------------------------

func newDestRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <name>",
		Aliases: []string{"rm", "delete"},
		Short:   "Remove a destination",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			cfg, path, ok, err := config.LoadDefault()
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("no dotfile at %s", path)
			}
			if !cfg.Remove(name) {
				return fmt.Errorf("no destination named %q", name)
			}
			if err := cfg.Save(path); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "Removed destination %q from %s\n", name, path)
			return nil
		},
	}
}

// --- enable / disable --------------------------------------------------

func newDestEnableCmd(enable bool) *cobra.Command {
	verb := "enable"
	past := "Enabled"
	if !enable {
		verb = "disable"
		past = "Disabled"
	}
	return &cobra.Command{
		Use:   verb + " <name>",
		Short: strings.ToUpper(verb[:1]) + verb[1:] + " a destination",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			cfg, path, ok, err := config.LoadDefault()
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("no dotfile at %s", path)
			}
			if !cfg.SetEnabled(name, enable) {
				return fmt.Errorf("no destination named %q", name)
			}
			if err := cfg.Save(path); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "%s destination %q\n", past, name)
			return nil
		},
	}
}

// --- test --------------------------------------------------------------

func newDestTestCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "test <name>",
		Short: "Send a probe event to verify connectivity",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			cfg, path, ok, err := config.LoadDefault()
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("no dotfile at %s", path)
			}
			d := cfg.Get(name)
			if d == nil {
				return fmt.Errorf("no destination named %q", name)
			}
			if d.Type != config.DestinationTypeCribl {
				return fmt.Errorf("test only supports cribl_hec destinations (got %s)", d.Type)
			}
			return probeHEC(cmd.Context(), *d)
		},
	}
}

func probeHEC(ctx context.Context, d config.Destination) error {
	if ctx == nil {
		ctx = context.Background()
	}
	body := []byte(fmt.Sprintf(
		`{"time":%d,"host":"logsim-cli","source":"logsim:test","sourcetype":"logsim:test","event":"logsim destinations test probe"}`+"\n",
		time.Now().Unix(),
	))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Splunk "+d.Token)
	req.Header.Set("Content-Type", "application/x-ndjson")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))

	fmt.Fprintf(os.Stderr, "POST %s → %d\n", d.URL, resp.StatusCode)
	if len(respBody) > 0 {
		fmt.Fprintf(os.Stderr, "response: %s\n", strings.TrimSpace(string(respBody)))
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("destination %q rejected probe (HTTP %d)", d.Name, resp.StatusCode)
	}
	return nil
}

// --- path --------------------------------------------------------------

func newDestPathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "path",
		Short: "Print the dotfile path that would be used",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Println(config.DefaultPath())
			return nil
		},
	}
}
