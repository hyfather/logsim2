package search

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

// ErrCodeExists is returned by Create when the requested code is already in
// use. The HTTP layer maps it to 409.
var ErrCodeExists = errors.New("db code already exists")

// ErrNotFound is returned when a lookup misses. The HTTP layer maps it to 404.
var ErrNotFound = errors.New("db not found")

// BackendFactory builds a fresh Backend on demand. Tests inject an in-memory
// fake; production wires this to NewDuckDBBackend.
type BackendFactory func() (Backend, error)

// Registry owns the set of live dbs in the daemon. All methods are safe for
// concurrent use. Closing the registry tears down every backend it owns —
// "ctrl-c deletes all dbs" is implemented by calling Close from the search
// command's signal handler.
type Registry struct {
	mu       sync.RWMutex
	factory  BackendFactory
	entries  map[string]*Entry
	closed   bool
}

// Entry is a registry record. Pointer-stable across the registry's lifetime
// so callers can stash a reference between calls.
type Entry struct {
	Code      string
	CreatedAt time.Time
	Backend   Backend
}

func NewRegistry(factory BackendFactory) *Registry {
	return &Registry{
		factory: factory,
		entries: make(map[string]*Entry),
	}
}

// Create makes a new db. If code is empty a fresh code is generated; if
// non-empty it must already be normalised (call NormalizeCode first). The
// generated/accepted code and a pointer to the entry are returned.
func (r *Registry) Create(code string) (*Entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("registry closed")
	}

	if code != "" {
		if _, dup := r.entries[code]; dup {
			return nil, ErrCodeExists
		}
	} else {
		// Try a handful of times before giving up — at 36^6 the birthday
		// paradox doesn't bite until ~50k dbs, but we should still bail
		// rather than spin if something pathological is happening.
		for tries := 0; tries < 16; tries++ {
			c := NewCode()
			if _, dup := r.entries[c]; !dup {
				code = c
				break
			}
		}
		if code == "" {
			return nil, errors.New("could not allocate unused code after 16 tries")
		}
	}

	be, err := r.factory()
	if err != nil {
		return nil, err
	}
	e := &Entry{Code: code, CreatedAt: time.Now(), Backend: be}
	r.entries[code] = e
	return e, nil
}

// GetOrCreate looks up code, creating it (under exactly that code) if absent.
// Used by the HEC ingestion path so `--to local` doesn't have to call
// /dbs first.
func (r *Registry) GetOrCreate(code string) (*Entry, error) {
	r.mu.RLock()
	if e, ok := r.entries[code]; ok {
		r.mu.RUnlock()
		return e, nil
	}
	r.mu.RUnlock()

	// Race: another goroutine may have created it between RUnlock and Lock.
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("registry closed")
	}
	if e, ok := r.entries[code]; ok {
		return e, nil
	}
	be, err := r.factory()
	if err != nil {
		return nil, err
	}
	e := &Entry{Code: code, CreatedAt: time.Now(), Backend: be}
	r.entries[code] = e
	return e, nil
}

func (r *Registry) Get(code string) (*Entry, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[code]
	if !ok {
		return nil, ErrNotFound
	}
	return e, nil
}

func (r *Registry) Delete(code string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[code]
	if !ok {
		return ErrNotFound
	}
	delete(r.entries, code)
	return e.Backend.Close()
}

// List returns entries sorted by code. The registry mutex is held only for
// the snapshot, not while the caller iterates.
func (r *Registry) List() []*Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Entry, 0, len(r.entries))
	for _, e := range r.entries {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	return out
}

// Close tears down every backend. Idempotent.
func (r *Registry) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	for _, e := range r.entries {
		_ = e.Backend.Close()
	}
	r.entries = nil
	return nil
}

// Snapshot is a TUI-friendly summary of the registry. Each row is one db.
type Snapshot struct {
	Code      string    `json:"code"`
	CreatedAt time.Time `json:"created_at"`
	Stats
}

// Snapshots collects per-db Stats for the TUI / list endpoint. Failures on
// individual dbs are surfaced as zero counts rather than aborting the whole
// snapshot.
func (r *Registry) Snapshots(ctx context.Context) []Snapshot {
	entries := r.List()
	out := make([]Snapshot, 0, len(entries))
	for _, e := range entries {
		s, err := e.Backend.Stats(ctx)
		if err != nil {
			s = Stats{}
		}
		out = append(out, Snapshot{Code: e.Code, CreatedAt: e.CreatedAt, Stats: s})
	}
	return out
}
