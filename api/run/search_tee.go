package run

import (
	"fmt"
	"net/http"

	"github.com/nikhilm/logsim2/pkg/sinks"
)

// buildSearchTee returns a HEC sink pointed at /api/search/dbs/<code> on
// the same deployment. It's used as a parallel sink during /api/run so the
// in-memory search daemon receives every event the engine emits, no matter
// which response shape the client requested.
//
// The URL is reconstructed from the request's host + scheme so the same code
// works in three environments: local devserver (http://localhost:8787),
// vercel preview/production (https://*.vercel.app), and any custom domain.
//
// Returns nil when code is empty so callers can do a single nil-check.
// Failures during ingest are logged inside CriblSink and never propagated
// to the engine — search persistence is best-effort.
func buildSearchTee(r *http.Request, code string) *sinks.CriblSink {
	if code == "" {
		return nil
	}
	scheme := "http"
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		// Vercel sets this; honour the first value if comma-separated.
		if i := indexOfRune(proto, ','); i >= 0 {
			proto = proto[:i]
		}
		scheme = proto
	} else if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		// Local dev with no Host header — fall back to localhost:8787 since
		// that's the only realistic scenario this fires in.
		host = "localhost:8787"
	}
	url := fmt.Sprintf("%s://%s/api/search/dbs/%s/services/collector/event", scheme, host, code)
	// Batch 100, flush every 250ms — fast enough that the editor sees events
	// arrive within a tick or two when querying. Empty token: the search
	// daemon has no auth.
	s := sinks.NewCriblWithFormat(url, "", 100, 250, sinks.FormatJSONL)
	s.SetName("search:" + code)
	return s
}

func indexOfRune(s string, r rune) int {
	for i, c := range s {
		if c == r {
			return i
		}
	}
	return -1
}
