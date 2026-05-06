package logs_at

import (
	"fmt"
	"net/http"

	"github.com/nikhilm/logsim2/pkg/sinks"
)

// buildSearchTee mirrors api/run.buildSearchTee — duplicated rather than
// shared because each Vercel function ships standalone (no cross-package
// imports across api/*). See api/run/search_tee.go for the long comment.
func buildSearchTee(r *http.Request, code string) *sinks.CriblSink {
	if code == "" {
		return nil
	}
	scheme := "http"
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		if i := indexOfRune(proto, ','); i >= 0 {
			proto = proto[:i]
		}
		scheme = proto
	} else if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "localhost:8787"
	}
	url := fmt.Sprintf("%s://%s/api/search/dbs/%s/services/collector/event", scheme, host, code)
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
