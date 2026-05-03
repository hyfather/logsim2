package scenario

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MaxRemoteScenarioBytes caps remote-fetched scenarios. Plain-text YAML for the
// largest current preset is ~80 KB; 4 MB leaves headroom and protects against
// a misconfigured URL spraying gigabytes into the engine.
const MaxRemoteScenarioBytes = 4 << 20

// DefaultHTTPTimeout bounds how long `logsim run https://…` will wait for the
// remote scenario before giving up.
const DefaultHTTPTimeout = 15 * time.Second

// LoadOptions tweaks how Load resolves a scenario source.
type LoadOptions struct {
	// HTTPClient overrides the default client used to fetch URL sources. Tests
	// inject a client backed by httptest.Server here.
	HTTPClient *http.Client
	// Context bounds the URL fetch. Defaults to context.Background().
	Context context.Context
}

// IsHTTPURL reports whether src looks like an absolute http(s) URL.
func IsHTTPURL(src string) bool {
	s := strings.ToLower(strings.TrimSpace(src))
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// Load resolves a scenario from either a local file path or an http(s) URL,
// parses it, and returns the in-memory Scenario. It does NOT validate beyond
// schema parsing; call Validate() or use LoadAndValidate.
func Load(src string, opts ...LoadOptions) (*Scenario, error) {
	if IsHTTPURL(src) {
		return loadURL(src, mergeOpts(opts))
	}
	return ParseFile(src)
}

// LoadAndValidate is the one-call entry point used by the CLI: it accepts a
// path or URL, parses, and runs the engine validator before returning.
func LoadAndValidate(src string, opts ...LoadOptions) (*Scenario, error) {
	s, err := Load(src, opts...)
	if err != nil {
		return nil, err
	}
	if err := Validate(s); err != nil {
		return nil, err
	}
	return s, nil
}

func mergeOpts(opts []LoadOptions) LoadOptions {
	var merged LoadOptions
	for _, o := range opts {
		if o.HTTPClient != nil {
			merged.HTTPClient = o.HTTPClient
		}
		if o.Context != nil {
			merged.Context = o.Context
		}
	}
	return merged
}

func loadURL(url string, opts LoadOptions) (*Scenario, error) {
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: DefaultHTTPTimeout}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("scenario url %q: build request: %w", url, err)
	}
	req.Header.Set("Accept", "application/yaml, text/yaml, application/x-yaml, text/plain;q=0.9, */*;q=0.5")
	req.Header.Set("User-Agent", "logsim-cli")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("scenario url %q: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("scenario url %q: HTTP %d %s", url, resp.StatusCode, http.StatusText(resp.StatusCode))
	}

	// LimitReader+1 detects bodies that exceed the cap without reading them
	// fully into memory.
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxRemoteScenarioBytes+1))
	if err != nil {
		return nil, fmt.Errorf("scenario url %q: read body: %w", url, err)
	}
	if int64(len(body)) > MaxRemoteScenarioBytes {
		return nil, fmt.Errorf("scenario url %q: body exceeds %d byte cap", url, MaxRemoteScenarioBytes)
	}
	if len(body) == 0 {
		return nil, errors.New("scenario url returned an empty body")
	}

	s, err := Parse(strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("scenario url %q: %w", url, err)
	}
	return s, nil
}
