//go:build !cgo

package search

import (
	"context"
	"errors"
)

// ErrNoCGO is returned by every DuckDBBackend method on non-CGO builds.
// `logsim search` requires CGO; the api/* Vercel functions don't, and
// gating duckdb behind a build tag keeps `CGO_ENABLED=0 go build ./...`
// working for them.
var ErrNoCGO = errors.New("logsim search requires a CGO build (see scripts/install.sh)")

// DuckDBBackend is a stub on non-CGO builds. Construction always fails;
// every method satisfies the Backend interface so callers can compile
// against it without conditional code.
type DuckDBBackend struct{}

func NewDuckDBBackend() (*DuckDBBackend, error) { return nil, ErrNoCGO }

func (*DuckDBBackend) Ingest(context.Context, []Event) error                  { return ErrNoCGO }
func (*DuckDBBackend) GetRaw(context.Context, RawQuery) (RawResult, error)    { return RawResult{}, ErrNoCGO }
func (*DuckDBBackend) GetSummary(context.Context, SummaryQuery) (SummaryResult, error) {
	return SummaryResult{}, ErrNoCGO
}
func (*DuckDBBackend) GetDistribution(context.Context, DistributionQuery) (DistributionResult, error) {
	return DistributionResult{}, ErrNoCGO
}
func (*DuckDBBackend) GetTopValues(context.Context, TopValuesQuery) (TopValuesResult, error) {
	return TopValuesResult{}, ErrNoCGO
}
func (*DuckDBBackend) Stats(context.Context) (Stats, error) { return Stats{}, ErrNoCGO }
func (*DuckDBBackend) Close() error                          { return nil }
