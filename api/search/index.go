// Package search hosts the Vercel function that mounts the in-memory
// search daemon under /api/search/. The implementation reuses pkg/search
// — the same chi router that backs `logsim search` — wired to a pure-Go
// MemoryBackend (no CGO, since Vercel rejects CGO at build time).
//
// All daemon routes (/dbs, /dbs/{code}, HEC ingest, IR queries) are
// served from this one function file so a single warm Vercel function
// instance owns the state. State persists only while the function is
// warm; cold starts reset the registry, which matches the per-session
// "play, then inspect" UX the editor uses.
package search

import (
	"net/http"
	"strings"
	"sync"

	"github.com/nikhilm/logsim2/pkg/search"
)

// One registry per process. Holds dbs in memory while the function is warm.
var (
	regOnce sync.Once
	reg     *search.Registry
	handler http.Handler
)

func ensureMounted() {
	regOnce.Do(func() {
		reg = search.NewRegistry(func() (search.Backend, error) {
			return search.NewMemoryBackend(), nil
		})
		handler = search.NewServer(reg).Handler()
	})
}

// Handler is the entry point Vercel invokes. The chi router defined in
// pkg/search expects paths under /dbs/...; on Vercel the function is
// mounted at /api/search so we strip that prefix before delegating.
func Handler(w http.ResponseWriter, r *http.Request) {
	ensureMounted()

	// Vercel routes /api/search/* to this function. cmd/devserver mounts
	// it at the same prefix. Trim before the chi router sees it.
	const prefix = "/api/search"
	if strings.HasPrefix(r.URL.Path, prefix) {
		newPath := strings.TrimPrefix(r.URL.Path, prefix)
		if newPath == "" {
			newPath = "/"
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = newPath
		r2.URL.RawPath = ""
		handler.ServeHTTP(w, r2)
		return
	}
	handler.ServeHTTP(w, r)
}
