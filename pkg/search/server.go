package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// DefaultPort is the canonical port for `logsim search`. Picked far from
// anything else logsim/dev tooling uses.
const DefaultPort = 3700

// Server wraps the registry + chi router. Construct with NewServer; mount
// Handler() on an http.Server.
type Server struct {
	reg *Registry
}

func NewServer(reg *Registry) *Server { return &Server{reg: reg} }

// Handler returns the chi router. CORS is open ("*") because the eventual
// frontend will run from logsim2.vercel.app and dev `localhost:3000`.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(corsAllowAll)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	// Cribl HEC senders default to GET /services/collector/health for
	// readiness. We honour it at the daemon root in addition to per-db.
	r.Get("/services/collector/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"text": "HEC is healthy", "code": 17})
	})

	r.Route("/dbs", func(r chi.Router) {
		r.Get("/", s.handleListDBs)
		r.Post("/", s.handleCreateDB)

		r.Route("/{code}", func(r chi.Router) {
			r.Use(s.dbContext)
			r.Delete("/", s.handleDeleteDB)
			r.Get("/", s.handleGetDB)

			r.Post("/services/collector/event", s.handleHECIngest)
			r.Post("/services/collector/raw", s.handleHECIngestRaw)
			r.Get("/services/collector/health", func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{"text": "HEC is healthy", "code": 17})
			})

			r.Post("/get_raw", s.handleGetRaw)
			r.Post("/get_summary", s.handleGetSummary)
			r.Post("/get_distribution", s.handleGetDistribution)
			r.Post("/get_top_values", s.handleGetTopValues)
		})
	})

	return r
}

// dbContext resolves {code} from the URL into an *Entry and stashes it on
// the request context. 404 if missing.
type dbCtxKey struct{}

func (s *Server) dbContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := chi.URLParam(r, "code")
		code, err := NormalizeCode(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// HEC ingest auto-creates: HEC senders shouldn't need a separate
		// /dbs round-trip. Read endpoints do not, so they get a clean 404.
		var entry *Entry
		if r.Method == http.MethodPost &&
			(matchesPath(r.URL.Path, "/services/collector/event") ||
				matchesPath(r.URL.Path, "/services/collector/raw")) {
			entry, err = s.reg.GetOrCreate(code)
		} else {
			entry, err = s.reg.Get(code)
		}
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, http.StatusNotFound, fmt.Sprintf("db %q not found", code))
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		ctx := context.WithValue(r.Context(), dbCtxKey{}, entry)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func matchesPath(full, suffix string) bool {
	return len(full) >= len(suffix) && full[len(full)-len(suffix):] == suffix
}

func entryFromCtx(r *http.Request) *Entry {
	if v, ok := r.Context().Value(dbCtxKey{}).(*Entry); ok {
		return v
	}
	return nil
}

// --- db CRUD ----------------------------------------------------------

func (s *Server) handleListDBs(w http.ResponseWriter, r *http.Request) {
	snaps := s.reg.Snapshots(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"dbs": snaps})
}

type createDBRequest struct {
	Code string `json:"code,omitempty"`
}

func (s *Server) handleCreateDB(w http.ResponseWriter, r *http.Request) {
	var req createDBRequest
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
	}
	var (
		entry *Entry
		err   error
	)
	if req.Code == "" {
		entry, err = s.reg.Create("")
	} else {
		code, e := NormalizeCode(req.Code)
		if e != nil {
			writeError(w, http.StatusBadRequest, e.Error())
			return
		}
		entry, err = s.reg.Create(code)
	}
	if err != nil {
		if errors.Is(err, ErrCodeExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"code":       entry.Code,
		"created_at": entry.CreatedAt,
	})
}

func (s *Server) handleGetDB(w http.ResponseWriter, r *http.Request) {
	e := entryFromCtx(r)
	stats, _ := e.Backend.Stats(r.Context())
	writeJSON(w, http.StatusOK, Snapshot{Code: e.Code, CreatedAt: e.CreatedAt, Stats: stats})
}

