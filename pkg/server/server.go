// Package server implements the logsim HTTP/SSE API.
package server

import (
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/nikhilm/logsim2/pkg/config"
)

// Server holds runtime state shared across handlers.
type Server struct {
	corsOrigin  string
	configPath  string
	dcfgMu      sync.RWMutex
	dcfg        *config.DestinationsConfig // may be nil
}

// New creates a Server. configPath may be "" if no destinations file is used.
func New(corsOrigin, configPath string) *Server {
	s := &Server{
		corsOrigin: corsOrigin,
		configPath: configPath,
	}
	s.reloadDestinations()
	return s
}

// Handler builds and returns the chi router.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()

	// Middleware stack.
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)
	r.Use(corsMiddleware(s.corsOrigin))
	r.Use(jsonContentType)

	r.Post("/v1/simulate", s.handleSimulate)
	r.Post("/v1/simulate/bulk", s.handleBulk)
	r.Get("/v1/destinations", s.handleListDestinations)
	r.Post("/v1/destinations/{name}/test", s.handleTestDestination)
	r.Post("/v1/forward", s.handleForward)

	return r
}

// WatchSIGHUP reloads destinations.yaml on SIGHUP. Non-blocking.
func (s *Server) WatchSIGHUP() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGHUP)
	go func() {
		for range ch {
			s.reloadDestinations()
		}
	}()
}

func (s *Server) reloadDestinations() {
	if s.configPath == "" {
		return
	}
	cfg, err := config.ParseFile(s.configPath)
	if err != nil {
		// Log to stderr but don't crash.
		os.Stderr.WriteString("logsim: reload destinations: " + err.Error() + "\n")
		return
	}
	s.dcfgMu.Lock()
	s.dcfg = cfg
	s.dcfgMu.Unlock()
}

func (s *Server) destinations() *config.DestinationsConfig {
	s.dcfgMu.RLock()
	defer s.dcfgMu.RUnlock()
	return s.dcfg
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func corsMiddleware(origin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if origin == "" {
				origin = "*"
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func jsonContentType(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Don't override Content-Type for SSE or ZIP handlers — they set their own.
		next.ServeHTTP(w, r)
	})
}
