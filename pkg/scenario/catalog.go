package scenario

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// DefaultBaseURL is the public LogSim site that hosts the curated scenario
// catalog. Override at runtime by exporting $LOGSIM_BASE_URL.
const DefaultBaseURL = "https://logsim2.vercel.app"

// catalogPath is the catalog endpoint relative to the base URL.
const catalogPath = "/s/index.json"

// MaxCatalogBytes caps the catalog response. The current catalog is ~25 KB;
// 1 MiB is generous headroom and still bounds memory if the URL is misconfigured.
const MaxCatalogBytes = 1 << 20

// CatalogEntry mirrors one row from /s/index.json. The JSON tags match the
// shape produced by scripts/build-preset-yaml.mjs — keep them in sync.
type CatalogEntry struct {
	File          string `json:"file"`
	Slug          string `json:"slug"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	Difficulty    string `json:"difficulty"`
	DurationTicks int    `json:"durationTicks"`
	ServiceCount  int    `json:"serviceCount"`
	Bytes         int    `json:"bytes"`
}

// CatalogGroup mirrors a category descriptor in /s/index.json.
type CatalogGroup struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Order       int    `json:"order"`
}

// Catalog is the deserialized /s/index.json payload.
type Catalog struct {
	Groups      []CatalogGroup `json:"groups"`
	Scenarios   []CatalogEntry `json:"scenarios"`
	GeneratedAt string         `json:"generatedAt"`
}

// BaseURL returns the configured catalog base URL, honoring $LOGSIM_BASE_URL.
func BaseURL() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("LOGSIM_BASE_URL")), "/"); v != "" {
		return v
	}
	return DefaultBaseURL
}

// SlugURL maps a slug to the YAML URL on the configured base.
func SlugURL(slug string) string {
	return BaseURL() + "/s/" + slug + ".yaml"
}

// FetchCatalog retrieves and decodes the catalog at $LOGSIM_BASE_URL/s/index.json.
func FetchCatalog(opts ...LoadOptions) (*Catalog, error) {
	merged := mergeOpts(opts)
	ctx := merged.Context
	if ctx == nil {
		ctx = context.Background()
	}
	client := merged.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: DefaultHTTPTimeout}
	}

	url := BaseURL() + catalogPath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("catalog %q: build request: %w", url, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "logsim-cli")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("catalog %q: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("catalog %q: HTTP %d %s", url, resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxCatalogBytes+1))
	if err != nil {
		return nil, fmt.Errorf("catalog %q: read body: %w", url, err)
	}
	if int64(len(body)) > MaxCatalogBytes {
		return nil, fmt.Errorf("catalog %q: body exceeds %d byte cap", url, MaxCatalogBytes)
	}
	if len(body) == 0 {
		return nil, errors.New("catalog returned an empty body")
	}
	var cat Catalog
	if err := json.Unmarshal(body, &cat); err != nil {
		return nil, fmt.Errorf("catalog %q: decode: %w", url, err)
	}
	return &cat, nil
}