func (s *Server) handleDeleteDB(w http.ResponseWriter, r *http.Request) {
	e := entryFromCtx(r)
	if err := s.reg.Delete(e.Code); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- HEC ingest -------------------------------------------------------

func (s *Server) handleHECIngest(w http.ResponseWriter, r *http.Request) {
	e := entryFromCtx(r)
	events, err := ParseHEC(r.Body)
	if err != nil {
		writeHECError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := e.Backend.Ingest(r.Context(), events); err != nil {
		writeHECError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": "Success", "code": 0, "ingested": len(events)})
}

// handleHECIngestRaw accepts /services/collector/raw — the body is the raw
// log line(s), not envelopes. Each line becomes one event with the request
// metadata applied as the envelope. Splunk uses this when senders can't
// produce JSON envelopes; Cribl's `raw` endpoint behaves the same.
func (s *Server) handleHECIngestRaw(w http.ResponseWriter, r *http.Request) {
	e := entryFromCtx(r)
	host := r.URL.Query().Get("host")
	source := r.URL.Query().Get("source")
	sourcetype := r.URL.Query().Get("sourcetype")
	index := r.URL.Query().Get("index")

	events, err := readRawLines(r.Body, host, source, sourcetype, index)
	if err != nil {
		writeHECError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := e.Backend.Ingest(r.Context(), events); err != nil {
		writeHECError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": "Success", "code": 0, "ingested": len(events)})
}

// --- IR endpoints -----------------------------------------------------

func (s *Server) handleGetRaw(w http.ResponseWriter, r *http.Request) {
	var q RawQuery
	if err := decodeQuery(r, &q); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	e := entryFromCtx(r)
	res, err := e.Backend.GetRaw(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleGetSummary(w http.ResponseWriter, r *http.Request) {
	var q SummaryQuery
	if err := decodeQuery(r, &q); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	e := entryFromCtx(r)
	res, err := e.Backend.GetSummary(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleGetDistribution(w http.ResponseWriter, r *http.Request) {
	var q DistributionQuery
	if err := decodeQuery(r, &q); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	e := entryFromCtx(r)
	res, err := e.Backend.GetDistribution(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleGetTopValues(w http.ResponseWriter, r *http.Request) {
	var q TopValuesQuery
	if err := decodeQuery(r, &q); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	e := entryFromCtx(r)
	res, err := e.Backend.GetTopValues(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- helpers ----------------------------------------------------------

// decodeQuery decodes an IR request body. The Range fields support either
// RFC3339Nano strings or epoch seconds (number) so curl-from-the-shell users
// don't have to format timestamps. Missing From/To default to a wide range
// so an exploratory query without bounds Just Works.
func decodeQuery(r *http.Request, dst any) error {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	// Apply a deliberately wide default time range when both ends are
	// zero. Logsim-generated events can be timestamped years in the past
	// (replaying historical scenarios) or future (synthesising load), so
	// "the user didn't specify" should not silently exclude events.
	if rg, ok := rangeOf(dst); ok {
		if rg.From.IsZero() && rg.To.IsZero() {
			setRange(dst, time.Unix(0, 0), time.Now().UTC().Add(100*365*24*time.Hour))
		}
	}
	return nil
}

func rangeOf(v any) (Range, bool) {
	switch x := v.(type) {
	case *RawQuery:
		return x.Range, true
	case *SummaryQuery:
		return x.Range, true
	case *DistributionQuery:
		return x.Range, true
	case *TopValuesQuery:
		return x.Range, true
	}
	return Range{}, false
}

func setRange(v any, from, to time.Time) {
	switch x := v.(type) {
	case *RawQuery:
		x.Range = Range{From: from, To: to}
	case *SummaryQuery:
		x.Range = Range{From: from, To: to}
	case *DistributionQuery:
		x.Range = Range{From: from, To: to}
	case *TopValuesQuery:
		x.Range = Range{From: from, To: to}
	}
}

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

// writeHECError mirrors Splunk HEC's error envelope shape so existing senders
// (incl. our own pkg/sinks/cribl.go) parse the response.
func writeHECError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"text": msg, "code": 13})
}

func corsAllowAll(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
