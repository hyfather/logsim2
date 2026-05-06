package apihelp

import (
	"fmt"
	"net/http"

	"github.com/nikhilm/logsim2/pkg/sinks"
)

// SearchTeeSink returns a HEC sink pointed at /api/search/dbs/<code> on
// the same deployment, used by /api/run and /api/logs_at to mirror every
// event the engine emits into the in-memory search daemon. The daemon
// auto-creates the db on first ingest.
//
// Lives in pkg/apihelp (shared across lambdas) rather than inside api/*
// because Vercel treats every .go file under api/** as a function entry
// point and rejects helper files that don't export a Handler.
//
// Returns nil when code is empty so callers can do a single nil-check.
// Failures during ingest are logged inside CriblSink and never propagated
// to the engine — search persistence is best-effort.
func SearchTeeSink(r *http.Request, code string) *sinks.CriblSink {
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
		// Local devserver fallback: only realistic scenario this fires in.
		host = "localhost:8787"
	}
	url := fmt.Sprintf("%s://%s/api/search/dbs/%s/services/collector/event", scheme, host, code)
	// Batch 100, flush every 250ms — fast enough that the editor sees events
	// arrive within a tick or two when querying. Empty token: no auth.
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
