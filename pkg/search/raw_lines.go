package search

import (
	"bufio"
	"io"
	"time"
)

// readRawLines reads the body of /services/collector/raw — newline-delimited
// raw log lines, no envelope. Each line becomes one event with the URL-query
// metadata applied. Empty lines are dropped.
func readRawLines(r io.Reader, host, source, sourcetype, index string) ([]Event, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	now := time.Now().UTC()
	var out []Event
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		out = append(out, Event{
			Time:       now,
			Host:       host,
			Source:     source,
			Sourcetype: sourcetype,
			Index:      index,
			Raw:        line,
		})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
