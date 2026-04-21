package sinks

import "github.com/nikhilm/logsim2/pkg/event"

// Sink receives log entries from the engine and delivers them somewhere.
type Sink interface {
	Write(entries []event.LogEntry) error
	Flush() error
	Close() error
}
