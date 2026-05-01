// Package encoders translates LogEntry into a wire format. The native encoder
// passes the entry through (callers emit Raw or the JSON-encoded LogEntry as
// they always have); other encoders (ocsf, eventually udm and asim) map the
// entry's Class hint and structured Fields onto a target schema.
//
// Encoders are intentionally side-effect-free: they take a LogEntry and return
// the bytes that should land in the sink. Sinks decide whether to append a
// newline, wrap in a HEC envelope, etc.
package encoders

import (
	"encoding/json"
	"fmt"

	"github.com/nikhilm/logsim2/pkg/event"
)

// Format names a target schema. Native is the historical pass-through.
type Format string

const (
	FormatNative Format = "native"
	FormatOCSF   Format = "ocsf"
	FormatOTEL   Format = "otel"
	// Reserved for future additions.
	FormatUDM  Format = "udm"
	FormatASIM Format = "asim"
)

// Class is the generator-supplied hint that picks an OCSF event class.
// Constants are strings (not the OCSF numeric class_uid) so generators stay
// human-readable; the encoder translates to OCSF numerics.
const (
	ClassHTTPActivity         = "http_activity"
	ClassNetworkActivity      = "network_activity"
	ClassDatastoreActivity    = "datastore_activity"
	ClassApplicationLifecycle = "application_lifecycle"
	ClassAPIActivity          = "api_activity"
)

// Encoder produces the byte representation of one LogEntry in a target schema.
// Implementations return JSON without a trailing newline; sinks add one if the
// transport is line-delimited.
type Encoder interface {
	Format() Format
	Encode(e *event.LogEntry) ([]byte, error)
}

// For returns the encoder for f. FormatNative and unknown formats fall back to
// the native pass-through so callers never get a nil encoder.
func For(f Format) Encoder {
	switch f {
	case FormatOCSF:
		return ocsfEncoder{}
	case FormatOTEL:
		return otelEncoder{}
	case FormatUDM, FormatASIM:
		// Stubs until those mappings land — return native so output is still
		// usable rather than empty. The format ride-along signals intent.
		return nativeEncoder{}
	default:
		return nativeEncoder{}
	}
}

// Parse normalizes a free-form format string. Empty strings become Native.
func Parse(s string) Format {
	switch Format(s) {
	case FormatOCSF:
		return FormatOCSF
	case FormatOTEL:
		return FormatOTEL
	case FormatUDM:
		return FormatUDM
	case FormatASIM:
		return FormatASIM
	default:
		return FormatNative
	}
}

// ApplyToRaw encodes each entry through the format encoder and overwrites
// e.Raw with the schema-mapped line. The other LogEntry fields (id, ts,
// source, level, sourcetype) are left intact so existing transports that
// expect the LogEntry envelope (frontend SSE, NDJSON streams, bulk ZIP) can
// keep their shape — only the visible payload changes.
//
// FormatNative is a no-op. Errors per entry are swallowed: a single bad map
// shouldn't abort an entire stream of otherwise-valid logs.
func ApplyToRaw(entries []event.LogEntry, f Format) []event.LogEntry {
	if f == FormatNative {
		return entries
	}
	enc := For(f)
	for i := range entries {
		b, err := enc.Encode(&entries[i])
		if err != nil {
			continue
		}
		entries[i].Raw = string(b)
	}
	return entries
}

// nativeEncoder marshals the LogEntry as-is. Callers that prefer the raw line
// can ignore this and read e.Raw directly; we still implement Encode so a
// uniform pipeline (engine → encoder → sink) works.
type nativeEncoder struct{}

func (nativeEncoder) Format() Format { return FormatNative }

func (nativeEncoder) Encode(e *event.LogEntry) ([]byte, error) {
	if e == nil {
		return nil, fmt.Errorf("encoders: nil entry")
	}
	b, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	return b, nil
}
