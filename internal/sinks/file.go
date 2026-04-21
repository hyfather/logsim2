package sinks

import (
	"fmt"
	"os"
)

// NewFile opens (or creates) a file at path and returns a WriterSink writing
// to it. If append is true, new entries are appended; otherwise the file is
// truncated on open. The returned sink owns the file handle and closes it on
// Close().
func NewFile(path string, format Format, appendMode bool) (*WriterSink, error) {
	flags := os.O_CREATE | os.O_WRONLY
	if appendMode {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", path, err)
	}
	s := NewWriter(f, format)
	s.closer = f
	return s, nil
}
